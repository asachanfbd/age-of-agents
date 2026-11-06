import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import type { CrmCtx, WorkTask } from '../src/crm/context.ts';
import { createContact, markCustomer } from '../src/crm/contacts.ts';
import { attachBuilding, detachBuilding, listCustomers } from '../src/crm/customers.ts';
import { openCrmDb } from '../src/crm/db.ts';
import { UNTITLED_TASK, WORK_BACKFILL_DAYS, WORK_LOG_MAX, WORK_SUMMARY_MAX, WORK_TITLE_MAX } from '../src/crm/limits.ts';
import { redactSecrets, rememberSecret } from '../src/redaction.ts';
import { addEntry, addWorkEntry, listTimeline, TIMELINE_KINDS, editComment } from '../src/crm/timeline.ts';
import { backfillBuilding, capText, fallbackSummary, inBackfillWindow, postFinished, postStarted, settleWorkUpdates, summaryPrompt, taskLabel, workKey, workText, writeSummary } from '../src/crm/workUpdates.ts';
import { createCrmAgent } from '../src/crm/crmAgent.ts';
import { harness } from './helpers/crmFakes.ts';
import type { Harness } from './helpers/crmFakes.ts';

const DAY = 86_400_000;
const target = { buildingId: 'b-sw', buildingName: 'App' };
const task = (over: Partial<WorkTask> = {}): WorkTask => ({ planItemId: 'p1', title: 'Fix login', runSummary: 'Fixed the login page', startedAt: 0, finishedAt: null, ...over });

let n = 0;
function customer(h: Harness): number {
  const c = createContact(h.ctx, { name: `C${++n}`, channels: [{ type: 'email', handle: `c${n}@x.com` }] });
  markCustomer(h.ctx, c.id);
  return c.id;
}
async function attached(h: Harness, contactId = customer(h), buildingId = 'b-sw') {
  await attachBuilding(h.ctx, contactId, buildingId);
  await settleWorkUpdates();
  return contactId;
}
const work = (ctx: CrmCtx, contactId: number) => ctx.db.prepare("SELECT * FROM timeline WHERE contactId = ? AND kind = 'building_work' ORDER BY at, id").all(contactId) as Array<{ at: number; text: string; data: string }>;
const data = (row: { data: string }) => JSON.parse(row.data) as Record<string, unknown>;

test('U01 a blank, whitespace-only or missing title becomes the generic label', () => {
  for (const t of ['', '   ', null, undefined]) assert.equal(taskLabel(t), UNTITLED_TASK);
  assert.equal(taskLabel('  Fix  '), 'Fix');
});

test('U02 a title over the cap is cut to the cap', () => {
  assert.equal([...taskLabel('x'.repeat(WORK_TITLE_MAX + 50))].length, WORK_TITLE_MAX);
});

test('U03 an empty or whitespace-only AI summary falls back to the title', async () => {
  const h = harness();
  for (const reply of ['', '  \n ']) {
    h.agent.reply = reply;
    assert.deepEqual(await writeSummary(h.ctx, 'Fix login', null), { summary: 'Fix login', rewritten: false });
  }
});

test('U04 the summary cap keeps exactly the cap, cuts one more, and counts an emoji pair as one character', () => {
  assert.equal(capText('a'.repeat(WORK_SUMMARY_MAX), WORK_SUMMARY_MAX).length, WORK_SUMMARY_MAX);
  assert.equal(capText('a'.repeat(WORK_SUMMARY_MAX + 1), WORK_SUMMARY_MAX).length, WORK_SUMMARY_MAX);
  assert.equal(capText('ab😀cd', 3), 'ab😀');
});

test('U05 started and finished texts carry the Building name and task title', () => {
  assert.equal(workText('started', 'Fix login', 'App'), 'Started: Fix login on App');
  assert.equal(workText('finished', 'Fix login', 'App'), 'Finished: Fix login on App');
});

