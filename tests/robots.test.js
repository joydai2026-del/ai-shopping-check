import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../src/robots.js';
import { readFixture } from './helpers/fake-store.js';

test('star group applies when a bot has no group of its own', () => {
  const r = parseRobots('User-agent: *\nDisallow: /admin\n');
  assert.equal(isAllowed(r, 'OAI-SearchBot', '/'), true);
  assert.equal(isAllowed(r, 'OAI-SearchBot', '/admin/x'), false);
});

test('stacked user-agent lines share one group; bot names are case-insensitive', () => {
  const r = parseRobots(readFixture('shopify-bad', 'robots.txt'));
  assert.equal(isAllowed(r, 'oai-searchbot', '/'), false);
  assert.equal(isAllowed(r, 'PerplexityBot', '/products/x'), false);
  assert.equal(isAllowed(r, 'Claude-SearchBot', '/'), true);
  assert.equal(isAllowed(r, 'Claude-SearchBot', '/products/x'), false);
  assert.equal(isAllowed(r, 'Googlebot', '/products/x'), true);
});

test('longest rule wins and Allow wins a tie', () => {
  const r = parseRobots('User-agent: *\nDisallow: /shop\nAllow: /shop/products\nDisallow: /x\nAllow: /x\n');
  assert.equal(isAllowed(r, 'a', '/shop/cart'), false);
  assert.equal(isAllowed(r, 'a', '/shop/products/mug'), true);
  assert.equal(isAllowed(r, 'a', '/x'), true);
});

test('wildcards and end anchors', () => {
  const r = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /*?q=\n');
  assert.equal(isAllowed(r, 'a', '/products.json'), false);
  assert.equal(isAllowed(r, 'a', '/products.json?x=1'), true);
  assert.equal(isAllowed(r, 'a', '/search?q=mug'), false);
});

test('empty Disallow allows everything; comments and Sitemap lines are read', () => {
  const r = parseRobots('# hi\nUser-agent: GPTBot\nDisallow:\nSitemap: https://a.example/s.xml\n');
  assert.equal(isAllowed(r, 'GPTBot', '/'), true);
  assert.deepEqual(r.sitemaps, ['https://a.example/s.xml']);
});

test('no robots file means everything is allowed', () => {
  assert.equal(isAllowed(parseRobots(''), 'OAI-SearchBot', '/products/x'), true);
});

test('a hostile wildcard rule cannot freeze the server', () => {
  const evil = '/' + 'a*'.repeat(25) + 'b';
  const r = parseRobots(`User-agent: *\nDisallow: ${evil}\n`);
  const t = Date.now();
  assert.equal(isAllowed(r, 'x', '/' + 'a'.repeat(60)), true);
  assert.equal(isAllowed(r, 'x', '/' + 'a'.repeat(5000)), true);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t}ms`);
});

test('round 4: a huge file of hostile rules stays fast', () => {
  const evil = `User-agent: *\n${`Disallow: /*${'a'.repeat(500)}b$\n`.repeat(970)}`;
  const r = parseRobots(evil);
  const path = `/products/${'a'.repeat(1980)}`;
  const t = Date.now();
  for (const bot of ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot', 'Claude-User', 'Googlebot', 'GPTBot', 'ClaudeBot', 'Google-Extended']) {
    isAllowed(r, bot, path);
    isAllowed(r, bot, '/');
  }
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t}ms`);
});

test('wildcard edge cases match the RFC 9309 examples', () => {
  const r = (rule) => parseRobots(`User-agent: *\nDisallow: ${rule}\n`);
  assert.equal(isAllowed(r('/fish*.php'), 'x', '/fish.php'), false);
  assert.equal(isAllowed(r('/fish*.php'), 'x', '/fishheads/catfish.php?parameters'), false);
  assert.equal(isAllowed(r('/fish*.php'), 'x', '/Fish.PHP'), true);
  assert.equal(isAllowed(r('/*.php$'), 'x', '/folder/filename.php'), false);
  assert.equal(isAllowed(r('/*.php$'), 'x', '/filename.php?parameters'), true);
  assert.equal(isAllowed(r('/fish$'), 'x', '/fish'), false);
  assert.equal(isAllowed(r('/fish$'), 'x', '/fishy'), true);
  assert.equal(isAllowed(r('/a*b*c'), 'x', '/aXbYc'), false);
  assert.equal(isAllowed(r('/a*b*c'), 'x', '/aXcYb'), true);
});

test('paths are compared after percent-encoding normalization (Google robots spec)', () => {
  const r = parseRobots('User-agent: *\nDisallow: /products/café\nDisallow: /a%2fb\nAllow: /%7Eok\n');
  assert.equal(isAllowed(r, 'a', '/products/caf%C3%A9'), false);
  assert.equal(isAllowed(r, 'a', '/products/caf%c3%a9'), false);
  assert.equal(isAllowed(r, 'a', '/products/café'), false);
  assert.equal(isAllowed(r, 'a', '/a%2Fb'), false, 'hex case does not matter');
  assert.equal(isAllowed(r, 'a', '/products/cafe'), true);
  const r2 = parseRobots('User-agent: *\nDisallow: /products/caf%C3%A9\n');
  assert.equal(isAllowed(r2, 'a', '/products/café'), false);
});

test('RFC 9309 2.2.3: %24 and %2A in a rule mean a literal $ and *, while bare * and a trailing $ are rule syntax', () => {
  const r = parseRobots('User-agent: *\nDisallow: /path/foo-%24\nDisallow: /path/file-with-a-%2A.html\n');
  assert.equal(isAllowed(r, 'a', '/path/foo-$'), false, 'RFC example: /path/foo-%24 matches /path/foo-$');
  assert.equal(isAllowed(r, 'a', '/path/foo-%24'), false);
  assert.equal(isAllowed(r, 'a', '/path/foo-$/more'), false, '%24 is not an end anchor');
  assert.equal(isAllowed(r, 'a', '/path/file-with-a-*.html'), false, 'RFC example: %2A matches a literal *');
  assert.equal(isAllowed(r, 'a', '/path/file-with-a-x.html'), true, '%2A is not a wildcard');
  // A bare * is a wildcard and a trailing $ is an end anchor.
  const r2 = parseRobots('User-agent: *\nDisallow: /a*b$\n');
  assert.equal(isAllowed(r2, 'a', '/axxb'), false);
  assert.equal(isAllowed(r2, 'a', '/axxbc'), true);
  // A $ that is not at the end of a rule is an ordinary character.
  const r3 = parseRobots('User-agent: *\nDisallow: /price$list\n');
  assert.equal(isAllowed(r3, 'a', '/price$list/x'), false);
  // Unreserved characters are decoded on both sides.
  const r4 = parseRobots('User-agent: *\nDisallow: /%7Euser\n');
  assert.equal(isAllowed(r4, 'a', '/~user'), false);
});
