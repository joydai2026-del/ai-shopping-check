// Every check is a small pure function over the data the scanner collected.
// Each returns { status: 'pass' | 'warn' | 'fail', detail }.
// Words shown to store owners live here, in plain English.
import { isAllowed } from './robots.js';
import { SHOPPING_BOTS, ADVISORY_BOTS, TRAINING_BOTS } from './bots.js';
import { isValidGtin } from './html.js';

const fixFor = (platform, fix) => fix[platform] || fix.other;

// For per-product checks: pass if every product has it, warn if some, fail if none.
function perProduct(data, has, label) {
  const r = perProductCore(data, has, label);
  return { ...r, detail: r.detail + failedNote(data) };
}

// Say so when some sampled product pages could not be opened, instead of
// quietly judging the store on the rest.
function failedNote(data) {
  const ok = data.products.filter((p) => p.ok).length;
  const failed = data.products.length - ok;
  if (!failed || !ok) return '';
  return ` ${failed} other product page${failed === 1 ? '' : 's'} could not be opened, so ${failed === 1 ? 'it is' : 'they are'} not counted here.`;
}

function perProductCore(data, has, label) {
  const pages = data.products.filter((p) => p.ok);
  if (!pages.length) return { status: 'fail', detail: 'We could not open any of your product pages.' };
  const yes = pages.filter((p) => p.product && has(p.product)).length;
  if (pages.length === 1) {
    return yes
      ? { status: 'pass', detail: `The product page we checked shows ${label}.` }
      : { status: 'fail', detail: `The product page we checked does not show ${label} in a way AI can read.` };
  }
  if (yes === pages.length) return { status: 'pass', detail: `All ${pages.length} product pages we checked show ${label}.` };
  if (yes === 0) return { status: 'fail', detail: `None of the ${pages.length} product pages we checked show ${label} in a way AI can read.` };
  return { status: 'warn', detail: `${yes} of ${pages.length} product pages we checked show ${label}.` };
}

function unreadableDetail(data) {
  const code = data.robots.status ? ` (it answered with code ${data.robots.status})` : '';
  return `We could not read your robots.txt${code}, so we cannot tell which AI bots are allowed. AI bots may have the same trouble.`;
}

function blockedBots(data, bots) {
  // The store's own robots.txt for the home page and every sampled product
  // address (path and query, before and after redirects), plus the robots.txt
  // of any other site a product page redirected to.
  const targets = [];
  if (data.robots.found) {
    const sampled = data.productPaths || (data.productPath ? [data.productPath] : []);
    targets.push({ parsed: data.robots.parsed, paths: [...new Set(['/', data.homePath || '/', ...sampled])] });
  }
  for (const x of data.extraRobots || []) if (!x.state || x.state === 'found') targets.push(x);
  return bots.filter((b) => targets.some((t) => t.paths.some((p) => !isAllowed(t.parsed, b.token, p))));
}

