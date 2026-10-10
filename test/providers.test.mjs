// node --test test/providers.test.mjs — the Workers AI host speaks its own shape: JSON in, a wrapped
// answer out, and the caller sees the same text/language/segments as from any other host. Fake fetch, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-test';
process.env.CLOUDFLARE_API_TOKEN = 'token-test';
process.env.NET_RETRY_DELAY_MS = '1';
const { HOSTS, hostEnabled, hostLabel, transcribeAudio } = await import('../src/providers.js');

const audio = { buf: Buffer.from('OggS fake'), name: 'note.ogg' };
const reply = (status, json, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => json, text: async () => JSON.stringify(json) });
let seen;
const withFetch = async (answer, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return typeof answer === 'function' ? answer() : answer; };
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test('the host is listed, on with both values, and labelled by its address', () => {
  assert.ok(HOSTS.cloudflare); assert.equal(hostEnabled('cloudflare'), true); assert.equal(hostLabel('cloudflare'), 'api.cloudflare.com');
});

test('the request is JSON at .../ai/run/<model>: audio in base64, language and the prompt under their own names', async () => {
  const text = await withFetch(reply(200, { success: true, result: { text: ' שלום ', transcription_info: { language: 'he' } } }),
    () => transcribeAudio('cloudflare', audio, { model: '@cf/openai/whisper-large-v3-turbo', language: 'he', prompt: 'hint' }));
  assert.equal(text, 'שלום');
  assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run/@cf/openai/whisper-large-v3-turbo');
  assert.equal(seen.init.headers.Authorization, 'Bearer token-test');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body, { audio: audio.buf.toString('base64'), language: 'he', initial_prompt: 'hint' });
});

test('with details, the language and segments come from the wrapped answer; nothing optional is sent when empty', async () => {
  const segs = [{ avg_logprob: -0.3, no_speech_prob: 0.02, compression_ratio: 1.1 }];
  const r = await withFetch(reply(200, { success: true, result: { text: 'hi', transcription_info: { language: 'en' }, segments: segs } }),
    () => transcribeAudio('cloudflare', audio, { model: 'm', language: '', details: true }));
  assert.deepEqual(r, { text: 'hi', language: 'en', segments: segs });
  assert.deepEqual(Object.keys(JSON.parse(seen.init.body)), ['audio']);
});

test('an error carries the status, the first error code and retry-after; a 200 with success:false is an error too', async () => {
  await assert.rejects(withFetch(reply(429, { success: false, errors: [{ code: 10000, message: 'quota' }] }, { 'retry-after': '120' }),
    () => transcribeAudio('cloudflare', audio, { model: 'm' })), (e) => e.status === 429 && e.retryAfter === 120 && /HTTP 429 \(10000\)/.test(e.message));
  await assert.rejects(withFetch(reply(200, { success: false, errors: [{ code: 7000 }] }),
    () => transcribeAudio('cloudflare', audio, { model: 'm' })), (e) => e.status === 200 && /\(7000\)/.test(e.message));
});

test('the body of an error never reaches the message', async () => {
  await assert.rejects(withFetch(reply(400, { success: false, errors: [{ code: 1, message: 'the audio said: secret words' }] }),
    () => transcribeAudio('cloudflare', audio, { model: 'm' })), (e) => !/secret/.test(e.message));
});
