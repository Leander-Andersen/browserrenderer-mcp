// Fixed code for the retail tools, executed by upstream browser_run_code_unsafe.
//
// buildRetailCode() assembles ONE async function (page) => {...} out of the top-level functions of this
// file (embedded with Function.prototype.toString) plus the validated parameters, embedded only through
// JSON.stringify. Every function below must therefore be self-contained: it may reference only its own
// locals and the other embedded functions, never imports or module constants.
//
// The code collects RAW, trimmed bits of what the shops serve to an anonymous visitor (JSON-LD, a few
// selector texts, same-origin API JSON). Normalising and formatting happen gateway-side (retail.mjs).

// Strip control/invisible characters, collapse whitespace, cap the length.
export function cleanText(s, max) {
  let t = '';
  if (typeof s === 'string') t = s;
  else if (typeof s === 'number' || typeof s === 'boolean') t = String(s);
  t = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t;
}

// JSON-LD script texts -> trimmed schema.org Product objects (@graph, arrays and ItemList entries are walked).
export function trimLd(texts) {
  const out = [];
  const slim = (n) => {
    const b = n.brand && typeof n.brand === 'object' ? n.brand.name : n.brand;
    let gtin = '';
    for (const k of ['gtin13', 'gtin', 'gtin14', 'gtin12', 'gtin8']) {
      const v = cleanText(n[k], 20).replace(/\D/g, '');
      if (v.length >= 8 && v.length <= 14) { gtin = v; break; }
    }
    const rawOffers = Array.isArray(n.offers) ? n.offers : (n.offers && typeof n.offers === 'object' ? [n.offers] : []);
    const offers = rawOffers.slice(0, 6).filter((o) => o && typeof o === 'object').map((o) => {
      const c = o.eligibleCustomerType;
      const cust = c && typeof c === 'object' ? c['@id'] || c['@type'] : c;
      return {
        name: cleanText(o.name, 60), price: cleanText(o.price, 24), cur: cleanText(o.priceCurrency, 8),
        avail: cleanText(o.availability, 80), cust: cleanText(cust, 80), url: cleanText(o.url, 400),
      };
    });
    const rawProps = Array.isArray(n.additionalProperty) ? n.additionalProperty : (n.additionalProperty ? [n.additionalProperty] : []);
    const props = [];
    for (const p of rawProps) {
      if (!p || typeof p !== 'object' || !p.name) continue;
      props.push([cleanText(p.name, 120), cleanText(p.value, 200)]);
      if (props.length >= 80) break;
    }
    return {
      name: cleanText(n.name, 200), sku: cleanText(n.sku, 40), mpn: cleanText(n.mpn, 80), gtin,
      brand: cleanText(b, 80), description: cleanText(n.description, 700), url: cleanText(n.url, 400), offers, props,
    };
  };
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 5 || out.length >= 12) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (n['@graph']) walk(n['@graph'], depth + 1);
    const t = n['@type'];
    if ((Array.isArray(t) ? t : [t]).includes('Product')) out.push(slim(n));
    else if (n.itemListElement) walk(n.itemListElement, depth + 1);
    else if (n.item) walk(n.item, depth + 1);
  };
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string' || text.length > 400000) continue;
    let j;
    try { j = JSON.parse(text); } catch (e) { continue; }
    walk(j, 0);
  }
  return out;
}

// Raw JSON-LD script texts out of an HTML string (for responses fetched without rendering).
export function ldFromHtml(html) {
  const out = [];
  if (typeof html !== 'string') return out;
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 8) out.push(m[1]);
  return out;
}

