// -----------------------------------------------------------------------------
// The QSS web API of one QNAP QSW switch, after aioqsw (Apache-2.0, Noltari;
// see THIRD_PARTY_NOTICES.md):
//
//   POST /api/v1/users/login   {"username", "password": base64(password)}
//                              -> { result: <token> }
//   then every request carries the cookies QSW_LANG=ENG and QSW_ID=<token>
//   and the header Authorization: Bearer <token>
//   GET  /api/v1/system/board, /ports/status        (main: a reading needs them)
//   GET  /api/v1/ports/statistics, /system/sensor,
//        /system/time, /firmware/info               (secondary: never blocking)
//   POST /api/v1/system/command {"command": "reboot"} -> { result: "None" }
//
// One request at a time (a reading is sequential), each on its own connection.
// The session token is kept and used again; a route refusing it (401/403)
// opens a new session once in the same reading. Only the login route can
// refuse the credentials: a 401/403 elsewhere, an unreadable or cut answer,
// are never a refusal of the credentials. Nothing else of the library is
// ported (firmware update, configuration backup): this integration never
// writes anything but the reboot, behind its option.
//
// The password and the token only go into the request; never into a log, an
// error message or /data. In HTTPS, only on a connection whose certificate
// was checked first (src/qsw/http.js).
// -----------------------------------------------------------------------------

import { LIMITS, TIMEOUTS } from '../constants.js';
import { CODES, SwitchError, isFinal } from './errors.js';
import { switchRequest } from './http.js';
import {
  parseBoard,
  parseFirmware,
  parsePortsStatistics,
  parsePortsStatus,
  parseSensor,
  parseTime,
  resultOf,
} from './parse.js';

/** A token we may send back in a cookie and a header: printable ASCII, no `;` nor space, bounded. */
const TOKEN = /^[\x21-\x3a\x3c-\x7e]{1,512}$/;

export const PATHS = Object.freeze({
  LOGIN: '/api/v1/users/login',
  BOARD: '/api/v1/system/board',
  PORTS_STATUS: '/api/v1/ports/status',
  PORTS_STATISTICS: '/api/v1/ports/statistics',
  SENSOR: '/api/v1/system/sensor',
  TIME: '/api/v1/system/time',
  FIRMWARE: '/api/v1/firmware/info',
  COMMAND: '/api/v1/system/command',
});

/** The Retry-After of an answer, in ms (seconds only), or undefined. */
function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

function jsonOf(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new SwitchError(CODES.BAD_ANSWER, 'The answer is not JSON');
  }
}

const refused = (status) => status === 401 || status === 403;

export class QswClient {
  /**
   * @param {object} options
   * @param {boolean} options.secure HTTPS (true) or plain HTTP
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.username
   * @param {string} options.password
   * @param {(fingerprint: string) => Promise<void>|void} options.checkPeer
   * @param {Function} [options.request] the transport (tests inject a fake switch)
   */
  constructor({ secure, host, port, username, password, checkPeer, request = switchRequest }) {
    this.target = { secure, host, port };
    this.username = username;
    this.password = password;
    this.checkPeer = checkPeer;
    this.request = request;
    /** The token of the open session, or null. */
    this.token = null;
  }

  close() {
    this.token = null;
  }

  async send(method, path, { headers, body, timeLeft, beforeSend }) {
    const left = timeLeft();
    if (!(left > 0)) throw new SwitchError(CODES.LATE, 'No time left', { notSent: true });
    return this.request(
      { ...this.target, method, path },
      {
        headers,
        body,
        maxBytes: LIMITS.ANSWER_BYTES,
        timeout: Math.max(1, Math.min(left, TIMEOUTS.REQUEST_MS)),
        checkPeer: this.checkPeer,
        beforeSend,
      },
    );
  }

