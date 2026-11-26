import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  RETAIL_DEFS, RETAIL_NAMES, validateLookup, validateCompare, lookupParams, compareParams, parseMoney, formatPrice,
  normalizeDetail, normalizeItem, formatProduct, checkGtin, priceText, formatLookup, formatCompare, createRetailTools, stockTextIn, idFromUrl,
} from '../gateway/retail.mjs';
import {
  buildRetailCode, cleanText, gtin14, trimLd, ldFromHtml, trimElkDyn, trimPower, parseKomplettMd, parsePrisjakt, retailMain,
} from '../gateway/retail-page.mjs';

const fx = (f) => fs.readFileSync(new URL(`./fixtures/retail/${f}`, import.meta.url), 'utf8');
const fj = (f) => JSON.parse(fx(f));
const ldTexts = (f) => fj(f).map((o) => JSON.stringify(o));
const EAN = '4548736132580';

// ---- tool definitions ----

test('tool definitions are small, strict and named', () => {
  assert.deepEqual([...RETAIL_NAMES].sort(), ['product_compare', 'product_lookup']);
  assert.ok(JSON.stringify(RETAIL_DEFS).length <= 1800, `defs are ${JSON.stringify(RETAIL_DEFS).length} chars`);
  for (const d of RETAIL_DEFS) {
    assert.equal(d.inputSchema.additionalProperties, false);
    assert.match(d.description, /untrusted/i);
  }
});

// ---- validation ----

test('validateLookup accepts the four input kinds and defaults mode to normal', () => {
  assert.deepEqual(validateLookup({ site: 'power', ean: EAN }).value, { site: 'power', kind: 'ean', value: EAN, mode: 'normal' });
  assert.deepEqual(validateLookup({ site: 'elkjop', id: '459129', mode: 'tldr' }).value, { site: 'elkjop', kind: 'id', value: '459129', mode: 'tldr' });
  assert.deepEqual(validateLookup({ site: 'proshop', query: '  Sony WH-1000XM5 ' }).value.value, 'Sony WH-1000XM5');
});

test('validateLookup reduces product URLs to ids and rejects foreign hosts', () => {
  const ok = (site, url) => validateLookup({ site, url }).value;
  assert.equal(ok('elkjop', 'https://www.elkjop.no/product/tv-lyd/x/459129').value, '459129');
  assert.equal(ok('elkjop', 'https://elkjop.no/product/459129').value, '459129');
  assert.equal(ok('komplett', 'https://www.komplett.no/product/1213311/tv/x/y').value, '1213311');
  assert.equal(ok('proshop', 'https://www.proshop.no/Hodetelefoner/Sony-WH-1000XM5-Svart/3083472').value, '3083472');
  assert.equal(ok('power', 'https://www.power.no/tv/x/p-1478246/').value, '1478246');
  assert.equal(ok('power', 'https://www.power.no/product/p-1478246/').value, '1478246');
  for (const [site, url] of [
    ['komplett', 'http://www.komplett.no/product/1213311'],
    ['komplett', 'https://www.komplett.no.evil.example/product/1213311'],
    ['komplett', 'https://evil.example/www.komplett.no/product/1213311'],
    ['komplett', 'https://user:pw@www.komplett.no/product/1213311'],
    ['komplett', 'https://www.komplett.no:8443/product/1213311'],
    ['komplett', 'https://shop.komplett.no/product/1213311'],
    ['elkjop', 'https://www.komplett.no/product/1213311'],
    ['power', 'https://www.power.no/'],
    ['power', 'javascript:alert(1)'],
    ['power', 'not a url'],
  ]) assert.ok(validateLookup({ site, url }).error, `${url} must be rejected`);
});

test('validateLookup rejects bad arguments', () => {
  const bad = [
    {}, { site: 'amazon', ean: EAN }, { site: 'power' }, { site: 'power', ean: EAN, id: '123456' },
    { site: 'power', ean: '123' }, { site: 'power', ean: `${EAN}x` }, { site: 'power', ean: 4548736132580 },
    { site: 'power', id: '123' }, { site: 'power', id: '12345678901' }, { site: 'power', id: '12 34' },
    { site: 'power', query: '' }, { site: 'power', query: 'x'.repeat(101) }, { site: 'power', query: 'a\nb' }, { site: 'power', query: 'a\u0000b' },
    { site: 'power', ean: EAN, mode: 'huge' }, { site: 'power', ean: EAN, extra: 1 },
  ];
  for (const a of bad) assert.ok(validateLookup(a).error, JSON.stringify(a));
  assert.ok(validateLookup(null).error);
  assert.ok(validateLookup('x').error);
});

test('validateCompare', () => {
  assert.deepEqual(validateCompare({ ean: EAN }).value, { ean: EAN, sites: ['elkjop', 'komplett', 'proshop', 'power'], mode: 'tldr', prisjakt: false });
  assert.deepEqual(validateCompare({ ean: EAN, sites: ['power', 'elkjop'], mode: 'normal', prisjakt: true }).value,
    { ean: EAN, sites: ['elkjop', 'power'], mode: 'normal', prisjakt: true });
  for (const a of [
    {}, { ean: '1234567' }, { ean: '123456789012345' }, { ean: `${EAN}"` }, { ean: EAN, sites: [] }, { ean: EAN, sites: ['elkjop', 'elkjop'] },
    { ean: EAN, sites: ['ebay'] }, { ean: EAN, sites: 'power' }, { ean: EAN, mode: 'full' }, { ean: EAN, prisjakt: 'yes' }, { ean: EAN, foo: 1 },
  ]) assert.ok(validateCompare(a).error, JSON.stringify(a));
});

