import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const board = await import('../src/lib/crmBoard.ts');
const actions = await import('../src/lib/crmBoardActions.ts');
const kpis = await import('../src/lib/crmKpis.ts');
const customers = await import('../src/lib/crmCustomers.ts');
const reports = await import('../src/lib/crmReports.ts');
const seoKpis = await import('../src/lib/seoKpis.ts');
const pointer = await import('../src/lib/pointerOrigin.ts');
const charts = await import('../src/lib/chartData.ts');
const calendar = await import('../src/lib/crmCalendar.ts');
const prospects = await import('../src/lib/crmProspects.ts');
const workspace = await import('../src/lib/crmWorkspace.ts');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

let nextId = 1;
const contact = (stage, extra = {}) => ({ id: nextId++, name: `P${nextId}`, company: null, title: null, tags: [], custom: {}, segment: 'prospect', stage, channels: [{ id: 1, type: 'email', label: '', handle: 'a@x.com', invalid: false, dnc: false }], dnc: false, customerAt: null, createdAt: 1, ...extra });
const boardOf = (spec) => ({ ...board.emptyBoard(), ...Object.fromEntries(Object.entries(spec).map(([stage, cards]) => [stage, { cards, total: cards.length }])) });

test('U13 U14 U15 stages map to the four accents; unknown or missing stages are neutral', () => {
  assert.deepEqual(board.BOARD_STAGES.map(board.stageAccent), ['neutral', 'yellow', 'green', 'orange', 'charcoal']);
  for (const bad of [null, undefined, '', 'Won']) assert.equal(board.stageAccent(bad), 'neutral');
});

test('U36 "Move to…" offers the four other stages', () => {
  assert.deepEqual(board.moveTargets('Engaged'), ['New', 'Contacted', 'Meeting set', 'Proposal']);
});

test('U26 U27 a column reports what is not loaded and its count line', () => {
  assert.equal(board.columnHidden({ cards: [1, 2, 3], total: 3 }), 0);
  assert.equal(board.columnHidden({ cards: [1, 2, 3], total: 20 }), 17);
  assert.equal(board.columnHidden({ cards: [], total: 0 }), 0);
  assert.equal(board.columnCountLabel({ cards: [], total: 1 }), '1 contact');
  assert.equal(board.columnCountLabel({ cards: [], total: 1200 }), '1,200 contacts');
  assert.equal(board.COLUMN_LIMIT < board.COLUMN_FETCH_LIMIT, true);
});

test('U28 U29 U32 applyMove moves the card to the top of the target and updates totals; same column and unknown id are no-ops', () => {
  const a = contact('New'); const b = contact('New'); const c = contact('Engaged');
  const state = boardOf({ New: [a, b], Engaged: [c] });
  const result = board.applyMove(state, b.id, 'Engaged');
  assert.deepEqual(result.move, { id: b.id, from: 'New', to: 'Engaged', fromIndex: 1 });
  assert.deepEqual(result.board.Engaged.cards.map((x) => [x.id, x.stage]), [[b.id, 'Engaged'], [c.id, 'Engaged']]);
  assert.deepEqual([result.board.New.total, result.board.Engaged.total], [1, 2]);
  assert.equal(board.applyMove(state, a.id, 'New'), null);
  assert.equal(board.applyMove(state, 9999, 'Engaged'), null);
  assert.equal(state.New.cards.length, 2, 'the input is not changed');
});

test('U30 U31 rollback restores the original position; the inverse move names the way back', () => {
  const a = contact('New'); const b = contact('New'); const c = contact('New');
  const state = boardOf({ New: [a, b, c] });
  const { board: moved, move } = board.applyMove(state, b.id, 'Proposal');
  const back = board.rollbackMove(moved, move);
  assert.deepEqual(back.New.cards.map((x) => x.id), [a.id, b.id, c.id]);
  assert.equal(back.New.cards[1].stage, 'New');
  assert.deepEqual([back.New.total, back.Proposal.total], [3, 0]);
  assert.deepEqual(board.inverseMove(move), { id: b.id, stage: 'New' });
  assert.equal(board.rollbackMove(state, move), state, 'a card that is not there is left alone');
});

