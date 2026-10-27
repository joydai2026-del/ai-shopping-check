// A local fake store that serves the synthetic fixtures. Test-only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function readFixture(store, file, origin = 'https://synthetic.example') {
  return fs.readFileSync(path.join(FIXTURES, store, file), 'utf8').replaceAll('{{ORIGIN}}', origin);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

/** Starts a fake store on 127.0.0.1. Returns { origin, close, hits }. */
export async function startFakeStore(store, { extraRoutes = {} } = {}) {
  const routes = JSON.parse(fs.readFileSync(path.join(FIXTURES, store, 'routes.json'), 'utf8'));
  const hits = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    hits.push({ path: p, ua: req.headers['user-agent'] });
    if (extraRoutes[p]) return extraRoutes[p](req, res);
    const file = routes[p];
    if (!file) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html>not found</html>'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(readFixture(store, file, origin));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, hits, close: () => new Promise((r) => server.close(r)) };
}

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
