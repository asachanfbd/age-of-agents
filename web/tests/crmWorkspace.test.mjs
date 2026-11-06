import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const ws = await import('../src/lib/crmWorkspace.ts');
const types = await import('../src/lib/buildingTypes.ts');
const prospects = await import('../src/lib/crmProspects.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const crmFiles = () => readdirSync(new URL('../src/ui/crm/', import.meta.url)).filter((f) => f.endsWith('.tsx')).map((f) => [f, src(`ui/crm/${f}`)]);

test('C001 the tab list is exactly Calendar, Prospects, Customers, Lost, Import, Merge, Notes (MOM), Reports, Settings with Settings last', () => {
  assert.deepEqual(ws.CRM_TABS.map((t) => t.label), ['Calendar', 'Prospects', 'Customers', 'Lost', 'Import', 'Merge', 'Notes (MOM)', 'Reports', 'Settings']);
  assert.equal(ws.CRM_TABS.at(-1).key, 'settings');
  assert.equal(ws.DEFAULT_CRM_TAB, 'calendar');
  assert.match(src('ui/CrmWorkspace.tsx'), /CRM_TABS\.map/, 'the workspace renders the tabs from the one declaration');
});

test('C002 the contact opens as a detail panel over the tab that listed it, not as a tab; closing returns to the list', () => {
  let s = ws.selectTab(ws.initialWorkspace(), 'prospects');
  s = ws.openContact(s, 42);
  assert.deepEqual(s, { tab: 'prospects', contactId: 42 });
  assert.deepEqual(ws.closeContact(s), { tab: 'prospects', contactId: null });
  assert.equal(ws.selectTab(s, 'prospects').contactId, 42, 're-selecting the same tab keeps the panel');
  assert.equal(ws.selectTab(s, 'customers').contactId, null, 'another tab closes it');
  assert.ok(!ws.CRM_TABS.some((t) => /contact/i.test(t.key) || /contact/i.test(t.label)));
  assert.match(src('ui/CrmWorkspace.tsx'), /<ContactPanel/);
});

test('C003 CRM appears in the New Building picker and helpers with its own tint and labels; the other types are unchanged', () => {
  const make = (id, name, category, color) => ({ id, name, description: `${name} Building`, category, version: 1, repository: id === 'software', look: { model: 'generic', color }, workspace: id, devOnly: false, hasStorage: false, slots: [], agents: [], tables: [], rollups: [] });
  const catalog = [make('software', 'Software', 'Engineering', '#7295ad'), make('seo', 'SEO', 'Marketing', '#2fb89a'), make('crm', 'CRM', 'Sales', '#d9534f')];
  assert.deepEqual(types.filterTypes(catalog, 'crm', types.ALL_CATEGORIES).map((t) => t.id), ['crm']);
  assert.deepEqual(types.filterTypes(catalog, '', 'Sales').map((t) => t.name), ['CRM']);
  assert.equal(types.lookFor({ typeId: 'crm' }, catalog).color, '#d9534f');
  assert.equal(types.lookFor({ typeId: 'seo' }, catalog).color, '#2fb89a');
  assert.deepEqual([types.workspaceFor({ typeId: 'crm' }), types.workspaceFor({ typeId: 'seo' }), types.workspaceFor({}), types.workspaceFor({ typeId: 'notes' })], ['crm', 'seo', 'software', 'notes']);
  assert.equal(types.workspaceFor({ typeId: 'crm', typeUnavailable: true }), 'unavailable');
});

test('C004 every changing control is disabled in a read-only Building and history stays readable; each tab passes the rule', () => {
  assert.equal(ws.crmControlsDisabled(true), true);
  assert.equal(ws.crmControlsDisabled(false), false);
  assert.equal(ws.disabledTitle(true), ws.READ_ONLY_TITLE);
  assert.equal(ws.disabledTitle(false, 'Save'), 'Save');
  const READ_ONLY_BY_NATURE = new Set(['ReportsTab.tsx']); // no control on it changes data: periods, filters and CSV export only read
  const tabs = crmFiles().filter(([name]) => (/Tab\.tsx$/.test(name) || name === 'ContactPanel.tsx') && !READ_ONLY_BY_NATURE.has(name));
  assert.ok(tabs.length >= 9);
  for (const [name, text] of tabs) assert.match(text, /crmControlsDisabled/, `${name} must use the read-only rule`);
  assert.ok(!/\bcrmApi\.(post|patch|put|delete)/i.test(src('ui/crm/ReportsTab.tsx')) && !/<Button[^>]*onClick=\{[^}]*crmApi\.(?!report)/.test(src('ui/crm/ReportsTab.tsx')));
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /<CrmWorkspace project=\{project\} readOnly=\{isBuildingReadOnly\(project\)\}/);
});

