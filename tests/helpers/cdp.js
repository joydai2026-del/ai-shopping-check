// A tiny Chrome DevTools Protocol driver, so the browser test needs no
// Playwright package. It launches the Chromium that Playwright already cached
// on this machine (or CHROME_PATH) and talks to it over a WebSocket.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const linuxCache = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const root of [cache, linuxCache]) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const p = path.join(root, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// Keeps pages silent: no speech, no media playback.
const SILENCE = `
  try { if (window.speechSynthesis) window.speechSynthesis.speak = () => {}; } catch {}
  try { HTMLMediaElement.prototype.play = function () { return Promise.resolve(); }; } catch {}
`;

export async function launch() {
  const bin = findChrome();
  if (!bin) return null;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-chrome-'));
  const proc = spawn(bin, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', '--mute-audio', '--disable-gpu', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    proc.stderr.on('data', (c) => {
      buf += c;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', () => reject(new Error('Chrome exited early')));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function newPage({ width, height, mobile = false }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const errors = [];
    listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Page.addScriptToEvaluateOnNewDocument', { source: SILENCE });
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    const evaluate = async (expression) => {
      const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expression, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate(expression)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    };
    return {
      errors,
      evaluate,
      waitFor,
      async goto(url) {
        await s('Page.navigate', { url });
        await waitFor('document.readyState === "complete"');
      },
      async type(selector, text) {
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
        await s('Input.insertText', { text });
      },
      async click(selector) {
        const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block: 'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await s('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
        }
      },
      async screenshot(file) {
        const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      },
    };
  }

  return {
    newPage,
    async close() {
      try { await send('Browser.close'); } catch { /* already closing */ }
      ws.close();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.on('exit', r)));
      fs.rmSync(userDir, { recursive: true, force: true });
    },
  };
}
