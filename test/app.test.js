// -----------------------------------------------------------------------------
// The app end to end: fake Gladys (SDK), fake switch, virtual clock, the
// handlers of the container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusalTag } from '../src/app.js';
import { PATHS } from '../src/qsw/client.js';
import { CODES, SwitchError } from '../src/qsw/errors.js';
import { FEATURES } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { MAC, OTHER_MAC, PASSWORD, TOKEN } from './fixtures/qsw.js';
import {
  BASE_CONFIG,
  KEY,
  MINUTE,
  SECOND,
  T0,
  badge,
  deviceId,
  fid,
  fixedRandom,
  sentTo,
  settle,
  setup,
  state,
  switchDevice,
} from './helpers/app.js';
import { FINGERPRINT, OTHER_FINGERPRINT, createFakeSwitch } from './helpers/fakeSwitch.js';

const press = (gladys, value = 1) => {
  const device = switchDevice();
  const feature = device.features.find((f) => f.external_id === fid(FEATURES.REBOOT));
  return gladys.fake.setValue(device, feature, value);
};
const status = (gladys) => gladys.fake.connectionStatus;

/** Nothing secret nor identifying left the integration (logs, Gladys, /data). */
function assertNoSecret({ gladys, logs, store }) {
  const out = JSON.stringify([
    logs,
    gladys.fake.requests,
    gladys.fake.connectionStatuses,
    gladys.fake.sceneEvents,
    store.data,
  ]);
  const secrets = [
    PASSWORD,
    Buffer.from(PASSWORD).toString('base64'),
    TOKEN,
    MAC,
    MAC.replace(/:/g, '').toLowerCase(),
    'Q000A00000',
  ];
  for (const secret of secrets) assert.ok(!out.includes(secret), `leaked: ${secret}`);
}

test('first start: the certificate pinned in /data before the password is sent, then everything published', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  let pinnedBeforeLogin = null;
  sw.hook = (entry) => {
    if (entry.path === PATHS.LOGIN) pinnedBeforeLogin ??= store.data?.pins?.[KEY] ?? null;
  };
  const ctx = await setup({ sw, store });
  const { gladys } = ctx;
  assert.equal(pinnedBeforeLogin, FINGERPRINT);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1);
  for (const path of [
    PATHS.BOARD,
    PATHS.PORTS_STATUS,
    PATHS.PORTS_STATISTICS,
    PATHS.SENSOR,
    PATHS.TIME,
    PATHS.FIRMWARE,
  ]) {
    assert.equal(sentTo(sw, path).length, 1, path);
  }
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /QSW-M408-4C answers: 3 of 12 ports connected\.$/);
  assert.equal(state(gladys, FEATURES.PORTS_UP), 3);
  assert.equal(state(gladys, FEATURES.TEMPERATURE), 31);
  assert.equal(state(gladys, FEATURES.FAN1), 1991);
  assert.equal(state(gladys, FEATURES.FAN2), undefined, 'no second fan (-2)');
  assert.equal(state(gladys, FEATURES.UPTIME), 0);
  assert.equal(state(gladys, FEATURES.FIRMWARE), '1.2.0.29649 (20220128)');
  assert.equal(state(gladys, 'port_1_link'), 1);
  assert.equal(state(gladys, 'port_1_speed'), 10000);
  assert.equal(state(gladys, 'port_3_speed'), 100);
  assert.equal(state(gladys, 'port_4_link'), 0);
  assert.equal(state(gladys, 'port_4_speed'), 0, 'a port down: no link speed');
  assert.equal(state(gladys, FEATURES.RX_RATE), undefined, 'no rate before two readings');
  assert.equal(state(gladys, 'port_1_rx'), undefined);
  assert.equal(badge(gladys).transport, 'local');
  const discovered = gladys.fake.discoveredDevices.at(-1);
  assert.equal(discovered.name, 'QNAP QSW-M408-4C');
  assert.ok(discovered.features.some((f) => f.external_id === fid('port_12_tx')));
  assert.ok(!discovered.features.some((f) => f.external_id === fid('port_13_link')), 'no LACP');
  // The login sends the user name and the password in base64 (aioqsw).
  const login = sentTo(sw, PATHS.LOGIN)[0];
  assert.deepEqual(JSON.parse(login.body), {
    username: 'admin',
    password: Buffer.from(PASSWORD).toString('base64'),
  });
  const read = sentTo(sw, PATHS.BOARD)[0];
  assert.equal(read.headers.authorization, `Bearer ${TOKEN}0`);
  assert.equal(read.headers.cookie, `QSW_LANG=ENG; QSW_ID=${TOKEN}0`);
  assertNoSecret({ ...ctx, store });
});

