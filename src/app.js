// -----------------------------------------------------------------------------
// QswApp: the integration. One QNAP QSW switch, one device.
//
//   start(config)  (re)connects: /data read (bounded in time), the client of
//                  the address and login built, Discovery and the status sent
//                  again, the reading loop armed.
//   reading loop   every `poll_interval` s (60 by default): login when no
//                  session is open, then GET system/board and ports/status
//                  (needed), ports/statistics, system/sensor, system/time and
//                  firmware/info (secondary: a failure there never blocks) ->
//                  ports connected, temperature, fans, rates, uptime,
//                  firmware, and per port: link, speed, receive and transmit
//                  rates.
//   reboot         a `button`, refused unless "Allow rebooting the switch" is
//                  on: the switch read again first (the same one, by a salted
//                  hash of its MAC), the option checked again right before
//                  the request is written, one request never retried, at most
//                  one every 10 min (kept in /data).
//   failures       credentials refused (by the login route only): kept in
//                  /data, never tried again by the loop until the user name
//                  or the password is saved again (the test button tries
//                  once); another HTTPS certificate than the one pinned:
//                  nothing is sent until the user types the fingerprint met;
//                  HTTP 429 and 5xx of a needed route pause every request
//                  (bounded, kept in /data); anything else is retried, never
//                  faster than the poll interval, doubling up to 30 min.
//
// Pace: never two readings less than an interval apart, whatever asks (a
// reconnection, a save of the form, the test button, a restart of the
// container: the time of the last attempt is kept in /data, written BEFORE
// the request).
//
// /data: every read and write is bounded in time (5 s). Unreadable or slow at
// start, it is read again on a timer of its own (10 s), one read at a time;
// what was decided in memory meanwhile (a refusal, a pause) is merged, never
// overwritten. While it cannot be read, no certificate and no identity are
// learned, and no reboot is sent (its cooldown could not be kept).
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces the
// readings, the retries, the pauses, the rates and the cooldown, so that a
// wall clock set back or forward never stops nor hurries them. One read of the
// clock per decision: dueAt(mono) computes on the caller's instant. One timer
// at a time for the loop.
//
// A reading belongs to its session (the client of one address and login):
// when they change, a late answer of the old one publishes nothing and sets
// no status (checked after every await). Neither the password, nor the
// session token, nor the MAC is ever logged, published or written to /data.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { QswClient } from './qsw/client.js';
import { CODES, SwitchError, isFinal, isPause } from './qsw/errors.js';
import { normalizeConfig, targetKey } from './config.js';
import { COMMAND, FEATURES, INTERVALS, LIMITS, PRESSED, TIMEOUTS } from './constants.js';
import {
  SWITCH_FEATURES,
  buildSwitchDevice,
  createdSwitch,
  featureOf,
  statesOf,
} from './devices.js';
import { T, reasonOf } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, prunePins, serializeMemory } from './store.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 28_000;
const defaultTimers = { setTimeout, clearTimeout };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hmac = (salt, value) => createHmac('sha256', salt).update(value).digest('hex');
/**
 * 8 bits of an HMAC of a refused password: a marker, never enough to tell a
 * password (1 password in 256 shares it). Saving the configuration always
 * tries the password saved, once, whatever its marker.
 */
export const refusalTag = (salt, password) => hmac(salt, `refused|${password}`).slice(0, 2);

/** An error for Gladys, with its cause kept (never shown). */
const userError = (message, cause) =>
  Object.assign(new Error(message, cause ? { cause } : undefined), { user: true });

const portsUpOf = SWITCH_FEATURES.find(([key]) => key === FEATURES.PORTS_UP)[3];

/** kbit/s between two byte counters `seconds` apart; null when unknown, reset or absurd. */
function kbps(current, previous, seconds) {
  if (typeof current !== 'bigint' || typeof previous !== 'bigint' || current < previous) {
    return null;
  }
  const value = Math.round((Number(current - previous) * 8) / 1000 / seconds);
  return Number.isFinite(value) && value <= LIMITS.RATE_KBPS ? value : null;
}