test('idFromUrl', () => {
  assert.equal(idFromUrl('komplett', '/product/1213311'), '1213311');
  assert.equal(idFromUrl('komplett', '/category/10896/x'), '');
  assert.equal(idFromUrl('elkjop', '/brand/sony'), '');
});

// ---- code template ----

const NASTY = 'a"b\'c`d${process.exit(1)}\\n</script>';

function runCode(code, page) {
  const fn = vm.runInNewContext(`(${code})`, { setTimeout, clearTimeout, URL }, { timeout: 2000 });
  return fn(page);
}

test('line separators and control characters in a query are rejected', () => {
  assert.ok(validateLookup({ site: 'power', query: 'a\u2028b' }).error);
  assert.ok(validateLookup({ site: 'power', query: 'a\u0085b' }).error);
});

test('built code compiles and embeds hostile values only as data', async () => {
  const p = lookupParams(validateLookup({ site: 'power', query: NASTY }).value);
  const code = buildRetailCode(p);
  const urls = [];
  const ctx = {
    request: { get: async (u) => { urls.push(u); return { status: () => 200, text: async () => '{"products":[]}' }; } },
    newPage: async () => ({ close: async () => {} }),
  };
  const out = await runCode(code, { context: () => ctx });
  assert.equal(out.sites.power.status, 'not_found');
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes(`q=${encodeURIComponent(NASTY)}&`), urls[0]);
  assert.ok(!urls[0].includes('"') && !urls[0].includes('`') && !urls[0].includes('${'));
  // the parameter object is recoverable verbatim from the source
  const line = code.split('\n').find((l) => l.startsWith('const P = '));
  assert.deepEqual(JSON.parse(line.slice('const P = '.length, -1)), p);
});

test('code parameters carry deadlines and the detail level', () => {
  const l = lookupParams(validateLookup({ site: 'power', ean: EAN, mode: 'full' }).value);
  assert.equal(l.need, 'full');
  assert.deepEqual(l.sites, ['power']);
  const c = compareParams(validateCompare({ ean: EAN, mode: 'normal' }).value);
  assert.equal(c.need, 'detail');
  assert.ok(c.perSiteMs <= 25000 && c.totalMs <= 45000 && c.perSiteMs < c.totalMs);
  assert.equal(compareParams(validateCompare({ ean: EAN }).value).need, 'basic');
});

// ---- partial results, deadlines, tab hygiene ----

test('one hanging site times out, the rest come back, every tab is closed', async () => {
  const closed = [];
  const power = {
    get: async (u) => ({
      status: () => 200,
      text: async () => (u.includes('productlists')
        ? JSON.stringify({ products: fj('power.api.json') })
        : `<html><script type="application/ld+json">${JSON.stringify(fj('power.ld.json')[0])}</script></html>`),
    }),
  };
  let n = 0;
  const ctx = {
    request: power,
    newPage: async () => {
      const id = n++;
      return {
        goto: () => new Promise(() => {}), // never resolves: a hung navigation
        url: () => 'about:blank',
        title: async () => '',
        close: async () => { closed.push(id); },
      };
    },
  };
  const P = { sites: ['elkjop', 'power', 'komplett'], kind: 'ean', value: EAN, g14: '0'.repeat(14 - EAN.length) + EAN, need: 'basic', prisjakt: false, perSiteMs: 150, totalMs: 400 };
  const t0 = Date.now();
  const out = await retailMain({ context: () => ctx }, P);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(out.sites.elkjop.status, 'timeout');
  assert.equal(out.sites.komplett.status, 'timeout');
  assert.equal(out.sites.power.status, 'ok');
  assert.equal(out.sites.power.detail.api.price, 3790);
  assert.equal(closed.length, 3, 'every opened tab is closed');
  const text = formatCompare(EAN, out, 'tldr', false);
  assert.match(text, /power\s+3 790 kr \(was 4 490 kr, -16%\)\s+WH1000XM5B\.CE7\s+in stock/);
  assert.match(text, /elkjop\s+timed out/);
  assert.match(text, /komplett\s+timed out/);
});

test('blocked and error statuses are classified', async () => {
  const mk = (get) => ({ request: { get }, newPage: async () => ({ close: async () => {} }) });
  const base = { sites: ['power'], kind: 'id', value: '1478246', need: 'basic', prisjakt: false, perSiteMs: 1000, totalMs: 2000 };
  let o = await retailMain({ context: () => mk(async () => ({ status: () => 403, text: async () => '' })) }, base);
  assert.equal(o.sites.power.status, 'blocked');
  o = await retailMain({ context: () => mk(async () => { throw new Error('socket hang up\nstack'); }) }, base);
  assert.equal(o.sites.power.status, 'error');
  assert.equal(o.sites.power.err, 'socket hang up');
  o = await retailMain({ context: () => mk(async () => { throw new Error('Timeout 12000ms exceeded.'); }) }, base);
  assert.equal(o.sites.power.status, 'timeout');
});

// ---- raw trimmers ----

test('cleanText strips control characters and caps length', () => {
  assert.equal(cleanText('a\u0000b\u0007c\u202ed\n\te  f', 50), 'a b c d e f');
  assert.equal(cleanText('x'.repeat(300), 200).length, 200);
  assert.equal(cleanText({ a: 1 }, 10), '');
  assert.equal(cleanText(12, 10), '12');
  assert.equal(cleanText(null, 10), '');
});