test('the reboot feature is a push button, never a switch; every other feature is read only', () => {
  const device = switchDevice();
  const reboot = device.features.find((f) => f.external_id === fid(FEATURES.REBOOT));
  assert.equal(reboot.category, 'button');
  assert.equal(reboot.type, 'push');
  assert.equal(reboot.read_only, false);
  for (const f of device.features) {
    assert.notEqual(f.category, 'switch', f.name);
    if (f !== reboot) assert.equal(f.read_only, true, f.name);
  }
  assert.equal(device.features.length, 8 + 12 * 4 + 1);
});

test('rates: from the byte counters of two readings on the monotonic clock; a counter going back is no rate', async () => {
  const sw = createFakeSwitch();
  sw.octets.set(1, [1_000_000, 2_000_000]);
  sw.octets.set(2, [0, 0]);
  const { gladys, wait } = await setup({ sw });
  // 60 s later: port 1 received 7.5 MB (1000 kbit/s), sent 15 MB; port 2 nothing.
  sw.octets.set(1, [8_500_000, 17_000_000]);
  await wait(MINUTE);
  assert.equal(sentTo(sw, PATHS.PORTS_STATISTICS).length, 2);
  assert.equal(state(gladys, 'port_1_rx'), 1000);
  assert.equal(state(gladys, 'port_1_tx'), 2000);
  assert.equal(state(gladys, 'port_2_rx'), 0);
  assert.equal(state(gladys, FEATURES.RX_RATE), 1000);
  assert.equal(state(gladys, FEATURES.TX_RATE), 2000);
  // The counters start again (a reboot of the switch): no rate, never a negative one.
  sw.octets.set(1, [10, 10]);
  const before = gladys.fake.states.length;
  await wait(MINUTE);
  const after = gladys.fake.states.slice(before);
  assert.ok(!after.some((s) => s.device_feature_external_id === fid('port_1_rx')));
  assert.ok(!after.some((s) => s.device_feature_external_id === fid(FEATURES.RX_RATE)));
  assert.ok(gladys.fake.states.every((s) => typeof s.state !== 'number' || s.state >= 0));
});

test('pace: never two readings less than the interval apart; a restart keeps it (/data)', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const { gladys, wait, app } = await setup({ sw, store });
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1);
  await wait(30 * SECOND);
  await gladys.fake.configUpdated({ ...BASE_CONFIG });
  await gladys.fake.action('test_connection');
  await settle();
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1, 'neither a save nor the test reads sooner');
  await wait(30 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
  await app.stop();
  // A new container 10 s later: the next reading 50 s after it.
  const again = await setup({ sw, store, now: T0 + MINUTE + 10 * SECOND });
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
  await again.wait(45 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
  await again.wait(6 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 3);
});

test('the test button reading counts as the reading of the session: the next one an interval after it', async () => {
  const sw = createFakeSwitch({ password: 'other' });
  const { gladys, wait } = await setup({ sw });
  assert.equal(sentTo(sw, PATHS.BOARD).length, 0, 'refused: no reading');
  await wait(90 * SECOND);
  sw.password = PASSWORD;
  const ack = await gladys.fake.action('test_connection');
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1);
  await wait(59 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1, 'the loop waits an interval after the test');
  await wait(2 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
});

