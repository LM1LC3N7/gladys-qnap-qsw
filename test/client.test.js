// -----------------------------------------------------------------------------
// The QSS client on the fake switch: the session, the routes needed and the
// secondary ones, the reboot answer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATHS, QswClient } from '../src/qsw/client.js';
import { CODES } from '../src/qsw/errors.js';
import { PASSWORD, USERNAME } from './fixtures/qsw.js';
import { FINGERPRINT, createFakeSwitch } from './helpers/fakeSwitch.js';

const client = (sw, extra = {}) =>
  new QswClient({
    secure: true,
    host: '192.168.1.30',
    port: 443,
    username: USERNAME,
    password: PASSWORD,
    checkPeer: (fp) => assert.equal(fp, FINGERPRINT),
    request: sw.request,
    ...extra,
  });
const timeLeft = () => 10_000;

test('a reading: login once, the session used again', async () => {
  const sw = createFakeSwitch();
  const c = client(sw);
  const r = await c.read({ timeLeft });
  assert.equal(r.portCount, 12);
  assert.deepEqual(r.missing, []);
  await c.read({ timeLeft });
  assert.equal(sw.logins, 1);
});

test('the login route only refuses the credentials; a token that is not one is a bad answer', async () => {
  const sw = createFakeSwitch({ password: 'x' });
  const err = await client(sw)
    .read({ timeLeft })
    .catch((e) => e);
  assert.equal(err.code, CODES.CREDENTIALS);
  const sw2 = createFakeSwitch();
  sw2.override(PATHS.LOGIN, { status: 200, body: { result: 'a b;c' } });
  assert.equal(
    (
      await client(sw2)
        .read({ timeLeft })
        .catch((e) => e)
    ).code,
    CODES.BAD_ANSWER,
  );
  const sw3 = createFakeSwitch();
  sw3.override(PATHS.LOGIN, { status: 200, body: '{"result":' });
  assert.equal(
    (
      await client(sw3)
        .read({ timeLeft })
        .catch((e) => e)
    ).code,
    CODES.BAD_ANSWER,
  );
  const sw4 = createFakeSwitch();
  sw4.override(PATHS.LOGIN, { status: 500 });
  const e4 = await client(sw4)
    .read({ timeLeft })
    .catch((e) => e);
  assert.equal(e4.code, CODES.HTTP);
  assert.equal(e4.status, 500);
});

test('a secondary route failing is listed missing; a needed one fails the reading', async () => {
  const sw = createFakeSwitch();
  sw.override(PATHS.PORTS_STATISTICS, { status: 503 });
  const r = await client(sw).read({ timeLeft });
  assert.deepEqual(r.missing, ['statistics']);
  assert.equal(r.statistics, null);
  sw.override(PATHS.PORTS_STATUS, { status: 503 });
  const err = await client(sw)
    .read({ timeLeft })
    .catch((e) => e);
  assert.equal(err.code, CODES.HTTP);
});

test('a certificate refused on a secondary route is never swallowed', async () => {
  const sw = createFakeSwitch();
  let calls = 0;
  const c = client(sw, {
    checkPeer: () => {
      calls += 1;
      if (calls > 3) throw Object.assign(new Error('pin'), { code: CODES.CERTIFICATE });
    },
  });
  const err = await c.read({ timeLeft }).catch((e) => e);
  assert.equal(err.code, CODES.CERTIFICATE);
});

test('no time left: nothing sent', async () => {
  const sw = createFakeSwitch();
  const err = await client(sw)
    .read({ timeLeft: () => 0 })
    .catch((e) => e);
  assert.equal(err.code, CODES.LATE);
  assert.equal(sw.sent.length, 0);
});

test('the reboot: result "None" is a success; anything else is not', async () => {
  const sw = createFakeSwitch();
  const c = client(sw);
  await assert.rejects(c.reboot({ timeLeft }), (e) => e.code === CODES.ACCESS && e.notSent);
  await c.board({ timeLeft });
  await c.reboot({ timeLeft });
  assert.equal(sw.reboots, 1);
  sw.override(PATHS.COMMAND, { status: 200, body: { result: 'error' } });
  await assert.rejects(c.reboot({ timeLeft }), (e) => e.code === CODES.BAD_ANSWER);
});