// One tRPC product.getDynamicProductData payload (elkjop.no) -> the few fields we use.
export function trimElkDyn(d) {
  if (!d || typeof d !== 'object') return null;
  const c = d.classifications || {};
  const pr = d.price || {};
  const av = d.availability || {};
  const se = d.sellability || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pair = (a) => (Array.isArray(a) ? [num(a[0]), num(a[1])] : null);
  const gt = cleanText(c.gtin, 20).replace(/\D/g, '');
  const th = av.stockThreshold && typeof av.stockThreshold === 'object' ? av.stockThreshold : null;
  const os = se.onlineStock && typeof se.onlineStock === 'object' ? se.onlineStock : null;
  return {
    sku: cleanText(d.sku, 40),
    title: cleanText(d.content && d.content.title, 200),
    desc: cleanText(d.content && d.content.description, 700),
    gtin: gt.length >= 8 && gt.length <= 14 ? gt : '',
    mpn: cleanText(c.manufacturerPartNumber, 80),
    brand: cleanText(d.brand && d.brand.name, 80),
    price: {
      current: pair(pr.current), original: pair(pr.original),
      club: pr.isClubPrice === true, discounted: pr.isDiscounted === true, note: cleanText(pr.disclaimer, 200),
    },
    stores: num(av.availableStoreStockCount),
    storesDisplay: th ? cleanText(th.display, 20) : '',
    storeIn: th ? th.inStock === true : null,
    online: os ? { inStock: os.inStock === true, level: cleanText(os.level, 20) } : null,
    buyable: typeof se.isBuyableOnline === 'boolean' ? se.isBuyableOnline : null,
  };
}

// One /api/v2/products item (power.no) -> the few fields we use.
export function trimPower(p) {
  if (!p || typeof p !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: cleanText(p.productId, 12),
    title: cleanText(p.title, 200),
    brand: cleanText(p.manufacturerName, 80),
    mpn: cleanText(p.productManufactorIdentity, 80),
    art: cleanText(p.elguideId, 40),
    desc: cleanText(p.shortDescription, 600),
    url: cleanText(p.url, 400),
    price: num(p.price),
    previous: num(p.previousPrice),
    previousNote: cleanText(p.previousPriceDisclaimer, 200),
    club: p.clubCampaignActive === true,
    stock: num(p.stockCount),
    storesStock: num(p.storesStockCount),
    stockStatus: num(p.webStockStatus),
    stockText: cleanText(p.webStockTextShort || p.webStockText, 80),
    canAdd: typeof p.canAddToCart === 'boolean' ? p.canAddToCart : null,
  };
}