test('U34 toast text is "Name → Stage" and falls back to the handle, then "Contact"', () => {
  assert.equal(board.moveToastText({ name: 'Support plan upgrade', channels: [] }, 'Proposal'), 'Support plan upgrade → Proposal');
  assert.equal(board.moveToastText({ name: null, channels: [{ handle: 'a@x.com' }] }, 'New'), 'a@x.com → New');
  assert.equal(board.contactLabel({ name: '  ', channels: [] }), 'Contact');
  assert.match(board.moveToastText({ name: 'x'.repeat(300), channels: [] }, 'New'), /→ New$/);
});

test('U35 read-only disables dragging with the shared title', () => {
  assert.equal(workspace.crmControlsDisabled(true), true);
  assert.equal(workspace.disabledTitle(true), workspace.READ_ONLY_TITLE);
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /const disabled = readOnly;/);
  assert.match(text, /draggable=\{!disabled\}/);
  assert.match(text, /disabled=\{disabled\}/);
});

test('U37 U38 the pinned zones are Customer and Lost and open the contact instead of changing a stage', () => {
  assert.deepEqual(board.DROP_ZONES.map((z) => z.key), ['customer', 'lost']);
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /onZoneDrop\(dragging\.id, zone\)/);
  assert.ok(!/setStage\([^)]*zone/.test(text));
});

const harness = (initial, { failing = new Set() } = {}) => {
  let current = initial; let reload = 0; const log = []; let undo = null; let error = 'unset'; const held = [];
  const deps = {
    setStage: (id, stage) => { log.push(['setStage', id, stage]); const key = `${id}:${stage}`; if (failing.has(key)) return Promise.reject(new Error('refused')); if (held.length) return new Promise((resolve) => held.push(resolve)); return Promise.resolve({}); },
    getBoard: () => current, setBoard: (update) => { current = update(current); }, invalidateLoads: () => { reload += 1; },
    offerUndo: (text, fn) => { log.push(['toast', text]); undo = fn; }, reportError: (m) => { error = m; }, describeError: (e) => e.message,
  };
  return { deps, board: () => current, log, reloads: () => reload, undo: () => undo?.(), lastUndo: () => undo, error: () => error, held };
};

test('I02 C23 a drop moves the card at once, saves once, then offers Undo which saves the way back', async () => {
  const a = contact('New', { name: 'Ann' });
  const h = harness(boardOf({ New: [a] }));
  const api = actions.createBoardActions(h.deps);
  assert.equal(await api.moveCard(a.id, 'Contacted'), true);
  assert.deepEqual(h.log, [['setStage', a.id, 'Contacted'], ['toast', 'Ann → Contacted']]);
  assert.equal(h.board().Contacted.cards.length, 1);
  assert.equal(h.reloads(), 1, 'in-flight loads are ended so they cannot undo the move');
  h.undo();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(h.log.slice(2), [['setStage', a.id, 'New']]);
  assert.equal(h.board().New.cards.length, 1);
  assert.equal(h.error(), null);
});

test('C24 I03 a refused save puts the card back and says why; no Undo is offered', async () => {
  const a = contact('New');
  const h = harness(boardOf({ New: [a] }), { failing: new Set([`${a.id}:Engaged`]) });
  assert.equal(await actions.createBoardActions(h.deps).moveCard(a.id, 'Engaged'), false);
  assert.equal(h.board().New.cards.length, 1);
  assert.equal(h.board().Engaged.cards.length, 0);
  assert.equal(h.error(), 'refused');
  assert.ok(!h.log.some(([kind]) => kind === 'toast'));
});

test('C25 a failing Undo moves the card forward again and shows the error', async () => {
  const a = contact('New');
  const h = harness(boardOf({ New: [a] }), { failing: new Set([`${a.id}:New`]) });
  const api = actions.createBoardActions(h.deps);
  await api.moveCard(a.id, 'Proposal');
  h.undo();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.board().Proposal.cards.length, 1);
  assert.equal(h.error(), 'refused');
});

test('U29 dropping on the same column does nothing and saves nothing', async () => {
  const a = contact('New');
  const h = harness(boardOf({ New: [a] }));
  assert.equal(await actions.createBoardActions(h.deps).moveCard(a.id, 'New'), false);
  assert.deepEqual(h.log, []);
});

