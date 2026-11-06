# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Added

- First version: one QNAP QSW managed switch read through the API of QSS
  (after aioqsw): ports connected, temperature, fans, total rates, uptime,
  firmware, and per port: connected, link speed, receive and transmit rates.
- HTTPS with the certificate pinned before the password is sent, or plain
  HTTP when the address starts with `http://`.
- A Reboot button, off by default, at most one every 10 minutes.

[Unreleased]: https://github.com/LM1LC3N7/gladys-qnap-qsw/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-qnap-qsw/releases/tag/v0.1.1
