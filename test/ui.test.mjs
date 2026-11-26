import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createUi, CSP, MAX_PER_MINUTE, CACHE_MAX } from '../gateway/ui.mjs';
import { createUiUpstream } from '../gateway/ui-upstream.mjs';
import { loadConfig } from '../gateway/config.mjs';

const EAN = '8720389032998';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a mock upstream: answers browser_run_code_unsafe the way the retail browser code would ----

const textResult = (obj) => ({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(obj)}\n### Ran Playwright code\n` }] });
function detailFor(site, over = {}) {
  const price = { power: 2999, proshop: 1457, elkjop: 990, komplett: 990 }[site];
  if (site === 'power') return { id: '3111517', url: 'https://www.power.no/p-3111517/', api: { title: 'Philips airfryer', mpn: 'NA352/00', brand: 'Philips', price, stock: 12, ...over }, ld: { gtin: EAN } };
  if (site === 'proshop') return { id: '3310246', url: 'https://www.proshop.no/x/3310246', ld: { name: 'Philips airfryer', mpn: 'NA352/00', gtin: EAN, offers: [{ price, avail: 'InStock' }] }, dom: {} };
  if (site === 'komplett') return { id: '1303793', url: 'https://www.komplett.no/product/1303793', ld: { name: 'Philips airfryer', mpn: 'NA352/00', gtin: EAN, offers: [{ price, avail: 'OutOfStock' }] }, md: {}, before: '2 795,-' };
  return { id: '774650', url: 'https://www.elkjop.no/product/774650', ld: { name: 'Philips airfryer', mpn: 'NA352/00', gtin: EAN, offers: [{ price, avail: 'InStock' }] }, dyn: null };
}
function mockUpstream({ delays = {}, statuses = {}, hold = null } = {}) {
  const calls = [];
  return {
    calls,
    async call(slot, name, args) {
      assert.equal(name, 'browser_run_code_unsafe');
      const P = JSON.parse(/const P = (\{.*\});\n/.exec(args.code)[1]);
      calls.push(P);
      if (hold) await hold;
      const out = { v: 1, ms: 1, sites: {} };
      await Promise.all(P.sites.map(async (s) => {
        await wait(delays[s] || 0);
        out.sites[s] = statuses[s] ? { status: statuses[s], ms: 1 } : P.kind === 'query'
          ? { status: 'ok', ms: 1, items: [{ id: '1', url: 'https://www.power.no/p-1/', api: { title: 'Candidate <b>1</b>', price: 100 } }, { id: '2', url: 'https://www.power.no/p-2/', api: { title: 'No price' } }] }
          : { status: 'ok', ms: 1, detail: detailFor(s) };
      }));
      if (P.prisjakt) out.prisjakt = { status: 'ok', ms: 1, detail: { low: 900, shops: 11, url: 'https://www.prisjakt.no/product.php?p=1' } };
      return textResult(out);
    },
  };
}

// ---- helpers: an HTTP host for createUi ----

async function host(opts = {}) {
  const logs = [];
  const upstream = opts.upstream || mockUpstream();
  const ui = createUi({ ui: { enabled: true, authOff: true, ...opts.ui }, upstream, log: (m) => logs.push(m), now: opts.now, fetchImpl: opts.fetchImpl });
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (ui.owns(url.pathname)) ui.handle(req, res, url).catch(() => res.end());
    else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); }
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers: { 'sec-fetch-site': 'same-origin', ...headers }, redirect: 'manual' });
  return { base, get, logs, upstream, close: () => { srv.closeAllConnections(); srv.close(); } };
}
async function ndjson(res) {
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- static files, headers, routing ----

test('static files and security headers on every UI response', async () => {
  const h = await host();
  try {
    for (const [path, type] of [['/', 'text/html'], ['/ui/app.js', 'text/javascript'], ['/ui/app.css', 'text/css'], ['/ui/icon.svg', 'image/svg+xml']]) {
      const r = await h.get(path);
      assert.equal(r.status, 200, path);
      assert.ok(r.headers.get('content-type').startsWith(type), path);
      assert.equal(r.headers.get('content-security-policy'), CSP);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()');
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      await r.arrayBuffer();
    }
    const api = await h.get('/ui/api/compare?code=1');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('content-security-policy'), CSP);
    assert.equal(api.headers.get('access-control-allow-origin'), null);
    await api.arrayBuffer();
    assert.match(CSP, /^default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/);
  } finally { h.close(); }
});

