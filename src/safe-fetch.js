// A guarded HTTP client for fetching other people's websites.
// Guards: http/https only, no private or local addresses (checked at connect
// time, so DNS tricks cannot slip past), timeouts, size caps, redirect cap,
// and a per-scan request budget.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKS = [
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
];
const v4List = new net.BlockList();
for (const [a, p] of V4_BLOCKS) v4List.addSubnet(a, p, 'ipv4');
const v6List = new net.BlockList();
for (const [a, p] of V6_BLOCKS) v6List.addSubnet(a, p, 'ipv6');

function expandV6(ip) {
  let s = ip.split('%')[0].toLowerCase();
  // Trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) becomes two hextets.
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return parts.length === 8 && parts.every((n) => n >= 0 && n <= 0xffff) ? parts : null;
}

function v4FromHextets(a, b) {
  return [a >> 8, a & 255, b >> 8, b & 255].join('.');
}

/** True when an IP address is private, local, reserved, or unparseable. */
export function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) return v4List.check(ip, 'ipv4');
  if (!net.isIPv6(ip.split('%')[0])) return true;
  const h = expandV6(ip);
  if (!h) return true;
  const zeros = (n) => h.slice(0, n).every((x) => x === 0);
  if (zeros(5) && h[5] === 0xffff) return isBlockedAddress(v4FromHextets(h[6], h[7])); // IPv4-mapped
  if (zeros(6)) return true; // ::, ::1, and deprecated IPv4-compatible
  if (zeros(4) && h[4] === 0xffff && h[5] === 0) return isBlockedAddress(v4FromHextets(h[6], h[7])); // IPv4-translated (::ffff:0:0/96)
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // RFC 8215 local-use NAT64 (64:ff9b:1::/48): may map to any private IPv4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo (2001::/32): tunnels to an IPv4 we cannot check reliably
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isBlockedAddress(v4FromHextets(h[6], h[7])); // NAT64
  }
  if (h[0] === 0x2002) return isBlockedAddress(v4FromHextets(h[1], h[2])); // 6to4
  return v6List.check(h.map((x) => x.toString(16)).join(':'), 'ipv6');
}

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** Checks a URL before any network traffic. Throws FetchError when unsafe. */
export function validateUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('bad_url', 'That does not look like a web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FetchError('bad_url', 'Only http and https web addresses can be checked.');
  }
  if (u.username || u.password) throw new FetchError('bad_url', 'Web addresses with passwords are not allowed.');
  if (!allowPrivate) {
    if (u.port && u.port !== '80' && u.port !== '443') {
      throw new FetchError('blocked', 'Only normal web ports (80 and 443) can be checked.');
    }
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes('.') && !net.isIP(host)) {
      throw new FetchError('blocked', 'That address is not a public website.');
    }
    if (net.isIP(host) && isBlockedAddress(host)) throw new FetchError('blocked', 'That address is not a public website.');
  }
  return u;
}

export function makeLookup(allowPrivate, dnsLookup = dns.lookup) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dnsLookup(hostname, { all: true, family: options.family || 0 }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs.length) return cb(new FetchError('dns', 'No address found.'));
      if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) {
        return cb(new FetchError('blocked', 'That address is not a public website.'));
      }
      if (options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/**
 * Creates a fetcher with a request budget. Each scan gets its own fetcher.
 * opts: { allowPrivate, maxRequests, timeoutMs, maxBytes, maxRedirects, retryDelayMs, userAgent, signal }
 * signal: an AbortSignal; when it fires, in-flight requests stop and new ones are refused.
 * allowPrivate exists only so tests can talk to a fake store on 127.0.0.1.
 */
export function createFetcher(opts = {}) {
  const o = {
    allowPrivate: false, maxRequests: 20, timeoutMs: 8000, maxBytes: 2_000_000, maxRedirects: 4, retryDelayMs: 1500,
    userAgent: 'AIShoppingCheck/0.1 (free store scan)', ...opts,
  };
  const lookup = makeLookup(o.allowPrivate);
  let used = 0;

  const signal = o.signal;
  const checkAborted = () => {
    if (signal && signal.aborted) throw new FetchError('aborted', 'The scan was stopped.');
  };

  function once(u, accept, maxBytes) {
    checkAborted();
    return new Promise((resolve, reject) => {
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(u, {
        method: 'GET', lookup, agent: false,
        // Offer ALPN like browsers and fetch() do. Without it, some store firewalls answer 429.
        ...(u.protocol === 'https:' ? { ALPNProtocols: ['http/1.1'] } : {}),
        headers: { 'user-agent': o.userAgent, accept, 'accept-encoding': 'gzip, deflate, br' },
      });
      let settled = false;
      const onAbort = () => req.destroy(new FetchError('aborted', 'The scan was stopped.'));
      const timer = setTimeout(() => req.destroy(new FetchError('timeout', 'The store took too long to answer.')), o.timeoutMs);
      const cleanup = () => { settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
      const fail = (e) => {
        if (settled) return;
        cleanup();
        req.destroy(); // always close the connection, so a bad answer cannot hold it open
        reject(e instanceof FetchError ? e : new FetchError('network', e.message));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', fail);
      req.on('response', (res) => {
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          if (settled) return;
          cleanup();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated });
        };
        stream.on('data', (c) => {
          if (truncated) return;
          size += c.length;
          if (size > maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            truncated = true;
            req.destroy();
            done();
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => { if (!truncated) done(); });
        // pipe() does not pass errors along, so listen on both the socket stream and the decompressor.
        stream.on('error', (e) => { if (!truncated) fail(e); });
        if (stream !== res) res.on('error', (e) => { if (!truncated) fail(e); });
        res.on('aborted', () => { if (!truncated) fail(new FetchError('network', 'The store closed the connection.')); });
      });
      req.end();
    });
  }

  async function get(raw, { accept = '*/*', maxBytes = o.maxBytes } = {}) {
    let u = validateUrl(raw, o);
    for (let hop = 0; ; hop++) {
      checkAborted();
      if (used >= o.maxRequests) throw new FetchError('budget', 'Scan request limit reached.');
      used++;
      let res = await once(u, accept, maxBytes);
      // Busy stores often answer 429 for a moment. Wait briefly and try once more.
      if ((res.status === 429 || res.status === 503) && o.retryDelayMs > 0 && used < o.maxRequests) {
        used++; // reserve the slot before waiting, so parallel retries cannot overspend the budget
        const ra = Number(res.headers['retry-after']);
        await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : o.retryDelayMs, 3000)));
        res = await once(u, accept, maxBytes);
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (hop >= o.maxRedirects) throw new FetchError('redirects', 'Too many redirects.');
        u = validateUrl(new URL(res.headers.location, u).href, o);
        continue;
      }
      return { ...res, url: u.href };
    }
  }

  return { get, get used() { return used; } };
}
