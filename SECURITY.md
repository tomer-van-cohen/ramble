# Security policy

Ramble handles something sensitive: a live link to a person's WhatsApp.

## Reporting a vulnerability

Please report privately, not in a public issue:

- **Email:** tomer.van.cohen@gmail.com with "Ramble security" in the subject.
- **GitHub:** use *Report a vulnerability* under the repository's Security tab
  (private vulnerability reporting), if it is shown for this repository.

You will get an answer within a few days. Coordinated disclosure is welcome;
please give a reasonable window to fix before publishing.

## What matters most here

- Anything that lets one linked account see or affect another.
- Anything that exposes message content, media, session keys or a user's private
  pages (`/link/<id>`, `/settings/<id>`) or their session cookie, including a way past
  the settings page's code.
- Anything that makes the server fetch a URL of the attacker's choosing
  (media is only ever fetched from WhatsApp's CDN; see `src/media.js`).
- Anything that makes the agent post into a chat it shouldn't.

## For operators

- Keep `DATA_DIR` on a private, persistent volume and back it up privately; it
  holds every linked account's WhatsApp session keys. The container drops root
  and writes files as `0600` / directories as `0700`.
- Set `ADMIN_PASSWORD` (long) and `ADMIN_USER` (long and random); without the
  password `/admin` is disabled. Admin also has
  a per-IP lockout after 10 failed attempts. Consider `INVITE_CODE` for a
  closed beta.
- Set `TRUST_PROXY` to the number of proxy hops in front of the app (default 1;
  `2` on Railway, whose edge adds a hop; `0` if exposed directly) so rate limits
  see real client addresses. Verify it: a failed `/admin` sign-in logs the address
  it was counted against, which must be the visitor's and not the proxy's.
- Logs never contain message text, transcripts or names — only counts,
  durations and error codes — but your hosting provider's log retention is
  yours to configure.
- Rotate model API keys if a container image or log ever leaks.
- One feature deliberately keeps content: an account can opt in to storing its
  recordings and their text so model changes can be judged on real audio
  (`POST /admin/keep-audio/<id>?on=1`, off for everyone by default). Those files
  live in `DATA_DIR/research/<account>/`, are pruned by age and size
  (`RESEARCH_KEEP_DAYS`, `RESEARCH_MAX_MB`), and are readable through
  `GET /admin/research/...` behind the admin password — the one place where
  message content leaves WhatsApp into an interface of ours. Turn it off, and
  delete the folder, when the experiment is over.
