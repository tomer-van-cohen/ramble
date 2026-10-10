// node --test test/sessions.test.mjs — the session events the library logs become one tagged line each,
// saying whose by address kind and device only, never a number. Invented ids; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-sessions-'));
const { sessionLine } = await import('../src/wa.js');
const me = { pn: '972500000001', lid: '123456789' };

test('a retry request from the owner\'s own phone, and from a contact\'s device, say who without the number', () => {
  const line = sessionLine('recv retry request', { attrs: { count: '2' }, key: { remoteJid: '972500000001@s.whatsapp.net', participant: '972500000001:0@s.whatsapp.net' } }, me);
  assert.equal(line, '🔐 recv retry request · own-phone:0 · count=2');
  assert.equal(sessionLine('prepared session for retry resend', { participant: '123456789:4@lid', sendToAll: false, shouldRecreateSession: true, recreateReason: 'MAC error', injectedFromBundle: false }, me),
    '🔐 prepared session for retry resend · own-device:4 · recreateReason=MAC error sendToAll=false shouldRecreateSession=true injectedFromBundle=false');
  assert.equal(sessionLine('sent retry receipt', { msgAttrs: { from: '972500000002@s.whatsapp.net', participant: '972500000002:3@s.whatsapp.net' }, retryCount: 1 }, me), '🔐 sent retry receipt · pn:3 · retryCount=1');
  assert.equal(sessionLine('failed to decrypt message', { key: { remoteJid: '555@g.us', participant: '777@lid' }, sender: '777@lid', err: new Error('Bad MAC\nstack'), messageType: 'msmsg', isSessionRecordError: false }, me), '🔐 failed to decrypt message · lid:0 · isSessionRecordError=false messageType=msmsg · Bad MAC');
});

test('no id of any kind leaks into the line', () => {
  const line = sessionLine('reg id mismatch on retry without bundle, deleting session', { participant: '972500000001:0@s.whatsapp.net', stored: 1234, received: 5678 }, me);
  assert.doesNotMatch(line, /9725|123456789|@/);
  assert.match(line, /own-phone:0 · stored=1234 received=5678/);
});

test('an id written into the message text itself is dropped from the line', () => {
  assert.equal(sessionLine('Added message to retry cache: 555000@lid/3A9E38E6', {}, me), '🔐 Added message to retry cache: …');
  assert.equal(sessionLine('recreating session for retry', { participant: '777:2@s.whatsapp.net', retryCount: 2 }, me), '🔐 recreating session for retry · pn:2 · retryCount=2');
});

test('the phone\'s own retry request shows its count and error code', () => {
  assert.equal(sessionLine('recv retry request', { attrs: { count: '2', error: '0', id: 'X' }, key: { remoteJid: '972500000001@s.whatsapp.net', participant: '972500000001:0@s.whatsapp.net' } }, me), '🔐 recv retry request · own-phone:0 · count=2 error=0');
});

test('a reset is due after two resend requests from the own phone within ten minutes, and then not again for an hour', async () => {
  const { ownPhoneRepairDue, OWN_PHONE_RETRY_WINDOW_MS, OWN_PHONE_RESET_GAP_MS } = await import('../src/wa.js');
  const now = 1_000_000_000_000;
  assert.equal(ownPhoneRepairDue([now - 1000], 0, now), false, 'one request is not enough');
  assert.equal(ownPhoneRepairDue([now - 5 * 60e3, now], 0, now), true);
  assert.equal(ownPhoneRepairDue([now - OWN_PHONE_RETRY_WINDOW_MS - 1, now], 0, now), false, 'the first one is too old');
  assert.equal(ownPhoneRepairDue([now - 1000, now], now - OWN_PHONE_RESET_GAP_MS + 1, now), false, 'reset too recently');
  assert.equal(ownPhoneRepairDue([now - 1000, now], now - OWN_PHONE_RESET_GAP_MS, now), true);
});

test('a group message that could not be read names its author, not the group', () => {
  const line = sessionLine('failed to decrypt message', { key: { remoteJid: '555@g.us', participant: '777:5@lid' }, sender: '555@g.us', author: '777:5@lid', err: new Error('No session found to decrypt message'), messageType: 'skmsg' }, me);
  assert.equal(line, '🔐 failed to decrypt message · lid:5 · messageType=skmsg · No session found to decrypt message');
});

test('a message that could not be read carries its media type', () => {
  assert.equal(sessionLine('failed to decrypt message', { key: { remoteJid: '555@g.us', participant: '777@lid' }, author: '777@lid', err: new Error('No session found to decrypt message'), messageType: 'skmsg', mediatype: 'ptt' }, me),
    '🔐 failed to decrypt message · lid:0 · messageType=skmsg mediatype=ptt · No session found to decrypt message');
});
