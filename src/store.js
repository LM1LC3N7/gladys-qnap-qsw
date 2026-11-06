// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in qsw-state.json, readable by the container user only (0600):
//   - `salt`: a random key drawn once, for the hashes below;
//   - `pins`: the SHA-256 fingerprint of the HTTPS certificate of the switch,
//     per address (not a secret: the switch shows it to anyone);
//   - `certChanged`: `{ key, seen }`, another certificate met at that address
//     (its fingerprint, shown in the status): nothing is sent there until the
//     user types that fingerprint in the configuration;
//   - `refused`: `{ key, user, tag }`, the login the switch refused: `tag` is
//     8 bits of an HMAC of the refused password (a marker: 1 password in 256
//     shares it; never the password, never a hash of the accepted one), so
//     that a restart does not try it again;
//   - `pause`: `{ key, until, status }`, the end of a pause after HTTP 429/5xx;
//   - `identity`: `{ key, tag }`, a salted HMAC of the MAC of the switch read
//     there (not the MAC in clear; it can be found again by brute force, and
//     a MAC is not a secret: the switch shows it on its label);
//   - `rebootAt`: `{ key, at }`, when a reboot was last sent (cooldown);
//   - `lastAttemptAt`: the wall-clock time of the last reading started, so
//     that a restart never reads sooner than the interval.
//
// A missing file (ENOENT) is a first start. Any other failure to read it
// (EACCES, EIO, not JSON, too large, not a regular file) is NOT a first start:
// load() throws, and the app neither writes the file (it would replace the
// pins it holds) nor learns a certificate nor an identity. The file is opened
// without blocking (a FIFO or a device put there never holds a read; it is
// refused), the temporary file of a write is created anew (`wx`, never an
// existing file followed). The app bounds every read and write in time.
// Read back bounded: only known keys of the expected shape (never an
// inherited or `__proto__` key), every time capped.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { INTERVALS, LIMITS, STORE_FILE } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const FINGERPRINT = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
const KEY = /^[\x21-\x7e]{1,300}$/;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const MAX_PINS = 8;
const fail = (message, code) => Object.assign(new Error(message), { code });

export function fileStore(path = STORE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** The state, null when there is no file yet; throws on any other failure. */
    async load() {
      let handle;
      try {
        handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
        );
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      let text;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw fail('State file not a regular file', 'EINVAL');
        if (info.size > LIMITS.STORE_BYTES) throw fail('State file too large', 'EFBIG');
        const buffer = Buffer.alloc(LIMITS.STORE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > LIMITS.STORE_BYTES) throw fail('State file too large', 'EFBIG');
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close().catch(() => {});
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw fail('State file not JSON', 'EINVAL');
      }
      if (!isObject(data)) throw fail('State file not an object', 'EINVAL');
      return data;
    },
    save(data) {
      const text = `${JSON.stringify(data)}\n`;
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        try {
          await rm(temporary, { force: true });
          // `wx`: created anew, never an existing file (a FIFO) opened.
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(text, 'utf8');
          } finally {
            await handle.close();
          }
          await rename(temporary, path);
        } catch (err) {
          await rm(temporary, { force: true }).catch(() => {});
          throw err;
        }
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/**
 * For the tests: the same JSON round trip as the file; `failing` refuses every
 * save, `unreadable` makes every load throw (EACCES), `hang` makes a load or a
 * save never settle.
 */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    loads: 0,
    failing,
    unreadable,
    hangLoad: false,
    hangSave: false,
    async load() {
      this.loads += 1;
      if (this.hangLoad) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.hangSave) return new Promise(() => {});
      if (this.failing) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const keyed = (value, fields) => {
  if (!isObject(value) || typeof own(value, 'key') !== 'string' || !KEY.test(value.key)) {
    return null;
  }
  const out = { key: value.key };
  for (const [name, check] of Object.entries(fields)) {
    const v = own(value, name);
    if (!check(v)) return null;
    out[name] = v;
  }
  return out;
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The persisted state, repaired and bounded against `now` (wall clock). */
export function normalizeMemory(raw, now, random = randomBytes) {
  const salt = own(raw, 'salt');
  const pins = Object.create(null);
  const rawPins = own(raw, 'pins');
  if (isObject(rawPins)) {
    for (const [key, fp] of Object.entries(rawPins).slice(0, MAX_PINS)) {
      if (KEY.test(key) && typeof fp === 'string' && FINGERPRINT.test(fp)) pins[key] = fp;
    }
  }
  const last = own(raw, 'lastAttemptAt');
  const pause = keyed(own(raw, 'pause'), {
    until: finite,
    status: (v) => Number.isInteger(v) && v >= 100 && v < 600,
  });
  const rebootAt = keyed(own(raw, 'rebootAt'), { at: finite });
  return {
    salt: typeof salt === 'string' && HEX(64).test(salt) ? salt : random(32).toString('hex'),
    pins,
    certChanged: keyed(own(raw, 'certChanged'), {
      seen: (v) => typeof v === 'string' && FINGERPRINT.test(v),
    }),
    refused: keyed(own(raw, 'refused'), {
      user: (v) => typeof v === 'string' && v.length <= 64,
      tag: (v) => typeof v === 'string' && HEX(2).test(v),
    }),
    // A pause over is dropped; one ending beyond its cap (a clock set back) is capped.
    pause:
      pause && pause.until > now
        ? { ...pause, until: Math.min(pause.until, now + INTERVALS.PAUSE_MAX_MS) }
        : null,
    identity: keyed(own(raw, 'identity'), { tag: (v) => typeof v === 'string' && HEX(64).test(v) }),
    // A time in the future (a clock set back) counts as "just now", never later.
    rebootAt: rebootAt ? { ...rebootAt, at: Math.min(rebootAt.at, now) } : null,
    lastAttemptAt: finite(last) ? Math.min(last, now) : 0,
  };
}

export const serializeMemory = (m) => ({
  salt: m.salt,
  pins: { ...m.pins },
  certChanged: m.certChanged,
  refused: m.refused,
  pause: m.pause,
  identity: m.identity,
  rebootAt: m.rebootAt,
  lastAttemptAt: m.lastAttemptAt,
});

/** Room for one more pin: the oldest others dropped (the current key kept). */
export function prunePins(pins, keep) {
  const keys = Object.keys(pins);
  for (const key of keys.slice(0, Math.max(0, keys.length - (MAX_PINS - 1)))) {
    if (key !== keep) delete pins[key];
  }
}