test('U33 I04 a failure of one move never undoes a later move of another card', async () => {
  const a = contact('New'); const b = contact('New');
  const h = harness(boardOf({ New: [a, b] }), { failing: new Set([`${a.id}:Engaged`]) });
  const api = actions.createBoardActions(h.deps);
  const first = api.moveCard(a.id, 'Engaged');
  await api.moveCard(b.id, 'Proposal');
  await first;
  assert.deepEqual(h.board().New.cards.map((c) => c.id), [a.id]);
  assert.deepEqual(h.board().Proposal.cards.map((c) => c.id), [b.id]);
});

test('I04 a late list answer is ignored once a move has begun (the board bumps its load token)', () => {
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /invalidateLoads: \(\) => \{ loadToken\.current \+= 1; setSettledKey\(requestKeyRef\.current\); \}/);
  assert.match(text, /if \(loadToken\.current === token\)/);
});

test('I01 the board loads one capped call per stage and does not use the shared contacts store', () => {
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /BOARD_STAGES\.map\(async \(stage\)/);
  assert.match(text, /crmApi\.contacts\(projectId, queryParams\(\{ \.\.\.query, segment: 'prospect', stage, offset: 0, limit \}\)\)/);
  assert.ok(!/useCrmStore/.test(text));
  assert.match(text, /expanded\.has\(stage\) \? COLUMN_FETCH_LIMIT : COLUMN_LIMIT/);
});

test('C26 the card menu is the keyboard way to move a card', () => {
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /Move to…/);
  assert.match(text, /moveTargets\(contact\.stage \?\? 'New'\)/);
  assert.match(text, /aria-label=\{`Actions for \$\{contactLabel\(contact\)\}`\}/);
});

test('C21 C22 C29 Prospects opens on Board, toggles to List, and keeps server paging and filters', () => {
  const text = src('ui/crm/ProspectsTab.tsx');
  assert.match(text, /useState<Mode>\('board'\)/);
  assert.match(text, /\{ value: 'board', label: 'Board' \}, \{ value: 'list', label: 'List' \}/);
  assert.match(text, /withOffset\(q, nav\.prevOffset\)/);
  assert.match(text, /<DataTable/);
  assert.match(text, /<FilterChips/);
  assert.match(text, /icon=\{<Search \/>\}/);
  assert.match(text, /crmControlsDisabled/);
  assert.match(text, /disabledTitle\(readOnly\)/);
  assert.match(src('ui/crm/ProspectBoard.tsx'), /Pending reachout|onOpenPending/);
  assert.match(src('ui/crm/ProspectBoard.tsx'), /Show all \{column\.total\}/);
});

test('U18 U19 KPIs per tab come from loaded counts; a missing count is omitted, a real 0 stays', async () => {
  const counts = { ...kpis.noCounts(), prospects: 12, pendingReachouts: 0, awaitingApproval: null, overdueFollowups: 3, customers: 4, sentToday: null, lostProspects: 1, lostCustomers: 0 };
  const labels = (tab) => kpis.kpisForTab(tab, counts).map((k) => k.label);
  assert.deepEqual(labels('calendar'), ['Overdue followups', 'Pending reachouts', 'Awaiting approval', 'Sent today']);
  assert.deepEqual(labels('prospects'), ['Prospects', 'Pending reachouts', 'Awaiting approval']);
  assert.deepEqual(labels('customers'), ['Customers']);
  assert.deepEqual(labels('lost'), ['Lost prospects', 'Lost customers']);
  assert.deepEqual(labels('import'), ['Prospects', 'Customers']);
  for (const tab of ['merge', 'notes', 'reports', 'settings']) assert.deepEqual(labels(tab), []);
  const { presentKpis } = await import('../src/lib/kpi.ts');
  assert.deepEqual(presentKpis(kpis.kpisForTab('calendar', counts)).map((k) => k.value), [3, 0]);
});

