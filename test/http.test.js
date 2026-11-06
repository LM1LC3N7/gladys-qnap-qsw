// -----------------------------------------------------------------------------
// The transport against real servers on loopback: HTTPS with a self-signed
// certificate like the one of a QSW (the fingerprint checked before a byte of
// the request is written), plain HTTP, one connection per request, a size cap
// counted while the answer arrives, a deadline, no redirect followed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:https';
import { createServer as createTlsServer } from 'node:tls';
import { createServer as createNetServer } from 'node:net';
import { CODES } from '../src/qsw/errors.js';
import { switchRequest } from '../src/qsw/http.js';
import { selfSigned } from './helpers/selfSigned.js';

const CERT = selfSigned('QSW');

async function server(handler, { secure = true } = {}) {
  const requests = [];
  let connections = 0;
  let bytes = 0;
  const onRequest = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  };
  const srv = secure
    ? createServer({ key: CERT.key, cert: CERT.cert }, onRequest)
    : createHttpServer(onRequest);
  srv.on(secure ? 'secureConnection' : 'connection', (socket) => {
    connections += 1;
    socket.on('data', (d) => (bytes += d.length));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: srv.address().port,
    requests,
    get connections() {
      return connections;
    },
    get bytes() {
      return bytes;
    },
    close: () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(resolve);
      }),
  };
}

const target = (port, path = '/api/v1/system/board', method = 'GET', secure = true) => ({
  secure,
  host: '127.0.0.1',
  port,
  method,
  path,
});

test('HTTPS: the fingerprint is checked first, then the request goes; one connection; our own User-Agent', async (t) => {
  const s = await server((req, res) => res.end('{"result":"None"}'));
  t.after(() => s.close());
  const seen = [];
  const res = await switchRequest(target(s.port, '/api/v1/system/command', 'POST'), {
    body: '{"command":"reboot"}',
    timeout: 5000,
    maxBytes: 1000,
    checkPeer: async (fingerprint) => {
      seen.push(fingerprint);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [CERT.fingerprint256]);
  assert.equal(s.requests[0].body, '{"command":"reboot"}');
  assert.match(s.requests[0].headers['user-agent'], /^gladys-qnap-qsw /);
  assert.doesNotMatch(s.requests[0].headers['user-agent'], /Mozilla|Chrome|Safari/);
  assert.equal(s.connections, 1);
});

test('HTTPS: a certificate refused: not a byte of the request written (password safe)', async (t) => {
  const s = await server((req, res) => res.end('{}'));
  t.after(() => s.close());
  const err = await switchRequest(target(s.port, '/api/v1/users/login', 'POST'), {
    body: '{"password":"c2VjcmV0"}',
    timeout: 5000,
    maxBytes: 1000,
    checkPeer: () => {
      throw Object.assign(new Error('pin'), { code: CODES.CERTIFICATE });
    },
  }).catch((e) => e);
  assert.equal(err.code, CODES.CERTIFICATE);
  assert.equal(err.notSent, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.requests.length, 0);
  assert.equal(s.bytes, 0, 'no application data after the handshake');
});

test('HTTPS without a certificate check is refused, nothing sent', async (t) => {
  const s = await server((req, res) => res.end('{}'));
  t.after(() => s.close());
  const err = await switchRequest(target(s.port), { timeout: 5000, maxBytes: 1000 }).catch(
    (e) => e,
  );
  assert.equal(err.notSent, true);
  assert.equal(s.requests.length, 0);
});

test('an answer before the request (impostor) is never accepted', async (t) => {
  const tls = createTlsServer({ key: CERT.key, cert: CERT.cert }, (socket) => {
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 17\r\n\r\n{"result":"None"}');
  });
  const sockets = new Set();
  tls.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        tls.close(resolve);
      }),
  );
  const err = await switchRequest(target(tls.address().port, '/x', 'POST'), {
    body: 'secret',
    timeout: 3000,
    maxBytes: 1000,
    checkPeer: () => new Promise((resolve) => setTimeout(resolve, 100)),
  }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.notSent, true);
});

test('beforeSend throwing: nothing sent, marked notSent (HTTP and HTTPS)', async (t) => {
  for (const secure of [true, false]) {
    const s = await server((req, res) => res.end('{}'), { secure });
    t.after(() => s.close());
    const err = await switchRequest(target(s.port, '/x', 'POST', secure), {
      body: '{}',
      timeout: 5000,
      maxBytes: 1000,
      checkPeer: () => {},
      beforeSend: () => {
        throw new Error('option off');
      },
    }).catch((e) => e);
    assert.equal(err.message, 'option off');
    assert.equal(err.notSent, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(s.requests.length, 0);
  }
});

test('plain HTTP: works without a certificate check', async (t) => {
  const s = await server((req, res) => res.end('{"result":"x"}'), { secure: false });
  t.after(() => s.close());
  const res = await switchRequest(target(s.port, '/a', 'GET', false), {
    timeout: 5000,
    maxBytes: 1000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), '{"result":"x"}');
});

test('size cap: an endless answer is cut while it arrives; a declared size above it too', async (t) => {
  const s = await server(
    (req, res) => {
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '100000' });
        res.write('x');
        return;
      }
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 120);
      const pump = () => {
        if (!res.destroyed && res.write(chunk)) setImmediate(pump);
      };
      res.on('drain', pump);
      pump();
    },
    { secure: false },
  );
  t.after(() => s.close());
  for (const path of ['/endless', '/declared']) {
    const err = await switchRequest(target(s.port, path, 'GET', false), {
      timeout: 5000,
      maxBytes: 64 * 1024,
    }).catch((e) => e);
    assert.equal(err.code, CODES.TOO_LARGE, path);
  }
});

test('deadline: a silent peer times out; a redirection is returned, never followed', async (t) => {
  const sockets = new Set();
  const hole = createNetServer((socket) => sockets.add(socket));
  await new Promise((resolve) => hole.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        hole.close(resolve);
      }),
  );
  const err = await switchRequest(target(hole.address().port, '/a', 'GET', false), {
    timeout: 200,
    maxBytes: 1000,
  }).catch((e) => e);
  assert.equal(err.code, CODES.TIMEOUT);
  const s = await server(
    (req, res) => res.writeHead(302, { location: 'http://evil.example/' }).end(),
    { secure: false },
  );
  t.after(() => s.close());
  const res = await switchRequest(target(s.port, '/a', 'GET', false), {
    timeout: 2000,
    maxBytes: 1000,
  });
  assert.equal(res.status, 302);
  assert.equal(s.requests.length, 1);
});

test('unreachable: a refused port, the address never in the message', async () => {
  const srv = createNetServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  const err = await switchRequest(target(port, '/a', 'GET', false), {
    timeout: 2000,
    maxBytes: 1000,
  }).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.doesNotMatch(err.message, /127\.0\.0\.1/);
});
