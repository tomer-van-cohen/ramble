// node --test test/authstore.test.mjs — the single-file session store and the move from the old folder (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useMultiFileAuthState, proto } from '@whiskeysockets/baileys';
import { useAuthStore, sqliteAvailable } from '../src/authstore.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'ramble-auth-'));
const bytes = (n, fill) => Buffer.alloc(n, fill);
// Invented keys with the shapes the real ones have: ids with ":" "/" "." and "@", buffers inside objects.
const KEYS = {
  'pre-key': { 1: { private: bytes(32, 1), public: bytes(32, 2) }, 2: { private: bytes(32, 3), public: bytes(32, 4) } },
  session: { '15550100001.0': { _sessions: { a: { registrationId: 7, chain: bytes(40, 5) } }, version: 'v1' }, '15550100002:3.0': { version: 'v1' } },
  'sender-key': { '120363000000000001@g.us::15550100003::0': bytes(64, 6) },
  'lid-mapping': { '15550100004': '100000000000004', '100000000000004_reverse': '15550100004' },
  'app-state-sync-key': { 'AAAAAA/b+c=': { keyData: bytes(32, 9), timestamp: 1700000000000 } },
};
const ids = (type) => Object.keys(KEYS[type]);

async function oldFolder(dir) {
  const { state, saveCreds } = await useMultiFileAuthState(join(dir, 'baileys_auth'));
  state.creds.me = { id: '15550100000:1@s.whatsapp.net', name: 'Test' }; state.creds.registered = true;
  await saveCreds(); await state.keys.set(KEYS);
  const read = {}; for (const type of Object.keys(KEYS)) read[type] = await state.keys.get(type, [...ids(type), 'missing']);
  // What the old store itself reads back from disk is the yardstick (JSON drops undefined fields).
  const saved = (await useMultiFileAuthState(join(dir, 'baileys_auth'))).state.creds;
  return { creds: saved, read, files: readdirSync(join(dir, 'baileys_auth')).length };
}

test('the store is the built-in SQLite one on this Node', () => assert.equal(sqliteAvailable, true));

test('an account with the old folder is moved key for key, and the folder goes only once the connection is accepted', async () => {
  const dir = fresh(); const before = await oldFolder(dir);
  assert.equal(before.files, 9); // creds + 8 keys, one file each
  const store = await useAuthStore(dir); const { state } = await store.auth();
  assert.deepEqual(state.creds, before.creds);
  for (const type of Object.keys(KEYS)) assert.deepEqual(await state.keys.get(type, [...ids(type), 'missing']), before.read[type], type);
  assert.ok((await state.keys.get('app-state-sync-key', ids('app-state-sync-key')))['AAAAAA/b+c='] instanceof proto.Message.AppStateSyncKeyData);
  assert.ok(!existsSync(join(dir, 'baileys_auth'))); assert.ok(existsSync(join(dir, 'baileys_auth.migrated')));
  await store.settle();
  assert.deepEqual(readdirSync(dir).filter((f) => !f.startsWith('auth.db')), []); // nothing but the one database (and its journal)
  store.close();
  // And it is all still there after a restart.
  const again = await useAuthStore(dir); const a = await again.auth();
  assert.deepEqual(a.state.creds, before.creds);
  assert.deepEqual(await a.state.keys.get('session', ids('session')), before.read.session ? Object.fromEntries(ids('session').map((i) => [i, before.read.session[i]])) : {});
  again.close();
});

test('keys are written, replaced and removed; credentials are saved; each auth() reads them afresh', async () => {
  const dir = fresh(); const store = await useAuthStore(dir); const { state, saveCreds } = await store.auth();
  assert.equal(state.creds.registered, false);
  await state.keys.set({ session: { a: { v: 1 }, b: { v: 2 } } });
  await state.keys.set({ session: { a: { v: 3 }, b: null }, 'pre-key': { 5: { private: bytes(4, 1), public: bytes(4, 2) } } });
  assert.deepEqual(await state.keys.get('session', ['a', 'b']), { a: { v: 3 }, b: null });
  assert.deepEqual((await state.keys.get('pre-key', ['5']))['5'].public, bytes(4, 2));
  state.creds.registered = true; state.creds.accountSyncCounter = 4; await saveCreds();
  const second = await store.auth();
  assert.notEqual(second.state.creds, state.creds); assert.equal(second.state.creds.accountSyncCounter, 4);
  store.close();
});

test('a batch of keys lands whole or not at all', async () => {
  const dir = fresh(); const store = await useAuthStore(dir); const { state } = await store.auth();
  await state.keys.set({ session: { kept: { v: 1 } } });
  const circular = {}; circular.self = circular; // cannot be written
  await assert.rejects(state.keys.set({ session: { first: { v: 2 }, broken: circular } }));
  assert.deepEqual(await state.keys.get('session', ['kept', 'first']), { kept: { v: 1 }, first: null });
  store.close();
});