test('U18b the expand-today and report counts read the groups and the day metrics', () => {
  const groups = [{ id: 'overdue', cards: [1, 2] }, { id: 'awaiting_approval', cards: [] }];
  assert.deepEqual(kpis.expandCounts({ groups }), { overdue: 2, awaiting: 0 });
  assert.deepEqual(kpis.expandCounts({ groups: [] }), { overdue: null, awaiting: null });
  const day = (m) => ({ period: { metrics: m } });
  assert.equal(kpis.sentTodayFrom(day({ reachoutsSent: 2, followupsSent: 3 })), 5);
  assert.equal(kpis.sentTodayFrom(day({ reachoutsSent: null, followupsSent: 3 })), 3);
  assert.equal(kpis.sentTodayFrom(day({ reachoutsSent: null, followupsSent: null })), null);
  assert.equal(kpis.sentTodayFrom(day({ reachoutsSent: 0, followupsSent: 0 })), 0);
});

test('C20 the workspace has nine pill tabs, each with a title, a PageHeader and a KpiRow', () => {
  assert.equal(workspace.CRM_TABS.length, 9);
  for (const tab of workspace.CRM_TABS) assert.equal(tab.title.length, 2);
  const text = src('ui/CrmWorkspace.tsx');
  assert.match(text, /<PageHeader lines=\{meta\.title\}><KpiRow/);
  assert.match(text, /CRM_TABS\.map/);
  assert.match(text, /<ContactPanel/);
});

test('U39 U40 customer card helpers: completeness, since text, links, role line', () => {
  const base = { name: 'Ann', company: 'Acme', title: 'CEO', tags: ['vip'], channels: [{ type: 'email', handle: 'a@x.com', invalid: false, dnc: false }, { type: 'phone', handle: '+1 555 01', invalid: true, dnc: false }], dnc: false };
  assert.equal(customers.profileCompleteness(base), 100);
  assert.equal(customers.profileCompleteness({ ...base, tags: [], title: ' ' }), 60);
  assert.equal(customers.profileCompleteness({ name: null, company: null, title: null, tags: [], channels: [] }), 0);
  assert.equal(customers.emailHref(base), 'mailto:a@x.com');
  assert.equal(customers.phoneHref(base), null, 'an invalid number is not offered');
  assert.equal(customers.phoneHref({ ...base, channels: [{ type: 'phone', handle: '+1 555 0100', invalid: false, dnc: false }] }), 'tel:+15550100');
  assert.equal(customers.emailHref({ ...base, dnc: true }), null);
  assert.equal(customers.roleLine(base), 'CEO · Acme');
  assert.equal(customers.roleLine({ title: null, company: null }), 'No company');
  assert.equal(customers.sinceAt({ customerAt: Date.UTC(2026, 9, 22), createdAt: 1 }), Date.UTC(2026, 9, 22));
  assert.equal(customers.sinceAt({ customerAt: null, createdAt: Date.UTC(2026, 0, 2) }), Date.UTC(2026, 0, 2));
  assert.equal(customers.sinceAt({ customerAt: null, createdAt: Number.NaN }), null);
  assert.equal(customers.sinceAt({ customerAt: null, createdAt: 0 }), null);
});

test('U41 the Customers segment chips filter by attached Buildings', () => {
  const rows = [{ id: 1, buildings: [] }, { id: 2, buildings: [1] }];
  assert.deepEqual(customers.filterCustomers(rows, 'all').map((r) => r.id), [1, 2]);
  assert.deepEqual(customers.filterCustomers(rows, 'with-buildings').map((r) => r.id), [2]);
  assert.deepEqual(customers.filterCustomers(rows, 'no-buildings').map((r) => r.id), [1]);
  assert.deepEqual(customers.GRID_VIEWS.map((v) => v.value), ['grid', 'table']);
});

test('C30 C31 the Customers grid shows person cards with the attach controls, a Grid/Table toggle and its empty state', () => {
  const text = src('ui/crm/CustomersTab.tsx');
  assert.match(text, /<SegmentedControl label="Layout"/);
  assert.match(text, /md:grid-cols-2/);
  assert.match(text, /<ScoreBar/);
  assert.match(text, /aria-pressed=\{starred\}/);
  assert.match(text, /Attach a Building/);
  assert.match(text, /crmApi\.detachBuilding/);
  assert.match(text, /crmApi\.attachBuilding/);
  assert.match(text, /No customers yet/);
  assert.match(text, /crmControlsDisabled/);
  assert.match(text, /<DataTable/);
});