// komplett.no /md/product/{id}: stock line and the Spesifikasjoner list.
export function parseKomplettMd(text) {
  const out = { stock: '', specs: [] };
  if (typeof text !== 'string') return out;
  const t = text.slice(0, 80000).replace(/\r\n?/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(t);
  if (fm) {
    const m = /^stock:\s*"?(.*?)"?\s*$/m.exec(fm[1]);
    if (m) out.stock = cleanText(m[1], 80);
  }
  const i = t.indexOf('## Spesifikasjoner');
  if (i >= 0) {
    const rest = t.slice(i + '## Spesifikasjoner'.length);
    const end = rest.search(/\n## /);
    for (const line of (end >= 0 ? rest.slice(0, end) : rest).split('\n')) {
      const m = /^- ([^:]{1,120}):\s*(.+)$/.exec(line);
      if (!m) continue;
      out.specs.push([cleanText(m[1], 120), cleanText(m[2], 200)]);
      if (out.specs.length >= 90) break;
    }
  }
  return out;
}

// prisjakt.no: search-page JSON-LD (ItemList of Products) and product-page JSON-LD (ProductGroup with
// per-variant AggregateOffer). Returns { name, url, searchPrice } from the search and, with the product
// texts, { lowPrice, offerCount } of the variant that the search pointed at (else the cheapest variant).
export function parsePrisjakt(searchTexts, productTexts) {
  const nodes = (texts) => {
    const acc = [];
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || d > 6 || acc.length > 400) return;
      if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
      acc.push(n);
      for (const k of ['itemListElement', 'item', 'hasVariant', '@graph']) if (n[k]) walk(n[k], d + 1);
    };
    for (const t of Array.isArray(texts) ? texts : []) {
      if (typeof t !== 'string' || t.length > 600000) continue;
      try { walk(JSON.parse(t), 0); } catch (e) { /* skip */ }
    }
    return acc;
  };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const res = { name: '', url: '', searchPrice: null, lowPrice: null, offerCount: null };
  const hit = nodes(searchTexts).find((n) => n['@type'] === 'Product' && typeof n.url === 'string' && /product\.php\?p=\d+/.test(n.url));
  if (hit) {
    res.name = cleanText(hit.name, 200);
    res.url = cleanText(hit.url, 400).replace(/#.*$/, '');
    res.searchPrice = hit.offers ? num(hit.offers.price) : null;
  }
  if (productTexts) {
    const variants = nodes(productTexts).filter((n) => n['@type'] === 'Product' && n.offers && n.offers['@type'] === 'AggregateOffer');
    const want = res.url;
    let v = variants.find((n) => typeof n.url === 'string' && n.url === want);
    if (!v) {
      for (const n of variants) if (!v || num(n.offers.lowPrice) < num(v.offers.lowPrice)) v = n;
    }
    if (v) { res.lowPrice = num(v.offers.lowPrice); res.offerCount = num(v.offers.offerCount); }
  }
  return res;
}

// The program. page = the user's current tab (never navigated); every site gets its own new tab.
// P = { sites, kind: ean|id|query, value, need: basic|detail|full, prisjakt, perSiteMs, totalMs }.
// Returns { v, ms, sites: { site: { status, ms, detail?, items?, err? } }, prisjakt? }.
export async function retailMain(page, P) {
  const t0 = Date.now();
  const ctx = page.context();
  const ENC = encodeURIComponent;
  const full = P.need === 'full';
  const basic = P.need === 'basic';
  const fail = (code) => { const e = new Error(code); e.code = code; return e; };
  const hostOk = (u, host) => {
    try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === host && !x.username && !x.port; } catch (e) { return false; }
  };
  const ready = async (tab, sel, ms) => {
    try { await tab.waitForSelector(sel, { state: 'attached', timeout: ms }); return true; } catch (e) { return false; }
  };
  const titleOf = async (tab) => tab.title().catch(() => '');
  const isBlocked = async (tab) => /checkpoint|access denied|forbidden|just a moment|captcha|blocked|attention required/i.test(await titleOf(tab));
  const open = async (tab, url) => {
    const r = await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return r ? r.status() : 0;
  };
  const lds = async (tab) => trimLd(await tab.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent || '')).catch(() => []));
  const sameFetch = async (tab, url, asText) => tab.evaluate(async ([u, text]) => {
    const c = new AbortController();
    const tm = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(u, { credentials: 'same-origin', signal: c.signal });
      if (!r.ok) return null;
      return text ? await r.text() : await r.json();
    } catch (e) { return null; } finally { clearTimeout(tm); }
  }, [url, asText === true]);
  const lastDigits = (href) => { const m = /(\d{4,10})\/?(?:[?#].*)?$/.exec(String(href || '')); return m ? m[1] : ''; };

  // ---- elkjop.no ----
  const elkjop = async (tab, q) => {
    const base = 'https://www.elkjop.no';
    const dyn = async (ids) => {
      const input = {};
      ids.forEach((id, i) => { input[String(i)] = { sku: id }; });
      const url = base + '/api/trpc/' + ids.map(() => 'product.getDynamicProductData').join(',') + '?batch=1&input=' + ENC(JSON.stringify(input));
      const arr = await sameFetch(tab, url, false);
      return ids.map((id, i) => trimElkDyn(Array.isArray(arr) && arr[i] && arr[i].result && arr[i].result.data));
    };
    const product = async (id) => {
      const st = await open(tab, base + '/product/' + id);
      if (!(await ready(tab, 'script[type="application/ld+json"]', 15000))) {
        if (await isBlocked(tab)) throw fail('blocked');
        if (st === 404) return null;
        throw fail('timeout');
      }
      const ld = (await lds(tab)).find((p) => p.sku || p.name);
      if (!ld) return null;
      const sku = ld.sku || id;
      const [d] = await dyn([sku]);
      let specs = [];
      if (full) {
        specs = await tab.$$eval('dl', (els) => {
          const rows = [];
          for (const dl of els) {
            const dt = dl.querySelector(':scope > dt > span');
            const dd = dl.querySelector(':scope > dd');
            if (dt && dd) rows.push([(dt.textContent || '').trim().slice(0, 200), (dd.textContent || '').trim().slice(0, 300)]);
            if (rows.length >= 90) break;
          }
          return rows;
        }).catch(() => []);
      }
      return { id: sku, url: tab.url(), ld, dyn: d, specs };
    };
    if (q.kind === 'id') {
      const d = await product(q.value);
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    await open(tab, base + '/search?q=' + ENC(q.value));
    if (!(await ready(tab, 'a[href*="/product/"]', 15000))) {
      if (await isBlocked(tab)) throw fail('blocked');
      if (/resultater/i.test(await titleOf(tab))) return { status: 'not_found' };
      throw fail('timeout');
    }
    const found = await tab.$$eval('a[href*="/product/"]', (els) => {
      const seen = new Set();
      const out = [];
      for (const a of els) {
        const href = a.getAttribute('href') || '';
        const m = /\/product\/[^?#]*\/(\d{4,10})(?:[/?#]|$)/.exec(href);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        out.push({ id: m[1], href });
        if (out.length >= 6) break;
      }
      return out;
    });
    if (!found.length) return { status: 'not_found' };
    const ds = await dyn(found.map((f) => f.id));
    const items = found.map((f, i) => ({ id: f.id, url: new URL(f.href, base).href, dyn: ds[i] }));
    let hit = null;
    if (q.kind === 'ean') hit = items.find((x) => x.dyn && x.dyn.gtin === q.value) || null;
    else if (items.length === 1) hit = items[0];
    if (q.kind === 'ean' && !hit) return { status: 'not_found' };
    if (hit) {
      if (full) { const d = await product(hit.id); if (d) return { status: 'ok', detail: d }; }
      return { status: 'ok', detail: { id: hit.id, url: hit.url, dyn: hit.dyn } };
    }
    return { status: 'ok', items: items.slice(0, 5) };
  };

  // ---- komplett.no ----
  const komplett = async (tab, q) => {
    const base = 'https://www.komplett.no';
    const collect = async () => {
      if (!(await ready(tab, 'script[type="application/ld+json"]', 12000))) {
        if (await isBlocked(tab)) throw fail('blocked');
        throw fail('timeout');
      }
      const ld = (await lds(tab)).find((p) => p.sku);
      if (!ld) return null;
      let before = null;
      let md = null;
      if (!basic) {
        before = await tab.locator('.product-price-before').first().textContent({ timeout: 3000 }).catch(() => null);
        md = parseKomplettMd(await sameFetch(tab, '/md/product/' + ENC(ld.sku), true));
      }
      return { id: ld.sku, url: tab.url(), ld, before: cleanText(before, 80), md };
    };
    const productAt = async (url) => {
      const st = await open(tab, url);
      if (st === 404) return null;
      return collect();
    };
    if (q.kind === 'id') {
      const d = await productAt(base + '/product/' + q.value);
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    await open(tab, base + '/search?q=' + ENC(q.value));
    if (/\/product\/\d+/.test(tab.url())) {
      const d = await collect();
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    if (!(await ready(tab, 'script[type="application/ld+json"]', 12000))) {
      if (await isBlocked(tab)) throw fail('blocked');
      throw fail('timeout');
    }
    const prods = (await lds(tab)).filter((p) => p.sku && hostOk(p.url, 'www.komplett.no'));
    if (!prods.length) return { status: 'not_found' };
    let hit = null;
    if (q.kind === 'ean') hit = prods.find((p) => p.gtin === q.value) || null;
    else if (prods.length === 1) hit = prods[0];
    if (q.kind === 'ean' && !hit) return { status: 'not_found' };
    if (hit) {
      if (basic) return { status: 'ok', detail: { id: hit.sku, url: hit.url, ld: hit, before: '', md: null } };
      const d = await productAt(hit.url);
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    return { status: 'ok', items: prods.slice(0, 5).map((p) => ({ id: p.sku, url: p.url, ld: p })) };
  };

  // ---- proshop.no ----
  const proshop = async (tab, q) => {
    const base = 'https://www.proshop.no';
    const collect = async () => {
      const ld = (await lds(tab)).find((p) => p.sku || p.name);
      if (!ld) return null;
      const dom = await tab.evaluate((withSpecs) => {
        const tx = (s) => { const e = document.querySelector(s); return e ? (e.textContent || '').trim().slice(0, 200) : null; };
        const specs = [];
        if (withSpecs) {
          for (const t of document.querySelectorAll('div.specItemTitle')) {
            const v = t.nextElementSibling;
            if (v) specs.push([(t.textContent || '').trim().slice(0, 200), (v.textContent || '').trim().slice(0, 300)]);
            if (specs.length >= 90) break;
          }
        }
        return { pre: tx('.site-currency-pre'), camp: tx('.site-currency-campaign'), stock: tx('.site-stock-label'), specs };
      }, full);
      return { id: ld.sku || lastDigits(tab.url()), url: tab.url(), ld, dom };
    };
    const productAt = async (url) => {
      const st = await open(tab, url);
      if (!(await ready(tab, 'script[type="application/ld+json"]', 12000))) {
        if (await isBlocked(tab)) throw fail('blocked');
        if (st === 404) return null;
        throw fail('timeout');
      }
      return collect();
    };
    if (q.kind === 'id') {
      const d = await productAt(base + '/' + q.value);
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    await open(tab, base + '/?s=' + ENC(q.value));
    const sel = 'li.site-productlist-item, script[type="application/ld+json"]';
    if (!(await ready(tab, sel, 9000))) {
      if (await isBlocked(tab)) throw fail('blocked');
      const txt = await tab.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 3000)).catch(() => '');
      if (/ingen|0 treff|fant ikke|no results/i.test(txt)) return { status: 'not_found' };
      throw fail('timeout');
    }
    const direct = (await lds(tab)).some((p) => p.sku || p.name);
    if (direct) {
      const d = await collect();
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    const cards = await tab.$$eval('li.site-productlist-item', (els) => els.slice(0, 8).map((li) => {
      const a = li.querySelector('a.site-product-link');
      const h = li.querySelector('h2');
      const pr = li.querySelector('.site-currency-campaign, .site-currency-lg, .site-currency-attention');
      const st = li.querySelector('.site-stock-text');
      return { href: a ? a.getAttribute('href') || '' : '', name: h ? h.textContent || '' : '', price: pr ? pr.textContent || '' : '', stock: st ? st.textContent || '' : '' };
    }));
    const cs = cards.filter((c) => lastDigits(c.href)).map((c) => ({ id: lastDigits(c.href), url: new URL(c.href, base).href, name: cleanText(c.name, 200), price: cleanText(c.price, 40), stock: cleanText(c.stock, 80) }));
    if (!cs.length) return { status: 'not_found' };
    if (q.kind === 'ean') {
      for (const c of cs.slice(0, 2)) {
        const d = await productAt(c.url);
        if (d && d.ld.gtin === q.value) return { status: 'ok', detail: d };
      }
      return { status: 'not_found' };
    }
    if (cs.length === 1) {
      const d = await productAt(cs[0].url);
      return d ? { status: 'ok', detail: d } : { status: 'not_found' };
    }
    return { status: 'ok', items: cs.slice(0, 5) };
  };

  // ---- power.no (plain HTTP through the browser context; no page load) ----
  const power = async (tab, q) => {
    const base = 'https://www.power.no';
    const get = async (u) => {
      const r = await ctx.request.get(u, { timeout: 12000, failOnStatusCode: false, maxRedirects: 3 });
      if (r.status() === 403 || r.status() === 429) throw fail('blocked');
      return { status: r.status(), text: await r.text() };
    };
    const jsonOf = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
    const detailOf = async (api) => {
      const r = await get(base + '/product/p-' + ENC(api.id) + '/');
      const ld = trimLd(ldFromHtml(r.text)).find((p) => p.sku || p.name) || null;
      return { status: 'ok', detail: { id: api.id, url: base + api.url, api, ld, specs: [] } };
    };
    if (q.kind === 'id') {
      const a = jsonOf((await get(base + '/api/v2/products?ids=' + ENC(q.value) + '&allowWebStatus8=true')).text);
      const api = Array.isArray(a) && a[0] ? trimPower(a[0]) : null;
      return api && api.title ? detailOf(api) : { status: 'not_found' };
    }
    const r = await get(base + '/api/v2/productlists?size=5&q=' + ENC(q.value) + '&s=5&from=0&o=false&cd=false');
    const j = jsonOf(r.text);
    const list = (j && Array.isArray(j.products) ? j.products : []).map(trimPower).filter((p) => p && p.title && p.id);
    if (!list.length) return { status: 'not_found' };
    if (q.kind === 'ean') {
      for (const api of list.slice(0, 3)) {
        const d = await detailOf(api);
        if (d.detail.ld && d.detail.ld.gtin === q.value) return d;
      }
      return { status: 'not_found' };
    }
    if (list.length === 1) return detailOf(list[0]);
    return { status: 'ok', items: list.slice(0, 5).map((p) => ({ id: p.id, url: base + p.url, api: p })) };
  };

  // ---- prisjakt.no (compare only) ----
  const prisjakt = async (tab, q) => {
    await open(tab, 'https://www.prisjakt.no/search?query=' + ENC(q.value));
    if (!(await ready(tab, 'script[type="application/ld+json"]', 12000))) {
      if (await isBlocked(tab)) throw fail('blocked');
      throw fail('timeout');
    }
    const s = parsePrisjakt(await tab.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent || '')), null);
    if (!s.url || !hostOk(s.url, 'www.prisjakt.no')) return { status: 'not_found' };
    let r = s;
    await open(tab, s.url);
    if (await ready(tab, 'script[type="application/ld+json"]', 12000)) {
      r = parsePrisjakt(await tab.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent || '')), await tab.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => e.textContent || '')));
      r.url = s.url;
      r.name = s.name;
    }
    return { status: 'ok', detail: { name: r.name, url: r.url, low: r.lowPrice !== null ? r.lowPrice : r.searchPrice, shops: r.offerCount } };
  };

  const SITES = { elkjop, komplett, proshop, power, prisjakt };

  const job = async (site) => {
    const started = Date.now();
    const budget = Math.max(1000, Math.min(P.perSiteMs, P.totalMs - (Date.now() - t0)));
    let tab = null;
    let timer = null;
    let out;
    try {
      tab = await ctx.newPage();
      const work = SITES[site](tab, { kind: site === 'prisjakt' ? 'ean' : P.kind, value: P.value });
      work.catch(() => {});
      out = await Promise.race([work, new Promise((res) => { timer = setTimeout(() => res({ status: 'timeout' }), budget); })]);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      if (e && e.code === 'blocked') out = { status: 'blocked' };
      else if (e && e.code === 'timeout' || /timeout/i.test(msg)) out = { status: 'timeout' };
      else out = { status: 'error', err: msg.split('\n')[0].slice(0, 160) };
    } finally {
      if (timer) clearTimeout(timer);
      if (tab) await Promise.race([tab.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    out.ms = Date.now() - started;
    return [site, out];
  };

  const names = P.prisjakt ? [...P.sites, 'prisjakt'] : P.sites;
  const done = await Promise.all(names.map(job));
  const res = { v: 1, ms: Date.now() - t0, sites: {} };
  for (const [site, out] of done) {
    if (site === 'prisjakt') res.prisjakt = out;
    else res.sites[site] = out;
  }
  // Keep the raw payload small: drop the bulky optional parts first.
  if (JSON.stringify(res).length > 60000) {
    for (const o of Object.values(res.sites)) {
      if (o.detail) { delete o.detail.specs; if (o.detail.md) o.detail.md.specs = []; if (o.detail.ld) { o.detail.ld.props = []; o.detail.ld.description = ''; } }
    }
  }
  return res;
}

const EMBEDDED = [cleanText, trimLd, ldFromHtml, trimElkDyn, trimPower, parseKomplettMd, parsePrisjakt, retailMain];

// P: validated parameter object (see retail.mjs). Embedded values only ever go through JSON.stringify.
export function buildRetailCode(P) {
  return `async (page) => {
const P = ${JSON.stringify(P)};
${EMBEDDED.map((f) => f.toString()).join('\n')}
return await retailMain(page, P);
}`;
}
