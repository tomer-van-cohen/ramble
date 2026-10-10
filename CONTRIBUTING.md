# Contributing to Ramble

Thanks for helping. Ramble is small on purpose: it links to WhatsApp, turns
recordings into readable text, and posts it back. Changes that keep it that way
are the easiest to merge.

## Run it locally

```bash
npm install
cp .env.example .env     # add your model API keys
npm start                # http://localhost:4599
npm test                 # the shell's suite, on the plain brain
```

Link a test WhatsApp number, not your main one, while developing.

## Ground rules

- **Privacy first.** Nothing about message content may be logged, stored or shown
  on any page. Logs carry counts, durations and errors, not text. `status()` on a
  tenant is the contract; keep it that way.
- **Nothing is posted into a chat to control it.** All control happens in the
  user's own group or in their Notes to self.
- **Fail open to the raw transcript, never to a wrong one.** Every model step
  has a fallback to the plainer thing.
- **The brain is elsewhere.** Prompts, model strategy, the sanity gate and the
  experiments live in a private repository checked out at `brain/` (see the
  README). Nothing of that kind goes into `src/`: the hook refuses `brain/` paths
  and the `RAMBLE-PRIVATE` marker, and CI checks again. A change here is one that
  works on the plain brain.
- **Keep the language of system text English.** Users' languages are handled by
  the models, not by us.
- Prefer a regression (a note that went wrong) as the test case — but rewrite it
  as **synthetic text** that reproduces the failure. Never commit a real person's message, name or number.
  That includes comments and commit messages. `git config core.hooksPath .githooks`
  turns on a hook that refuses anything listed in your own, untracked
  `.private-terms` file (names of your contacts, for instance).

## Pull requests

- One change per PR, with the "why" in the description.
- Run `npm test`; CI runs it too.
- Don't add dependencies for things Node 22 already does.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please don't open a public issue for it.
