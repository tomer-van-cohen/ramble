/**
 * Pairing, on top of Baileys: the QR it shows, the code it hands out, and one
 * step of the flow it does not know.
 *
 * Since late July 2026 WhatsApp may answer a scan with a `companion_reg_refresh`
 * notification instead of pair-success: the phone wants the companion's adv
 * secret rotated and the QR shown again with the new one (same ref). Baileys
 * 7.0.0-rc14 ignores the notification, keeps rotating QRs signed with the old
 * secret, and the phone says "couldn't link, check your connection". So every
 * QR passes through here and always carries the *current* secret, and the
 * notification rotates it and is acknowledged, as WhatsApp Web does.
 * (WhiskeySockets/Baileys#2737, PRs #2765 and #2749.)
 *
 * Pure parts are exported for tests; attach() wires a socket.
 */
import { randomBytes } from 'node:crypto';

/** A QR is "ref,noiseKey,identityKey,advSecret": the same one, with the secret in use now. */
export const withAdvSecret = (qr, advB64) => { const f = String(qr).split(','); return f.length === 4 ? [f[0], f[1], f[2], advB64].join(',') : qr; };
export const refOf = (qr) => String(qr).split(',')[0];

/** A fresh adv secret, persisted through Baileys' own creds.update. */
export function rotateAdvSecret(sock) {
  sock.authState.creds.advSecretKey = randomBytes(32).toString('base64');
  sock.ev.emit('creds.update', sock.authState.creds);
  return sock.authState.creds.advSecretKey;
}

/**
 * Wire one socket. onQr gets every QR to show (already carrying the current
 * secret); log lines say how far a pairing got, never what was in it.
 */
