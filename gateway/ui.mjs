// Price compare page: static files plus a small JSON/NDJSON API on top of the retail module.
// Everything here sits behind Cloudflare Access (JWT checked on every request).
import fs from 'node:fs';
import { createAccessVerifier } from './access.mjs';
import {
  validateLookup, validateCompare, compareParams, lookupParams, createRetailRunner, siteResult, prisjaktResult, lookupResult,
} from './retail.mjs';

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SEC_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
};
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/ui/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const UI_SLOT = 'ui';
export const MAX_CONCURRENT = 2;
export const MAX_PER_MINUTE = 60;
export const CACHE_MS = 600000;
export const CACHE_MAX = 200;

// opts: { ui: cfg.ui, upstream: { call(slot, name, args, extra) }, log, now?, fetchImpl?, dir? }
export function createUi({ ui, upstream, log, now = Date.now, fetchImpl, dir = new URL('./ui/', import.meta.url) }) {
  const verifier = ui.authOff ? null : createAccessVerifier({ team: ui.team, aud: ui.aud, fetchImpl, now });
  const files = new Map();
  const loadFile = (name) => {
    if (!files.has(name)) { try { files.set(name, fs.readFileSync(new URL(name, dir))); } catch { files.set(name, null); } }
    return files.get(name);
  };

  const hits = []; // request timestamps within the last minute
  let active = 0;
  const cache = new Map(); // key -> { at, value }
  const cacheGet = (k) => {
    const e = cache.get(k);
    if (!e) return null;
    if (now() - e.at > CACHE_MS) { cache.delete(k); return null; }
    cache.delete(k); cache.set(k, e); // most recently used last
    return e.value;
  };
  const cachePut = (k, value) => {
    cache.set(k, { at: now(), value });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  function send(res, status, body, type, extra = {}) {
    if (res.headersSent) return;
    res.writeHead(status, { ...SEC_HEADERS, 'content-type': type, ...extra });
    res.end(body);
  }
  const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
  const plain = (res, status, text) => send(res, status, text, 'text/plain; charset=utf-8', { 'cache-control': 'no-store' });

  const sameOrigin = (req) => {
    const sfs = req.headers['sec-fetch-site'];
    if (sfs !== undefined) return sfs === 'same-origin';
    const o = req.headers.origin;
    if (typeof o !== 'string') return false;
    try { return new URL(o).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase(); } catch { return false; }
  };

  const apiLog = (api, status, started, extra = '') => log(`ui api=${api} status=${status} ms=${now() - started}${extra}`);

  // ---- compare ----
  async function compare(req, res, params, started) {
    const allowed = new Set(['code', 'sites', 'prisjakt']);
    for (const k of params.keys()) if (!allowed.has(k)) return fail(res, 'compare', started, 400, `Unknown parameter: ${k.slice(0, 20)}`);
    const sitesRaw = params.get('sites');
    const pj = params.get('prisjakt');
    if (pj !== null && pj !== '1' && pj !== '0') return fail(res, 'compare', started, 400, 'prisjakt must be 0 or 1');
    const v = validateCompare({
      ean: params.get('code') ?? undefined,
      ...(sitesRaw ? { sites: sitesRaw.split(',') } : {}),
      mode: 'normal',
      prisjakt: pj === '1',
    });
    if (v.error) return fail(res, 'compare', started, 400, v.error);
    const { ean, sites, prisjakt } = v.value;
    const key = `compare:${ean}:${sites.join(',')}:${prisjakt ? 1 : 0}`;
    const cached = cacheGet(key);
    if (!cached && !acquire()) return fail(res, 'compare', started, 429, 'Too many requests in progress');
    res.writeHead(200, { ...SEC_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.flushHeaders?.();
    const out = (o) => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
    if (cached) {
      for (const l of cached) out(l);
      out({ done: true });
      res.end();
      return apiLog('compare', 200, started, ` shops_ok=${cached.filter((l) => l.status === 'ok').length} cache=1`);
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const run = createRetailRunner((name, args, extra) => upstream.call(extra.slot, name, args, { signal: ac.signal }), () => {});
    const lines = [];
    const emit = (o) => { lines.push(o); out(o); };
    try {
      const jobs = sites.map(async (site) => {
        const r = await run(compareParams({ ean, sites: [site], mode: 'normal', prisjakt: false }), { slot: UI_SLOT }).catch(() => ({ error: 1 }));
        emit(r.error ? { site, status: 'error' } : siteResult(site, r.raw.sites[site]));
      });
      if (prisjakt) {
        jobs.push((async () => {
          const r = await run(compareParams({ ean, sites: [], mode: 'normal', prisjakt: true }), { slot: UI_SLOT }).catch(() => ({ error: 1 }));
          emit({ prisjakt: r.error ? null : prisjaktResult(r.raw.prisjakt) });
        })());
      }
      await Promise.all(jobs);
    } finally {
      active--;
    }
    out({ done: true });
    res.end();
    const final = lines.filter((l) => l.site);
    if (!ac.signal.aborted && lines.every((l) => l.status === 'ok' || l.status === 'not_found' || l.prisjakt !== undefined)) cachePut(key, lines);
    apiLog('compare', 200, started, ` shops_ok=${final.filter((l) => l.status === 'ok').length}`);
  }

  // ---- lookup ----
  async function lookup(req, res, params, started) {
    const allowed = new Set(['site', 'id', 'url', 'query', 'ean', 'mode']);
    for (const k of params.keys()) if (!allowed.has(k)) return fail(res, 'lookup', started, 400, `Unknown parameter: ${k.slice(0, 20)}`);
    const args = {};
    for (const k of allowed) if (params.has(k)) args[k] = params.get(k);
    if (args.mode === undefined) args.mode = 'normal';
    else if (args.mode !== 'normal' && args.mode !== 'full') return fail(res, 'lookup', started, 400, 'mode must be normal or full');
    const v = validateLookup(args);
    if (v.error) return fail(res, 'lookup', started, 400, v.error);
    const { site, kind, value, mode } = v.value;
    const key = `lookup:${site}:${kind}:${kind === 'query' ? value.toLowerCase().replace(/\s+/g, ' ') : value}:${mode}`;
    const cached = cacheGet(key);
    if (cached) { sendJson(res, 200, cached); return apiLog('lookup', 200, started, ' cache=1'); }
    if (!acquire()) return fail(res, 'lookup', started, 429, 'Too many requests in progress');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let body;
    try {
      const run = createRetailRunner((name, a, extra) => upstream.call(extra.slot, name, a, { signal: ac.signal }), () => {});
      const r = await run(lookupParams(v.value), { slot: UI_SLOT });
      body = r.error ? { status: 'error' } : lookupResult(site, r.raw);
    } finally {
      active--;
    }
    if (body.product || body.candidates) cachePut(key, body);
    sendJson(res, 200, body);
    apiLog('lookup', 200, started);
  }

  function acquire() {
    if (active >= MAX_CONCURRENT) return false;
    active++;
    return true;
  }
  function fail(res, api, started, status, message) {
    sendJson(res, status, { error: message });
    apiLog(api, status, started);
  }

  const owns = (pathname) => ui.enabled && (pathname === '/' || pathname.startsWith('/ui/'));

  async function handle(req, res, url) {
    const started = now();
    if (verifier) {
      const token = req.headers['cf-access-jwt-assertion'];
      if (!(await verifier.verify(typeof token === 'string' ? token : ''))) return plain(res, 403, 'forbidden');
    }
    if (req.method !== 'GET') return plain(res, 405, 'method not allowed');
    const p = url.pathname;
    const st = STATIC[p];
    if (st) {
      const body = loadFile(st[0]);
      if (!body) return plain(res, 404, 'not found');
      return send(res, 200, body, st[1], { 'cache-control': 'no-cache' });
    }
    if (p !== '/ui/api/compare' && p !== '/ui/api/lookup') return plain(res, 404, 'not found');
    const api = p === '/ui/api/compare' ? 'compare' : 'lookup';
    if (!sameOrigin(req)) return plain(res, 403, 'forbidden');
    const t = now();
    while (hits.length && t - hits[0] >= 60000) hits.shift();
    if (hits.length >= MAX_PER_MINUTE) return fail(res, api, started, 429, 'Rate limit reached, try again shortly');
    hits.push(t);
    try {
      return await (api === 'compare' ? compare : lookup)(req, res, url.searchParams, started);
    } catch (e) {
      log(`ui api=${api} error=${String(e && e.message).slice(0, 80)}`);
      if (!res.headersSent) return fail(res, api, started, 500, 'internal error');
      res.end();
    }
  }

  return { owns, handle };
}