test('the page has no inline script or style and no event-handler attributes', async () => {
  const h = await host();
  try {
    const html = await (await h.get('/')).text();
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), 'inline <script>');
    assert.ok(!/<style/i.test(html));
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    assert.ok(!/style\s*=/i.test(html));
    const js = await (await h.get('/ui/app.js')).text();
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), 'unsafe DOM sink in app.js');
  } finally { h.close(); }
});

test('routing: unknown UI paths 404, non-GET refused, the API only answers its two routes', async () => {
  const h = await host();
  try {
    for (const p of ['/index.html', '/ui/', '/ui/nope', '/ui/api/', '/ui/api/other', '/ui/../mcp', '/ui/app.js/x']) {
      const r = await h.get(p);
      assert.equal(r.status, 404, p);
      await r.arrayBuffer();
    }
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(`${h.base}/ui/api/compare?code=${EAN}`, { method: m, headers: { 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 405, m);
      await r.arrayBuffer();
    }
    assert.equal((await fetch(`${h.base}/`, { method: 'POST' })).status, 405);
  } finally { h.close(); }
});

test('/mcp is not owned by the UI', () => {
  const ui = createUi({ ui: { enabled: true, authOff: true }, upstream: mockUpstream(), log: () => {} });
  assert.equal(ui.owns('/mcp'), false);
  assert.equal(ui.owns('/'), true);
  assert.equal(ui.owns('/ui/api/compare'), true);
  const off = createUi({ ui: { enabled: false, authOff: false }, upstream: mockUpstream(), log: () => {} });
  assert.equal(off.owns('/'), false);
  assert.equal(off.owns('/ui/app.js'), false);
});

// ---- same-origin rule ----

test('API needs Sec-Fetch-Site: same-origin, or no such header and a matching Origin', async () => {
  const h = await host();
  try {
    const path = '/ui/api/lookup?site=power&id=3111517';
    const code = async (headers) => { const r = await fetch(h.base + path, { headers }); await r.arrayBuffer(); return r.status; };
    assert.equal(await code({ 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(await code({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await code({ 'sec-fetch-site': 'same-site' }), 403);
    assert.equal(await code({ 'sec-fetch-site': 'none' }), 403);
    assert.equal(await code({}), 403, 'neither header');
    assert.equal(await code({ origin: 'https://evil.example' }), 403);
    assert.equal(await code({ origin: h.base }), 200, 'no Sec-Fetch-Site, matching Origin');
    assert.equal(await code({ origin: h.base, 'sec-fetch-site': 'cross-site' }), 403, 'Sec-Fetch-Site wins');
  } finally { h.close(); }
});

// ---- auth ----

test('auth on: no header, junk header and a foreign token get 403 plain text, static and API alike', async () => {
  const h = await host({ ui: { authOff: false, team: 'example.cloudflareaccess.com', aud: 'a'.repeat(64) }, fetchImpl: async () => ({ ok: false }) });
  try {
    for (const [p, headers] of [['/', {}], ['/ui/app.js', {}], ['/ui/api/compare?code=' + EAN, {}], ['/', { 'cf-access-jwt-assertion': 'junk' }], ['/ui/api/lookup?site=power&id=3111517', { 'cf-access-jwt-assertion': 'a.b.c' }]]) {
      const r = await h.get(p, headers);
      assert.equal(r.status, 403, p);
      assert.ok(r.headers.get('content-type').startsWith('text/plain'));
      assert.equal(await r.text(), 'forbidden');
    }
    assert.equal(h.upstream.calls.length, 0);
  } finally { h.close(); }
});

test('auth on: a valid token passes', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const team = 'example.cloudflareaccess.com';
  const aud = 'c'.repeat(64);
  const h = await host({ ui: { authOff: false, team, aud }, fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) });
  try {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const hp = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({ iss: `https://${team}`, aud: [aud], exp: Math.floor(Date.now() / 1000) + 300 })}`;
    const tok = `${hp}.${crypto.sign('RSA-SHA256', Buffer.from(hp), privateKey).toString('base64url')}`;
    const r = await h.get('/', { 'cf-access-jwt-assertion': tok });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    const bad = await h.get('/', { 'cf-access-jwt-assertion': `${tok.slice(0, -4)}AAAA` });
    assert.equal(bad.status, 403);
    await bad.arrayBuffer();
  } finally { h.close(); }
});

// ---- config ----

const withEnv = (env, fn) => {
  const keep = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('BRMCP_')) delete process.env[k];
  Object.assign(process.env, { BRMCP_HOSTNAME: 'x.example.com' }, env);
  try { return fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]; Object.assign(process.env, keep); }
};

test('config: UI is off unless TEAM and AUD are both set', () => {
  assert.equal(withEnv({}, () => loadConfig().ui.enabled), false);
  assert.equal(withEnv({ BRMCP_ACCESS_TEAM: 'example.cloudflareaccess.com' }, () => loadConfig().ui.enabled), false);
  assert.equal(withEnv({ BRMCP_ACCESS_AUD: 'a'.repeat(64) }, () => loadConfig().ui.enabled), false);
  const c = withEnv({ BRMCP_ACCESS_TEAM: 'Example.CloudflareAccess.com', BRMCP_ACCESS_AUD: 'a'.repeat(64) }, () => loadConfig());
  assert.equal(c.ui.enabled, true);
  assert.equal(c.ui.authOff, false);
  assert.equal(c.ui.team, 'example.cloudflareaccess.com');
});

test('config: bad team or AUD values are refused', () => {
  assert.throws(() => withEnv({ BRMCP_ACCESS_TEAM: 'https://example.cloudflareaccess.com', BRMCP_ACCESS_AUD: 'a'.repeat(64) }, loadConfig), /BRMCP_ACCESS_TEAM/);
  assert.throws(() => withEnv({ BRMCP_ACCESS_TEAM: 'localhost', BRMCP_ACCESS_AUD: 'a'.repeat(64) }, loadConfig), /BRMCP_ACCESS_TEAM/);
  assert.throws(() => withEnv({ BRMCP_ACCESS_TEAM: 'example.cloudflareaccess.com', BRMCP_ACCESS_AUD: 'a b' }, loadConfig), /BRMCP_ACCESS_AUD/);
  assert.throws(() => withEnv({ BRMCP_UI_AUTH: 'maybe' }, loadConfig), /BRMCP_UI_AUTH/);
});

test('config: BRMCP_UI_AUTH=off is accepted only on a loopback bind', () => {
  assert.equal(withEnv({ BRMCP_UI_AUTH: 'off', BRMCP_BIND: '127.0.0.1' }, () => loadConfig().ui.authOff), true);
  assert.equal(withEnv({ BRMCP_UI_AUTH: 'off' }, () => loadConfig().ui.enabled), true, 'default bind is loopback');
  for (const bind of ['0.0.0.0', '192.168.1.10', '10.0.0.5']) {
    assert.throws(() => withEnv({ BRMCP_UI_AUTH: 'off', BRMCP_BIND: bind }, loadConfig), /only allowed with BRMCP_BIND=127\.0\.0\.1/, bind);
  }
  assert.equal(withEnv({ BRMCP_UI_AUTH: 'on', BRMCP_BIND: '0.0.0.0' }, () => loadConfig().ui.authOff), false);
});

// ---- compare ----

test('compare streams one NDJSON line per shop as it finishes, then prisjakt, then done', async () => {
  const h = await host({ upstream: mockUpstream({ delays: { power: 10, proshop: 60, elkjop: 120, komplett: 180 } }) });
  try {
    const r = await h.get(`/ui/api/compare?code=${EAN}&prisjakt=1`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type').startsWith('application/x-ndjson'));
    // read incrementally: lines must arrive before the stream ends
    const stamps = [];
    const dec = new TextDecoder();
    let buf = '';
    const t0 = Date.now();
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { stamps.push([JSON.parse(buf.slice(0, i)), Date.now() - t0]); buf = buf.slice(i + 1); }
    }
    const lines = stamps.map((s) => s[0]);
    const shops = lines.filter((l) => l.site).map((l) => l.site);
    assert.deepEqual(shops, ['power', 'proshop', 'elkjop', 'komplett']);
    assert.deepEqual(lines[lines.length - 1], { done: true });
    assert.ok(lines.some((l) => 'prisjakt' in l));
    assert.deepEqual(lines.find((l) => 'prisjakt' in l), { prisjakt: { low: 900, shops: 11, url: 'https://www.prisjakt.no/product.php?p=1' } });
    const power = lines.find((l) => l.site === 'power');
    assert.deepEqual(Object.keys(power), ['site', 'status', 'product']);
    assert.deepEqual(Object.keys(power.product).sort(), ['before', 'brand', 'ean', 'id', 'inStock', 'member', 'mpn', 'name', 'price', 'stock', 'url'].sort());
    assert.equal(power.product.price, 2999);
    assert.equal(power.product.inStock, true);
    const komp = lines.find((l) => l.site === 'komplett');
    assert.equal(komp.product.inStock, false);
    assert.equal(komp.product.before, 2795);
    // arrival times are spread out, not all at the end
    const firstShop = stamps.find((s) => s[0].site)[1];
    const lastShop = stamps.filter((s) => s[0].site).pop()[1];
    assert.ok(lastShop - firstShop >= 100, `first ${firstShop} ms, last ${lastShop} ms`);
    // each shop was its own single-site browser call
    assert.deepEqual(h.upstream.calls.filter((c) => !c.prisjakt).map((c) => c.sites.length), [1, 1, 1, 1]);
    assert.ok(h.logs.some((l) => /^ui api=compare status=200 ms=\d+ shops_ok=4$/.test(l)), h.logs.join('|'));
  } finally { h.close(); }
});

test('compare: failed shops stream a status line without a product', async () => {
  const h = await host({ upstream: mockUpstream({ statuses: { elkjop: 'blocked', komplett: 'timeout', proshop: 'not_found' } }) });
  try {
    const lines = await ndjson(await h.get(`/ui/api/compare?code=${EAN}&sites=elkjop,komplett,proshop,power`));
    const by = Object.fromEntries(lines.filter((l) => l.site).map((l) => [l.site, l]));
    assert.deepEqual(by.elkjop, { site: 'elkjop', status: 'blocked' });
    assert.deepEqual(by.komplett, { site: 'komplett', status: 'timeout' });
    assert.deepEqual(by.proshop, { site: 'proshop', status: 'not_found' });
    assert.equal(by.power.status, 'ok');
    assert.ok(!lines.some((l) => 'prisjakt' in l), 'no prisjakt line unless asked');
  } finally { h.close(); }
});

test('compare: a backend error becomes status error and is not cached', async () => {
  let n = 0;
  const upstream = { calls: [], async call() { n++; return { isError: true, content: [{ type: 'text', text: 'boom' }] }; } };
  const h = await host({ upstream });
  try {
    const lines = await ndjson(await h.get(`/ui/api/compare?code=${EAN}&sites=power`));
    assert.deepEqual(lines, [{ site: 'power', status: 'error' }, { done: true }]);
    await (await h.get(`/ui/api/compare?code=${EAN}&sites=power`)).text();
    assert.equal(n, 2, 'errors are not cached');
  } finally { h.close(); }
});

test('compare: input validation errors are 400 JSON', async () => {
  const h = await host();
  try {
    for (const q of ['', 'code=', 'code=abc', 'code=8720389032999', 'code=123', `code=${EAN}&sites=nope`, `code=${EAN}&sites=power,power`, `code=${EAN}&prisjakt=yes`, `code=${EAN}&extra=1`, 'code=' + '1'.repeat(60)]) {
      const r = await h.get(`/ui/api/compare?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(r.headers.get('content-type').startsWith('application/json'));
      assert.equal(typeof (await r.json()).error, 'string');
    }
    assert.equal(h.upstream.calls.length, 0);
    const ok = await h.get(`/ui/api/compare?code=${EAN.slice(0, 4)}%20${EAN.slice(4)}&sites=power`);
    assert.equal(ok.status, 200, 'spaces in the code are allowed');
    await ok.text();
  } finally { h.close(); }
});

test('compare: second identical request is served from the cache', async () => {
  const h = await host();
  try {
    const a = await ndjson(await h.get(`/ui/api/compare?code=${EAN}`));
    const calls = h.upstream.calls.length;
    const b = await ndjson(await h.get(`/ui/api/compare?code=${EAN}`));
    assert.equal(h.upstream.calls.length, calls, 'no new browser calls');
    assert.deepEqual(b.filter((l) => l.site).map((l) => l.site), a.filter((l) => l.site).map((l) => l.site));
    assert.deepEqual(b[b.length - 1], { done: true });
    assert.ok(h.logs.some((l) => /cache=1/.test(l)));
    // site order in the query does not matter for the key
    await (await h.get(`/ui/api/compare?code=${EAN}&sites=power,elkjop,komplett,proshop`)).text();
    assert.equal(h.upstream.calls.length, calls);
  } finally { h.close(); }
});

test('cache entries expire after 10 minutes and the cache holds at most 200 entries', async () => {
  let t = 1000000;
  const h = await host({ now: () => t });
  try {
    await (await h.get('/ui/api/lookup?site=power&id=1234')).text();
    const n = h.upstream.calls.length;
    t += 599000;
    await (await h.get('/ui/api/lookup?site=power&id=1234')).text();
    assert.equal(h.upstream.calls.length, n, 'still cached');
    t += 2000;
    await (await h.get('/ui/api/lookup?site=power&id=1234')).text();
    assert.equal(h.upstream.calls.length, n + 1, 'expired');
    // fill past the limit (advance the clock so the rate limiter does not interfere)
    for (let i = 0; i < CACHE_MAX + 5; i++) {
      t += 1100;
      await (await h.get(`/ui/api/lookup?site=power&id=${10000 + i}`)).text();
    }
    const before = h.upstream.calls.length;
    t += 1100;
    await (await h.get('/ui/api/lookup?site=power&id=10000')).text(); // oldest: evicted
    assert.equal(h.upstream.calls.length, before + 1);
  } finally { h.close(); }
});

// ---- lookup ----

test('lookup returns a product, candidates (priced only, as plain data) or a status', async () => {
  const h = await host();
  try {
    const p = await (await h.get('/ui/api/lookup?site=power&id=3111517')).json();
    assert.equal(p.product.name, 'Philips airfryer');
    assert.equal(p.product.ean, EAN);
    const c = await (await h.get('/ui/api/lookup?site=power&query=Airfryer%20philips')).json();
    assert.deepEqual(c, { candidates: [{ id: '1', name: 'Candidate <b>1</b>', price: 100, before: null, url: 'https://www.power.no/p-1/' }] });
    const h2 = await host({ upstream: mockUpstream({ statuses: { elkjop: 'blocked' } }) });
    try {
      assert.deepEqual(await (await h2.get('/ui/api/lookup?site=elkjop&id=459129')).json(), { status: 'blocked' });
    } finally { h2.close(); }
  } finally { h.close(); }
});

test('lookup validates like product_lookup', async () => {
  const h = await host();
  try {
    for (const q of ['', 'site=power', 'site=nope&id=1234', 'site=power&id=12', 'site=power&id=1234&query=x', 'site=power&query=', `site=power&query=${'x'.repeat(101)}`,
      'site=power&ean=8720389032999', 'site=power&url=http%3A%2F%2Fwww.power.no%2Fp-1234%2F', 'site=power&url=https%3A%2F%2Fevil.example%2Fp-1234%2F',
      'site=power&id=1234&mode=tldr', 'site=power&id=1234&junk=1', 'site=power&query=a%00b']) {
      const r = await h.get(`/ui/api/lookup?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(typeof (await r.json()).error, 'string');
    }
    for (const q of ['site=power&url=https%3A%2F%2Fwww.power.no%2Fkjoekken%2Fp-3111517%2F', `site=power&ean=${EAN}`, 'site=power&id=3111517&mode=full']) {
      const r = await h.get(`/ui/api/lookup?${q}`);
      assert.equal(r.status, 200, q);
      await r.arrayBuffer();
    }
  } finally { h.close(); }
});

// ---- limits ----

test('at most 2 API requests run at once; the third gets 429', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  const h = await host({ upstream: mockUpstream({ hold }) });
  try {
    const a = h.get('/ui/api/lookup?site=power&id=1111');
    const b = h.get('/ui/api/lookup?site=power&id=2222');
    await wait(100);
    const c = await h.get('/ui/api/lookup?site=power&id=3333');
    assert.equal(c.status, 429);
    assert.equal(typeof (await c.json()).error, 'string');
    const d = await h.get(`/ui/api/compare?code=${EAN}`);
    assert.equal(d.status, 429);
    await d.arrayBuffer();
    release();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    const e = await h.get('/ui/api/lookup?site=power&id=4444');
    assert.equal(e.status, 200, 'slot freed again');
    await e.arrayBuffer();
  } finally { h.close(); }
});

test('at most 60 API requests per minute; static files are not counted', async () => {
  let t = 5000000;
  const h = await host({ now: () => t });
  try {
    for (let i = 0; i < 5; i++) await (await h.get('/ui/app.css')).arrayBuffer();
    for (let i = 0; i < MAX_PER_MINUTE; i++) {
      const r = await h.get('/ui/api/compare?code=bad');
      assert.equal(r.status, 400, `request ${i + 1}`);
      await r.arrayBuffer();
    }
    const r = await h.get('/ui/api/compare?code=bad');
    assert.equal(r.status, 429);
    await r.arrayBuffer();
    t += 61000;
    const ok = await h.get('/ui/api/compare?code=bad');
    assert.equal(ok.status, 400, 'window moved on');
    await ok.arrayBuffer();
  } finally { h.close(); }
});

// ---- logging ----

test('log lines carry no arguments, codes, queries or tokens', async () => {
  const h = await host();
  try {
    await (await h.get(`/ui/api/compare?code=${EAN}&sites=power`)).text();
    await (await h.get('/ui/api/lookup?site=power&query=secret%20thing')).text();
    await (await h.get('/ui/api/lookup?site=power&id=999999')).text();
    assert.ok(h.logs.length >= 3);
    for (const l of h.logs) {
      assert.match(l, /^ui api=(compare|lookup) status=\d+ ms=\d+( shops_ok=\d+)?( cache=1)?$/);
      assert.ok(!l.includes(EAN) && !/secret|999999/.test(l));
    }
  } finally { h.close(); }
});

// ---- upstream pool ----

test('ui upstream pool: lazy connect, idle close, slot cap, reconnect after failure', async () => {
  let t = 0;
  let opened = 0;
  let closed = 0;
  const pool = createUiUpstream({
    maxSlots: 2, idleMs: 1000, now: () => t,
    connect: async () => { opened++; return { callTool: async () => ({ content: [] }), close: async () => { closed++; } }; },
  });
  try {
    assert.equal(opened, 0);
    await Promise.all([pool.call('a', 'x', {}), pool.call('a', 'x', {})]);
    assert.equal(opened, 1, 'one session shared by concurrent calls');
    await pool.call('b', 'x', {});
    const over = await pool.call('c', 'x', {});
    assert.equal(over.isError, true, 'third slot refused');
    assert.equal(pool.size(), 2);
    t += 1500;
    await pool.sweep();
    assert.equal(pool.size(), 0);
    assert.equal(closed, 2, 'idle sessions closed');
    await pool.call('a', 'x', {});
    assert.equal(opened, 3);
  } finally { await pool.closeAll(); }

  let fail = true;
  let made = 0;
  const p2 = createUiUpstream({
    connect: async () => { made++; return { callTool: async () => { if (fail) throw new Error('socket closed'); return { content: [] }; }, close: async () => {} }; },
  });
  try {
    assert.equal((await p2.call('a', 'x', {})).isError, true);
    fail = false;
    assert.notEqual((await p2.call('a', 'x', {})).isError, true);
    assert.equal(made, 2, 'a failed session is replaced');
  } finally { await p2.closeAll(); }
});

// ---- the real server process ----

async function runGateway(env) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [new URL('../gateway/server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, BRMCP_HOSTNAME: `127.0.0.1:${port}`, BRMCP_PORT: String(port), BRMCP_UPSTREAM_PORT: String(port + 1), BRMCP_BIND: '127.0.0.1', BRMCP_GATEWAY_DATA_DIR: '/tmp', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 100 && !/listening on/.test(err) && child.exitCode === null; i++) await wait(50);
  return { port, child, err: () => err, stop: async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } };
}

test('gateway process: UI disabled without TEAM/AUD (404, one log line), /mcp and the Host check unchanged', async () => {
  const g = await runGateway({});
  try {
    assert.equal(g.err().split('ui disabled (BRMCP_ACCESS_TEAM/BRMCP_ACCESS_AUD not set)').length - 1, 1);
    const hdr = { host: `127.0.0.1:${g.port}` };
    for (const p of ['/', '/ui/app.js', '/ui/api/compare?code=' + EAN]) {
      const r = await fetch(`http://127.0.0.1:${g.port}${p}`, { headers: { ...hdr, 'sec-fetch-site': 'same-origin' } });
      assert.equal(r.status, 404, p);
      assert.equal(r.headers.get('content-security-policy'), null);
      await r.arrayBuffer();
    }
    const bad = await fetch(`http://127.0.0.1:${g.port}/mcp`, { method: 'POST', headers: { ...hdr, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(bad.status, 400, '/mcp still answers as before (no session)');
    assert.equal((await bad.json()).error.code, -32000);
    const nf = await fetch(`http://127.0.0.1:${g.port}/other`, { headers: hdr });
    assert.equal(nf.status, 404);
    await nf.arrayBuffer();
  } finally { await g.stop(); }
});

test('gateway process: Host check applies to the UI too; auth on without a header gives 403', async () => {
  const g = await runGateway({ BRMCP_ACCESS_TEAM: 'example.cloudflareaccess.com', BRMCP_ACCESS_AUD: 'd'.repeat(64) });
  try {
    assert.match(g.err(), /ui enabled/);
    const own = { host: `127.0.0.1:${g.port}` };
    const r = await fetch(`http://127.0.0.1:${g.port}/`, { headers: own });
    assert.equal(r.status, 403);
    assert.equal(await r.text(), 'forbidden');
    const r2 = await fetch(`http://127.0.0.1:${g.port}/ui/app.js`, { headers: own });
    assert.equal(r2.status, 403);
    await r2.arrayBuffer();
    // wrong Host: rejected by the host check before anything else (JSON body, not the UI's plain text)
    const wrong = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port: g.port, path: '/', headers: { host: 'evil.example' } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      q.end();
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body, '{"error":"forbidden host"}');
  } finally { await g.stop(); }
});

test('gateway process: BRMCP_UI_AUTH=off on a non-loopback bind refuses to start; on loopback it warns', async () => {
  const bad = await runGateway({ BRMCP_UI_AUTH: 'off', BRMCP_BIND: '0.0.0.0' });
  try {
    await wait(300);
    assert.equal(bad.child.exitCode, 78);
    assert.match(bad.err(), /BRMCP_UI_AUTH=off is only allowed with BRMCP_BIND=127\.0\.0\.1/);
  } finally { await bad.stop(); }
  const ok = await runGateway({ BRMCP_UI_AUTH: 'off' });
  try {
    assert.match(ok.err(), /WARNING: ui auth is OFF/);
    const r = await fetch(`http://127.0.0.1:${ok.port}/`, { headers: { host: `127.0.0.1:${ok.port}` } });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('<title>'));
  } finally { await ok.stop(); }
});
