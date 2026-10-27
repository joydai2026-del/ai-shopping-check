// Tiny web server: the page, POST /api/scan, /api/health and /llms.txt.
// No framework, just node:http.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStore, ScanError, normalizeStoreUrl, startScan } from './scan.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/llms.txt': ['llms.txt', 'text/plain; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// The visitor address used for rate limits. With hops=0 the forwarded header is ignored.
// With hops=N, use the Nth address from the right: the ones our own proxies appended,
// so a visitor cannot pick their own address by sending a fake header.
export function clientIp(req, hops = 0) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (!hops) return socketIp;
  const raw = req.headers['x-forwarded-for'];
  const list = (Array.isArray(raw) ? raw.join(',') : String(raw || '')).split(',').map((x) => x.trim()).filter(Boolean);
  return list.length >= hops ? list[list.length - hops] : socketIp;
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(data);
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Stop keeping data (drain the rest) and answer 413 instead of cutting the socket.
        if (!tooBig) reject(Object.assign(new Error('too_big'), { status: 413 }));
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error('bad_json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Sliding one-minute window per client IP. Separate counters per action class.
function rateLimiter(perMinute) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length >= perMinute) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
    return true;
  };
}

/**
 * deps: { config, scan (optional override), fetcherOptions (tests only) }
 */
export function createServer({ config, scan = scanStore, fetcherOptions = {} } = {}) {
  const scanLimit = rateLimiter(config.limits.scansPerMinutePerIp);
  let running = 0;


  return http.createServer(async (req, res) => {
    const ip = clientIp(req, config.trustProxyHops);
    try {
      let url;
      try {
        url = new URL(req.url, 'http://local');
      } catch {
        return send(res, 400, { error: 'bad_request' }, undefined, { connection: 'close' });
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), type, { 'cache-control': 'no-cache' });
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });

      if (url.pathname === '/api/scan') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed', message: 'Use POST with {"url": "yourstore.com"}.' }, undefined, { allow: 'POST' });
        const body = await readJson(req);
        if (typeof body.url !== 'string') return send(res, 400, { error: 'bad_url', message: 'Send {"url": "yourstore.com"}.' });
        try {
          normalizeStoreUrl(body.url);
        } catch (e) {
          return send(res, 400, { error: e.code, message: e.message });
        }
        if (!scanLimit(ip)) return send(res, 429, { error: 'rate_limited', message: 'Too many scans. Please wait a minute and try again.' });
        if (running >= config.limits.maxConcurrentScans) return send(res, 503, { error: 'busy', message: 'We are busy right now. Please try again in a few seconds.' });
        // A slot is freed only when the scan has really finished, not when we stop waiting for it.
        running++;
        const { job, result } = startScan(body.url, config.scan, { scan, fetcherOptions });
        job.catch(() => {}).finally(() => { running--; });
        try {
          const report = await result;
          return send(res, 200, report);
        } catch (e) {
          if (e instanceof ScanError) {
            const status = e.code === 'bad_url' ? 400 : e.code === 'blocked' ? 400 : e.code === 'timeout' ? 504 : 422;
            return send(res, status, { error: e.code, message: e.message });
          }
          console.error('scan failed:', e && e.message);
          return send(res, 500, { error: 'scan_failed', message: 'Something went wrong while checking. Please try again.' });
        }
      }

      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (!res.headersSent) send(res, status, { error: status === 413 ? 'too_big' : status === 400 ? 'bad_json' : 'server_error' }, undefined, { connection: 'close' });
    }
  });
}
