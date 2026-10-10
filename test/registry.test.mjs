// node --test test/registry.test.mjs — legacy migration + account records (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'readable-'));
process.env.DATA_DIR = root;
process.env.OWNER_NAME = 'Tomer';
process.env.TRANSCRIBE_LANGUAGE = 'he';
// A pre-multi-tenant layout: session + settings directly in DATA_DIR.
mkdirSync(join(root, 'baileys_auth'));
writeFileSync(join(root, 'baileys_auth', 'creds.json'), '{}');
writeFileSync(join(root, 'target.json'), JSON.stringify({ jid: '1@g.us', name: 'תמלול' }));
writeFileSync(join(root, 'enabled.json'), JSON.stringify(['2@g.us']));

const registry = await import('../src/registry.js');

test('legacy single-account data is moved into tenants/default with session and settings intact', () => {
  assert.equal(registry.migrateLegacy(), true);
  assert.ok(existsSync(join(root, 'tenants', 'default', 'baileys_auth', 'creds.json')));
  assert.ok(!existsSync(join(root, 'baileys_auth')));
  const rec = JSON.parse(readFileSync(join(root, 'tenants', 'default', 'tenant.json'), 'utf8'));
  assert.equal(rec.id, 'default'); assert.equal(rec.label, 'Tomer'); assert.equal(rec.language, 'he');
  assert.equal(rec.manageKey, undefined, 'no master key: browsers have sessions of their own');
  assert.equal(registry.migrateLegacy(), false, 'runs once');
});

test('loadAll restores the migrated account with its control group and enabled groups', () => {
  const ts = registry.loadAll();
  assert.equal(ts.length, 1);
  assert.equal(ts[0].target.name, 'תמלול');
  assert.ok(ts[0].enabled.has('2@g.us'));
  assert.equal(ts[0].status().controlGroup, 'תמלול');
});

test('status never includes message content or the QR unless asked', () => {
  const s = registry.list()[0].status();
  assert.ok(!('qr' in s));
  assert.deepEqual(Object.keys(s).sort(), ['abModel', 'bonusMinutes', 'capMinutes', 'controlGroup', 'createdAt', 'dailyMinutes', 'enabledGroups', 'groups', 'id', 'inviteCode', 'invited', 'keepAudio', 'label', 'language', 'lastError', 'lastMessageAt', 'linkedAt', 'minutesToday', 'mode', 'model', 'mutedChats', 'needsManualGroup', 'paused', 'plan', 'privateChats', 'ready', 'stats', 'transcribeVideo', 'voiceFix'].sort());
});

test('a sign-up that never linked is expired; a linked account is not', async () => {
  const stale = registry.create({ language: 'en', start: false }); // no WhatsApp socket in tests
  stale.createdAt = Date.now() - 60 * 60e3;               // an hour ago, never scanned
  const migrated = registry.get('default');
  migrated.createdAt = Date.now() - 60 * 60e3; migrated.linkedAt = Date.now() - 30 * 60e3;
  await registry.expireUnlinked();
  assert.equal(registry.get(stale.id), null);
  assert.ok(registry.get('default'));
});
