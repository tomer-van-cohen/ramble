/**
 * The admin's usage page (/admin/stats): who the users are and what they do, as numbers.
 *
 * Two sources. The accounts themselves (their settings, what they changed, their all-time
 * totals) are read live from the registry; the recordings (lengths, hours, outcomes, speed)
 * come from the usage ledger (usage.js). Nothing here names a person or a chat: the only
 * strings are setting values, language codes and command words.
 */
import { WHO, WHERE, SECTIONS, defaults, whereOf } from './settings.js';
import { LANGUAGES } from './tenant.js';
import { LEN_BIN, RECS_EDGES, MIN_EDGES } from './usage.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const share = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : 0);
const pc = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => { if (!xs.length) return null; const s = sorted(xs); return s[s.length >> 1]; };
const p90 = (xs) => { if (!xs.length) return null; const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; };
function histogram(values, edges) {
  const counts = edges.map(() => 0);
  for (const v of values) { const i = edges.findIndex(([max]) => v < max); counts[i < 0 ? edges.length - 1 : i]++; }
  return edges.map(([, label], i) => ({ label, n: counts[i] }));
}
const EVER_MIN_EDGES = [[1, '<1'], [3, '1–3'], [10, '3–10'], [30, '10–30'], [60, '30–60'], [120, '60–120'], [300, '120–300'], [Infinity, '300+']];
const EVER_RECS_EDGES = [[1, '0'], [10, '1–9'], [50, '10–49'], [200, '50–199'], [1000, '200–999'], [Infinity, '1000+']];
const DEFAULTS = defaults();
const langName = (code) => LANGUAGES.find(([c]) => c === code)?.[2] || code;

/**
 * How the linked accounts are set up, from their status objects (status({ history: true })).
 * Pure; the tests feed it invented accounts.
 */
