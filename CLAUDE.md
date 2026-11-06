# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for QNAP QSW managed switches
(QSS): a Node.js service (Node 22+, ESM, no build step) that runs in its own
sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads one switch through the API of its web
interface (after aioqsw, Apache-2.0), and offers one command: a reboot
button, off by default. See `TODO.md` for the status and every decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "reboot"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # regenerate cover.png (plain Node)
node scripts/mutants.mjs [3,7]            # mutation check of the guards (memcap)
```

## Architecture

```
index.js                 SDK wiring only (src/handlers.js)
src/handlers.js          every SDK handler, registered before connect()
src/app.js               QswApp: start, /data, pace, failures, certificate, identity, states, reboot
src/qsw/client.js        QSS API: login, reading (needed + secondary routes), reboot
src/qsw/http.js          the only network access (HTTP or HTTPS, fingerprint checked first, no redirect)
src/qsw/parse.js         answers -> plain values (strict numbers, physical ports only)
src/qsw/errors.js        error codes
src/devices.js           the switch device (pure), never fewer features
src/config.js            DEFAULTS (mirror the manifest) + normalization
src/store.js             /data: salt, pins, refusal, pause, identity, cooldown, last attempt
src/publisher.js         states within 250 per minute
src/i18n.js              statuses and messages (en / fr)
scripts/mutants.*        mutation list and runner (not in the image, not in CI)
test/                    node --test, fake Gladys (SDK) + fake switch + loopback HTTP/TLS
```

## Rules

- **External ids are forever**: `switch:main`, the feature keys of
  `src/constants.js` and `port_<n>_<link|speed|rx|tx>`. The same goes for the
  manifest keys and the action keys.
- **The reboot** is a `button`/`push`, never a switch nor a binary, refused
  unless `allow_reboot` is on. Any new command needs Louis's decision, off by
  default, never a switch. PoE stays unread until a documented route exists.
- **Credentials**: only the login route refuses them (401/403 there); a
  401/403 elsewhere, an unreadable or cut answer, never.
- **Secondary routes** (statistics, sensor, time, firmware) never block nor
  pause a reading; a final failure (certificate, login) is never swallowed.
- **/data**: every read and write bounded in time; a FIFO never waited for;
  unreadable is not empty (no pin, no identity learned, no reboot), read
  again every 10 s, one read at a time, what memory decided meanwhile merged.
- **The certificate** is checked before any byte is written; a first pin is
  written to /data before the password goes. Never turn the check off.
  Plain HTTP only when the user types `http://`.
- **Secrets and identifiers**: the password, the session token, the MAC and
  the serial number are never in a log, an error message, a status, a state
  or /data in clear (`test/app.test.js` checks it).
- **Clocks**: one read of the monotonic clock per decision (`dueAt(mono)`);
  the tests use a clock that moves at every read, and `test/realclock.test.js`
  runs on the real clock.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  them by hand (0.1.0 was set by hand once). `test/manifest.test.js` checks
  they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }`; a secret field has no
  default and is described as kept by Gladys in its database, never shown
  again, never as protected by any cipher.
- **Units**: only those the core lists for the category.
- **Encoding.** UTF-8 without BOM, no mojibake (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
