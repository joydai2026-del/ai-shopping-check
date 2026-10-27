import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { isBlockedAddress, validateUrl, createFetcher, makeLookup } from '../src/safe-fetch.js';
import { listen } from './helpers/fake-store.js';

test('private, local and reserved addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::5', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', 'ff02::1', 'fe80::1%en0', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '23.227.38.65', '2606:4700::1111', '::ffff:8.8.8.8', '172.32.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('validateUrl refuses unsafe addresses before any network traffic', () => {
  const bad = ['file:///etc/passwd', 'ftp://a.example/', 'gopher://a.example', 'http://localhost/', 'http://shop.localhost/', 'http://printer.local/',
    'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://user:pw' + '@' + 'a.example/', 'http://a.example:8080/', 'http://intranet/', 'http://2130706433/', 'not a url'];
  for (const u of bad) assert.throws(() => validateUrl(u), undefined, u);
  assert.equal(validateUrl('https://shop.example/').hostname, 'shop.example');
});

test('hostnames that resolve to private addresses are blocked at connect time', async () => {
  // localtest.me style names are not needed: "localhost." with a trailing dot slips past the name check, so the DNS guard must catch it.
  const f = createFetcher();
  await assert.rejects(f.get('http://localhost./'), (e) => e.code === 'blocked' || e.code === 'network');
});

async function server(handler) {
  const s = http.createServer(handler);
  const origin = await listen(s);
  return { origin, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
}

test('without allowPrivate, even a working local server is refused', async () => {
  const s = await server((req, res) => res.end('hi'));
  try {
    await assert.rejects(createFetcher().get(`${s.origin}/`), (e) => e.code === 'blocked');
  } finally { await s.close(); }
});

test('size cap truncates big bodies, including after gzip', async () => {
  const big = 'a'.repeat(200_000);
  const s = await server((req, res) => {
    if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(big)); }
    res.end(big);
  });
  try {
    const f = createFetcher({ allowPrivate: true, maxBytes: 1000 });
    const r = await f.get(`${s.origin}/`);
    assert.equal(r.truncated, true);
    assert.equal(r.body.length, 1000);
    const g = await f.get(`${s.origin}/gz`);
    assert.equal(g.truncated, true);
    assert.equal(g.body.length, 1000);
  } finally { await s.close(); }
});

test('timeouts stop slow servers', async () => {
  const s = await server(() => { /* never answers */ });
  try {
    await assert.rejects(createFetcher({ allowPrivate: true, timeoutMs: 200 }).get(`${s.origin}/`), (e) => e.code === 'timeout');
  } finally { await s.close(); }
});

test('redirects are followed, capped, and re-checked', async () => {
  const s = await server((req, res) => {
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (req.url === '/a') { res.writeHead(301, { location: '/b' }); return res.end(); }
    res.end('final');
  });
  try {
    const f = createFetcher({ allowPrivate: true, maxRedirects: 3 });
    const r = await f.get(`${s.origin}/a`);
    assert.equal(r.body, 'final');
    assert.ok(r.url.endsWith('/b'));
    await assert.rejects(f.get(`${s.origin}/loop`), (e) => e.code === 'redirects');
    await assert.rejects(f.get(`${s.origin}/to-file`), (e) => e.code === 'bad_url');
  } finally { await s.close(); }
});

test('request budget caps how many pages one scan can fetch', async () => {
  const s = await server((req, res) => res.end('ok'));
  try {
    const f = createFetcher({ allowPrivate: true, maxRequests: 2 });
    await f.get(`${s.origin}/1`);
    await f.get(`${s.origin}/2`);
    await assert.rejects(f.get(`${s.origin}/3`), (e) => e.code === 'budget');
    assert.equal(f.used, 2);
  } finally { await s.close(); }
});

