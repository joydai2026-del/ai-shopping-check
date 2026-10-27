import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseEnvFile } from '../src/config.js';

test('env file parsing and load order (process env wins over files)', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two"\nC=\'3\'\nbad line\n'), { A: '1', B: 'two', C: '3' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-'));
  const f = path.join(dir, 'env');
  fs.writeFileSync(f, 'PORT=4321\nSCAN_MAX_PRODUCT_PAGES=5\n');
  try {
    const c = loadConfig({}, { envFiles: [f] });
    assert.equal(c.port, 4321);
    assert.equal(c.scan.maxProducts, 5);
    assert.equal(loadConfig({ PORT: '5555' }, { envFiles: [f] }).port, 5555);
    assert.equal(loadConfig({}, { envFiles: [] }).port, 3000);
    assert.throws(() => loadConfig({ SCAN_MAX_PRODUCT_PAGES: '999' }, { envFiles: [] }), /SCAN_MAX_PRODUCT_PAGES/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config has no payment settings', () => {
  const c = loadConfig({ STRIPE_SECRET_KEY: 'anything', FIX_OFFER_PRICE_CENTS: '100' }, { envFiles: [] });
  assert.equal(c.stripe, undefined);
  assert.equal(c.offer, undefined);
  assert.equal(c.limits.checkoutsPerMinutePerIp, undefined);
});
