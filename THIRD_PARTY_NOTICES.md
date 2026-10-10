# Third-party notices

Ramble is MIT-licensed, but it depends on components under other licenses.
Operators who distribute the built container image should review these.

| Component | License | How Ramble uses it |
|---|---|---|
| [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) | MIT | WhatsApp multi-device protocol client |
| [libsignal](https://github.com/WhiskeySockets/libsignal-node) (dependency of Baileys) | GPL-3.0 | Signal-protocol encryption inside Baileys. Loaded in-process; if you redistribute a bundled build, GPL-3.0 terms apply to that distribution. |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0-or-later (wrapper); FFmpeg itself LGPL/GPL, see [ffmpeg.org/legal](https://ffmpeg.org/legal.html) | Downloads a static FFmpeg binary at `npm install`. Ramble runs it as a separate process to extract audio from videos. The binary is fetched at install time and is not covered by the lockfile's integrity hashes; pin `FFMPEG_PATH` to a binary you verified if that matters to you. |
| express, pino, qrcode | MIT | web server, logging, QR rendering |
| [Bricolage Grotesque](https://github.com/ateliertriay/bricolage), [Geist and Geist Mono](https://github.com/vercel/geist-font) | SIL Open Font License 1.1 | The site's typefaces, served from `src/fonts/` (latin subsets, as distributed by Google Fonts); each font's licence and copyright notice is next to it: `src/fonts/OFL-*.txt` |

Run `npx license-checker --production` for the full tree.
