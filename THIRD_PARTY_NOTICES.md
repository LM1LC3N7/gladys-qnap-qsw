# Third-party notices

Nothing but the Gladys SDK is installed at runtime. One library's logic is
followed in JavaScript; its notice follows.

## aioqsw

- Project: <https://github.com/Noltari/aioqsw>, published on PyPI as
  `aioqsw` (used by the `qnap_qsw` integration of Home Assistant).
- Author: Álvaro Fernández Rojas (Noltari).
- Version read: 0.4.3, commit `c22d132` (2026-05-05).
- License: Apache License, Version 2.0 (the full text is the `LICENSE` file
  of this repository, the same license).

What is followed (rewritten in JavaScript, not copied): the routes of the QSS
API (`POST /api/v1/users/login` with the password in base64, the `QSW_ID`
and `QSW_LANG` cookies and the `Authorization: Bearer` header of a session,
`GET /api/v1/system/board`, `/system/sensor`, `/system/time`,
`/firmware/info`, `/ports/status`, `/ports/statistics`, `POST
/api/v1/system/command` with `reboot`), the field names of their answers, a
negative fan speed meaning no fan, the firmware written
`version.number (build)`, the LACP groups listed after the physical ports, and
the rates computed from the byte counters of two readings. The test fixtures
are shaped after those of the Home Assistant `qnap_qsw` tests (Apache-2.0),
with fake identifiers. The firmware update, the configuration backup and the
live update of the library are not ported.

Changes made here: the reading is sequential (one request at a time) and
bounded in time; a route other than the login never counts as a refusal of
the credentials; only the board and the port status are needed, the other
routes never block a reading; the physical ports are those numbered up to
`PortNum`; a byte counter going back gives no rate (aioqsw would give a
negative one).
