// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// No key starts with `gladys_` (the core keeps GLADYS_* for itself).
// -----------------------------------------------------------------------------

import { DEFAULT_PORTS, POLL_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  username: 'admin',
  poll_interval: '60',
  allow_reboot: false,
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
/** A QSS user name: printable ASCII, no space. */
const USERNAME = /^[\x21-\x7e]{1,64}$/;
/** A control character (a newline pasted with the password). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/** The port: an integer 1-65535, or null. */
export function parsePort(value) {
  if (!/^\d{1,5}$/.test(value ?? '')) return null;
  const n = Number(value);
  return n > 0 && n < 65536 ? n : null;
}

/** An IPv4 address that is never one switch: any, broadcast, multicast. */
function forbiddenV4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  if (a === 0) return true;
  if (a >= 224) return true;
  return a === 255 && b === 255 && c === 255 && d === 255;
}

/**
 * The switch: an IPv4 address, a host name or an IPv6 address (brackets
 * allowed), with an optional port, and an optional scheme: `https://`
 * (the default when none is typed) or `http://` (the password then crosses
 * the network readable, said in the docs). An address pasted from a browser
 * (`http://192.168.1.30/login`) is read as its scheme, host and port.
 * Credentials, a query, a fragment are refused.
 *   -> { secure, host, port } or { error: 'missing' | 'invalid' }
 */
export function parseHost(value) {
  let raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > 300) return { error: 'invalid' };
  let port = null;
  let secure = true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { error: 'invalid' };
    }
    if (url.protocol === 'http:') secure = false;
    else if (url.protocol !== 'https:') return { error: 'invalid' };
    if (url.username || url.password || url.search || url.hash) return { error: 'invalid' };
    port = url.port ? Number(url.port) : null;
    raw = url.hostname;
  } else {
    const match = /^([^:[\]/]+):(\d{1,5})$/.exec(raw) ?? /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
    if (match) {
      raw = match[1];
      port = parsePort(match[2]);
      if (port === null) return { error: 'invalid' };
    }
  }
  const host = raw.replace(/^\[(.*)\]$/, '$1');
  const out = (h) => ({
    secure,
    host: h,
    port: port ?? (secure ? DEFAULT_PORTS.https : DEFAULT_PORTS.http),
  });
  if (IPV4.test(host)) {
    if (!host.split('.').every((n) => Number(n) <= 255)) return { error: 'invalid' };
    if (forbiddenV4(host)) return { error: 'invalid' };
    return out(host);
  }
  if (host.includes(':')) {
    if (!IPV6.test(host)) return { error: 'invalid' };
    const lower = host.toLowerCase();
    // The unspecified address and multicast are never one switch.
    if (/^(::|0*:)+0*$/.test(lower) || /^ff/.test(lower)) return { error: 'invalid' };
    return out(lower);
  }
  return HOSTNAME.test(host) ? out(host.toLowerCase().replace(/\.$/, '')) : { error: 'invalid' };
}

/**
 * A SHA-256 fingerprint as typed (colons, spaces or nothing between the
 * bytes, any case) -> `AA:BB:...` (Node's `fingerprint256`), '' when empty,
 * null when it is not 32 bytes of hex.
 */
export function parseFingerprint(value) {
  const raw = text(value).replace(/^sha-?256\s*[:=]?\s*/i, '');
  if (!raw) return '';
  const hex = raw.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/** A boolean of the configuration: true only for true (or "true"). */
const flag = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const target = parseHost(raw.host);
  const username = text(raw.username) || DEFAULTS.username;
  // The password is kept as typed (a space may belong to it), never trimmed.
  const password = typeof raw.password === 'string' ? raw.password : '';
  const fingerprint = parseFingerprint(raw.certificate_fingerprint);
  const poll = POLL_INTERVALS.includes(String(raw.poll_interval))
    ? String(raw.poll_interval)
    : DEFAULTS.poll_interval;
  return {
    host: target.error ? null : target.host,
    hostError: target.error ?? null,
    secure: target.error ? true : target.secure,
    port: target.error ? DEFAULT_PORTS.https : target.port,
    username,
    usernameInvalid: !USERNAME.test(username),
    password,
    // A newline or a control character pasted with it: said, never sent.
    passwordInvalid: password !== '' && (CONTROL.test(password) || password.length > 256),
    /** The fingerprint typed: '' none, null invalid. */
    fingerprint,
    pollMs: Number(poll) * 1000,
    allowReboot: flag(raw.allow_reboot),
  };
}

/** `scheme://host:port`: the key of the pin, the refusal, the pause and the identity in /data. */
export const targetKey = (config) =>
  `${config.secure ? 'https' : 'http'}://${config.host}:${config.port}`;