test('U06 the work key differs by contact, Building, plan item and phase, and repeats for the same inputs', () => {
  const base = workKey(1, 'b', 'p', 'started');
  assert.equal(base, workKey(1, 'b', 'p', 'started'));
  for (const other of [workKey(2, 'b', 'p', 'started'), workKey(1, 'c', 'p', 'started'), workKey(1, 'b', 'q', 'started'), workKey(1, 'b', 'p', 'finished')]) assert.notEqual(base, other);
});

test('U07 the prompt holds only the title and run summary', () => {
  const prompt = summaryPrompt('Fix login', 'Done');
  assert.match(prompt, /Task: Fix login/);
  assert.match(prompt, /Outcome: Done/);
  assert.match(summaryPrompt('T', null), /Outcome: not recorded/);
});

test('U08 a stored secret inside the run summary is redacted in the prompt and the fallback', () => {
  rememberSecret('sk-live-123456789');
  assert.equal(redactSecrets('x sk-live-123456789 y'), 'x [secret] y');
  assert.ok(!summaryPrompt('T', 'used sk-live-123456789').includes('sk-live-123456789'));
  assert.ok(!fallbackSummary('T', 'used sk-live-123456789').includes('sk-live-123456789'));
});

test('U09 the 30-day cutoff includes exactly 30 days ago and now, and excludes one millisecond earlier', () => {
  const now = 100 * DAY;
  assert.equal(inBackfillWindow(now - WORK_BACKFILL_DAYS * DAY, now), true);
  assert.equal(inBackfillWindow(now - WORK_BACKFILL_DAYS * DAY - 1, now), false);
  assert.equal(inBackfillWindow(now, now), true);
});

test('U11 invalid finish times are skipped in backfill and a future one is dated now', async () => {
  const h = harness();
  for (const bad of [null, Number.NaN, -5, 0]) assert.equal(inBackfillWindow(bad, h.clock.now), false);
  const c = await attached(h);
  await postFinished(h.ctx, target, task({ planItemId: 'future', finishedAt: h.clock.now + 5 * DAY }));
  assert.equal(work(h.ctx, c).find((r) => data(r).planItemId === 'future')!.at, h.clock.now);
});

test('U12 an agent that does not answer within the timeout gives the fallback', async () => {
  const h = harness();
  h.ctx.deps.agent.run = () => new Promise<string>(() => undefined);
  assert.deepEqual(await writeSummary(h.ctx, 'Fix login', 'Done', 5), { summary: 'Fix login: Done', rewritten: false });
});

test('U13 the agent answer is trimmed', async () => {
  const h = harness();
  h.agent.reply = '  All fixed.\n';
  assert.deepEqual(await writeSummary(h.ctx, 'T', null), { summary: 'All fixed.', rewritten: true });
});

test('U14 the Building work kind is a timeline kind', () => assert.ok(TIMELINE_KINDS.includes('building_work')));

