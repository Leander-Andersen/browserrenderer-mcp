// Price compare page. All shop data is untrusted: it is only ever put into the page with
// textContent / createElement, never as HTML.
(() => {
  'use strict';

  const SHOPS = [
    { id: 'elkjop', name: 'Elkjøp', host: ['elkjop.no', 'www.elkjop.no'] },
    { id: 'komplett', name: 'Komplett', host: ['komplett.no', 'www.komplett.no'] },
    { id: 'proshop', name: 'Proshop', host: ['proshop.no', 'www.proshop.no'] },
    { id: 'power', name: 'Power', host: ['power.no', 'www.power.no'] },
  ];
  const SHOP_NAME = Object.fromEntries(SHOPS.map((s) => [s.id, s.name]));
  const CTYPES = ['auto', 'ean13', 'upca', 'gtin14'];
  const CTYPE_LABEL = { auto: 'Auto', ean13: 'EAN-13', upca: 'UPC-A', gtin14: 'GTIN-14' };
  const STATUS_TEXT = { not_found: 'Not found', blocked: 'Blocked by the shop', timeout: 'Timed out', error: 'Error' };
  const RECENT_MAX = 10;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---- storage (may be unavailable) ----
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const loadRecent = () => {
    try {
      const a = JSON.parse(store.get('recent') || '[]');
      return Array.isArray(a) ? a.filter((s) => typeof s === 'string').slice(0, RECENT_MAX) : [];
    } catch { return []; }
  };

  // ---- codes ----
  function gs1Valid(d) {
    let sum = 0;
    for (let i = d.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(d[d.length - 1]);
  }
  const isCode = (d) => /^\d+$/.test(d) && [8, 12, 13, 14].includes(d.length) && gs1Valid(d);

  // How a code is shown and copied: { text, label, note }.
  function formatCode(digits, type) {
    const g14 = digits.padStart(14, '0');
    const ean13 = g14[0] === '0' ? g14.slice(1) : null;
    if (type === 'gtin14') return { text: g14, label: 'GTIN-14', note: '' };
    if (type === 'ean13') {
      return ean13 ? { text: ean13, label: 'EAN-13', note: '' } : { text: g14, label: 'GTIN-14', note: 'Does not fit EAN-13, shown as GTIN-14.' };
    }
    if (type === 'upca') {
      if (ean13 && ean13[0] === '0') return { text: ean13.slice(1), label: 'UPC-A', note: '' };
      return ean13 ? { text: ean13, label: 'EAN-13', note: 'Does not fit UPC-A, shown as EAN-13.' } : { text: g14, label: 'GTIN-14', note: 'Does not fit UPC-A, shown as GTIN-14.' };
    }
    const label = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' }[digits.length] || 'Code';
    return { text: digits, label, note: '' };
  }

  function expandUpcE(d) {
    const n = d[0]; const s = d.slice(1, 7); const chk = d[7]; const last = s[5];
    let body;
    if ('012'.includes(last)) body = `${s[0]}${s[1]}${last}0000${s[2]}${s[3]}${s[4]}`;
    else if (last === '3') body = `${s[0]}${s[1]}${s[2]}00000${s[3]}${s[4]}`;
    else if (last === '4') body = `${s[0]}${s[1]}${s[2]}${s[3]}00000${s[4]}`;
    else body = `${s.slice(0, 5)}0000${last}`;
    return `${n}${body}${chk}`;
  }

  // What the user typed -> { kind: code|article|url|text|error, ... }
  function detect(raw) {
    const t = raw.trim();
    if (!t) return { kind: 'empty' };
    if (/^https?:\/\//i.test(t)) {
      let u;
      try { u = new URL(t); } catch { return { kind: 'error', message: 'That is not a valid URL.' }; }
      const shop = SHOPS.find((s) => s.host.includes(u.hostname.toLowerCase()));
      if (!shop || u.protocol !== 'https:') return { kind: 'error', message: 'Only https links to Elkjøp, Komplett, Proshop or Power are supported.' };
      return { kind: 'url', site: shop.id, url: t };
    }
    const digits = t.replace(/[ -]/g, '');
    if (/^\d+$/.test(digits)) {
      if (isCode(digits)) return { kind: 'code', digits };
      if (/^\d{4,10}$/.test(digits)) return { kind: 'article', id: digits };
      if ([12, 13, 14].includes(digits.length)) return { kind: 'error', message: 'Not a valid product code: the check digit does not match. Check for a typo.' };
    }
    return { kind: 'text', query: t };
  }

  // ---- formatting ----
  function money(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '';
    const fixed = Math.abs(n).toFixed(Number.isInteger(n) ? 0 : 2);
    const [i, f] = fixed.split('.');
    return `${n < 0 ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${f ? `,${f}` : ''} kr`;
  }
  const safeUrl = (u) => {
    if (typeof u !== 'string') return '';
    try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; }
  };

  // ---- state ----
  const S = {
    shop: store.get('shop') && SHOP_NAME[store.get('shop')] ? store.get('shop') : 'elkjop',
    ctype: CTYPES.includes(store.get('ctype')) ? store.get('ctype') : 'auto',
    pj: store.get('pj') === '1',
    recent: loadRecent(),
    digits: '', // canonical code of the current results
    rows: new Map(), // site -> { li, result }
    pjRow: null,
    done: false,
    ctl: null,
    histIdx: -1,
    list: null, // the list element keyboard navigation currently uses
    cur: -1,
    candSite: 'elkjop',
  };

  const q = $('q'); const shopSel = $('shop'); const ctypeSel = $('ctype'); const pjBox = $('pj');
  shopSel.value = S.shop; ctypeSel.value = S.ctype; pjBox.checked = S.pj;

  // ---- announcements ----
  let liveTimer = 0;
  function say(text) {
    const live = $('live');
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 30);
  }
  function note(text, bad) {
    const n = $('note');
    n.hidden = !text;
    n.textContent = text || '';
    n.className = bad ? 'note bad' : 'note';
    if (text) say(text);
  }

  // ---- recent searches ----
  function renderRecent() {
    const ul = $('recent-list');
    ul.replaceChildren();
    for (const s of S.recent) {
      const li = el('li');
      const b = el('button', '', s);
      b.type = 'button';
      b.title = s;
      b.addEventListener('click', () => { q.value = s; search(); });
      li.append(b);
      ul.append(li);
    }
    $('recent').hidden = S.recent.length === 0 || !$('results').hidden || !$('cands').hidden;
  }
  function remember(text) {
    S.recent = [text, ...S.recent.filter((s) => s !== text)].slice(0, RECENT_MAX);
    store.set('recent', JSON.stringify(S.recent));
  }

  // ---- list navigation (roving tabindex) ----
  const items = () => (S.list ? [...S.list.children] : []);
  function setCur(i, focus) {
    const its = items();
    if (!its.length) return;
    S.cur = Math.max(0, Math.min(its.length - 1, i));
    its.forEach((li, k) => { li.tabIndex = k === S.cur ? 0 : -1; if (k === S.cur) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current'); });
    if (focus) its[S.cur].focus();
  }
  function useList(ul, focus) {
    S.list = ul;
    setCur(0, focus);
  }
  const curItem = () => items()[S.cur] || null;

  // ---- views ----
  function resetView() {
    if (S.ctl) S.ctl.abort();
    S.ctl = null; S.rows.clear(); S.pjRow = null; S.done = false; S.list = null; S.cur = -1; S.digits = '';
    $('results').hidden = true; $('cands').hidden = true;
    $('rows').replaceChildren(); $('cands-list').replaceChildren();
    note('');
    renderRecent();
  }

  function skeletonRow(site) {
    const li = el('li');
    li.dataset.site = site;
    li.tabIndex = -1;
    const row = el('div', 'row');
    row.append(el('span', 'shop', SHOP_NAME[site] || 'Prisjakt'));
    const p = el('span', 'price'); p.append(el('span', 'skel'));
    const st = el('span', 'stock'); st.append(el('span', 'skel s'));
    row.append(p, st);
    li.append(row);
    li.setAttribute('aria-label', `${SHOP_NAME[site] || 'Prisjakt'}: waiting`);
    li.setAttribute('aria-busy', 'true');
    return li;
  }

  function stockInfo(p) {
    const t = typeof p.stock === 'string' ? p.stock : '';
    const low = /\b(low|few|limited|begrenset|få)\b/i.test(t);
    if (p.inStock === true) return { cls: low ? '' : 'in', text: t || 'In stock', say: low ? 'low stock' : 'in stock' };
    if (p.inStock === false) return { cls: 'out', text: t || 'Out of stock', say: 'out of stock' };
    return { cls: '', text: t || 'Stock unknown', say: 'stock unknown' };
  }

  function fillRow(li, site, r) {
    li.removeAttribute('aria-busy');
    li.dataset.state = r.status;
    const row = el('div', 'row');
    const shop = el('span', 'shop', SHOP_NAME[site]);
    row.append(shop);
    let label = `${SHOP_NAME[site]}: `;
    if (r.status === 'ok' && r.product) {
      const p = r.product;
      const price = el('span', 'price');
      if (typeof p.price === 'number') {
        price.append(el('span', 'now', money(p.price)));
        if (typeof p.before === 'number' && p.before > p.price) {
          price.append(el('span', 'was', money(p.before)));
          const pct = Math.round((1 - p.price / p.before) * 100);
          if (pct > 0) price.append(el('span', 'pct', `-${pct}%`));
        }
        label += money(p.price);
      } else {
        price.append(el('span', 'missing', 'No price'));
        label += 'no price';
      }
      row.append(price);
      const si = stockInfo(p);
      const st = el('span', 'stock');
      const dot = el('span', `dot ${si.cls}`); dot.setAttribute('aria-hidden', 'true');
      st.append(dot, el('span', '', si.text));
      row.append(st);
      const href = safeUrl(p.url);
      if (href) {
        const a = el('a', 'open', 'Open');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.tabIndex = -1;
        a.setAttribute('aria-label', `Open ${SHOP_NAME[site]} page`);
        row.append(a);
      }
      label += `, ${si.say}`;
      li.dataset.url = href;
      li.dataset.price = typeof p.price === 'number' ? String(p.price) : '';
    } else {
      const price = el('span', 'price'); price.append(el('span', 'missing', STATUS_TEXT[r.status] || 'Error'));
      row.append(price);
      label += (STATUS_TEXT[r.status] || 'Error').toLowerCase();
      li.dataset.url = ''; li.dataset.price = '';
    }
    li.replaceChildren(row);
    li.setAttribute('aria-label', label);
    say(label);
  }

  function fillPrisjakt(li, r) {
    li.removeAttribute('aria-busy');
    const row = el('div', 'row');
    row.append(el('span', 'shop', 'Prisjakt'));
    const price = el('span', 'price');
    let label = 'Prisjakt: ';
    li.dataset.url = ''; li.dataset.price = '';
    if (r && typeof r.low === 'number') {
      price.append(el('span', 'now', money(r.low)));
      li.dataset.price = String(r.low);
      const st = el('span', 'stock', `Lowest price${typeof r.shops === 'number' ? `, ${r.shops} shops` : ''}`);
      row.append(price, st);
      const href = safeUrl(r.url);
      if (href) {
        const a = el('a', 'open', 'Open');
        a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.tabIndex = -1;
        a.setAttribute('aria-label', 'Open Prisjakt page');
        row.append(a);
        li.dataset.url = href;
      }
      label += `lowest ${money(r.low)}`;
    } else {
      price.append(el('span', 'missing', 'Not found'));
      row.append(price);
      label += 'not found';
    }
    li.replaceChildren(row);
    li.setAttribute('aria-label', label);
    say(label);
  }

  // Header: most common name and model across answered shops; code in the chosen format.
  const common = (xs) => {
    const c = new Map();
    for (const x of xs) if (x) c.set(x, (c.get(x) || 0) + 1);
    let best = ''; let n = 0;
    for (const [k, v] of c) if (v > n) { best = k; n = v; }
    return best;
  };
  function renderHeader() {
    const ok = [...S.rows.values()].filter((r) => r.result && r.result.status === 'ok' && r.result.product).map((r) => r.result.product);
    const name = common(ok.map((p) => p.name));
    $('prod-name').textContent = name || (S.done ? 'No shop returned this product' : 'Looking up');
    const meta = $('prod-meta');
    meta.replaceChildren();
    const mpn = common(ok.map((p) => p.mpn));
    if (mpn) { meta.append(document.createTextNode('Model ')); meta.append(el('span', 'code', mpn)); meta.append(document.createTextNode('   ')); }
    if (S.digits) {
      const f = formatCode(S.digits, S.ctype);
      meta.append(document.createTextNode(`${f.label} `));
      meta.append(el('span', 'code', f.text));
      $('prod-foot').textContent = f.note;
    }
  }

  function markBest() {
    for (const { li } of S.rows.values()) li.classList.remove('best');
    for (const li of document.querySelectorAll('#rows .tag')) li.remove();
    const priced = [...S.rows.values()].filter((r) => r.result && r.result.status === 'ok' && r.result.product && typeof r.result.product.price === 'number');
    const inStock = priced.filter((r) => r.result.product.inStock === true);
    const pool = inStock.length ? inStock : priced.filter((r) => r.result.product.inStock !== false);
    if (!pool.length) return;
    const min = Math.min(...pool.map((r) => r.result.product.price));
    for (const r of pool.filter((x) => x.result.product.price === min)) {
      r.li.classList.add('best');
      const shop = r.li.querySelector('.shop');
      if (shop) shop.append(el('span', 'tag', 'Cheapest'));
      r.li.setAttribute('aria-label', `${r.li.getAttribute('aria-label')}, cheapest in stock`);
    }
  }

  // ---- network ----
  async function api(path, params, signal) {
    const url = `${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (res.status === 429) throw new Error('Too many searches at once. Wait a moment and try again.');
    if (res.status === 403) throw new Error('Your session has expired. Reload the page to sign in again.');
    return res;
  }
  async function lookup(params, signal) {
    const res = await api('/ui/api/lookup', params, signal);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The lookup failed.');
    return body;
  }

  async function compare(digits, ctl) {
    S.digits = digits;
    S.rows = new Map(); S.pjRow = null; S.done = false;
    const ul = $('rows');
    ul.replaceChildren();
    for (const s of SHOPS) {
      const li = skeletonRow(s.id);
      S.rows.set(s.id, { li, result: null });
      ul.append(li);
    }
    if (S.pj) { S.pjRow = { li: skeletonRow('prisjakt'), result: null }; ul.append(S.pjRow.li); }
    $('cands').hidden = true; $('results').hidden = false; $('recent').hidden = true;
    $('prod-foot').textContent = '';
    renderHeader();
    useList(ul, true);
    say('Comparing shops');

    const params = { code: digits };
    if (S.pj) params.prisjakt = '1';
    const res = await api('/ui/api/compare', params, ctl.signal);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.error === 'string' ? body.error : 'The comparison failed.');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (line) => {
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.site && S.rows.has(o.site)) {
        const r = S.rows.get(o.site);
        r.result = o;
        fillRow(r.li, o.site, o);
        renderHeader();
      } else if ('prisjakt' in o && S.pjRow) {
        S.pjRow.result = o.prisjakt;
        fillPrisjakt(S.pjRow.li, o.prisjakt);
      } else if (o.done) {
        S.done = true;
        for (const [site, r] of S.rows) if (!r.result) { r.result = { site, status: 'error' }; fillRow(r.li, site, r.result); }
        if (S.pjRow && !S.pjRow.result) fillPrisjakt(S.pjRow.li, null);
        markBest();
        renderHeader();
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) handle(buf);
    if (!S.done) {
      S.done = true;
      for (const [site, r] of S.rows) if (!r.result) { r.result = { site, status: 'error' }; fillRow(r.li, site, r.result); }
      markBest();
    }
    const best = [...S.rows.values()].some((r) => r.result && r.result.status === 'ok');
    if (!best) note('No shop returned this product.', true);
  }

  function showCandidates(site, cands) {
    S.candSite = site;
    const ul = $('cands-list');
    ul.replaceChildren();
    for (const c of cands) {
      const li = el('li');
      li.tabIndex = -1;
      const row = el('div', 'cand');
      row.append(el('span', 'name', c.name || c.id));
      row.append(el('span', 'id', `${SHOP_NAME[site]} article no. ${c.id}`));
      const price = el('span', 'price');
      price.append(el('span', 'now', money(c.price)));
      if (typeof c.before === 'number' && c.before > c.price) price.append(el('span', 'was', money(c.before)));
      row.append(price);
      li.append(row);
      li.setAttribute('aria-label', `${c.name}, ${money(c.price)}`);
      li.dataset.id = c.id;
      li.addEventListener('click', () => chooseCandidate(site, c.id));
      ul.append(li);
    }
    $('results').hidden = true; $('recent').hidden = true; $('cands').hidden = false;
    useList(ul, true);
    say(`${cands.length} matches. Use the arrow keys and Enter to choose.`);
  }

  async function chooseCandidate(site, id) {
    resetView();
    const ctl = new AbortController(); S.ctl = ctl;
    await runSafe(async () => {
      note('Looking up the product...');
      const r = await lookup({ site, id }, ctl.signal);
      note('');
      await fromProduct(r, ctl);
    }, ctl);
  }

  async function fromProduct(r, ctl) {
    if (r.product && r.product.ean) {
      const d = r.product.ean.replace(/\D/g, '');
      if (isCode(d)) return compare(d, ctl);
      note('The shop page has no usable product code.', true);
      return undefined;
    }
    if (r.product) { note('The shop page has no product code, so the other shops cannot be searched.', true); return undefined; }
    note('Nothing found.', true);
    return undefined;
  }

  async function runSafe(fn, ctl) {
    try { await fn(); } catch (e) {
      if (ctl.signal.aborted) return;
      note(e && e.message ? e.message : 'Something went wrong.', true);
    }
  }

  // ---- search ----
  async function search() {
    const text = q.value;
    const d = detect(text);
    S.histIdx = -1;
    if (d.kind === 'empty') { q.focus(); return; }
    resetView();
    if (d.kind === 'error') { note(d.message, true); q.focus(); return; }
    remember(text.trim());
    const ctl = new AbortController(); S.ctl = ctl;
    q.blur();
    await runSafe(async () => {
      if (d.kind === 'code') return compare(d.digits, ctl);
      note(d.kind === 'text' ? `Searching ${SHOP_NAME[S.shop]}...` : 'Looking up the product...');
      let r;
      if (d.kind === 'article') r = await lookup({ site: S.shop, id: d.id }, ctl.signal);
      else if (d.kind === 'url') r = await lookup({ site: d.site, url: d.url }, ctl.signal);
      else r = await lookup({ site: S.shop, query: d.query }, ctl.signal);
      note('');
      if (r.candidates) return showCandidates(d.kind === 'url' ? d.site : S.shop, r.candidates);
      if (r.product) return fromProduct(r, ctl);
      const why = { blocked: 'The shop blocked the request.', timeout: 'The shop did not answer in time.', error: 'The lookup failed.' }[r.status] || 'Nothing found.';
      note(why, true);
      q.focus();
      return undefined;
    }, ctl);
    if (!S.list && !$('note').hidden) q.focus();
  }

  // ---- clipboard ----
  async function copy(text, what) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try {
        const t = el('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.append(t); t.select(); ok = document.execCommand('copy'); t.remove();
      } catch { ok = false; }
    }
    say(ok ? `Copied ${what}` : `Could not copy ${what}`);
    const foot = $('prod-foot');
    if (!$('results').hidden) foot.textContent = ok ? `Copied ${what}` : `Could not copy ${what}`;
  }

  // ---- camera ----
  let stream = null; let scanTimer = 0;
  function stopScan() {
    clearTimeout(scanTimer);
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    const v = $('video'); v.srcObject = null;
    $('scan').hidden = true;
  }
  async function startScan() {
    if (stream) return;
    try {
      const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
      const supported = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : want;
      const formats = want.filter((f) => supported.includes(f));
      const det = new BarcodeDetector({ formats });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = $('video');
      v.srcObject = stream;
      $('scan').hidden = false;
      await v.play();
      const tick = async () => {
        if (!stream) return;
        try {
          const found = await det.detect(v);
          if (found.length) {
            let val = String(found[0].rawValue || '');
            if (found[0].format === 'upc_e' && /^\d{8}$/.test(val)) val = expandUpcE(val);
            stopScan();
            q.value = val;
            search();
            return;
          }
        } catch { /* try again */ }
        scanTimer = setTimeout(tick, 200);
      };
      tick();
    } catch {
      stopScan();
      note('Could not open the camera.', true);
    }
  }

  // ---- help overlay ----
  let helpFrom = null;
  function toggleHelp(open) {
    const h = $('help');
    const want = open === undefined ? h.hidden : open;
    if (want) { helpFrom = document.activeElement; h.hidden = false; $('help-close').focus(); }
    else { h.hidden = true; if (helpFrom && helpFrom.focus) helpFrom.focus(); helpFrom = null; }
  }

  // ---- settings ----
  function setShop(id) {
    S.shop = id; shopSel.value = id; store.set('shop', id);
    say(`Searching in ${SHOP_NAME[id]}`);
  }
  function setCtype(t) {
    S.ctype = t; ctypeSel.value = t; store.set('ctype', t);
    say(`Code type ${CTYPE_LABEL[t]}`);
    if (S.digits) renderHeader();
  }
  function setPj(on) {
    S.pj = on; pjBox.checked = on; store.set('pj', on ? '1' : '0');
    say(`Prisjakt ${on ? 'on' : 'off'}`);
  }

  // ---- events ----
  $('search').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  shopSel.addEventListener('change', () => setShop(shopSel.value));
  ctypeSel.addEventListener('change', () => setCtype(ctypeSel.value));
  pjBox.addEventListener('change', () => setPj(pjBox.checked));
  $('help-btn').addEventListener('click', () => toggleHelp(true));
  $('help-close').addEventListener('click', () => toggleHelp(false));
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(false); });
  $('recent-clear').addEventListener('click', () => { S.recent = []; store.set('recent', '[]'); renderRecent(); q.focus(); });
  $('scan-stop').addEventListener('click', () => { stopScan(); q.focus(); });
  $('rows').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (li) setCur([...$('rows').children].indexOf(li), false);
  });
  $('rows').addEventListener('focusin', (e) => {
    const li = e.target.closest && e.target.closest('#rows > li');
    if (li) setCur([...$('rows').children].indexOf(li), false);
  });
  q.addEventListener('input', () => { S.histIdx = -1; });

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const inCheckbox = (t) => t && t.tagName === 'INPUT' && t.type === 'checkbox';

  function focusBox(select) { q.focus(); if (select) q.select(); }

  function activate() {
    const li = curItem();
    if (!li) return;
    if (S.list === $('cands-list')) { chooseCandidate(S.candSite, li.dataset.id); return; }
    if (li.dataset.url) window.open(li.dataset.url, '_blank', 'noopener,noreferrer');
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const help = !$('help').hidden;

    if (e.key === 'Escape') {
      if (help) { e.preventDefault(); toggleHelp(false); return; }
      if (stream) { e.preventDefault(); stopScan(); q.focus(); return; }
      if (t === q) {
        e.preventDefault();
        if (q.value) { q.value = ''; S.histIdx = -1; } else if (!$('results').hidden || !$('cands').hidden || !$('note').hidden) resetView();
        return;
      }
      if (!isTyping(t) || t.tagName === 'SELECT') { e.preventDefault(); focusBox(true); return; }
      return;
    }
    if (help) {
      if (e.key === 'Tab') { e.preventDefault(); $('help-close').focus(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); focusBox(true); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const m = /^Digit([1-4])$/.exec(e.code);
      if (m) { e.preventDefault(); setShop(SHOPS[Number(m[1]) - 1].id); return; }
      if (e.code === 'KeyT') { e.preventDefault(); setCtype(CTYPES[(CTYPES.indexOf(S.ctype) + 1) % CTYPES.length]); return; }
      if (e.code === 'KeyP') { e.preventDefault(); setPj(!S.pj); return; }
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (t === q) {
      if (e.key === 'ArrowUp' && (q.value === '' || S.histIdx >= 0)) {
        if (!S.recent.length) return;
        e.preventDefault();
        S.histIdx = Math.min(S.recent.length - 1, S.histIdx + 1);
        q.value = S.recent[S.histIdx];
        return;
      }
      if (e.key === 'ArrowDown') {
        if (S.histIdx >= 0) {
          e.preventDefault();
          S.histIdx -= 1;
          q.value = S.histIdx >= 0 ? S.recent[S.histIdx] : '';
          return;
        }
        if (S.list && items().length) { e.preventDefault(); setCur(S.cur < 0 ? 0 : S.cur, true); }
      }
      return;
    }
    if (isTyping(t) && !inCheckbox(t)) return;
    if (t && t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;

    switch (e.key) {
      case '/': e.preventDefault(); focusBox(true); break;
      case '?': e.preventDefault(); toggleHelp(true); break;
      case 'ArrowDown': case 'j': if (S.list) { e.preventDefault(); setCur(S.cur + 1, true); } break;
      case 'ArrowUp': case 'k': if (S.list) { e.preventDefault(); if (S.cur <= 0 && e.key === 'ArrowUp') focusBox(true); else setCur(S.cur - 1, true); } break;
      case 'Enter': case 'o': if (S.list && (t === document.body || (t.parentElement && t.parentElement === S.list) || t.closest && t.closest('#rows, #cands-list'))) { e.preventDefault(); activate(); } break;
      case 'c': { const li = curItem(); if (li && li.dataset.price) { e.preventDefault(); copy(li.dataset.price, `price ${li.dataset.price}`); } break; }
      case 'e': if (S.digits) { e.preventDefault(); const f = formatCode(S.digits, S.ctype); copy(f.text, `${f.label} ${f.text}`); } break;
      default:
    }
  });

  // ---- start ----
  if ('BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    const check = BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : Promise.resolve(want);
    check.then((sup) => { if (want.some((f) => sup.includes(f))) $('cam').hidden = false; }).catch(() => {});
    $('cam').addEventListener('click', startScan);
  }
  renderRecent();
  q.focus();
})();
