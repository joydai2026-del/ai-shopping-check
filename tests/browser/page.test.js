// Headless browser test of the real page, at desktop and 375x812 mobile.
// Drives the actual UI: type a store address, click, read the checklist,
// and check the layout. The "store" is the local synthetic fake store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, findChrome } from '../helpers/cdp.js';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { startFakeStore, listen } from '../helpers/fake-store.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results');
const skip = findChrome() ? false : 'no headless Chromium found (set CHROME_PATH)';
let browser, app, base, store;

before(async () => {
  if (skip) return;
  store = await startFakeStore('shopify-bad');
  app = createServer({ config: loadConfig({}, { envFiles: [] }), fetcherOptions: { allowPrivate: true } });
  base = await listen(app);
  browser = await launch();
});
after(async () => {
  if (skip) return;
  await browser.close();
  await store.close();
  await new Promise((r) => { app.closeAllConnections?.(); app.close(r); });
});

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 375, height: 812, mobile: true }]) {
  test(`scan flow works on ${vp.name} (${vp.width}x${vp.height})`, { skip, timeout: 60_000 }, async () => {
    const page = await browser.newPage(vp);
    await page.goto(`${base}/?silent=1`);
    assert.equal(await page.evaluate('document.querySelector("h1").textContent'), 'Can AI shopping assistants see your products?');
    assert.equal(await page.evaluate('document.getElementById("results").hidden'), true);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no sideways scroll before scan');

    // Empty submit shows a friendly hint instead of calling the server.
    await page.click('#scan-btn');
    await page.waitFor('document.getElementById("status").textContent.includes("Please type")');

    await page.type('#store-url', store.origin);
    await page.click('#scan-btn');
    await page.waitFor('!document.getElementById("results").hidden');

    const score = await page.evaluate('Number(document.getElementById("score-num").textContent)');
    assert.ok(score >= 0 && score < 50, `low score for the bad store, got ${score}`);
    assert.equal(await page.evaluate('document.querySelectorAll("#checklist .item").length'), 13);
    assert.equal(await page.evaluate('document.querySelector("#checklist .item").classList.contains("fail")'), true, 'problems listed first');
    assert.match(await page.evaluate('document.querySelector("#checklist .item.fail .fix").textContent'), /^How to fix: /);
    assert.match(await page.evaluate('document.querySelector("[data-check=shopping-bots-allowed] .detail").textContent'), /OAI-SearchBot/);
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no sideways scroll with results');

    // Buttons are big enough to tap, and there is no paid offer on the page.
    const btnH = await page.evaluate('document.getElementById("scan-btn").getBoundingClientRect().height');
    assert.ok(btnH >= 44, `tap target ${btnH}px`);
    assert.equal(await page.evaluate('document.getElementById("checkout-btn")'), null);

    await page.screenshot(path.join(OUT, `page-${vp.name}.png`));
    assert.deepEqual(page.errors, [], 'no console errors');
  });
}

// UX audit 2026-10-21: a failed second scan used to leave the first store's
// score on screen under the error, so it looked like the new store scored 100.
test('a failed second scan hides the previous store results', { skip, timeout: 60_000 }, async () => {
  const page = await browser.newPage({ name: 'desktop', width: 1280, height: 800 });
  await page.goto(`${base}/?silent=1`);
  await page.type('#store-url', store.origin);
  await page.click('#scan-btn');
  await page.waitFor('!document.getElementById("results").hidden');
  await page.evaluate('document.getElementById("store-url").value = ""');
  await page.type('#store-url', 'http://127.0.0.1:1');
  await page.click('#scan-btn');
  await page.waitFor('document.getElementById("status").classList.contains("error")');
  assert.equal(await page.evaluate('document.getElementById("results").hidden'), true, 'old results must not stay under the new error');
});