test('a secondary route failing (sensor 500, statistics 401, firmware cut) never blocks nor pauses', async () => {
  const sw = createFakeSwitch();
  sw.override(PATHS.SENSOR, { status: 500, body: '{}' });
  sw.override(PATHS.TIME, { status: 401 });
  sw.override(PATHS.FIRMWARE, { status: 200, body: '{"result":' });
  const { gladys, wait } = await setup({ sw });
  assert.equal(status(gladys).connected, true);
  assert.match(
    status(gladys).message.en,
    /Not read this time: temperature and fans, uptime, firmware/,
  );
  assert.equal(state(gladys, 'port_1_link'), 1);
  assert.equal(state(gladys, FEATURES.TEMPERATURE), undefined);
  // The 401 of a secondary route opened a new session once, never a refusal.
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 2);
  await wait(MINUTE);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2, 'no pause, no retry delay');
  sw.overrides.clear();
  await wait(MINUTE);
  assert.equal(state(gladys, FEATURES.TEMPERATURE), 31);
  assert.doesNotMatch(status(gladys).message.en, /Not read/);
});

test('a secondary route hanging: the reading ends within its budget, the main values published', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, connect: false });
  sw.hook = (entry) => {
    if (entry.path === PATHS.SENSOR) {
      return ctx.advance(10 * SECOND).then(() => {
        throw new SwitchError(CODES.TIMEOUT, 'No answer within 10 s');
      });
    }
    return undefined;
  };
  await ctx.gladys.connect();
  await ctx.wait(0);
  assert.equal(status(ctx.gladys).connected, true);
  assert.equal(state(ctx.gladys, 'port_2_link'), 1);
  assert.equal(sentTo(sw, PATHS.FIRMWARE).length, 1);
});

test('HTTP 503 on a main route: a pause kept in /data and across a restart, bounded', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  sw.override(PATHS.PORTS_STATUS, { status: 503, headers: { 'retry-after': '600' } }, 1);
  const { gladys, wait, app } = await setup({ sw, store });
  assert.match(status(gladys).message.en, /HTTP 503\): no request for 10 min/);
  assert.equal(store.data.pause.status, 503);
  await wait(9 * MINUTE);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1);
  await app.stop();
  const again = await setup({ sw, store, now: T0 + 9 * MINUTE + 10 * SECOND });
  assert.equal(sentTo(sw, PATHS.BOARD).length, 1);
  await again.wait(MINUTE);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
  assert.equal(store.data.pause, null);
});

test('credentials refused by the login route: kept, never retried by the loop nor a restart; a save tries the password', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch({ password: 'other' });
  const ctx = await setup({ sw, store });
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1);
  assert.match(status(ctx.gladys).message.en, /refused the user name or the password/);
  assert.equal(store.data.refused.tag, refusalTag(store.data.salt, PASSWORD));
  await ctx.wait(2 * 3600 * SECOND);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1, 'the loop never tries again');
  await ctx.app.stop();
  const again = await setup({ sw, store, now: T0 + 3 * 3600 * SECOND });
  await again.wait(10 * MINUTE);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1, 'a restart never tries again');
  // The same password saved again: tried once (a new password always is).
  await again.gladys.fake.configUpdated({ ...BASE_CONFIG });
  await again.wait(0);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 2);
  // The right one now: accepted, the refusal cleared.
  sw.password = PASSWORD;
  await again.gladys.fake.configUpdated({ ...BASE_CONFIG });
  await again.wait(MINUTE);
  assert.equal(status(again.gladys).connected, true);
  assert.equal(store.data.refused, null);
  assertNoSecret({ ...again, store });
});

