// -----------------------------------------------------------------------------
// The configuration: the address with its scheme and port, the fingerprint,
// the defaults (mirror of the manifest).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseFingerprint, parseHost, targetKey } from '../src/config.js';

test('the address: HTTPS by default, http:// when typed, ports, IPv6, pasted URLs', () => {
  assert.deepEqual(parseHost('192.168.1.30'), { secure: true, host: '192.168.1.30', port: 443 });
  assert.deepEqual(parseHost('http://192.168.1.30'), {
    secure: false,
    host: '192.168.1.30',
    port: 80,
  });
  assert.deepEqual(parseHost('https://Switch.LAN:8443/login'), {
    secure: true,
    host: 'switch.lan',
    port: 8443,
  });
  assert.deepEqual(parseHost('192.168.1.30:8080'), {
    secure: true,
    host: '192.168.1.30',
    port: 8080,
  });
  assert.deepEqual(parseHost('[fd00::30]:444'), { secure: true, host: 'fd00::30', port: 444 });
  for (const bad of [
    'ftp://192.168.1.30',
    'http://user:pw@192.168.1.30',
    'http://192.168.1.30/?a=1',
    '192.168.1.300',
    '0.0.0.0',
    '255.255.255.255',
    '239.1.2.3',
    '::',
    'ff02::1',
    'a b',
    '192.168.1.30:0',
  ]) {
    assert.equal(parseHost(bad).error, 'invalid', bad);
  }
  assert.equal(parseHost('').error, 'missing');
});

test('the fingerprint as typed', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex), 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(`SHA-256: ${hex.match(/../g).join(' ')}`), 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(''), '');
  assert.equal(parseFingerprint('abcd'), null);
});

test('normalized: defaults, password kept as typed, flags strict, key with the scheme', () => {
  const c = normalizeConfig({ host: 'http://10.0.0.2', password: ' p ', allow_reboot: 'yes' });
  assert.equal(c.username, 'admin');
  assert.equal(c.password, ' p ');
  assert.equal(c.allowReboot, false);
  assert.equal(c.pollMs, 60_000);
  assert.equal(targetKey(c), 'http://10.0.0.2:80');
  assert.equal(normalizeConfig({ allow_reboot: true }).allowReboot, true);
  assert.equal(normalizeConfig({ poll_interval: '7' }).pollMs, 60_000);
  assert.equal(normalizeConfig({ password: 'a\u0007' }).passwordInvalid, true);
  assert.equal(normalizeConfig(null).hostError, 'missing');
});