test('trimLd finds Products in lists, @graph and ItemList, and caps strings', () => {
  const k = trimLd(ldTexts('komplett.ld.json'));
  assert.equal(k.length, 2);
  assert.equal(k[0].gtin, EAN);
  assert.equal(k[1].gtin, '');
  const g = trimLd(ldTexts('power.ld.json'));
  assert.equal(g.length, 1);
  assert.equal(g[0].sku, '1478246');
  assert.equal(g[0].gtin, EAN);
  const il = trimLd([JSON.stringify({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: { '@type': 'Product', name: 'N', sku: '1' } }] })]);
  assert.equal(il[0].name, 'N');
  assert.deepEqual(trimLd(['not json', '{"@type":"Organization"}', 5, null]), []);
  const long = trimLd([JSON.stringify({ '@type': 'Product', name: 'n'.repeat(900), description: 'd'.repeat(2000), url: 'u'.repeat(900) })])[0];
  assert.ok(long.name.length <= 200 && long.description.length <= 700 && long.url.length <= 400);
});

test('ldFromHtml', () => {
  const html = '<script type="application/ld+json">{"a":1}</script><script>x</script><script type=\'application/ld+json\'>{"b":2}</script>';
  assert.deepEqual(ldFromHtml(html), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(ldFromHtml(null), []);
});

test('trimElkDyn and trimPower keep only the used fields', () => {
  const d = trimElkDyn(fj('elkjop.dyn.json'));
  assert.equal(d.gtin, EAN);
  assert.equal(d.mpn, 'WH1000XM5B.CE7');
  assert.deepEqual(d.price.current, [3790, 3032]);
  assert.equal(d.online.inStock, true);
  assert.equal(d.stores, 118);
  assert.equal(trimElkDyn(null), null);
  const p = trimPower(fj('power.api.json')[0]);
  assert.equal(p.mpn, 'WH1000XM5B.CE7');
  assert.equal(p.previous, 4490);
  assert.equal(p.stock, 416);
  assert.equal(trimPower('x'), null);
});

test('parseKomplettMd reads the stock line and the specification list (CRLF input)', () => {
  const md = parseKomplettMd(fx('komplett.md.txt'));
  assert.match(md.stock, /på lager/);
  assert.ok(md.specs.length >= 5);
  assert.deepEqual(md.specs.find((s) => s[0] === 'EAN'), ['EAN', EAN]);
  assert.deepEqual(parseKomplettMd(null), { stock: '', specs: [] });
});

test('parsePrisjakt picks the variant the search pointed at, else the cheapest', () => {
  const s = parsePrisjakt([JSON.stringify(fj('prisjakt.search.json')[0])], null);
  assert.match(s.url, /product\.php\?p=\d+/);
  assert.ok(!s.url.includes('#'));
  assert.equal(typeof s.searchPrice, 'number');
  const r = parsePrisjakt([JSON.stringify(fj('prisjakt.search.json')[0])], [JSON.stringify(fj('prisjakt.product.json')[0])]);
  assert.equal(typeof r.lowPrice, 'number');
  assert.equal(typeof r.offerCount, 'number');
  const cheapest = parsePrisjakt([JSON.stringify({ '@type': 'Product', url: 'https://www.prisjakt.no/product.php?p=1', offers: { price: 5 } })], [JSON.stringify({
    '@type': 'ProductGroup', hasVariant: [
      { '@type': 'Product', url: 'https://x/a', offers: { '@type': 'AggregateOffer', lowPrice: 30, offerCount: 3 } },
      { '@type': 'Product', url: 'https://x/b', offers: { '@type': 'AggregateOffer', lowPrice: 20, offerCount: 9 } },
    ],
  })]);
  assert.deepEqual([cheapest.lowPrice, cheapest.offerCount], [20, 9]);
});

// ---- normalisers (fixtures) ----

const ldOf = (f) => trimLd(ldTexts(f));

test('parseMoney / formatPrice / stockTextIn', () => {
  assert.equal(parseMoney('3 790,00 kr'), 3790);
  assert.equal(parseMoney('Førpris: 23 990,-'), 23990);
  assert.equal(parseMoney('3790.00'), 3790);
  assert.equal(parseMoney('11 232,50 kr'), 11232.5);
  assert.equal(parseMoney(1393), 1393);
  assert.equal(parseMoney('gratis'), null);
  assert.equal(parseMoney(null), null);
  assert.equal(formatPrice(3790), '3 790 kr');
  assert.equal(formatPrice(990), '990 kr');
  assert.equal(formatPrice(1234567), '1 234 567 kr');
  assert.equal(formatPrice(3790.5), '3 790,50 kr');
  assert.equal(formatPrice(null), '?');
  assert.equal(stockTextIn('20+ stk. på lager.'), true);
  assert.equal(stockTextIn('Forventet på lager 6. des. 2026'), false);
  assert.equal(stockTextIn('På lager'), true);
  assert.equal(stockTextIn(''), null);
});

test('elkjop: Public offer, dynamic price and stock win over cached JSON-LD', () => {
  const p = normalizeDetail('elkjop', { id: '459129', url: 'https://www.elkjop.no/product/x/459129', ld: ldOf('elkjop.ld.json')[0], dyn: trimElkDyn(fj('elkjop.dyn.json')) });
  assert.equal(p.price, 3790);
  assert.equal(p.mpn, 'WH1000XM5B.CE7');
  assert.equal(p.ean, EAN);
  assert.equal(p.brand, 'Sony');
  assert.equal(p.inStock, true);
  assert.equal(p.stock, 'online 100+, 118 stores');
  assert.equal(p.before, null);
  // JSON-LD alone: the Public offer, never the Business one
  const q = normalizeDetail('elkjop', { id: '459129', url: 'u', ld: ldOf('elkjop.ld.json')[0] });
  assert.equal(q.price, 3790);
  assert.equal(q.inStock, true);
});

test('elkjop: discounted dynamic data gives before price and campaign note', () => {
  const p = normalizeDetail('elkjop', { id: '1128753', url: 'u', dyn: trimElkDyn(fj('elkjop.dyn.discount.json')) });
  assert.equal(p.price, 3690);
  assert.equal(p.before, 4990);
  assert.match(p.campaign, /Tilbudet gjelder/);
  assert.ok(p.name.length > 0);
});

test('komplett: list-page JSON-LD plus markdown and before price', () => {
  const ld = ldOf('komplett.ld.json')[0];
  const p = normalizeDetail('komplett', { id: ld.sku, url: ld.url, ld, before: 'Førpris: 4 990,-', md: parseKomplettMd(fx('komplett.md.txt')) });
  assert.equal(p.price, 3790);
  assert.equal(p.before, 4990);
  assert.equal(p.mpn, 'WH1000XM5B.CE7');
  assert.equal(p.ean, EAN);
  assert.equal(p.inStock, true);
  assert.match(p.stock, /på lager/);
  assert.ok(p.specs.some(([n, v]) => n === 'EAN' && v === EAN));
  // a before price that is not higher than the price is ignored
  assert.equal(normalizeDetail('komplett', { id: ld.sku, url: ld.url, ld, before: '3 000,-' }).before, null);
});

test('proshop: JSON-LD price is the campaign price, ordinary price from the page', () => {
  const ld = ldOf('proshop.ld.json')[0];
  const p = normalizeDetail('proshop', { id: '3083472', url: 'https://www.proshop.no/x/3083472', ld, dom: fj('proshop.dom.json') });
  assert.equal(p.price, 3790);
  const q = normalizeDetail('proshop', { id: '3083472', url: 'u', ld: { ...ld, offers: [{ price: '11232.00', avail: 'http://schema.org/InStock' }] }, dom: fj('proshop.dom.json') });
  assert.equal(q.before, 11691);
  assert.equal(q.stock, 'På lager');
  assert.equal(q.inStock, true);
  assert.equal(q.ean, EAN);
  assert.deepEqual(q.specs[2], ['Model', 'WH1000XM5B.CE7']);
  const pre = normalizeDetail('proshop', { id: '1', url: 'u', ld: { ...ld, offers: [{ price: '1393.00', avail: 'http://schema.org/PreOrder' }] }, dom: { stock: null } });
  assert.equal(pre.inStock, false);
  assert.equal(pre.stock, 'PreOrder');
});

test('power: API data, previous price with its disclaimer, EAN from the page JSON-LD', () => {
  const p = normalizeDetail('power', { id: '1478246', url: 'https://www.power.no/x/p-1478246/', api: trimPower(fj('power.api.json')[0]), ld: ldOf('power.ld.json')[0] });
  assert.equal(p.price, 3790);
  assert.equal(p.before, 4490);
  assert.match(p.campaign, /Førpris/);
  assert.equal(p.ean, EAN);
  assert.equal(p.mpn, 'WH1000XM5B.CE7');
  assert.equal(p.inStock, true);
  assert.equal(p.stock, 'online 416, 289 in stores');
  assert.deepEqual(p.specs, []);
});

test('normalisers survive empty and hostile input', () => {
  for (const s of ['elkjop', 'komplett', 'proshop', 'power']) {
    assert.equal(normalizeDetail(s, null), null);
    const p = normalizeDetail(s, {});
    assert.ok(p === null || typeof p === 'object');
  }
  const p = normalizeDetail('komplett', { ld: { name: `Evil\u0000 name ${'x'.repeat(500)}`, offers: [] } });
  assert.ok(p.name.length <= 200 && !p.name.includes('\u0000'));
  assert.equal(normalizeItem('elkjop', null), null);
});

// ---- formatting ----

const sample = (site, over = {}) => ({
  site, id: '1', name: 'Sony WH-1000XM5', mpn: 'WH1000XM5B.CE7', ean: EAN, brand: 'Sony', price: 3790, before: null, campaign: null,
  inStock: true, stock: null, url: `https://www.${site}.no/p/1`, specs: [], description: '', ...over,
});

test('formatProduct tldr / normal / full', () => {
  const p = sample('elkjop', { before: 4990, campaign: 'Tilbud til 30.11', stock: 'online 100+, 118 stores', specs: [['Vekt', '247 g']], description: 'Bra.' });
  const tldr = formatProduct(p, 'tldr');
  assert.match(tldr, /Model: WH1000XM5B\.CE7/);
  assert.match(tldr, /EAN: 4548736132580/);
  assert.match(tldr, /Price: 3 790 kr \(was 4 990 kr, -24%\)\n/);
  assert.ok(!/Brand|Before|Availability|Specs/.test(tldr));
  const normal = formatProduct(p, 'normal');
  assert.match(normal, /Brand: Sony {2}Article no: 1/);
  assert.ok(!/Before/.test(normal));
  assert.match(normal, /^Price: 3 790 kr \(was 4 990 kr, -24%\)$/m);
  assert.match(normal, /Note: Tilbud til 30\.11/);
  assert.match(normal, /Availability: in stock \(online 100\+, 118 stores\)/);
  assert.ok(!/Specs|Description/.test(normal));
  const full = formatProduct(p, 'full');
  assert.match(full, /Specs \(1\):\nVekt: 247 g/);
  assert.match(full, /Description: Bra\./);
  assert.match(formatProduct(sample('power'), 'full'), /Specs: not available for power\.no/);
});

test('full mode caps specs at 60 rows and 4000 characters, description at 600', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`Spec ${i}`, 'v'.repeat(30)]);
  const out = formatProduct(sample('komplett', { specs: rows }), 'full');
  const lines = out.split('\n').filter((l) => /^Spec \d+: /.test(l));
  assert.equal(lines.length, 60);
  assert.match(out, /Specs \(60 of 120, cut\)/);
  const wide = Array.from({ length: 50 }, (_, i) => [`S${i}`, 'w'.repeat(200)]);
  const specText = formatProduct(sample('komplett', { specs: wide }), 'full').split('\n').filter((l) => /^S\d+: /.test(l)).join('\n');
  assert.ok(specText.length <= 4000, `${specText.length}`);
  const d = formatProduct(sample('komplett', { description: 'd'.repeat(700) }), 'full').split('\n').find((l) => l.startsWith('Description: '));
  assert.ok(d.length <= 'Description: '.length + 600);
});

