import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, runChecks, summarize } from '../src/checks.js';
import { parseRobots } from '../src/robots.js';
import { extractJsonLd, extractMeta, findProductNode, normalizeProduct } from '../src/html.js';
import { readFixture } from './helpers/fake-store.js';

function page(store, file) {
  const html = readFixture(store, file);
  const { blocks, errors } = extractJsonLd(html);
  return { url: 'https://s.example/x', ok: true, product: normalizeProduct(findProductNode(blocks)), meta: extractMeta(html), jsonldErrors: errors };
}

function goodData(over = {}) {
  return {
    platform: 'shopify',
    robots: { found: true, parsed: parseRobots(readFixture('shopify-good', 'robots.txt')) },
    llms: { found: true },
    feed: { ok: true, count: 2, hasBarcodes: true, hasSkus: true },
    sitemap: { found: true, productUrlCount: 2 },
    products: [page('shopify-good', 'product-blue-mug.html'), page('shopify-good', 'product-green-tote.html')],
    productPath: '/products/synthetic-blue-mug',
    ...over,
  };
}
const badPage = () => page('shopify-bad', 'product-plain-sock.html');
const byId = (data) => Object.fromEntries(runChecks(data).results.map((r) => [r.id, r]));

test('weights add up to 100 and every check has plain-English why and fix', () => {
  assert.equal(CHECKS.reduce((n, c) => n + c.weight, 0), 100);
  for (const c of CHECKS) {
    assert.ok(c.why.length > 20, c.id);
    assert.ok(c.fix.other, c.id);
    assert.ok(!/\u2014/.test(c.why + c.title + Object.values(c.fix).join('')), `no em dash in ${c.id}`);
  }
});

test('a well set up store scores 100 with every check passing', () => {
  const { score, results } = runChecks(goodData());
  assert.equal(score, 100);
  for (const r of results) {
    assert.equal(r.status, 'pass', r.id);
    assert.equal(r.fix, '', 'no fix text when passing');
  }
});

test('shopping-bots-allowed: fails when 3+ shopping bots are blocked, names them', () => {
  const r = byId(goodData({ robots: { found: true, parsed: parseRobots(readFixture('shopify-bad', 'robots.txt')) } }));
  assert.equal(r['shopping-bots-allowed'].status, 'fail');
  assert.match(r['shopping-bots-allowed'].detail, /OAI-SearchBot.*PerplexityBot.*Claude-SearchBot/);
  assert.match(r['shopping-bots-allowed'].fix, /robots\.txt\.liquid/);
});

test('shopping-bots-allowed: warns for one blocked bot, passes with no robots file', () => {
  const one = byId(goodData({ robots: { found: true, parsed: parseRobots('User-agent: PerplexityBot\nDisallow: /\n') } }));
  assert.equal(one['shopping-bots-allowed'].status, 'warn');
  const none = byId(goodData({ robots: { found: false, parsed: parseRobots('') } }));
  assert.equal(none['shopping-bots-allowed'].status, 'pass');
});

test('training-bots: blocking is only a warning', () => {
  const r = byId(goodData({ robots: { found: true, parsed: parseRobots(readFixture('woo-good', 'robots.txt')) } }));
  assert.equal(r['training-bots'].status, 'warn');
  assert.match(r['training-bots'].detail, /Google-Extended/);
});

test('product-feed: pass, empty warn, missing fail', () => {
  assert.equal(byId(goodData())['product-feed'].status, 'pass');
  assert.equal(byId(goodData({ feed: { ok: true, count: 0 } }))['product-feed'].status, 'warn');
  assert.equal(byId(goodData({ feed: { ok: false, count: 0 } }))['product-feed'].status, 'fail');
});

test('sitemap: pass, no products warn, missing fail', () => {
  assert.equal(byId(goodData())['sitemap'].status, 'pass');
  assert.equal(byId(goodData({ sitemap: { found: true, productUrlCount: 0 } }))['sitemap'].status, 'warn');
  assert.equal(byId(goodData({ sitemap: { found: false, productUrlCount: 0 } }))['sitemap'].status, 'fail');
});

test('product-schema: mixed pages warn, broken JSON-LD is mentioned, none fails', () => {
  const mixed = byId(goodData({ products: [page('shopify-good', 'product-blue-mug.html'), badPage()] }));
  assert.equal(mixed['product-schema'].status, 'warn');
  assert.match(mixed['product-schema'].detail, /1 of 2/);
  assert.match(mixed['product-schema'].detail, /broken/);
  assert.equal(byId(goodData({ products: [badPage()] }))['product-schema'].status, 'fail');
});

test('per-product checks all fail when no product page could be opened', () => {
  const r = byId(goodData({ products: [] }));
  for (const id of ['product-schema', 'price', 'availability', 'identifiers', 'brand', 'image', 'description', 'open-graph']) {
    assert.equal(r[id].status, 'fail', id);
    assert.match(r[id].detail, /could not open/);
  }
});

