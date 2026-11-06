// -----------------------------------------------------------------------------
// The answers of the QSS API (QNAP QSW switches) -> plain values, after the
// field names and meanings of aioqsw (Apache-2.0, see THIRD_PARTY_NOTICES.md):
//
//   every answer      { error_code, error_message, result }
//   system/board      result { MacAddr, SerialNumber, Model, Product, PortNum, ... }
//   system/sensor     result { SwitchTemp, MaxSwitchTemp, Fan1Speed, Fan2Speed } (a
//                     negative fan speed: no such fan)
//   system/time       result { UpTime } (seconds)
//   firmware/info     result { version, number, buildNumber, ... }
//   ports/status      result [ { key: "1", val: { Link, FullDuplexStatus, Speed: "1000" } } ]
//   ports/statistics  result [ { key: "1", val: { RxOctets, TxOctets, RxErrors, FCSErrors } } ]
//
// Strict: a value of the wrong type, out of range or missing is `null`
// (unknown), never 0; '' is never 0; a decimal where an integer is due is
// refused. Ports are the physical ones, keys 1..PortNum (the LACP groups come
// after them in the lists: not read). Nothing here holds the MAC or the
// serial number in clear beyond the identity check of src/app.js.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { CODES, SwitchError } from './errors.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const bad = (what) => new SwitchError(CODES.BAD_ANSWER, `Not a QSS answer (${what})`);

/** An integer within bounds, from a number or a decimal text of digits; else null. */
export function integer(value, min, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^-?\d{1,15}$/.test(value.trim())) n = Number(value);
  else return null;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** A byte counter (may exceed 2^53): a BigInt >= 0, or null. */
export function counter(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d{1,20}$/.test(value.trim())) {
    const n = BigInt(value.trim());
    return n < 2n ** 64n ? n : null;
  }
  return null;
}

/** A boolean: true/false (or 1/0), else null. */
const bool = (value) => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
};

/** A text shown in Gladys: printable, trimmed, bounded; else null. */
export function cleanText(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!text) return null;
  return text.slice(0, LIMITS.TEXT_LENGTH);
}

/** A MAC address -> 12 lowercase hex digits, or null (unreadable, never "another"). */
export function macOf(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/[:.-]/g, '');
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) return null;
  const mac = hex.toLowerCase();
  // All zeros or all ones: not the address of one switch.
  if (/^0{12}$/.test(mac) || /^f{12}$/.test(mac)) return null;
  return mac;
}

/** The `result` of an answer whose error_code (when given) is 200. */
export function resultOf(answer) {
  if (!isObject(answer)) throw bad('not an object');
  const code = own(answer, 'error_code');
  if (code !== undefined && code !== 200 && code !== '200') throw bad('error code');
  if (!Object.hasOwn(answer, 'result')) throw bad('no result');
  return answer.result;
}

/** system/board -> { mac, product, model, portCount }. */
export function parseBoard(answer) {
  const r = resultOf(answer);
  if (!isObject(r)) throw bad('board');
  const portCount = integer(own(r, 'PortNum'), 1, LIMITS.PORTS);
  if (portCount === null) throw bad('port count');
  return {
    mac: macOf(own(r, 'MacAddr')),
    product: cleanText(own(r, 'Product')),
    model: cleanText(own(r, 'Model')),
    portCount,
  };
}

/** system/sensor -> { temperature, fan1, fan2 } (null: unknown or no such fan). */
export function parseSensor(answer) {
  const r = resultOf(answer);
  if (!isObject(r)) throw bad('sensor');
  const fan = (key) => {
    const n = integer(own(r, key), -1_000_000, 100_000);
    return n === null || n < 0 ? null : n;
  };
  return {
    temperature: integer(own(r, 'SwitchTemp'), -40, 150),
    fan1: fan('Fan1Speed'),
    fan2: fan('Fan2Speed'),
  };
}

/** system/time -> { uptime } (seconds, null: unknown). */
export function parseTime(answer) {
  const r = resultOf(answer);
  if (!isObject(r)) throw bad('time');
  return { uptime: integer(own(r, 'UpTime'), 0, 100 * 365 * 86_400) };
}

/** firmware/info -> { firmware } as aioqsw writes it: `1.2.0.29649 (20220128)`. */
export function parseFirmware(answer) {
  const r = resultOf(answer);
  if (!isObject(r)) throw bad('firmware');
  const version = cleanText(own(r, 'version'));
  const number = cleanText(String(own(r, 'number') ?? ''));
  const build = cleanText(String(own(r, 'buildNumber') ?? ''));
  if (!version) return { firmware: null };
  let firmware = version;
  if (number) firmware += `.${number}`;
  if (number && build) firmware += ` (${build})`;
  return { firmware: cleanText(firmware) };
}

/** The entries of a port list, for the physical ports 1..portCount only: Map<n, val>. */
function portEntries(answer, portCount, what) {
  const list = resultOf(answer);
  if (!Array.isArray(list)) throw bad(what);
  const out = new Map();
  for (const entry of list.slice(0, LIMITS.PORT_ENTRIES)) {
    const n = integer(own(entry, 'key'), 1, 10_000);
    if (n === null || n > portCount || out.has(n)) continue;
    const val = own(entry, 'val');
    if (isObject(val)) out.set(n, val);
  }
  return out;
}

/** ports/status -> Map<n, { link, speed }> (speed in Mbit/s; 0 when the link is down). */
export function parsePortsStatus(answer, portCount) {
  const out = new Map();
  for (const [n, val] of portEntries(answer, portCount, 'ports status')) {
    const link = bool(own(val, 'Link'));
    const speed = integer(own(val, 'Speed'), 0, 400_000);
    // A port down still says the speed it last had (or could have): 0, no link.
    out.set(n, { link, speed: link === false ? 0 : link === true ? speed : null });
  }
  return out;
}

/** ports/statistics -> Map<n, { rx, tx }> (BigInt byte counters, null: unknown). */
export function parsePortsStatistics(answer, portCount) {
  const out = new Map();
  for (const [n, val] of portEntries(answer, portCount, 'ports statistics')) {
    out.set(n, { rx: counter(own(val, 'RxOctets')), tx: counter(own(val, 'TxOctets')) });
  }
  return out;
}
