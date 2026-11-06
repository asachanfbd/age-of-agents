import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule, render } from './renderHelper.mjs';

const contact = (o = {}) => ({ id: 1, name: 'Ann Lee', company: 'Acme', title: 'CEO', tags: [], custom: {}, segment: 'customer', stage: null, customerAt: Date.UTC(2026, 9, 22), createdAt: 1, dnc: false, channels: [{ id: 1, type: 'email', label: '', handle: 'ann@x.com', invalid: false, dnc: false }], buildings: [], ...o });

test('KpiRow leaves out a missing value, keeps a real 0 and shows a delta badge', async () => {
  const html = await render('src/ui/design/Header.tsx', 'KpiRow', { icons: {}, items: [{ key: 'a', label: 'Open', value: 0 }, { key: 'b', label: 'Gone', value: null }, { key: 'c', label: 'Won', value: 1200, delta: { tone: 'positive', text: '+5' } }] });
  assert.match(html, /Open/); assert.match(html, />0</); assert.doesNotMatch(html, /Gone/);
  assert.match(html, /1,200/); assert.match(html, /\+5/);
  assert.equal(await render('src/ui/design/Header.tsx', 'KpiRow', { icons: {}, items: [{ key: 'b', label: 'Gone', value: null }] }), '');
});

test('PageHeader sets the title over its lines and holds the actions', async () => {
  const html = await render('src/ui/design/Header.tsx', 'PageHeader', { lines: ['Deal', 'Pipeline'], actions: createElement('button', null, 'New deal') });
  assert.match(html, /<h2[^>]*><span class="block">Deal<\/span><span class="block">Pipeline<\/span><\/h2>/);
  assert.match(html, /New deal/);
});

test('SegmentedControl and FilterChips mark the active option with aria-pressed', async () => {
  const seg = await render('src/ui/design/Segmented.tsx', 'SegmentedControl', { label: 'View', value: 'board', options: [{ value: 'board', label: 'Board' }, { value: 'list', label: 'List' }], onChange() {} });
  assert.match(seg, /aria-label="View"/);
  assert.match(seg, /aria-pressed="true"[^>]*>Board/); assert.match(seg, /aria-pressed="false"[^>]*>List/);
  const chips = await render('src/ui/design/Segmented.tsx', 'FilterChips', { label: 'Stage', value: 'all', options: [{ value: 'all', label: 'All' }, { value: 'x', label: 'X' }], onChange() {} });
  assert.match(chips, /bg-primary text-primary-foreground[^>]*>All/);
});

test('ItemCard is filled with its accent and opens from its title button', async () => {
  const html = await render('src/ui/design/Cards.tsx', 'ItemCard', { accent: 'yellow', title: 'Deal', subtitle: 'Acme', topLine: 'Closes Oct 22', value: '$5', avatars: ['Ann Lee', 'Bo Chi'], onOpen() {}, openLabel: 'Open Deal' });
  assert.match(html, /bg-stage-yellow text-stage-yellow-foreground/);
  assert.match(html, /<button[^>]*aria-label="Open Deal"[^>]*>Deal<\/button>/);
  assert.match(html, /AL/); assert.match(html, /BC/);
});