const rawOk = (site, p) => ({ status: 'ok', ms: 1000, detail: { _p: p } });

function compareRaw() {
  const ek = { id: '459129', url: 'https://www.elkjop.no/p/459129', ld: ldOf('elkjop.ld.json')[0], dyn: trimElkDyn(fj('elkjop.dyn.json')) };
  const kl = ldOf('komplett.ld.json')[0];
  return {
    v: 1, ms: 5000,
    sites: {
      elkjop: { status: 'ok', ms: 4000, detail: ek },
      komplett: { status: 'ok', ms: 4100, detail: { id: kl.sku, url: kl.url, ld: { ...kl, offers: [{ ...kl.offers[0], price: '3690' }] }, before: '', md: null } },
      proshop: { status: 'blocked', ms: 900 },
      power: { status: 'timeout', ms: 25000 },
    },
  };
}

test('formatCompare tldr: summary, cheapest and one short line per site, partial statuses', () => {
  const text = formatCompare(EAN, compareRaw(), 'tldr', false);
  const lines = text.split('\n');
  assert.equal(lines[0], `EAN ${EAN}: Sony WH-1000XM5 trådløse around-ear hodetelefoner (sort/hardcase) (WH1000XM5B.CE7)`);
  assert.equal(lines[1], 'Cheapest: komplett 3 690 kr');
  assert.match(lines[2], /^elkjop\s+3 790 kr\s+WH1000XM5B\.CE7\s+in stock$/);
  assert.match(lines[3], /^komplett\s+3 690 kr\s+WH1000XM5B\.CE7\s+in stock$/);
  assert.match(lines[4], /^proshop\s+blocked by the site$/);
  assert.match(lines[5], /^power\s+timed out$/);
  assert.equal(lines.length, 6);
  assert.ok(text.length < 600);
  assert.ok(!/Specs|Note|https/.test(text));
});