export function attach(sock, { onQr, onRefresh, tag = '', log = console.log } = {}) {
  let lastQr = null;
  const show = (qr) => { lastQr = withAdvSecret(qr, sock.authState.creds.advSecretKey); onQr?.(lastQr); };
  sock.ev.on('connection.update', (u) => { if (u.qr) show(u.qr); });
  sock.ws.on('CB:iq,type:set,pair-device', () => log(`${tag} 🔗 pairing offered — waiting for a scan or a code`));
  sock.ws.on('CB:notification,type:companion_reg_refresh', async (node) => {
    rotateAdvSecret(sock);
    if (lastQr) show(refOf(lastQr) + lastQr.slice(lastQr.indexOf(',')));
    // WhatsApp Web answers with an ack; Baileys' own ack fails before login (it needs creds.me),
    // so it is sent from here, unless the account is registered and Baileys can do it.
    let acked = false;
    if (!sock.authState.creds.me && node?.attrs?.id) {
      try { await sock.sendNode({ tag: 'ack', attrs: { id: node.attrs.id, to: node.attrs.from || 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' } }); acked = true; }
      catch (e) { log(`${tag} refresh ack failed: ${e?.message || e}`); }
    }
    log(`${tag} 🔁 WhatsApp asked for a refreshed pairing — new secret, same code${acked ? ', acknowledged' : ''}`);
    onRefresh?.();
  });
  sock.ws.on('CB:iq,,pair-success', () => log(`${tag} 📱 scanned — finishing the pairing`));
  return { get lastQr() { return lastQr; } };
}

/**
 * Countries for the number field: [ISO code, dial code, name, time zones that mean it].
 * The phone's time zone is the best hint of where it is, so the form preselects from it;
 * the browser's region is the fallback. A number typed with + or 00 ignores the choice.
 */
export const COUNTRIES = [
  ['IL', '972', 'Israel', ['Asia/Jerusalem', 'Asia/Tel_Aviv']], ['US', '1', 'United States', ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Detroit', 'America/Indiana/Indianapolis']],
  ['CA', '1', 'Canada', ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns', 'America/Montreal']], ['GB', '44', 'United Kingdom', ['Europe/London']],
  ['GR', '30', 'Greece', ['Europe/Athens']], ['CY', '357', 'Cyprus', ['Asia/Nicosia', 'Europe/Nicosia']], ['DE', '49', 'Germany', ['Europe/Berlin']], ['FR', '33', 'France', ['Europe/Paris']],
  ['IT', '39', 'Italy', ['Europe/Rome']], ['ES', '34', 'Spain', ['Europe/Madrid', 'Atlantic/Canary']], ['PT', '351', 'Portugal', ['Europe/Lisbon']], ['NL', '31', 'Netherlands', ['Europe/Amsterdam']],
  ['BE', '32', 'Belgium', ['Europe/Brussels']], ['CH', '41', 'Switzerland', ['Europe/Zurich']], ['AT', '43', 'Austria', ['Europe/Vienna']], ['IE', '353', 'Ireland', ['Europe/Dublin']],
  ['SE', '46', 'Sweden', ['Europe/Stockholm']], ['NO', '47', 'Norway', ['Europe/Oslo']], ['DK', '45', 'Denmark', ['Europe/Copenhagen']], ['FI', '358', 'Finland', ['Europe/Helsinki']],
  ['PL', '48', 'Poland', ['Europe/Warsaw']], ['CZ', '420', 'Czechia', ['Europe/Prague']], ['HU', '36', 'Hungary', ['Europe/Budapest']], ['RO', '40', 'Romania', ['Europe/Bucharest']],
  ['BG', '359', 'Bulgaria', ['Europe/Sofia']], ['UA', '380', 'Ukraine', ['Europe/Kyiv', 'Europe/Kiev']], ['RU', '7', 'Russia', ['Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Novosibirsk']], ['TR', '90', 'Türkiye', ['Europe/Istanbul']],
  ['AE', '971', 'United Arab Emirates', ['Asia/Dubai']], ['SA', '966', 'Saudi Arabia', ['Asia/Riyadh']], ['EG', '20', 'Egypt', ['Africa/Cairo']], ['JO', '962', 'Jordan', ['Asia/Amman']],
  ['MA', '212', 'Morocco', ['Africa/Casablanca']], ['ZA', '27', 'South Africa', ['Africa/Johannesburg']], ['NG', '234', 'Nigeria', ['Africa/Lagos']], ['IN', '91', 'India', ['Asia/Kolkata', 'Asia/Calcutta']],
  ['TH', '66', 'Thailand', ['Asia/Bangkok']], ['SG', '65', 'Singapore', ['Asia/Singapore']], ['PH', '63', 'Philippines', ['Asia/Manila']], ['ID', '62', 'Indonesia', ['Asia/Jakarta']],
  ['JP', '81', 'Japan', ['Asia/Tokyo']], ['KR', '82', 'South Korea', ['Asia/Seoul']], ['AU', '61', 'Australia', ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide']], ['NZ', '64', 'New Zealand', ['Pacific/Auckland']],
  ['BR', '55', 'Brazil', ['America/Sao_Paulo']], ['AR', '54', 'Argentina', ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires']], ['MX', '52', 'Mexico', ['America/Mexico_City']], ['CO', '57', 'Colombia', ['America/Bogota']],
  ['CL', '56', 'Chile', ['America/Santiago']],
];
// A language without a region still says something about where most of its speakers are.
const LANGUAGE_COUNTRY = { he: 'IL', iw: 'IL', el: 'GR', de: 'DE', fr: 'FR', it: 'IT', es: 'ES', pt: 'PT', nl: 'NL', pl: 'PL', ru: 'RU', uk: 'UA', tr: 'TR', ja: 'JP', ko: 'KR', th: 'TH', sv: 'SE', da: 'DK', fi: 'FI', cs: 'CZ', hu: 'HU', ro: 'RO', bg: 'BG' };

/** The country an Accept-Language header points at ("he-IL", "he", "en-GB"), or ''. */
export function countryFromLanguage(acceptLanguage = '') {
  for (const part of String(acceptLanguage).split(',')) {
    const [lang, region] = part.split(';')[0].trim().split('-');
    const iso = (region || '').toUpperCase();
    if (COUNTRIES.some((c) => c[0] === iso)) return iso;
    const guess = LANGUAGE_COUNTRY[(lang || '').toLowerCase()];
    if (guess) return guess;
  }
  return '';
}

/**
 * The number as WhatsApp knows it: digits with the country code; null when it cannot be one.
 * Typed with + or 00, it is taken as it is. Otherwise `dial` is the chosen country's code:
 * the local form ("050-123 4567", with its trunk 0) gets it put in front, and a number that
 * already starts with it ("972 50…") is left alone.
 */
export function normalizePhone(input, dial = '') {
  const raw = String(input || '').trim();
  let d = raw.replace(/\D/g, '');
  const cc = String(dial || '').replace(/\D/g, '');
  if (raw.startsWith('+')) { /* international */ }
  else if (d.startsWith('00')) d = d.slice(2);
  else if (cc && !(d.startsWith(cc) && d.length - cc.length >= 8 && !d.startsWith('0'))) d = cc + (cc === '39' ? d : d.replace(/^0/, ''));
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