export const CHECKS = [
  {
    id: 'shopping-bots-allowed',
    title: 'AI shopping assistants are allowed in',
    weight: 18,
    why: 'Your robots.txt file is a "keep out" sign for robots. If it blocks AI shopping assistants, they cannot see your products at all.',
    fix: {
      shopify: 'In Shopify, go to Online Store, Themes, Edit code, and open robots.txt.liquid. Remove the lines that block the bots listed above.',
      woocommerce: 'Open your robots.txt (often in Yoast SEO, Tools, File editor) and remove the "Disallow" lines for the bots listed above.',
      other: 'Edit your robots.txt file and remove the "Disallow" lines for the bots listed above.',
    },
    run(data) {
      if (data.robots.unreadable) return { status: 'warn', detail: unreadableDetail(data) };
      const unknownSites = (data.extraRobots || []).filter((x) => x.state === 'unreadable').map((x) => x.origin);
      const unknownNote = unknownSites.length
        ? ` Some of your product links send visitors to another website (${unknownSites.join(', ')}), and we could not read the robots.txt there, so we cannot tell whether AI assistants are allowed on those pages.`
        : '';
      const blocked = blockedBots(data, SHOPPING_BOTS);
      if (!blocked.length && unknownSites.length) return { status: 'warn', detail: unknownNote.trim() };
      if (!data.robots.found && !(data.extraRobots || []).some((x) => x.state === 'found')) return { status: 'pass', detail: 'You have no robots.txt file, so nothing is blocked.' };
      const advisory = blockedBots(data, ADVISORY_BOTS);
      const note = advisory.length
        ? ` Your robots.txt also disallows ${advisory.map((b) => `${b.token} (${b.who})`).join(', ')}. OpenAI says robots.txt rules may not apply to these shopper-started visits, so this does not change your score.`
        : '';
      if (!blocked.length) return { status: 'pass', detail: `ChatGPT search, Perplexity, Claude and Google are all allowed to read your store.${note}` };
      const status = blocked.length >= 3 ? 'fail' : 'warn';
      return { status, detail: `Blocked: ${blocked.map((b) => `${b.token} (${b.who})`).join(', ')}.${note}${unknownNote}` };
    },
  },
  {
    id: 'training-bots',
    title: 'AI training bots (your choice)',
    weight: 5,
    why: 'These bots collect pages to train AI. Blocking them will not hide you from AI search, but blocking Google-Extended can keep you out of some Gemini answers.',
    fix: { other: 'This is a business choice. If you want AI companies to be able to use your pages for training, remove the "Disallow" lines for these bots from robots.txt.' },
    run(data) {
      if (data.robots.unreadable) return { status: 'warn', detail: unreadableDetail(data) };
      const blocked = blockedBots(data, TRAINING_BOTS);
      if (!blocked.length) return { status: 'pass', detail: 'You allow AI training bots to read your store.' };
      return { status: 'warn', detail: `You block: ${blocked.map((b) => `${b.token} (${b.who})`).join(', ')}. That is fine if you chose it.` };
    },
  },
  {
    id: 'product-feed',
    title: 'Your product list is publicly readable',
    weight: 10,
    why: 'Shopify and WooCommerce publish a machine-readable list of your products. AI tools use it to learn what you sell, quickly and correctly.',
    fix: {
      shopify: 'Your Shopify product list (/products.json) should be on by default. If it is off, check apps or password protection that may hide it.',
      woocommerce: 'Make sure WooCommerce is up to date and that no security plugin blocks /wp-json/wc/store/v1/products.',
      other: 'We could not find a Shopify or WooCommerce product list. This tool works best for those two store types.',
    },
    run(data) {
      if (data.feed.ok && data.feed.count > 0) {
        return { status: 'pass', detail: `We found ${data.feed.count} product${data.feed.count === 1 ? '' : 's'} in your public product list.` };
      }
      if (data.feed.ok) return { status: 'warn', detail: 'Your product list is readable but it is empty.' };
      return { status: 'fail', detail: 'We could not read a public product list for your store.' };
    },
  },
  {
    id: 'sitemap',
    title: 'A sitemap lists your products',
    weight: 10,
    why: 'A sitemap is a table of contents for robots. It helps AI assistants find every product, not just the ones on your home page.',
    fix: {
      shopify: 'Shopify makes /sitemap.xml for you. If it is missing, make sure your store is not password protected.',
      woocommerce: 'Turn on sitemaps in WordPress (Settings, Reading) or in your SEO plugin, and include products.',
      other: 'Add a sitemap.xml that lists your product pages, and mention it in robots.txt.',
    },
    run(data) {
      if (!data.sitemap.found) return { status: 'fail', detail: 'We did not find a sitemap.' };
      if (data.sitemap.productUrlCount > 0) {
        const n = data.sitemap.productUrlCount;
        return { status: 'pass', detail: data.sitemap.partial ? `Your sitemap lists your products (we counted ${n} in the first part).` : `Your sitemap lists ${n} product pages.` };
      }
      return { status: 'warn', detail: 'You have a sitemap, but we did not see product pages in it.' };
    },
  },
  {
    id: 'product-schema',
    title: 'Product pages have AI-readable product info',
    weight: 13,
    why: 'Product pages can carry hidden "labels" (called structured data) that tell AI exactly what the product is. Without them, AI has to guess from the page.',
    fix: {
      shopify: 'Most modern Shopify themes add this. Update your theme, or add a trusted structured-data app from the Shopify App Store.',
      woocommerce: 'WooCommerce adds this by default. Check that a plugin or theme is not removing it, or add an SEO plugin such as Yoast or Rank Math.',
      other: 'Add schema.org Product data (JSON-LD) to each product page.',
    },
    run(data) {
      const r = perProduct(data, () => true, 'product info');
      const errs = data.products.reduce((n, p) => n + (p.jsonldErrors || 0), 0);
      if (errs) r.detail += ` ${errs} block(s) of product info were broken and could not be read.`;
      return r;
    },
  },
  {
    id: 'price',
    title: 'Price and currency are clear',
    weight: 10,
    why: 'AI shopping assistants compare prices. If they cannot read your price and currency, they may skip your product.',
    fix: {
      shopify: 'Update your theme so product pages include price and currency in their structured data.',
      woocommerce: 'Make sure each product has a regular price set, and that your SEO plugin outputs offers.',
      other: 'Add offers with price and priceCurrency to your product structured data.',
    },
    run: (data) => perProduct(data, (p) => p.price !== '' && !Number.isNaN(Number(p.price)) && /^[A-Z]{3}$/.test(p.currency), 'a price with currency'),
  },
  {
    id: 'availability',
    title: 'Stock status is shown',
    weight: 8,
    why: 'Shoppers ask AI for things they can buy today. If AI cannot tell whether you have it in stock, it may recommend someone else.',
    fix: {
      shopify: 'Turn on inventory tracking for your products and update your theme so it shows availability in structured data.',
      woocommerce: 'Set stock status on each product (Inventory tab).',
      other: 'Add offers.availability (for example https://schema.org/InStock) to your product structured data.',
    },
    run: (data) => perProduct(data, (p) => p.availability !== '', 'stock status'),
  },
  {
    id: 'identifiers',
    title: 'Products have barcodes or SKUs',
    weight: 8,
    why: 'Barcodes (GTIN/UPC/EAN) and SKUs let AI match your product to the exact same item elsewhere, which builds trust and wins comparisons.',
    fix: {
      shopify: 'Add the barcode (GTIN, UPC or EAN) and SKU to each product variant in Shopify admin.',
      woocommerce: 'Fill in the SKU field and the GTIN/UPC/EAN field on each product (Inventory tab).',
      other: 'Add gtin and sku to your product structured data.',
    },
    run(data) {
      const r = perProduct(data, (p) => Boolean(p.gtin || p.sku || p.mpn), 'a barcode or SKU');
      const pages = data.products.filter((p) => p.ok && p.product);
      const badGtin = pages.filter((p) => p.product.gtin && !isValidGtin(p.product.gtin)).length;
      if (badGtin) {
        r.detail += ` ${badGtin} barcode(s) look mistyped (the check digit is wrong).`;
        if (r.status === 'pass') r.status = 'warn';
      }
      if (r.status !== 'pass' && data.feed.hasBarcodes) {
        r.detail += ' Good news: your product list already has barcodes, your pages just do not show them.';
      }
      return r;
    },
  },
  {
    id: 'brand',
    title: 'Brand name is shown',
    weight: 4,
    why: 'People often shop by brand ("Nike running shoes"). A clear brand helps AI match those questions to you.',
    fix: {
      shopify: 'Fill in the Vendor field on each product. Most themes use it as the brand.',
      woocommerce: 'Use a brand plugin or your SEO plugin to set the product brand.',
      other: 'Add brand to your product structured data.',
    },
    run: (data) => perProduct(data, (p) => p.brand !== '', 'a brand'),
  },
  {
    id: 'image',
    title: 'Product photo is linked',
    weight: 4,
    why: 'AI shopping results show a picture. No readable photo means a plain, easy-to-skip result.',
    fix: { other: 'Make sure every product has a main photo, and that your structured data includes image.' },
    run: (data) => perProduct(data, (p) => p.image !== '', 'a product photo'),
  },
  {
    id: 'description',
    title: 'Products have a real description',
    weight: 4,
    why: 'AI answers questions like "is this good for sensitive skin?" from your description. A few words is not enough.',
    fix: { other: 'Write at least two or three sentences per product: what it is, who it is for, size or materials.' },
    run: (data) => perProduct(data, (p) => p.description.length >= 50, 'a description of 50+ characters'),
  },
  {
    id: 'open-graph',
    title: 'Link previews are set up',
    weight: 4,
    why: 'Open Graph tags make the title, picture and price show up nicely when a link is shared, and many AI tools read them too.',
    fix: {
      shopify: 'Shopify themes add these. If missing, update your theme.',
      woocommerce: 'An SEO plugin such as Yoast or Rank Math adds these automatically.',
      other: 'Add og:title, og:image and og:type meta tags to product pages.',
    },
    run(data) {
      const pages = data.products.filter((p) => p.ok);
      if (!pages.length) return { status: 'fail', detail: 'We could not open any of your product pages.' };
      const full = pages.filter((p) => p.meta['og:title'] && p.meta['og:image']).length;
      if (full === pages.length) return { status: 'pass', detail: 'Your product pages have a title and picture for previews.' };
      if (full === 0) return { status: 'fail', detail: 'Your product pages are missing preview title and picture tags.' };
      return { status: 'warn', detail: `${full} of ${pages.length} product pages have preview tags.` };
    },
  },
  {
    id: 'llms-txt',
    title: 'An llms.txt guide for AI (optional, new)',
    weight: 2,
    why: 'llms.txt is a new, optional "welcome note" for AI tools that says what your store is and where things are. Few stores have one yet.',
    fix: { other: 'Add a short llms.txt file at your site root with your store name, a one-line summary, and links to your main collections.' },
    run: (data) => (data.llms.found
      ? { status: 'pass', detail: 'You have an llms.txt file. Nice and early.' }
      : { status: 'warn', detail: 'You do not have an llms.txt file yet. This is optional.' }),
  },
];

