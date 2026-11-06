import { parseCron } from './cron.ts';
import type { JobSettings, JobTarget, JobTrigger } from './types.ts';

export const LIMITS = {
  name: 120,
  text: 10_000,
  path: 1_024,
  url: 2_048,
  jsonField: 256,
  minIntervalSeconds: 60,
  maxIntervalSeconds: 30 * 24 * 60 * 60,
  maxRunsPerDay: 1_000,
  maxFailureThreshold: 100,
} as const;

export const DEFAULT_FAILURE_THRESHOLD = 3;

export type JobValidation = { ok: true; value: JobSettings } | { ok: false; field: string; error: string };

/** What a job is checked against besides its own fields. */
export interface ValidationContext {
  /** The workflow slot ids of the Building's type. */
  slotIds: readonly string[];
  /** The Catalog's agent ids. */
  agentIds: readonly string[];
  /** The in-process action ids of the Building's type. */
  actionIds?: readonly string[];
  /** The ids of the Building's saved commands. */
  commandIds?: readonly string[];
}

class Refusal extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Refusal(field, `${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Refusal(field, `${label} must be at most ${max.toLocaleString('en-US')} characters`);
  return trimmed;
}

function wholeNumber(value: unknown, field: string, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Refusal(field, `${label} must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`);
  }
  return value;
}

function optionalLimit(value: unknown, field: string, max: number, label: string): number | null {
  return value === undefined || value === null ? null : wholeNumber(value, field, 1, max, label);
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Refusal(field, `${label} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

function flag(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Refusal(field, `${field} must be true or false`);
  return value;
}

function interval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Refusal('trigger.intervalSeconds', 'The interval must be a whole number of seconds');
  if (value < LIMITS.minIntervalSeconds) throw new Refusal('trigger.intervalSeconds', 'The interval must be at least 1 minute');
  if (value > LIMITS.maxIntervalSeconds) throw new Refusal('trigger.intervalSeconds', 'The interval must be at most 30 days');
  return value;
}

function address(value: unknown): string {
  const url = text(value, 'trigger.url', LIMITS.url, 'The address');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Refusal('trigger.url', 'The address must be a full http or https address'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Refusal('trigger.url', 'The address must start with http:// or https://');
  return url;
}

const JSON_FIELD = /^[^.[\]\s]+(\[\d+\])*(\.[^.[\]\s]+(\[\d+\])*)*$/;

function jsonField(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Refusal('trigger.jsonField', 'The JSON field must be text');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > LIMITS.jsonField) throw new Refusal('trigger.jsonField', `The JSON field must be at most ${LIMITS.jsonField} characters`);
  if (!JSON_FIELD.test(trimmed)) throw new Refusal('trigger.jsonField', 'The JSON field must look like plans[0].price');
  return trimmed;
}

function trigger(value: unknown): JobTrigger {
  if (!isObject(value)) throw new Refusal('trigger', 'A trigger is required');
  const kind = oneOf(value.kind, 'trigger.kind', ['cron', 'file', 'api'] as const, 'The trigger kind');
  if (kind === 'cron') {
    const parsed = parseCron(value.cron);
    if (!parsed.ok) throw new Refusal('trigger.cron', parsed.error);
    return { kind, cron: parsed.schedule.expression };
  }
  if (kind === 'file') {
    return {
      kind,
      path: text(value.path, 'trigger.path', LIMITS.path, 'The path'),
      detect: oneOf(value.detect, 'trigger.detect', ['mtime', 'hash'] as const, 'The change check'),
      intervalSeconds: interval(value.intervalSeconds),
    };
  }
  return { kind, url: address(value.url), jsonField: jsonField(value.jsonField), intervalSeconds: interval(value.intervalSeconds) };
}

function target(value: unknown, context: ValidationContext): JobTarget {
  if (!isObject(value)) throw new Refusal('target', 'Choose what the job runs');
  const kind = oneOf(value.kind, 'target.kind', ['slot', 'prompt', 'capability', 'action', 'command'] as const, 'What the job runs');
  if (kind === 'command') {
    if (typeof value.commandId !== 'string' || !(context.commandIds ?? []).includes(value.commandId)) {
      throw new Refusal('target.commandId', 'Choose one of this Building\'s saved commands');
    }
    return { kind, commandId: value.commandId };
  }
  if (kind === 'action') {
    if (typeof value.actionId !== 'string' || !(context.actionIds ?? []).includes(value.actionId)) {
      throw new Refusal('target.actionId', `This Building's type has no action "${String(value.actionId)}"`);
    }
    return { kind, actionId: value.actionId };
  }
  if (kind === 'capability') {
    const inputs = value.inputs === undefined || value.inputs === null ? {} : value.inputs;
    if (!isObject(inputs)) throw new Refusal('target.inputs', 'The inputs must be an object');
    return {
      kind,
      targetBuildingId: text(value.targetBuildingId, 'target.targetBuildingId', LIMITS.name, 'The target Building'),
      capabilityId: text(value.capabilityId, 'target.capabilityId', LIMITS.name, 'The capability'),
      inputs,
    };
  }
  if (kind === 'slot') {
    if (value.prompt !== undefined) throw new Refusal('target', 'A job runs a workflow slot or a single prompt, not both');
    if (typeof value.slotId !== 'string' || !context.slotIds.includes(value.slotId)) {
      throw new Refusal('target.slotId', `This Building's type has no workflow slot "${String(value.slotId)}"`);
    }
    return { kind, slotId: value.slotId, description: text(value.description, 'target.description', LIMITS.text, 'The task description') };
  }
  if (value.slotId !== undefined) throw new Refusal('target', 'A job runs a workflow slot or a single prompt, not both');
  const agentId = value.agentId === undefined || value.agentId === null ? null : value.agentId;
  if (agentId !== null && (typeof agentId !== 'string' || !context.agentIds.includes(agentId))) {
    throw new Refusal('target.agentId', `Agent "${String(agentId)}" does not exist in the Catalog`);
  }
  return { kind, agentId, prompt: text(value.prompt, 'target.prompt', LIMITS.text, 'The prompt') };
}