test('U44 detailed information rows list company, title, source, tags and custom fields; empties read (empty)', () => {
  const rows = prospects.detailRows({ company: 'Acme', title: null, source: 'csv', tags: ['a', 'b'], custom: { f1: 'EU' } }, [{ id: 'f1', name: 'Region' }, { id: 'f2', name: 'Size' }]);
  assert.deepEqual(rows.map((r) => [r.label, r.value, r.empty]), [['Company', 'Acme', false], ['Title', '(empty)', true], ['Source', 'csv', false], ['Tags', 'a, b', false], ['Region', 'EU', false], ['Size', '(empty)', true]]);
  assert.equal(prospects.detailRows({ company: '', title: '', source: '', tags: [], custom: {} }, []).every((r) => r.empty), true);
});

test('U44b timeline entries take their colour from the kind', () => {
  assert.deepEqual(['comment', 'lost_marked', 'followup_failed', 'message_sent', 'response_logged', 'merge', 'stage_changed', 'whatever'].map(prospects.timelineAccent), ['yellow', 'orange', 'orange', 'green', 'green', 'charcoal', 'charcoal', 'neutral']);
});

test('C32 C33 the contact detail takes over with a back button and keeps every action', () => {
  const text = src('ui/crm/ContactPanel.tsx');
  assert.match(text, /aria-label="Back to the list"/);
  assert.match(text, /<ScoreRing/);
  assert.match(text, /Detailed Information/);
  assert.match(text, /Interaction History/);
  for (const api of ['markCustomer', 'markLost', 'setDnc', 'setStage', 'reopen', 'patchChannel', 'reachout', 'removeChannel', 'addChannel', 'approve', 'reject', 'undoMerge', 'addComment', 'editComment', 'deleteComment', 'createFollowup']) assert.match(text, new RegExp(`crmApi\\.${api}\\(`), api);
  assert.match(text, /<ResponseForm/);
  assert.match(text, /Stage to reopen at/);
  assert.match(text, /disabled=\{disabled\}/);
  assert.match(text, /crmControlsDisabled\(readOnly\)/);
  assert.match(text, /aria-label=\{`Copy \$\{label\}`\}/);
  assert.match(text, /focusAction/);
});

test('I05 switching tabs closes the open contact', () => {
  const open = workspace.openContact(workspace.selectTab(workspace.initialWorkspace(), 'customers'), 7);
  assert.equal(workspace.selectTab(open, 'prospects').contactId, null);
  assert.equal(workspace.selectTab(open, 'customers').contactId, 7);
});