test('formatCompare normal adds stock detail, before price and url; prisjakt adds one line', () => {
  const raw = compareRaw();
  raw.sites.elkjop.detail.dyn = trimElkDyn(fj('elkjop.dyn.discount.json'));
  raw.prisjakt = { status: 'ok', ms: 5000, detail: { name: 'x', url: 'https://www.prisjakt.no/product.php?p=1', low: 2846, shops: 13 } };
  const text = formatCompare(EAN, raw, 'normal', true);
  assert.match(text, /elkjop\s+3 690 kr \(was 4 990 kr, -26%\) {2}WH1000XM5B\.CE7 +in stock {2}\(online 100\+, 3 stores\)\n/);
  assert.match(text, /\n {2}https:\/\/www\.elkjop\.no\/p\/459129\n/);
  assert.match(text, /\nPrisjakt: lowest 2 846 kr at 13 shops$/);
  raw.prisjakt = { status: 'timeout', ms: 25000 };
  assert.match(formatCompare(EAN, raw, 'tldr', true), /\nPrisjakt: timed out$/);
});

test('formatCompare: nothing found, out-of-stock cheapest, ties', () => {
  const none = formatCompare(EAN, { sites: { elkjop: { status: 'not_found' }, power: { status: 'error', err: 'boom' } } }, 'tldr', false);
  assert.match(none, /^EAN 4548736132580: no shop returned a product\nelkjop {2,}not found\npower {2,}error \(boom\)$/);
  const raw = compareRaw();
  raw.sites.komplett.detail.ld.offers[0].avail = 'http://schema.org/OutOfStock';
  const t = formatCompare(EAN, raw, 'tldr', false);
  assert.match(t, /Cheapest: elkjop 3 790 kr/, 'out-of-stock shop is not the cheapest pick');
  assert.match(t, /komplett\s+3 690 kr .* out of stock/);
});

