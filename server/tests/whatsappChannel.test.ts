import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWhatsAppChannel,
  WhatsAppChannelConfigError,
  WhatsAppChannelSendError,
} from '../src/notifications/channels/whatsappChannel.ts';

const config = { sendHost: 'https://send.example', sendApiKey: 'test-key', sendTo: '+15550000000' };

test('send() posts the exact shape docs/notify.sh sends and resolves on a 2xx response', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const channel = createWhatsAppChannel({
    ...config,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('ok', { status: 200 });
    },
  });

  await channel.send('hello there', '+19998887777');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://send.example/api/send');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-api-key'), 'test-key');
  // target is ignored in favor of the configured recipient (see whatsappChannel.ts's doc comment).
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { to: '+15550000000', message: 'hello there' });
});

test('send() throws WhatsAppChannelConfigError when any of sendHost/sendApiKey/sendTo is missing', async () => {
  const fetchCalls: unknown[] = [];
  const stubFetch = async () => { fetchCalls.push(null); return new Response('', { status: 200 }); };

  await assert.rejects(
    () => createWhatsAppChannel({ sendApiKey: 'k', sendTo: 't', fetch: stubFetch }).send('m', 'x'),
    WhatsAppChannelConfigError,
  );
  await assert.rejects(
    () => createWhatsAppChannel({ sendHost: 'h', sendTo: 't', fetch: stubFetch }).send('m', 'x'),
    WhatsAppChannelConfigError,
  );
  await assert.rejects(
    () => createWhatsAppChannel({ sendHost: 'h', sendApiKey: 'k', fetch: stubFetch }).send('m', 'x'),
    WhatsAppChannelConfigError,
  );
  await assert.rejects(
    () => createWhatsAppChannel({ fetch: stubFetch }).send('m', 'x'),
    WhatsAppChannelConfigError,
  );
  // None of the above should have reached the network.
  assert.equal(fetchCalls.length, 0);
});

test('send() surfaces a non-2xx response as a rejected promise', async () => {
  const channel = createWhatsAppChannel({
    ...config,
    fetch: async () => new Response('bad api key', { status: 401 }),
  });

  await assert.rejects(
    () => channel.send('hello', '+19998887777'),
    (error: unknown) => {
      assert.ok(error instanceof WhatsAppChannelSendError);
      assert.match(error.message, /401/);
      assert.match(error.message, /bad api key/);
      return true;
    },
  );
});
