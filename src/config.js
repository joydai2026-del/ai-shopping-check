// All operational settings live here, read from the environment with safe
// defaults. Change behavior by setting env vars, never by editing code.
// Load order (first wins): process env, ~/.config/ai-shopping-check/env, ./.env
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function int(env, key, def, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Setting ${key} must be a whole number from ${min} to ${max}.`);
  return n;
}

export const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'ai-shopping-check', 'env');

/**
 * envFiles: list of files to read (later files have lower priority).
 * Pass envFiles: [] in tests to ignore files on the machine.
 */
export function loadConfig(processEnv = process.env, { envFiles } = {}) {
  const files = envFiles ?? [processEnv.ARC_ENV_FILE || DEFAULT_ENV_FILE, path.resolve('.env')];
  const fromFiles = {};
  for (const f of [...files].reverse()) Object.assign(fromFiles, readEnvFile(f));
  const env = { ...fromFiles, ...processEnv };

  const port = int(env, 'PORT', 3000, 0, 65535);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    // Set to 1 behind one hosting proxy (Render, Fly, Cloud Run) so rate limits are per visitor.
    trustProxyHops: int(env, 'TRUST_PROXY_HOPS', 0, 0, 5),
    scan: {
      maxProducts: int(env, 'SCAN_MAX_PRODUCT_PAGES', 3, 1, 10),
      maxRequests: int(env, 'SCAN_MAX_REQUESTS', 20, 5, 60),
      timeoutMs: int(env, 'SCAN_TIMEOUT_MS', 8000, 1000, 30000),
      maxBytes: int(env, 'SCAN_MAX_BYTES', 2_000_000, 50_000, 10_000_000),
      totalTimeoutMs: int(env, 'SCAN_TOTAL_TIMEOUT_MS', 30000, 5000, 120000),
    },
    limits: {
      scansPerMinutePerIp: int(env, 'SCANS_PER_MINUTE_PER_IP', 6, 1, 1000),
      maxConcurrentScans: int(env, 'MAX_CONCURRENT_SCANS', 3, 1, 50),
    },
  };
}