test('U15 the migration adds the key column and unique index to an old database, leaves old rows, and is a no-op twice', () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/crm-mig-${process.pid}-${Date.now()}.sqlite`;
  const old = new Database(dir);
  old.exec("CREATE TABLE timeline (id INTEGER PRIMARY KEY, contactId INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, editedAt INTEGER)");
  old.prepare("INSERT INTO timeline (contactId, kind, at, text) VALUES (1, 'added', 5, 'old')").run();
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = openCrmDb(dir);
    assert.deepEqual(db.prepare('SELECT text, workKey FROM timeline').all(), [{ text: 'old', workKey: null }]);
    db.prepare("INSERT INTO timeline (contactId, kind, at) VALUES (1, 'added', 6)").run();
    db.prepare("INSERT INTO timeline (contactId, kind, at) VALUES (1, 'added', 7)").run();
    db.prepare('DELETE FROM timeline WHERE id > 1').run();
    db.close();
  }
});

test('U16 a second insert with the same key is ignored; a different phase is accepted', () => {
  const h = harness();
  assert.equal(addWorkEntry(h.ctx, 1, 'k1', 't', {}, 1), true);
  assert.equal(addWorkEntry(h.ctx, 1, 'k1', 't', {}, 2), false);
  assert.equal(addWorkEntry(h.ctx, 1, 'k2', 't', {}, 3), true);
});

test('I01 starting a task posts "started" with the Building name, title and time', async () => {
  const h = harness();
  const c = await attached(h);
  h.advance(DAY);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  const [row] = work(h.ctx, c);
  assert.deepEqual([row!.text, row!.at, data(row!).phase, data(row!).buildingName, data(row!).taskTitle], ['Started: Fix login on App', h.clock.now, 'started', 'App', 'Fix login']);
  assert.equal(h.agent.requests.length, 0);
});

test('I02 two customers with the same Building each get their own entry', async () => {
  const h = harness();
  const a = await attached(h), b = await attached(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.deepEqual([work(h.ctx, a).length, work(h.ctx, b).length], [2, 2]);
  assert.equal(h.agent.requests.length, 1);
});

test('I03 finishing posts one "finished" entry with the AI summary, marked rewritten', async () => {
  const h = harness();
  const c = await attached(h);
  h.agent.reply = 'We fixed the login page.';
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  const [row] = work(h.ctx, c);
  assert.deepEqual([data(row!).summary, data(row!).rewritten, data(row!).backfilled], ['We fixed the login page.', true, false]);
  assert.equal(h.agent.requests[0]!.kind, 'work');
});

for (const [id, how] of [['I04', 'throws'], ['I05', 'times out'], ['I06', 'is unavailable']] as const) {
  test(`${id} an agent that ${how} still posts at once with the title and run summary, not rewritten, with no retry`, async () => {
    const h = harness();
    const c = await attached(h);
    if (how === 'times out') h.ctx.deps.agent.run = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 1));
    else h.agent.reply = new Error(how === 'throws' ? 'boom' : 'No agent is available');
    await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
    const [row] = work(h.ctx, c);
    assert.deepEqual([data(row!).summary, data(row!).rewritten], ['Fix login: Fixed the login page', false]);
    assert.ok(how === 'times out' || h.agent.requests.length === 1);
  });
}

test('I08 a run with no final summary falls back to the title only', async () => {
  const h = harness();
  const c = await attached(h);
  h.agent.reply = new Error('x');
  await postFinished(h.ctx, target, task({ runSummary: null, finishedAt: h.clock.now }));
  assert.equal(data(work(h.ctx, c)[0]!).summary, 'Fix login');
});

test('I09 a very long AI answer and a very long run summary are both capped', async () => {
  const h = harness();
  const c = await attached(h);
  h.agent.reply = 'y'.repeat(WORK_SUMMARY_MAX * 3);
  await postFinished(h.ctx, target, task({ planItemId: 'a', finishedAt: h.clock.now }));
  h.agent.reply = new Error('x');
  await postFinished(h.ctx, target, task({ planItemId: 'b', runSummary: 'z'.repeat(WORK_SUMMARY_MAX * 3), finishedAt: h.clock.now }));
  for (const row of work(h.ctx, c)) assert.ok([...(data(row).summary as string)].length <= WORK_SUMMARY_MAX);
});

test('I13 a task finished after an earlier failed attempt posts one "finished" and no second "started"', async () => {
  const h = harness();
  const c = await attached(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  // the failed run posts nothing; the retry is not a first run, so the caller passes no start time
  postStarted(h.ctx, target, task({ startedAt: null }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.deepEqual(work(h.ctx, c).map((r) => data(r).phase), ['started', 'finished']);
});

test('I15 repeated started and finished events are ignored', async () => {
  const h = harness();
  const c = await attached(h);
  for (let i = 0; i < 3; i++) { postStarted(h.ctx, target, task({ startedAt: h.clock.now })); await postFinished(h.ctx, target, task({ finishedAt: h.clock.now })); }
  assert.equal(work(h.ctx, c).length, 2);
  assert.equal(h.agent.requests.length, 1);
});

test('I16 repeats after a daemon restart (database reopened) are still ignored', async () => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/crm-restart-${process.pid}-${Date.now()}.sqlite`;
  const h = harness();
  h.ctx.db = openCrmDb(dir);
  const c = await attached(h);
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  h.ctx.db.close();
  h.ctx.db = openCrmDb(dir);
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.equal(work(h.ctx, c).length, 1);
});

