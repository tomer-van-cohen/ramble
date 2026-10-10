<p align="center"><img src="docs/logo.svg" width="96" alt="Ramble"></p>

# Ramble

Your WhatsApp voice notes, as text, right under each recording.

Ramble links to your WhatsApp as a device (like WhatsApp Web) and turns voice
notes and videos into readable text — not a word-for-word transcript, a clear
rewrite of what was said, with a one-line summary for long notes — posted back
into WhatsApp as you.

- **Private chats**: every voice note, yours and theirs, gets its text under it, so
  both sides can read it.
- **Groups**: your own voice notes get their text; everyone's in a group you switch
  on from a private control group only you are in (`include`, or `private` to get the
  text only there). Nothing is ever posted in a chat to control it.
- **Settings page**: right after linking, and later from `settings` in the control
  group: private chats and groups each on or off, only your voice notes or everyone's,
  all chats or the ones you pick, and the text in the chat or only to you.
- Recordings are deleted the moment they're transcribed. Nothing is stored.

## Using the hosted service

Open the link and scan the QR (or, on the phone itself, get a code to type in under
**Link with phone number instead**) with **WhatsApp → Settings → Linked devices → Link a
device**, done. Any language; the speech model detects it (for the rare case it keeps
guessing wrong, write `language hebrew`, or another, in the *Ramble* group). Ramble creates a group named *Ramble*
in your WhatsApp (only you in it) — that's your control panel, and its first
message links to your settings page. Everything can also be done from the group:

