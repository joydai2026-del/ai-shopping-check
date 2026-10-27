// Page logic. All store data is inserted with textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const form = $('scan-form');
const input = $('store-url');
const btn = $('scan-btn');
const statusEl = $('status');
const results = $('results');

const BADGE = { pass: 'Good', warn: 'Could be better', fail: 'Needs fixing' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function render(report) {
  $('score-num').textContent = String(report.score);
  $('score-text').textContent = `${report.score} out of 100`;
  const ring = $('score-ring');
  ring.className = `score-ring ${report.grade}`;
  ring.style.setProperty('--pct', String(report.score));
  $('headline').textContent = report.headline;
  const kind = { shopify: 'Shopify store', woocommerce: 'WooCommerce store' }[report.platform] || 'store';
  $('store-line').textContent = `We checked ${report.store} (${kind}) and ${report.productsChecked.length} product page${report.productsChecked.length === 1 ? '' : 's'}.`;

  const list = $('checklist');
  list.replaceChildren();
  const order = { fail: 0, warn: 1, pass: 2 };
  for (const c of [...report.checks].sort((a, b) => order[a.status] - order[b.status])) {
    const li = el('li', `item ${c.status}`);
    li.dataset.check = c.id;
    const h = el('h3');
    h.append(el('span', `badge ${c.status}`, BADGE[c.status]), el('span', '', c.title));
    li.append(h, el('p', 'detail', c.detail));
    const why = el('p', 'why');
    why.append(el('span', 'label', 'Why it matters: '), document.createTextNode(c.why));
    li.append(why);
    if (c.fix) {
      const fix = el('p', 'fix');
      fix.append(el('span', 'label', 'How to fix: '), document.createTextNode(c.fix));
      li.append(fix);
    }
    list.append(li);
  }
  results.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) { setStatus('Please type your store address first.', true); input.focus(); return; }
  btn.disabled = true;
  // Clear the previous report, so an error for this store never sits above another store's score.
  results.hidden = true;
  setStatus('Checking your store. This takes about 20 seconds...');
  try {
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { setStatus(data.message || 'Something went wrong. Please try again.', true); return; }
    setStatus('Done. Here is what we found.');
    render(data);
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    setStatus('We could not reach the checker. Please check your internet and try again.', true);
  } finally {
    btn.disabled = false;
  }
});
