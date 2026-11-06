// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake switch and a virtual clock,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { QswApp } from '../../src/app.js';
import { buildSwitchDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { PASSWORD, USERNAME } from '../fixtures/qsw.js';
import { createFakeClock } from './fakeClock.js';
import { createFakeSwitch } from './fakeSwitch.js';

export const SELECTOR = 'qnap-qsw';
export const T0 = Date.parse('2026-11-06T08:00:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const HOST = '192.168.1.30';
export const KEY = `https://${HOST}:443`;
export const BASE_CONFIG = { host: HOST, username: USERNAME, password: PASSWORD };

const ids = createFakeGladys({ selector: SELECTOR });
export const switchDevice = (ports = 12) =>
  buildSwitchDevice(ids, { product: 'QSW-M408-4C', portCount: ports });
export const fid = (key) => ids.externalIds('switch', 'main').feature(key);
export const deviceId = () => ids.externalIds('switch', 'main').device;
export const state = (gladys, key) => gladys.fake.lastState(fid(key));
export const badge = (gladys) =>
  gladys.fake.transports.filter((t) => t.device_external_id === deviceId()).at(-1);

const tick = () => new Promise((resolve) => setImmediate(resolve));
export const settle = async () => {
  for (let i = 0; i < 20; i += 1) await tick();
};

/** A random source giving the same salt every time. */
export const fixedRandom = (size) => Buffer.alloc(size, 7);

export async function setup({
  config = {},
  created = [switchDevice()],
  sw = createFakeSwitch(),
  store = memoryStore(),
  now = T0,
  connect = true,
  getConfig,
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created,
  });
  if (getConfig) gladys.getConfig = getConfig;
  const { clock, timers, advance, pending } = createFakeClock(now);
  let drift = 0;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new QswApp({
    gladys,
    logger,
    request: sw.request,
    now: () => clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    random: fixedRandom,
  });
  registerHandlers(gladys, app, logger);
  if (connect) {
    await gladys.connect();
    await advance(0);
    await settle();
  }
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  return { app, gladys, sw, clock, timers, pending, advance, wait, logs, store };
}

/** The requests of the switch for a path. */
export const sentTo = (sw, path) => sw.sent.filter((r) => r.path === path);
