// Command-line scan for agents and scripts: node src/cli.js mystore.com
import { startScan } from './scan.js';
import { loadConfig } from './config.js';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node src/cli.js <store-url>');
  process.exit(2);
}
const { scan } = loadConfig();
try {
  // Same whole-scan deadline as the server (SCAN_TOTAL_TIMEOUT_MS).
  const report = await startScan(target, scan).result;
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error(JSON.stringify({ error: e.code || 'scan_failed', message: e.message }));
  process.exit(1);
}
