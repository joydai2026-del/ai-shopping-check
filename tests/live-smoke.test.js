// Opt-in live smoke test against a real public Shopify store.
// Skipped unless LIVE_SMOKE=1. Run with: npm run test:live
// Default store verified reachable on 2026-10-20. Override with LIVE_SMOKE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanStore } from '../src/scan.js';

const target = process.env.LIVE_SMOKE_URL || 'www.allbirds.com';

test(`live scan of ${target}`, { skip: process.env.LIVE_SMOKE !== '1' && 'set LIVE_SMOKE=1 to run', timeout: 60_000 }, async () => {
  const r = await scanStore(target);
  assert.equal(r.platform, 'shopify');
  assert.ok(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100);
  assert.equal(r.checks.length, 13);
  assert.equal(r.checks.find((c) => c.id === 'product-feed').status, 'pass');
  assert.ok(r.productsChecked.some((p) => p.opened), 'opened at least one real product page');
  assert.ok(r.requestsUsed <= 20);
});
