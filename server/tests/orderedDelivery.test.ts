import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOrderedDelivery } from '../src/api/orderedDelivery.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('results that resolve in reverse order are still delivered in call order', async () => {
  const delivered: string[] = [];
  const send = createOrderedDelivery<string>((value) => delivered.push(value));
  const first = deferred<string>();
  const second = deferred<string>();
  send(first.promise);
  send(second.promise);
  second.resolve('live: []');
  await settle();
  assert.deepEqual(delivered, [], 'the newer result waits for the older one');
  first.resolve('live: [s1]');
  await settle();
  assert.deepEqual(delivered, ['live: [s1]', 'live: []']);
});

test('a failed lookup is skipped, without an unhandled rejection, and later ones still arrive', async () => {
  const delivered: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const send = createOrderedDelivery<string>((value) => delivered.push(value));
    const slow = deferred<string>();
    const failing = deferred<string>();
    send(slow.promise);
    send(failing.promise);
    send(Promise.resolve('third'));
    failing.reject(new Error('db lookup failed'));
    await settle();
    slow.resolve('first');
    await settle();
    assert.deepEqual(delivered, ['first', 'third']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
