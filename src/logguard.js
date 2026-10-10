/**
 * The Signal library under Baileys writes to the console directly, bypassing the
 * silenced Baileys logger, and some of its lines carry a whole session object:
 * private keys, root and chain keys. Those must never reach a log.
 *
 * This wraps the console once: a line from that library keeps at most its own
 * text (and only where the text helps diagnose a decrypt failure); any argument
 * that looks like session key material is replaced, whoever logs it.
 */
const LIBSIGNAL = /^(Closing session:|Opening session:|Removing old closed session:|Session already (closed|open)|Closing open session in favor|Closing stale open session|Migrating session to:|Unhandled bucket type|V1 session storage migration|WARNING: Expected pubkey|Decrypted message with closed session|Failed to decrypt message|Session error:)/;
// Worth keeping as a bare line: they explain a message that could not be read.
const KEEP_TEXT = /^(Closing open session in favor|Failed to decrypt message|Decrypted message with closed session|Session error:)/;
const KEY_FIELDS = ['privKey', 'rootKey', 'chainKey', 'ephemeralKeyPair', 'baseKey', 'indexInfo', '_chains', 'currentRatchet'];

/** True for a value that is, or directly holds, Signal session key material. Exported for tests. */
export function looksLikeKeys(v) {
  if (!v || typeof v !== 'object') return false;
  const name = v.constructor?.name;
  if (name === 'SessionEntry' || name === 'SessionRecord') return true;
  return KEY_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(v, k));
}

/**
 * What a console call may print. null = nothing. Pure, exported for tests.
 * @param {unknown[]} args
 */
export function screen(args) {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (LIBSIGNAL.test(first)) return KEEP_TEXT.test(first) ? [first.split('\n')[0].slice(0, 200)] : null;
  return args.some(looksLikeKeys) ? args.map((a) => (looksLikeKeys(a) ? '[session keys withheld]' : a)) : args;
}

const GUARDED = Symbol.for('ramble.logguard');
if (!console[GUARDED]) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { const out = screen(args); if (out) original(...out); };
  }
  console[GUARDED] = true;
}