test('I27 two identical finish events while the first awaits the agent give one row', async () => {
  const h = harness();
  const c = await attached(h);
  const releases: Array<(v: string) => void> = [];
  h.ctx.deps.agent.run = () => new Promise<string>((r) => { releases.push(r); });
  const first = postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  const second = postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  releases.forEach((r) => r('Done well'));
  await Promise.all([first, second]);
  assert.equal(work(h.ctx, c).length, 1);
});

test('I17 a task started before attach and finished after posts "finished" only', async () => {
  const h = harness();
  const startedAt = h.clock.now;
  h.advance(DAY);
  const c = await attached(h);
  postStarted(h.ctx, target, task({ startedAt }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.deepEqual(work(h.ctx, c).map((r) => data(r).phase), ['finished']);
});

test('I18 an unattached Building posts nothing', async () => {
  const h = harness();
  const c = customer(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.equal(work(h.ctx, c).length, 0);
});

test('I19 after detach nothing new posts and earlier entries stay; I20 re-attach only posts events while attached', async () => {
  const h = harness();
  const c = await attached(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  await detachBuilding(h.ctx, c, 'b-sw');
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.deepEqual(work(h.ctx, c).map((r) => data(r).phase), ['started']);
  h.advance(1000);
  await attachBuilding(h.ctx, c, 'b-sw');
  await settleWorkUpdates();
  postStarted(h.ctx, target, task({ planItemId: 'old', startedAt: h.clock.now - 500 }));
  assert.equal(work(h.ctx, c).length, 1);
});

test('I22 a contact moved to Lost posts nothing; a do-not-contact customer still gets entries', async () => {
  const h = harness();
  const lost = await attached(h), dnc = await attached(h);
  h.ctx.db.prepare("UPDATE contacts SET segment = 'lost_customer' WHERE id = ?").run(lost);
  h.ctx.db.prepare('UPDATE contacts SET dnc = 1 WHERE id = ?').run(dnc);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  assert.deepEqual([work(h.ctx, lost).length, work(h.ctx, dnc).length], [0, 1]);
});

test('I25 many tasks finishing at once each post, and one failure does not stop the others', async () => {
  const h = harness();
  const c = await attached(h);
  let calls = 0;
  h.ctx.deps.agent.run = async () => { if (++calls === 2) throw new Error('one fails'); return 'ok'; };
  await Promise.all([1, 2, 3, 4].map((i) => postFinished(h.ctx, target, task({ planItemId: `p${i}`, finishedAt: h.clock.now }))));
  assert.equal(work(h.ctx, c).length, 4);
  assert.equal(work(h.ctx, c).filter((r) => data(r).rewritten === false).length, 1);
});

test('I26 one customer\'s failing insert does not stop the other customer', async () => {
  const h = harness();
  const a = await attached(h), b = await attached(h);
  h.ctx.db.exec(`CREATE TRIGGER fail_a BEFORE INSERT ON timeline WHEN NEW.contactId = ${a} AND NEW.kind = 'building_work' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const errors = console.error;
  console.error = () => undefined;
  try { postStarted(h.ctx, target, task({ startedAt: h.clock.now })); } finally { console.error = errors; }
  assert.deepEqual([work(h.ctx, a).length, work(h.ctx, b).length], [0, 1]);
});

test('I28 attaching backfills finished entries for tasks completed in 30 days, dated by completion, flagged backfilled, ordered among other entries', async () => {
  const h = harness();
  h.tasks.byBuilding.set('b-sw', [
    task({ planItemId: 'new', title: 'Newer', finishedAt: h.clock.now - 2 * DAY }),
    task({ planItemId: 'old', title: 'Older', finishedAt: h.clock.now - 10 * DAY }),
    task({ planItemId: 'ancient', finishedAt: h.clock.now - 31 * DAY }),
  ]);
  h.advance(DAY);
  const c = await attached(h);
  const rows = work(h.ctx, c);
  assert.deepEqual(rows.map((r) => data(r).taskTitle), ['Older', 'Newer']);
  assert.deepEqual(rows.map((r) => r.at), [h.clock.now - 11 * DAY, h.clock.now - 3 * DAY]);
  assert.ok(rows.every((r) => data(r).backfilled === true && data(r).phase === 'finished'));
  const timeline = listTimeline(h.ctx, c, 50, 0).rows;
  assert.ok(timeline.findIndex((e) => e.kind === 'building_attached') < timeline.findIndex((e) => e.kind === 'building_work'));
});

test('I30 re-attach does not duplicate, and tasks completed while detached are added', async () => {
  const h = harness();
  h.tasks.byBuilding.set('b-sw', [task({ planItemId: 'one', finishedAt: h.clock.now - DAY })]);
  const c = await attached(h);
  await detachBuilding(h.ctx, c, 'b-sw');
  h.tasks.byBuilding.get('b-sw')!.push(task({ planItemId: 'two', finishedAt: h.clock.now - 1000 }));
  await attached(h, c);
  assert.deepEqual(work(h.ctx, c).map((r) => data(r).planItemId).sort(), ['one', 'two']);
});

test('I31 no completed tasks posts nothing and attach succeeds; I32 a failing task source still attaches', async () => {
  const h = harness();
  const c = await attached(h);
  assert.equal(work(h.ctx, c).length, 0);
  h.tasks.failWith = new Error('source down');
  const errors = console.error;
  console.error = () => undefined;
  try {
    const d = customer(h);
    const row = await attachBuilding(h.ctx, d, 'b-sw');
    await settleWorkUpdates();
    assert.equal(row.buildings.length, 1);
  } finally { console.error = errors; }
});

test('I32b a per-task agent failure during backfill falls back (not rewritten and backfilled)', async () => {
  const h = harness();
  h.agent.reply = new Error('x');
  h.tasks.byBuilding.set('b-sw', [task({ finishedAt: h.clock.now - DAY })]);
  const c = await attached(h);
  assert.deepEqual([data(work(h.ctx, c)[0]!).rewritten, data(work(h.ctx, c)[0]!).backfilled], [false, true]);
});

test('I33 a backfill and a live finish for the same task at once give one entry', async () => {
  const h = harness();
  const c = customer(h);
  await attachBuilding(h.ctx, c, 'b-sw');
  await settleWorkUpdates();
  const releases: Array<(v: string) => void> = [];
  h.ctx.deps.agent.run = () => new Promise<string>((r) => { releases.push(r); });
  h.tasks.byBuilding.set('b-sw', [task({ finishedAt: h.clock.now - 1000 })]);
  const backfill = backfillBuilding(h.ctx, c, target);
  const live = postFinished(h.ctx, target, task({ finishedAt: h.clock.now - 1000 }));
  await new Promise((r) => setImmediate(r));
  releases.forEach((r) => r('ok'));
  await Promise.all([backfill, live]);
  assert.equal(work(h.ctx, c).length, 1);
});

test('I34 backfill for a second customer leaves the first customer\'s entries untouched', async () => {
  const h = harness();
  h.tasks.byBuilding.set('b-sw', [task({ finishedAt: h.clock.now - DAY })]);
  const a = await attached(h);
  const before = work(h.ctx, a);
  const b = await attached(h);
  assert.deepEqual(work(h.ctx, a), before);
  assert.equal(work(h.ctx, b).length, 1);
});

test('I36 the work summary uses the existing CRM agent with a no-tools turn', async () => {
  const seen: Array<{ disallowedTools: string[]; appendSystemPrompt: string }> = [];
  const agent = createCrmAgent(() => 'b1', async () => '/w', {
    selectExecutor: async () => ({}), runTurn: async (_e: unknown, o: { disallowedTools: string[]; appendSystemPrompt: string }) => { seen.push(o); return { status: 'done', message: '', extra: { text: 'ok' } }; },
  } as never);
  assert.equal(await agent.run({ kind: 'work', prompt: 'p' }), 'ok');
  assert.ok(seen[0]!.disallowedTools.includes('Bash'));
  assert.match(seen[0]!.appendSystemPrompt, /Do not use any tools/);
});

test('I37 nothing is sent to the customer: no mail, no follow-ups', async () => {
  const h = harness();
  const c = await attached(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.equal(h.transport.sent.length, 0);
  assert.equal((h.ctx.db.prepare('SELECT COUNT(*) AS n FROM followups WHERE contactId = ?').get(c) as { n: number }).n, 0);
});

test('I38 a Building-work entry cannot be edited', async () => {
  const h = harness();
  const c = await attached(h);
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  const id = (h.ctx.db.prepare("SELECT id FROM timeline WHERE kind = 'building_work'").get() as { id: number }).id;
  assert.throws(() => editComment(h.ctx, c, id, 'x'), /Only comments can be changed/);
});

test('I40 each attached Building has its own work log (newest first, max 50) and total; I41 an unavailable Building keeps its log', async () => {
  const h = harness();
  const c = await attached(h);
  await attachBuilding(h.ctx, c, 'b-seo');
  for (let i = 0; i < WORK_LOG_MAX + 5; i++) addWorkEntry(h.ctx, c, `k${i}`, 't', { phase: 'finished', buildingId: 'b-sw', taskTitle: `T${i}`, summary: 's', rewritten: true, backfilled: false }, 1000 + i);
  addWorkEntry(h.ctx, c, 'other', 't', { phase: 'started', buildingId: 'b-seo', taskTitle: 'S' }, 5000);
  addEntry(h.ctx, c, 'comment', 'hello');
  h.buildings.peeks.set('b-sw', { state: 'unavailable' });
  const [row] = (await listCustomers(h.ctx, {})).rows;
  const sw = row!.buildings.find((b) => b.buildingId === 'b-sw')!, seo = row!.buildings.find((b) => b.buildingId === 'b-seo')!;
  assert.deepEqual([sw.workLog.length, sw.workLogTotal, sw.workLog[0]!.taskTitle, sw.peek.state], [WORK_LOG_MAX, WORK_LOG_MAX + 5, `T${WORK_LOG_MAX + 4}`, 'unavailable']);
  assert.deepEqual([seo.workLogTotal, seo.workLog[0]!.phase, seo.workLog[0]!.rewritten], [1, 'started', true]);
});

test('I42 counts and reports are unchanged by posting entries', async () => {
  const h = harness();
  const c = await attached(h);
  const count = () => (h.ctx.db.prepare("SELECT (SELECT COUNT(*) FROM contacts) AS c, (SELECT COUNT(*) FROM followups) AS f, (SELECT COUNT(*) FROM building_links) AS l").get());
  const before = count();
  postStarted(h.ctx, target, task({ startedAt: h.clock.now }));
  await postFinished(h.ctx, target, task({ finishedAt: h.clock.now }));
  assert.deepEqual(count(), before);
  assert.equal(c > 0, true);
});

test('U10 I29 backfill orders by finish time with stable ties, skips old and unfinished tasks, and posts no "started"', async () => {
  const h = harness();
  h.tasks.byBuilding.set('b-sw', [
    task({ planItemId: 'a', title: 'A', finishedAt: h.clock.now - 5 * DAY }),
    task({ planItemId: 'b', title: 'B', finishedAt: h.clock.now - 5 * DAY }),
    task({ planItemId: 'c', title: 'C', finishedAt: h.clock.now - 9 * DAY }),
    task({ planItemId: 'old', title: 'Old', finishedAt: h.clock.now - 45 * DAY }),
    task({ planItemId: 'open', title: 'Open', finishedAt: null }),
  ]);
  const c = await attached(h);
  const rows = work(h.ctx, c);
  assert.deepEqual(rows.map((r) => data(r).taskTitle), ['C', 'A', 'B']);
  assert.ok(rows.every((r) => data(r).phase === 'finished'));
});
