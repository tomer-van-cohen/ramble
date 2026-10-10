// node --test test/net.test.mjs — a request that fails on the way gets one more try, and the log says why (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NET_RETRY_DELAY_MS = '1';
const { isNetError, netWhy, retryNet } = await import('../src/net.js');

// What fetch throws when the connection, not the provider, fails.
const dropped = (code = 'ECONNRESET') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) });

test('a dropped connection is a network failure; an answer, a cancellation or our own timeout is not', () => {
  assert.equal(isNetError(dropped()), true);
  assert.equal(isNetError(dropped('UND_ERR_CONNECT_TIMEOUT')), true);
  assert.equal(isNetError(new TypeError('terminated')), true);
  assert.equal(isNetError(new Error('whisper HTTP 500')), false);
  assert.equal(isNetError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isNetError(new Error('timeout')), false);
});

test('the log line carries the reason under "fetch failed"', () => {
  assert.equal(netWhy(dropped()), 'fetch failed (read ECONNRESET)');
  assert.equal(netWhy(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })), 'fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error)');
  assert.equal(netWhy(new Error('model HTTP 429 (rate_limit)\nmore')), 'model HTTP 429 (rate_limit)');
});

test('one more try after a dropped connection, and the second answer is used', async () => {
  let calls = 0;
  const out = await retryNet(async () => { if (++calls === 1) throw dropped(); return 'text'; });
  assert.equal(out, 'text'); assert.equal(calls, 2);
});

test('two drops in a row give up with the error; an HTTP error or a cancellation is never retried', async () => {
  let calls = 0;
  await assert.rejects(retryNet(async () => { calls++; throw dropped(); }), /fetch failed/); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(retryNet(async () => { calls++; throw new Error('HTTP 400'); }), /HTTP 400/); assert.equal(calls, 1);
  calls = 0; const ac = new AbortController(); ac.abort();
  await assert.rejects(retryNet(async () => { calls++; throw dropped(); }, { signal: ac.signal }), /fetch failed/); assert.equal(calls, 1);
});

test('connections: each attempt gets seconds, not the 250 ms that a busy event loop overruns, and IPv4 goes first', async () => {
  const net = await import('node:net'); const dns = await import('node:dns');
  const { configureConnections, CONNECT_ATTEMPT_MS } = await import('../src/net.js');
  configureConnections();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), CONNECT_ATTEMPT_MS); assert.ok(CONNECT_ATTEMPT_MS >= 2000);
  assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
});