test('logged out: nothing of the old session is left, in the file or beside it', async () => {
  const dir = fresh(); const before = await oldFolder(dir);
  const store = await useAuthStore(dir);
  await store.clear();
  const { state } = await store.auth();
  assert.equal(state.creds.registered, false); assert.notDeepEqual(state.creds.noiseKey, before.creds.noiseKey);
  assert.deepEqual(await state.keys.get('session', ids('session')), Object.fromEntries(ids('session').map((i) => [i, null])));
  assert.ok(!existsSync(join(dir, 'baileys_auth.migrated'))); assert.ok(!existsSync(join(dir, 'baileys_auth')));
  store.close();
});

test('an old folder that shows up again was written by older code, so it wins', async () => {
  const dir = fresh(); await oldFolder(dir);
  const store = await useAuthStore(dir); const { state } = await store.auth();
  await state.keys.set({ session: { onlyInDb: { v: 1 } } }); store.close();
  const older = await useMultiFileAuthState(join(dir, 'baileys_auth')); // what a rollback would do
  older.state.creds.accountSyncCounter = 99; await older.saveCreds(); await older.state.keys.set({ session: { fromOldCode: { v: 2 } } });
  const back = await useAuthStore(dir); const b = await back.auth();
  assert.equal(b.state.creds.accountSyncCounter, 99);
  assert.deepEqual(await b.state.keys.get('session', ['fromOldCode', 'onlyInDb']), { fromOldCode: { v: 2 }, onlyInDb: null });
  back.close();
});

test('a damaged key file reads as a missing key, as it did in the old store; the rest is moved', async () => {
  const dir = fresh(); const before = await oldFolder(dir);
  writeFileSync(join(dir, 'baileys_auth', 'session-torn.json'), '{"half":');
  const store = await useAuthStore(dir); const { state } = await store.auth();
  assert.deepEqual(state.creds, before.creds);
  assert.deepEqual(await state.keys.get('session', ['torn', '15550100001.0']), { torn: null, '15550100001.0': before.read.session['15550100001.0'] });
  store.close();
});

test('a stopped account writes nothing more, and says nothing about it', async () => {
  const dir = fresh(); const store = await useAuthStore(dir); const { state, saveCreds } = await store.auth();
  store.close(); store.close();
  await state.keys.set({ session: { late: { v: 1 } } }); await saveCreds();
  assert.deepEqual(await state.keys.get('session', ['late']), { late: null });
});

test('ten thousand keys are three files, not ten thousand', async () => {
  const dir = fresh(); mkdirSync(dir, { recursive: true });
  const store = await useAuthStore(dir); const { state } = await store.auth();
  const many = {}; for (let i = 0; i < 10000; i++) many[`1555010${String(i).padStart(4, '0')}`] = `10000000000${i}`;
  await state.keys.set({ 'lid-mapping': many });
  assert.ok(readdirSync(dir).length <= 3);
  assert.equal((await state.keys.get('lid-mapping', ['15550109999']))['15550109999'], '100000000009999');
  store.close();
});

test('keys without credentials belong to an earlier pairing and are not carried into a new one', async () => {
  const dir = fresh(); await oldFolder(dir);
  writeFileSync(join(dir, 'baileys_auth', 'creds.json'), ''); // what a crash in the middle of a write leaves
  const store = await useAuthStore(dir); const { state } = await store.auth();
  assert.equal(state.creds.registered, false);
  assert.deepEqual(await state.keys.get('session', ids('session')), Object.fromEntries(ids('session').map((i) => [i, null])));
  assert.deepEqual(await state.keys.get('sender-key', ids('sender-key')), Object.fromEntries(ids('sender-key').map((i) => [i, null])));
  store.close();
});

test('the sessions with given users go, every device of theirs, under either address; the rest stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ramble-forget-'));
  const store = await useAuthStore(dir, { tag: '[t]' });
  const { state } = await store.auth();
  await state.keys.set({ session: { '972500000001.0': { a: 1 }, '972500000001.7': { a: 2 }, '123456_1.0': { a: 3 }, '972500000002.0': { a: 4 }, '9725000000010.0': { a: 5 } }, 'pre-key': { '972500000001.0': { b: 1 } } });
  assert.equal(store.forgetSessions(['972500000001', '123456_1']), 3);
  const left = await state.keys.get('session', ['972500000001.0', '972500000001.7', '123456_1.0', '972500000002.0', '9725000000010.0']);
  assert.deepEqual(Object.entries(left).filter(([, v]) => v).map(([k]) => k), ['972500000002.0', '9725000000010.0'], 'a longer number that starts the same is not touched');
  assert.deepEqual(await state.keys.get('pre-key', ['972500000001.0']), { '972500000001.0': { b: 1 } }, 'only sessions');
  assert.equal(store.forgetSessions(['972500000001']), 0);
  store.close();
});
