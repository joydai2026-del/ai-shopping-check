// Orchestrates one store scan: fetch the public bits, then run the checks.
import { createFetcher, FetchError } from './safe-fetch.js';
import { parseRobots } from './robots.js';
import { extractJsonLd, extractMeta, findProductNode, normalizeProduct, parseSitemap } from './html.js';
import { runChecks, summarize } from './checks.js';

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Accepts "mystore.com", "https://mystore.com/some/page", etc. Returns the origin. */
export function normalizeStoreUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new ScanError('bad_url', 'Please type your store address.');
  if (s.length > 300) throw new ScanError('bad_url', 'That web address is too long.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ScanError('bad_url', 'That does not look like a web address. Try something like mystore.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ScanError('bad_url', 'Only http and https web addresses can be checked.');
  return u.origin;
}

const JSON_ACCEPT = 'application/json';
const HTML_ACCEPT = 'text/html,application/xhtml+xml';

async function tryGet(fetcher, url, opts) {
  try {
    return await fetcher.get(url, opts);
  } catch (e) {
    if (e instanceof FetchError && (e.code === 'blocked' || e.code === 'aborted')) throw e;
    return null;
  }
}

function parseJson(res) {
  if (!res || res.status !== 200 || res.truncated) return null;
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

export function detectPlatform(home) {
  const h = home.headers || {};
  const html = home.body || '';
  if (h['x-shopify-stage'] || h['x-shopid'] || /shopify/i.test(String(h['powered-by'] || '')) || /cdn\.shopify\.com|Shopify\.theme/.test(html)) return 'shopify';
  if (/wp-content\/plugins\/woocommerce|woocommerce/i.test(html) || /\/wp-json\//.test(String(h.link || ''))) return 'woocommerce';
  return 'unknown';
}

const sameOrigin = (a, origin) => {
  try { return new URL(a).origin === origin; } catch { return false; }
};

async function readShopifyFeed(fetcher, origin) {
  const res = await tryGet(fetcher, `${origin}/products.json?limit=10`, { accept: JSON_ACCEPT });
  const json = parseJson(res);
  if (!json || !Array.isArray(json.products)) return null;
  const products = json.products.filter((p) => p && typeof p.handle === 'string');
  const variants = products.flatMap((p) => (Array.isArray(p.variants) ? p.variants : []));
  const feed = {
    ok: true, source: 'products.json', count: products.length,
    hasBarcodes: variants.some((v) => v && v.barcode), hasSkus: variants.some((v) => v && v.sku),
  };
  const urls = products.map((p) => `${origin}/products/${encodeURIComponent(p.handle)}`);
  // The single-product endpoint confirms per-product data is reachable too.
  if (products[0]) {
    const one = parseJson(await tryGet(fetcher, `${urls[0]}.json`, { accept: JSON_ACCEPT }));
    feed.productEndpoint = Boolean(one && one.product);
    if (one && one.product && Array.isArray(one.product.variants)) {
      feed.hasBarcodes ||= one.product.variants.some((v) => v && v.barcode);
    }
  }
  return { feed, urls };
}

async function readWooFeed(fetcher, origin) {
  const res = await tryGet(fetcher, `${origin}/wp-json/wc/store/v1/products?per_page=10`, { accept: JSON_ACCEPT });
  const json = parseJson(res);
  if (!Array.isArray(json)) return null;
  const products = json.filter((p) => p && typeof p.permalink === 'string');
  return {
    feed: { ok: true, source: 'store-api', count: products.length, hasBarcodes: false, hasSkus: products.some((p) => p.sku) },
    urls: products.map((p) => p.permalink).filter((u) => sameOrigin(u, origin)),
  };
}

const PRODUCT_PATH = /\/products?\/[^/?#]+/i;

async function readSitemap(fetcher, origin, robotsSitemaps, platform) {
  const candidates = [...robotsSitemaps.filter((u) => sameOrigin(u, origin)).slice(0, 1), `${origin}/sitemap.xml`];
  if (platform === 'woocommerce') candidates.push(`${origin}/wp-sitemap.xml`);
  for (const url of [...new Set(candidates)]) {
    const res = await tryGet(fetcher, url, { accept: 'application/xml,text/xml' });
    if (!res || res.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(res.body)) continue;
    let { isIndex, locs } = parseSitemap(res.body);
    if (isIndex) {
      const child = locs.filter((l) => sameOrigin(l, origin)).sort((a, b) => Number(/product/i.test(b)) - Number(/product/i.test(a)))[0];
      locs = [];
      if (child) {
        const cr = await tryGet(fetcher, child, { accept: 'application/xml,text/xml' });
        if (cr && cr.status === 200) locs = parseSitemap(cr.body).locs;
      }
    }
    const productUrls = locs.filter((l) => sameOrigin(l, origin) && PRODUCT_PATH.test(new URL(l).pathname));
    return { found: true, url, productUrlCount: productUrls.length, productUrls, partial: isIndex };
  }
  return { found: false, productUrlCount: 0, productUrls: [] };
}

async function readProductPage(fetcher, url) {
  const res = await tryGet(fetcher, url, { accept: HTML_ACCEPT });
  // finalUrl: where the page really lives after redirects (robots.txt is checked there).
  const finalUrl = res && res.url ? res.url : url;
  if (!res || res.status !== 200) return { url, finalUrl, ok: false, product: null, meta: {}, jsonldErrors: 0 };
  try {
    const { blocks, errors } = extractJsonLd(res.body);
    return { url, finalUrl, ok: true, product: normalizeProduct(findProductNode(blocks)), meta: extractMeta(res.body), jsonldErrors: errors };
  } catch {
    // A page so odd that we cannot read it counts as "no product info", not a crashed scan.
    return { url, finalUrl, ok: true, product: null, meta: {}, jsonldErrors: 1 };
  }
}

/**
 * Scans a store. options: { fetcher, fetcherOptions, maxProducts }
 * Returns a plain JSON-safe report.
 */
export async function scanStore(input, options = {}) {
  const startOrigin = normalizeStoreUrl(input);
  const fetcher = options.fetcher || createFetcher(options.fetcherOptions);
  const maxProducts = options.maxProducts ?? 3;

  let home;
  try {
    home = await fetcher.get(`${startOrigin}/`, { accept: HTML_ACCEPT });
  } catch (e) {
    if (e instanceof FetchError && (e.code === 'blocked' || e.code === 'bad_url')) throw new ScanError('blocked', 'That address is not a public website we can check.');
    if (e instanceof FetchError && e.code === 'aborted') throw new ScanError('timeout', 'The scan was stopped.');
    throw new ScanError('unreachable', 'We could not reach that store. Check the address and try again.');
  }
  if (home.status >= 400) {
    throw new ScanError('unreachable', `The store answered with an error (code ${home.status}). It may be password protected or blocking checks.`);
  }
  const origin = new URL(home.url).origin; // follow a redirect such as shop.com -> www.shop.com
  let platform = detectPlatform(home);

  const [robotsRes, llmsRes] = await Promise.all([
    tryGet(fetcher, `${origin}/robots.txt`, { accept: 'text/plain', maxBytes: 500_000 }),
    tryGet(fetcher, `${origin}/llms.txt`, { accept: 'text/plain', maxBytes: 200_000 }),
  ]);
  // 404/410 means "no robots.txt" (everything allowed). Any other failure means we do not know.
  // A 200 that is really a web page ("Access denied") or was cut off is unreadable, not missing.
  const robotsFound = Boolean(robotsRes && robotsRes.status === 200 && !robotsRes.truncated && !/<html|<!doctype/i.test(robotsRes.body.slice(0, 500)));
  const robotsMissing = Boolean(robotsRes && (robotsRes.status === 404 || robotsRes.status === 410));
  const robots = {
    found: robotsFound,
    unreadable: !robotsFound && !robotsMissing,
    status: robotsRes ? robotsRes.status : null,
    parsed: parseRobots(robotsFound ? robotsRes.body : ''),
  };
  const llms = { found: Boolean(llmsRes && llmsRes.status === 200 && llmsRes.body.trim().startsWith('#')) };

  let feedResult = null;
  if (platform !== 'woocommerce') feedResult = await readShopifyFeed(fetcher, origin);
  if (feedResult && platform === 'unknown') platform = 'shopify';
  if (!feedResult && platform !== 'shopify') {
    feedResult = await readWooFeed(fetcher, origin);
    if (feedResult && platform === 'unknown') platform = 'woocommerce';
  }
  const feed = feedResult ? feedResult.feed : { ok: false, count: 0, hasBarcodes: false, hasSkus: false };

  const sitemap = await readSitemap(fetcher, origin, robots.parsed.sitemaps, platform);

  const urls = [...new Set([...(feedResult ? feedResult.urls : []), ...sitemap.productUrls])].slice(0, maxProducts);
  const products = [];
  for (const u of urls) products.push(await readProductPage(fetcher, u)); // one at a time, to be polite
  // robots.txt is matched on path AND query, at every address a bot would fetch:
  // the home page where it really ends up, each product URL, and where it
  // redirects to. A redirect to another site is checked against that site's own
  // robots.txt. Every sampled destination is checked; one we cannot read is
  // reported as unknown, never counted as allowed.
  const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };
  const productPaths = [];
  const otherSites = new Map();
  for (const p of products) {
    productPaths.push(pathOf(p.url));
    const fin = new URL(p.finalUrl || p.url);
    if (fin.origin === origin) productPaths.push(pathOf(fin.href));
    else {
      if (!otherSites.has(fin.origin)) otherSites.set(fin.origin, []);
      otherSites.get(fin.origin).push(pathOf(fin.href));
    }
  }
  const extraRobots = [];
  for (const [site, paths] of otherSites) {
    const r = await tryGet(fetcher, `${site}/robots.txt`, { accept: 'text/plain', maxBytes: 500_000 });
    const found = Boolean(r && r.status === 200 && !r.truncated && !/<html|<!doctype/i.test(r.body.slice(0, 500)));
    const missing = Boolean(r && (r.status === 404 || r.status === 410));
    extraRobots.push({
      origin: site,
      state: found ? 'found' : missing ? 'missing' : 'unreadable',
      parsed: parseRobots(found ? r.body : ''),
      paths: [...new Set(paths)],
    });
  }

  const data = { platform, robots, llms, feed, sitemap, products, homePath: pathOf(home.url), productPaths: [...new Set(productPaths)], extraRobots };
  const { score, results } = runChecks(data);
  const { grade, headline } = summarize(score, results);

  return {
    store: origin,
    platform,
    score,
    grade,
    headline,
    checks: results,
    productsChecked: products.map((p) => ({ url: p.url, opened: p.ok, name: p.product ? p.product.name : '' })),
    requestsUsed: fetcher.used,
    scannedAt: new Date().toISOString(),
  };
}

// Runs one scan with the whole-scan deadline (scan.totalTimeoutMs). Used by the
// server and the CLI so both stop at the same limit. `result` answers on time;
// `job` settles only when the scan has really finished (after the abort).
export function startScan(url, scanConfig, { scan = scanStore, fetcherOptions = {} } = {}) {
  const controller = new AbortController();
  const job = Promise.resolve().then(() => scan(url, {
    maxProducts: scanConfig.maxProducts,
    signal: controller.signal,
    fetcherOptions: { maxRequests: scanConfig.maxRequests, timeoutMs: scanConfig.timeoutMs, maxBytes: scanConfig.maxBytes, ...fetcherOptions, signal: controller.signal },
  }));
  let t;
  const result = Promise.race([
    job.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => {
        controller.abort();
        reject(new ScanError('timeout', 'The scan took too long. The store may be slow. Please try again.'));
      }, scanConfig.totalTimeoutMs);
    }),
  ]);
  return { job, result };
}