test('C008 the contact panel model: channel badges, empty custom fields as "(empty)", the comment counter and the 5,000 limit', () => {
  const badges = (ch) => prospects.channelBadges({ id: 1, type: 'email', label: '', handle: 'a@x', ...ch });
  assert.deepEqual(badges({ invalid: false, dnc: false }), ['Valid']);
  assert.deepEqual(badges({ invalid: true, dnc: false }), ['Invalid']);
  assert.deepEqual(badges({ invalid: false, dnc: true }), ['Valid', 'Do not contact']);
  assert.deepEqual(badges({ invalid: true, dnc: true }), ['Invalid', 'Do not contact']);
  const rows = prospects.customFieldRows({ custom: { a: 'EU' } }, [{ id: 'a', name: 'Region' }, { id: 'b', name: 'Size' }]);
  assert.deepEqual(rows.map((r) => [r.name, r.value, r.empty]), [['Region', 'EU', false], ['Size', '(empty)', true]]);
  const entries = [{ id: 1, at: 100 }, { id: 3, at: 200 }, { id: 2, at: 200 }];
  assert.deepEqual(prospects.timelineNewestFirst(entries).map((e) => e.id), [3, 2, 1]);
  assert.equal(prospects.COMMENT_MAX, 5000);
  assert.deepEqual(prospects.commentCounter('x'.repeat(5000)), { count: 5000, remaining: 0, over: false, canSend: true });
  assert.deepEqual(prospects.commentCounter('x'.repeat(5001)), { count: 5001, remaining: -1, over: true, canSend: false });
  assert.equal(prospects.commentCounter('   ').canSend, false);
  assert.equal(prospects.commentCounter('😀'.repeat(5000)).over, false);
});

test('C005 row status: Pending reachout, Awaiting approval, No response with its resurface date, Do not contact; precedence when several apply', () => {
  const c = (extra = {}) => ({ id: 1, dnc: false, noResponse: false, resurfaceAt: null, channels: [], ...extra });
  assert.equal(prospects.primaryStatus(c()), null);
  assert.equal(prospects.primaryStatus(c({ pendingReachout: true })).label, 'Pending reachout');
  assert.equal(prospects.primaryStatus(c({ awaitingApproval: true })).label, 'Awaiting approval');
  const nr = prospects.primaryStatus(c({ noResponse: true, resurfaceAt: Date.parse('2026-04-15T00:00:00Z') }));
  assert.deepEqual(nr, { kind: 'no_response', label: 'No response', resurfaceAt: Date.parse('2026-04-15T00:00:00Z') });
  assert.equal(prospects.primaryStatus(c({ channels: [{ dnc: true }] })).label, 'Do not contact');
  const all = prospects.rowStatuses(c({ dnc: true, awaitingApproval: true, pendingReachout: true, noResponse: true }));
  assert.deepEqual(all.map((s) => s.kind), ['dnc', 'awaiting_approval', 'pending_reachout', 'no_response']);
});

test('C006 paging: "Rows 1-50 of 98,412", prev and next at the ends, page size clamped to 200, empty-page text', () => {
  const page = (offset, n, total) => ({ rows: Array.from({ length: n }, (_, i) => i), total, offset, limit: 50 });
  assert.equal(prospects.pagingLabel(page(0, 50, 98412)), 'Rows 1-50 of 98,412');
  assert.equal(prospects.pagingLabel(page(98400, 12, 98412)), 'Rows 98,401-98,412 of 98,412');
  assert.equal(prospects.pagingLabel(page(0, 0, 0)), prospects.EMPTY_PAGE_TEXT);
  assert.deepEqual(prospects.pageNav(page(0, 50, 98412)), { canPrev: false, canNext: true, prevOffset: 0, nextOffset: 50 });
  assert.deepEqual(prospects.pageNav(page(98400, 12, 98412)), { canPrev: true, canNext: false, prevOffset: 98350, nextOffset: 98450 });
  assert.deepEqual([prospects.clampPageSize(500), prospects.clampPageSize(200), prospects.clampPageSize(0), prospects.clampPageSize(1.5), prospects.clampPageSize(10)], [200, 200, 50, 50, 10]);
});
