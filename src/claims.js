/**
 * One recording, one text — even when both sides of a chat use this server.
 *
 * A voice note reaches the sender's account and the recipient's account (and, in
 * a group, every member's) under the same WhatsApp message id. Left alone, each
 * would post its own text under it. So an account takes a recording before it
 * works on it, and the others wait for the outcome: a posted text means there is
 * nothing left to do; a release (chat off, over the daily limit, a failure)
 * hands the recording to whoever is waiting.
 *
 * Memory only: message ids and account ids, no content, gone after a few minutes.
 */
const TTL_MS = 10 * 60e3;
const CAP = 5000;
const claims = new Map(); // key -> { owner, state: 'working'|'posted'|'released', at, waiters: [] }
// The WhatsApp ids (phone and lid) of every account connected here: a recording from one of
// them may be taken by its sender's account, so only then do the others hold back for it.
const linked = new Map(); // jid -> account id

/** An account is connected under these ids (and no other). */
export function link(owner, jids) {
  unlink(owner);
  for (const j of jids) if (j) linked.set(j, owner);
}
/** The account is gone or disconnected. */
export function unlink(owner) { for (const [j, o] of linked) if (o === owner) linked.delete(j); }
/** True when any of these ids belongs to an account on this server other than `except`. */
export const isLinked = (jids, except = null) => jids.some((j) => j && linked.has(j) && linked.get(j) !== except);

const prune = () => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, c] of claims) { if (c.at > cutoff) break; claims.delete(k); } // insertion order is age
  while (claims.size > CAP) claims.delete(claims.keys().next().value);
};

/** Who is on it, if anyone: { owner, state } or null. */
export const holder = (key) => { const c = claims.get(key); return c && Date.now() - c.at < TTL_MS ? { owner: c.owner, state: c.state } : null; };

/**
 * Take the recording. True if it is now ours: nobody had it, we had it, or whoever had it let go.
 * force: the owner has been silent for too long; take it from them.
 */
export function take(key, owner, { force = false } = {}) {
  prune();
  const c = claims.get(key);
  if (c && !force && c.owner !== owner && c.state !== 'released' && Date.now() - c.at < TTL_MS) return false;
  claims.delete(key); // re-inserted at the young end
  claims.set(key, { owner, state: 'working', at: Date.now(), waiters: c?.waiters || [] });
  return true;
}

/** The owner is done: a text was posted, or it lets go so that another account can do it. */
export function settle(key, owner, posted) {
  const c = claims.get(key);
  if (!c || c.owner !== owner || c.state !== 'working') return;
  c.state = posted ? 'posted' : 'released';
  for (const w of c.waiters.splice(0)) w(c.state);
}

/** How the current owner's work ends: 'posted', 'released', or 'timeout'. */
export function outcome(key, timeoutMs) {
  const c = claims.get(key);
  if (!c || c.state !== 'working') return Promise.resolve(c?.state === 'posted' ? 'posted' : 'released');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { c.waiters = c.waiters.filter((w) => w !== done); resolve('timeout'); }, timeoutMs);
    timer.unref?.();
    const done = (state) => { clearTimeout(timer); resolve(state); };
    c.waiters.push(done);
  });
}

export const _reset = () => claims.clear(); // tests