| Do this | Effect |
|---|---|
| Write `settings` in the *Ramble* group | a link to the settings page (signs that browser in; the link itself works for 3 hours) |
| Write `exclude Mom` / `include Mom` in the *Ramble* group (a contact's or a group's name, the name a business shows, or a phone number) | lists the matching chats if there are several, then asks; `yes` switches that chat. An excluded chat is not transcribed at all, your own voice notes included |
| Forward a voice note from any chat into the *Ramble* group | its text + whether that chat is transcribed; reply `exclude` / `include` to switch it (it asks first) |
| Write `exclude` or `include` alone | what is excluded / which groups are transcribed |
| Write `private Mom` (or reply `private` to a forwarded recording's text) | asks first; then every recording in that chat, yours included, is transcribed into the *Ramble* group only, with nothing posted in the chat. Disappearing chats are skipped |
| Reply `delete` to anything Ramble posted | deletes it for everyone |
| Write `leave` in the *Ramble* group, then `yes` | unlinks the device and erases your account |
| Write `help` in the *Ramble* group | the list of commands |
| Write `pause` / `resume` in the *Ramble* group | stops all transcription for a while / starts it again |
| Write `groups`, `groups off`, `groups mine`, `groups others`, `groups all` or `groups private` in the *Ramble* group | shows / sets what happens in groups you haven't switched: nothing, your own voice notes with the text in the group (new accounts), only other people's, everyone's, or everyone's with the text only in the *Ramble* group |
| Write `language` in the *Ramble* group; `language hebrew` (or `auto`) | shows / pins the transcription language |
| In *Notes to self*: `names: David, Eden` | teaches the spelling of names (`names` lists, `names -X` removes) |
| Record a voice note *in* the *Ramble* group: "send Eden that I'm on my way" | finds Eden in your contacts and shows who and what; reply `yes` (or a number, if several match) and it texts her, as you. Nothing is sent without your yes. Reply `undo` to a sent one to delete it |

When both sides of a chat have an account on the same server, a recording still gets
one text: the sender's account posts it, and the recipient's steps in only if the
sender's cannot (chat off, daily limit, a failure).

Every command is one English word (`on`, `off`, `delete`, `yes`, `no`, `undo`,
`leave`, `help`, `settings`, `language`, `pause`, `resume`, `include`, `exclude`, `private`, `groups`, `names`): no synonyms and no translations, so it is never a question
which to write. A *spoken* answer to a question may be a Hebrew yes/no or a number word.

To stop using it, write `leave` in the *Ramble* group and confirm with `yes`: the
device is logged out of your WhatsApp and everything about your account is erased.

## ⚠️ Read this first

Ramble is a transcription service: it turns recordings into readable text.
WhatsApp is only the channel it receives recordings from and posts the text back
into. Ramble adds nothing to WhatsApp, offers no WhatsApp feature, and is not
affiliated with WhatsApp or Meta. Any paid plan pays for the transcription (the
audio minutes and the model), never for WhatsApp or access to it.

To be that channel, Ramble uses [Baileys](https://github.com/WhiskeySockets/Baileys),
which speaks WhatsApp's multi-device protocol directly. That is **not an official
WhatsApp API** and it is against WhatsApp's Terms of Service. Accounts using
unofficial clients can, in rare cases, be **temporarily or permanently
restricted**. Use it at your own risk; the authors take no responsibility.

## Running it yourself

One Node.js process serves the site and runs every linked account (each one is
a directory under `DATA_DIR/tenants/`). Works on any host that runs a Docker
container with a persistent disk; steps for [Railway](https://railway.app):

1. Import this repo into a Railway project (it builds from the `Dockerfile`).
2. **Add a Volume** mounted at **`/data`** — before anyone links. The startup log
   prints `💾 DATA_DIR /data: mounted volume ✓` when it's right and a loud `🚨`
   when it isn't.
3. Set the variables:

   | Variable | Value |
   |---|---|
   | `TRANSCRIBE_API_KEY` | OpenAI key (transcription with `gpt-4o-transcribe`) |
   | `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL` | `https://api.openai.com/v1` / `gpt-4o-transcribe` |
   | `FREE_TRANSCRIBE_API_KEY` | Groq key: the free plan's provider, and the fallback if the paid one is down |
   | `DAILY_MINUTES_CAP` / `GLOBAL_DAILY_MINUTES` / `MAX_TRANSCRIBE_SECONDS` | cost ceilings per account, per server and per recording (defaults 30 / 600 / 600) |
   | `SUMMARY_BASE_URL` / `SUMMARY_MODEL` | `https://api.openai.com/v1` / `gpt-5.4-mini` (rewrite + summary) |
   | `SUMMARIZE` | `1` |
   | `ADMIN_PASSWORD` | protects `/admin` (health only; never message content) |
   | `ADMIN_USER` | optional; the `/admin` username, long and random (unset = any username) |
   | `INVITE_CODE` | optional; the landing page then requires it (closed beta) |
   | `TRUST_PROXY` | proxy hops in front of the app (`2` on Railway) |
   | `PRODUCT_NAME` | the name of the control group created in each user's WhatsApp (default `Ramble`) |
   | `MAX_TENANTS` | how many accounts this server accepts (default 50) |

4. Generate a public domain. That domain is the link you give people.

Locally (Node 22 or newer): `npm install && npm start`, open <http://localhost:4599>.

`/healthz` answers `{ok:true}`; `/admin` (Basic auth, any username)
lists every account's state, minutes today and last error. `/admin/link/<id>`
signs out every browser of an account and returns a link, good for a day, that signs one in again (support). See `.env.example` for every setting.

## Privacy & security

- Session keys and settings live in `DATA_DIR/tenants/<id>/` (files `0600`,
  directories `0700`, process runs as the unprivileged `node` user). Treat that
  directory like a phone: back it up privately, never commit it.
- Every message on a linked account passes through the server in transit, as it
  would through WhatsApp Web. Only voice notes and videos in allowed chats are
  processed; everything else is discarded immediately. No message text is stored.
  View-once media is never processed; in disappearing chats the posted text
  disappears on the same timer as the recording.
- What is kept per account: session keys, settings, the language, the names it
  was taught, a hash of each recent recording (to match a forwarded recording
  to its chat) and the display names of chats and people it has seen.
- Audio, the resulting text and the names in it go to the model providers under
  their API terms. Media is only ever downloaded from WhatsApp's own CDN.
- Logs contain counts, durations and error codes; never text, transcripts or
  names. A test enforces that. The one exception is an account that opted in to
  keeping data for product work (below): for that account only, every step is
  traced to the log — transcript, what the model made of it, who a dictated
  message matched and what was sent — so a bad result can be explained.
- The site sets a strict CSP, sends no referrer off-site, and no-store on private pages. Each
  browser gets its own session (an HttpOnly cookie) by signing up, or by sending a three-digit code
  the page shows in its own control group, so a forwarded settings link opens nothing.
- The `/privacy` page says all of this to users, and they consent before linking.
- See [SECURITY.md](SECURITY.md) for reporting and operator notes, and
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency licenses
  (Baileys pulls in a GPL-3.0 `libsignal`; ffmpeg-static downloads a GPL FFmpeg).

## Cost and abuse controls

Transcription is nearly all of the cost: about half a cent per thirty-second
voice note on a paid provider, a fraction of that on a free-tier one. Ramble
reserves audio seconds *before* calling any provider, against three ceilings:

| Ceiling | Default | What it stops |
|---|---|---|
| `DAILY_MINUTES_CAP` | 30 min per account per day | one user running up a bill |
| `GLOBAL_DAILY_MINUTES` | 600 min per server per day | everyone doing it at once |
| `MAX_TRANSCRIBE_SECONDS` | 10 min per recording | a forwarded lecture in one shot |

Reservations are atomic, so recordings arriving together cannot all slip under a
ceiling. The same recording sent twice (usually a forward into the control group)
is served from memory and costs nothing. In groups only the owner's own voice notes
are transcribed by default, so a busy group costs little until its owner switches it on. `/admin` shows minutes
used today, per account and for the server.

Two plans decide which provider an account uses: `pro` (the better, paid model)
and `free` (a cheap or free-tier one). A plan is a transcription tier — which
model, how many minutes — and nothing else; the WhatsApp link is the same on
both and is never what is paid for. Move an account with
`POST /admin/plan/<id>?plan=free|pro`. To compare another model on real
recordings, `POST /admin/ab/<id>?model=<model>` transcribes twice for a while and
posts both texts into that account's own control group, never into a log.

None of this bounds money by itself — set a hard spending limit with your model
provider too.

## Improving the product on real audio (opt-in)

Recordings are deleted the moment they are transcribed. An account can opt in to
keeping them, so a model change can be judged on real audio instead of a guess:

```
POST /admin/keep-audio/<account>?on=1      # off for everyone by default
GET  /admin/research/<account>             # what is kept: metadata + the text
GET  /admin/research/<account>/<item>      # one recording, as audio
```

Kept files live under `DATA_DIR/research/<account>/`, each with a sidecar holding
what the models made of it, and are pruned after `RESEARCH_KEEP_DAYS` (30) or
once they pass `RESEARCH_MAX_MB` (500), oldest first. The same opt-in turns on a full trace of that account in the server log (lines
marked 🔬). This is the only feature that stores message content, it is per
account, and the privacy page says so.

## Development

```bash
npm start   # run
npm test    # sanity gate, rewrite guards, account registry + migration
```

`src/tenant.js` is one linked account (connection, settings, transcription,
control group); `src/registry.js` holds all of them; `src/web.js` is the site;
`src/wa.js` the WhatsApp link; `src/providers.js` the only door to a model
provider; `src/brain/` the contract with the brain, and the plain brain.

### The brain

Turning a recording into good text — which model is asked, where, how many
times, with what prompt; the sanity gate; the correction pass — is the product,
and lives in a private repository, checked out at `brain/` beside `src/` and
loaded at start. This repository runs without it, on the plain brain in
`src/brain/plain.js`: one transcription at the plan's host, delivered as it
came.

What you can read here is everything that touches your data, and it does not
depend on which brain runs. `src/brain/contract.js` says exactly what the brain
is handed (the recording as a buffer, its length, the speaker's name, the names
you taught it) and what comes back (text). The brain is given no path, no
account id and no network of its own: the only addresses audio or text can
leave for are the hosts listed in `src/providers.js`, through its two functions.
Where a recording lands and when it is deleted (`src/media.js`), what is kept
only on opt-in (`src/research.js`), what the log may say (`src/logguard.js`):
all of it is here, and tested here.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues: [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT — see `LICENSE`.

