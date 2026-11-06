import type { BuildingPeek, CrmCtx } from './context.ts';
import { getContact, listContacts } from './contacts.ts';
import type { ContactView } from './contacts.ts';
import { CrmConflictError, CrmInputError, CrmNotFoundError } from './errors.ts';
import type { Page } from './paging.ts';
import { addEntry } from './timeline.ts';
import { backfillBuilding, inBackground, workLogFor } from './workUpdates.ts';
import type { WorkLogEntry } from './workUpdates.ts';

export interface AttachedBuilding { buildingId: string; attachedAt: number; peek: BuildingPeek; workLog: WorkLogEntry[]; workLogTotal: number }
export interface CustomerRow extends ContactView { buildings: AttachedBuilding[] }

async function peekAll(ctx: CrmCtx, contactId: number): Promise<AttachedBuilding[]> {
  const links = ctx.db.prepare('SELECT buildingId, attachedAt FROM building_links WHERE contactId = ? ORDER BY attachedAt, buildingId').all(contactId) as Array<{ buildingId: string; attachedAt: number }>;
  return Promise.all(links.map(async (l) => {
    // A refused or failing read marks only that Building; it never fails the list.
    const peek = await ctx.deps.buildings.peek(l.buildingId).catch((e): BuildingPeek => ({ state: 'read_failed', reason: e instanceof Error ? e.message : 'The read failed' }));
    return { ...l, peek, ...workLogFor(ctx, contactId, l.buildingId) };
  }));
}

export async function withBuildings(ctx: CrmCtx, contact: ContactView): Promise<CustomerRow> {
  return { ...contact, buildings: await peekAll(ctx, contact.id) };
}

export async function listCustomers(ctx: CrmCtx, q: Record<string, unknown>): Promise<Page<CustomerRow>> {
  const page = listContacts(ctx, { ...q, segment: 'customer' });
  return { ...page, rows: await Promise.all(page.rows.map((c) => withBuildings(ctx, c))) };
}

export async function attachBuilding(ctx: CrmCtx, contactId: number, buildingId: unknown): Promise<CustomerRow> {
  const c = getContact(ctx, contactId);
  if (c.segment !== 'customer') throw new CrmConflictError('Only a customer can have Buildings attached');
  if (typeof buildingId !== 'string' || !buildingId) throw new CrmInputError('buildingId is required', 'buildingId');
  if (buildingId === ctx.buildingId) throw new CrmInputError('A CRM Building cannot be attached to its own customer', 'buildingId');
  const all = await ctx.deps.buildings.list();
  const b = all.find((x) => x.id === buildingId);
  if (!b) throw new CrmNotFoundError('That Building does not exist');
  if (ctx.db.prepare('SELECT 1 FROM building_links WHERE contactId = ? AND buildingId = ?').get(contactId, buildingId)) throw new CrmConflictError('That Building is already attached');
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT INTO building_links (contactId, buildingId, attachedAt) VALUES (?, ?, ?)').run(contactId, buildingId, ctx.now());
    addEntry(ctx, contactId, 'building_attached', `Attached Building ${b.name} (${b.typeId})`, { buildingId, name: b.name, typeId: b.typeId });
  })();
  inBackground(backfillBuilding(ctx, contactId, { buildingId, buildingName: b.name }));
  return withBuildings(ctx, getContact(ctx, contactId));
}

export async function detachBuilding(ctx: CrmCtx, contactId: number, buildingId: string): Promise<CustomerRow> {
  getContact(ctx, contactId);
  if (!ctx.db.prepare('SELECT 1 FROM building_links WHERE contactId = ? AND buildingId = ?').get(contactId, buildingId)) throw new CrmNotFoundError('That Building is not attached');
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM building_links WHERE contactId = ? AND buildingId = ?').run(contactId, buildingId);
    addEntry(ctx, contactId, 'building_detached', `Detached Building ${buildingId}`, { buildingId });
  })();
  return withBuildings(ctx, getContact(ctx, contactId));
}

export function listLost(ctx: CrmCtx, q: Record<string, unknown>): { prospects: Page<ContactView>; customers: Page<ContactView> } {
  return { prospects: listContacts(ctx, { ...q, segment: 'lost_prospect' }), customers: listContacts(ctx, { ...q, segment: 'lost_customer' }) };
}

/** Summaries for attached Buildings: SEO latest report and Software open tasks. Anything else gets the basics only. */
export function summaryFor(typeId: string, facts: { latestReport?: { savedAt: string | null; name: string } | null; openTasks?: number | null }): string | null {
  if (typeId === 'seo') return facts.latestReport === undefined ? null : facts.latestReport === null ? null : `Latest report: ${facts.latestReport.name}`;
  if (typeId === 'software') return facts.openTasks === undefined || facts.openTasks === null ? null : `${facts.openTasks} open task${facts.openTasks === 1 ? '' : 's'}`;
  return null;
}