test('C34 C35 the reachout popup and Expand Today are stage-coloured modals with pill actions', () => {
  const reachout = src('ui/crm/ReachoutPopup.tsx');
  assert.match(reachout, /<StageModal accent=\{itemAccent\(/);
  assert.match(reachout, /<StatPanel/);
  assert.match(reachout, /<ModalButton solid/);
  assert.match(reachout, /Pending reachout/);
  assert.match(reachout, /submitEnabled\(choice, busy\)/);
  const expand = src('ui/crm/ExpandToday.tsx');
  assert.match(expand, /<StageProgress stages=\{stages\} current=\{current\.groupTitle\}/);
  assert.match(expand, /label="Expand Today"/);
  assert.match(expand, /advance\(true\)/);
  const modal = src('ui/design/StageModal.tsx');
  assert.match(modal, /transition-colors duration-300/);
  assert.match(modal, /bg-current\/15/);
});

test('C36 calendar items are accent-coloured cards: overdue and failed orange, waiting yellow, meetings green, calls charcoal', () => {
  const item = (o) => ({ overdue: false, state: 'planned', type: 'message', ...o });
  assert.equal(calendar.itemAccent(item({ overdue: true })), 'orange');
  assert.equal(calendar.itemAccent(item({ state: 'failed' })), 'orange');
  assert.equal(calendar.itemAccent(item({ state: 'pending' })), 'yellow');
  assert.equal(calendar.itemAccent(item({ type: 'online_meeting' })), 'green');
  assert.equal(calendar.itemAccent(item({ type: 'call' })), 'charcoal');
  assert.equal(calendar.itemAccent(item({})), 'neutral');
  const text = src('ui/crm/CalendarTab.tsx');
  assert.match(text, /<ItemCard/);
  assert.match(text, /min-\[1100px\]:grid-cols-3/);
  assert.match(text, /rounded-2xl/);
});

test('U45 U46 U47 U48 report chart data: both periods per metric, nulls kept, breakdown busiest first', () => {
  const metrics = (v) => ({ prospectsAdded: v, reachoutsSent: null, followupsSent: v, newCustomers: 0, lostProspects: null });
  const r = { period: { label: 'Week', metrics: metrics(5) }, previous: { label: 'Last', metrics: metrics(2) } };
  const groups = reports.periodGroups(r);
  assert.deepEqual(groups.map((g) => g.label), ['Prospects added', 'Reachouts sent', 'Followups sent', 'New customers', 'Lost prospects']);
  assert.deepEqual(groups[1].values, [null, null]);
  assert.deepEqual(groups[3].values, [0, 0]);
  assert.deepEqual(reports.periodSeries(r).map((s) => [s.label, s.dashed ?? false]), [['Week', false], ['Last', true]]);
  const rows = [{ label: 'phone', added: 1, reachoutsSent: 1, followupsSent: null }, { label: 'email', added: 9, reachoutsSent: 4, followupsSent: 2 }, { label: 'none', added: null, reachoutsSent: null, followupsSent: null }, { label: 'zero', added: 0, reachoutsSent: 0, followupsSent: 0 }];
  assert.deepEqual(reports.breakdownGroups(rows).map((g) => g.label), ['email', 'phone', 'zero', 'none']);
  assert.deepEqual(reports.breakdownGroups([]), []);
  assert.equal(reports.metricText(null), 'no data');
  assert.equal(reports.metricText(0), '0');
});

test('U50 chart scale: nice maximums for flat, single, negative and huge values', () => {
  assert.equal(charts.niceMax([]), 1);
  assert.equal(charts.niceMax([0, 0]), 1);
  assert.equal(charts.niceMax([null, null]), 1);
  assert.equal(charts.niceMax([3]), 5);
  assert.equal(charts.niceMax([-4, -1]), 1);
  assert.equal(charts.niceMax([24, 60]), 100);
  assert.equal(charts.niceMax([1.2e9]), 2e9);
  assert.equal(charts.niceMax([Number.NaN, 7]), 10);
  assert.deepEqual(charts.axisTicks(100), [0, 25, 50, 75, 100]);
});

test('U51 U52 bar layout: no NaN, null draws no bar, a hover x finds its group clamped to the ends', () => {
  const groups = [{ label: 'a', values: [10, null] }, { label: 'b', values: [5, 0] }];
  const layout = charts.barLayout(groups, 2, { width: 400, height: 100 });
  assert.equal(layout.rects.length, 3, 'null has no bar');
  for (const rect of layout.rects) for (const value of [rect.x, rect.y, rect.width, rect.height]) assert.ok(Number.isFinite(value));
  assert.equal(layout.rects[0].height, 100, 'the maximum fills the plot');
  assert.equal(layout.rects[2].height, 0, 'a real zero is a zero-height bar');
  assert.equal(charts.barLayout([], 2, { width: 400, height: 100 }).rects.length, 0);
  assert.equal(charts.barLayout(groups, 0, { width: 400, height: 100 }).rects.every((r) => r.width === 0), true);
  assert.equal(charts.groupAt(-50, 200, 2), 0);
  assert.equal(charts.groupAt(250, 200, 2), 1);
  assert.equal(charts.groupAt(9999, 200, 2), 1);
  assert.equal(charts.groupAt(10, 200, 0), null);
  assert.equal(charts.groupAt(10, 0, 2), null);
});

test('U54 chart colours come only from token variables', () => {
  const text = src('ui/design/Charts.tsx');
  assert.match(text, /accentVar\(/);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(text));
  assert.match(text, /className="sr-only"/);
});

test('C37 reports: tiles, charts, tooltip card, "no data" and an Export CSV pill menu', () => {
  const text = src('ui/crm/ReportsTab.tsx');
  assert.match(text, /<BarChart/);
  assert.match(text, /metricText\(r\.period\.metrics\[tile\.key\]\)/);
  assert.match(text, /Export CSV/);
  assert.match(text, /<DropdownMenu>/);
  assert.match(text, /compare\(/);
  assert.match(text, /NO_DATA/);
  assert.match(src('ui/design/Charts.tsx'), /role="status"/);
  assert.ok(!/crmApi\.(markLost|setStage|createContact)/.test(text));
});

test('C38 the remaining tabs use the shared components and no raw colours', () => {
  for (const file of ['LostTab', 'ImportTab', 'MergeTab', 'NotesTab', 'SettingsTab']) {
    const text = src(`ui/crm/${file}.tsx`);
    assert.ok(/Section|DataTable/.test(text), file);
    assert.ok(!/<select\b/.test(text), `${file} uses NativeSelect`);
  }
});

test('I08 CSV export links are unchanged', () => {
  assert.equal(reports.csvFileName('summary', 'week'), 'crm-summary-week.csv');
  assert.deepEqual(reports.EXPORT_TABLES.map((t) => t.value), ['summary', 'by-channel', 'by-source']);
});

test('I14 the CRM views never call fetch directly: every request goes through crmApi', () => {
  for (const file of ['ProspectBoard', 'ProspectsTab', 'CustomersTab', 'ContactPanel', 'ReportsTab', 'useCrmCounts']) {
    const text = file === 'useCrmCounts' ? src('ui/crm/useCrmCounts.ts') : src(`ui/crm/${file}.tsx`);
    assert.ok(!/\bfetch\(/.test(text), file);
  }
});

test('a stale Undo does nothing: a card moved again since the toast is not sent back', async () => {
  const a = contact('New', { name: 'Ann' });
  const h = harness(boardOf({ New: [a] }));
  const api = actions.createBoardActions(h.deps);
  await api.moveCard(a.id, 'Contacted');
  const staleUndo = h.lastUndo();
  await api.moveCard(a.id, 'Proposal');
  const before = h.log.length;
  staleUndo();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.log.length, before, 'no setStage for the stale undo');
  assert.equal(h.board().Proposal.cards.length, 1);
});

test('the board is loading until its request settles, and a move ends the wait', () => {
  const text = src('ui/crm/ProspectBoard.tsx');
  assert.match(text, /const loading = settledKey !== requestKey;/);
  assert.match(text, /setSettledKey\(requestKey\)/);
});

test('KPI counts are read again only when the data changes, not on a tab switch', () => {
  const text = src('ui/CrmWorkspace.tsx');
  assert.match(text, /useCrmCounts\(project\.id, String\(dataVersion\)\)/);
  assert.match(text, /onChanged=\{changed\}/);
  for (const file of ['ContactPanel', 'ProspectsTab', 'CustomersTab', 'LostTab', 'ImportTab', 'MergeTab', 'CalendarTab']) assert.match(src(`ui/crm/${file}.tsx`), /onChanged\(\)/, file);
});

test('U45 the period chart is a line chart of current against a dashed previous period', () => {
  assert.match(src('ui/crm/ReportsTab.tsx'), /<LineChart label=/);
  const run = (values) => charts.linePoints(values.map((v, i) => ({ label: String(i), values: [v] })), 0, { width: 300, height: 100 }, 10);
  assert.deepEqual(run([2, null, 4, 6]).map((r) => r.length), [1, 2], 'a null splits the line');
  assert.deepEqual(run([null, null]), []);
  assert.equal(run([10])[0][0].y, 0);
  assert.equal(charts.smoothPath([]), '');
  assert.match(charts.smoothPath([{ x: 1, y: 2 }]), /^M1\.00 2\.00$/);
  const path = charts.smoothPath([{ x: 0, y: 10 }, { x: 10, y: 0 }, { x: 20, y: 5 }]);
  assert.ok(!/NaN/.test(path) && path.startsWith('M0.00 10.00 C'));
  assert.equal(charts.areaPath([{ x: 0, y: 1 }], 50), '');
  assert.match(charts.areaPath([{ x: 0, y: 1 }, { x: 5, y: 2 }], 50), / L5\.00 50 L0\.00 50 Z$/);
});

test('SEO tabs get a KPI row from data already loaded; a missing slice is omitted', async () => {
  const { presentKpis } = await import('../src/lib/kpi.ts');
  const data = { ...seoKpis.noSeoKpiData(), keywords: 120, clusters: 9, pendingSuggestions: 0, backlinks: 40, referringDomains: null };
  assert.deepEqual(presentKpis(seoKpis.seoKpisForTab('keywords', data)).map((k) => [k.label, k.value]), [['Keywords', 120], ['Clusters', 9], ['To review', 0]]);
  assert.deepEqual(presentKpis(seoKpis.seoKpisForTab('backlinks', data)).map((k) => k.label), ['Backlinks']);
  assert.deepEqual(seoKpis.seoKpisForTab('sitemaps', data).map((k) => k.label), ['Sitemaps', 'URLs']);
  assert.deepEqual(seoKpis.seoKpisForTab('pages', data).map((k) => k.label), ['Pages']);
  for (const tab of ['reports', 'internal-links', 'tasks', 'settings']) assert.deepEqual(seoKpis.seoKpisForTab(tab, data), []);
  const shell = src('ui/SeoWorkspace.tsx');
  assert.match(shell, /<PageHeader size="md"/); assert.match(shell, /<Section title=/);
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /<PageHeader\s+size="md"\s+titleAs=\{DialogTitle\}/);
  assert.match(src('ui/ProjectWorkspaceModal.tsx'), /countProjectTasks/);
});

test('a stage modal grows out of the last pointer-down and zooms plainly after a keyboard open', () => {
  pointer.resetPointerOrigin();
  assert.equal(pointer.zoomOffset({ width: 1000, height: 800 }), null);
  const listeners = {};
  const doc = { addEventListener: (type, fn, capture) => { listeners[type] = [fn, capture]; }, removeEventListener: (type) => { delete listeners[type]; } };
  const stop = pointer.trackPointerOrigin(doc);
  assert.equal(listeners.pointerdown[1], true);
  listeners.pointerdown[0]({ clientX: 100, clientY: 700 });
  assert.deepEqual(pointer.zoomOffset({ width: 1000, height: 800 }), { dx: -400, dy: 300 });
  stop();
  assert.equal(listeners.pointerdown, undefined);
  assert.match(src('styles/shadcn.css'), /\.stage-modal-zoom\[data-state='open'\] \{ animation: stage-modal-zoom/);
  assert.match(src('ui/design/StageModal.tsx'), /stage-modal-zoom/);
  assert.match(src('main.tsx'), /trackPointerOrigin\(\)/);
  pointer.resetPointerOrigin();
});

test('a calendar item names its contact like the panel: name, else the item channel handle, else "Contact"', () => {
  assert.equal(board.itemContactLabel({ contactName: 'Ann Lee', channelHandle: '+919910166500' }), 'Ann Lee');
  assert.equal(board.itemContactLabel({ contactName: null, channelHandle: '+919910166500' }), '+919910166500');
  assert.equal(board.itemContactLabel({ contactName: '   ', channelHandle: 'a@x.com' }), 'a@x.com');
  assert.equal(board.itemContactLabel({ contactName: null, channelHandle: null }), 'Contact');
  assert.equal(board.itemContactLabel({ contactName: null, channelHandle: '+919910166500' }), board.contactLabel({ name: null, channels: [{ handle: '+919910166500' }] }), 'matches the contact panel heading');
});

test('Calendar, Expand Today and the reachout popup label the contact with itemContactLabel, never a name-only fallback', () => {
  const sites = { 'ui/crm/CalendarTab.tsx': 3, 'ui/crm/ExpandToday.tsx': 2, 'ui/crm/ReachoutPopup.tsx': 1 };
  for (const [file, count] of Object.entries(sites)) {
    const text = src(file);
    assert.equal(text.match(/itemContactLabel\(/g)?.length, count, file);
    assert.doesNotMatch(text, /contactName \?\?|\.contactName \?/, file);
  }
});
