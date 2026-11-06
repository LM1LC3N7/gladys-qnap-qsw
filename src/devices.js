// -----------------------------------------------------------------------------
// The Gladys device of the switch (pure): `ext:<selector>:switch:main`.
//
// Every value is read only. The reboot is a `button`/`push` feature, never a
// switch nor a binary: a "turn everything off" of a voice assistant, MCP or a
// `switch` scene action must not reach it; it is refused unless allowed in
// the configuration. The link of a port is a read-only binary sensor.
//
// The port features (`port_<n>_link`, `_speed`, `_rx`, `_tx`) follow the
// number of ports the switch says it has: before the first reading, the
// device has the features of the switch only.
//
// A device published again never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history of the missing
// one. The features of the device created in Gladys (`gladys.devices`, kept
// up to date by the SDK) are added back when the blueprint lacks them.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, LIMITS, PORT_FEATURES as P, SWITCH_ID, SWITCH_TYPE } from './constants.js';

export const switchIds = (gladys) => gladys.externalIds(SWITCH_TYPE, SWITCH_ID);

const reading = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const textual = () =>
  reading({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
// No rpm unit and no "count" category in the core: the unit is in the name.
const plain = (min, max) => reading({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min, max });
const rate = () =>
  reading({
    category: C.DATARATE,
    type: T.DATARATE.RATE,
    unit: U.KILOBITS_PER_SECOND,
    min: 0,
    max: LIMITS.RATE_KBPS,
  });
const binary = () =>
  reading({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1, keep_history: true });

/** A number published only when finite, never NaN. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The features of the switch: [key, name, definition, value of a reading]. Units of the core only. */
export const SWITCH_FEATURES = [
  [
    F.PORTS_UP,
    'Ports connected',
    plain(0, LIMITS.PORTS),
    (s) => {
      if (!s.status || s.status.size !== s.portCount) return null;
      let up = 0;
      for (const port of s.status.values()) {
        if (port.link === null) return null;
        if (port.link) up += 1;
      }
      return up;
    },
  ],
  [
    F.TEMPERATURE,
    'Temperature',
    reading({
      category: C.DEVICE_TEMPERATURE_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.CELSIUS,
      min: -40,
      max: 150,
    }),
    (s) => num(s.temperature),
  ],
  [F.FAN1, 'Fan 1 speed (rpm)', plain(0, 100_000), (s) => num(s.fan1)],
  [F.FAN2, 'Fan 2 speed (rpm)', plain(0, 100_000), (s) => num(s.fan2)],
  [F.RX_RATE, 'Receive rate (all ports)', rate(), (s) => num(s.rates?.total?.rx)],
  [F.TX_RATE, 'Transmit rate (all ports)', rate(), (s) => num(s.rates?.total?.tx)],
  [
    F.UPTIME,
    'Uptime',
    reading({
      category: C.DURATION,
      type: T.DURATION.DECIMAL,
      unit: U.HOURS,
      min: 0,
      max: 1_000_000,
      keep_history: false,
    }),
    (s) => (num(s.uptime) === null ? null : Math.round(s.uptime / 360) / 10),
  ],
  [F.FIRMWARE, 'Firmware', textual(), (s) => s.firmware ?? null],
];

/** The features of port n: [key, name, definition, value of a reading]. */
export const portFeatures = (n) => [
  [
    `port_${n}_${P.LINK}`,
    `Port ${n} connected`,
    binary(),
    (s) => {
      const link = s.status?.get(n)?.link;
      return link === true ? 1 : link === false ? 0 : null;
    },
  ],
  [
    `port_${n}_${P.SPEED}`,
    `Port ${n} link speed`,
    reading({
      category: C.DATARATE,
      type: T.DATARATE.RATE,
      unit: U.MEGABITS_PER_SECOND,
      min: 0,
      max: 400_000,
    }),
    (s) => num(s.status?.get(n)?.speed),
  ],
  [
    `port_${n}_${P.RX_RATE}`,
    `Port ${n} receive rate`,
    rate(),
    (s) => num(s.rates?.ports?.get(n)?.rx),
  ],
  [
    `port_${n}_${P.TX_RATE}`,
    `Port ${n} transmit rate`,
    rate(),
    (s) => num(s.rates?.ports?.get(n)?.tx),
  ],
];

/** Every feature of a switch with `portCount` ports, the reboot aside. */
export function allFeatures(portCount) {
  const out = [...SWITCH_FEATURES];
  const count = Number.isInteger(portCount) ? Math.min(Math.max(portCount, 0), LIMITS.PORTS) : 0;
  for (let n = 1; n <= count; n += 1) out.push(...portFeatures(n));
  return out;
}

/** The features of the created device the blueprint lacks, appended (never fewer). */
export function withCreatedFeatures(device, devices) {
  const created = (devices ?? []).find((d) => d?.external_id === device.external_id);
  if (!created) return device;
  const known = new Set(device.features.map((f) => f.external_id));
  const extra = (created.features ?? []).filter(
    (f) => f && typeof f.external_id === 'string' && !known.has(f.external_id),
  );
  if (extra.length === 0) return device;
  return { ...device, features: [...device.features, ...extra] };
}

/** @param {{ product?: string|null, model?: string|null, portCount?: number }} [sw] */
export function buildSwitchDevice(gladys, sw = {}) {
  const ids = switchIds(gladys);
  const label = sw?.product || sw?.model || null;
  return withCreatedFeatures(
    {
      name: label ? `QNAP ${label}` : 'QNAP QSW switch',
      external_id: ids.device,
      model: label ? `QNAP ${label}` : 'QNAP QSW',
      should_poll: false,
      features: [
        ...allFeatures(sw?.portCount).map(([key, name, definition]) => ({
          name,
          external_id: ids.feature(key),
          ...definition,
        })),
        {
          name: 'Reboot the switch',
          external_id: ids.feature(F.REBOOT),
          category: C.BUTTON,
          type: T.BUTTON.PUSH,
          min: 0,
          max: 1,
          read_only: false,
          has_feedback: false,
          keep_history: false,
        },
      ],
    },
    gladys.devices,
  );
}

/** The states of a reading for the created device: numbers and texts, never null nor NaN. */
export function statesOf(gladys, sw) {
  const ids = switchIds(gladys);
  const created = (gladys.devices ?? []).find((d) => d?.external_id === ids.device);
  if (!created || !sw) return [];
  const have = new Set((created.features ?? []).map((f) => f?.external_id));
  const states = [];
  for (const [key, , definition, valueOf] of allFeatures(sw.portCount)) {
    const id = ids.feature(key);
    if (!have.has(id)) continue;
    const value = valueOf(sw);
    if (definition.category === C.TEXT) {
      if (typeof value === 'string' && value)
        states.push({ device_feature_external_id: id, text: value });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  }
  return states;
}

const PORT_KEY = new RegExp(`^port_([1-9]\\d?)_(${Object.values(P).join('|')})$`);

/**
 * What a feature external id of this integration designates: the feature
 * key of the switch, null for the device itself; undefined when not ours.
 */
export function featureOf(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) return undefined;
  const device = switchIds(gladys).device;
  if (externalId === device) return null;
  if (!externalId.startsWith(`${device}:`)) return undefined;
  const key = externalId.slice(device.length + 1);
  if (Object.values(F).includes(key)) return key;
  const port = PORT_KEY.exec(key);
  return port && Number(port[1]) <= LIMITS.PORTS ? key : undefined;
}

/** The created device of the switch, or null. */
export const createdSwitch = (gladys) =>
  (gladys.devices ?? []).find((d) => d?.external_id === switchIds(gladys).device) ?? null;
