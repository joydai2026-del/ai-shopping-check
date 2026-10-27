import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startScan } from '../src/scan.js';

const scanCfg = { maxProducts: 1, maxRequests: 5, timeoutMs: 1000, maxBytes: 50_000, totalTimeoutMs: 50 };

test('startScan enforces the whole-scan deadline and aborts the scan', async () => {
  let signal;
  const slow = (url, opts) => { signal = opts.signal; return new Promise((r) => setTimeout(r, 300)); };
  const { result, job } = startScan('a.example', scanCfg, { scan: slow });
  await assert.rejects(result, (e) => e.code === 'timeout');
  assert.equal(signal.aborted, true);
  await job;
});

test('the CLI uses the same deadline as the server', () => {
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(cli, /startScan\(/);
  assert.match(server, /startScan\(/);
});