export function settingsStats(accounts, { now = Date.now() } = {}) {
  const linked = accounts.filter((t) => t.linkedAt);
  const n = linked.length;
  const count = (pred) => linked.filter(pred).length;
  const section = (k) => ({
    on: count((t) => t.settings?.[k]?.on), off: count((t) => t.settings?.[k] && !t.settings[k].on),
    who: Object.fromEntries(WHO.map((w) => [w, count((t) => t.settings?.[k]?.on && t.settings[k].who === w)])),
    where: Object.fromEntries(WHERE.map((w) => [w, count((t) => t.settings?.[k]?.on && t.settings[k].where === w)])),
    picked: count((t) => t.settings?.[k]?.on && t.settings[k].picked > 0),
  });
  const isDefault = (t) => SECTIONS.every((k) => { const s = t.settings?.[k]; return s && s.on === DEFAULTS[k].on && s.who === DEFAULTS[k].who && s.where === DEFAULTS[k].where && !s.picked; });
  const combo = (t) => SECTIONS.map((k) => { const s = t.settings?.[k]; return !s ? '?' : !s.on ? `${k} off` : `${k} ${s.who}/${s.where}${s.picked ? ' (some)' : ''}`; }).join(' · ');
  const combos = new Map();
  for (const t of linked) combos.set(combo(t), (combos.get(combo(t)) || 0) + 1);
  const langs = new Map();
  for (const t of linked) if (t.language && t.language !== 'auto') langs.set(t.language, (langs.get(t.language) || 0) + 1);
  const cmds = new Map();
  for (const t of linked) for (const c of t.commands || []) if (c?.cmd) cmds.set(c.cmd, (cmds.get(c.cmd) || 0) + 1);
  const week = new Set(Array.from({ length: 6 }, (_, i) => new Date(now - (i + 1) * 864e5).toISOString().slice(0, 10)));
  const weekMinutes = (t) => (t.minutesToday || 0) + (t.usageHistory || []).filter((h) => week.has(h.day)).reduce((a, h) => a + (h.minutes || 0), 0);
  const everMinutes = (t) => ((t.totals?.ownSeconds || 0) + (t.totals?.othersSeconds || 0)) / 60;
  const everRecs = (t) => (t.totals?.own || 0) + (t.totals?.others || 0);
  const ownShare = (() => { const own = linked.reduce((a, t) => a + (t.totals?.own || 0), 0), all = linked.reduce((a, t) => a + everRecs(t), 0); return share(own, all); })();
  const u = (t) => t.settingsUse || {};
  const ages = linked.map((t) => (now - (t.linkedAt || now)) / 864e5);
  return {
    accounts: accounts.length, linked: n, connected: count((t) => t.ready), paused: count((t) => t.paused),
    chats: section('chats'), groups: section('groups'),
    where: Object.fromEntries(['chat', 'me', 'mixed'].map((w) => [w, count((t) => t.settings && whereOf({ chats: t.settings.chats, groups: t.settings.groups }) === w)])),
    defaults: count(isDefault), changedFromDefault: n - count(isDefault),
    combos: [...combos].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, c]) => ({ label, n: c, share: share(c, n) })),
    page: { visited: count((t) => u(t).visits > 0), changed: count((t) => u(t).changes > 0), visits: linked.reduce((a, t) => a + (u(t).visits || 0), 0), changes: linked.reduce((a, t) => a + (u(t).changes || 0), 0) },
    perChat: { includedGroups: count((t) => t.enabledGroups > 0), excludedChats: count((t) => t.mutedChats > 0), privateChats: count((t) => t.privateChats > 0), any: count((t) => t.enabledGroups > 0 || t.mutedChats > 0 || t.privateChats > 0) },
    language: { auto: n - [...langs.values()].reduce((a, b) => a + b, 0), pinned: [...langs].sort((a, b) => b[1] - a[1]).map(([code, c]) => ({ code, name: langName(code), n: c })) },
    video: count((t) => t.transcribeVideo), keepAudio: count((t) => t.keepAudio), plan: { pro: count((t) => t.plan === 'pro'), free: count((t) => t.plan === 'free') },
    invited: { byInvite: count((t) => t.referredBy), inviters: count((t) => t.invited > 0) },
    commands: [...cmds].sort((a, b) => b[1] - a[1]).map(([cmd, c]) => ({ cmd, n: c })),
    ever: {
      recordings: linked.reduce((a, t) => a + everRecs(t), 0), minutes: Math.round(linked.reduce((a, t) => a + everMinutes(t), 0)), ownShare,
      usedAtAll: count((t) => everRecs(t) > 0), byMinutes: histogram(linked.map(everMinutes), EVER_MIN_EDGES), byRecs: histogram(linked.map(everRecs), EVER_RECS_EDGES),
      minutesMedian: Math.round((median(linked.map(everMinutes)) || 0) * 10) / 10, recsMedian: median(linked.map(everRecs)),
    },
    week: { active: count((t) => weekMinutes(t) > 0), minutes: linked.reduce((a, t) => a + weekMinutes(t), 0), byMinutes: histogram(linked.map(weekMinutes), MIN_EDGES), minutesMedian: median(linked.filter((t) => weekMinutes(t) > 0).map(weekMinutes)) },
    age: { medianDays: Math.round((median(ages) || 0) * 10) / 10, p90Days: Math.round((p90(ages) || 0) * 10) / 10, overWeek: count((t) => now - t.linkedAt > 7 * 864e5) },
  };
}

export const STATS_CSS = `
.st{display:flex;flex-direction:column;gap:22px;padding-bottom:64px}
.st h2{font-size:26px;margin:10px 0 0}
.st .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px 18px;min-width:0}
.st .card h3{font-size:18px;margin:0 0 4px}.st .card .muted{font-size:13px;margin-bottom:10px}
.st .g2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:14px}
.st .g3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:14px}
.st .tiles{margin-bottom:0}.st .tile b{display:block}
.cols{display:block;width:100%;height:160px;border-bottom:1px solid var(--line)}
.cols rect{fill:var(--green)}.cols rect.alt{fill:#2a78d6}.cols rect.bad{fill:var(--danger)}
.xl{display:flex;margin-top:4px}.xl span{flex:1 1 0;min-width:0;text-align:center;font-size:11px;color:var(--mute);font-family:var(--mono);overflow:hidden;white-space:nowrap}
.hb{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1.6fr) 100px;align-items:center;gap:10px;font-size:14px;padding:3px 0}
.hb .tr{display:block;width:100%;height:10px}.hb .tr rect{fill:var(--green)}.hb .tr rect.bg{fill:var(--chat)}
.hb .tr rect.alt{fill:#2a78d6}.hb .tr rect.dim{fill:#8c877c}.hb .tr rect.bad{fill:var(--danger)}
.hb .n{font-family:var(--mono);font-size:13px;text-align:right;white-space:nowrap}.hb .l{line-height:1.25}
.st table{border-collapse:collapse;width:100%;font-size:14px}.st th,.st td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}.st th{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.st td.n{font-family:var(--mono);text-align:right;white-space:nowrap}.st th.n{text-align:right}
.st .tbl{overflow-x:auto}.st td:first-child{overflow-wrap:anywhere}
.st .note{font-size:13px;color:var(--mute);margin-top:8px}.st .gap8{height:8px}
`;

