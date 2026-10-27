import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLd, extractMeta, findProductNode, normalizeProduct, isValidGtin, parseSitemap, decodeEntities } from '../src/html.js';
import { readFixture } from './helpers/fake-store.js';

const productFrom = (store, file) => {
  const { blocks } = extractJsonLd(readFixture(store, file));
  return normalizeProduct(findProductNode(blocks));
};

test('reads a plain Shopify Product block', () => {
  const p = productFrom('shopify-good', 'product-blue-mug.html');
  assert.equal(p.name, 'Synthetic Blue Mug');
  assert.equal(p.price, '18.00');
  assert.equal(p.currency, 'USD');
  assert.equal(p.availability, 'InStock');
  assert.equal(p.gtin, '4006381333931');
  assert.equal(p.sku, 'SYN-MUG-BLUE');
  assert.equal(p.brand, 'Synthetic Test Shop');
  assert.match(p.image, /blue-mug\.jpg$/);
  assert.ok(p.description.length > 50);
});

test('reads a ProductGroup with variants, string brand and ImageObject', () => {
  const p = productFrom('shopify-good', 'product-green-tote.html');
  assert.equal(p.price, '24');
  assert.equal(p.gtin, '012345678905');
  assert.equal(p.brand, 'Synthetic Test Shop');
  assert.match(p.image, /green-tote\.jpg$/);
});

test('reads a Yoast-style @graph with priceSpecification and HTML in the description', () => {
  const p = productFrom('woo-good', 'product-candle.html');
  assert.equal(p.price, '15.00');
  assert.equal(p.currency, 'USD');
  assert.equal(p.brand, '');
  assert.ok(!p.description.includes('<p>'));
});

test('counts broken JSON-LD and finds no product', () => {
  const { blocks, errors } = extractJsonLd(readFixture('shopify-bad', 'product-plain-sock.html'));
  assert.equal(errors, 1);
  assert.equal(findProductNode(blocks), null);
  assert.equal(normalizeProduct(null), null);
});

test('reads Open Graph meta tags and decodes entities', () => {
  const m = extractMeta(readFixture('woo-good', 'product-candle.html'));
  assert.equal(m['og:title'], 'Synthetic Candle & Wick');
  assert.match(m['og:image'], /candle\.jpg$/);
  assert.equal(decodeEntities('&#39;a&#x26;b&quot;'), "'a&b\"");
});

test('GTIN check digits', () => {
  assert.equal(isValidGtin('4006381333931'), true);
  assert.equal(isValidGtin('012345678905'), true);
  assert.equal(isValidGtin('4006381333932'), false);
  assert.equal(isValidGtin('12345'), false);
});

test('sitemap index vs url set', () => {
  const idx = parseSitemap(readFixture('shopify-good', 'sitemap.xml', 'https://s.example'));
  assert.equal(idx.isIndex, true);
  assert.equal(idx.locs[1], 'https://s.example/sitemap_products_1.xml?from=1&to=2');
  const set = parseSitemap(readFixture('shopify-good', 'sitemap_products_1.xml', 'https://s.example'));
  assert.equal(set.isIndex, false);
  assert.equal(set.locs.length, 3);
});

test('hostile pages cannot make the parsers slow', () => {
  const t = Date.now();
  extractMeta('<meta ' + 'a'.repeat(200_000) + '>');
  extractMeta('<meta '.repeat(100_000));
  extractJsonLd('<script'.repeat(100_000));
  extractJsonLd('<script type="application/ld+json">'.repeat(50_000));
  parseSitemap('<loc>' + ' '.repeat(200_000));
  parseSitemap('<loc>'.repeat(100_000));
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

test('sitemap CDATA locations are read', () => {
  assert.deepEqual(parseSitemap('<urlset><url><loc><![CDATA[https://s.example/products/a]]></loc></url></urlset>').locs, ['https://s.example/products/a']);
});

test('round 3: hostile descriptions, non-ASCII text and bad entities are handled', () => {
  const t = Date.now();
  normalizeProduct({ '@type': 'Product', description: '<'.repeat(200_000) });
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
  const html = 'İ'.repeat(3) + readFixture('shopify-good', 'product-blue-mug.html');
  assert.equal(normalizeProduct(findProductNode(extractJsonLd(html).blocks)).name, 'Synthetic Blue Mug');
  assert.equal(decodeEntities('a&#x110000;b&#1114112;c&#0;'), 'a&#x110000;b&#1114112;c&#0;');
  assert.equal(extractMeta('<meta name="description" content="&#x110000;">').description, '&#x110000;');
});
