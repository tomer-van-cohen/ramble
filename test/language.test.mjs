// node --test test/language.test.mjs — language preselect; no auto-lock (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-lang-'));
const { Tenant } = await import('../src/tenant.js');

test('an account on auto stays on auto: the model detects the language of every recording', () => {
  const t = new Tenant({ id: 'x', createdAt: Date.now() }, join(process.env.DATA_DIR, 'x'));
  assert.equal(t.language, '');
  assert.equal(typeof t.learnLanguage, 'undefined');
});

test('an explicit choice is kept', () => {
  const t = new Tenant({ id: 'z', language: 'en', createdAt: Date.now() }, join(process.env.DATA_DIR, 'z'));
  assert.equal(t.language, 'en');
  t.setLanguage('');
  assert.equal(t.language, '');
});