test('formatLookup: product, candidates, statuses', () => {
  const ok = formatLookup('power', { sites: { power: { status: 'ok', detail: { id: '1478246', url: 'u', api: trimPower(fj('power.api.json')[0]), ld: ldOf('power.ld.json')[0] } } } }, 'tldr');
  assert.match(ok.text, /^Sony WH-1000XM5 .* \[power\]\nModel: WH1000XM5B\.CE7 {2}EAN: 4548736132580\nPrice: 3 790 kr \(was 4 490 kr, -16%\)\nu$/);
  const items = Array.from({ length: 7 }, (_, i) => ({ id: String(1000 + i), url: `https://www.power.no/p-${1000 + i}/`, api: { title: `Item ${i}`, price: 100 + i } }));
  const c = formatLookup('power', { sites: { power: { status: 'ok', items } } }, 'normal');
  assert.match(c.text, /^5 candidates on power/);
  assert.equal(c.text.split('\n').length, 6);
  assert.match(c.text, /1000 {2}Item 0 {2}100 kr {2}https:\/\/www\.power\.no\/p-1000\//);
  assert.equal(formatLookup('power', { sites: { power: { status: 'not_found' } } }, 'normal').text, 'power: not found');
  assert.equal(formatLookup('power', { sites: { power: { status: 'blocked' } } }, 'normal').text, 'power: blocked by the site');
  assert.equal(formatLookup('power', { sites: {} }, 'normal').isError, true);
});

// ---- tool handlers ----

function fakeUpstream(obj, { isError = false } = {}) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return { isError, content: [{ type: 'text', text: `### Result\n${JSON.stringify(obj)}\n### Ran Playwright code\n...` }] };
  };
  return { fn, calls };
}

