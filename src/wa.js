import './logguard.js'; // the Signal library logs session keys to the console directly
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, Browsers, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import { attach as attachPairing } from './pairing.js';
import { useAuthStore } from './authstore.js';
import { bump } from './health.js';
import { connectSlot, jitter } from './connectgate.js';
import { netWhy } from './net.js';
import { placeholderCache } from './phonebrake.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Every request that makes the phone show "Finished syncing with WhatsApp on …":
// app-state syncs, asking the phone to resend a message we couldn't decrypt,
// history sync. Baileys only logs these at info/debug, so pick them out of its
// log and print one line each (the message text only, never the objects with jids).
const PHONE_SYNC = /resync|synced |app state sync|history sync|placeholder resend|PDO|AwaitingInitialSync|Syncing state/i;
// The encryption sessions with phones: a phone that could not read what we sent (a retry request), a
// session rebuilt, a message we could not read. Printed with whose: the address kind and device number
// only, never the number itself ("own-phone:0" is the owner's phone; "pn:3" some contact's third device).
const SESSION = /retry|session|decrypt|identity key changed|MAC error|base key collision|reg id mismatch/i;
const SESSION_NOISE = /^(fetching sessions|assertSessions call|bulk session migration|bulk device migration|Using LID identity|skipping retry|skipping placeholder|failed to send unified_session|Added message to retry cache)/i;
const SESSION_FIELDS = ['retryCount', 'reason', 'recreateReason', 'sendToAll', 'shouldRecreateSession', 'injectedFromBundle', 'isSessionRecordError', 'messageType', 'mediatype', 'stored', 'received'];
// The phone's own retry request carries its count and an error code; those two say how far it got.
const RETRY_ATTRS = ['count', 'error'];
// The owner's phone could not read a post of ours twice within this long: the sessions with it are forgotten
// (resetOwnSessions), since the library resends over the same broken session unless the phone asks a
// second time with keys, which it does not always do. At most once an hour per account.
export const OWN_PHONE_RETRY_WINDOW_MS = Number(process.env.OWN_PHONE_RETRY_WINDOW_MS ?? 10 * 60e3);
export const OWN_PHONE_RESET_GAP_MS = Number(process.env.OWN_PHONE_RESET_GAP_MS ?? 60 * 60e3);
/** Pure: given the times the own phone asked for a resend and the last reset, is a reset due now? Exported for tests. */
export function ownPhoneRepairDue(retryTimes, lastResetAt, now = Date.now()) {
  const recent = retryTimes.filter((t) => now - t <= OWN_PHONE_RETRY_WINDOW_MS);
  return recent.length >= 2 && now - lastResetAt >= OWN_PHONE_RESET_GAP_MS;
}
function whoKind(jid, me) {
  if (typeof jid !== 'string' || !jid.includes('@')) return null;
  const [userPart, server] = jid.split('@');
  const [user, dev] = userPart.split(':');
  const device = Number(dev || 0);
  const own = (me?.pn && user === me.pn) || (me?.lid && user === me.lid);
  return `${own ? (device === 0 ? 'own-phone' : 'own-device') : server === 'lid' ? 'lid' : server === 's.whatsapp.net' ? 'pn' : server}:${device}`;
}
/** One log line for a session event: the library's message, whose, and the scalar facts. Pure; exported for tests. */
export function sessionLine(msg, obj = {}, me = {}) {
  // The author of a group message comes first: that is whose session or sender key is in question.
  const who = whoKind(obj.author || obj.participant || obj.key?.participant || obj.sender || obj.jid || obj.msgAttrs?.participant || obj.msgAttrs?.from || obj.key?.remoteJid, me);
  const fields = SESSION_FIELDS.filter((k) => obj[k] !== undefined && obj[k] !== null).map((k) => `${k}=${obj[k]}`);
  if (obj.attrs) fields.push(...RETRY_ATTRS.filter((k) => obj.attrs[k] !== undefined).map((k) => `${k}=${obj.attrs[k]}`));
  const err = obj.err?.message || obj.error?.message;
  // A few of the library's messages carry an id in the text itself: those words go.
  return `🔐 ${String(msg).replace(/\S*[@/]\S*/g, '…')}${who ? ` · ${who}` : ''}${fields.length ? ` · ${fields.join(' ')}` : ''}${err ? ` · ${String(err).split('\n')[0].slice(0, 80)}` : ''}`;
}
const meUsers = (creds) => ({ pn: creds?.me?.id?.split('@')[0].split(':')[0] || null, lid: creds?.me?.lid?.split('@')[0].split(':')[0] || null });
function waLogger(tag, me = () => ({}), onOwnPhoneRetry = () => {}) {
  if (process.env.WA_LOG) return pino({ level: process.env.WA_LOG });
  return pino({
    level: 'debug',
    hooks: {
      logMethod(args) {
        const msg = args.find((a) => typeof a === 'string');
        if (!msg) return;
        if (PHONE_SYNC.test(msg)) { console.log(`${tag} 📲 ${msg.replace(/ for message \S+/, '').replace(/ \([^)]*\)/, '')}`); return; }
        if (!SESSION.test(msg) || SESSION_NOISE.test(msg)) return;
        const line = sessionLine(msg, args[0] && typeof args[0] === 'object' ? args[0] : {}, me());
        // A contact's identity seen for the first time is the normal start of a session: dozens a minute
        // across the server, worth a line only when it is the owner's own device.
        if (/^identity key changed/.test(msg) && !line.includes('own-')) return;
        console.log(`${tag} ${line}`);
        if (/^recv retry request/.test(msg) && line.includes('own-phone:')) onOwnPhoneRetry();
        // A recording we could not read is one we will not transcribe (unless the sender's resend gets through).
        const media = args[0]?.mediatype;
        if (/^failed to decrypt message/.test(msg) && (media === 'ptt' || media === 'audio')) console.log(`${tag} 🔇 a ${media === 'ptt' ? 'voice note' : 'recording'} could not be read${args[0]?.messageType === 'skmsg' ? ' (group)' : ''}`);
      },
    },
  });
}

