import assert from 'node:assert/strict';
import test from 'node:test';
import { PASTE_END, PASTE_START, terminalSafe, typeIntoSession } from '../src/content/typeIntoSession.ts';

function fakeHost() {
  const writes: [string, string][] = [];
  return { writes, write: (id: string, data: string) => { writes.push([id, data]); } };
}

function heldTimer() {
  const held: { fn: () => void; ms: number }[] = [];
  return { held, setTimer: (fn: () => void, ms: number) => { held.push({ fn, ms }); } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('TI1 the text goes as one bracketed paste, then Enter only after the timer fires with the given delay', async () => {
  const host = fakeHost();
  const timer = heldTimer();
  const pending = typeIntoSession(host, 's1', 'Hello there', 300, timer.setTimer);
  await flush();
  assert.deepEqual(host.writes, [['s1', '\x1b[200~Hello there\x1b[201~']], 'no Enter before the timer fires');
  assert.deepEqual(timer.held.map((h) => h.ms), [300]);
  timer.held[0]!.fn();
  assert.equal(await pending, 11);
  assert.deepEqual(host.writes, [['s1', '\x1b[200~Hello there\x1b[201~'], ['s1', '\r']]);
});

test('TI2 nothing inside the paste can end it, press Enter or send a control key', async () => {
  const host = fakeHost();
  const nasty = 'a\x1b[201~b\x1bc\rd\ne\r\nf\tg\x9bh\x00i\x03j\x7fk';
  const sent = await typeIntoSession(host, 's1', nasty, 0, (fn) => fn());
  const pasted = host.writes[0]![1];
  assert.ok(pasted.startsWith(PASTE_START) && pasted.endsWith(PASTE_END));
  const inner = pasted.slice(PASTE_START.length, -PASTE_END.length);
  assert.equal(inner, 'abc d e f ghijk');
  assert.doesNotMatch(inner, /[\x00-\x1f\x7f-\x9f]/);
  assert.equal(sent, inner.length);
  assert.deepEqual(host.writes.map((w) => w[1]).slice(1), ['\r']);
});

test('TI3 the count is in characters (code points), not UTF-16 units or bytes', async () => {
  const host = fakeHost();
  assert.equal(await typeIntoSession(host, 's1', 'नमस्ते 👋', 0, (fn) => fn()), [...'नमस्ते 👋'].length);
});

test('TI4 a message over one 1,024-byte read still goes as a single bracketed write', async () => {
  const host = fakeHost();
  const long = 'x'.repeat(2_500);
  await typeIntoSession(host, 's1', long, 0, (fn) => fn());
  assert.deepEqual(host.writes.map((w) => w[1]), [`${PASTE_START}${long}${PASTE_END}`, '\r']);
});

test('TI5 terminalSafe keeps ordinary text and quotes as typed', () => {
  assert.equal(terminalSafe('Say "hi" — yaar, kya scene hai?'), 'Say "hi" — yaar, kya scene hai?');
});