test('a 429 answer is retried once after a short wait', async () => {
  let n = 0;
  const s = await server((req, res) => { n++; if (n === 1) { res.writeHead(429); return res.end(); } res.end('ok'); });
  try {
    const f = createFetcher({ allowPrivate: true, retryDelayMs: 50 });
    const r = await f.get(`${s.origin}/`);
    assert.equal(r.status, 200);
    assert.equal(f.used, 2, 'the retry counts against the budget');
  } finally { await s.close(); }
});

test('a gzip answer cut off halfway is a caught error, not a crash', async () => {
  const s = await server((req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.write(zlib.gzipSync('x'.repeat(50_000)).subarray(0, 200));
    setTimeout(() => res.socket.destroy(), 20);
  });
  try {
    await assert.rejects(createFetcher({ allowPrivate: true }).get(`${s.origin}/`), (e) => e.code === 'network');
  } finally { await s.close(); }
});

test('parallel retries cannot overspend the request budget', async () => {
  let hits = 0;
  const s = await server((req, res) => { hits++; res.writeHead(429); res.end(); });
  try {
    const f = createFetcher({ allowPrivate: true, maxRequests: 3, retryDelayMs: 30 });
    await Promise.all([f.get(`${s.origin}/a`), f.get(`${s.origin}/b`)]);
    assert.equal(hits, 3);
    assert.equal(f.used, 3);
  } finally { await s.close(); }
});

test('a name with one public and one private address is refused', async () => {
  const fakeDns = (host, opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  const lookup = makeLookup(false, fakeDns);
  const err = await new Promise((r) => lookup('mixed.example', { all: true }, (e) => r(e)));
  assert.equal(err.code, 'blocked');
  const ok = await new Promise((r) => makeLookup(false, (h, o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]))('pub.example', {}, (e, a) => r(a)));
  assert.equal(ok, '8.8.8.8');
});

test('an aborted scan stops in-flight and new requests', async () => {
  const s = await server(() => { /* hang */ });
  try {
    const c = new AbortController();
    const f = createFetcher({ allowPrivate: true, signal: c.signal, timeoutMs: 5000 });
    const p = f.get(`${s.origin}/`);
    setTimeout(() => c.abort(), 50);
    await assert.rejects(p, (e) => e.code === 'aborted');
    await assert.rejects(f.get(`${s.origin}/`), (e) => e.code === 'aborted');
  } finally { await s.close(); }
});

test('a broken gzip answer closes the connection', async () => {
  let sock;
  const s = await server((req, res) => {
    sock = res.socket;
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.write(Buffer.from('this is not gzip at all'));
    // keep the response open on purpose
  });
  try {
    await assert.rejects(createFetcher({ allowPrivate: true }).get(`${s.origin}/`), (e) => e.code === 'network');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sock.destroyed, true, 'server side saw the connection closed');
  } finally { await s.close(); }
});

test('IPv6 transition ranges cannot smuggle a private IPv4 address', () => {
  for (const ip of [
    '64:ff9b:1::a9fe:a9fe', // RFC 8215 local-use NAT64, whole /48 is blocked
    '64:ff9b:1:ffff::1.2.3.4',
    '64:ff9b::7f00:1', // well-known NAT64 prefix with 127.0.0.1 inside
    '64:ff9b::10.0.0.1',
    '::ffff:0:a9fe:a9fe', // IPv4-translated (::ffff:0:0/96) with 169.254.169.254 inside
    '::ffff:0:10.1.2.3',
    '2002:c0a8:0101::1', // 6to4 with 192.168.1.1 inside
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo (2001::/32), blocked as a range
    '2001::1',
  ]) assert.equal(isBlockedAddress(ip), true, ip);
  // Public addresses inside the well-known NAT64 and 6to4 prefixes still work.
  assert.equal(isBlockedAddress('64:ff9b::808:808'), false);
  assert.equal(isBlockedAddress('2002:0808:0808::1'), false);
  assert.equal(isBlockedAddress('::ffff:0:808:808'), false);
});
