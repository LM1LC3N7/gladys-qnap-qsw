// -----------------------------------------------------------------------------
// Answers of a QSW-M408-4C, shaped after the fixtures of the Home Assistant
// `qnap_qsw` tests (built on aioqsw), with fake identifiers: 12 physical
// ports, then the LACP groups (keys 29-34), a second fan absent (-2).
// -----------------------------------------------------------------------------

export const USERNAME = 'admin';
export const PASSWORD = 'pa:ss w0rd-é';
export const TOKEN = 'TOKEN-0123456789abcdef';
export const MAC = '24:5E:BE:00:11:22';
export const OTHER_MAC = '24:5E:BE:99:88:77';

const ok = (result) => ({ error_code: 200, error_message: 'OK', result });

export const board = ({ mac = MAC, ports = 12 } = {}) =>
  ok({
    MacAddr: mac,
    SerialNumber: 'Q000A00000',
    ChipId: 'ALLEYCAT3',
    Model: 'M408',
    Product: 'QSW-M408-4C',
    PortNum: ports,
    TrunkNum: 0,
  });

export const sensor = ({ temp = 31, fan1 = 1991, fan2 = -2 } = {}) =>
  ok({ Fan1Speed: fan1, Fan2Speed: fan2, MaxSwitchTemp: 85, SwitchTemp: temp });

export const time = ({ uptime = 91 } = {}) => ok({ UpTime: uptime });

export const firmware = () =>
  ok({
    version: '1.2.0',
    date: '20220128',
    pubDate: 'Fri, 28 Jan 2022 01:17:39 +0800',
    buildNumber: '20220128',
    number: '29649',
    ci_commit: 'b2eb4c8ffb549995aeb4f9c4e645c6d882997c17',
    ci_branch: 'm408/codesigning',
    ci_pipeline: '9898',
    commit_cpss: '',
    commit_iss: '448a3208e5ea744c393b2580f4b9733add9c2faa',
  });

const KEYS = [...Array.from({ length: 12 }, (_, i) => i + 1), 29, 30, 31, 32, 33, 34];

/** Port 1 at 10 Gbit/s, 2 at 1 Gbit/s, 3 at 100 Mbit/s, the others down. */
export const portsStatus = ({ links = { 1: '10000', 2: '1000', 3: '100' } } = {}) =>
  ok(
    KEYS.map((key) => ({
      key: String(key),
      val: {
        Link: key in links,
        FullDuplexStatus: key in links && key !== 3,
        Speed: links[key] ?? (key > 12 ? '0' : '1000'),
      },
    })),
  );

/** Byte counters: `octets(n)` -> [rx, tx] of port n. */
export const portsStatistics = (octets = () => [0, 0]) =>
  ok(
    KEYS.map((key) => {
      const [rx, tx] = octets(key);
      return { key: String(key), val: { RxOctets: rx, RxErrors: 0, TxOctets: tx, FCSErrors: 0 } };
    }),
  );
