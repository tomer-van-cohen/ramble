/**
 * What the server did with each recording, as numbers: a ledger for the admin's usage page.
 *
 * One line per recording that reached an account, appended to DATA_DIR/usage/rec-<day>.jsonl:
 * when, which account (its id), how long, voice or video, the owner's own or someone else's,
 * what became of it (delivered, dropped by the sanity gate, failed, over the daily cap, skipped),
 * where the text went and how long it all took. Never a word of what was said, never a chat
 * or a name. Days older than USAGE_KEEP_DAYS (default 90) are removed as new days are written.
 *
 * summarize() turns a span of records into the distributions the page draws: recording
 * lengths in 10-second steps, activity by hour of day (in STATS_TZ), accounts by how much
 * they transcribed, outcomes and speed. Pure, so the tests can feed it invented records.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from './paths.js';

export const USAGE_KEEP_DAYS = Math.max(1, Number(process.env.USAGE_KEEP_DAYS ?? 90) || 90);
/** The time zone the admin's hour-of-day charts use (where the users are, not where the server is). */
export const STATS_TZ = process.env.STATS_TZ || 'Asia/Jerusalem';
export const OUTCOMES = ['delivered', 'dropped', 'failed', 'cap', 'skipped'];

const dir = () => dataPath('usage');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const FILE_RE = /^rec-(\d{4}-\d{2}-\d{2})\.jsonl$/;
let lastSweep = '';

/**
 * Append one record (numbers and short tokens only). Never throws: bookkeeping is never a
 * reason to fail a delivery. Sweeps the old days once per day.
 */
export function record(entry) {
  try {
    const at = entry.at || Date.now();
    mkdirSync(dir(), { recursive: true });
    appendFileSync(join(dir(), `rec-${day(at)}.jsonl`), JSON.stringify({ at, ...entry }) + '\n');
    if (lastSweep !== day(at)) { lastSweep = day(at); sweep(); }
  } catch (e) { console.warn(`usage record failed: ${e.message}`); }
}

/** Drop the day files older than USAGE_KEEP_DAYS. Returns how many were removed. */
export function sweep(now = Date.now()) {
  if (!existsSync(dir())) return 0;
  const cutoff = day(now - USAGE_KEEP_DAYS * 86400e3);
  let removed = 0;
  for (const f of readdirSync(dir())) {
    const m = FILE_RE.exec(f);
    if (m && m[1] < cutoff) { try { unlinkSync(join(dir(), f)); removed++; } catch { /* gone */ } }
  }
  return removed;
}

/** Every record of the last `days` days (today included), oldest first. */
export function readRecords({ days = 7, now = Date.now() } = {}) {
  if (!existsSync(dir())) return [];
  const cutoff = day(now - (days - 1) * 86400e3);
  const out = [];
  for (const f of readdirSync(dir()).filter((f) => FILE_RE.test(f)).sort()) {
    if (f.slice(4, 14) < cutoff) continue;
    for (const line of readFileSync(join(dir(), f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
    }
  }
  return out;
}

const hourFmt = new Map();
/** The hour of day (0–23) of a timestamp in the stats time zone. */
export function hourIn(ms, tz = STATS_TZ) {
  if (!hourFmt.has(tz)) {
    try { hourFmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })); } catch { hourFmt.set(tz, null); }
  }
  const f = hourFmt.get(tz);
  return f ? Number(f.format(new Date(ms))) % 24 : new Date(ms).getUTCHours();
}
const dayFmt = new Map();
/** The calendar day (YYYY-MM-DD) of a timestamp in the stats time zone. */
export function dayIn(ms, tz = STATS_TZ) {
  if (!dayFmt.has(tz)) {
    try { dayFmt.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })); } catch { dayFmt.set(tz, null); }
  }
  const f = dayFmt.get(tz);
  return f ? f.format(new Date(ms)) : day(ms);
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => { if (!xs.length) return null; const s = sorted(xs); return s[s.length >> 1]; };
const pct = (xs, p) => { if (!xs.length) return null; const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const share = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : 0);
/** Counts of values by the first edge they fall under: [{ label, n }]. */
function histogram(values, edges) {
  const counts = edges.map(() => 0);
  for (const v of values) { const i = edges.findIndex(([max]) => v < max); counts[i < 0 ? edges.length - 1 : i]++; }
  return edges.map(([, label], i) => ({ label, n: counts[i] }));
}
export const LEN_BIN = 10, LEN_BINS = 19; // 0–10 … 170–180, then everything longer
export const RECS_EDGES = [[2, '1'], [4, '2–3'], [8, '4–7'], [16, '8–15'], [32, '16–31'], [64, '32–63'], [Infinity, '64+']];
export const MIN_EDGES = [[1, '<1'], [3, '1–3'], [5, '3–5'], [10, '5–10'], [20, '10–20'], [30, '20–30'], [45, '30–45'], [Infinity, '45+']];

/**
 * The distributions for a span of records. Pure. Everything is counts, seconds and shares;
 * the per-account figures are over account ids that never leave this function.
 */