export class QswApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the transport (tests inject a fake switch)
   * @param {() => number} [options.now] wall clock (ms)
   * @param {() => number} [options.monotonic] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {{ load: Function, save: Function }} [options.store] /data
   * @param {(size: number) => Buffer} [options.random]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'qnap-qsw' }),
    request,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = fileStore(),
    random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, monotonic });
    this.config = normalizeConfig();
    /** `{ key, client }` of the current address and login; replaced when they change. */
    this.session = undefined;
    this.running = false;
    this.stopped = false;
    this.timer = undefined;
    this.configTimer = undefined;
    this.storeTimer = undefined;
    this.lifecycle = Promise.resolve();
    this.loopRun = Promise.resolve();
    /** The reading (or the command) in flight: one at a time. */
    this.busy = undefined;
    this.inFlight = undefined;
    this.lastStatus = null;
    /** What /data keeps (see src/store.js); loaded at the first start. */
    this.memory = undefined;
    /** /data could not be read: nothing is written there, no certificate nor identity learned. */
    this.dataUnreadable = false;
    /** A read of /data still pending (slow): never a second one beside it. */
    this.loading = undefined;
    this.loadWarned = false;
    this.saveWarned = false;
    /** The pace (monotonic instants; undefined: none). */
    this.lastReadAt = undefined;
    this.savedAttemptAt = undefined;
    this.pauseDue = undefined;
    this.rebootMono = undefined;
    this.resetSession();
  }

  /** What belongs to one address and login: forgotten when they change. */
  resetSession() {
    this.online = false;
    /** The last reading (src/qsw/client.js read()) with its rates. */
    this.sw = null;
    /** The byte counters of the last statistics read: { mono, ports }. */
    this.counters = null;
    this.nextTryAt = undefined;
    this.retryDelay = undefined;
    /** A failure that stops every request until the user acts: { code, message } | null. */
    this.final = null;
    /** Saving the configuration takes the switch met as the new one. */
    this.acceptIdentity = false;
    this.discoveredKey = null;
    this.transports = new Map();
    this.rebootPending = null;
    this.rebootingUntil = undefined;
    /** The status of the last failed reading, said again until a reading works. */
    this.failureMessage = null;
  }

  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, this.config.pollMs);
  }

  key() {
    return targetKey(this.config);
  }

  // --- Lifecycle -------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: a switch met at the address with another MAC is
   * taken as the new one, and a refused login is tried again once (the
   * password saved is always tried). Nothing reads sooner than the interval,
   * nor lifts a pause or a changed certificate (only the fingerprint typed).
   */
  start(rawConfig, { force = false } = {}) {
    return this.serialize(() => this.doStart(rawConfig, { force }));
  }

  /**
   * The configuration read from Gladys, then start. When Gladys does not give
   * it, asked again 30 s, 1 min, 2 min... 10 min at most, without end, the
   * status saying so. One chain at a time (cleared by pause()).
   */
  async startFromGladys(attempt = 0) {
    this.clearConfigTimer();
    if (this.stopped) return;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped) return;
      const delay = clamp(
        INTERVALS.CONFIG_RETRY_MIN_MS * 2 ** attempt,
        INTERVALS.CONFIG_RETRY_MIN_MS,
        INTERVALS.CONFIG_RETRY_MAX_MS,
      );
      this.logger.warn(`Configuration not read (${err?.name ?? 'Error'}): asked again`);
      // A reading of an older configuration stops: the next start decides.
      this.pause();
      await this.setStatus(false, T.status.configNotRead(delay));
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.startFromGladys(attempt + 1).catch((e) =>
          this.logger.error(`Start failed (${e?.name ?? 'Error'})`),
        );
      }, delay);
      return;
    }
    await this.start(config);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  clearLoopTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearStoreTimer() {
    if (this.storeTimer !== undefined) {
      this.timers.clearTimeout(this.storeTimer);
      this.storeTimer = undefined;
    }
  }

  /** Gladys went away: the loop stops; the session, the pace and the failures stay. */
  pause() {
    this.running = false;
    this.clearLoopTimer();
    this.clearConfigTimer();
    this.clearStoreTimer();
  }

  /**
   * Stops the readings, waits (bounded) for the one running, and writes /data
   * (bounded): the time of the last attempt is not lost by a clean stop. No
   * timer and no request after it.
   */
  stop() {
    this.stopped = true;
    this.pause();
    return this.serialize(async () => {
      this.pause();
      if (this.busy)
        await this.within(
          this.busy.catch(() => {}),
          INTERVALS.STOP_WAIT_MS,
        );
      this.session?.client?.close();
      if (this.memory) await this.save();
    });
  }

  /** Resolves once every queued start/stop and the reading running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy?.catch(() => {});
  }

  /** `promise`, or a rejection after `ms` (the promise is left to itself). */
  within(promise, ms) {
    let handle;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        handle = this.timers.setTimeout(
          () => reject(Object.assign(new Error('Too slow'), { code: 'ETIMEDOUT' })),
          ms,
        );
      }),
    ]).finally(() => this.timers.clearTimeout(handle));
  }

  // --- /data -------------------------------------------------------------------

  /**
   * /data, read once (bounded); while it cannot be read, read again on a
   * timer of its own, one read at a time. A read still pending is never
   * doubled. What was decided in memory meanwhile is merged.
   */
  async loadMemory() {
    if (this.memory && !this.dataUnreadable) return;
    if (this.loading) {
      // A read still pending (slow /data): the memory of this run serves.
      this.memory ??= normalizeMemory(null, this.now(), this.random);
      this.dataUnreadable = true;
      this.armStoreRetry();
      return;
    }
    const run = Promise.resolve().then(() => this.store.load());
    this.loading = run;
    run
      .finally(() => {
        if (this.loading === run) this.loading = undefined;
      })
      .catch(() => {});
    let raw;
    try {
      raw = await this.within(run, TIMEOUTS.STORE_MS);
    } catch (err) {
      if (!this.loadWarned) {
        this.loadWarned = true;
        this.logger.warn(
          `The storage /data cannot be read (${err?.code ?? 'error'}): nothing written there, no certificate learned; read again every 10 s`,
        );
      }
      this.dataUnreadable = true;
      // Kept in memory only: a refusal or a pause of this run.
      this.memory ??= normalizeMemory(null, this.now(), this.random);
      this.armStoreRetry();
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const disk = normalizeMemory(raw, now, this.random);
    const ram = this.dataUnreadable ? this.memory : null;
    if (ram) this.merge(disk, ram);
    this.memory = disk;
    const wasUnreadable = this.dataUnreadable;
    this.dataUnreadable = false;
    this.loadWarned = false;
    this.clearStoreTimer();
    // The last attempt before a restart: the next one never comes sooner than the interval.
    if (disk.lastAttemptAt > 0) {
      const at = mono - Math.max(0, now - disk.lastAttemptAt);
      if (this.lastReadAt === undefined || at > this.lastReadAt) this.lastReadAt = at;
      this.savedAttemptAt = disk.lastAttemptAt;
    }
    // The pause and the cooldown kept are brought onto the monotonic clock
    // by the next start (they belong to an address).
    this.appliedKey = null;
    if (wasUnreadable) {
      this.logger.info('The storage /data can be read again');
      await this.save();
    }
  }

  /** What was decided in memory while /data could not be read, onto what it holds. */
  merge(disk, ram) {
    const c = this.config;
    if (ram.refused && ram.refused.key === targetKey(c) && ram.refused.user === c.username) {
      // The marker is salted: made again with the salt of /data.
      disk.refused = { ...ram.refused, tag: refusalTag(disk.salt, c.password) };
    }
    if (ram.pause && (!disk.pause || ram.pause.until > disk.pause.until)) disk.pause = ram.pause;
    if (ram.certChanged) disk.certChanged = ram.certChanged;
    for (const [key, fp] of Object.entries(ram.pins)) {
      if (!disk.pins[key]) {
        prunePins(disk.pins, key);
        disk.pins[key] = fp;
      }
    }
    disk.lastAttemptAt = Math.max(disk.lastAttemptAt, ram.lastAttemptAt);
  }

  armStoreRetry() {
    if (this.storeTimer !== undefined || this.stopped) return;
    this.storeTimer = this.timers.setTimeout(() => {
      this.storeTimer = undefined;
      return this.serialize(() => this.reloadMemory()).catch((err) =>
        this.logger.error(`Reading /data failed (${err?.name ?? 'Error'})`),
      );
    }, INTERVALS.STORE_RETRY_MS);
  }

  /** The timer of an unreadable /data: read again, applied to the running configuration. */
  async reloadMemory() {
    if (!this.dataUnreadable || this.stopped) return;
    await this.loadMemory();
    if (this.dataUnreadable || !this.running || this.configProblem(this.config)) return;
    // A stop that came from /data alone is over: tried again (one handshake, nothing sent before the check).
    if (this.final?.code === CODES.PIN_UNAVAILABLE) this.final = null;
    await this.applyMemory(this.config);
    if (this.final) {
      await this.setStatus(false, this.final.message);
      this.clearLoopTimer();
      return;
    }
    this.schedule();
  }

  /** Writes /data (bounded). Never throws: the values stay in memory (a warning once). */
  async save() {
    if (this.dataUnreadable || !this.memory) return false;
    try {
      await this.within(
        Promise.resolve().then(() => this.store.save(serializeMemory(this.memory))),
        TIMEOUTS.STORE_MS,
      );
      this.saveWarned = false;
      return true;
    } catch (err) {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`The storage /data cannot be written (${err?.code ?? 'error'})`);
      }
      return false;
    }
  }

  // --- Start -------------------------------------------------------------------

  sessionKeyOf(config) {
    return JSON.stringify([
      config.secure,
      config.host,
      config.port,
      config.username,
      config.password,
      config.fingerprint,
    ]);
  }

  async doStart(rawConfig, { force = false } = {}) {
    if (this.stopped) return;
    this.pause();
    const config = normalizeConfig(rawConfig);
    const key = this.sessionKeyOf(config);
    this.config = config;
    await this.loadMemory();
    if (this.stopped) return;
    if (!this.session || this.session.key !== key) {
      this.session?.client?.close();
      this.resetSession();
      this.session = { key, client: null };
    }
    if (force) {
      this.acceptIdentity = true;
      if (this.final?.code === 'other_switch') this.final = null;
      // The password saved is always tried once, whatever its marker.
      if (this.memory.refused) {
        this.memory.refused = null;
        await this.save();
      }
      if (this.final?.code === CODES.CREDENTIALS) this.final = null;
    }
    // Stops that sent nothing and are not kept in /data are tried again at
    // each start (one TLS handshake, never the password before the check).
    if (['config', CODES.CERTIFICATE_TYPED, CODES.PIN_UNAVAILABLE].includes(this.final?.code)) {
      this.final = null;
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again.
    this.lastStatus = null;
    this.transports.clear();
    this.gladys.forgetPublishedStates?.();

    const invalid = this.configProblem(config);
    if (invalid) {
      this.final = { code: 'config', message: invalid };
      await this.publishDiscovered();
      await this.publishTransports();
      await this.setStatus(false, invalid);
      return;
    }
    await this.applyMemory(config);
    if (this.final && this.final.code !== CODES.CREDENTIALS) {
      // A final stop of this session (certificate, other switch): said again.
      await this.publishDiscovered();
      await this.publishTransports();
      await this.setStatus(false, this.final.message);
      return;
    }
    const session = this.session;
    session.client ??= new QswClient({
      secure: config.secure,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      checkPeer: (fingerprint) => this.checkPeer(session, fingerprint),
      ...(this.request ? { request: this.request } : {}),
    });
    this.retryDelay ??= this.minRetry();
    await this.publishDiscovered();
    if (this.fresh()) {
      // The last reading is younger than the interval (Gladys reconnected):
      // sent again from it; the switch is read again when the interval is over.
      await this.publishStates();
      await this.publishTransports();
      await this.setStatus(true, this.okMessage());
    } else {
      // The badge waits for the next reading (never "unreachable" before it).
      if (this.final) await this.publishTransports();
      await this.setStatus(
        false,
        this.final?.message ?? this.failureMessage ?? this.waitingMessage(),
      );
    }
    this.schedule();
  }

  configProblem(config) {
    if (config.hostError === 'missing') return T.status.hostMissing;
    if (config.hostError) return T.status.hostInvalid;
    if (config.usernameInvalid) return T.status.usernameInvalid;
    if (!config.password) return T.status.missingPassword;
    if (config.passwordInvalid) return T.status.passwordInvalid;
    if (config.fingerprint === null) return T.status.fingerprintInvalid;
    if (config.fingerprint && !config.secure) return T.status.fingerprintHttp;
    return null;
  }

  /** The refusal and the changed certificate kept in /data, against this configuration. */
  async applyMemory(config) {
    const m = this.memory;
    const key = targetKey(config);
    let dirty = false;
    if (this.appliedKey !== key) {
      // The pause and the cooldown of this address, onto the monotonic clock.
      const now = this.now();
      const mono = this.monotonic();
      this.pauseDue =
        m.pause?.key === key
          ? mono + clamp(m.pause.until - now, 0, INTERVALS.PAUSE_MAX_MS)
          : undefined;
      this.rebootMono =
        m.rebootAt?.key === key ? mono - Math.max(0, now - m.rebootAt.at) : undefined;
      this.appliedKey = key;
    }
    // A login refused stands only for the same address, user and password.
    if (m.refused) {
      if (this.refusedApplies()) {
        this.final = { code: CODES.CREDENTIALS, message: T.status.credentialsRefused };
      } else {
        m.refused = null;
        dirty = true;
        if (this.final?.code === CODES.CREDENTIALS) this.final = null;
      }
    }
    if (m.certChanged?.key === key) {
      if (config.fingerprint) {
        // A fingerprint typed is the authority: checkPeer imposes it (another
        // certificate is refused, showing the one really met, nothing sent).
        m.certChanged = null;
        dirty = true;
        if (this.final?.code === CODES.CERTIFICATE) this.final = null;
        this.logger.info('A certificate fingerprint was typed: it is the one trusted now');
      } else {
        this.final = {
          code: CODES.CERTIFICATE,
          message: T.status.certificateChanged(m.certChanged.seen),
        };
      }
    }
    if (dirty) await this.save();
  }

  refusedApplies() {
    const r = this.memory?.refused;
    const c = this.config;
    return Boolean(
      r &&
      r.key === targetKey(c) &&
      r.user === c.username &&
      r.tag === refusalTag(this.memory.salt, c.password),
    );
  }

  waitingMessage() {
    const mono = this.monotonic();
    return T.status.waiting(Math.max(0, this.dueAt(mono) - mono));
  }

  // --- The certificate ---------------------------------------------------------

  /**
   * HTTPS only, right after the TLS handshake, before any byte is written: the
   * certificate of the switch must be the fingerprint typed, else the pin
   * kept in /data; with neither, it is learned, written to /data BEFORE the
   * request goes. /data unreadable or not writable: nothing learned, nothing
   * sent.
   */
  async checkPeer(session, fingerprint) {
    if (session !== this.session) throw new SwitchError(CODES.LATE, 'Configuration changed');
    const m = this.memory;
    const key = this.key();
    const typed = this.config.fingerprint;
    if (typed) {
      if (fingerprint !== typed) {
        throw new SwitchError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', {
          fingerprint,
        });
      }
      if (m.pins[key] !== typed) {
        prunePins(m.pins, key);
        m.pins[key] = typed;
        if (m.certChanged?.key === key) m.certChanged = null;
        // Kept when /data allows it; the typed value is the reference anyway.
        await this.save();
      }
      return;
    }
    const pin = m.pins[key];
    if (pin) {
      if (fingerprint === pin) return;
      throw new SwitchError(CODES.CERTIFICATE, 'Another certificate', { fingerprint });
    }
    if (this.dataUnreadable) {
      throw new SwitchError(CODES.PIN_UNAVAILABLE, '/data unreadable', {
        reason: 'unreadable',
        fingerprint,
      });
    }
    prunePins(m.pins, key);
    m.pins[key] = fingerprint;
    if (!(await this.save())) {
      delete m.pins[key];
      throw new SwitchError(CODES.PIN_UNAVAILABLE, '/data not writable', {
        reason: 'unwritable',
        fingerprint,
      });
    }
    this.logger.info('HTTPS certificate of the switch learned and pinned');
  }

  // --- Pace ------------------------------------------------------------------

  /** The rest of the pause (ms, monotonic), capped to PAUSE_MAX at every use; 0 when none. */
  pauseLeft(mono) {
    if (this.pauseDue === undefined) return 0;
    return clamp(this.pauseDue - mono, 0, INTERVALS.PAUSE_MAX_MS);
  }

  /** The monotonic time from which the next reading may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.config.pollMs;
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next reading when it is due; none while a final failure stands. */
  schedule() {
    this.clearLoopTimer();
    if (!this.running || this.stopped || !this.session?.client || this.final) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`Loop failed (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) this.schedule();
  }

  /** One reading when it is due; a reading (or a command) running is never doubled. */
  tick({ evenRefused = false } = {}) {
    if (this.busy) return this.busy.catch(() => {});
    const run = this.read({ evenRefused }).finally(() => {
      if (this.busy === run) this.busy = undefined;
    });
    this.busy = run;
    return run;
  }

  async read({ evenRefused }) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running || this.stopped) return;
    // A refused login is never tried again by the loop: only the test button, once.
    if (this.final && !(evenRefused && this.final.code === CODES.CREDENTIALS)) return;
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) return;
    const gone = () => session !== this.session || !this.running || this.stopped;
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let sw;
    try {
      sw = await client.read({ timeLeft: () => mono + TIMEOUTS.READING_MS - this.monotonic() });
    } catch (err) {
      if (gone()) return;
      await this.failed(err);
      return;
    }
    if (gone()) return;
    await this.succeeded(sw, gone);
  }

  async saveAttempt(now) {
    this.memory.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= Math.min(INTERVALS.ATTEMPT_SAVE_MS, this.config.pollMs)
    ) {
      this.savedAttemptAt = now;
      await this.save();
    }
  }

  // --- Outcomes ----------------------------------------------------------------

  /** A reading (or the fresh read of a command) failed. Never throws. */
  async failed(err) {
    const wasOnline = this.online;
    this.online = false;
    const m = this.memory;
    const key = this.key();
    await this.publishTransports();
    switch (err?.code) {
      case CODES.CREDENTIALS:
        m.refused = {
          key,
          user: this.config.username,
          tag: refusalTag(m.salt, this.config.password),
        };
        this.final = { code: CODES.CREDENTIALS, message: T.status.credentialsRefused };
        this.session?.client?.close();
        await this.save();
        this.logger.warn(
          'The switch refused the user name or the password: not tried again until they are saved again',
        );
        return this.stopWithFinal();
      case CODES.CERTIFICATE:
        m.certChanged = { key, seen: err.fingerprint };
        this.final = {
          code: CODES.CERTIFICATE,
          message: T.status.certificateChanged(err.fingerprint),
        };
        await this.save();
        this.logger.warn('The HTTPS certificate of the switch is not the one pinned: nothing sent');
        return this.stopWithFinal();
      case CODES.CERTIFICATE_TYPED:
        this.final = {
          code: CODES.CERTIFICATE_TYPED,
          message: T.status.certificateTyped(err.fingerprint),
        };
        this.logger.warn('The HTTPS certificate of the switch is not the one typed: nothing sent');
        return this.stopWithFinal();
      case CODES.PIN_UNAVAILABLE:
        this.final = {
          code: CODES.PIN_UNAVAILABLE,
          message: T.status.pinUnavailable(err.reason, err.fingerprint),
        };
        this.logger.warn('The certificate of the switch cannot be kept in /data: nothing sent');
        return this.stopWithFinal();
      default:
        break;
    }
    const mono = this.monotonic();
    let message;
    if (isPause(err)) {
      const delay = clamp(
        err.retryAfterMs ?? this.retryDelay,
        Math.max(INTERVALS.PAUSE_MIN_MS, this.config.pollMs),
        INTERVALS.PAUSE_MAX_MS,
      );
      this.pauseDue = mono + delay;
      m.pause = { key, until: this.now() + delay, status: err.status };
      await this.save();
      message = T.status.paused(err.status, delay);
      if (err.status !== 429)
        this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    } else {
      const delay = this.retryDelay;
      this.nextTryAt = mono + delay;
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
      if (this.rebootingUntil !== undefined && mono < this.rebootingUntil) {
        message = T.status.rebooting(delay);
      } else if (err?.code === CODES.TLS) {
        message = T.status.tls(delay);
      } else {
        message = T.status.failure(err, delay, this.config.secure);
      }
    }
    // A SwitchError message never holds a secret nor an identifier; anything
    // else is reduced to its name. At most one line per retry (1 min or more).
    const what = err?.name === 'SwitchError' ? err.message : String(err?.name ?? 'error');
    this.logger[wasOnline ? 'warn' : 'info'](`The switch fails: ${what}`);
    this.failureMessage = message;
    await this.setStatus(false, message);
  }

  async stopWithFinal() {
    this.clearLoopTimer();
    await this.setStatus(false, this.final.message);
  }

  /** The salted hash of the MAC (the identity kept in /data), or null when unreadable. */
  identityTag(sw) {
    return sw?.mac ? hmac(this.memory.salt, `mac|${sw.mac}`) : null;
  }

  /** The rates since the previous statistics (kbit/s), on the monotonic clock. */
  ratesOf(sw, mono) {
    const prev = this.counters;
    const stats = sw.statistics;
    if (!stats) return null;
    this.counters = { mono, ports: stats };
    if (!prev || mono - prev.mono < 1000) return null;
    const seconds = (mono - prev.mono) / 1000;
    const ports = new Map();
    const total = { rx: 0, tx: 0 };
    for (let n = 1; n <= sw.portCount; n += 1) {
      const cur = stats.get(n);
      const old = prev.ports.get(n);
      const rx = kbps(cur?.rx, old?.rx, seconds);
      const tx = kbps(cur?.tx, old?.tx, seconds);
      ports.set(n, { rx, tx });
      total.rx = rx === null || total.rx === null ? null : total.rx + rx;
      total.tx = tx === null || total.tx === null ? null : total.tx + tx;
    }
    for (const dir of ['rx', 'tx']) {
      if (total[dir] !== null && total[dir] > LIMITS.RATE_KBPS) total[dir] = null;
    }
    return { ports, total };
  }

  async succeeded(sw, gone) {
    const m = this.memory;
    const key = this.key();
    // An answer: a pause asked before, the retries and a refused login are over.
    this.pauseDue = undefined;
    this.nextTryAt = undefined;
    this.retryDelay = this.minRetry();
    this.failureMessage = null;
    let dirty = false;
    if (m.pause) {
      m.pause = null;
      dirty = true;
    }
    if (m.refused) {
      m.refused = null;
      dirty = true;
    }
    if (this.final?.code === CODES.CREDENTIALS) {
      this.final = null;
      this.logger.info('The switch accepts the login again');
    }
    // The identity: the same switch as before at this address, else nothing
    // is published (its values would land on the device of another one).
    // /data unreadable: nothing learned (an identity is never made up).
    const tag = this.identityTag(sw);
    if (tag && !this.dataUnreadable) {
      if (m.identity?.key === key && m.identity.tag !== tag && !this.acceptIdentity) {
        if (dirty) await this.save();
        if (gone()) return;
        this.final = { code: 'other_switch', message: T.status.otherSwitch };
        this.online = false;
        this.logger.warn('Another switch answers at this address: nothing published');
        await this.publishTransports();
        return this.stopWithFinal();
      }
      if (m.identity?.key !== key || m.identity.tag !== tag) {
        m.identity = { key, tag };
        dirty = true;
      }
      this.acceptIdentity = false;
    }
    if (dirty) await this.save();
    if (gone()) return;
    this.followReboot(sw);
    const mono = this.monotonic();
    this.sw = { ...sw, rates: this.ratesOf(sw, mono) };
    this.online = true;
    this.lastOkAt = mono;
    const discoveredKey = JSON.stringify([sw.product, sw.model, sw.portCount]);
    if (discoveredKey !== this.discoveredKey) {
      await this.publishDiscovered();
      if (gone()) return;
      this.discoveredKey = discoveredKey;
    }
    await this.publishStates();
    if (gone()) return;
    await this.publishTransports();
    if (gone()) return;
    await this.setStatus(true, this.okMessage());
  }

  okMessage() {
    const sw = this.sw;
    return T.status.ok({
      label: sw?.product ?? sw?.model ?? null,
      up: sw ? portsUpOf(sw) : null,
      count: sw?.portCount ?? null,
      missing: sw?.missing ?? [],
    });
  }

  /** After a reboot sent: confirmed by a smaller uptime, or said not applied. */
  followReboot(sw) {
    const pending = this.rebootPending;
    if (!pending) return;
    const elapsed = this.monotonic() - pending.at;
    if (sw.uptime !== null && sw.uptime * 1000 < elapsed + 60_000) {
      this.logger.info('Reboot of the switch confirmed (uptime started again)');
      this.rebootPending = null;
    } else if (elapsed > COMMAND.REBOOTING_MS) {
      this.logger.warn('The switch did not reboot (its uptime goes on, or is not read)');
      this.rebootPending = null;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify({ connected, message });
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent (${err?.name ?? 'Error'})`);
    });
  }

  // --- Gladys side -------------------------------------------------------------

  /** Never throws: a refusal of Gladys is not a failure of the switch. */
  async publishDiscovered() {
    await this.gladys
      .publishDiscoveredDevices([buildSwitchDevice(this.gladys, this.sw ?? {})])
      .catch((err) => this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`));
  }

  /** Discovery (scan button): what is known, never a reading (the next one comes at its time). */
  async publishDiscovery() {
    await this.publishDiscovered();
  }

  /** Online, with a reading younger than the interval: its values may be sent (again). */
  fresh() {
    return (
      this.online &&
      this.lastOkAt !== undefined &&
      this.monotonic() - this.lastOkAt < this.config.pollMs
    );
  }

  async publishStates() {
    if (!this.fresh()) return;
    await this.publisher.publish(statesOf(this.gladys, this.sw));
  }

  async publishTransports() {
    const created = createdSwitch(this.gladys);
    if (!created) return;
    const transport = this.online ? 'local' : 'unreachable';
    if (this.transports.get(created.external_id) === transport) return;
    this.transports.set(created.external_id, transport);
    await this.gladys
      .publishTransports([{ external_id: created.external_id, transport }])
      .catch((err) => {
        this.transports.delete(created.external_id);
        this.logger.debug(`Transport not published (${err?.name ?? 'Error'})`);
      });
  }

  /** A device created or updated: its values now (the last reading, never older than the interval). */
  async deviceCreated(device) {
    if (typeof device?.external_id === 'string') {
      this.gladys.forgetPublishedStates?.(device.external_id);
      this.transports.delete(device.external_id);
    }
    await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    if (typeof device?.external_id === 'string') this.transports.delete(device.external_id);
  }

  // --- The reboot command ------------------------------------------------------

  /**
   * A command from Gladys. Only the reboot button acts; every reading
   * refuses. Resolves when the switch accepted the reboot.
   */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const key = featureOf(this.gladys, feature?.external_id);
    if (key === undefined || key === null) throw userError(T.errors.unknownDevice);
    if (key !== FEATURES.REBOOT) throw userError(T.errors.readOnly);
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw userError(T.errors.badValue);
    if (!this.config.allowReboot) throw userError(T.errors.rebootDisabled);
    if (this.inFlight) throw userError(T.errors.stillRunning);
    const run = this.reboot(received);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /**
   * The checks of the reboot, on the latest configuration: before the read
   * and right before sending. A reboot does not wait for the readings to come
   * back (an outage, the retry delay): its own fresh read decides.
   */
  checkReboot(session, mono) {
    if (!this.config.allowReboot) throw userError(T.errors.rebootDisabled);
    if (this.final?.code === 'other_switch') throw userError(T.errors.otherSwitch);
    if (session !== this.session || !session?.client || !this.running || this.final) {
      throw userError(T.errors.notConnected);
    }
    if (this.dataUnreadable) throw userError(T.errors.identityUnknown);
    const pause = this.pauseLeft(mono);
    if (pause > 0) throw userError(T.errors.paused(pause));
    if (this.rebootMono !== undefined) {
      // A reboot "in the future" (a clock set back in /data) counts as one now.
      const ago = Math.max(0, mono - this.rebootMono);
      if (ago < COMMAND.COOLDOWN_MS) throw userError(T.errors.cooldown(COMMAND.COOLDOWN_MS - ago));
    }
  }

  /** A failure of the command that the loop must follow (final, pause): the usual path. */
  follow(err) {
    if (!isPause(err) && !isFinal(err)) return;
    this.following = this.failed(err).catch(() => {});
  }

  async reboot(received) {
    const session = this.session;
    const client = session?.client;
    this.checkReboot(session, received);
    // The reading in flight finishes first (one request at a time), within the read budget.
    if (this.busy) {
      let late = false;
      await this.within(
        this.busy.catch(() => {}),
        Math.max(0, received + COMMAND.READ_BY_MS - this.monotonic()),
      ).catch(() => {
        late = true;
      });
      if (late || this.busy) throw userError(T.errors.tooSlow);
    }
    const run = this.rebootSteps(received, session, client);
    this.busy = run;
    try {
      return await run;
    } finally {
      if (this.busy === run) this.busy = undefined;
    }
  }

  async rebootSteps(received, session, client) {
    // The switch read just before acting, never the one in memory: it must
    // answer, and be the very switch read before (the same MAC).
    const readLeft = () => received + COMMAND.READ_BY_MS - this.monotonic();
    let fresh;
    try {
      fresh = await client.board({ timeLeft: readLeft });
    } catch (err) {
      this.follow(err);
      if (err?.code === CODES.TIMEOUT || err?.code === CODES.LATE) {
        throw userError(T.errors.tooSlow, err);
      }
      throw userError(T.errors.unknownState(reasonOf(err).en), err);
    }
    // A read that ended after its budget leaves no time to act safely.
    if (readLeft() < 0) throw userError(T.errors.tooSlow);
    const tag = this.identityTag(fresh);
    const known = this.memory.identity;
    if (!tag || this.dataUnreadable || known?.key !== this.key()) {
      throw userError(T.errors.identityUnknown);
    }
    if (known.tag !== tag) throw userError(T.errors.otherSwitch);
    // The option may have been turned off during the read: checked again.
    const sendBy = received + COMMAND.SEND_BY_MS;
    let mono = this.monotonic();
    this.checkReboot(session, mono);
    if (mono > sendBy) throw userError(T.errors.tooSlow);
    // The cooldown is kept BEFORE the first byte: a restart right after keeps it.
    const before = { at: this.memory.rebootAt, mono: this.rebootMono };
    this.memory.rebootAt = { key: this.key(), at: this.now() };
    this.rebootMono = mono;
    const undo = () => {
      this.memory.rebootAt = before.at;
      this.rebootMono = before.mono;
      return this.save();
    };
    // The cooldown must survive a restart: /data unreadable or not writable,
    // nothing is sent.
    if (!(await this.save())) {
      this.memory.rebootAt = before.at;
      this.rebootMono = before.mono;
      throw userError(T.errors.cooldownNotKept);
    }
    mono = this.monotonic();
    if (mono > sendBy || session !== this.session) {
      await undo();
      throw userError(T.errors.tooSlow);
    }
    this.logger.info('Reboot of the switch requested from Gladys');
    try {
      await client.reboot({
        timeLeft: () => received + COMMAND.ANSWER_BY_MS - this.monotonic(),
        // The very last check, right before the request is written (after the
        // TCP and TLS handshakes): the option, the session, the deadline.
        beforeSend: () => {
          const at = this.monotonic();
          if (!this.config.allowReboot) throw userError(T.errors.rebootDisabled);
          if (session !== this.session || !this.running || this.stopped) {
            throw userError(T.errors.notConnected);
          }
          if (at > sendBy) throw userError(T.errors.tooSlow);
        },
      });
    } catch (err) {
      if (err?.user) {
        await undo();
        throw err;
      }
      const reason = reasonOf(err).en;
      this.logger.warn(
        `Reboot of the switch: ${err?.name === 'SwitchError' ? err.message : 'error'}`,
      );
      this.follow(err);
      if (err?.notSent) {
        await undo();
        throw userError(T.errors.notSent(reason), err);
      }
      const answered =
        err?.code === CODES.ACCESS ||
        err?.code === CODES.REDIRECT ||
        err?.code === CODES.BAD_ANSWER ||
        (err?.code === CODES.HTTP && err.status < 500);
      if (answered) {
        // The switch answered "no": it is not rebooting.
        await undo();
        throw userError(T.errors.refused(reason), err);
      }
      // A 5xx, a silence, a cut answer after the request was written: it may
      // have reached the switch.
      this.rebooted();
      throw userError(T.errors.sentUnconfirmed(reason), err);
    }
    this.rebooted();
  }

  rebooted() {
    const mono = this.monotonic();
    this.rebootPending = { at: mono };
    this.rebootingUntil = mono + COMMAND.REBOOTING_MS;
  }

  // --- Configuration button --------------------------------------------------

  /**
   * Reads when a reading is due (never sooner than the interval), then
   * reports within 28 s. A refused login is tried once (it is lifted only by
   * a success); a changed certificate or a pause is not lifted. The reading
   * counts as the one of the loop: the next one comes an interval after it.
   */
  async testConnection() {
    try {
      await this.within(
        (async () => {
          await this.lifecycle;
          await this.tick({ evenRefused: true });
        })(),
        TEST_BUDGET_MS,
      );
    } catch (err) {
      if (err?.code === 'ETIMEDOUT') throw new Error(T.errors.testTooLong, { cause: err });
      throw err;
    }
    if (this.running && !this.final) this.schedule();
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus).message : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok(this.okMessage());
  }
}
