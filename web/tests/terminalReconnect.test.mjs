import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const { createTerminalConnection, isTaskExpectedLive, FALLBACK_RETRY_DELAYS_MS } = await import('../src/lib/terminalReconnect.ts');

/**
 * Drives one terminal connection with fake sockets and timers. `sockets` lists every socket opened, in
 * order; `log` records resets and writes in order so a test can check a reset came before new output.
 */
function harness({ initiallyLive = false, expectedLive = false } = {}) {
  const sockets = [];
  const log = [];
  const events = [];
  const sessionStates = [];
  const timers = [];
  let connectionIds = 0;
  const state = { expectedLive };
  const connection = createTerminalConnection({
    openSocket: (handlers) => {
      const socket = {
        handlers,
        open: false,
        closed: false,
        sent: [],
        isOpen() { return this.open; },
        send(data) { this.sent.push(JSON.parse(data)); },
        close() { this.closed = true; this.open = false; },
        // Server-side helpers.
        accept() { this.open = true; handlers.onOpen(); },
        frame(message) { handlers.onMessage(JSON.stringify(message)); },
        refuse() { handlers.onMessage(JSON.stringify({ type: 'error', message: 'Terminal session is no longer available' })); this.drop(); },
        drop() { this.open = false; handlers.onClose(); },
      };
      sockets.push(socket);
      return socket;
    },
    write: (data) => log.push(`write:${data}`),
    reset: () => log.push('reset'),
    onConnectionEvent: (event) => events.push(event),
    onSessionState: (value) => sessionStates.push(value),
    onOpen: () => {},
    nextConnectionId: () => ++connectionIds,
    isExpectedLive: () => state.expectedLive,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    initiallyLive,
  });
  const pendingTimers = () => timers.filter((timer) => !timer.cleared && !timer.fired);
  const fireTimers = () => { for (const timer of pendingTimers()) { timer.fired = true; timer.callback(); } };
  return { connection, sockets, log, events, sessionStates, timers, pendingTimers, fireTimers, state, latest: () => sockets.at(-1) };
}

test('regression: a terminal mounted before its PTY exists reconnects once the session is live, and shows its output', () => {
  const h = harness();
  h.latest().accept();
  h.latest().refuse();
  assert.equal(h.sockets.length, 1, 'a not-live session does not reconnect on its own');
  assert.equal(h.events.at(-1).type, 'error');

  h.connection.setLive(true);
  assert.equal(h.sockets.length, 2, 'exactly one new socket once the PTY is listed');
  h.latest().accept();
  h.latest().frame({ type: 'live' });
  h.latest().frame({ type: 'output', data: 'hello' });
  assert.deepEqual(h.log, ['reset', 'write:hello'], 'the view is cleared before the new attach replays output');
  assert.deepEqual(h.events.slice(-2), [{ type: 'start', connectionId: 2 }, { type: 'open', connectionId: 2 }], 'the new socket gets its own connection id, clearing the error badge');
  assert.deepEqual(h.sessionStates, ['ended', 'live']);
});

test('an already-live, attached session is never reconnected by later snapshots', () => {
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'live' });
  h.latest().frame({ type: 'output', data: 'a' });
  for (let i = 0; i < 5; i += 1) h.connection.setLive(true);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.log, ['write:a'], 'no reset');
});

test('a live snapshot that arrives before the failed attach is processed reconnects once the close lands', () => {
  const h = harness();
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 1, 'still connecting: nothing to do yet');
  h.latest().refuse();
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].closed, true);
});

test('a normal end never reconnects or resets, even while the snapshot still lists the session', () => {
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'live' });
  h.latest().frame({ type: 'output', data: 'scrollback' });
  h.latest().frame({ type: 'ended' });
  h.connection.setLive(true); // a stale snapshot from before the exit
  h.connection.setLive(false); // the exit's own snapshot
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.log, ['write:scrollback'], 'scrollback stays');
  assert.deepEqual(h.sessionStates, ['live', 'ended']);
});

test('a session restarted under the same id (step reopen) reconnects once, after a reset', () => {
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'output', data: 'old' });
  h.latest().frame({ type: 'ended' });
  h.connection.setLive(false);
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[0].closed, true);
  h.latest().frame({ type: 'output', data: 'old' });
  h.latest().frame({ type: 'output', data: 'new' });
  assert.deepEqual(h.log, ['write:old', 'reset', 'write:old', 'write:new'], 'the replayed buffer is not doubled');
});

test('attaching to an already-ended session that is not live arms the reconnect for its restart', () => {
  const h = harness();
  h.latest().accept();
  h.latest().frame({ type: 'output', data: 'old' });
  h.latest().frame({ type: 'ended' });
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 2);
});

test('without a not-live snapshot between, an ended session does not reconnect on a live one', () => {
  // Why the component feeds every snapshot (store subscription) and the server sends them in order:
  // the not-live snapshot is what proves the next live one is a new PTY.
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'ended' });
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 1);
});

test('out-of-order snapshots cause at most one reattach to the ended session, with no loop', () => {
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'ended' });
  h.connection.setLive(false);
  h.connection.setLive(true); // a stale start snapshot resolving late
  assert.equal(h.sockets.length, 2);
  h.latest().accept();
  h.latest().frame({ type: 'ended' }); // the ended session replays and ends again
  h.connection.setLive(true);
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 2);
});

test('a dropped socket with a stale live listing waits for a fresh snapshot instead of looping', () => {
  const h = harness({ initiallyLive: true });
  h.latest().accept();
  h.latest().frame({ type: 'live' });
  h.latest().drop(); // the daemon went away; the store still lists the session
  assert.equal(h.sockets.length, 1);
  h.connection.setLive(true); // the daemon is back and lists it
  assert.equal(h.sockets.length, 2);
  h.latest().drop();
  assert.equal(h.sockets.length, 2, 'one attempt per fresh snapshot');
});

