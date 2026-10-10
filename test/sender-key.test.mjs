// node --test test/sender-key.test.mjs — a group sender whose key came under their phone number, and whose
// messages then arrive under their LID, is still readable (scripts/patch-deps.mjs). Invented ids; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { useMultiFileAuthState, addTransactionCapability } from '@whiskeysockets/baileys';
import { makeLibSignalRepository } from '@whiskeysockets/baileys/lib/Signal/libsignal.js';

const GROUP = '120363000000000001@g.us';
const SENDER_PN = '972500000009@s.whatsapp.net', SENDER_LID = '210000000000009@lid';
const silent = pino({ level: 'silent' });

async function repo(name) {
  const { state } = await useMultiFileAuthState(mkdtempSync(join(tmpdir(), `ramble-sk-${name}-`)));
  const keys = addTransactionCapability(state.keys, silent, { maxCommitRetries: 1, delayBetweenTriesMs: 1 });
  return makeLibSignalRepository({ creds: state.creds, keys }, silent);
}

async function setup({ mapping }) {
  const sender = await repo('sender'), me = await repo('me');
  const { ciphertext, senderKeyDistributionMessage } = await sender.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('first') });
  // The key arrives while the group names the sender by phone number…
  await me.processSenderKeyDistributionMessage({ authorJid: SENDER_PN, item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage } });
  assert.equal(Buffer.from(await me.decryptGroupMessage({ group: GROUP, authorJid: SENDER_PN, msg: ciphertext })).toString(), 'first');
  if (mapping) await me.lidMapping.storeLIDPNMappings([{ lid: SENDER_LID, pn: SENDER_PN }]);
  const next = await sender.encryptGroupMessage({ group: GROUP, meId: SENDER_PN, data: Buffer.from('second') });
  return { me, next };
}

test('…and the next message names them by LID: read with the key kept under the phone number', async () => {
  const { me, next } = await setup({ mapping: true });
  const out = await me.decryptGroupMessage({ group: GROUP, authorJid: SENDER_LID, msg: next.ciphertext });
  assert.equal(Buffer.from(out).toString(), 'second');
});

test('without a known mapping between the two, nothing changes: the message is still unreadable', async () => {
  const { me, next } = await setup({ mapping: false });
  await assert.rejects(me.decryptGroupMessage({ group: GROUP, authorJid: SENDER_LID, msg: next.ciphertext }), /No session|No sender key|No SenderKeyRecord/i);
});

test('another person\'s LID never borrows this sender\'s key', async () => {
  const { me, next } = await setup({ mapping: true });
  await me.lidMapping.storeLIDPNMappings([{ lid: '210000000000077@lid', pn: '972500000077@s.whatsapp.net' }]);
  await assert.rejects(me.decryptGroupMessage({ group: GROUP, authorJid: '210000000000077@lid', msg: next.ciphertext }));
});
