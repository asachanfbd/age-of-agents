import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
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
const { useWorldStore } = await import('../src/store/worldStore.ts');
const lib = await import('../src/lib/connections.ts');
const { installServerStub } = await import('./serverStub.mjs');
const { CLEAN_ERROR_STATE } = await import('./errorHelpers.mjs');
const src = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const stubSource = readFileSync(new URL('./serverStub.mjs', import.meta.url), 'utf8');

const CAPABILITIES = [
  { id: 'read-report', description: 'Reads a report', mode: 'read', inputs: [{ name: 'topic', type: 'string', required: true, max: 5 }], outputs: [] },
  { id: 'send-report', description: 'Sends a report', mode: 'write', inputs: [{ name: 'to', type: 'string', required: true, max: 20 }], outputs: [] },
  { id: 'quiet-write', description: 'Writes without asking', mode: 'write', requiresApproval: false, inputs: [], outputs: [] },
];
const EVENTS = [{ id: 'report-published', description: 'A report was published' }];

function setup() {
  const stub = installServerStub();
  stub.buildings.types.push({ id: 'seo', name: 'SEO', slots: [], agents: [], scheduledJobs: [], capabilities: CAPABILITIES, events: EVENTS });
  stub.buildings.types.push({ id: 'sales', name: 'Sales', slots: [], agents: [], scheduledJobs: [], capabilities: [], events: [] });
  const building = (id, typeId, position = [0, 0]) => {
    stub.projects.set(id, { id, typeId, name: id, position, readOnly: false, readOnlyReason: null, status: 'idle' });
    return id;
  };
  building('sales-1', 'sales', [0, 0]);
  building('seo-1', 'seo', [10, 0]);
  useWorldStore.setState({ linksByProject: {}, allLinks: [], subscriptionsByProject: {}, activityByProject: {}, connectionLoadErrorByProject: {}, ...CLEAN_ERROR_STATE });
  return { stub, building };
}
const store = () => useWorldStore.getState();
const grants = (...ids) => ids.map((capabilityId) => ({ capabilityId, preApproved: false }));
async function linked(stub, over = {}) {
  const result = await store().createLink('sales-1', { fromBuildingId: 'sales-1', toBuildingId: 'seo-1', capabilities: grants('read-report', 'send-report'), events: ['report-published'], ...over });
  assert.equal(result.ok, true, JSON.stringify(result));
  return [...stub.connections.links.values()][0];
}

// ---- Store, through the stub ----