  /** An answer that is not a success: the matching SwitchError. */
  static failure(res) {
    const status = res.status;
    if (status >= 300 && status < 400) {
      return new SwitchError(CODES.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    return new SwitchError(CODES.HTTP, `HTTP ${status}`, {
      status,
      retryAfterMs: retryAfterOf(res.headers),
    });
  }

  /** Opens a session. Throws CODES.CREDENTIALS on a refusal of the login route only. */
  async login(timeLeft) {
    this.token = null;
    const res = await this.send('POST', PATHS.LOGIN, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: Buffer.from(this.password, 'utf8').toString('base64'),
      }),
      timeLeft,
    });
    if (refused(res.status)) {
      throw new SwitchError(CODES.CREDENTIALS, `Login refused (HTTP ${res.status})`, {
        status: res.status,
      });
    }
    if (res.status !== 200) throw QswClient.failure(res);
    const token = resultOf(jsonOf(res.body));
    if (typeof token !== 'string' || !TOKEN.test(token) || token === 'None') {
      throw new SwitchError(CODES.BAD_ANSWER, 'No session token');
    }
    this.token = token;
  }

  authHeaders() {
    return {
      cookie: `QSW_LANG=ENG; QSW_ID=${this.token}`,
      authorization: `Bearer ${this.token}`,
    };
  }

  /**
   * GET a route of the API, its JSON. Opens a session when none is open; a
   * session refused is opened again once per reading (`ctx.fresh`).
   */
  async get(path, ctx, timeLeft) {
    if (!this.token) {
      await this.login(timeLeft);
      ctx.fresh = true;
    }
    for (;;) {
      const res = await this.send('GET', path, { headers: this.authHeaders(), timeLeft });
      if (refused(res.status) && !ctx.fresh) {
        // The session expired (or the switch restarted): a new one, once.
        await this.login(timeLeft);
        ctx.fresh = true;
        continue;
      }
      if (refused(res.status)) {
        this.token = null;
        throw new SwitchError(CODES.ACCESS, `Refused after login (HTTP ${res.status})`, {
          status: res.status,
        });
      }
      if (res.status !== 200) throw QswClient.failure(res);
      return jsonOf(res.body);
    }
  }

  /**
   * One reading. The board and the port status are needed (their failure
   * fails the reading); the statistics, the sensors, the uptime and the
   * firmware are read when they answer, never blocking (`missing` lists the
   * ones that did not). A failure that stops everything (certificate, login
   * refused) is never swallowed. `timeLeft()` -> ms left for the whole reading.
   */
  async read({ timeLeft }) {
    const ctx = { fresh: false };
    const board = parseBoard(await this.get(PATHS.BOARD, ctx, timeLeft));
    const status = parsePortsStatus(
      await this.get(PATHS.PORTS_STATUS, ctx, timeLeft),
      board.portCount,
    );
    const missing = [];
    const secondary = async (name, path, parse) => {
      try {
        return parse(await this.get(path, ctx, timeLeft));
      } catch (err) {
        if (isFinal(err)) throw err;
        missing.push(name);
        return null;
      }
    };
    const statistics = await secondary('statistics', PATHS.PORTS_STATISTICS, (a) =>
      parsePortsStatistics(a, board.portCount),
    );
    const sensor = await secondary('sensor', PATHS.SENSOR, parseSensor);
    const time = await secondary('time', PATHS.TIME, parseTime);
    const firmware = await secondary('firmware', PATHS.FIRMWARE, parseFirmware);
    return {
      ...board,
      status,
      statistics,
      temperature: sensor?.temperature ?? null,
      fan1: sensor?.fan1 ?? null,
      fan2: sensor?.fan2 ?? null,
      uptime: time?.uptime ?? null,
      firmware: firmware?.firmware ?? null,
      missing,
    };
  }

  /** The board only (the identity), for the fresh read of a command. */
  async board({ timeLeft }) {
    return parseBoard(await this.get(PATHS.BOARD, { fresh: false }, timeLeft));
  }

  /**
   * The reboot, on the session of the fresh read just before. One request,
   * never retried. `beforeSend` runs right before it is written. Resolves
   * when the switch answered `result: "None"` (aioqsw's success).
   */
  async reboot({ timeLeft, beforeSend }) {
    if (!this.token) {
      throw new SwitchError(CODES.ACCESS, 'No session', { notSent: true });
    }
    const res = await this.send('POST', PATHS.COMMAND, {
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'reboot' }),
      timeLeft,
      beforeSend,
    });
    if (refused(res.status)) {
      this.token = null;
      throw new SwitchError(CODES.ACCESS, `Reboot refused (HTTP ${res.status})`, {
        status: res.status,
      });
    }
    if (res.status !== 200) throw QswClient.failure(res);
    if (resultOf(jsonOf(res.body)) !== 'None') {
      throw new SwitchError(CODES.BAD_ANSWER, 'The switch did not accept the reboot');
    }
  }
}