test('StageProgress marks the current stage; ScoreBar and ScoreRing expose a clamped value', async () => {
  const html = await render('src/ui/design/Cards.tsx', 'StageProgress', { stages: ['New', 'Engaged', 'Proposal'], current: 'Engaged' });
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(html, /font-bold">Engaged/);
  assert.equal((await render('src/ui/design/Cards.tsx', 'StageProgress', { stages: ['A'], current: 'zzz' })).includes('aria-current'), false);
  assert.match(await render('src/ui/design/Cards.tsx', 'ScoreBar', { value: 140, label: 'Fit' }), /aria-valuenow="100"/);
  assert.match(await render('src/ui/design/Cards.tsx', 'ScoreBar', { value: Number.NaN, label: 'Fit' }), /aria-valuenow="0"/);
  assert.match(await render('src/ui/design/Cards.tsx', 'ScoreRing', { value: 50, label: 'Done', children: 'AB' }), /aria-valuenow="50"/);
});

test('AvatarStack shows initials and a "+N" for the rest', async () => {
  const html = await render('src/ui/design/Cards.tsx', 'AvatarStack', { names: ['Ann Lee', 'Bo Chi', 'Cy Dun', 'Di Eve'], max: 2 });
  assert.match(html, />AL</); assert.match(html, /\+2/); assert.doesNotMatch(html, />CD</);
  assert.equal(await render('src/ui/design/Cards.tsx', 'AvatarStack', { names: [] }), '');
});

test('DataTable renders two-line cells, sortable headers, a status dot and a "Show all" pill', async () => {
  const mod = await loadModule('src/ui/design/DataTable.tsx');
  const rows = [1, 2, 3].map((id) => ({ id, name: `N${id}` }));
  const html = renderToStaticMarkup(createElement(mod.DataTable, { label: 'T', rows, rowKey: (r) => r.id, rowLimit: 2, summary: '3 rows', rowMenu: () => 'menu', columns: [{ key: 'n', header: 'Name', sortValue: (r) => r.name, render: (r) => createElement(mod.TwoLine, { main: r.name, sub: 'muted' }) }, { key: 's', header: 'Status', render: () => createElement(mod.StatusDot, { accent: 'green', label: 'Paid' }) }] }));
  assert.match(html, /aria-sort="none"/); assert.match(html, /Show all 3/); assert.match(html, /3 rows/);
  assert.equal((html.match(/<tr/g) ?? []).length, 3, 'header plus two rows'); assert.match(html, /bg-stage-green/); assert.match(html, />muted</);
});

test('BarChart gives screen readers a table, reads null as "no data" and draws no bar for it', async () => {
  const html = await render('src/ui/design/Charts.tsx', 'BarChart', { label: 'By channel', series: [{ key: 'a', label: 'Added', accent: 'green' }, { key: 'b', label: 'Sent', accent: 'yellow' }], groups: [{ label: 'email', values: [4, null] }] });
  assert.match(html, /<caption>By channel<\/caption>/); assert.match(html, /<td>no data<\/td>/); assert.equal((html.match(/<rect/g) ?? []).length, 1);
});

test('LineChart draws a dashed comparison line and leaves a gap at a null', async () => {
  const series = [{ key: 'c', label: 'This week', accent: 'green' }, { key: 'p', label: 'Last week', accent: 'yellow', dashed: true }];
  const html = await render('src/ui/design/Charts.tsx', 'LineChart', { label: 'Period', series, groups: [{ label: 'A', values: [4, 2] }, { label: 'B', values: [6, 5] }, { label: 'C', values: [3, null] }] });
  assert.match(html, /stroke-dasharray="6 5"/); assert.match(html, /<td>no data<\/td>/); assert.equal((html.match(/<circle/g) ?? []).length, 5);
  assert.doesNotMatch(html, /NaN/);
});

test('the Prospects board renders five stage columns and the Customer and Lost zones, read-only or not', async () => {
  const props = { projectId: 'p', query: { search: '', offset: 0, limit: 50 }, reloadKey: 0, onOpenContact() {}, onOpenPending() {}, onZoneDrop() {} };
  const html = await render('src/ui/crm/ProspectBoard.tsx', 'ProspectBoard', { ...props, readOnly: false });
  for (const stage of ['New', 'Contacted', 'Engaged', 'Meeting set', 'Proposal']) assert.match(html, new RegExp(`aria-label="${stage} column"`));
  assert.match(html, /Drop to mark as customer/); assert.match(html, /Drop to mark as lost/); assert.match(html, /aria-busy="true"/);
  const ro = await render('src/ui/crm/ProspectBoard.tsx', 'ProspectBoard', { ...props, readOnly: true });
  assert.match(ro, /This Building is read-only/); assert.doesNotMatch(ro, /Drop to mark/);
});

test('a Customers person card shows its stats, completeness, star toggle and contact buttons', async () => {
  const props = { customer: contact(), projectId: 'p', timeZone: 'UTC', disabled: false, readOnly: false, starred: true, onStar() {}, onOpen() {}, onChanged() {}, onError() {} };
  const html = await render('src/ui/crm/CustomersTab.tsx', 'PersonCard', props);
  assert.match(html, /CEO · Acme/); assert.match(html, /<time [^>]*title="Thu 22 Oct, 00:00"/); assert.match(html, /aria-pressed="true"/); assert.match(html, /aria-valuenow="80"/);
  assert.match(html, /aria-label="Email Ann Lee"/); assert.match(html, /aria-label="Call Ann Lee"[^>]*disabled/);
  assert.match(await render('src/ui/crm/CustomersTab.tsx', 'PersonCard', { ...props, starred: false }), /aria-pressed="false"/);
});

test('the Customers tab starts on its loading text and the contact detail on its back button', async () => {
  const tab = await render('src/ui/crm/CustomersTab.tsx', 'CustomersTab', { project: { id: 'p' }, readOnly: false, onOpenContact() {}, onChanged() {} });
  assert.match(tab, /Loading customers/); assert.match(tab, /aria-pressed="true"[^>]*>Grid/);
  const detail = await render('src/ui/crm/ContactPanel.tsx', 'ContactPanel', { project: { id: 'p' }, contactId: 1, readOnly: false, focusAction: null, onChanged() {}, onClose() {} });
  assert.match(detail, /aria-label="Back to the list"/); assert.match(detail, /Loading…/);
});
