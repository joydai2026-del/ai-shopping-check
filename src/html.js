// Tiny, dependency-free readers for the bits of HTML we care about:
// schema.org JSON-LD blocks and <meta> tags (Open Graph).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
export function decodeEntities(s = '') {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k.startsWith('#')) {
      const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[k] ?? m;
  });
}

function parseAttrs(tagRaw) {
  const tag = tagRaw.slice(0, 2000); // a hostile page cannot make this slow
  const out = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

/** Returns { blocks: [parsed JSON values], errors: number } */
export function extractJsonLd(html = '') {
  const blocks = [];
  let errors = 0;
  // indexOf scanning instead of one big regex: linear time even on hostile pages.
  // ASCII-only lowercasing keeps every offset identical to the original text.
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let pos = 0;
  while (blocks.length + errors < 50) {
    const start = lower.indexOf('<script', pos);
    if (start < 0) break;
    const tagEnd = lower.indexOf('>', start);
    if (tagEnd < 0) break;
    const close = lower.indexOf('</script', tagEnd);
    if (close < 0) break;
    pos = close + 8;
    const attrs = parseAttrs(html.slice(start + 7, tagEnd));
    if (String(attrs.type || '').toLowerCase().trim() !== 'application/ld+json') continue;
    const raw = html.slice(tagEnd + 1, close).replace(/^\s*<!--/, '').replace(/-->\s*$/, '').replace(/^\s*\/\/<!\[CDATA\[/, '').replace(/\/\/\]\]>\s*$/, '').trim();
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      errors++;
    }
  }
  return { blocks, errors };
}

/** Returns { 'og:title': '...', 'product:price:amount': '...', description: '...' } (first value wins). */
export function extractMeta(html = '') {
  const meta = {};
  const re = /<meta\b[^>]{0,2000}>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  return meta;
}

function typesOf(node) {
  const t = node && node['@type'];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x).replace(/^https?:\/\/schema\.org\//i, ''));
}

function walk(value, visit, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) walk(v, visit, depth + 1); return; }
  visit(value);
  if (value['@graph']) walk(value['@graph'], visit, depth + 1);
}

/** Finds the first Product (or ProductGroup) node across JSON-LD blocks. */
export function findProductNode(blocks) {
  let found = null;
  for (const b of blocks) {
    walk(b, (n) => {
      if (found) return;
      const t = typesOf(n);
      if (t.includes('Product') || t.includes('ProductGroup')) found = n;
    });
    if (found) break;
  }
  return found;
}

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Flattens the messy shapes schema.org allows into one simple object. */
export function normalizeProduct(node) {
  if (!node) return null;
  const variants = asArray(node.hasVariant);
  const offerNodes = [];
  const collectOffers = (o) => {
    for (const off of asArray(o)) {
      if (!off || typeof off !== 'object') continue;
      offerNodes.push(off);
      if (off.offers) collectOffers(off.offers); // AggregateOffer.offers
    }
  };
  collectOffers(node.offers);
  for (const v of variants) collectOffers(v && v.offers);

  let price = '';
  let currency = '';
  let availability = '';
  for (const off of offerNodes) {
    const spec = asArray(off.priceSpecification)[0] || {};
    price ||= str(off.price ?? off.lowPrice ?? spec.price);
    currency ||= str(off.priceCurrency ?? spec.priceCurrency);
    availability ||= str(off.availability);
  }

  const idSources = [node, ...variants, ...offerNodes];
  const pick = (...keys) => {
    for (const src of idSources) for (const k of keys) if (src && str(src[k])) return str(src[k]);
    return '';
  };
  const brandRaw = asArray(node.brand)[0];
  const brand = typeof brandRaw === 'object' && brandRaw ? str(brandRaw.name) : str(brandRaw);
  const imageRaw = asArray(node.image)[0] ?? asArray(variants[0] && variants[0].image)[0];
  const image = typeof imageRaw === 'object' && imageRaw ? str(imageRaw.url || imageRaw.contentUrl) : str(imageRaw);

  return {
    name: str(node.name),
    description: decodeEntities(str(node.description).slice(0, 10_000)).replace(/<[^<>]{0,500}>/g, ' ').replace(/\s+/g, ' ').trim(),
    image,
    brand,
    sku: pick('sku'),
    gtin: pick('gtin', 'gtin14', 'gtin13', 'gtin12', 'gtin8'),
    mpn: pick('mpn'),
    price,
    currency,
    availability: availability.replace(/^https?:\/\/schema\.org\//i, ''),
    hasOffers: offerNodes.length > 0,
  };
}

/** GS1 check-digit validation for GTIN-8/12/13/14. */
export function isValidGtin(gtin) {
  const s = String(gtin).trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Collects <loc> URLs from sitemap XML; tells whether it is an index. */
export function parseSitemap(xml = '') {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const locs = [];
  const re = /<loc>([^<]{0,4096})<\/loc>|<loc><!\[CDATA\[([^\]]{0,4096})\]\]><\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) && locs.length < 5000) {
    const v = decodeEntities((m[1] ?? m[2] ?? '').trim());
    if (v) locs.push(v);
  }
  return { isIndex, locs };
}