test('C01 the stub answers every route the store and the scene call', async () => {
  const { stub } = setup();
  const link = await linked(stub);
  const routes = [
    ['GET', '/api/links'], ['GET', '/api/projects/sales-1/links'], ['PATCH', `/api/links/${link.id}`, {}], ['GET', '/api/projects/sales-1/subscriptions'],
    ['GET', '/api/projects/sales-1/activity'], ['POST', '/api/projects/sales-1/capability-calls', { targetBuildingId: 'seo-1', capabilityId: 'read-report', inputs: { topic: 'a' } }],
  ];
  for (const [method, path, body] of routes) {
    const res = await fetch(`http://localhost:4500${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.notEqual(res.status, 500, `${method} ${path}`);
  }
  for (const route of ['/api/subscriptions', 'capability-calls', 'decision', 'subscriptions']) assert.ok(stubSource.includes(route), route);
});

test('C02 loading links fills the store for that Building, outgoing and incoming', async () => {
  const { stub } = setup();
  await linked(stub);
  await store().loadLinks('sales-1');
  await store().loadLinks('seo-1');
  assert.deepEqual([store().linksByProject['sales-1'].outgoing.length, store().linksByProject['sales-1'].incoming.length], [1, 0]);
  assert.deepEqual([store().linksByProject['seo-1'].outgoing.length, store().linksByProject['seo-1'].incoming.length], [0, 1]);
});

test('C03 creating a link reloads the Building and the scene; a refusal comes back with its reason and field', async () => {
  const { stub } = setup();
  await linked(stub);
  assert.equal(store().linksByProject['sales-1'].outgoing.length, 1);
  assert.equal(store().allLinks.length, 1);
  const duplicate = await store().createLink('sales-1', { fromBuildingId: 'sales-1', toBuildingId: 'seo-1' });
  assert.deepEqual([duplicate.ok, duplicate.status], [false, 409]);
  assert.match(duplicate.error, /^Not possible right now: /);
  const unknown = await store().createLink('sales-1', { fromBuildingId: 'sales-1', toBuildingId: 'seo-1-x' });
  assert.equal(unknown.status, 404);
  stub.connections.links.clear();
  const bad = await store().createLink('sales-1', { fromBuildingId: 'sales-1', toBuildingId: 'seo-1', capabilities: grants('nope') });
  assert.deepEqual([bad.status, bad.field], [400, 'capabilities[0].capabilityId']);
});

test('C04 updating the grants changes the stored link', async () => {
  const { stub } = setup();
  const link = await linked(stub);
  const result = await store().updateLink('sales-1', link.id, { capabilities: [{ capabilityId: 'send-report', preApproved: true }] });
  assert.equal(result.ok, true);
  assert.deepEqual(store().linksByProject['sales-1'].outgoing[0].capabilities, [{ capabilityId: 'send-report', preApproved: true }]);
});

test('C05 deleting a link removes it and its subscriptions from the store', async () => {
  const { stub } = setup();
  const link = await linked(stub);
  await store().createSubscription('sales-1', { sourceBuildingId: 'seo-1', eventId: 'report-published', jobId: 'job-1' });
  assert.equal(store().subscriptionsByProject['sales-1'].length, 1);
  assert.equal((await store().deleteLink('sales-1', link.id)).ok, true);
  assert.equal(store().linksByProject['sales-1'].outgoing.length, 0);
  assert.equal(store().allLinks.length, 0);
  assert.equal(store().subscriptionsByProject['sales-1'].length, 0);
  assert.equal((await store().deleteLink('sales-1', link.id)).status, 404);
});

test('C06 a manual call that works hands back its outcome and refreshes the log', async () => {
  const { stub } = setup();
  await linked(stub);
  const result = await store().callCapability('sales-1', { targetBuildingId: 'seo-1', capabilityId: 'read-report', inputs: { topic: 'seo' } });
  assert.deepEqual([result.ok, result.outcome.state, result.outcome.outputs], [true, 'done', { echoed: { topic: 'seo' } }]);
  assert.equal(store().activityByProject['sales-1'].length, 1);
  const held = await store().callCapability('sales-1', { targetBuildingId: 'seo-1', capabilityId: 'send-report', inputs: { to: 'ann' } });
  assert.equal(held.outcome.state, 'awaiting-approval');
  const [entry] = store().activityByProject['sales-1'];
  assert.equal(entry.result, 'awaiting-approval');
  assert.equal((await store().decideCapabilityCall('sales-1', entry.id, 'approve')).ok, true);
  assert.equal(store().activityByProject['sales-1'][0].result, 'ok');
});

test('C07 a refused call comes back as a banner for 400, 403, 404 and 409', async () => {
  const { stub } = setup();
  const send = (call) => store().callCapability('sales-1', { targetBuildingId: 'seo-1', inputs: {}, ...call });
  const unlinked = await send({ capabilityId: 'read-report', inputs: { topic: 'a' } });
  assert.deepEqual([unlinked.status, unlinked.error], [403, 'The link does not allow this: The Buildings are not linked. Link them in Connections first.']);
  await linked(stub, { capabilities: grants('read-report') });
  const ungranted = await send({ capabilityId: 'send-report', inputs: { to: 'a' } });
  assert.equal(ungranted.status, 403);
  const unknown = await send({ capabilityId: 'nope' });
  assert.equal(unknown.status, 404);
  const malformed = await send({ capabilityId: 'read-report', inputs: {} });
  assert.deepEqual([malformed.status, malformed.field, malformed.error], [400, 'topic', 'A value was not accepted: topic is required']);
  stub.connections.busy.add('seo-1|read-report');
  const busy = await send({ capabilityId: 'read-report', inputs: { topic: 'a' } });
  assert.deepEqual([busy.status, busy.error], [409, 'Not possible right now: The Building is busy']);
});

test('C09 loading the log sends only the filters that are set, and a backwards range is refused before sending', async () => {
  const { stub } = setup();
  await linked(stub);
  await store().callCapability('sales-1', { targetBuildingId: 'seo-1', capabilityId: 'read-report', inputs: { topic: 'a' } });
  assert.equal((await store().loadActivity('sales-1', { capability: 'read-report', result: 'ok' })).ok, true);
  assert.equal(store().activityByProject['sales-1'].length, 1);
  await store().loadActivity('sales-1', { capability: 'other' });
  assert.equal(store().activityByProject['sales-1'].length, 0);
  const backwards = await store().loadActivity('sales-1', { from: '2026-10-13T00:00', to: '2026-10-12T00:00' });
  assert.deepEqual([backwards.ok, backwards.status], [false, 400]);
  assert.equal((await store().loadActivity('missing')).status, 404);
});

// ---- Pure view logic ----

const link = (over = {}) => ({
  id: 'l1', fromBuildingId: 'a', toBuildingId: 'b', fromName: 'A', toName: 'B', capabilities: grants('x', 'y'), events: ['e'], broken: false, brokenReasons: [], createdAt: '', updatedAt: '', ...over,
});

test('C10 links group as outgoing first, then incoming, each naming the other Building', () => {
  const rows = lib.linkRows({ outgoing: [link()], incoming: [link({ id: 'l2', fromBuildingId: 'c', toBuildingId: 'a', fromName: 'C', toName: 'A', capabilities: [], events: [] })] });
  assert.deepEqual(rows.map((r) => [r.id, r.direction, r.otherName, r.summary]), [['l1', 'outgoing', 'B', '2 capabilities, 1 event'], ['l2', 'incoming', 'C', '0 capabilities, 0 events']]);
});

test('C11 a broken link says so with its reasons', () => {
  const [row] = lib.linkRows({ outgoing: [link({ broken: true, brokenReasons: ['The target no longer offers "x"'] })], incoming: [] });
  assert.deepEqual([row.broken, row.brokenReasons], [true, ['The target no longer offers "x"']]);
});

test('C12 the error mapper leads with the reason for 400, 403, 404, 409 and 504, and copes with an unknown status or no message', () => {
  assert.equal(lib.describeConnectionError(400, 'topic is required'), 'A value was not accepted: topic is required');
  assert.equal(lib.describeConnectionError(403, 'no link'), 'The link does not allow this: no link');
  assert.equal(lib.describeConnectionError(404, 'gone'), 'Not found: gone');
  assert.equal(lib.describeConnectionError(409, 'busy'), 'Not possible right now: busy');
  assert.equal(lib.describeConnectionError(504, null), 'The other Building did not answer in time');
  assert.equal(lib.describeConnectionError(418, 'teapot'), 'teapot');
  assert.equal(lib.describeConnectionError(418, undefined), 'The request failed');
  assert.equal(lib.describeConnectionError(0, ' '), 'The request failed');
});

const entry = (over = {}) => ({
  id: 'e1', at: '2026-10-12T09:00:00.000Z', kind: 'call', callerKind: 'job', callerBuildingId: 'a', callerName: 'A', callerRefId: 'j', targetBuildingId: 'b', targetName: 'B', name: 'read-report',
  inputsSummary: '{"topic":"seo"}', inputsShortened: false, result: 'ok', status: 200, message: null, runRef: null, role: 'caller', ...over,
});

test('C13 an Activity row shows who called what, a readable result and the inputs', () => {
  assert.deepEqual(lib.activityRow(entry()), {
    id: 'e1', time: '2026-10-12T09:00:00.000Z', caller: 'A (Scheduled job)', target: 'B', what: 'read-report', summary: '{"topic":"seo"}', resultLabel: 'Done', tone: 'ok', message: null, runRef: null,
  });
  assert.equal(lib.activityRow(entry({ inputsShortened: true })).summary, '{"topic":"seo"}…');
  assert.deepEqual([lib.activityRow(entry({ result: 'refused' })).tone, lib.activityRow(entry({ result: 'awaiting-approval' })).resultLabel], ['bad', 'Waiting for approval']);
  assert.equal(lib.activityRow(entry({ kind: 'event', callerKind: 'event' })).caller, 'A (Event)');
});

test('C14 a Building that is gone reads "Building deleted", also when the name is missing or blank', () => {
  assert.equal(lib.buildingLabel(null), 'Building deleted');
  assert.equal(lib.buildingLabel('  '), 'Building deleted');
  assert.equal(lib.buildingLabel('Sales'), 'Sales');
  assert.equal(lib.activityRow(entry({ targetName: 'Building deleted' })).target, 'Building deleted');
  assert.equal(lib.linkRows({ outgoing: [link({ toName: null })], incoming: [] })[0].otherName, 'Building deleted');
});

test('C15 a run link is carried through when the entry has a run reference, and is null otherwise', () => {
  assert.equal(lib.activityRow(entry({ runRef: 'run-9' })).runRef, 'run-9');
  assert.equal(lib.activityRow(entry()).runRef, null);
});

test('C16 filters become a query string and an empty filter is left out', () => {
  assert.equal(lib.activityQuery({}), '');
  assert.equal(lib.activityQuery({ caller: '', capability: 'read-report', result: '', from: undefined }), '?capability=read-report');
  assert.equal(lib.activityQuery({ caller: 'a b', result: 'ok' }), '?caller=a+b&result=ok');
});

test('C17 a time range that ends before it starts is blocked, an open or equal one is not', () => {
  assert.match(lib.activityRangeProblem({ from: '2026-10-13T00:00', to: '2026-10-12T00:00' }), /must not be later/);
  assert.equal(lib.activityRangeProblem({ from: '2026-10-12T00:00', to: '2026-10-12T00:00' }), null);
  assert.equal(lib.activityRangeProblem({ from: '2026-10-12T00:00' }), null);
  assert.equal(lib.activityRangeProblem({}), null);
});

test('C18 the call form is built from the capability\'s inputs', () => {
  const capability = { inputs: [
    { name: 'to', type: 'string', required: true, max: 20 }, { name: 'count', type: 'integer' }, { name: 'urgent', type: 'boolean' },
    { name: 'kind', type: 'enum', values: ['a', 'b'] }, { name: 'tags', type: 'array', max: 3, items: { name: 't', type: 'string' } },
  ] };
  assert.deepEqual(lib.callFields(capability).map((f) => [f.name, f.kind, f.required, f.max, f.options]), [
    ['to', 'text', true, 20, []], ['count', 'number', false, null, []], ['urgent', 'checkbox', false, null, []], ['kind', 'select', false, null, ['a', 'b']], ['tags', 'json', false, 3, []],
  ]);
  assert.deepEqual(lib.buildCallInputs(capability, { to: 'ann', count: '3', urgent: true, kind: '', tags: '["x"]' }), { to: 'ann', count: 3, urgent: true, tags: ['x'] });
  assert.deepEqual(lib.buildCallInputs(capability, {}), {});
});

test('C19 text one over its cap blocks sending and is never shortened', () => {
  const capability = { inputs: [{ name: 'to', type: 'string', required: true, max: 5 }] };
  assert.equal(lib.callProblem(capability, { to: 'abcde' }), null);
  assert.deepEqual(lib.callProblem(capability, { to: 'abcdef' }), { field: 'to', message: 'to must be at most 5 characters' });
  assert.deepEqual(lib.buildCallInputs(capability, { to: 'abcdef' }), { to: 'abcdef' });
  assert.equal(lib.callProblem(capability, { to: `${'a'.repeat(4)}😀` }), null);
  assert.equal(lib.callProblem(capability, { to: '  ' }).message, 'to is required');
  assert.equal(lib.callProblem({ inputs: [{ name: 'n', type: 'number' }] }, { n: 'x' }).message, 'n must be a number');
  assert.equal(lib.callProblem({ inputs: [{ name: 'j', type: 'array' }] }, { j: '[' }).message, 'j must be valid JSON');
});

test('C20 the pre-approved toggle is only for a write that would otherwise wait for approval', () => {
  assert.equal(lib.canPreApprove({ mode: 'write' }), true);
  assert.equal(lib.canPreApprove({ mode: 'write', requiresApproval: true }), true);
  assert.equal(lib.canPreApprove({ mode: 'write', requiresApproval: false }), false);
  assert.equal(lib.canPreApprove({ mode: 'read', requiresApproval: true }), false);
});

test('C21 the link editor offers only what the target type declares', () => {
  assert.deepEqual(lib.grantChoices({ capabilities: CAPABILITIES, events: EVENTS }), { capabilities: CAPABILITIES, events: EVENTS });
  assert.deepEqual(lib.grantChoices({}), { capabilities: [], events: [] });
  assert.deepEqual(lib.grantChoices(undefined), { capabilities: [], events: [] });
});

// ---- 3D scene lines ----

const positions = (entries) => new Map(Object.entries(entries));

test('C22 a line runs from one Building\'s position to the other\'s', () => {
  const [line] = lib.linkLines([link()], positions({ a: [0, 0], b: [10, 5] }));
  assert.deepEqual([line.from, line.to, line.broken], [[0, 0], [10, 5], false]);
});

test('C23 the endpoints follow a Building that moves', () => {
  const before = lib.linkLines([link()], positions({ a: [0, 0], b: [10, 0] }))[0];
  const after = lib.linkLines([link()], positions({ a: [0, 0], b: [10, 6] }))[0];
  assert.deepEqual([before.to, after.to], [[10, 0], [10, 6]]);
  assert.deepEqual(before.from, after.from);
});

test('C24 a pair linked both ways gets two lines that do not coincide, and a single link stays on the straight path', () => {
  const lines = lib.linkLines([link(), link({ id: 'l2', fromBuildingId: 'b', toBuildingId: 'a' })], positions({ a: [0, 0], b: [10, 0] }));
  assert.equal(lines.length, 2);
  assert.notDeepEqual(lines[0].from, lines[1].from);
  assert.notDeepEqual(lines[0].to, lines[1].to);
  assert.ok(lines.every((l) => l.from.every(Number.isFinite) && l.to.every(Number.isFinite)));
  assert.deepEqual(lib.linkLines([link()], positions({ a: [0, 0], b: [10, 0] }))[0].from, [0, 0]);
});

test('C25 a broken link is flagged for the dashed red style', () => {
  const [line] = lib.linkLines([link({ broken: true })], positions({ a: [0, 0], b: [4, 0] }));
  assert.equal(line.broken, true);
  assert.match(src('scene/ConnectionLines.tsx'), /dashed=\{line\.broken\}/);
  assert.match(src('scene/ConnectionLines.tsx'), /BROKEN_COLOR/);
});

test('C26 a removed link draws no line, and neither does a link to a Building that is not in the scene', () => {
  assert.deepEqual(lib.linkLines([], positions({ a: [0, 0], b: [4, 0] })), []);
  assert.deepEqual(lib.linkLines([link()], positions({ a: [0, 0] })), []);
});

test('C27 Buildings in the same place make no line, never NaN', () => {
  assert.deepEqual(lib.linkLines([link(), link({ id: 'l2', fromBuildingId: 'b', toBuildingId: 'a' })], positions({ a: [3, 3], b: [3, 3] })), []);
});

test('C28 the tooltip names both Buildings, what the link grants and whether it is broken', () => {
  assert.equal(lib.linkTooltip(link()), 'A → B: 2 capabilities, 1 event');
  assert.equal(lib.linkTooltip(link({ broken: true, capabilities: grants('x'), events: [] })), 'A → B: 1 capability, 0 events (broken)');
  assert.equal(lib.linkTooltip(link({ toName: null })), 'A → Building deleted: 2 capabilities, 1 event');
});

test('C29 a crowd of links is bounded', () => {
  const many = Array.from({ length: 500 }, (_, i) => link({ id: `l${String(i).padStart(3, '0')}`, fromBuildingId: `f${i}`, toBuildingId: `t${i}` }));
  const at = Object.fromEntries(many.flatMap((l, i) => [[l.fromBuildingId, [0, i]], [l.toBuildingId, [5, i]]]));
  assert.equal(lib.linkLines(many, positions(at)).length, lib.MAX_LINK_LINES);
});

// ---- Schedules knows capability jobs and event starts ----

const schedules = await import('../src/lib/schedules.ts');
const capabilityJob = {
  name: 'Fetch report', enabled: true, trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'capability', targetBuildingId: 'seo-1', capabilityId: 'read-report', inputs: { topic: 'a' } },
  overlap: 'skip', missedPolicy: 'skip', maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: false, failureThreshold: 3,
};

test('a job that calls a capability is labelled with the capability and the Building, or says the Building is gone', () => {
  assert.equal(schedules.targetLabel(capabilityJob.target, [], [], [{ id: 'seo-1', name: 'SEO' }]), 'Calls "read-report" on SEO');
  assert.equal(schedules.targetLabel(capabilityJob.target, [], []), 'Calls "read-report" on a Building that is no longer there');
});

test('a run started by an event reads as an Event and shows the event, without the delivery id', () => {
  assert.equal(schedules.startedByLabel('event'), 'Event');
  assert.equal(schedules.changeText('event:0b1f-77 report-published'), 'Event: report-published.');
  assert.equal(schedules.changeText('prices.json changed'), 'Change: prices.json changed.');
  assert.equal(schedules.changeText(null), null);
});

test('editing a capability job keeps its target: the form says so, validates without one and sends none', () => {
  const form = schedules.jobToForm(capabilityJob);
  assert.equal(form.targetKind, 'capability');
  assert.deepEqual(schedules.validateJobForm(form, []), {});
  assert.equal('target' in schedules.formToRequest(form), false);
  assert.equal(schedules.formToRequest(form).name, 'Fetch report');
  assert.equal('target' in schedules.formToRequest({ ...form, targetKind: 'prompt', prompt: 'x' }), true);
  assert.match(src('ui/schedules/JobEditorDialog.tsx'), /form\.targetKind !== 'capability' &&/);
});

// ---- Source checks ----

test('C30 the Connections and Activity views are Settings sections with their own panels, and the actions carry accessible names', () => {
  const settings = src('ui/project-popup/SettingsPanel.tsx');
  assert.match(settings, /current === 'connections' && <ConnectionsPanel/);
  assert.match(settings, /current === 'activity' && <ActivityPanel/);
  assert.doesNotMatch(src('ui/ProjectWorkspaceModal.tsx'), /ConnectionsPanel|ActivityPanel/);
  const panel = src('ui/connections/ConnectionsPanel.tsx');
  for (const label of ['aria-label="Connections"', 'aria-label="Links"', 'aria-label={`Edit link to ${row.otherName}`}', 'aria-label={`Remove link with ${row.otherName}`}', 'Pre-approved for scheduled jobs']) assert.ok(panel.includes(label), label);
  assert.match(src('lib/settingsSections.ts'), /'connections'/);
});

test('C31 the Activity log has caller, capability, result and time filters, and blocks a backwards range', () => {
  const panel = src('ui/connections/ActivityPanel.tsx');
  for (const text of ['Building', 'Capability or event', 'Result', 'From', 'To']) assert.ok(panel.includes(`>${text}`) || panel.includes(`${text}\n`), text);
  assert.match(panel, /aria-label="Activity filters"/);
  assert.match(panel, /disabled=\{Boolean\(rangeProblem\)\}/);
  assert.match(panel, /entry\.result === 'awaiting-approval'/);
});

test('C32 the views use the shared components and no hand-rolled dialogs', () => {
  for (const file of ['ui/connections/ConnectionsPanel.tsx', 'ui/connections/ActivityPanel.tsx']) {
    const text = src(file);
    assert.match(text, /@\/components\/ui\/button/);
    assert.equal(/<dialog|window\.confirm|window\.alert/.test(text), false);
  }
  assert.match(src('ui/connections/ConnectionsPanel.tsx'), /@\/components\/ui\/dialog/);
});

test('the scene imports link geometry from lib, so three.js stays out of the pure code', () => {
  assert.equal(/from 'three'/.test(src('lib/connections.ts')), false);
  assert.match(src('scene/ConnectionLines.tsx'), /linkLines\(links/);
  assert.match(src('scene/Scene.tsx'), /<ConnectionLines \/>/);
});

test('C28 a new link starts with every capability of the target granted and none pre-approved', () => {
  assert.deepEqual(lib.defaultGrants(CAPABILITIES), CAPABILITIES.map((c) => ({ capabilityId: c.id, preApproved: false })));
  assert.deepEqual(lib.defaultGrants([]), []);
});

test('C29 unchecking removes only that grant, and checking it again adds it back not pre-approved', () => {
  const grants = [{ capabilityId: 'read-report', preApproved: false }, { capabilityId: 'send-report', preApproved: true }];
  const off = lib.toggleGrant(grants, 'read-report');
  assert.deepEqual(off, [{ capabilityId: 'send-report', preApproved: true }]);
  assert.deepEqual(lib.toggleGrant(off, 'read-report'), [{ capabilityId: 'send-report', preApproved: true }, { capabilityId: 'read-report', preApproved: false }]);
  assert.deepEqual(lib.togglePreApproved(grants, 'send-report'), [grants[0], { capabilityId: 'send-report', preApproved: false }]);
});

test('C30 the link editor derives its grants from the stored link or the target, not from state set once on open', () => {
  const dialog = src('ui/connections/ConnectionsPanel.tsx');
  assert.ok(dialog.includes('defaultGrants(choices.capabilities)'));
  assert.ok(dialog.includes('chosenGrants ?? existing?.capabilities'));
  assert.ok(dialog.includes('setChosenGrants(null)'), 'changing the target goes back to every capability of the new target');
  assert.ok(dialog.includes("All capabilities are on; uncheck any you don't want to share."));
  assert.equal(dialog.includes('existing?.capabilities ?? []'), false);
});

test('C31 the new software capabilities are described in plain words by the declaration the screen renders', () => {
  const software = readFileSync(new URL('../../server/src/buildings/types/software.ts', import.meta.url), 'utf8');
  assert.ok(software.includes("Read one task\\'s description, status and step-by-step summary."));
  assert.ok(software.includes("description: 'List finished tasks.'"));
});
