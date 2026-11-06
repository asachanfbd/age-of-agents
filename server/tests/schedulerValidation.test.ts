import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateJob, validateJobPatch } from '../src/scheduler/jobValidation.ts';
import type { JobSettings } from '../src/scheduler/types.ts';

const context = { slotIds: ['review', 'publish'], agentIds: ['manager', 'builder'] };
const cronJob = (patch: Record<string, unknown> = {}) => ({
  name: 'Weekly review', trigger: { kind: 'cron', cron: '0 9 * * 1' }, target: { kind: 'slot', slotId: 'review', description: 'Review the notes.' }, ...patch,
});
const fileTrigger = (patch: Record<string, unknown> = {}) => ({ kind: 'file', path: 'inbox', detect: 'mtime', intervalSeconds: 300, ...patch });
const apiTrigger = (patch: Record<string, unknown> = {}) => ({ kind: 'api', url: 'https://example.com/pricing.json', intervalSeconds: 900, ...patch });

function accepted(input: unknown): JobSettings {
  const result = validateJob(input, context);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { value: JobSettings }).value;
}

function refused(input: unknown, field: string, message?: RegExp): void {
  const result = validateJob(input, context);
  assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input)?.slice(0, 200)}`);
  if (result.ok) return;
  assert.equal(result.field, field);
  assert.ok(result.error.length > 0);
  if (message) assert.match(result.error, message);
}

test('UV01 a valid cron job on a slot gets the defaults', () => {
  assert.deepEqual(accepted(cronJob()), {
    name: 'Weekly review', enabled: true, trigger: { kind: 'cron', cron: '0 9 * * 1' },
    target: { kind: 'slot', slotId: 'review', description: 'Review the notes.' },
    overlap: 'skip', missedPolicy: 'skip', maxRunsPerDay: null, maxFiveHourPercent: null, maxWeeklyPercent: null, needsApproval: false, failureThreshold: 3,
  });
  assert.equal(accepted(cronJob({ trigger: { kind: 'cron', cron: ' @DAILY ' } })).trigger.kind === 'cron' && (accepted(cronJob({ trigger: { kind: 'cron', cron: ' @DAILY ' } })).trigger as { cron: string }).cron, '@daily');
});

test('UV02 a valid folder or file job with either change check', () => {
  for (const detect of ['mtime', 'hash']) {
    assert.deepEqual(accepted(cronJob({ trigger: fileTrigger({ detect }) })).trigger, { kind: 'file', path: 'inbox', detect, intervalSeconds: 300 });
  }
});

test('UV03 a valid API job; an empty JSON field is stored as absent', () => {
  for (const jsonField of [undefined, null, '', '   ']) {
    assert.deepEqual(accepted(cronJob({ trigger: apiTrigger({ jsonField }) })).trigger, { kind: 'api', url: 'https://example.com/pricing.json', jsonField: null, intervalSeconds: 900 });
  }
  assert.equal((accepted(cronJob({ trigger: apiTrigger({ jsonField: ' plans[0].price ' }) })).trigger as { jsonField: string }).jsonField, 'plans[0].price');
});

test('UV04 a valid single-agent-prompt job, with a named agent or the default one', () => {
  assert.deepEqual(accepted(cronJob({ target: { kind: 'prompt', agentId: 'builder', prompt: ' Summarise the week. ' } })).target, { kind: 'prompt', agentId: 'builder', prompt: 'Summarise the week.' });
  assert.deepEqual(accepted(cronJob({ target: { kind: 'prompt', prompt: 'Go' } })).target, { kind: 'prompt', agentId: null, prompt: 'Go' });
  refused(cronJob({ target: { kind: 'prompt', agentId: 'ghost', prompt: 'Go' } }), 'target.agentId', /ghost/);
  refused(cronJob({ target: { kind: 'prompt', agentId: 5, prompt: 'Go' } }), 'target.agentId');
});

test('UV05 the name is required, trimmed, and at most 120 characters', () => {
  for (const name of [undefined, '', '   ', 'x'.repeat(121), 5]) refused(cronJob({ name }), 'name');
  assert.equal(accepted(cronJob({ name: 'x'.repeat(120) })).name.length, 120);
  assert.equal(accepted(cronJob({ name: `  ${'x'.repeat(120)}  ` })).name.length, 120, 'trimmed before the length check');
});

test('UV06 a missing or unknown trigger kind is refused', () => {
  refused(cronJob({ trigger: undefined }), 'trigger');
  refused(cronJob({ trigger: 'cron' }), 'trigger');
  refused(cronJob({ trigger: {} }), 'trigger.kind');
  refused(cronJob({ trigger: { kind: 'webhook' } }), 'trigger.kind');
});

test('UV07 an invalid cron expression is refused with a message that says cron', () => {
  refused(cronJob({ trigger: { kind: 'cron', cron: '61 * * * *' } }), 'trigger.cron', /cron/i);
  refused(cronJob({ trigger: { kind: 'cron' } }), 'trigger.cron', /cron/i);
});

test('UV08 the interval is a whole number of seconds from 1 minute to 30 days', () => {
  refused(cronJob({ trigger: fileTrigger({ intervalSeconds: 59 }) }), 'trigger.intervalSeconds', /at least 1 minute/);
  for (const intervalSeconds of [60, 2_592_000]) assert.equal((accepted(cronJob({ trigger: fileTrigger({ intervalSeconds }) })).trigger as { intervalSeconds: number }).intervalSeconds, intervalSeconds);
  refused(cronJob({ trigger: apiTrigger({ intervalSeconds: 2_592_001 }) }), 'trigger.intervalSeconds', /30 days/);
  for (const intervalSeconds of [0, -60, 1.5, Number.NaN, '60', 2 ** 60, undefined]) refused(cronJob({ trigger: apiTrigger({ intervalSeconds }) }), 'trigger.intervalSeconds');
});

test('UV09 a path is 1 to 1,024 characters and may point anywhere', () => {
  for (const path of ['', '  ', 'x'.repeat(1025), undefined]) refused(cronJob({ trigger: fileTrigger({ path }) }), 'trigger.path');
  for (const path of ['x'.repeat(1024), '/var/log/app', 'inbox/new', '../shared/notes.md']) assert.equal((accepted(cronJob({ trigger: fileTrigger({ path }) })).trigger as { path: string }).path, path);
});

test('UV10 an address must be http or https, up to 2,048 characters', () => {
  const long = (length: number) => `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`;
  for (const url of ['ftp://example.com/x', 'file:///etc/hosts', 'javascript:alert(1)', 'example.com/x', 'http://', long(2049), '', undefined]) {
    refused(cronJob({ trigger: apiTrigger({ url }) }), 'trigger.url');
  }
  for (const url of ['http://localhost:3000/x', 'https://10.0.0.1', 'HTTP://Example.com', long(2048)]) {
    assert.equal((accepted(cronJob({ trigger: apiTrigger({ url }) })).trigger as { url: string }).url, url);
  }
});

test('UV11 a JSON field is a dotted path with [n] indexes, up to 256 characters', () => {
  refused(cronJob({ trigger: apiTrigger({ jsonField: 'a'.repeat(257) }) }), 'trigger.jsonField');
  for (const jsonField of ['a..b', 'a[x]', '[0]', 'a.', 'a b', 5]) refused(cronJob({ trigger: apiTrigger({ jsonField }) }), 'trigger.jsonField');
  for (const jsonField of ['plans[0].price', 'a.b', 'items[10]', 'grid[1][2].x', 'a'.repeat(256)]) {
    assert.equal((accepted(cronJob({ trigger: apiTrigger({ jsonField }) })).trigger as { jsonField: string }).jsonField, jsonField);
  }
});

test('UV12 a change check other than mtime or hash is refused', () => {
  for (const detect of ['size', 'MTIME', undefined, 5]) refused(cronJob({ trigger: fileTrigger({ detect }) }), 'trigger.detect');
});

test('UV13 a slot target needs a slot the type has and a task description up to 10,000 characters', () => {
  refused(cronJob({ target: { kind: 'slot', slotId: 'ghost', description: 'x' } }), 'target.slotId', /"ghost"/);
  refused(cronJob({ target: { kind: 'slot', description: 'x' } }), 'target.slotId');
  for (const description of [undefined, '', 'x'.repeat(10_001)]) refused(cronJob({ target: { kind: 'slot', slotId: 'review', description } }), 'target.description');
  assert.equal((accepted(cronJob({ target: { kind: 'slot', slotId: 'review', description: 'x'.repeat(10_000) } })).target as { description: string }).description.length, 10_000);
});

test('UV14 a prompt is 1 to 10,000 characters', () => {
  for (const prompt of [undefined, '', '  ', 'x'.repeat(10_001)]) refused(cronJob({ target: { kind: 'prompt', prompt } }), 'target.prompt');
  assert.equal((accepted(cronJob({ target: { kind: 'prompt', prompt: 'x'.repeat(10_000) } })).target as { prompt: string }).prompt.length, 10_000);
});

test('UV15 a target with both a slot and a prompt, or neither, is refused', () => {
  refused(cronJob({ target: { kind: 'slot', slotId: 'review', description: 'x', prompt: 'y' } }), 'target');
  refused(cronJob({ target: { kind: 'prompt', slotId: 'review', prompt: 'y' } }), 'target');
  refused(cronJob({ target: {} }), 'target.kind');
  refused(cronJob({ target: undefined }), 'target');
  refused(cronJob({ target: { kind: 'both' } }), 'target.kind');
});

test('UV16 the overlap rule is skip, queue or parallel, case-sensitive', () => {
  for (const overlap of ['skip', 'queue', 'parallel']) assert.equal(accepted(cronJob({ overlap })).overlap, overlap);
  for (const overlap of ['Skip', 'wait', 5, null]) refused(cronJob({ overlap }), 'overlap');
});

test('UV17 the missed-run policy is skip or once, and is dropped on a poll job', () => {
  assert.equal(accepted(cronJob({ missedPolicy: 'once' })).missedPolicy, 'once');
  for (const missedPolicy of ['always', 'Once', 5]) refused(cronJob({ missedPolicy }), 'missedPolicy');
  assert.equal(accepted(cronJob({ trigger: fileTrigger(), missedPolicy: 'once' })).missedPolicy, null);
  assert.equal(accepted(cronJob({ trigger: apiTrigger(), missedPolicy: 'nonsense' })).missedPolicy, null);
});

test('UV18 runs per day: absent or null is no limit; 1 to 1,000 whole', () => {
  for (const maxRunsPerDay of [undefined, null]) assert.equal(accepted(cronJob({ maxRunsPerDay })).maxRunsPerDay, null);
  for (const maxRunsPerDay of [1, 1000]) assert.equal(accepted(cronJob({ maxRunsPerDay })).maxRunsPerDay, maxRunsPerDay);
  for (const maxRunsPerDay of [0, 1001, -1, 2.5, '5']) refused(cronJob({ maxRunsPerDay }), 'maxRunsPerDay');
});

test('UV19 failures before turn-off: absent gives 3; 1 to 100 whole', () => {
  assert.equal(accepted(cronJob()).failureThreshold, 3);
  for (const failureThreshold of [1, 100]) assert.equal(accepted(cronJob({ failureThreshold })).failureThreshold, failureThreshold);
  for (const failureThreshold of [0, 101, 1.5, '3']) refused(cronJob({ failureThreshold }), 'failureThreshold');
});

test('UV20 each usage percentage: null is no limit; 1 to 100 whole', () => {
  for (const field of ['maxFiveHourPercent', 'maxWeeklyPercent'] as const) {
    assert.equal(accepted(cronJob({ [field]: null }))[field], null);
    for (const value of [1, 100]) assert.equal(accepted(cronJob({ [field]: value }))[field], value);
    for (const value of [0, 101, 50.5, '80']) refused(cronJob({ [field]: value }), field);
  }
});

test('UV21 "needs approval" and "enabled" must be true or false', () => {
  for (const field of ['needsApproval', 'enabled']) for (const value of ['yes', 1, null]) refused(cronJob({ [field]: value }), field);
  assert.equal(accepted(cronJob({ enabled: false, needsApproval: true })).enabled, false);
});

test('UV22 fields a caller may not set, and unknown ones, are not stored', () => {
  const value = accepted(cronJob({ id: 'mine', nextRunAt: '2020-01-01T00:00:00Z', consecutiveFailures: 9, projectId: 'other', autoDisabled: true, colour: 'red' }));
  assert.deepEqual(Object.keys(value).sort(), ['enabled', 'failureThreshold', 'maxFiveHourPercent', 'maxRunsPerDay', 'maxWeeklyPercent', 'missedPolicy', 'name', 'needsApproval', 'overlap', 'target', 'trigger']);
});

test('UV23 a partial edit is validated as the merged job', () => {
  const current = accepted(cronJob());
  const renamed = validateJobPatch(current, { name: ' Renamed ' }, context);
  assert.deepEqual(renamed.ok && renamed.value, { ...current, name: 'Renamed' });
  const toFolder = validateJobPatch(current, { trigger: { kind: 'file' } }, context);
  assert.deepEqual([toFolder.ok, !toFolder.ok && toFolder.field], [false, 'trigger.path'], 'cron to folder without a path and interval is refused');
  const toFolderWhole = validateJobPatch(current, { trigger: fileTrigger() }, context);
  assert.equal(toFolderWhole.ok && toFolderWhole.value.missedPolicy, null);
  const backToCron = validateJobPatch((toFolderWhole as { value: JobSettings }).value, { trigger: { kind: 'cron', cron: '@daily' } }, context);
  assert.equal(backToCron.ok && backToCron.value.missedPolicy, 'skip', 'a poll job moved to cron takes the default missed-run policy');
  // A job whose slot or agent is gone can still be renamed or switched off; only an edit of the target checks them again.
  const gone = { slotIds: ['publish'], agentIds: [] };
  const lostSlot = validateJobPatch(current, { name: 'x', enabled: false }, gone);
  assert.deepEqual(lostSlot.ok && [lostSlot.value.name, lostSlot.value.enabled, lostSlot.value.target], ['x', false, current.target]);
  const sameTarget = validateJobPatch(current, { target: current.target }, gone);
  assert.deepEqual([sameTarget.ok, !sameTarget.ok && sameTarget.field], [false, 'target.slotId'], 'an edit that sends the target is checked against the type as it is now');
  const promptJob = accepted(cronJob({ target: { kind: 'prompt', agentId: 'builder', prompt: 'Go' } }));
  const lostAgent = validateJobPatch(promptJob, { enabled: false }, gone);
  assert.equal(lostAgent.ok && lostAgent.value.enabled, false);
  const editedPrompt = validateJobPatch(promptJob, { target: { kind: 'prompt', agentId: 'builder', prompt: 'New' } }, gone);
  assert.deepEqual([editedPrompt.ok, !editedPrompt.ok && editedPrompt.field], [false, 'target.agentId']);
  for (const body of [null, [], 'text']) assert.equal(validateJobPatch(current, body, context).ok, false);
});

test('UV24 a body that is an array, null or text is refused', () => {
  for (const body of [[], null, 'text', 5, undefined]) refused(body, 'body');
});

const withCommands = { ...context, commandIds: ['c1', 'c2'] };
const commandJob = (patch: Record<string, unknown> = {}) => cronJob({ target: { kind: 'command', commandId: 'c1' }, ...patch });

test('UV25 a command target needs a saved command of the Building; any other commandId is refused on target.commandId', () => {
  const ok = validateJob(commandJob(), withCommands);
  assert.deepEqual(ok.ok && ok.value.target, { kind: 'command', commandId: 'c1' });
  for (const commandId of [undefined, '', '  ', 5, null, {}, 'ghost']) {
    const result = validateJob(commandJob({ target: { kind: 'command', commandId } }), withCommands);
    assert.deepEqual([result.ok, !result.ok && result.field], [false, 'target.commandId']);
  }
  const noCommands = validateJob(commandJob(), context);
  assert.deepEqual([noCommands.ok, !noCommands.ok && noCommands.field], [false, 'target.commandId']);
  const unknownKind = validateJob(cronJob({ target: { kind: 'both' } }), withCommands);
  assert.match(!unknownKind.ok ? unknownKind.error : '', /command/);
});

test('UV26 a command job cannot need approval; false or omitted is fine and usage limits are stored', () => {
  const refusal = validateJob(commandJob({ needsApproval: true }), withCommands);
  assert.deepEqual([refusal.ok, !refusal.ok && refusal.field, !refusal.ok && /cannot wait for approval/.test(refusal.error)], [false, 'needsApproval', true]);
  for (const needsApproval of [false, undefined]) assert.equal(validateJob(commandJob({ needsApproval }), withCommands).ok, true);
  const limited = validateJob(commandJob({ maxFiveHourPercent: 50, maxWeeklyPercent: 60 }), withCommands);
  assert.deepEqual(limited.ok && [limited.value.maxFiveHourPercent, limited.value.maxWeeklyPercent], [50, 60]);
});

test('UV27 an edit that leaves the command target alone is not checked against the commands again; one that sends it is', () => {
  const current = (validateJob(commandJob(), withCommands) as { value: JobSettings }).value;
  const renamed = validateJobPatch(current, { name: 'Renamed', enabled: false }, context);
  assert.deepEqual(renamed.ok && [renamed.value.name, renamed.value.target], ['Renamed', current.target]);
  const resent = validateJobPatch(current, { target: current.target }, context);
  assert.deepEqual([resent.ok, !resent.ok && resent.field], [false, 'target.commandId']);
  const switched = validateJobPatch(current, { target: { kind: 'command', commandId: 'c2' } }, withCommands);
  assert.equal(switched.ok && (switched.value.target as { commandId: string }).commandId, 'c2');
  const approval = validateJobPatch(current, { needsApproval: true }, context);
  assert.deepEqual([approval.ok, !approval.ok && approval.field], [false, 'needsApproval']);
});
