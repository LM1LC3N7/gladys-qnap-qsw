// -----------------------------------------------------------------------------
// A fake QSW switch in memory: the transport of src/qsw/http.js, with the
// same contract (checkPeer awaited in HTTPS, then beforeSend, then the
// request is "written"; a failure there marks the error notSent). Every
// request the switch received is recorded in `sent`, every connection in
// `connections`.
// -----------------------------------------------------------------------------

import { CODES, SwitchError } from '../../src/qsw/errors.js';
import { PATHS } from '../../src/qsw/client.js';
import * as F from '../fixtures/qsw.js';

export const FINGERPRINT =
  'AA:11:BB:22:CC:33:DD:44:EE:55:FF:66:00:77:11:88:22:99:33:AA:44:BB:55:CC:66:DD:77:EE:88:FF:99:00';
export const OTHER_FINGERPRINT =
  '0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0';

const json = (value, headers = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(value)),
});

export function createFakeSwitch({
  fingerprint = FINGERPRINT,
  username = F.USERNAME,
  password = F.PASSWORD,
} = {}) {
  const sw = {
    fingerprint,
    username,
    password,
    mac: F.MAC,
    ports: 12,
    temp: 31,
    uptime: 91,
    links: undefined,
    /** Byte counters of each port: [rx, tx]. */
    octets: new Map(),
    /** 'down' | 'timeout' | null */
    state: null,
    /** path -> { response, times } forced once or always. */
    overrides: new Map(),
    sessions: new Set(),
    connections: 0,
    sent: [],
    reboots: 0,
    logins: 0,
    /** Called with each request before it is answered (a test may await there). */
    hook: null,
    override(path, response, times = Infinity) {
      sw.overrides.set(path, { response, times });
    },
    expireSessions() {
      sw.sessions.clear();
    },
    count(path) {
      return sw.sent.filter((r) => r.path === path).length;
    },
    /** Called before the connection is up (a slow TCP or TLS handshake). */
    connectHook: null,
    async request(target, options) {
      sw.connections += 1;
      await sw.connectHook?.(target);
      if (sw.state === 'down') {
        throw new SwitchError(CODES.UNREACHABLE, 'ECONNREFUSED', { notSent: true });
      }
      try {
        if (target.secure !== false) await options.checkPeer(sw.fingerprint);
        options.beforeSend?.();
      } catch (err) {
        throw Object.assign(err, { notSent: true });
      }
      const entry = {
        method: target.method,
        path: target.path,
        secure: target.secure,
        headers: { ...options.headers },
        body: options.body,
        timeout: options.timeout,
      };
      sw.sent.push(entry);
      await sw.hook?.(entry);
      if (sw.state === 'timeout') {
        throw new SwitchError(CODES.TIMEOUT, 'No answer within 10 s', { notSent: false });
      }
      const forced = sw.overrides.get(target.path);
      if (forced && forced.times > 0) {
        forced.times -= 1;
        const r = typeof forced.response === 'function' ? forced.response(entry) : forced.response;
        if (r instanceof Error) throw r;
        return {
          status: r.status,
          headers: r.headers ?? {},
          body: Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '')),
        };
      }
      const token = /QSW_ID=([^;\s]+)/.exec(options.headers?.cookie ?? '')?.[1];
      const authed = () =>
        token && sw.sessions.has(token) && options.headers?.authorization === `Bearer ${token}`;
      const denied = { status: 401, headers: {}, body: Buffer.from('') };
      if (target.path === PATHS.LOGIN && target.method === 'POST') {
        sw.logins += 1;
        const body = JSON.parse(options.body);
        const pass = Buffer.from(body.password, 'base64').toString('utf8');
        if (body.username !== sw.username || pass !== sw.password) return denied;
        const t = `${F.TOKEN}${sw.sessions.size}`;
        sw.sessions.add(t);
        return json({ error_code: 200, error_message: 'OK', result: t });
      }
      if (!authed()) return denied;
      if (target.method === 'GET') {
        switch (target.path) {
          case PATHS.BOARD:
            return json(F.board({ mac: sw.mac, ports: sw.ports }));
          case PATHS.PORTS_STATUS:
            return json(F.portsStatus(sw.links ? { links: sw.links } : {}));
          case PATHS.PORTS_STATISTICS:
            return json(F.portsStatistics((n) => sw.octets.get(n) ?? [0, 0]));
          case PATHS.SENSOR:
            return json(F.sensor({ temp: sw.temp }));
          case PATHS.TIME:
            return json(F.time({ uptime: sw.uptime }));
          case PATHS.FIRMWARE:
            return json(F.firmware());
          default:
            break;
        }
      }
      if (target.path === PATHS.COMMAND && target.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.command !== 'reboot') return { status: 400, headers: {}, body: Buffer.from('') };
        sw.reboots += 1;
        return json({ error_code: 200, error_message: 'OK', result: 'None' });
      }
      return { status: 404, headers: {}, body: Buffer.from('') };
    },
  };
  sw.request = sw.request.bind(sw);
  return sw;
}