export function summarize(records, { tz = STATS_TZ } = {}) {
  const all = records.filter((r) => r && typeof r.at === 'number');
  const delivered = all.filter((r) => r.outcome === 'delivered');
  const outcomes = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
  const reasons = {};
  for (const r of all) {
    outcomes[OUTCOMES.includes(r.outcome) ? r.outcome : 'skipped']++;
    if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const secs = delivered.map((r) => r.sec || 0);
  const bins = Array.from({ length: LEN_BINS }, (_, i) => ({ lo: i * LEN_BIN, n: 0, seconds: 0 }));
  for (const r of delivered) { const b = bins[Math.min(LEN_BINS - 1, Math.floor((r.sec || 0) / LEN_BIN))]; b.n++; b.seconds += r.sec || 0; }
  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of delivered) hours[hourIn(r.at, tz)]++;
  const days = new Map();
  for (const r of delivered) {
    const d = dayIn(r.at, tz);
    if (!days.has(d)) days.set(d, { day: d, n: 0, seconds: 0, accounts: new Set() });
    const x = days.get(d); x.n++; x.seconds += r.sec || 0; x.accounts.add(r.acct);
  }
  const dayRows = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((x) => ({ day: x.day, n: x.n, minutes: Math.round(x.seconds / 60), accounts: x.accounts.size }));
  const perAcct = new Map();
  for (const r of delivered) {
    if (!perAcct.has(r.acct)) perAcct.set(r.acct, { n: 0, seconds: 0, days: new Set() });
    const a = perAcct.get(r.acct); a.n++; a.seconds += r.sec || 0; a.days.add(dayIn(r.at, tz));
  }
  const acctRows = [...perAcct.values()];
  const minutesSorted = acctRows.map((a) => a.seconds / 60).sort((a, b) => b - a);
  const minutesTotal = minutesSorted.reduce((a, b) => a + b, 0);
  const deciles = Array.from({ length: 10 }, (_, i) => share(minutesSorted.slice(Math.floor((i * minutesSorted.length) / 10), Math.floor(((i + 1) * minutesSorted.length) / 10)).reduce((a, b) => a + b, 0), minutesTotal));
  const totals = delivered.filter((r) => typeof r.total === 'number').map((r) => r.total);
  const where = { chat: 0, me: 0, control: 0 };
  for (const r of delivered) if (r.where in where) where[r.where]++;
  const latencyByLen = [[15, '≤15s'], [30, '16–30s'], [60, '31–60s'], [120, '61–120s'], [Infinity, '>120s']].map(([max, label], i, arr) => {
    const min = i ? arr[i - 1][0] : 0;
    const xs = delivered.filter((r) => typeof r.total === 'number' && (r.sec || 0) > min && (r.sec || 0) <= max).map((r) => r.total);
    return { label, n: xs.length, median: median(xs), p90: pct(xs, 0.9) };
  });
  const capAccounts = new Set(all.filter((r) => r.outcome === 'cap').map((r) => r.acct));
  return {
    records: all.length, delivered: delivered.length, outcomes, reasons,
    deliveredShare: share(delivered.length, all.length - outcomes.cap - outcomes.skipped),
    length: secs.length ? { median: median(secs), mean: Math.round((secs.reduce((a, b) => a + b, 0) / secs.length) * 10) / 10, p90: pct(secs, 0.9), max: Math.max(...secs), under10: share(secs.filter((s) => s < 10).length, secs.length), under30: share(secs.filter((s) => s < 30).length, secs.length), over60: share(secs.filter((s) => s >= 60).length, secs.length), over120: share(secs.filter((s) => s >= 120).length, secs.length), minutes: Math.round(secs.reduce((a, b) => a + b, 0) / 60) } : null,
    bins: bins.map((b) => ({ lo: b.lo, n: b.n, minutes: Math.round(b.seconds / 60) })),
    hours, days: dayRows,
    mix: { own: share(delivered.filter((r) => r.own).length, delivered.length), video: share(delivered.filter((r) => r.video).length, delivered.length), where },
    accounts: {
      active: acctRows.length,
      returning: acctRows.filter((a) => a.days.size > 1).length,
      recsMedian: median(acctRows.map((a) => a.n)), recsP90: pct(acctRows.map((a) => a.n), 0.9), recsMax: acctRows.length ? Math.max(...acctRows.map((a) => a.n)) : null,
      minMedian: acctRows.length ? Math.round(median(acctRows.map((a) => a.seconds / 60)) * 10) / 10 : null, minP90: acctRows.length ? Math.round(pct(acctRows.map((a) => a.seconds / 60), 0.9) * 10) / 10 : null,
      byRecs: histogram(acctRows.map((a) => a.n), RECS_EDGES), byMinutes: histogram(acctRows.map((a) => a.seconds / 60), MIN_EDGES), minutesByDecile: deciles,
      capHit: capAccounts.size,
    },
    latency: totals.length ? { median: median(totals), p90: pct(totals, 0.9), under10: share(totals.filter((t) => t <= 10).length, totals.length), under30: share(totals.filter((t) => t <= 30).length, totals.length), over120: share(totals.filter((t) => t > 120).length, totals.length), byLength: latencyByLen } : null,
  };
}
