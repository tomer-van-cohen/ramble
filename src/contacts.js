/**
 * Matching a spoken name against the account's contacts, for a dictated message. Pure:
 * the result is a SUGGESTION for the owner to confirm, never a licence to send. The
 * contact list never goes to a model: the model names the person, this finds them.
 */
export const norm = (s) => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '')          // niqqud and cantillation
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')        // punctuation, emoji, quotes
  .replace(/\s+/g, ' ').trim();

/**
 * Rank the account's contacts against a spoken name (and its spellings in
 * other scripts). The result is a SUGGESTION for the owner to confirm, never a
 * licence to send.
 *
 *   contacts: Map<jid, name>     activity: Map<jid, n> — how many messages the
 *   owner has sent that chat since we started counting (metadata, no content)
 *
 * How well the NAME fits comes first, always: 3 = the whole name ("Eden" →
 * "Eden 🌻"), 2 = the first name(s) ("Eden" → "Eden Levi"), 1 = another word
 * of it ("Eden" → "Amit Eden"). A weaker fit never outranks a better one,
 * whatever else is known about the contact. Inside a tier, the chat the owner
 * writes to most comes first. `proposed` is set only when the best tier holds
 * one person, or one the owner clearly writes to more than the rest.
 * The same person under two ids (phone + lid) counts once.
 * @returns {{ proposed: {jid,name}|null, candidates: Array<{jid,name,score}> }}
 */
export function matchContacts(spoken, contacts, { activity = new Map(), max = 6 } = {}) {
  const none = { proposed: null, candidates: [] };
  const queries = new Set();
  for (const v of Array.isArray(spoken) ? spoken : [spoken]) {
    const q = norm(v); if (!q) continue;
    queries.add(q);
    if (q.length > 2 && q.startsWith('ל')) queries.add(`\u0000${q.slice(1)}`); // a leftover Hebrew "to": tried, but ranked below
  }
  if (!queries.size || !contacts?.size) return none;
  const hits = [];
  for (const [jid, name] of contacts) {
    const n = norm(name); if (!n) continue;
    const t = n.split(' ');
    let score = 0;
    for (const raw of queries) {
      const weak = raw.startsWith('\u0000'); const q = weak ? raw.slice(1) : raw; const qt = q.split(' ');
      let sc = 0;
      if (n === q) sc = 3;
      else if (qt.length <= t.length && qt.every((w, i) => t[i] === w)) sc = 2;
      else if (qt.length === 1 && t.includes(q)) sc = 1;
      if (weak && sc) sc -= 0.5;
      score = Math.max(score, sc);
    }
    if (score > 0) hits.push({ jid, name: String(name).trim(), key: n, score, n: Number(activity.get(jid)) || 0 });
  }
  if (!hits.length) return none;
  // One entry per distinct name: its best score, the activity of all its ids, a phone-number id preferred.
  const byName = new Map();
  for (const h of hits) {
    const cur = byName.get(h.key);
    if (!cur) { byName.set(h.key, { ...h }); continue; }
    cur.n += h.n; cur.score = Math.max(cur.score, h.score);
    if (!cur.jid.endsWith('@s.whatsapp.net') && h.jid.endsWith('@s.whatsapp.net')) cur.jid = h.jid;
  }
  const ranked = [...byName.values()].sort((a, b) => b.score - a.score || b.n - a.n || a.name.length - b.name.length);
  const best = ranked.filter((h) => h.score === ranked[0].score);
  const clear = best.length === 1 || (best[0].n >= 3 && best[0].n >= 2 * best[1].n);
  const strip = ({ jid, name, score }) => ({ jid, name, score });
  return { proposed: clear ? strip(best[0]) : null, candidates: ranked.slice(0, max).map(strip) };
}
