// robots.txt is checked against the product URLs AI bots would really fetch:
// the query string is kept, and redirects are followed to where the page lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanStore } from '../src/scan.js';
import { startFakeStore, readFixture } from './helpers/fake-store.js';

const opts = { maxProducts: 2, fetcherOptions: { allowPrivate: true } };
const status = (report, id) => report.checks.find((c) => c.id === id);
const BLOCK3 = (rule) => `User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nUser-agent: Claude-SearchBot\n${rule}\n`;
const text = (body, type = 'text/plain') => (req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); };

test('query strings on product URLs are checked against robots.txt', async () => {
  let origin = '';
  const fake = await startFakeStore('shopify-good', { extraRoutes: {
    '/robots.txt': text(BLOCK3('Disallow: /*?variant=')),
    '/products.json': (req, res) => { res.writeHead(404); res.end(); },
    '/sitemap_products_1.xml': (req, res) => text(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/products/synthetic-blue-mug?variant=1</loc></url></urlset>`, 'application/xml')(req, res),
  } });
  origin = fake.origin;
  try {
    const report = await scanStore(fake.origin, opts);
    const c = status(report, 'shopping-bots-allowed');
    assert.equal(c.status, 'fail', c.detail);
  } finally { await fake.close(); }
});

test('a product page that redirects is checked at its final address (same store)', async () => {
  const fake = await startFakeStore('shopify-good', { extraRoutes: {
    '/robots.txt': text(BLOCK3('Disallow: /moved/')),
    '/products/synthetic-blue-mug': (req, res) => { res.writeHead(301, { location: '/moved/mug' }); res.end(); },
    '/products/synthetic-green-tote': (req, res) => { res.writeHead(301, { location: '/moved/tote' }); res.end(); },
    '/moved/mug': text(readFixture('shopify-good', 'product-blue-mug.html'), 'text/html'),
    '/moved/tote': text(readFixture('shopify-good', 'product-green-tote.html'), 'text/html'),
  } });
  try {
    const report = await scanStore(fake.origin, opts);
    assert.equal(status(report, 'shopping-bots-allowed').status, 'fail', status(report, 'shopping-bots-allowed').detail);
  } finally { await fake.close(); }
});

test('a product page that redirects to another site is checked against that site\'s robots.txt', async () => {
  const other = await startFakeStore('shopify-good', { extraRoutes: { '/robots.txt': text(BLOCK3('Disallow: /')) } });
  const fake = await startFakeStore('shopify-good', { extraRoutes: {
    '/products/synthetic-blue-mug': (req, res) => { res.writeHead(302, { location: `${other.origin}/products/synthetic-blue-mug` }); res.end(); },
    '/products/synthetic-green-tote': (req, res) => { res.writeHead(302, { location: `${other.origin}/products/synthetic-green-tote` }); res.end(); },
  } });
  try {
    const report = await scanStore(fake.origin, opts);
    const c = status(report, 'shopping-bots-allowed');
    assert.equal(c.status, 'fail', c.detail);
    assert.ok(other.hits.some((h) => h.path === '/robots.txt'), 'read the other site\'s robots.txt');
  } finally { await fake.close(); await other.close(); }
});

test('the home page is checked at its final address after a redirect', async () => {
  const fake = await startFakeStore('shopify-good', { extraRoutes: {
    '/robots.txt': text(BLOCK3('Disallow: /en')),
    '/': (req, res) => { res.writeHead(302, { location: '/en?market=us' }); res.end(); },
    '/en': text(readFixture('shopify-good', 'home.html'), 'text/html'),
  } });
  try {
    const report = await scanStore(fake.origin, opts);
    const c = status(report, 'shopping-bots-allowed');
    assert.equal(c.status, 'fail', c.detail);
  } finally { await fake.close(); }
});

test('an unreadable robots.txt on a redirect destination is reported, never a silent pass', async () => {
  const other = await startFakeStore('shopify-good', { extraRoutes: { '/robots.txt': (req, res) => { res.writeHead(503); res.end('busy'); } } });
  const fake = await startFakeStore('shopify-good', { extraRoutes: {
    '/products/synthetic-blue-mug': (req, res) => { res.writeHead(302, { location: `${other.origin}/products/synthetic-blue-mug` }); res.end(); },
  } });
  try {
    const report = await scanStore(fake.origin, opts);
    const c = status(report, 'shopping-bots-allowed');
    assert.equal(c.status, 'warn', c.detail);
    assert.match(c.detail, /could not read the robots\.txt/i);
    assert.doesNotMatch(c.detail, /all allowed/);
  } finally { await fake.close(); await other.close(); }
});

test('every redirect destination site is checked, not just the first two', async () => {
  const sites = [];
  for (let i = 0; i < 3; i++) sites.push(await startFakeStore('shopify-good', i === 2 ? { extraRoutes: { '/robots.txt': text(BLOCK3('Disallow: /')) } } : {}));
  const handles = ['p0', 'p1', 'p2'];
  const extraRoutes = {
    '/products.json': text(JSON.stringify({ products: handles.map((h) => ({ handle: h, variants: [] })) }), 'application/json'),
  };
  handles.forEach((h, i) => {
    extraRoutes[`/products/${h}`] = (req, res) => { res.writeHead(302, { location: `${sites[i].origin}/products/synthetic-blue-mug` }); res.end(); };
  });
  const fake = await startFakeStore('shopify-good', { extraRoutes });
  try {
    const report = await scanStore(fake.origin, { maxProducts: 3, fetcherOptions: { allowPrivate: true, maxRequests: 60 } });
    const c = status(report, 'shopping-bots-allowed');
    assert.equal(c.status, 'fail', c.detail);
  } finally { await fake.close(); for (const s of sites) await s.close(); }
});
