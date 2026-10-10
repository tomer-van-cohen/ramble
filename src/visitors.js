/**
 * One person per browser, for the admin page's funnel: an anonymous cookie (a random id)
 * and, per id, when it was first and last seen, how many pages it opened, a device label
 * and the referring site from its first visit, whether it ran the page's script (a real
 * browser, not a crawler or a link preview), and when it signed up and linked.
 * No address, no agent string, nothing else. Kept in DATA_DIR/visitors.json, pruned
 * after VISITOR_KEEP_DAYS and capped in size.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dataPath } from './paths.js';

const FILE = dataPath('visitors.json');
const KEEP_DAYS = Number(process.env.VISITOR_KEEP_DAYS ?? 180);
const MAX = 20000;
export const VISITOR_RE = /^[0-9a-f]{20}$/;

let all = new Map();
try { all = new Map(JSON.parse(readFileSync(FILE, 'utf8'))); } catch { /* none yet */ }
let timer = null;
const save = () => {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    for (const [id, v] of all) if (v.last < cutoff) all.delete(id);
    while (all.size > MAX) all.delete(all.keys().next().value);
    try { writeFileSync(FILE, JSON.stringify([...all]), { mode: 0o600 }); } catch (e) { console.warn('visitors save failed:', e.message); }
  }, 2000);
  timer.unref?.();
};

export const newVisitorId = () => randomBytes(10).toString('hex');

/** A page view by this browser; the first one also notes its device label and where it came from. */
export function visit(id, { device = '', from = '' } = {}) {
  if (!VISITOR_RE.test(String(id || ''))) return null;
  const now = Date.now();
  const v = all.get(id) || { first: now, last: now, visits: 0, accounts: [], device, from };
  v.visits++; v.last = now;
  all.delete(id); all.set(id, v); // most recent last, so the cap drops the stalest
  save();
  return v;
}

const mark = (id, fn) => { const v = all.get(id); if (v) { fn(v); save(); } };
/** The page's script ran: a real browser. */
export const confirm = (id) => mark(id, (v) => { v.human = true; });
/** It clicked through to sign up. */
export const addAccount = (id, accountId) => mark(id, (v) => {
  if (!v.accounts.includes(accountId)) v.accounts = [...v.accounts, accountId].slice(-20);
  v.signedAt ||= Date.now();
});
/** One of its sign-ups finished linking WhatsApp. */
export const markLinked = (id) => mark(id, (v) => { v.linkedAt ||= Date.now(); });
/** The operator's own browser (it opened /admin): left out of the funnel. */
export const markStaff = (id) => mark(id, (v) => { v.staff = true; });
export const list = () => [...all.entries()];

export const get = (id) => all.get(id) || null;