/**
 * Checks a complete job. Text is trimmed first; fields a caller may not set (`id`, `nextRunAt`, counters) and unknown
 * ones are dropped. The missed-run policy belongs to cron jobs only, so on a poll job it is dropped, not stored.
 */
export function validateJob(input: unknown, context: ValidationContext): JobValidation {
  if (!isObject(input)) return { ok: false, field: 'body', error: 'The job must be a JSON object' };
  try {
    const jobTrigger = trigger(input.trigger);
    const value: JobSettings = {
      name: text(input.name, 'name', LIMITS.name, 'The name'),
      enabled: flag(input.enabled, 'enabled', true),
      trigger: jobTrigger,
      target: target(input.target, context),
      overlap: oneOf(input.overlap === undefined ? 'skip' : input.overlap, 'overlap', ['skip', 'queue', 'parallel'] as const, 'The overlap rule'),
      missedPolicy: jobTrigger.kind === 'cron' ? oneOf(input.missedPolicy === undefined ? 'skip' : input.missedPolicy, 'missedPolicy', ['skip', 'once'] as const, 'The missed-run policy') : null,
      maxRunsPerDay: optionalLimit(input.maxRunsPerDay, 'maxRunsPerDay', LIMITS.maxRunsPerDay, 'Runs per day'),
      maxFiveHourPercent: optionalLimit(input.maxFiveHourPercent, 'maxFiveHourPercent', 100, 'The 5-hour usage percentage'),
      maxWeeklyPercent: optionalLimit(input.maxWeeklyPercent, 'maxWeeklyPercent', 100, 'The weekly usage percentage'),
      needsApproval: flag(input.needsApproval, 'needsApproval', false),
      failureThreshold: input.failureThreshold === undefined || input.failureThreshold === null
        ? DEFAULT_FAILURE_THRESHOLD
        : wholeNumber(input.failureThreshold, 'failureThreshold', 1, LIMITS.maxFailureThreshold, 'Failures before the job turns off'),
    };
    // A command run has no agent to hold for approval.
    if (value.target.kind === 'command' && value.needsApproval) throw new Refusal('needsApproval', 'A saved command runs without an agent, so it cannot wait for approval');
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, field: error.field, error: error.message };
    throw error;
  }
}

const SETTING_KEYS = ['name', 'enabled', 'trigger', 'target', 'overlap', 'missedPolicy', 'maxRunsPerDay', 'maxFiveHourPercent', 'maxWeeklyPercent', 'needsApproval', 'failureThreshold'] as const;

/**
 * Checks an edit as the job it would produce: the patch's top-level fields replace the stored ones, and the result is
 * validated whole. Changing the trigger to another kind therefore needs that kind's fields in the patch.
 *
 * An edit that leaves the target alone does not ask again whether its slot or agent still exists, so a job whose agent
 * was removed from the Catalog can still be renamed or switched off. Starting it is what fails, with the reason.
 */
export function validateJobPatch(current: JobSettings, patch: unknown, context: ValidationContext): JobValidation {
  if (!isObject(patch)) return { ok: false, field: 'body', error: 'The change must be a JSON object' };
  const merged: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) merged[key] = patch[key] !== undefined ? patch[key] : current[key];
  // A stored poll job has no missed-run policy; moving it to cron takes the default unless the patch names one.
  if (merged.missedPolicy === null) delete merged.missedPolicy;
  if (patch.target !== undefined) return validateJob(merged, context);
  const { target: kept } = current;
  return validateJob(merged, {
    slotIds: kept.kind === 'slot' ? [...context.slotIds, kept.slotId] : context.slotIds,
    agentIds: kept.kind === 'prompt' && kept.agentId !== null ? [...context.agentIds, kept.agentId] : context.agentIds,
    actionIds: kept.kind === 'action' ? [...(context.actionIds ?? []), kept.actionId] : context.actionIds,
    commandIds: kept.kind === 'command' ? [...(context.commandIds ?? []), kept.commandId] : context.commandIds,
  });
}
