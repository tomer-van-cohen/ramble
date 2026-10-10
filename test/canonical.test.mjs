// node --test test/canonical.test.mjs — a retired domain forwards to the current one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-canon-'));
process.env.CANONICAL_HOST = 'ramble.baby';
process.env.LEGACY_HOSTS = 'readable.live, www.readable.live';
process.env.TRUST_PROXY = '0';
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
after(() => server.close());

const ask = (host, path, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers: { host } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
  req.on('error', reject); req.end();
});

test('the old domain forwards to the new one and keeps the path and query', async () => {
  const r = await ask('readable.live', '/i/abcd1234?x=1');
  assert.equal(r.statusCode, 301);
  assert.equal(r.headers.location, 'https://ramble.baby/i/abcd1234?x=1');
  assert.equal((await ask('WWW.Readable.Live', '/privacy')).headers.location, 'https://ramble.baby/privacy');
});

test('a form posted from a page still open on the old domain lands on the new home page, not on a cross-site refusal', async () => {
  const r = await ask('readable.live', '/start', 'POST');
  assert.equal(r.statusCode, 303); assert.equal(r.headers.location, 'https://ramble.baby/');
});

test('the current domain, unknown hosts and health checks are served in place', async () => {
  assert.equal((await ask('ramble.baby', '/')).statusCode, 200);
  assert.equal((await ask('some-app.up.railway.app', '/')).statusCode, 200);
  assert.equal((await ask('readable.live', '/healthz')).statusCode, 200);
});
