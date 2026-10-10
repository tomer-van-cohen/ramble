// node --test test/research.test.mjs — the opt-in "keep recordings" store.
// Synthetic audio bytes and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-research-'));
process.env.RESEARCH_KEEP_DAYS = '30';
process.env.RESEARCH_MAX_MB = '1';
const research = await import('../src/research.js');
const { Tenant } = await import('../src/tenant.js');

const scratch = mkdtempSync(join(tmpdir(), 'readable-media-'));
const fakeRecording = (name, bytes = 1000) => {
  const p = join(scratch, name);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
};

test('opting in is off by default and persists when set', () => {
  const dir = join(process.env.DATA_DIR, 'tenants', 'a1');
  mkdirSync(dir, { recursive: true });
  const t = new Tenant({ id: 'a1', createdAt: Date.now() }, dir);
  assert.equal(t.keepAudio, false, 'nobody is opted in unless they asked');
  assert.equal(t.setKeepAudio(true), true);
  const rec = JSON.parse(readFileSync(join(dir, 'tenant.json'), 'utf8'));
  assert.equal(rec.keepAudio, true);
  assert.equal(new Tenant(rec, dir).keepAudio, true);
  assert.equal(new Tenant({ ...rec, keepAudio: 'yes' }, dir).keepAudio, false, 'only a real true counts');
});

test('a kept recording moves out of the media folder and gets a sidecar with the text', () => {
  const src = fakeRecording('note1.ogg');
  const item = research.archive({ accountId: 'a1', mediaPath: src, meta: { seconds: 7, text: 'what was said', rewritten: 'What was said.', summary: null, model: 'model-x' } });
  assert.ok(item, 'archived');
  assert.equal(existsSync(src), false, 'the original is gone from the media folder');
  const items = research.list('a1');
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'what was said');
  assert.equal(items[0].model, 'model-x');
  assert.equal(items[0].bytes, 1000);
  assert.ok(research.audioPath('a1', items[0].item), 'the audio is retrievable');
});

test('accounts are kept apart and a crafted item name cannot escape the folder', () => {
  research.archive({ accountId: 'a2', mediaPath: fakeRecording('other.ogg'), meta: { seconds: 3 } });
  assert.equal(research.list('a2').length, 1);
  assert.equal(research.list('a1').length, 1, 'one account cannot see another\'s');
  assert.equal(research.audioPath('a1', '../a2/whatever'), null);
  assert.equal(research.audioPath('a1', '/etc/passwd'), null);
  assert.equal(research.audioPath('nobody', 'x'), null);
});

test('archiving never throws when the recording is already gone', () => {
  assert.equal(research.archive({ accountId: 'a1', mediaPath: join(scratch, 'missing.ogg'), meta: {} }), null);
  assert.equal(research.archive({ accountId: 'a1', mediaPath: null, meta: {} }), null);
});

test('the sweep drops what is too old', () => {
  const item = research.archive({ accountId: 'a3', mediaPath: fakeRecording('old.ogg'), meta: { seconds: 5 } });
  const dir = join(process.env.DATA_DIR, 'research', 'a3');
  const old = Date.now() / 1000 - 60 * 86400; // 60 days ago
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), old, old);
  const { removed } = research.sweep();
  assert.ok(removed >= 2, `audio + sidecar removed (${removed})`);
  assert.equal(research.audioPath('a3', item), null);
});

test('the sweep enforces the total size ceiling, oldest first', () => {
  // 1 MB ceiling; three 400 KB recordings cannot all stay.
  for (const [i, name] of ['s1.ogg', 's2.ogg', 's3.ogg'].entries()) {
    research.archive({ accountId: 'a4', mediaPath: fakeRecording(name, 400_000), meta: { seconds: 10, n: i } });
  }
  const before = research.usage().bytes;
  assert.ok(before > 1e6, `over the ceiling before the sweep (${before})`);
  research.sweep();
  assert.ok(research.usage().bytes <= 1e6, `within the ceiling after the sweep (${research.usage().bytes})`);
});