test('credentials refused: the test button tries once more', async () => {
  const sw = createFakeSwitch({ password: 'other' });
  const ctx = await setup({ sw });
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1);
  await ctx.wait(MINUTE);
  sw.password = PASSWORD;
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 2);
  assert.equal(status(ctx.gladys).connected, true);
});

test('a 401/403 elsewhere than the login route is never a refusal of the credentials', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  sw.override(PATHS.BOARD, { status: 403 }, 1);
  const ctx = await setup({ sw, store });
  // Refused right after a fresh login: "access refused", retried like any failure.
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1);
  assert.match(status(ctx.gladys).message.en, /access refused after login/);
  assert.equal(store.data.refused, null);
  await ctx.wait(MINUTE);
  assert.equal(status(ctx.gladys).connected, true);
});

test('an expired session is opened again once in the reading', async () => {
  const sw = createFakeSwitch();
  const { gladys, wait } = await setup({ sw });
  sw.expireSessions();
  await wait(MINUTE);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 2);
  assert.equal(status(gladys).connected, true);
});

test('another certificate: nothing sent, kept in /data, lifted only by typing the fingerprint met', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store });
  const sent = sw.sent.length;
  sw.fingerprint = OTHER_FINGERPRINT;
  sw.expireSessions();
  await ctx.wait(MINUTE);
  assert.equal(sw.sent.length, sent, 'not a byte after the handshake');
  assert.match(status(ctx.gladys).message.en, new RegExp(OTHER_FINGERPRINT));
  assert.equal(store.data.certChanged.seen, OTHER_FINGERPRINT);
  await ctx.gladys.fake.configUpdated({ ...BASE_CONFIG });
  await ctx.wait(10 * MINUTE);
  assert.equal(sw.sent.length, sent, 'a save lifts nothing');
  await ctx.gladys.fake.configUpdated({
    ...BASE_CONFIG,
    certificate_fingerprint: OTHER_FINGERPRINT.toLowerCase(),
  });
  await ctx.wait(MINUTE);
  assert.equal(status(ctx.gladys).connected, true);
  assert.equal(store.data.pins[KEY], OTHER_FINGERPRINT);
});

test('plain HTTP when typed: no certificate, no pin; a fingerprint with http:// is refused', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store, config: { host: 'http://192.168.1.30' } });
  assert.equal(status(ctx.gladys).connected, true);
  assert.equal(sw.sent[0].secure, false);
  assert.deepEqual(store.data.pins, {});
  await ctx.gladys.fake.configUpdated({
    ...BASE_CONFIG,
    host: 'http://192.168.1.30',
    certificate_fingerprint: FINGERPRINT,
  });
  await ctx.wait(0);
  assert.match(status(ctx.gladys).message.en, /only applies to HTTPS/);
});

test('configuration problems are said, nothing sent', async () => {
  for (const [config, pattern] of [
    [{ host: '' }, /Enter the address/],
    [{ host: 'ftp://192.168.1.30' }, /not valid/],
    [{ host: '255.255.255.255' }, /not valid/],
    [{ host: '224.0.0.1' }, /not valid/],
    [{ host: '0.0.0.0' }, /not valid/],
    [{ password: '' }, /Enter the password/],
    [{ password: 'a\nb' }, /line break/],
    [{ username: 'a b' }, /user name is not valid/],
    [{ certificate_fingerprint: 'zz' }, /not a SHA-256/],
  ]) {
    const sw = createFakeSwitch();
    const ctx = await setup({ sw, config });
    assert.match(status(ctx.gladys).message.en, pattern, JSON.stringify(config));
    assert.equal(sw.connections, 0);
  }
});

test('/data unreadable: no certificate nor identity learned, nothing sent; read again every 10 s', async () => {
  const store = memoryStore(null, { unreadable: true });
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store });
  assert.equal(sw.sent.length, 0);
  assert.match(status(ctx.gladys).message.en, /cannot be read/);
  assert.equal(store.loads, 1);
  await ctx.wait(10 * SECOND);
  assert.equal(store.loads, 2, 'read again on its own timer');
  store.unreadable = false;
  await ctx.wait(10 * SECOND);
  assert.equal(store.loads, 3);
  await ctx.wait(MINUTE);
  assert.equal(status(ctx.gladys).connected, true);
  assert.equal(store.data.pins[KEY], FINGERPRINT);
  assert.ok(store.data.identity?.tag);
});