// The page's CSP allows no inline style attributes, so the bars are SVG rects, sized by attributes.
const hbar = (label, n, max, { cls = '', text = null } = {}) => `<div class="hb"><span class="l">${esc(label)}</span><svg class="tr" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="10" rx="2"/><rect class="${cls}" width="${max ? Math.max(n ? 1 : 0, (n / max) * 100).toFixed(1) : 0}" height="10" rx="2"/></svg><span class="n">${text ?? fmt(n)}</span></div>`;
const hbars = (rows, opts = {}) => { const max = Math.max(...rows.map((r) => r.n), 1); return rows.map((r) => hbar(r.label, r.n, max, { cls: r.cls || opts.cls || '', text: r.text })).join(''); };
const cols = (values, labels, { cls = () => '' } = {}) => {
  const max = Math.max(...values, 1), w = 10;
  return `<svg class="cols" viewBox="0 0 ${values.length * w} 100" preserveAspectRatio="none" role="img" aria-label="${esc(labels.name || '')}">${values.map((v, i) => { const h = Math.max(0.5, (v / max) * 100); return `<rect class="${cls(i, v)}" x="${i * w + 1}" y="${(100 - h).toFixed(1)}" width="${w - 2}" height="${h.toFixed(1)}"><title>${esc(labels.tip ? labels.tip(i, v) : v)}</title></rect>`; }).join('')}</svg><div class="xl">${values.map((_, i) => `<span>${esc(labels.at(i))}</span>`).join('')}</div>`;
};
const tile = (value, label, note = '') => `<div class="tile"><small>${esc(label)}</small><b>${value}</b>${note ? `<span>${note}</span>` : ''}</div>`;
const PERIODS = [1, 7, 30, 90];