const FACTOR = { pass: 1, warn: 0.5, fail: 0 };

export function runChecks(data) {
  const platform = data.platform === 'shopify' || data.platform === 'woocommerce' ? data.platform : 'other';
  const results = CHECKS.map((c) => {
    const r = c.run(data);
    return { id: c.id, title: c.title, status: r.status, detail: r.detail, why: c.why, fix: r.status === 'pass' ? '' : fixFor(platform, c.fix), weight: c.weight };
  });
  const total = results.reduce((n, r) => n + r.weight, 0);
  const got = results.reduce((n, r) => n + r.weight * FACTOR[r.status], 0);
  const score = Math.round((got / total) * 100);
  return { score, results };
}

// The headline must never sound like good news when robots.txt keeps AI
// shopping assistants out, even if the product data scores well.
export function summarize(score, results = []) {
  const access = results.find((r) => r.id === 'shopping-bots-allowed');
  if (access && access.status === 'fail') {
    return { grade: 'poor', headline: 'Needs work. Your robots.txt blocks several AI shopping assistants, so they may not see your products at all.' };
  }
  if (access && access.status === 'warn' && score >= 80) {
    return { grade: 'ok', headline: 'Close. Your product details are in good shape, but some AI shopping assistants are blocked or we could not read your robots.txt.' };
  }
  if (score >= 80) return { grade: 'good', headline: 'Great news. AI shopping assistants can read most of your store.' };
  if (score >= 50) return { grade: 'ok', headline: 'Getting there. AI shopping assistants can read some of your store, but they miss important details.' };
  return { grade: 'poor', headline: 'Needs work. AI shopping assistants will struggle to find and recommend your products.' };
}