test('/data unreadable then readable: a refusal decided meanwhile is kept (merged), never overwritten', async () => {
  const salt = '11'.repeat(32);
  const store = memoryStore({ salt, pins: { [KEY]: FINGERPRINT } }, { unreadable: true });
  const sw = createFakeSwitch({ password: 'other' });
  const ctx = await setup({ sw, store, config: { certificate_fingerprint: FINGERPRINT } });
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1);
  assert.match(status(ctx.gladys).message.en, /refused the user name/);
  store.unreadable = false;
  await ctx.wait(10 * SECOND);
  assert.equal(store.data.salt, salt);
  assert.equal(store.data.refused.tag, refusalTag(salt, PASSWORD));
  await ctx.wait(10 * MINUTE);
  assert.equal(sentTo(sw, PATHS.LOGIN).length, 1, 'still refused');
});

test('/data hanging: the start goes on within 5 s; one read at a time; no reboot (cooldown not kept)', async () => {
  const store = memoryStore();
  store.hangLoad = true;
  const sw = createFakeSwitch();
  const ctx = await setup({
    sw,
    store,
    config: { certificate_fingerprint: FINGERPRINT, allow_reboot: true },
    connect: false,
  });
  const connecting = ctx.gladys.connect();
  await settle();
  await ctx.wait(5 * SECOND);
  await connecting;
  await ctx.wait(0);
  assert.match(status(ctx.gladys).message.en ?? '', /QSW-M408-4C answers/);
  await ctx.wait(30 * SECOND);
  assert.equal(store.loads, 1, 'the pending read is never doubled');
  const boards = sentTo(sw, PATHS.BOARD).length;
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error ?? JSON.stringify(ack), /identity|data/i);
  assert.equal(sw.reboots, 0);
  assert.equal(sentTo(sw, PATHS.BOARD).length, boards, 'refused before any request');
});

test('/data writes hanging: the readings go on; a reboot is refused within its budget', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  store.hangSave = true;
  await ctx.wait(MINUTE + 5 * SECOND);
  assert.equal(sentTo(sw, PATHS.BOARD).length, 2);
  const pressed = press(ctx.gladys);
  await ctx.wait(6 * SECOND);
  const ack = await pressed;
  assert.equal(ack.success, false);
  assert.equal(sw.reboots, 0);
});

test('another switch at the address (other MAC): nothing published nor commanded; a save takes it', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  const published = ctx.gladys.fake.states.length;
  sw.mac = OTHER_MAC;
  sw.temp = 50;
  await ctx.wait(MINUTE);
  assert.match(status(ctx.gladys).message.en, /Another switch/);
  assert.equal(ctx.gladys.fake.states.length, published);
  assert.equal(badge(ctx.gladys).transport, 'unreachable');
  await ctx.wait(11 * MINUTE);
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.equal(sw.reboots, 0);
  await ctx.gladys.fake.configUpdated({ ...BASE_CONFIG, allow_reboot: true });
  await ctx.wait(MINUTE);
  assert.equal(state(ctx.gladys, FEATURES.TEMPERATURE), 50);
});

test('reboot: refused unless allowed, nothing sent; a reading feature refuses', async () => {
  const sw = createFakeSwitch();
  const { gladys } = await setup({ sw });
  const ack = await press(gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled/);
  assert.equal(sentTo(sw, PATHS.COMMAND).length, 0);
  const device = switchDevice();
  const link = device.features.find((f) => f.external_id === fid('port_1_link'));
  const ack2 = await gladys.fake.setValue(device, link, 0);
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /read only/);
});