test('price: needs a number and a 3-letter currency', () => {
  const p = page('shopify-good', 'product-blue-mug.html');
  p.product.currency = '';
  assert.equal(byId(goodData({ products: [p] }))['price'].status, 'fail');
});

test('availability and brand fail when missing', () => {
  const p = page('woo-good', 'product-candle.html');
  const r = byId(goodData({ platform: 'woocommerce', products: [p] }));
  assert.equal(r['availability'].status, 'pass');
  assert.equal(r['brand'].status, 'fail');
  assert.match(r['brand'].fix, /brand plugin/);
});

test('identifiers: a mistyped barcode turns a pass into a warning; feed barcodes hint', () => {
  const p = page('shopify-good', 'product-blue-mug.html');
  p.product.gtin = '4006381333932';
  const r = byId(goodData({ products: [p] }));
  assert.equal(r['identifiers'].status, 'warn');
  assert.match(r['identifiers'].detail, /mistyped/);
  const q = page('shopify-good', 'product-blue-mug.html');
  q.product.gtin = ''; q.product.sku = '';
  const r2 = byId(goodData({ products: [q] }));
  assert.equal(r2['identifiers'].status, 'fail');
  assert.match(r2['identifiers'].detail, /already has barcodes/);
});

test('image, description and open-graph fail on a bare page', () => {
  const r = byId(goodData({ products: [badPage()] }));
  assert.equal(r['image'].status, 'fail');
  assert.equal(r['description'].status, 'fail');
  assert.equal(r['open-graph'].status, 'fail');
});

test('llms-txt is a gentle warning when missing', () => {
  assert.equal(byId(goodData({ llms: { found: false } }))['llms-txt'].status, 'warn');
});

test('score counts a warning as half and summary bands are plain English', () => {
  const { score } = runChecks(goodData({ llms: { found: false } }));
  assert.equal(score, 99);
  assert.equal(summarize(85).grade, 'good');
  assert.equal(summarize(60).grade, 'ok');
  assert.equal(summarize(10).grade, 'poor');
  assert.match(summarize(10).headline, /Needs work/);
});

test('unknown platform uses the generic fix text', () => {
  const r = byId(goodData({ platform: 'unknown', feed: { ok: false, count: 0 } }));
  assert.match(r['product-feed'].fix, /Shopify or WooCommerce/);
});

test('robots.txt that could not be read is a warning, never a pass', () => {
  const r = byId(goodData({ robots: { found: false, unreadable: true, status: 503, parsed: parseRobots('') } }));
  assert.equal(r['shopping-bots-allowed'].status, 'warn');
  assert.match(r['shopping-bots-allowed'].detail, /code 503/);
  assert.equal(r['training-bots'].status, 'warn');
});

test('a store that blocks shopping assistants never gets the "can read most of your store" headline', () => {
  const blocked = goodData({ robots: { found: true, parsed: parseRobots('User-agent: *\nDisallow: /\n') } });
  const { score, results } = runChecks(blocked);
  assert.ok(score >= 80, `score is still high (${score}), which is the trap`);
  const s = summarize(score, results);
  assert.notEqual(s.grade, 'good');
  assert.doesNotMatch(s.headline, /can read most of your store/);
  assert.match(s.headline, /robots\.txt/);
  const oneBlocked = goodData({ robots: { found: true, parsed: parseRobots('User-agent: PerplexityBot\nDisallow: /\n') } });
  const r2 = runChecks(oneBlocked);
  assert.doesNotMatch(summarize(r2.score, r2.results).headline, /can read most of your store/);
});

test('ChatGPT-User is advisory: OpenAI says robots.txt may not apply to shopper-started visits', () => {
  const r = byId(goodData({ robots: { found: true, parsed: parseRobots('User-agent: ChatGPT-User\nDisallow: /\n') } }));
  assert.equal(r['shopping-bots-allowed'].status, 'pass');
  assert.match(r['shopping-bots-allowed'].detail, /ChatGPT-User/);
  assert.match(r['shopping-bots-allowed'].detail, /may not apply/);
});

test('every sampled product page is checked against robots.txt, not just the first', () => {
  const robots = { found: true, parsed: parseRobots('User-agent: OAI-SearchBot\nDisallow: /products/secret\n') };
  const r = byId(goodData({ robots, productPaths: ['/products/synthetic-blue-mug', '/products/secret-tote'] }));
  assert.notEqual(r['shopping-bots-allowed'].status, 'pass');
  assert.match(r['shopping-bots-allowed'].detail, /OAI-SearchBot/);
});

test('product pages that failed to open are disclosed in per-product details', () => {
  const failed = { url: 'https://s.example/products/broken', ok: false, product: null, meta: {} };
  const r = byId(goodData({ products: [page('shopify-good', 'product-blue-mug.html'), failed] }));
  assert.match(r.price.detail, /1 other product page could not be opened/);
});

test('training-bot wording makes no reach promise', () => {
  const allow = byId(goodData());
  assert.doesNotMatch(allow['training-bots'].detail, /widest reach/);
  const c = CHECKS.find((x) => x.id === 'training-bots');
  assert.doesNotMatch(c.fix.other, /widest reach/);
});