/** The whole page's body (inside the admin wrapper). `s` from settingsStats, `u` from usage.summarize. */
export function statsPage({ s, u, days, tz }) {
  const hourLabels = { at: (i) => (i % 3 === 0 ? String(i).padStart(2, '0') : ''), tip: (i, v) => `${String(i).padStart(2, '0')}:00 · ${v} recordings` };
  const binLabels = { at: (i) => (i === u.bins.length - 1 ? `${i * LEN_BIN}+` : i % 2 === 0 ? String(i * LEN_BIN) : ''), tip: (i, v) => `${i * LEN_BIN}–${i * LEN_BIN + LEN_BIN}s · ${v} recordings` };
  const whoLabel = { mine: 'only the owner’s own', others: 'only other people’s', all: 'everyone’s' };
  const whereLabel = { chat: 'in the chat', me: 'only to the owner’s control group' };
  const sect = (k, title) => `<div class="card"><h3>${title}</h3><p class="muted">${fmt(s[k].on)} on · ${fmt(s[k].off)} off</p>
${hbars(WHO.map((w) => ({ label: whoLabel[w], n: s[k].who[w], text: `${fmt(s[k].who[w])} · ${pc(share(s[k].who[w], s.linked))}` })))}
<div class="gap8"></div>${hbars(WHERE.map((w) => ({ label: whereLabel[w], n: s[k].where[w], cls: 'alt', text: `${fmt(s[k].where[w])} · ${pc(share(s[k].where[w], s.linked))}` })))}
<p class="note">${fmt(s[k].picked)} accounts limit this section to chats they picked.</p></div>`;
  const outcomeRows = [['delivered', 'Text delivered', ''], ['dropped', 'Dropped by the sanity gate (no speech, a hallucination)', 'dim'], ['failed', 'Failed (download, network, timeout)', 'bad'], ['cap', 'Over the daily cap, not transcribed', 'alt'], ['skipped', 'Skipped (over the length limit, queue full)', 'dim']];
  const processed = u.outcomes.delivered + u.outcomes.dropped + u.outcomes.failed;
  const usageEmpty = !u.records;
  return `<h1 class="small">Usage</h1>
<div class="st">
<div class="tiles">
${tile(fmt(s.linked), 'linked accounts', `${fmt(s.connected)} connected now · ${fmt(s.accounts - s.linked)} waiting to link`)}
${tile(fmt(s.week.active), 'active in the last 7 days', `${pc(share(s.week.active, s.linked))} of linked · ${fmt(s.week.minutes)} min of audio`)}
${tile(fmt(s.ever.recordings), 'recordings transcribed, ever', `${fmt(s.ever.minutes)} minutes · ${pc(s.ever.ownShare)} the owners’ own`)}
${tile(fmt(s.changedFromDefault), 'accounts that changed a setting', `${pc(share(s.changedFromDefault, s.linked))} of linked · ${fmt(s.page.visited)} opened the page`)}
${tile(usageEmpty ? '—' : fmt(u.length?.median), 'median recording, seconds', usageEmpty ? '' : `mean ${u.length?.mean} · ${pc(u.length?.under30)} under 30s`)}
${tile(usageEmpty ? '—' : String(u.latency?.median ?? '—'), 'seconds to the text, median', usageEmpty ? '' : `${pc(u.latency?.under10)} within 10s · ${pc(u.latency?.under30)} within 30s`)}
${tile(usageEmpty ? '—' : pc(u.deliveredShare, 1), 'of processed recordings delivered', usageEmpty ? '' : `${fmt(u.outcomes.dropped)} dropped · ${fmt(u.outcomes.failed)} failed`)}
${tile(fmt(s.ever.usedAtAll), 'linked accounts that ever got a text', `${pc(share(s.ever.usedAtAll, s.linked))} of linked`)}
</div>

<h2>Settings</h2>
<p class="muted">What the ${fmt(s.linked)} linked accounts chose. New accounts start with everyone’s voice notes in private chats and only the owner’s own in groups, the text in the chat.</p>
<div class="g2">${sect('chats', 'Private chats')}${sect('groups', 'Groups')}</div>
<div class="g3">
<div class="card"><h3>Where the text goes</h3><p class="muted">Both sections together.</p>${hbars([{ label: 'In the chat, under the recording', n: s.where.chat, text: `${fmt(s.where.chat)} · ${pc(share(s.where.chat, s.linked))}` }, { label: 'Only to the owner (private mode)', n: s.where.me, cls: 'alt', text: `${fmt(s.where.me)} · ${pc(share(s.where.me, s.linked))}` }, { label: 'Mixed (chats one way, groups the other)', n: s.where.mixed, cls: 'dim', text: `${fmt(s.where.mixed)} · ${pc(share(s.where.mixed, s.linked))}` }])}</div>
<div class="card"><h3>The settings page</h3>${hbars([{ label: 'Opened the page', n: s.page.visited, text: `${fmt(s.page.visited)} · ${pc(share(s.page.visited, s.linked))}` }, { label: 'Changed something on it', n: s.page.changed, text: `${fmt(s.page.changed)} · ${pc(share(s.page.changed, s.linked))}` }, { label: 'Differ from the defaults now', n: s.changedFromDefault, cls: 'alt', text: `${fmt(s.changedFromDefault)} · ${pc(share(s.changedFromDefault, s.linked))}` }])}<p class="note">${fmt(s.page.visits)} visits and ${fmt(s.page.changes)} saves in all. Some accounts differ from the defaults through WhatsApp commands rather than the page.</p></div>
<div class="card"><h3>Per-chat switches from WhatsApp</h3>${hbars([{ label: 'Any switch at all', n: s.perChat.any, text: `${fmt(s.perChat.any)} · ${pc(share(s.perChat.any, s.linked))}` }, { label: 'Included a group (include)', n: s.perChat.includedGroups }, { label: 'Excluded a chat (exclude)', n: s.perChat.excludedChats, cls: 'dim' }, { label: 'Put a chat in private mode', n: s.perChat.privateChats, cls: 'alt' }])}</div>
</div>
<div class="g3">
<div class="card"><h3>Most common set-ups</h3><div class="tbl"><table><thead><tr><th>chats · groups (who / where)</th><th class="n">accounts</th><th class="n">share</th></tr></thead><tbody>${s.combos.map((c) => `<tr><td>${esc(c.label)}</td><td class="n">${fmt(c.n)}</td><td class="n">${pc(c.share)}</td></tr>`).join('')}</tbody></table></div></div>
<div class="card"><h3>Other choices</h3>${hbars([{ label: 'Language pinned (not auto)', n: s.linked - s.language.auto, text: `${fmt(s.linked - s.language.auto)} · ${pc(share(s.linked - s.language.auto, s.linked))}` }, { label: 'Paused', n: s.paused, cls: 'dim' }, { label: 'Videos on', n: s.video, cls: 'alt' }, { label: 'Keeps recordings for research', n: s.keepAudio, cls: 'dim' }, { label: 'Joined through an invite', n: s.invited.byInvite }, { label: 'Invited at least one friend', n: s.invited.inviters }])}${s.language.pinned.length ? `<p class="note">Pinned: ${s.language.pinned.map((l) => `${esc(l.name)} ${fmt(l.n)}`).join(' · ')}</p>` : ''}</div>
<div class="card"><h3>Commands people use</h3><p class="muted">The last 30 commands of each account, all accounts together.</p>${s.commands.length ? hbars(s.commands.slice(0, 10).map((c) => ({ label: c.cmd, n: c.n }))) : '<p class="muted">None yet.</p>'}</div>
</div>

<h2>Users, by how much they transcribe</h2>
<div class="g2">
<div class="card"><h3>All time: minutes of audio per account</h3><p class="muted">Median ${s.ever.minutesMedian} min · ${fmt(s.linked - s.ever.usedAtAll)} linked accounts never got a text.</p>${hbars(s.ever.byMinutes)}</div>
<div class="card"><h3>All time: recordings per account</h3><p class="muted">Median ${fmt(s.ever.recsMedian)} recordings.</p>${hbars(s.ever.byRecs, { cls: 'alt' })}</div>
<div class="card"><h3>Last 7 days: minutes per account</h3><p class="muted">${fmt(s.week.active)} active · median ${fmt(s.week.minutesMedian)} min among them.</p>${hbars(s.week.byMinutes)}</div>
<div class="card"><h3>How long they have been linked</h3>${hbars([{ label: 'Linked over a week ago', n: s.age.overWeek, text: `${fmt(s.age.overWeek)} · ${pc(share(s.age.overWeek, s.linked))}` }, { label: 'Linked this week', n: s.linked - s.age.overWeek, cls: 'alt', text: `${fmt(s.linked - s.age.overWeek)} · ${pc(share(s.linked - s.age.overWeek, s.linked))}` }])}<p class="note">Median ${s.age.medianDays} days since linking, p90 ${s.age.p90Days}.</p></div>
</div>

<h2>Recordings</h2>
<p class="muted">From the usage ledger, last ${days === 1 ? '24 hours' : `${days} days`} · hours in ${esc(tz)} · periods: ${PERIODS.map((d) => (d === days ? `<b>${d}d</b>` : `<a href="/admin/stats?days=${d}">${d}d</a>`)).join(' · ')}</p>
${usageEmpty ? '<div class="card"><p class="muted">Nothing recorded yet: the ledger fills from the first recording after this version is deployed.</p></div>' : `
<div class="tiles">
${tile(fmt(u.delivered), 'recordings delivered', `${fmt(u.length?.minutes)} minutes · ${fmt(u.accounts.active)} accounts`)}
${tile(fmt(u.accounts.returning), 'accounts active on more than one day', pc(share(u.accounts.returning, u.accounts.active)))}
${tile(fmt(u.accounts.recsMedian), 'recordings per active account, median', `p90 ${fmt(u.accounts.recsP90)} · max ${fmt(u.accounts.recsMax)}`)}
${tile(String(u.accounts.minMedian ?? '—'), 'minutes per active account, median', `p90 ${u.accounts.minP90 ?? '—'}`)}
${tile(pc(u.accounts.minutesByDecile[0]), 'of minutes from the top 10% of accounts', `bottom half: ${pc(u.accounts.minutesByDecile.slice(5).reduce((a, b) => a + b, 0))}`)}
${tile(fmt(u.accounts.capHit), 'accounts that hit the daily cap', `${fmt(u.outcomes.cap)} recordings not transcribed`)}
</div>
<div class="g2">
<div class="card"><h3>Length, in 10-second steps</h3><p class="muted">Median ${u.length?.median}s, mean ${u.length?.mean}s, p90 ${u.length?.p90}s, longest ${u.length?.max}s · ${pc(u.length?.under10)} under 10s · ${pc(u.length?.over60, 1)} a minute or more · ${pc(u.length?.over120, 1)} two minutes or more.</p>${cols(u.bins.map((b) => b.n), binLabels)}</div>
<div class="card"><h3>Where the minutes go</h3><p class="muted">The same steps, summed in minutes of audio: the long tail is the cost.</p>${cols(u.bins.map((b) => b.minutes), { at: binLabels.at, tip: (i, v) => `${i * LEN_BIN}–${i * LEN_BIN + LEN_BIN}s · ${v} minutes` }, { cls: () => 'alt' })}</div>
<div class="card"><h3>By hour of day</h3><p class="muted">Recordings delivered per hour, the whole period summed.</p>${cols(u.hours, hourLabels)}</div>
<div class="card"><h3>By day</h3><div class="tbl"><table><thead><tr><th>day</th><th class="n">recordings</th><th class="n">minutes</th><th class="n">accounts</th></tr></thead><tbody>${u.days.slice(-14).reverse().map((d) => `<tr><td>${esc(d.day)}</td><td class="n">${fmt(d.n)}</td><td class="n">${fmt(d.minutes)}</td><td class="n">${fmt(d.accounts)}</td></tr>`).join('')}</tbody></table></div></div>
<div class="card"><h3>Accounts by recordings in the period</h3>${hbars(u.accounts.byRecs)}</div>
<div class="card"><h3>Accounts by minutes in the period</h3>${hbars(u.accounts.byMinutes, { cls: 'alt' })}</div>
<div class="card"><h3>What became of each recording</h3><p class="muted">${fmt(u.records)} recordings reached an account; ${fmt(processed)} were processed.</p>${hbars(outcomeRows.map(([k, label, cls]) => ({ label, n: u.outcomes[k], cls, text: `${fmt(u.outcomes[k])} · ${pc(share(u.outcomes[k], u.records), 1)}` })))}${Object.keys(u.reasons).length ? `<p class="note">${Object.entries(u.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, c]) => `${esc(r)} ${fmt(c)}`).join(' · ')}</p>` : ''}<p class="note">${pc(u.mix.own)} of the delivered texts were the owner’s own voice notes, ${pc(u.mix.video)} videos. Text in the chat ${fmt(u.mix.where.chat)} · only to the owner ${fmt(u.mix.where.me)} · in the control group ${fmt(u.mix.where.control)}.</p></div>
<div class="card"><h3>Speed: from the recording’s arrival to the text</h3><p class="muted">Seconds. ${pc(u.latency?.over120, 1)} waited over two minutes.</p><div class="tbl"><table><thead><tr><th>recording length</th><th class="n">n</th><th class="n">median</th><th class="n">p90</th></tr></thead><tbody>${(u.latency?.byLength || []).map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${fmt(r.n)}</td><td class="n">${r.median ?? '—'}</td><td class="n">${r.p90 ?? '—'}</td></tr>`).join('')}</tbody></table></div></div>
</div>`}
</div>`;
}