test('reboot allowed: a fresh read of the same switch, one request, a 10 min cooldown kept in /data', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  const boards = sentTo(sw, PATHS.BOARD).length;
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sentTo(sw, PATHS.BOARD).length, boards + 1, 'a fresh read first');
  assert.equal(sw.reboots, 1);
  assert.deepEqual(JSON.parse(sentTo(sw, PATHS.COMMAND)[0].body), { command: 'reboot' });
  assert.equal(store.data.rebootAt.key, KEY);
  const ack2 = await press(ctx.gladys);
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /less than 10 min/);
  for (const value of [0, true, '']) {
    const bad = await press(ctx.gladys, value);
    assert.equal(bad.success, false);
  }
  await ctx.app.stop();
  const again = await setup({ sw, store, config: { allow_reboot: true }, now: T0 + 5 * MINUTE });
  const ack3 = await press(again.gladys);
  assert.equal(ack3.success, false, 'the cooldown survives a restart');
  assert.equal(sw.reboots, 1);
  await again.wait(6 * MINUTE);
  const ack4 = await press(again.gladys);
  assert.equal(ack4.success, true, JSON.stringify(ack4));
  assert.equal(sw.reboots, 2);
});

test('reboot: the option turned off during the fresh read stops it before the cooldown is even written', async () => {
  const sw = createFakeSwitch();
  const store = memoryStore();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  let cooldownWritten = false;
  const original = store.save.bind(store);
  store.save = async (data) => {
    if (data.rebootAt) cooldownWritten = true;
    return original(data);
  };
  sw.hook = async (entry) => {
    if (entry.path === PATHS.BOARD) {
      sw.hook = null;
      ctx.app.config = { ...ctx.app.config, allowReboot: false };
    }
  };
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled/);
  assert.equal(sentTo(sw, PATHS.COMMAND).length, 0);
  assert.equal(cooldownWritten, false);
});

test('reboot: a press while one is being sent, the option turned off meanwhile, is said disabled', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, config: { allow_reboot: true } });
  let second;
  sw.hook = async (entry) => {
    if (entry.path !== PATHS.COMMAND) return;
    ctx.app.config = { ...ctx.app.config, allowReboot: false };
    second = await ctx.app.setValue(null, { external_id: fid(FEATURES.REBOOT) }, 1).catch((e) => e);
  };
  await press(ctx.gladys);
  assert.match(second?.message ?? '', /disabled/);
  assert.equal(sw.reboots, 1);
});

test('reboot: a connection too slow to come up: the deadline checked right before writing, nothing sent', async () => {
  const sw = createFakeSwitch();
  const store = memoryStore();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  sw.connectHook = (target) => (target.path === PATHS.COMMAND ? ctx.advance(3700) : undefined);
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /in time/);
  assert.equal(sentTo(sw, PATHS.COMMAND).length, 0);
  assert.equal(store.data.rebootAt, null, 'the cooldown undone');
});

test('reboot: the switch replaced since the last reading: the fresh read refuses it, nothing sent', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, config: { allow_reboot: true } });
  sw.mac = OTHER_MAC;
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Another switch/);
  sw.mac = 'unreadable';
  const ack2 = await press(ctx.gladys);
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /identity/, 'unreadable is never "another switch"');
  assert.equal(sw.reboots, 0);
});

test('reboot: the option turned off after the save, in beforeSend: nothing written', async () => {
  const sw = createFakeSwitch();
  const store = memoryStore();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  const original = store.save.bind(store);
  store.save = async (data) => {
    await original(data);
    if (data.rebootAt) ctx.app.config = { ...ctx.app.config, allowReboot: false };
  };
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.equal(sentTo(sw, PATHS.COMMAND).length, 0);
  assert.equal(store.data.rebootAt, null, 'the cooldown undone: nothing was sent');
});

