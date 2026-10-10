/**
 * Failures below HTTP: the connection dropped, timed out or never opened. fetch reports
 * all of them as "fetch failed" and keeps the reason in `cause`, so a log line that
 * says only "fetch failed" cannot tell a busy server from a provider cutting it off.
 *
 * Such a failure is worth one more try a moment later: the recording is still there,
 * and the provider never saw the first attempt. An answer from the provider (any HTTP
 * status), a cancellation or our own timeout is not retried.
 */
import net from 'node:net';
import dns from 'node:dns';

const NET_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/;
export const RETRY_DELAY_MS = Number(process.env.NET_RETRY_DELAY_MS ?? 1500);

/** True when a request failed on the way, not with an answer. Pure; exported for tests. */
export function isNetError(e) {
  if (!e || e.name === 'AbortError') return false;
  const code = e.cause?.code || e.code || '';
  return e.message === 'fetch failed' || e.message === 'terminated' || NET_CODES.test(code);
}

/** "fetch failed (ETIMEDOUT: connect ETIMEDOUT …)": the error's first line with its cause. Pure; exported for tests. */
export function netWhy(e) {
  const first = String(e?.message || e).split('\n')[0].slice(0, 160);
  const c = e?.cause;
  if (!c) return first;
  const code = c.code || c.name || '';
  const msg = String(c.message || '').split('\n')[0].slice(0, 100);
  const why = code && msg && !msg.includes(code) ? `${code}: ${msg}` : (msg || code);
  return why ? `${first} (${why})` : first;
}

/**
 * Run `fn`, and once more after a short wait if it failed on the way.
 * `label` names the step in the log line that says a retry happened.
 */
export async function retryNet(fn, { label = 'request', signal, delayMs = RETRY_DELAY_MS, tries = 2 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || signal?.aborted || !isNetError(e)) throw e;
      console.warn(`   ↻ ${label}: ${netWhy(e)} — trying again`);
      await new Promise((r) => setTimeout(r, delayMs));
      if (signal?.aborted) throw e;
    }
  }
}

/**
 * How every outgoing connection is opened. A host with both IPv6 and IPv4 addresses is
 * tried one address at a time, and Node gives each attempt 250 ms before moving on; when
 * the event loop is busy that is not enough to even notice the connection has opened, so
 * every attempt is cut off and the request fails as ETIMEDOUT with no message. Each
 * attempt now gets several seconds, and IPv4, the one this server's network carries,
 * is tried first.
 */
export const CONNECT_ATTEMPT_MS = Number(process.env.CONNECT_ATTEMPT_TIMEOUT_MS ?? 5000);
export function configureConnections() {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
  dns.setDefaultResultOrder('ipv4first');
}
