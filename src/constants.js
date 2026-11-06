// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user scenes and devices: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/**
 * Device external id: `ext:<selector>:switch:main`, one switch per
 * installation (the address of the configuration). Fixed: it never depends
 * on the MAC, the name or the model; the switch it belongs to is checked at
 * every reading by a salted hash of its MAC (src/app.js), so that another
 * switch at the address never gets its values nor its reboot.
 */
export const SWITCH_TYPE = 'switch';
export const SWITCH_ID = 'main';

/** The features of the switch itself. */
export const FEATURES = Object.freeze({
  PORTS_UP: 'ports_up',
  TEMPERATURE: 'temperature',
  FAN1: 'fan1',
  FAN2: 'fan2',
  RX_RATE: 'rx_rate',
  TX_RATE: 'tx_rate',
  UPTIME: 'uptime',
  FIRMWARE: 'firmware',
  REBOOT: 'reboot',
});

/** The features of each physical port n: `port_<n>_<key>`. */
export const PORT_FEATURES = Object.freeze({
  LINK: 'link',
  SPEED: 'speed',
  RX_RATE: 'rx',
  TX_RATE: 'tx',
});

/** Seconds between two readings. */
export const POLL_INTERVALS = Object.freeze(['30', '60', '120', '300']);

export const DEFAULT_PORTS = Object.freeze({ https: 443, http: 80 });

export const LIMITS = Object.freeze({
  /** POST /state admits 300 states per minute per integration: we keep under 250. */
  STATES_PER_MINUTE: 250,
  /** A text published to Gladys (model, firmware) is cut to this length. */
  TEXT_LENGTH: 64,
  /** Physical ports read (the largest QSW has 28): more is not a QSW answer. */
  PORTS: 64,
  /** Entries of a port list read from one answer (physical + LACP). */
  PORT_ENTRIES: 256,
  /** Size cap of an answer (the port lists are the largest, a few KB). */
  ANSWER_BYTES: 256 * 1024,
  /** Size cap of the /data file read back. */
  STORE_BYTES: 16 * 1024,
  /** A rate above this (kbit/s, 100 Gbit/s) is not a rate of a QSW port: not published. */
  RATE_KBPS: 100_000_000,
});

export const TIMEOUTS = Object.freeze({
  /** One request to the switch (TCP and TLS handshakes included). */
  REQUEST_MS: 10_000,
  /** A whole reading (six requests one after the other). */
  READING_MS: 25_000,
  /** One read or write of /data: beyond it, taken as failed (never awaited without end). */
  STORE_MS: 5_000,
});

export const INTERVALS = Object.freeze({
  /** A failure (network, unexpected answer) is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 30 * 60_000,
  /** HTTP 429 / 5xx on a main route: pause of every request, within these bounds (Retry-After if given). */
  PAUSE_MIN_MS: 60_000,
  PAUSE_MAX_MS: 6 * 3600_000,
  /** The time of the last attempt is written to /data at most this often. */
  ATTEMPT_SAVE_MS: 60_000,
  /** Configuration not given by Gladys: asked again from this delay, doubling up to the max. */
  CONFIG_RETRY_MIN_MS: 30_000,
  CONFIG_RETRY_MAX_MS: 10 * 60_000,
  /** /data unreadable or slow: read again this often, one read at a time. */
  STORE_RETRY_MS: 10_000,
  /** A secondary route refusing the session is asked again at most this far apart. */
  SECONDARY_MAX_MS: 3600_000,
  /** Unchanged values are sent again this often (the core shows them as fresh). */
  HEARTBEAT_MS: 30 * 60_000,
  /** A stop waits this long at most for the reading in flight. */
  STOP_WAIT_MS: 3_000,
});

/** The reboot command: deadlines counted from its arrival (Gladys acks within 5 s). */
export const COMMAND = Object.freeze({
  /** The fresh reading of the switch (its identity) must end by then. */
  READ_BY_MS: 2_500,
  /** The reboot request is refused unsent after this. */
  SEND_BY_MS: 3_500,
  /** The answer of the switch is awaited until this. */
  ANSWER_BY_MS: 4_500,
  /** No second reboot before this delay (a scene in a loop): kept in /data. */
  COOLDOWN_MS: 10 * 60_000,
  /** After a reboot sent, a failing reading says "rebooting" this long. */
  REBOOTING_MS: 5 * 60_000,
});

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The persistent store (see src/store.js). */
export const STORE_FILE = '/data/qsw-state.json';

/** The User-Agent of every request: the integration says who it is, never a browser. */
export const USER_AGENT = 'gladys-qnap-qsw (+https://github.com/LM1LC3N7/gladys-qnap-qsw)';