test('reboot: a switch too slow to answer the fresh read: nothing sent', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, config: { allow_reboot: true } });
  sw.hook = (entry) => (entry.path === PATHS.BOARD ? ctx.advance(3 * SECOND) : undefined);
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /in time/);
  assert.equal(sentTo(sw, PATHS.COMMAND).length, 0);
});

test('reboot: does not wait for the readings to come back (outage): its own fresh read decides', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, config: { allow_reboot: true } });
  sw.state = 'down';
  await ctx.wait(MINUTE);
  assert.equal(status(ctx.gladys).connected, false);
  sw.state = null;
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(sw.reboots, 1);
});

test('reboot: an identity never read is said so, never "another switch"', async () => {
  const sw = createFakeSwitch();
  sw.mac = 'not a mac';
  const ctx = await setup({ sw, config: { allow_reboot: true } });
  assert.equal(status(ctx.gladys).connected, true, 'the values are published');
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /identity/);
  assert.equal(sw.reboots, 0);
});

test('reboot answered "no" (HTTP 400) is refused and the cooldown undone; a silence after sending is "sent, unconfirmed"', async () => {
  const store = memoryStore();
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, store, config: { allow_reboot: true } });
  sw.override(PATHS.COMMAND, { status: 400 }, 1);
  const ack = await press(ctx.gladys);
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the reboot/);
  assert.equal(store.data.rebootAt, null);
  sw.override(PATHS.COMMAND, new SwitchError(CODES.TIMEOUT, 'No answer', { notSent: false }), 1);
  const ack2 = await press(ctx.gladys);
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /sent, without an answer/);
  assert.equal(store.data.rebootAt.key, KEY);
});

test('getConfig failing at start and in a later "connected": asked again without end, the status saying so', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw, connect: false });
  await ctx.gladys.connect();
  await ctx.wait(0);
  assert.equal(status(ctx.gladys).connected, true);
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  let fails = 2;
  let calls = 0;
  ctx.gladys.getConfig = async () => {
    calls += 1;
    if (fails > 0) {
      fails -= 1;
      throw new Error('Gladys busy');
    }
    return original();
  };
  ctx.gladys.emit('connected');
  await ctx.wait(0);
  assert.equal(calls, 1);
  assert.match(
    status(ctx.gladys).message.en,
    /did not give the configuration: asked again in 30 s/,
  );
  await ctx.wait(30 * SECOND);
  assert.equal(calls, 2);
  assert.match(status(ctx.gladys).message.en, /asked again in 1 min/);
  await ctx.wait(MINUTE);
  assert.equal(calls, 3);
  await ctx.wait(MINUTE);
  assert.equal(status(ctx.gladys).connected, true);
  assert.ok(sentTo(sw, PATHS.BOARD).length >= 2, 'reading again');
});

test('stop: no timer and no request after it', async () => {
  const sw = createFakeSwitch();
  const ctx = await setup({ sw });
  await ctx.app.stop();
  assert.equal(ctx.pending.size, 0, 'no timer left');
  const sent = sw.sent.length;
  await ctx.wait(10 * MINUTE);
  assert.equal(sw.sent.length, sent);
});

test('the marker of a refused password: 8 bits, shared by many passwords (no brute force)', () => {
  const salt = fixedRandom(32).toString('hex');
  const tag = refusalTag(salt, PASSWORD);
  assert.match(tag, /^[0-9a-f]{2}$/);
  let same = 0;
  for (let i = 0; i < 10_000; i += 1) if (refusalTag(salt, `guess${i}`) === tag) same += 1;
  assert.ok(same > 10, `${same} passwords share the marker`);
});

test('Discovery: the scan publishes what is known, never a reading', async () => {
  const sw = createFakeSwitch();
  const { gladys } = await setup({ sw });
  const before = sw.sent.length;
  await gladys.fake.scanRequest();
  await settle();
  assert.equal(sw.sent.length, before);
  assert.equal(gladys.fake.discoveredDevices.at(-1).external_id, deviceId());
});