test('a non-Task session (agent or studio) reconnects from snapshots alone and never retries on a timer', () => {
  const h = harness({ expectedLive: false });
  h.latest().refuse();
  assert.equal(h.pendingTimers().length, 0);
  h.connection.setLive(true);
  assert.equal(h.sockets.length, 2);
});

test('a Task expected live retries with backoff while unlisted, up to the bound', () => {
  const h = harness({ expectedLive: true });
  h.latest().refuse();
  const delays = [];
  for (let i = 0; i < FALLBACK_RETRY_DELAYS_MS.length + 2; i += 1) {
    const [timer] = h.pendingTimers();
    if (!timer) break;
    delays.push(timer.ms);
    h.fireTimers();
    h.latest().refuse();
  }
  assert.deepEqual(delays, [...FALLBACK_RETRY_DELAYS_MS]);
  assert.equal(h.sockets.length, FALLBACK_RETRY_DELAYS_MS.length + 1);
  assert.equal(h.pendingTimers().length, 0, 'stops at the bound');
});

test('the fallback retry stops once the task is no longer expected live, and a successful attach resets its budget', () => {
  const h = harness({ expectedLive: true });
  h.latest().refuse();
  h.state.expectedLive = false;
  h.fireTimers();
  assert.equal(h.sockets.length, 1, 'a done/stopped task is not retried');

  const g = harness({ expectedLive: true });
  g.latest().refuse();
  g.fireTimers();
  g.latest().frame({ type: 'live' });
  g.latest().drop();
  assert.equal(g.pendingTimers()[0].ms, FALLBACK_RETRY_DELAYS_MS[0]);
});

test('a live snapshot cancels a pending fallback retry in favour of an immediate reconnect', () => {
  const h = harness({ expectedLive: true });
  h.latest().refuse();
  const [timer] = h.pendingTimers();
  h.connection.setLive(true);
  assert.equal(timer.cleared, true);
  assert.equal(h.sockets.length, 2);
});

test('input and resize go to the current socket after a reconnect, and only while it is open', () => {
  const h = harness();
  h.connection.send({ type: 'input', data: 'lost' });
  h.latest().refuse();
  h.connection.setLive(true);
  h.connection.send({ type: 'input', data: 'early' });
  h.latest().accept();
  h.connection.send({ type: 'input', data: 'x' });
  h.connection.send({ type: 'resize', cols: 80, rows: 24 });
  assert.deepEqual(h.sockets[0].sent, []);
  assert.deepEqual(h.sockets[1].sent, [{ type: 'input', data: 'x' }, { type: 'resize', cols: 80, rows: 24 }]);
});

test('events from a replaced or disposed socket are ignored, and dispose closes the socket and timers', () => {
  const h = harness({ expectedLive: true });
  const first = h.latest();
  first.refuse();
  h.connection.setLive(true);
  first.frame({ type: 'output', data: 'stale' });
  first.handlers.onError();
  assert.ok(!h.log.includes('write:stale'));
  assert.equal(h.sockets.length, 2);

  h.latest().refuse();
  h.connection.setLive(false);
  const pending = h.pendingTimers();
  h.connection.dispose();
  assert.equal(h.latest().closed, true);
  assert.ok(pending.every((timer) => timer.cleared));
  h.connection.setLive(true);
  h.latest().frame({ type: 'output', data: 'late' });
  assert.equal(h.sockets.length, 2);
  assert.ok(!h.log.includes('write:late'));
});

test('a socket error reports the connection failure; malformed frames are ignored', () => {
  const h = harness();
  h.latest().frame({ type: 'output', data: 'ok' });
  h.latest().handlers.onMessage('not json');
  h.latest().handlers.onError();
  assert.deepEqual(h.events.at(-1), { type: 'error', connectionId: 1, message: 'Could not connect to the terminal session.' });
  assert.deepEqual(h.log, ['write:ok']);
  h.latest().handlers.onMessage(JSON.stringify({ type: 'error' }));
  assert.equal(h.events.filter((event) => event.type === 'error').at(-1).message, 'Terminal unavailable');
});

test('isTaskExpectedLive: running or starting Tasks only; a missing record is not', () => {
  assert.equal(isTaskExpectedLive(undefined), false);
  assert.equal(isTaskExpectedLive({ status: 'developing' }), true);
  assert.equal(isTaskExpectedLive({ status: 'blocked' }), true);
  assert.equal(isTaskExpectedLive({ status: 'stopped', runtimeStatus: 'starting' }), true);
  for (const status of ['done', 'stopped', 'failed']) assert.equal(isTaskExpectedLive({ status, runtimeStatus: 'stopped' }), false);
});

test('TaskTerminal reconnects through this controller, fed every live-session snapshot from the store', async () => {
  const terminal = await readFile(new URL('../src/ui/TaskTerminal.tsx', import.meta.url), 'utf8');
  assert.match(terminal, /const link = createTerminalConnection\(\{/);
  assert.match(terminal, /useWorldStore\.subscribe\(\(state, previous\) => \{\s*if \(state\.liveTerminalSessions !== previous\.liveTerminalSessions\) link\.setLive\(isLiveIn\(state\.liveTerminalSessions\)\);/);
  assert.match(terminal, /reset: \(\) => terminal\.reset\(\)/, 'the view is cleared before a reattach replays the buffer');
  assert.match(terminal, /isExpectedLive: \(\) => isTaskExpectedLive\(useWorldStore\.getState\(\)\.tasksById\[taskId\]\)/);
  assert.match(terminal, /stopLiveSync\(\);\s*link\.dispose\(\);/);
});
