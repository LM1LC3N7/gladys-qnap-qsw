// -----------------------------------------------------------------------------
// The answers of QSS -> plain values: strict numbers, unknown never 0, the
// physical ports only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  counter,
  integer,
  macOf,
  parseBoard,
  parseFirmware,
  parsePortsStatistics,
  parsePortsStatus,
  parseSensor,
  parseTime,
} from '../src/qsw/parse.js';
import * as F from './fixtures/qsw.js';

test('board: MAC normalized, product, port count bounded; a broken board is refused', () => {
  assert.deepEqual(parseBoard(F.board()), {
    mac: '245ebe001122',
    product: 'QSW-M408-4C',
    model: 'M408',
    portCount: 12,
  });
  assert.equal(parseBoard(F.board({ mac: 'MAC' })).mac, null, 'unreadable, never another');
  assert.throws(() => parseBoard(F.board({ ports: 0 })), /port count/);
  assert.throws(() => parseBoard(F.board({ ports: 65 })), /port count/);
  assert.throws(() => parseBoard(F.board({ ports: '12.5' })), /port count/);
  assert.throws(() => parseBoard({ error_code: 500, result: {} }), /error code/);
  assert.throws(() => parseBoard({ error_code: 200 }), /no result/);
  assert.throws(() => parseBoard([]), /not an object/);
  assert.equal(macOf('00:00:00:00:00:00'), null);
  assert.equal(macOf('ff-ff-ff-ff-ff-ff'), null);
});

test('numbers are strict: empty is unknown, never 0; decimals refused for integers', () => {
  assert.equal(integer('', 0, 10), null);
  assert.equal(integer(' ', 0, 10), null);
  assert.equal(integer(null, 0, 10), null);
  assert.equal(integer('1.5', 0, 10), null);
  assert.equal(integer(1.5, 0, 10), null);
  assert.equal(integer('7', 0, 10), 7);
  assert.equal(integer(11, 0, 10), null);
  assert.equal(counter('18446744073709551615'), 18446744073709551615n);
  assert.equal(counter('18446744073709551616'), null);
  assert.equal(counter(-1), null);
  assert.equal(counter(''), null);
  assert.equal(counter(1.5), null);
});

test('sensor: a negative fan is no fan; the temperature bounded', () => {
  assert.deepEqual(parseSensor(F.sensor()), { temperature: 31, fan1: 1991, fan2: null });
  assert.equal(parseSensor(F.sensor({ temp: 400 })).temperature, null);
  assert.equal(parseSensor(F.sensor({ temp: '' })).temperature, null);
  assert.equal(parseSensor({ result: {} }).temperature, null);
});

test('time and firmware', () => {
  assert.deepEqual(parseTime(F.time({ uptime: 3600 })), { uptime: 3600 });
  assert.deepEqual(parseTime(F.time({ uptime: -1 })), { uptime: null });
  assert.deepEqual(parseFirmware(F.firmware()), { firmware: '1.2.0.29649 (20220128)' });
  assert.deepEqual(parseFirmware({ result: { version: '' } }), { firmware: null });
  assert.equal(cleanText('a\u0000b\n'), 'ab');
  assert.equal(cleanText('x'.repeat(100)).length, 64);
});

test('ports: physical ones only (LACP keys after PortNum ignored); a port down has speed 0', () => {
  const status = parsePortsStatus(F.portsStatus(), 12);
  assert.equal(status.size, 12);
  assert.deepEqual(status.get(1), { link: true, speed: 10000 });
  assert.deepEqual(status.get(3), { link: true, speed: 100 });
  assert.deepEqual(status.get(4), { link: false, speed: 0 });
  assert.equal(status.get(29), undefined);
  const odd = parsePortsStatus(
    {
      result: [
        { key: '1', val: { Link: 'yes', Speed: '1000' } },
        { key: '1', val: { Link: false } },
        { key: '__proto__', val: {} },
        { key: '2' },
      ],
    },
    4,
  );
  assert.deepEqual(odd.get(1), { link: null, speed: null }, 'the first entry of a key only');
  assert.equal(odd.size, 1);
  const stats = parsePortsStatistics(
    F.portsStatistics((n) => [n * 10, n]),
    12,
  );
  assert.deepEqual(stats.get(2), { rx: 20n, tx: 2n });
  assert.equal(stats.size, 12);
  assert.throws(() => parsePortsStatus({ result: {} }, 12), /ports status/);
});

test('a port list is bounded', () => {
  const big = {
    result: Array.from({ length: 100_000 }, (_, i) => ({ key: String(i + 1), val: {} })),
  };
  const start = performance.now();
  const status = parsePortsStatus(big, 64);
  assert.ok(performance.now() - start < 500);
  assert.equal(status.size, 64);
});
