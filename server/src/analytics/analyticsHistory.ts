import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutorProfile } from '../domain/types.ts';
import type { ExecutorLimits, LimitWindow } from '../executors/executorLimits.ts';
import type { UsageFailureReason } from '../executors/usagePoller.ts';
import { RETENTION_MS, type ActivityRecord, type AgentLink, type QuotaFailure, type QuotaReading, type StoredWindow, type TokenCounts } from './types.ts';

/** Where history is kept. Injectable so tests can use memory or make reads and writes fail. */
export interface HistoryStorage {
  /** The stored text, or null when nothing has been saved yet. */
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
}

/** Files under the daemon's data directory, written atomically so a crash never leaves a truncated file. */
export function fileHistoryStorage(directory: string): HistoryStorage {
  return {
    async read(name) {
      try { return await readFile(path.join(directory, name), 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(name, text) {
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, name);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, text);
      await rename(temporary, target);
    },
  };
}

const QUOTA_FILE = 'quota-history.json';
const ACTIVITY_FILE = 'activity-history.json';

type ReadingRow = [at: number, used5: number | null, reset5: number | null, used7: number | null, reset7: number | null];
interface QuotaFile {
  version: 1;
  collectionStartedAt: number | null;
  links: AgentLink[];
  readings: Record<string, ReadingRow[]>;
  failures: Record<string, [at: number, reason: UsageFailureReason][]>;
}
interface SessionUsage { usage: TokenCounts; at: number }
interface ActivityFile {
  version: 1;
  records: ActivityRecord[];
  sessions: Record<string, SessionUsage>;
}

function toRow(reading: QuotaReading): ReadingRow {
  return [reading.at, reading.fiveHour?.usedPercentage ?? null, reading.fiveHour?.resetsAt ?? null, reading.sevenDay?.usedPercentage ?? null, reading.sevenDay?.resetsAt ?? null];
}

function fromRow([at, used5, reset5, used7, reset7]: ReadingRow): QuotaReading {
  const window = (used: number | null, resetsAt: number | null): StoredWindow | null => used === null ? null : { usedPercentage: used, resetsAt };
  return { at, fiveHour: window(used5, reset5), sevenDay: window(used7, reset7) };
}

function toStoredWindow(window: LimitWindow | null): StoredWindow | null {
  return window ? { usedPercentage: window.usedPercentage, resetsAt: window.resetsAt === null ? null : Math.round(window.resetsAt * 1000) } : null;
}

/** A provider reading (seconds) as a stored one (milliseconds), keeping the provider's own observation time. */
export function toQuotaReading(limits: ExecutorLimits): QuotaReading {
  return { at: Math.round(limits.observedAt * 1000), fiveHour: toStoredWindow(limits.fiveHour), sevenDay: toStoredWindow(limits.sevenDay) };
}

/** Inserts into a list kept sorted by `at`; false when an entry with that time is already there. */
function insertByTime<T extends { at: number }>(list: T[], entry: T): boolean {
  let index = list.length;
  while (index > 0 && list[index - 1]!.at > entry.at) index -= 1;
  if (index > 0 && list[index - 1]!.at === entry.at) return false;
  list.splice(index, 0, entry);
  return true;
}

function inRange<T extends { at: number }>(list: T[] | undefined, from: number, to: number): T[] {
  return (list ?? []).filter((entry) => entry.at >= from && entry.at <= to);
}

export interface ConfiguredAgent {
  executorId: string;
  label: string;
  kind: ExecutorProfile['kind'];
  account: string;
}

export interface HistoryStatus {
  /** Set when stored history could not be read. Collection carries on in memory and the file is left untouched. */
  loadError: string | null;
  /** Set while the latest save of either history file failed. Earlier readings stay in memory. */
  saveError: string | null;
}

/**
 * The analytics runtime state: quota readings and failed checks per provider account, the agent
 * profiles linked to each account, tracked activity, and how much of each CLI session's reported
 * usage has already been assigned. Everything older than the retention period is pruned.
 */
export class AnalyticsHistory {
  private storage: HistoryStorage;
  private now: () => number;
  private loading: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private collectionStartedAt: number | null = null;
  private links: AgentLink[] = [];
  private readings = new Map<string, QuotaReading[]>();
  private failures = new Map<string, QuotaFailure[]>();
  private records = new Map<string, ActivityRecord>();
  private sessions = new Map<string, SessionUsage>();
  /** Files that could not be read are never written, so a damaged file is not replaced by an empty one. */
  private unreadable = new Set<string>();
  private loadError: string | null = null;
  /** Files whose latest save failed. Each clears only when that file is next saved. */
  private unsaved = new Set<string>();

  constructor(options: { storage: HistoryStorage; now?: () => number }) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  private ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    const quota = await this.readFile<QuotaFile>(QUOTA_FILE);
    if (quota) {
      this.collectionStartedAt = quota.collectionStartedAt ?? null;
      this.links = quota.links ?? [];
      for (const [account, rows] of Object.entries(quota.readings ?? {})) this.readings.set(account, rows.map(fromRow));
      for (const [account, rows] of Object.entries(quota.failures ?? {})) this.failures.set(account, rows.map(([at, reason]) => ({ at, reason })));
    }
    const activity = await this.readFile<ActivityFile>(ACTIVITY_FILE);
    if (activity) {
      for (const record of activity.records ?? []) this.records.set(record.id, record);
      for (const [key, session] of Object.entries(activity.sessions ?? {})) this.sessions.set(key, session);
    }
  }

  private async readFile<T>(name: string): Promise<T | null> {
    try {
      const text = await this.storage.read(name);
      return text === null ? null : JSON.parse(text) as T;
    } catch {
      this.unreadable.add(name);
      this.loadError = 'Saved analytics history could not be read. New readings are kept only until the daemon restarts.';
      return null;
    }
  }

  private save(name: string, build: () => unknown): Promise<void> {
    const run = this.writes.then(async () => {
      if (this.unreadable.has(name)) return;
      try {
        await this.storage.write(name, JSON.stringify(build()));
        this.unsaved.delete(name);
      } catch {
        this.unsaved.add(name);
      }
    });
    this.writes = run;
    return run;
  }

  private saveQuota(): Promise<void> {
    return this.save(QUOTA_FILE, (): QuotaFile => ({
      version: 1,
      collectionStartedAt: this.collectionStartedAt,
      links: this.links,
      readings: Object.fromEntries([...this.readings].map(([account, list]) => [account, list.map(toRow)])),
      failures: Object.fromEntries([...this.failures].map(([account, list]) => [account, list.map((failure): [number, UsageFailureReason] => [failure.at, failure.reason])])),
    }));
  }

  private saveActivity(): Promise<void> {
    return this.save(ACTIVITY_FILE, (): ActivityFile => ({ version: 1, records: [...this.records.values()], sessions: Object.fromEntries(this.sessions) }));
  }

  async status(): Promise<HistoryStatus> {
    await this.ready();
    const saveError = this.unsaved.size ? 'Analytics history could not be saved. Readings since the last save are kept only until the daemon restarts.' : null;
    return { loadError: this.loadError, saveError };
  }

  /** When collection began: the earliest moment a reading can exist for. Null before the first sync. */
  async startedAt(): Promise<number | null> {
    await this.ready();
    return this.collectionStartedAt;
  }

  /**
   * Brings the agent links in line with the configured profiles: a new profile gets a link, a
   * relabelled one keeps its link, and a profile that was removed or re-pointed at another account is
   * retired with its last label.
   */
  async syncAgents(configured: ConfiguredAgent[]): Promise<AgentLink[]> {
    await this.ready();
    const now = this.now();
    let changed = false;
    if (this.collectionStartedAt === null) { this.collectionStartedAt = now; changed = true; }
    for (const link of this.links) {
      if (link.retiredAt !== null) continue;
      const match = configured.find((agent) => agent.executorId === link.executorId && agent.account === link.account);
      if (!match) { link.retiredAt = now; changed = true; continue; }
      if (match.label !== link.label) { link.label = match.label; changed = true; }
    }
    for (const agent of configured) {
      if (this.links.some((link) => link.retiredAt === null && link.executorId === agent.executorId)) continue;
      this.links.push({ id: randomUUID(), ...agent, firstSeenAt: now, retiredAt: null });
      changed = true;
    }
    if (changed) await this.saveQuota();
    return this.agentLinks();
  }

  async agentLinks(): Promise<AgentLink[]> {
    await this.ready();
    return this.links.map((link) => ({ ...link }));
  }

  /** Stores one provider observation; false when that account already has a reading for the same observation time. */
  async recordReading(account: string, reading: QuotaReading): Promise<boolean> {
    await this.ready();
    const list = this.readings.get(account) ?? [];
    this.readings.set(account, list);
    if (!insertByTime(list, reading)) return false;
    this.prune();
    await this.saveQuota();
    return true;
  }

  /** Stores one failed check; false when that account's failure at that time is already recorded. */
  async recordFailure(account: string, failure: QuotaFailure): Promise<boolean> {
    await this.ready();
    const list = this.failures.get(account) ?? [];
    this.failures.set(account, list);
    if (!insertByTime(list, failure)) return false;
    await this.saveQuota();
    return true;
  }

  async readingsFor(account: string, from = -Infinity, to = Infinity): Promise<QuotaReading[]> {
    await this.ready();
    return inRange(this.readings.get(account), from, to);
  }

  async failuresFor(account: string, from = -Infinity, to = Infinity): Promise<QuotaFailure[]> {
    await this.ready();
    return inRange(this.failures.get(account), from, to);
  }

  async activity(id: string): Promise<ActivityRecord | undefined> {
    await this.ready();
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async activities(filter: (record: ActivityRecord) => boolean = () => true): Promise<ActivityRecord[]> {
    await this.ready();
    return [...this.records.values()].filter(filter).map((record) => structuredClone(record));
  }

  async putActivities(records: ActivityRecord[]): Promise<void> {
    await this.ready();
    if (!records.length) return;
    for (const record of records) this.records.set(record.id, structuredClone(record));
    await this.saveActivity();
  }

  /** The cumulative usage already assigned for one CLI session. */
  async sessionUsage(key: string): Promise<TokenCounts | null> {
    await this.ready();
    return this.sessions.get(key)?.usage ?? null;
  }

  /** Records a session's new cumulative usage together with the activity it was assigned to, in one save. */
  async assignSessionUsage(key: string, cumulative: TokenCounts, record: ActivityRecord): Promise<void> {
    await this.ready();
    this.sessions.set(key, { usage: cumulative, at: this.now() });
    this.records.set(record.id, structuredClone(record));
    await this.saveActivity();
  }

  /** Drops everything past retention. Live sessions are kept however long they have run. */
  async pruneExpired(): Promise<void> {
    await this.ready();
    this.prune();
    await Promise.all([this.saveQuota(), this.saveActivity()]);
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    for (const lists of [this.readings, this.failures] as Map<string, { at: number }[]>[]) {
      for (const [account, list] of lists) {
        const kept = list.filter((entry) => entry.at >= cutoff);
        if (kept.length) lists.set(account, kept); else lists.delete(account);
      }
    }
    for (const [id, record] of this.records) {
      if (record.endedAt !== null && record.endedAt < cutoff) this.records.delete(id);
    }
    for (const [key, session] of this.sessions) {
      if (session.at < cutoff) this.sessions.delete(key);
    }
    this.links = this.links.filter((link) => link.retiredAt === null || link.retiredAt >= cutoff);
  }
}
