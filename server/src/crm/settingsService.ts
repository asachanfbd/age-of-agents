import { randomUUID } from 'node:crypto';
import type { CrmCtx } from './context.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import { applySettingsPatch, customFieldCapReached, validateCustomFieldName, validateLostReasons } from './settings.ts';
import type { CustomFieldDef } from './settings.ts';
import { CUSTOM_FIELDS_MAX } from './limits.ts';
import { smtpStatus, savePassword } from './email.ts';
import { reconcileChains } from './followups.ts';

const customUsage = (ctx: CrmCtx, id: string): number =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE mergedInto IS NULL AND COALESCE(json_extract(custom, ?), '') <> ''").get(`$."${id}"`) as { n: number }).n;
const reasonUsage = (ctx: CrmCtx, reason: string): number => (ctx.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE lostReason = ?').get(reason) as { n: number }).n;

export async function settingsView(ctx: CrmCtx) {
  const s = ctx.settings();
  return { ...s, smtp: { ...s.smtp, status: await smtpStatus(ctx) } };
}

/** Applies a settings change. `smtp.password` is write-only: it goes to the secret store and never comes back. */
export async function updateSettings(ctx: CrmCtx, patch: unknown) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new CrmInputError('body must be an object', 'body');
  const { smtp, ...rest } = patch as { smtp?: Record<string, unknown> };
  const password = smtp && typeof smtp === 'object' ? smtp.password : undefined;
  const smtpRest = smtp && typeof smtp === 'object' ? Object.fromEntries(Object.entries(smtp).filter(([k]) => k !== 'password')) : smtp;
  const current = ctx.settings();
  const next = applySettingsPatch(current, { ...rest, ...(smtp !== undefined ? { smtp: smtpRest } : {}) });
  const removed = current.lostReasons.filter((r) => !next.lostReasons.includes(r));
  for (const r of removed) {
    const n = reasonUsage(ctx, r);
    if (n > 0) throw new CrmConflictError(`"${r}" is the reason for ${n} lost contact${n === 1 ? '' : 's'}; it cannot be removed`, { inUse: n });
  }
  await savePassword(ctx, password);
  ctx.saveSettings(next);
  if (next.cadence.followups !== current.cadence.followups) reconcileChains(ctx);
  return settingsView(ctx);
}

export function addCustomField(ctx: CrmCtx, name: unknown): CustomFieldDef {
  const s = ctx.settings();
  const clean = validateCustomFieldName(name, s.customFields);
  if (customFieldCapReached(s.customFields)) throw new CrmInputError(`At most ${CUSTOM_FIELDS_MAX} custom fields are allowed`, 'name');
  const def = { id: `cf${randomUUID().slice(0, 8)}`, name: clean };
  ctx.saveSettings({ ...s, customFields: [...s.customFields, def] });
  return def;
}

export function renameCustomField(ctx: CrmCtx, id: string, name: unknown): CustomFieldDef {
  const s = ctx.settings();
  if (!s.customFields.some((f) => f.id === id)) throw new CrmNotFoundError('That custom field does not exist');
  const clean = validateCustomFieldName(name, s.customFields, id);
  ctx.saveSettings({ ...s, customFields: s.customFields.map((f) => (f.id === id ? { ...f, name: clean } : f)) });
  return { id, name: clean };
}

/** A field that holds values on contacts cannot be deleted (409 with the count); clear the values first. */
export function deleteCustomField(ctx: CrmCtx, id: string): void {
  const s = ctx.settings();
  if (!s.customFields.some((f) => f.id === id)) throw new CrmNotFoundError('That custom field does not exist');
  const n = customUsage(ctx, id);
  if (n > 0) throw new CrmConflictError(`${n} contact${n === 1 ? ' has' : 's have'} a value in this field; clear those values before deleting it`, { inUse: n });
  ctx.saveSettings({ ...s, customFields: s.customFields.filter((f) => f.id !== id) });
}

export function renameLostReason(ctx: CrmCtx, from: string, to: unknown): string[] {
  const s = ctx.settings();
  if (!s.lostReasons.includes(from)) throw new CrmNotFoundError('That reason does not exist');
  const list = validateLostReasons(s.lostReasons.map((r) => (r === from ? to : r)));
  const renamed = list[s.lostReasons.indexOf(from)]!;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE contacts SET lostReason = ? WHERE lostReason = ?').run(renamed, from);
    ctx.saveSettings({ ...s, lostReasons: list });
  })();
  return list;
}

