// End to end: real server + real scanner + real HTTP, against local fake stores
// built from the synthetic fixtures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { startFakeStore, listen } from './helpers/fake-store.js';

const config = loadConfig({}, { envFiles: [] });
const app = createServer({ config, fetcherOptions: { allowPrivate: true } });
const base = await listen(app);
after(() => new Promise((r) => { app.closeAllConnections?.(); app.close(r); }));

async function scan(store) {
  const fake = await startFakeStore(store);
  try {
    const r = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: fake.origin }) });
    return { status: r.status, report: await r.json(), hits: fake.hits, origin: fake.origin };
  } finally { await fake.close(); }
}
const statusOf = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

test('good Shopify store scores 100', async () => {
  const { status, report, hits } = await scan('shopify-good');
  assert.equal(status, 200);
  assert.equal(report.platform, 'shopify');
  assert.equal(report.score, 100, JSON.stringify(report.checks.filter((c) => c.status !== 'pass')));
  assert.equal(report.grade, 'good');
  assert.equal(report.productsChecked.length, 2);
  const paths = hits.map((h) => h.path);
  for (const p of ['/', '/robots.txt', '/llms.txt', '/products.json', '/products/synthetic-blue-mug.json', '/sitemap.xml', '/sitemap_products_1.xml', '/products/synthetic-blue-mug']) {
    assert.ok(paths.includes(p), `fetched ${p}`);
  }
  assert.ok(hits.every((h) => /^AIShoppingCheck\/0\.1 /.test(h.ua)));
  assert.ok(report.requestsUsed <= config.scan.maxRequests);
});

test('bad Shopify store scores low and explains why', async () => {
  const { report } = await scan('shopify-bad');
  const s = statusOf(report);
  assert.equal(report.platform, 'shopify');
  assert.equal(s['shopping-bots-allowed'], 'fail');
  assert.equal(s['training-bots'], 'warn');
  assert.equal(s['product-feed'], 'pass');
  assert.equal(s['sitemap'], 'fail');
  assert.equal(s['product-schema'], 'fail');
  assert.equal(s['llms-txt'], 'warn');
  assert.ok(report.score < 50, `score ${report.score}`);
  assert.equal(report.grade, 'poor');
  for (const c of report.checks) if (c.status !== 'pass') assert.ok(c.fix.length > 10, c.id);
});

test('WooCommerce store via the Store API and WordPress sitemap', async () => {
  const { report, hits } = await scan('woo-good');
  const s = statusOf(report);
  assert.equal(report.platform, 'woocommerce');
  assert.equal(s['product-feed'], 'pass');
  assert.equal(s['sitemap'], 'pass');
  assert.equal(s['price'], 'pass');
  assert.equal(s['brand'], 'fail');
  assert.equal(s['training-bots'], 'warn');
  assert.ok(hits.some((h) => h.path === '/wp-json/wc/store/v1/products'));
  assert.ok(!hits.some((h) => h.path === '/products.json'), 'did not probe Shopify endpoints on a Woo store');
});

test('a store that does not answer gives a plain error', async () => {
  const fake = await startFakeStore('shopify-good');
  const origin = fake.origin;
  await fake.close();
  const r = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: origin }) });
  assert.equal(r.status, 422);
  assert.match((await r.json()).message, /could not reach/);
});

test('robots.txt that is really an "Access denied" page, or cut off, is never a pass', async () => {
  const fake = await startFakeStore('shopify-good', { extraRoutes: { '/robots.txt': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Access denied</html>'); } } });
  try {
    const r = await fetch(`${base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: fake.origin }) });
    const s = statusOf(await r.json());
    assert.equal(s['shopping-bots-allowed'], 'warn');
    assert.equal(s['training-bots'], 'warn');
  } finally { await fake.close(); }
});
