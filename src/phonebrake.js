/**
 * When a message cannot be read, the library asks the owner's phone to send it over again, and
 * the phone shows "Finished syncing with WhatsApp" each time. One account stuck on a sender it
 * cannot read asked hundreds of times an hour, and almost none of those were answered.
 *
 * The library keeps its pending requests in a cache it lets us supply, and asks that cache
 * first whether a request for the message is already out. This one answers "yes, already
 * asked" once the account has sent PHONE_REQUESTS_PER_HOUR requests in the last hour, so no
 * further request goes to the phone until the hour rolls on. Requests already out behave as
 * before. The default is 0: the phone is never asked. What that costs is in the log: a voice
 * note that could not be read says so (wa.js, "🔇").
 */
export const PHONE_REQUESTS_PER_HOUR = Number(process.env.PHONE_REQUESTS_PER_HOUR ?? 0);
const HOUR = 3600e3;
const MAX_ENTRIES = 500;

/** The cache the library takes as `placeholderResendCache` (get, set, del, close). */
export function placeholderCache({ perHour = PHONE_REQUESTS_PER_HOUR, now = Date.now, onHeld = () => {} } = {}) {
  const entries = new Map(); // message id -> { value, at }
  const sent = [];           // when each request went to the phone
  let held = 0, warnedAt = -Infinity;
  const recent = () => { while (sent.length && now() - sent[0] >= HOUR) sent.shift(); return sent.length; };
  return {
    get(id) {
      const e = entries.get(id);
      if (e && now() - e.at < HOUR) return e.value;
      if (e) entries.delete(id);
      if (recent() >= perHour) {
        held++;
        if (now() - warnedAt >= HOUR) { warnedAt = now(); onHeld({ perHour }); }
        return true; // "already asked": the library sends nothing
      }
      return undefined;
    },
    set(id, value) {
      entries.set(id, { value, at: now() });
      if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      sent.push(now());
    },
    del(id) { entries.delete(id); },
    close() { entries.clear(); },
    get held() { return held; },
  };
}
