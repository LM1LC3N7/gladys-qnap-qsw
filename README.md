# gladys-qnap-qsw

A [Gladys Assistant](https://gladysassistant.com) external integration for
QNAP **QSW** managed switches (QSW-M408, QSW-M2116 and the other QSW-M models
running QSS), through the API of the local web interface of the switch, in
HTTPS with a pinned certificate (or plain HTTP when typed).

- One device per switch: ports connected, temperature, fan speeds, total
  receive and transmit rates, uptime, firmware; per port: connected, link
  speed, receive and transmit rates.
- A **Reboot the switch** button, off by default (an option), never a switch.

**Never tested with a real switch**: follows
[aioqsw](https://github.com/Noltari/aioqsw) (Apache-2.0, the library of the
Home Assistant `qnap_qsw` integration), tested against a fake switch.

Not the QNAP NAS integration (QTS / QuTS hero), which is another one. PoE is
not read.

Unofficial integration, not affiliated with QNAP.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Status, decisions and next steps: [TODO.md](TODO.md).
- Rules for contributors: [CLAUDE.md](CLAUDE.md).
- Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
node scripts/mutants.mjs      # mutation check of the guards (one at a time)
```

License: Apache-2.0 ([LICENSE](LICENSE)).
