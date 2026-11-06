import type { Db } from './db.ts';
import type { CrmSettings } from './settings.ts';

export interface MailMessage { from: string; to: string; subject: string; text: string }
export interface SmtpAccount { host: string; port: number; security: 'starttls' | 'ssl' | 'none'; user: string; password: string }
export type SmtpFailureKind = 'auth' | 'tls' | 'refused' | 'timeout' | 'rejected' | 'other';
export class SmtpError extends Error {
  readonly kind: SmtpFailureKind;
  constructor(kind: SmtpFailureKind, message: string) { super(message); this.name = 'SmtpError'; this.kind = kind; }
}
export interface MailTransport { send(account: SmtpAccount, message: MailMessage): Promise<void> }

export interface DraftRequest { kind: 'message' | 'mom' | 'work' | 'mapping'; prompt: string }
/** Runs an agent for one output kind; throws when the agent fails. Tests inject a fake. */
export interface CrmAgent { run(request: DraftRequest): Promise<string> }

export type BuildingPeek =
  | { state: 'ok'; name: string; typeId: string; status: string; summary: string | null }
  | { state: 'unavailable' }
  | { state: 'read_failed'; reason: string };
export interface BuildingReader {
  list(): Promise<Array<{ id: string; name: string; typeId: string; status: string }>>;
  peek(buildingId: string): Promise<BuildingPeek>;
}

/** A board task (plan item) run on another Building. Times are epoch ms; null when unknown. */
export interface WorkTask { planItemId: string; title: string | null; runSummary: string | null; startedAt: number | null; finishedAt: number | null }
export interface BuildingTaskReader {
  /** Tasks on the Building whose run completed at or after `sinceMs`. */
  finishedSince(buildingId: string, sinceMs: number): Promise<WorkTask[]>;
}

export interface CrmDeps {
  transport: MailTransport;
  agent: CrmAgent;
  buildings: BuildingReader;
  tasks: BuildingTaskReader;
  /** Raised when the SMTP connection needs attention. */
  notifyAttention(buildingId: string, reason: string): void;
  resolveAttention(buildingId: string): void;
}

export interface CrmSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CrmCtx {
  db: Db;
  buildingId: string;
  now(): number;
  deps: CrmDeps;
  secrets: CrmSecrets;
  /** Folder for MOM attachments and audio. */
  filesDir: string;
  settings(): CrmSettings;
  saveSettings(next: CrmSettings): void;
  /** Runs async work one at a time per Building. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

export const SMTP_PASSWORD_KEY = 'crm.smtp.password';