// Asking the phone for an app-state resync makes it show "WhatsApp synced with a
// linked device" and clears its notifications — so at most once per N days.
const RESYNC_DAYS = Number(process.env.APP_STATE_RESYNC_DAYS ?? 7);

/**
 * One WhatsApp link (one account) via Baileys — protocol-level, no browser.
 * Never marks itself online, never sends read receipts. Reconnects with backoff;
 * on a logged-out session it wipes the credentials and starts a fresh pairing.
 *
 *   const link = createLink({ dir, tag, onQr, onReady, onMessage, onClose, onChats, onContacts, onLoggedOut });
 *   await link.start();   link.stop();
 */
/**
 * Which parts of an account's history are downloaded when it links. Nothing here reads old
 * messages: what is used is which chats are archived and what people are called, and both also
 * arrive with the app-state sync and with every live message. The "recent" and "full" parts are
 * tens of thousands of old messages per account, decoded and held in memory for nothing; the
 * first bundle stays, because it carries the phone-number-to-id mappings the encryption needs.
 * Exported for tests.
 */
const HISTORY = proto.HistorySync.HistorySyncType;
export const wantHistory = ({ syncType } = {}) => syncType !== HISTORY.RECENT && syncType !== HISTORY.FULL;

// Which WhatsApp Web version to announce: asked for once an hour, not once per connection.
let versionAt = 0, versionPromise = null;
function latestVersion() {
  if (!versionPromise || Date.now() - versionAt > 3600e3) { versionAt = Date.now(); versionPromise = fetchLatestBaileysVersion().catch((e) => { versionPromise = null; throw e; }); }
  return versionPromise;
}

/**
 * Should an account with no live pairing keep asking WhatsApp for codes? A brand-new sign-up yes:
 * someone is about to scan. An account that was linked once and has lost its pairing (logged out
 * on the phone or by WhatsApp) only while its owner has the link page open; otherwise it would ask
 * for a fresh QR every few minutes, forever, for a screen no one is looking at. Pure; exported for tests.
 */
export const keepPairing = ({ unpaired, wanted }) => !unpaired || wanted !== false;
/**
 * Is there a pairing to resume? The library's own test: credentials that know who we are (creds.me).
 * Not creds.registered: the library sets that only when linking by a pairing code, so an account linked
 * by scanning a QR is "unregistered" for its whole life. Exported for tests.
 */
export const isPaired = (creds) => !!creds?.me?.id;
/**
 * Why WhatsApp closed the connection, as it says it: the child of a stream error ("conflict" with a type
 * such as "device_removed" when the owner removed the device on the phone) or the reason of a login
 * failure. Words and codes only, nothing about the account. Exported for tests.
 */