test('handlers run one upstream code call, format the result and log per-site lines without arguments', async () => {
  const logs = [];
  const up = fakeUpstream(compareRaw());
  const tools = createRetailTools(up.fn, (m) => logs.push(m));
  assert.ok(tools.handles('product_compare') && tools.handles('product_lookup') && !tools.handles('browser_snapshot'));
  const r = await tools.handle('product_compare', { ean: EAN }, {});
  assert.equal(up.calls.length, 1);
  assert.equal(up.calls[0].name, 'browser_run_code_unsafe');
  assert.match(up.calls[0].args.code, /^async \(page\) => \{/);
  assert.match(r.result.content[0].text, /^EAN 4548736132580:/);
  assert.equal(r.capped, true);
  assert.ok(r.rawTextChars > 100);
  assert.deepEqual(logs.sort(), [
    'retail site=elkjop status=ok ms=4000', 'retail site=komplett status=ok ms=4100',
    'retail site=power status=timeout ms=25000', 'retail site=proshop status=blocked ms=900',
  ]);
  assert.ok(!logs.join(' ').includes(EAN));
});

test('handlers reject bad arguments without calling upstream and report backend problems', async () => {
  const up = fakeUpstream({});
  const tools = createRetailTools(up.fn, () => {});
  for (const [n, a] of [['product_lookup', { site: 'power' }], ['product_compare', { ean: 'x' }], ['product_lookup', { site: 'power', ean: EAN, nope: 1 }]]) {
    const r = await tools.handle(n, a, {});
    assert.equal(r.result.isError, true);
  }
  assert.equal(up.calls.length, 0);
  const bad = createRetailTools(fakeUpstream({ nothing: true }).fn, () => {});
  assert.equal((await bad.handle('product_compare', { ean: EAN }, {})).result.isError, true);
  const err = createRetailTools(fakeUpstream({}, { isError: true }).fn, () => {});
  const e = await err.handle('product_lookup', { site: 'power', ean: EAN }, {});
  assert.equal(e.result.isError, true);
  assert.ok(!e.result.content[0].text.includes(EAN));
});

// ---- GTIN family codes ----

test('checkGtin: GS1 check digit for 8, 12, 13 and 14 digits, padding and the shop search form', () => {
  const ok = (c) => { const g = checkGtin(c); assert.ok(!g.error, `${c}: ${g.error}`); return g; };
  const gtin8 = ok('96385074');
  assert.equal(gtin8.g14, '00000096385074');
  assert.equal(gtin8.search, '0000096385074', 'padded to 13 for the shop search');
  const upc = ok('036000291452');
  assert.equal(upc.g14, '00036000291452');
  assert.equal(upc.search, '0036000291452');
  const ean = ok('4006381333931');
  assert.equal(ean.g14, '04006381333931');
  assert.equal(ean.search, '4006381333931');
  const g14 = ok('04006381333931');
  assert.equal(g14.search, '4006381333931', 'one leading zero of a GTIN-14 is dropped');
  const real14 = ok('14006381333938');
  assert.equal(real14.search, '14006381333938', 'a real GTIN-14 stays 14 digits');
  for (const bad of ['96385075', '036000291453', '4006381333932', '14006381333939']) {
    assert.equal(checkGtin(bad).error, 'check digit does not match (typo?)', bad);
  }
});

test('checkGtin: separators are stripped, everything else is rejected', () => {
  assert.equal(checkGtin('4006381 333931').digits, '4006381333931');
  assert.equal(checkGtin('4-006381-333931').digits, '4006381333931');
  assert.equal(checkGtin(' 036000-291452 ').digits, '036000291452');
  for (const bad of ['', '1234567', '123456789', '12345678901', '123456789012345', '4006381333931a', '4006381333931\n', '4006381333931;rm', '4006381.333931', '４００６３８１３３３９３１', null, 4006381333931, {}, 'x'.repeat(100)]) {
    assert.ok(checkGtin(bad).error, `rejects ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(validateCompare({ ean: '4006381333932' }), { error: 'check digit does not match (typo?)' });
  assert.equal(validateLookup({ site: 'power', ean: '4006381333932' }).error, 'check digit does not match (typo?)');
  assert.equal(validateLookup({ site: 'power', ean: '036000-291452' }).value.value, '036000291452');
  assert.equal(validateCompare({ ean: '0360 0029 1452' }).value.ean, '036000291452');
});

test('code parameters carry the shop search form and the 14-digit form of the code', () => {
  const u = lookupParams(validateLookup({ site: 'power', ean: '036000291452' }).value);
  assert.equal(u.value, '0036000291452');
  assert.equal(u.g14, '00036000291452');
  const c = compareParams(validateCompare({ ean: '14006381333938' }).value);
  assert.equal(c.value, '14006381333938');
  assert.equal(c.g14, '14006381333938');
  assert.equal(lookupParams(validateLookup({ site: 'power', query: 'x' }).value).g14, undefined);
  assert.equal(gtin14('3600029'), '', 'too short');
  assert.equal(gtin14('0036000291452'), '00036000291452');
});

test('an EAN given as UPC-A matches a shop that stores it as 13 digits with a leading 0', async () => {
  const ld = fj('power.ld.json')[0];
  ld['@graph'].find((n) => n['@type'] === 'Product').gtin13 = '0036000291452';
  const ctx = {
    request: {
      get: async (u) => ({
        status: () => 200,
        text: async () => (u.includes('productlists')
          ? JSON.stringify({ products: fj('power.api.json') })
          : `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`),
      }),
    },
    newPage: async () => ({ close: async () => {} }),
  };
  const g = checkGtin('036000291452');
  const P = { sites: ['power'], kind: 'ean', value: g.search, g14: g.g14, need: 'basic', prisjakt: false, perSiteMs: 2000, totalMs: 4000 };
  const out = await retailMain({ context: () => ctx }, P);
  assert.equal(out.sites.power.status, 'ok');
  assert.ok(out.sites.power.detail, 'matched on the padded forms');
  const miss = await retailMain({ context: () => ctx }, { ...P, g14: '00036000291469' });
  assert.equal(miss.sites.power.status, 'not_found');
  assert.match(formatCompare('036000291452', out, 'tldr', false), /^EAN 036000291452: /);
});

// ---- price display ----

test('priceText: current price first, before-price inline only when higher, member forms', () => {
  assert.equal(priceText({ price: 3790, before: null }), '3 790 kr');
  assert.equal(priceText({ price: 3790 }), '3 790 kr');
  assert.equal(priceText({ price: 3690, before: 4990 }), '3 690 kr (was 4 990 kr, -26%)');
  assert.equal(priceText({ price: 3790, before: 3790 }), '3 790 kr', 'not higher: no was');
  assert.equal(priceText({ price: 3790, before: 3000 }), '3 790 kr');
  assert.equal(priceText({ price: 999, before: 1000 }), '999 kr (was 1 000 kr)', 'percent rounds to 0: omitted');
  assert.equal(priceText({ price: null, before: 100 }), '?');
  assert.equal(priceText({ price: 3790, member: 3490 }), '3 790 kr (members 3 490 kr)');
  assert.equal(priceText({ price: 3790, member: true }), '3 790 kr (members price)');
  assert.equal(priceText({ price: 3690, before: 4990, member: 3490 }), '3 690 kr (was 4 990 kr, -26%) (members 3 490 kr)');
});

test('candidate lines use the same price display; before-prices come from each source', () => {
  const el = normalizeItem('elkjop', { id: '1', url: 'u', dyn: trimElkDyn(fj('elkjop.dyn.discount.json')) });
  assert.equal(priceText(el), '3 690 kr (was 4 990 kr, -26%)');
  const pw = normalizeItem('power', { id: '2', url: 'u', api: { title: 'x', price: 2490, previous: 2790 } });
  assert.equal(priceText(pw), '2 490 kr (was 2 790 kr, -11%)');
  const ps = normalizeItem('proshop', { id: '3', url: 'u', name: 'x', price: '1 199,-', pre: '1 499,-' });
  assert.equal(priceText(ps), '1 199 kr (was 1 499 kr, -20%)');
  assert.equal(priceText(normalizeItem('proshop', { id: '3', url: 'u', name: 'x', price: '1 199,-', pre: '' })), '1 199 kr');
  const c = formatLookup('power', { sites: { power: { status: 'ok', items: [{ id: '2', url: 'https://www.power.no/p-2/', api: { title: 'x', price: 2490, previous: 2790 } }] } } }, 'tldr');
  assert.match(c.text, /2 {2}x {2}2 490 kr \(was 2 790 kr, -11%\) {2}https:\/\/www\.power\.no\/p-2\//);
});

test('formatCompare: discounted site keeps columns aligned in tldr and normal; cheapest line marks the discount', () => {
  const raw = compareRaw();
  raw.sites.elkjop.detail.dyn = trimElkDyn(fj('elkjop.dyn.discount.json'));
  raw.sites.komplett.detail.ld.offers[0].price = '999';
  for (const mode of ['tldr', 'normal']) {
    const text = formatCompare(EAN, raw, mode, false);
    const lines = text.split('\n').filter((l) => /^(elkjop|komplett)\s/.test(l));
    assert.equal(lines.length, 2);
    const col = (l) => l.indexOf('WH1000XM5B.CE7');
    assert.equal(col(lines[0]), col(lines[1]), `model column aligned in ${mode}\n${text}`);
    assert.match(lines[0], /^elkjop\s+3 690 kr \(was 4 990 kr, -26%\)\s+WH1000XM5B/);
    assert.match(lines[1], /^komplett\s+999 kr\s+WH1000XM5B/);
    assert.ok(!/ was 4 990 kr$/m.test(text), 'no separate trailing was part');
    assert.match(text, /\nCheapest: komplett 999 kr\n/);
  }
  const tie = compareRaw();
  tie.sites.elkjop.detail.dyn = trimElkDyn(fj('elkjop.dyn.discount.json'));
  assert.match(formatCompare(EAN, tie, 'tldr', false), /\nCheapest: elkjop 3 690 kr \(was 4 990 kr, -26%\), komplett 3 690 kr\n/);
  const solo = compareRaw();
  solo.sites.komplett.detail.ld.offers[0].price = '4000';
  solo.sites.elkjop.detail.dyn = trimElkDyn(fj('elkjop.dyn.discount.json'));
  assert.match(formatCompare(EAN, solo, 'tldr', false), /\nCheapest: elkjop 3 690 kr \(was 4 990 kr, -26%\)\n/);
});

// ---- candidate lists: price fill and drop ----

test('candidates: unpriced ones are filled from the site batch (power), then dropped when still unpriced', async () => {
  const reqs = [];
  const list = [
    { productId: 1, title: 'Headphones', price: 3790, url: '/p-1/' },
    { productId: 2, title: 'Case', price: null, url: '/p-2/' },
    { productId: 3, title: 'Cable', price: null, url: '/p-3/' },
  ];
  const ctx = {
    request: {
      get: async (u) => {
        reqs.push(u);
        const body = u.includes('productlists') ? { products: list } : [{ productId: 2, title: 'Case', price: 299, previousPrice: 399 }];
        return { status: () => 200, text: async () => JSON.stringify(body) };
      },
    },
    newPage: async () => ({ close: async () => {} }),
  };
  const P = { sites: ['power'], kind: 'query', value: 'sony', need: 'detail', prisjakt: false, perSiteMs: 2000, totalMs: 4000 };
  const out = await retailMain({ context: () => ctx }, P);
  assert.equal(reqs.length, 2, 'one list request plus ONE batch request');
  assert.match(reqs[1], /\/api\/v2\/products\?ids=2,3&allowWebStatus8=true$/);
  const f = formatLookup('power', out, 'normal');
  assert.match(f.text, /^2 candidates on power/);
  assert.match(f.text, /1 {2}Headphones {2}3 790 kr {2}/);
  assert.match(f.text, /2 {2}Case {2}299 kr \(was 399 kr, -25%\) {2}/);
  assert.ok(!/Cable/.test(f.text), 'candidate without a price is left out');
});

test('candidates: elkjop fetches missing prices in one more tRPC batch', async () => {
  const evalUrls = [];
  const dyn = (sku, price) => ({ result: { data: { sku, content: { title: `P${sku}` }, price: price === null ? {} : { current: [price, price * 0.8], original: [price + 100, 1], isDiscounted: true } } } });
  const inputOf = (u) => JSON.parse(decodeURIComponent(/input=(.*)$/.exec(u)[1]));
  const tab = {
    goto: async () => ({ status: () => 200 }),
    waitForSelector: async () => true,
    title: async () => 'x',
    url: () => 'https://www.elkjop.no/search?q=x',
    $$eval: async () => ['11', '22', '33'].map((id) => ({ id, href: `/product/x/${id}` })),
    evaluate: async (fn, [u]) => {
      evalUrls.push(u);
      const skus = Object.values(inputOf(u)).map((v) => v.sku);
      if (evalUrls.length === 1) return skus.map((k) => dyn(k, k === '11' ? 3790 : null));
      return skus.map((k) => dyn(k, k === '22' ? 299 : null));
    },
    close: async () => {},
  };
  const ctx = { request: {}, newPage: async () => tab };
  const P = { sites: ['elkjop'], kind: 'query', value: 'x', need: 'detail', prisjakt: false, perSiteMs: 2000, totalMs: 4000 };
  const out = await retailMain({ context: () => ctx }, P);
  assert.equal(evalUrls.length, 2, 'first batch plus one more for the unpriced');
  assert.equal(Object.keys(inputOf(evalUrls[1])).length, 2);
  const f = formatLookup('elkjop', out, 'normal');
  assert.match(f.text, /^2 candidates on elkjop/);
  assert.match(f.text, /11 {2}P11 {2}3 790 kr \(was 3 890 kr, -3%\)/);
  assert.match(f.text, /22 {2}P22 {2}299 kr/);
  assert.ok(!/P33/.test(f.text));
});

test('candidates: nothing priced says "no priced matches", nothing at all says "not found"', () => {
  const items = [{ id: '1', url: 'u', api: { title: 'Case', price: null } }, { id: '2', url: 'u', api: { title: 'Cable' } }];
  assert.equal(formatLookup('power', { sites: { power: { status: 'ok', items } } }, 'normal').text, 'power: no priced matches');
  assert.equal(formatLookup('power', { sites: { power: { status: 'ok', items: [] } } }, 'normal').text, 'power: not found');
  const ek = [{ id: '1', url: 'u', dyn: trimElkDyn({ sku: '1', content: { title: 'Acc' } }) }];
  assert.equal(formatLookup('elkjop', { sites: { elkjop: { status: 'ok', items: ek } } }, 'tldr').text, 'elkjop: no priced matches');
});
