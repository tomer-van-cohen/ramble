// node --test test/admin-user.test.mjs — with ADMIN_USER set, /admin needs the username and the password.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-admin-user-'));
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.ADMIN_USER = 'test-admin-user';
process.env.TRUST_PROXY = '0';
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const as = (user, pass) => fetch(`${base}/admin.json`, { headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } });

test('the right username and password get in; either one wrong does not, and the answer does not say which', async () => {
  assert.equal((await as('test-admin-user', 'test-admin-pw')).status, 200);
  const wrongUser = await as('admin', 'test-admin-pw'), wrongPass = await as('test-admin-user', 'nope');
  assert.equal(wrongUser.status, 401); assert.equal(wrongPass.status, 401);
  assert.equal(await wrongUser.text(), await wrongPass.text());
  assert.equal((await as('test-admin-user', 'test-admin-pw:extra')).status, 401, 'a colon in the password is part of it');
});
