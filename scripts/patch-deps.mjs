#!/usr/bin/env node
/**
 * Five places inside the WhatsApp libraries are changed after `npm install`.
 *
 * Two caches: each connection keeps a cache of phone-number-to-id mappings, and one of
 * migrated sessions, with no size limit and a three-day expiry that is enforced by a
 * separate timer per entry. On a server with hundreds of accounts those timers were most
 * of the live memory: about a gigabyte an hour, growing until the process ran out. The
 * library has no option for it, so the two constructions are rewritten here to a bounded
 * cache without timers (stale entries are dropped when they are next touched or pushed out).
 *
 * Sender keys: WhatsApp now names people by LID as well as by phone number. A sender key that
 * arrived while a group addressed its members by phone number was stored under that name, and
 * the same person's messages that then arrive under their LID found nothing: hundreds of group
 * messages an hour that could not be read, each one asking the owner's phone for a resend. The
 * lookup now tries the phone-number name too, from the local mapping, when the LID name misses.
 *
 * Missed recordings: a message that could not be read is logged with its media type, which
 * WhatsApp puts on the encrypted node, so a voice note that was missed can be counted.
 *
 * Signatures: every message in a group carries a signature, and the Signal library checks
 * it in pure JavaScript, 5 ms each; with hundreds of accounts that was half the processor.
 * Baileys ships a Rust/WebAssembly bridge with the same algorithm (XEdDSA) at 0.1 ms, and
 * already loads it for other work. The Signal library's sign and verify are pointed at it,
 * with the pure-JS code kept as the fallback. test/fast-signatures.test.mjs checks the two
 * agree, both ways, and that forgeries are refused.
 *
 * Run after every install (the Dockerfile does; locally: `node scripts/patch-deps.mjs`).
 * Idempotent. Fails loudly when a library's code no longer matches, or when the fast
 * signatures do not actually load, so an upgrade cannot silently lose a patch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
const SIGNAL = join('@whiskeysockets', 'baileys', 'lib', 'Signal');
const CURVE = join('libsignal', 'src', 'curve.js');
const MAX = 2_000; // entries per connection (the cache preallocates this many slots: keep it small, a socket is made every few seconds)
const PATCHES = [
  { file: join(SIGNAL, 'lid-mapping.js'), from: '            ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n            ttlAutopurge: true,\n            updateAgeOnGet: true\n', to: `            ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n            max: ${MAX}, // ramble: bounded, no timer per entry (scripts/patch-deps.mjs)\n            ttlAutopurge: false,\n            updateAgeOnGet: true\n` },
  { file: join(SIGNAL, 'libsignal.js'), from: '        ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n        ttlAutopurge: true,\n        updateAgeOnGet: true\n', to: `        ttl: 3 * 24 * 60 * 60 * 1000, // 7 days\n        max: ${MAX}, // ramble: bounded, no timer per entry (scripts/patch-deps.mjs)\n        ttlAutopurge: false,\n        updateAgeOnGet: true\n` },
  // A group message from a sender seen under their LID, whose sender key came under their phone number:
  // the key is looked up under the other address too, before the message counts as unreadable.
  { file: join(SIGNAL, 'libsignal.js'), from: '    const storage = signalStorage(auth, lidMapping);\n', to: '    const storage = signalStorage(auth, lidMapping, logger); // ramble: logger for the sender-key fallback (scripts/patch-deps.mjs)\n' },
  { file: join(SIGNAL, 'libsignal.js'), from: 'function signalStorage({ creds, keys }, lidMapping) {\n', to: `// ramble (scripts/patch-deps.mjs): the id this sender key would have under the phone-number form of a
// LID sender, from the local mapping only (no network), or null.
const senderKeyIdUnderPN = async (senderKeyName, lidMapping) => {
    const { id, deviceId } = senderKeyName.getSender();
    if (!lidMapping || typeof id !== 'string' || !id.endsWith('_1'))
        return null;
    const pn = await lidMapping.getPNForLID(\`\${id.slice(0, -2)}\${deviceId ? \`:\${deviceId}\` : ''}@lid\`).catch(() => null);
    return pn ? new SenderKeyName(senderKeyName.getGroupId(), jidToSignalProtocolAddress(pn)).toString() : null;
};
function signalStorage({ creds, keys }, lidMapping, logger) {
` },
  { file: join(SIGNAL, 'libsignal.js'), from: `            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return SenderKeyRecord.deserialize(key);
            }
            return new SenderKeyRecord();
        },`, to: `            const { [keyId]: key } = await keys.get('sender-key', [keyId]);
            if (key) {
                return SenderKeyRecord.deserialize(key);
            }
            // ramble (scripts/patch-deps.mjs): the same sender, under their phone-number address
            const altId = await senderKeyIdUnderPN(senderKeyName, lidMapping);
            const { [altId]: altKey } = altId ? await keys.get('sender-key', [altId]) : {};
            if (altKey) {
                logger?.info('decrypt: sender key found under the phone-number address');
                return SenderKeyRecord.deserialize(altKey);
            }
            return new SenderKeyRecord();
        },` },
  // A message that could not be read: its media type ('ptt' for a voice note), which WhatsApp puts on the
  // encrypted node, goes into the log context, so a missed recording can be counted.
  { file: join('@whiskeysockets', 'baileys', 'lib', 'Utils', 'decode-wa-message.js'), from: `                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,`, to: `                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            mediatype: attrs.mediatype, // ramble (scripts/patch-deps.mjs): count missed recordings
                            sender,` },
  // The Signal library's signatures, through the bridge (see the header). Three pieces of one file.
  { file: CURVE, from: "const curveJs = require('curve25519-js');\nconst nodeCrypto = require('crypto');\n", to: `const curveJs = require('curve25519-js');
const nodeCrypto = require('crypto');
// ramble (scripts/patch-deps.mjs): sign and verify through the Rust/WASM bridge that ships with
// Baileys: the same XEdDSA, 50x faster than curve25519-js (test/fast-signatures.test.mjs checks
// the two agree). Without the bridge, the pure-JS code below is used.
let fastCurve = null;
try {
    const bridge = require(require('path').join(__dirname, '..', '..', 'whatsapp-rust-bridge', 'dist', 'index.js'));
    if (typeof bridge.verifySignature === 'function' && typeof bridge.calculateSignature === 'function') fastCurve = bridge;
} catch (e) { /* the pure-JS code below */ }
exports.fastSignatures = !!fastCurve;
` },
  { file: CURVE, from: "    return Buffer.from(curveJs.sign(privKey, message));\n};", to: "    return Buffer.from(fastCurve ? fastCurve.calculateSignature(privKey, message) : curveJs.sign(privKey, message)); // ramble: see fastCurve\n};" },
  { file: CURVE, from: "    return isInit ? true : curveJs.verify(pubKey, msg, sig);\n};", to: "    return isInit ? true : (fastCurve ? fastCurve.verifySignature(pubKey, msg, sig) : curveJs.verify(pubKey, msg, sig)); // ramble: see fastCurve\n};" },
];
let changed = 0;
for (const p of PATCHES) {
  const path = join(root, p.file);
  const src = readFileSync(path, 'utf8');
  if (src.includes(p.to)) continue; // already applied
  if (!src.includes(p.from)) { console.error(`patch-deps: ${p.file} does not look as expected — the library changed; review scripts/patch-deps.mjs`); process.exit(1); }
  writeFileSync(path, src.replace(p.from, p.to));
  changed++;
}
// The fast signatures must really load here, or the server would run the slow path without a word.
const curve = createRequire(import.meta.url)(join(root, CURVE));
if (!curve.fastSignatures) { console.error('patch-deps: the Rust/WASM bridge did not load for signatures; the pure-JS path would be used — review scripts/patch-deps.mjs'); process.exit(1); }
console.log(`patch-deps: ${changed ? `${changed} patch(es) applied` : 'already applied'} · fast signatures ✓`);