export function disconnectWhy(error) {
  const d = error?.data;
  if (d && typeof d === 'object') {
    if (d.tag) return [d.tag, d.attrs?.type, d.attrs?.reason].filter(Boolean).join(' ').slice(0, 60);
    if (d.reason) return `failure ${String(d.reason).slice(0, 20)}`;
  }
  return '';
}

export function createLink(cb) {
  const resyncMarker = join(cb.dir, 'appstate-resync.json');
  const tag = cb.tag || '';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let stopped = false;
  let asleep = false; // no pairing and no one waiting to scan: no socket until wake()
  let sock = null;
  let store = null; // this account's session keys; one open at a time
  // Requests to the owner's phone to resend a message we could not read, capped per hour (phonebrake.js).
  const phoneRequests = placeholderCache({ onHeld: ({ perHour }) => console.log(`${tag} 📵 ${perHour ? `the phone was asked to resend ${perHour} times this hour — holding further requests` : 'a message could not be read; the phone is not asked to resend it (PHONE_REQUESTS_PER_HOUR=0)'}`) });
  const ownRetries = []; let lastOwnReset = 0; // when the owner's phone asked for a resend; when its sessions were last forgotten
  const logger = waLogger(tag, () => meUsers(sock?.authState?.creds), () => {
    ownRetries.push(Date.now()); if (ownRetries.length > 10) ownRetries.shift();
    if (!ownPhoneRepairDue(ownRetries, lastOwnReset)) return;
    lastOwnReset = Date.now(); ownRetries.length = 0;
    console.log(`${tag} 🔐 the owner's phone could not read two posts in a row`);
    try { resetOwnSessions(); } catch (e) { console.warn(`${tag} 🔐 sessions not forgotten: ${e.message}`); }
  });

  function resyncDue() {
    if (RESYNC_DAYS <= 0) return false;
    try { const { at } = JSON.parse(readFileSync(resyncMarker, 'utf8')); return Date.now() - at > RESYNC_DAYS * 86400e3; }
    catch { return true; }
  }
  function markResynced() {
    try { writeFileSync(resyncMarker, JSON.stringify({ at: Date.now() })); } catch { /* best effort */ }
  }

  async function start() {
    if (stopped) return;
    store ??= await useAuthStore(cb.dir, { tag });
    const auth = store;
    const { state, saveCreds } = await auth.auth();
    // Nothing to resume and no one waiting to scan: sleep until the link page wakes us (see keepPairing).
    if (!keepPairing({ unpaired: !isPaired(state.creds), wanted: cb.wantPairing?.() })) { asleep = true; cb.onAsleep?.(); console.log(`${tag} 💤 no pairing and no one on the link page — waiting until it is opened`); return; }
    asleep = false;
    const { version } = await latestVersion();
    // A slot first: connections are opened a few at a time (see connectgate.js).
    const release = await connectSlot();
    if (stopped) { release(); auth.close(); store = null; return; } // stop() may have run while we awaited — don't open a socket for a dead account

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      markOnlineOnConnect: false, // stay invisible: the phone keeps its notifications
      syncFullHistory: false,     // live messages only
      shouldSyncHistoryMessage: wantHistory,
      browser: Browsers.ubuntu('Chrome'), // a stock WhatsApp Web session, nothing unusual
      placeholderResendCache: phoneRequests, // capped per hour; one per account, kept across reconnects
      qrTimeout: 45000, // each QR (and so a pairing code) lives 45s; a socket offers six before it starts over
    });
    const s = sock;
    bump('sockets');
    attachPairing(s, { tag, onQr: (qr) => cb.onQr?.(qr), onRefresh: () => cb.onPairRefresh?.() });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'open' || connection === 'close' || u.qr) release(); // the attempt has its answer
      if (connection === 'open') {
        reconnectAttempts = 0;
        cb.onReady?.(s);
        auth.settle().catch((e) => console.warn(`${tag} could not remove the old session folder:`, e.message));
        console.log(`${tag} 📲 connection open (sync counter ${state.creds.accountSyncCounter ?? 0})`);
        if (resyncDue()) {
          s.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true)
            .then(() => { markResynced(); console.log(`${tag} 🔄 app-state resynced; next in ${RESYNC_DAYS} days`); })
            .catch((e) => console.warn(`${tag} app-state resync failed: ${netWhy(e)}`));
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        cb.onClose?.(loggedOut, code);
        if (stopped) return;
        if (loggedOut) {
          // Revoked on the phone (or a pairing that never completed): wipe and re-pair.
          const why = disconnectWhy(lastDisconnect?.error);
          console.warn(`${tag} ❌ session logged out (${why || 'no reason given'}) — clearing credentials`);
          try { await auth.clear(); } catch (e) { console.warn(`${tag} could not clear the session:`, e.message); }
          cb.onLoggedOut?.();
        }
        if (reconnectTimer) return;
        if (!keepPairing({ unpaired: loggedOut || !isPaired(state.creds), wanted: cb.wantPairing?.() })) {
          asleep = true; cb.onAsleep?.();
          console.log(`${tag} 💤 no pairing and no one on the link page — waiting until it is opened`);
          return;
        }
        // An unpaired socket closes on its own when its QRs run out: not a failure, so no backoff.
        const poolRanOut = code === DisconnectReason.timedOut && !isPaired(state.creds);
        const delay = jitter(poolRanOut ? 2000 : Math.min(30000, 2000 * 2 ** reconnectAttempts));
        if (!poolRanOut) reconnectAttempts++;
        console.warn(`${tag} ↻ connection closed (${code}${poolRanOut ? ', QR pool used up' : ''}); reconnecting in ${Math.round(delay / 1000)}s${poolRanOut ? '' : ` (attempt ${reconnectAttempts})`}`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          start().catch((e) => console.error(`${tag} reconnect failed:`, e.message));
        }, delay);
      }
    });

    s.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        try { await cb.onMessage?.(m, s); }
        catch (e) { console.warn(`${tag} message handler error:`, e.message); }
      }
    });
    s.ev.on('messaging-history.set', ({ chats, contacts, messages, syncType, progress }) => {
      bump('historySets'); bump('historyMessages', messages?.length || 0); bump('historyChats', chats?.length || 0); bump(`historyType${syncType}Messages`, messages?.length || 0);
      console.log(`${tag} 📲 history sync received (type ${syncType}, ${chats?.length || 0} chats, ${contacts?.length || 0} contacts${progress != null ? `, ${progress}%` : ''})`);
      if (chats?.length) cb.onChats?.(chats);
      if (contacts?.length) cb.onContacts?.(contacts);
    });
    s.ev.on('chats.upsert', (chats) => cb.onChats?.(chats));
    s.ev.on('chats.update', (updates) => cb.onChats?.(updates));
    s.ev.on('contacts.upsert', (contacts) => cb.onContacts?.(contacts));
    s.ev.on('contacts.update', (contacts) => cb.onContacts?.(contacts));
    return s;
  }

  /** Stop reconnecting and close the socket (used when a user unlinks). */
  function stop({ logout = false } = {}) {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const s = sock; sock = null;
    if (!s) { store?.close(); store = null; return Promise.resolve({ loggedOut: false }); }
    // Report honestly whether WhatsApp acknowledged the logout; the caller warns if not.
    const out = logout ? s.logout().then(() => ({ loggedOut: true }), () => ({ loggedOut: false })) : Promise.resolve({ loggedOut: false });
    return out.finally(() => { try { s.end?.(); } catch { /* ignore */ } store?.close(); store = null; });
  }

  /** A pairing code for this phone number, valid for the current socket (the QR keeps working too). */
  const requestPairingCode = (phone) => { if (!sock) throw new Error('not connected'); return sock.requestPairingCode(phone); };

  /** The link page was opened: an account that went to sleep without a pairing asks for a code again. */
  const wake = () => { if (!asleep || stopped || reconnectTimer) return false; asleep = false; start().catch((e) => console.error(`${tag} wake failed:`, e.message)); return true; };

  /**
   * Forget the sessions with the owner's own devices, the phone included, under both of its addresses:
   * the next post opens fresh ones. For a phone that shows "waiting for this message" under our posts.
   */
  const resetOwnSessions = () => {
    const me = meUsers(sock?.authState?.creds);
    if (!store || !me.pn) throw new Error('not connected');
    const n = store.forgetSessions([me.pn, ...(me.lid ? [`${me.lid}_1`] : [])]);
    console.log(`${tag} 🔐 sessions with the owner's own devices forgotten (${n}); the next post opens fresh ones`);
    return n;
  };

  return { start, stop, wake, requestPairingCode, resetOwnSessions, get sock() { return sock; }, get asleep() { return asleep; } };
}
