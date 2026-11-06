# TODO — QNAP QSW v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm audit --omit=dev`, the mutants
  (`node scripts/mutants.mjs`, under `memcap`), then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. The claim is in /t/10385 (lot 18).

## Status

- [x] **Milestone 1 — core** (2026-11-06): QSS client after aioqsw 0.4.3
      (login with the password in base64, session token in a cookie and a
      Bearer header; board, port status needed; statistics, sensor, uptime,
      firmware secondary; reboot by `system/command`); HTTPS on node:https
      with the certificate checked by its SHA-256 fingerprint before any byte
      is written (pinned in /data at the first contact, written before the
      password is sent; or typed), plain HTTP when typed; one device per
      switch (8 features + 4 per physical port), the reboot button behind an
      option; pace on a monotonic clock; refused login, changed certificate,
      pause 429/5xx kept in /data; identity by a salted hash of the MAC;
      /data bounded in time, re-read on its own timer. Tested against the
      SDK's fake Gladys, a fake switch in memory, real HTTP and TLS servers on
      loopback, a real-clock test (×20), a versioned mutation list. **Never
      tested with a real switch.**
- [ ] **Milestone 2 — real switch** (a tester with a QSW-M): record real
      answers as fixtures (identifiers anonymized), fix what differs. To
      check first:
  - whether QSS serves HTTPS by default, and on which port; what an `http://`
    request answers when HTTPS is forced (a redirect is never followed: the
    status says "redirection");
  - the content type the login expects (JSON sent; aioqsw sends the JSON as
    a plain body), and what a wrong password answers (401 assumed, as aioqsw;
    a 200 with an error code would be "unexpected answer", retried with
    backoff, never a refusal kept);
  - how long a session lives, and whether a session of Gladys logs out the
    web interface of the user (aioqsw's `duplicated-login` example hints at
    it);
  - the unit of `RxOctets`/`TxOctets` (bytes assumed, as aioqsw) and whether
    they are 64-bit (BigInt here);
  - `system/sensor` taking ~5 s and failing with HTTP 500 at times (aioqsw):
    secondary here;
  - whether `system/command reboot` answers before rebooting;
  - the PoE routes of the PoE models (QSW-M2116P, QSW-M2108PR...), if any are
    documented.
- [ ] **Later** (ask on the forum first): PoE per port, the LACP groups, the
      error counters, the firmware update check (`firmware/update/check`,
      which makes the switch call QNAP), discovery.

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) before the first release; versions belong to the
  Release workflow from then on.
- **SDK `^0.16.0`** (latest on npm on 2026-11-06). `keywords`, `countries` and
  `gladys_version >= 5.3.0` wait until Gladys 5.3 is widespread. Planned:
  keywords `qnap`, `qsw`, `switch`, `network`, `poe`; countries: worldwide.
- **Not the NAS integration**: guim31/gladys-qnap reads QNAP NAS (QTS / QuTS
  hero: volumes, disks, UPS); it does not cover the QSW switches (checked on
  2026-11-06: no QSS route, no switch device). Both can live side by side.
- **Read only by default.** The reboot is the only command: a `button`/`push`
  feature, never a switch, refused unless `allow_reboot` is on (default off),
  checked again in `beforeSend`, right before the request is written. The
  firmware update and the configuration backup of aioqsw are not ported.
- **The reboot is not "protective"** (it cuts the network of the house for
  1 to 3 min): it waits for the reading in flight (within its 2.5 s budget),
  needs a fresh read of the board showing the MAC known at this address in
  /data, and is refused during a pause, a final failure, or while /data
  cannot be read. It does not need the loop to be online (an outage with its
  retry delay): its own fresh read decides. Its cooldown (10 min) is written
  to /data before the first byte, and undone when the request was not
  written or the switch answered "no". Success is `result: "None"`; the
  reboot is then confirmed (log) by the uptime of a later reading.
- **HTTPS by default, HTTP when typed**: QSS may serve its interface in plain
  HTTP only (Home Assistant's example URL is `http://`); the password is then
  only base64 on the wire, said in the manifest and the docs. A fingerprint
  with an `http://` address is a configuration error.
- **Certificate**: as gladys-airos (first pin written before the password;
  /data unreadable or not writable: nothing learned nor sent; another
  certificate stops everything until its fingerprint is typed).
- **Identity**: an HMAC (salt of /data) of `MacAddr`, per address; another MAC
  publishes nothing and refuses the reboot until the form is saved. A MAC that
  cannot be read is "unknown" (values published, reboot refused), never
  "another switch". The external id is fixed (`switch:main`).
- **Refused login**: only `POST /users/login` answering 401/403. 8 bits of an
  HMAC of the refused password, per address and user, in /data, so that a
  restart does not send it again. Saving the configuration always tries the
  password saved once (lesson of lot 20 wave 2: a new password is always
  tried, whatever its marker); the test button tries once.
- **Secondary routes**: statistics, sensor, uptime, firmware: any failure
  (5xx, 401 after a fresh login, timeout, unreadable answer) leaves their
  values unpublished this time, said in the status, never a pause nor a
  failed reading; a certificate or login refusal met there is final as
  anywhere.
- **Rates**: kbit/s from the byte counters of two readings at least 1 s
  apart on the monotonic clock; a counter going back (reboot, reset) gives no
  rate; above 100 Gbit/s, none. The total is the sum of the ports, none when
  one port is unknown.
- **Ports**: keys 1..`PortNum` (bounded to 64); the LACP groups after them
  are not read. A port down publishes a speed of 0 (the switch still says its
  last or possible speed there).
- **/data** (lessons of lot 20): every read and write bounded to 5 s; the
  file opened non-blocking and refused unless a regular file; the temporary
  file created anew (`wx`). Unreadable or slow at start: read again every
  10 s on its own timer, never two reads at once; a refusal or a pause
  decided meanwhile is merged into what /data holds (the refusal marker made
  again with the salt of /data).
- **Pace**: one timer; `dueAt(mono)` on the caller's instant; the time of the
  last attempt written to /data before the request; failures retried from
  max(1 min, interval) doubling to 30 min; 429/5xx of a needed route a pause
  of 1 min (or the interval) to 6 h, Retry-After honoured, kept in /data. The
  test button reading counts as the reading of the session.
- **Units** (core list only): kbit/s for the rates, Mbit/s for the link
  speed, hours for the uptime, °C; rpm and counts have no unit in the core:
  in the feature name (category `unknown`).
- **No scene trigger**: a port link is a binary feature, usable in scenes as
  any device value.
- **User-Agent**: `gladys-qnap-qsw (+https://github.com/LM1LC3N7/gladys-qnap-qsw)`,
  never a browser's.
