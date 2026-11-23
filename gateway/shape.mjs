// Pure result/schema shaping helpers (no I/O). Used by browser.mjs and server.mjs.

export const FIND_SEP = '\n\n----\n\n';
export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem',
]);
export const MAX_CHARS_LIMIT = 200000;
export const OUTLINE_HINT =
  'Read with browser_page_text; locate elements/refs with browser_find; list controls with mode="interactive"; ' +
  'expand a subtree with target=<ref>; whole tree with mode="full".';

const indentOf = (l) => l.length - l.trimStart().length;
const LINE_RE = /^(\s*)- ([A-Za-z]+)\b(.*)$/;

// ---- generic text helpers ----

export function cutText(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

// Cut one text to `max` chars (generic gateway cap). Returns the text unchanged when short enough.
export function capText(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated by gateway: ${max} of ${text.length} chars; narrow the request]`;
}

// Apply the generic cap to every text part of a tool result (returns a new result when changed).
export function capResult(result, max) {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((p) => {
    if (p && p.type === 'text' && typeof p.text === 'string' && p.text.length > max) {
      changed = true;
      return { ...p, text: capText(p.text, max) };
    }
    return p;
  });
  return changed ? { ...result, content } : result;
}

export function resultText(result) {
  return (result?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
}

export const textResult = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });
export const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text }] });

// Replace the text parts of a result by a single text part (keeps non-text parts).
export function withText(result, text) {
  const rest = (result.content ?? []).filter((p) => p?.type !== 'text');
  return { ...result, content: [{ type: 'text', text }, ...rest] };
}

// ---- snapshot ----

// Split "### Page ... ### Snapshot\n```yaml\n<body>\n```<rest>" into parts, or null.
export function splitSnapshot(text) {
  const open = text.match(/```yaml\n/);
  if (!open) return null;
  const start = open.index + open[0].length;
  const rest = text.slice(start);
  const close = rest.match(/\n```(?:\n|$)/);
  const yaml = close ? rest.slice(0, close.index) : rest;
  const after = close ? rest.slice(close.index + close[0].length) : '';
  return { head: text.slice(0, open.index), yaml, after: after.replace(/^\n+/, '') };
}

// The part of `head` before the "### Snapshot" heading (the "### Page" section etc).
function pageSection(head) {
  const i = head.search(/^### Snapshot\s*$/m);
  return (i >= 0 ? head.slice(0, i) : head).trim();
}

// Cut `body` to at most `max` chars at a line boundary. Always keeps at least one line.
export function truncateLines(body, max) {
  const lines = body.split('\n');
  if (body.length <= max) return { text: body, truncated: false, shownChars: body.length, totalChars: body.length, shownLines: lines.length, totalLines: lines.length };
  let used = 0;
  let n = 0;
  for (const l of lines) {
    const add = l.length + (n ? 1 : 0);
    if (n > 0 && used + add > max) break;
    used += add;
    n++;
  }
  const text = lines.slice(0, n).join('\n').slice(0, Math.max(max, 1));
  return { text, truncated: true, shownChars: text.length, totalChars: body.length, shownLines: n, totalLines: lines.length };
}

export const truncNote = (t) =>
  `[truncated: showing ${t.shownChars} of ${t.totalChars} chars, ${t.shownLines} of ${t.totalLines} lines. ` +
  'Use browser_find, target=<ref>, depth, or a larger max_chars.]';

function assemble(head, body, note, after) {
  let out = `${head}\`\`\`yaml\n${body}\n\`\`\``;
  if (note) out += `\n${note}`;
  if (after) out += `\n${after}`;
  return out;
}

function cleanLine(line) {
  return line.replace(/ \[cursor=pointer\]/g, '').replace(/:\s*$/, '');
}

const BOX_RE = / \[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/;
export const COLLAPSE_AT = 4;
export const COLLAPSE_NOTE = '[repeated items collapsed into one line each with all their refs; use name="..." or browser_find for details]';
export const MAX_COLLAPSED_REFS = 60;

// True when the line's [box=x,y,w,h] (viewport-relative CSS px) has area and intersects {width, height}.
export function boxInViewport(line, vp) {
  const m = line.match(BOX_RE);
  if (!m) return false;
  const [x, y, w, h] = m.slice(1).map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return false;
  return x < vp.width && x + w > 0 && y < vp.height && y + h > 0;
}

// Flat list of interactive lines (+ headings for context). Optional filters in `opts`:
// roles (array, replaces the built-in role set), name (case-insensitive substring), viewport ({width, height},
// needs [box=...] in the yaml), stripBoxes. Without a name filter, 4+ repeats of one role+name (and, with urls,
// the same URL) collapse to one line listing all their refs (first 60).
export function interactiveLines(yaml, urls = false, opts = {}) {
  const { roles, name, viewport, stripBoxes = false } = opts;
  const roleSet = Array.isArray(roles) ? new Set(roles) : null;
  const needle = name ? name.toLowerCase() : null;
  const lines = yaml.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const role = m[2];
    if (roleSet ? !roleSet.has(role) : !INTERACTIVE_ROLES.has(role) && role !== 'heading') continue;
    if (viewport && !boxInViewport(lines[i], viewport)) continue;
    let l = cleanLine(lines[i].trim()).replace(/^- /, '');
    if (stripBoxes) l = l.replace(BOX_RE, '');
    if (needle && !l.toLowerCase().includes(needle)) continue;
    let key = l.match(/^[A-Za-z]+(?: "(?:[^"\\]|\\.)*")?/)?.[0] ?? role;
    const ref = l.match(/\[ref=([^\]]+)\]/)?.[1];
    let text = l;
    if (urls && role === 'link') {
      const next = lines[i + 1]?.match(/^\s*- \/url: (.*)$/);
      if (next) { text += ` -> ${next[1].trim()}`; key += ` -> ${next[1].trim()}`; }
    }
    entries.push({ key, ref, text });
  }
  if (needle) return entries.map((e) => e.text);
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.key);
    if (g) g.push(e); else groups.set(e.key, [e]);
  }
  const out = [];
  const done = new Set();
  let collapsed = false;
  for (const e of entries) {
    const g = groups.get(e.key);
    if (g.length < COLLAPSE_AT) { out.push(e.text); continue; }
    if (done.has(e.key)) continue;
    done.add(e.key);
    collapsed = true;
    const all = g.map((x) => x.ref).filter(Boolean);
    const refs = all.slice(0, MAX_COLLAPSED_REFS);
    out.push(`${e.key} x${g.length}${refs.length ? ` [refs ${refs.join(', ')}${all.length > refs.length ? ', ...' : ''}]` : ''}`);
  }
  if (collapsed) out.push(COLLAPSE_NOTE);
  return out;
}

export function shapeFull(text, maxChars) {
  const parts = splitSnapshot(text);
  if (!parts) return null;
  const t = truncateLines(parts.yaml, maxChars);
  return assemble(parts.head, t.text, t.truncated ? truncNote(t) : '', parts.after);
}

export function shapeInteractive(text, { urls = false, maxChars, roles, name, viewport, stripBoxes = false }) {
  const parts = splitSnapshot(text);
  if (!parts) return null;
  const filtered = roles !== undefined || name !== undefined || viewport !== undefined;
  const found = interactiveLines(parts.yaml, urls, { roles, name, viewport, stripBoxes });
  const body = found.length || !filtered ? found.join('\n') : '(no matching elements)';
  const t = truncateLines(body, maxChars);
  return assemble(parts.head, t.text, t.truncated ? truncNote(t) : '', parts.after);
}

const TEXT_ROLES = new Set([
  'text', 'paragraph', 'link', 'cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'blockquote', 'caption', 'term', 'definition', 'strong', 'emphasis', 'code',
]);
export const OUTLINE_TEXT_CHARS = 600;

// Visible text of a snapshot yaml in document order (names of text-like nodes, de-duplicated, without items repeated
// 4+ times or list ordinals), joined with " | " and cut at a separator to at most `max` chars.
export function textExcerpt(yaml, max = OUTLINE_TEXT_CHARS) {
  const texts = [];
  const counts = new Map();
  for (const raw of yaml.split('\n')) {
    const m = raw.match(LINE_RE);
    if (!m || !TEXT_ROLES.has(m[2])) continue;
    let t = m[3].match(/^ "((?:[^"\\]|\\.)*)"/)?.[1] ?? m[3].match(/^(?: \[[^\]]*\])*: (.*)$/)?.[1] ?? '';
    t = t.replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1').replace(/\s+/g, ' ').trim();
    // Skip empties, punctuation and list ordinals ("12.").
    if (t.length < 2 || !/[\p{L}\p{N}]/u.test(t) || /^\d+\.$/.test(t)) continue;
    texts.push(t);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const seen = new Set();
  const out = [];
  let len = 0;
  for (const t of texts) {
    // Repeated boilerplate ("upvote", "hide") says nothing about the page.
    if (seen.has(t) || counts.get(t) >= COLLAPSE_AT) continue;
    seen.add(t);
    const add = t.length + (out.length ? 3 : 0);
    if (len + add > max) {
      if (!out.length) out.push(t.slice(0, max));
      break;
    }
    out.push(t);
    len += add;
  }
  return out.join(' | ');
}

const plural = (r) => (/(x|s)$/.test(r) ? `${r}es` : `${r}s`);

export function shapeOutline(text, { maxOutlineChars = 1500 } = {}) {
  const parts = splitSnapshot(text);
  if (!parts) return null;
  const lines = parts.yaml.split('\n');
  const counts = new Map();
  const headings = [];
  const top = [];
  for (const raw of lines) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const indent = m[1].length;
    const role = m[2];
    if (INTERACTIVE_ROLES.has(role)) counts.set(role, (counts.get(role) ?? 0) + 1);
    if (role === 'heading' && headings.length < 25) {
      const title = raw.match(/heading "(.*?)"(?= \[|:|$)/)?.[1] ?? raw.match(/heading "(.*)"/)?.[1] ?? '';
      const level = raw.match(/\[level=(\d+)\]/)?.[1] ?? '?';
      const ref = raw.match(/\[ref=([^\]]+)\]/)?.[1];
      headings.push(`h${level} "${title}"${ref ? ` [ref=${ref}]` : ''}`);
    }
    if (indent <= 4 && top.length < 25) top.push(cleanLine(raw).slice(0, 100));
  }
  const countStr = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${plural(r)} ${n}`).join(', ');
  const sections = [
    `Full snapshot: ${lines.length} lines, ${parts.yaml.length} chars.`,
    `Interactive: ${countStr || 'none'}.`,
    headings.length ? `Headings:\n${headings.join('\n')}` : 'Headings: none.',
  ];
  if (headings.length < 3) {
    const used = sections.join('\n').length + '\nText: '.length;
    const ex = textExcerpt(parts.yaml, Math.min(OUTLINE_TEXT_CHARS, maxOutlineChars - used - 150));
    if (ex) sections.push(`Text: ${ex}`);
  }
  sections.push(
    top.length ? `Top of tree:\n${top.join('\n')}` : '',
  );
  let outline = sections.filter(Boolean).join('\n');
  if (outline.length > maxOutlineChars) {
    const t = truncateLines(outline, maxOutlineChars);
    outline = `${t.text}\n[outline cut]`;
  }
  const page = pageSection(parts.head);
  return `${page}\n### Snapshot (outline)\n${outline}\n${OUTLINE_HINT}${parts.after ? `\n${parts.after}` : ''}`;
}

// ---- find ----

const FIND_HEAD_RE = /^### Result\nFound (\d+) match(?:es)? for ([^\n]*):\n\n/;

// Leading ancestor lines (strictly deeper, each with children) that every block shares, or null.
export function commonPath(blocks) {
  if (blocks.length < 2) return null;
  const lines = blocks.map((b) => b.split('\n'));
  const path = [];
  let prev = -1;
  for (let n = 0; ; n++) {
    const l = lines[0][n];
    if (l === undefined || !/^\s*- .*:$/.test(l) || indentOf(l) <= prev) break;
    if (!lines.every((ls) => ls[n] === l && ls[n + 1] !== undefined && indentOf(ls[n + 1]) > indentOf(l))) break;
    path.push(l);
    prev = indentOf(l);
  }
  if (!path.length) return null;
  return { path: path.map((l) => l.trim().replace(/^- /, '').replace(/:$/, '')).join(' > '), blocks: lines.map((ls) => ls.slice(path.length).join('\n')) };
}

// Cap a stock browser_find (detail) result at maxChars, whole blocks only. Upstream's "Found N matches" counts matching
// lines while one block (snippet) can hold several (their windows merge), so the header and note use the block count.
// A leading ancestor path shared by the shown blocks is printed once.
export function capFind(text, maxChars) {
  const m = text.match(FIND_HEAD_RE);
  if (!m) return capFindPlain(text, maxChars);
  const blocks = text.slice(m[0].length).split(FIND_SEP);
  const lines = Number(m[1]);
  const unit = blocks.length === lines ? 'matches' : 'snippets';
  const head = blocks.length === lines ? m[0] : `### Result\nFound ${lines} matching line${lines === 1 ? '' : 's'} in ${blocks.length} snippet${blocks.length === 1 ? '' : 's'} for ${m[2]}:\n\n`;
  const build = (list, note) => {
    const c = commonPath(list);
    const body = (c ? c.blocks : list).join(FIND_SEP);
    return `${head}${c ? `Common path: ${c.path}\n\n` : ''}${body}${note}`;
  };
  const all = build(blocks, '');
  if (all.length <= maxChars) return all;
  const note = (k) => `\n\n[showing ${k} of ${blocks.length} ${unit}; narrow the search or raise max_chars]`;
  const c = commonPath(blocks);
  const rest = c ? c.blocks : blocks;
  const budget = maxChars - head.length - (c ? `Common path: ${c.path}\n\n`.length : 0);
  let kept = 1;
  let len = rest[0].length;
  while (kept < rest.length && len + FIND_SEP.length + rest[kept].length <= budget) {
    len += FIND_SEP.length + rest[kept].length;
    kept++;
  }
  if (kept === 1 && len > budget) {
    return `${head}${blocks[0].slice(0, Math.max(maxChars - head.length, 1))}\n[showing ${blocks.length === 1 ? 'part of 1 match' : `1 of ${blocks.length} ${unit}`}; narrow the search or raise max_chars]`;
  }
  if (kept === blocks.length) return build(blocks, '');
  return build(blocks.slice(0, kept), note(kept));
}

function capFindPlain(text, maxChars) {
  const blocks = text.split(FIND_SEP);
  if (text.length <= maxChars) return text;
  if (blocks.length === 1) return `${text.slice(0, maxChars)}\n[showing part of 1 match; narrow the search or raise max_chars]`;
  let kept = 1;
  let len = blocks[0].length;
  if (len > maxChars) {
    return `${blocks[0].slice(0, maxChars)}\n[showing 1 of ${blocks.length} matches; narrow the search or raise max_chars]`;
  }
  while (kept < blocks.length && len + FIND_SEP.length + blocks[kept].length <= maxChars) {
    len += FIND_SEP.length + blocks[kept].length;
    kept++;
  }
  return `${blocks.slice(0, kept).join(FIND_SEP)}\n\n[showing ${kept} of ${blocks.length} matches; narrow the search or raise max_chars]`;
}

// ---- compact find (gateway-side search of the full snapshot) ----

const isUrlLine = (l) => /^\s*- \/url: /.test(l);

// Compile upstream-style regex syntax: "/pattern/flags" or a plain (case-sensitive) pattern.
export function compileFindRegex(src) {
  const m = src.match(/^\/(.+)\/([a-z]*)$/s);
  return m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(src);
}

function nearestParent(lines, i) {
  let ind = indentOf(lines[i]);
  for (let j = i - 1; j >= 0; j--) {
    if (!lines[j].trim()) continue;
    if (indentOf(lines[j]) < ind) return j;
  }
  return -1;
}

function ancestorRef(lines, i) {
  let ind = indentOf(lines[i]);
  for (let j = i - 1; j >= 0 && ind > 0; j--) {
    if (!lines[j].trim() || indentOf(lines[j]) >= ind) continue;
    const r = lines[j].match(/\[ref=([^\]]+)\]/)?.[1];
    if (r) return r;
    ind = indentOf(lines[j]);
  }
  return undefined;
}

function compactNode(lines, i) {
  let l = cleanLine(lines[i].trim()).replace(/^- /, '');
  if (/^- link\b/.test(lines[i].trim())) {
    const u = lines[i + 1]?.match(/^\s*- \/url: (.*)$/);
    if (u) l += ` -> ${u[1].trim()}`;
  }
  if (!/\[ref=/.test(l)) {
    const r = ancestorRef(lines, i);
    if (r) l += ` [in ref=${r}]`;
  }
  return l;
}

// Search a snapshot yaml body line by line; returns { text } or { error }.
export function compactFind(yaml, { text, regex, maxChars }) {
  if ((text === undefined) === (regex === undefined)) return { error: 'Provide exactly one of text or regex.' };
  let test;
  let label;
  if (text !== undefined) {
    if (typeof text !== 'string' || !text) return { error: 'text must be a non-empty string.' };
    const needle = text.toLowerCase();
    test = (l) => l.toLowerCase().includes(needle);
    label = `"${text}"`;
  } else {
    if (typeof regex !== 'string' || !regex) return { error: 'regex must be a non-empty string.' };
    let re;
    try { re = compileFindRegex(regex); } catch (e) { return { error: `Invalid regex: ${e.message}` }; }
    test = (l) => re.test(l);
    label = /^\/.+\/[a-z]*$/s.test(regex) ? regex : `/${regex}/`;
  }
  const lines = yaml.split('\n');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (!test(cleanLine(lines[i].trim()).replace(/^- /, ''))) continue;
    let node = i;
    if (isUrlLine(lines[i])) {
      const p = nearestParent(lines, i);
      if (p >= 0 && /^- link\b/.test(lines[p].trim())) node = p;
    }
    const l = compactNode(lines, node);
    if (!seen.has(l)) { seen.add(l); out.push(l); }
  }
  if (!out.length) return { text: `### Result\nNo matches for ${label}.` };
  const head = `### Result\nFound ${out.length} match${out.length === 1 ? '' : 'es'} for ${label}:\n`;
  let kept = 0;
  let len = head.length;
  for (const l of out) {
    const add = l.length + (kept ? 1 : 0);
    if (kept > 0 && len + add > maxChars) break;
    len += add;
    kept++;
  }
  let body = out.slice(0, kept).join('\n');
  if (kept < out.length) body += `\n[showing ${kept} of ${out.length} matches; narrow the search or raise max_chars]`;
  return { text: head + body };
}

// ---- action results: drop the server-side snapshot file link ----

const SNAP_LINK_RE = /(^|\n)### Snapshot\n- \[[^\]\n]*\]\([^)\n]*\.yml\)[ \t]*(?:\n+(?=### )|\n*$)/;

// Remove a "### Snapshot" section whose body is only a link to a .yml file (unreachable for remote clients).
export function stripSnapshotLink(text) {
  if (typeof text !== 'string' || !SNAP_LINK_RE.test(text)) return text;
  return text.replace(SNAP_LINK_RE, (_m, pre) => pre).replace(/\s+$/, '');
}

export function stripSnapshotLinkResult(result) {
  if (!result || !Array.isArray(result.content)) return result;
  let changed = false;
  const content = result.content.map((p) => {
    if (p && p.type === 'text' && typeof p.text === 'string') {
      const t = stripSnapshotLink(p.text);
      if (t !== p.text) { changed = true; return { ...p, text: t }; }
    }
    return p;
  });
  return changed ? { ...result, content } : result;
}

// ---- evaluate-result parsing / page text ----

// Parse the JSON between "### Result\n" and the next "### " heading (or end).
export function parseEvalResult(text) {
  if (typeof text !== 'string') return undefined;
  const i = text.indexOf('### Result\n');
  if (i < 0) return undefined;
  let body = text.slice(i + '### Result\n'.length);
  const next = body.search(/^### /m);
  if (next >= 0) body = body.slice(0, next);
  try { return JSON.parse(body.trim()); } catch { return undefined; }
}

export function buildPageTextFunction({ selector, offset, maxChars }) {
  if (selector !== undefined && (typeof selector !== 'string' || selector.length > 500)) throw new Error('bad selector');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS_LIMIT) throw new Error('bad max_chars');
  const sel = selector ? JSON.stringify(selector) : 'null';
  return `() => {
  const SEL = ${sel};
  const OFFSET = ${offset};
  const MAX = ${maxChars};
  const body = document.body;
  let root;
  if (SEL) {
    root = document.querySelector(SEL);
    if (!root) return { nomatch: true };
  } else {
    root = body;
    const bl = (body && body.innerText ? body.innerText.length : 0);
    const m = document.querySelector('main, [role=main], article');
    if (m) {
      const ml = (m.innerText || '').length;
      if (ml > 500 && ml >= 0.25 * bl) root = m;
    }
  }
  let t = ((root && root.innerText) || '')
    .replace(/\\t/g, ' ')
    .split('\\n').map((l) => l.trim().replace(/ {2,}/g, ' ')).join('\\n')
    .replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, total: t.length, text: t.slice(OFFSET, OFFSET + MAX) };
}`;
}

export function formatPageText(obj, offset, maxChars) {
  const text = String(obj.text ?? '');
  const total = Number(obj.total) || 0;
  const end = offset + text.length;
  let out = `Title: ${obj.title ?? ''}\nURL: ${obj.url ?? ''}\nText (chars ${offset}-${end} of ${total}):\n${text}`;
  if (end < total) out += `\n[truncated: continue with offset=${end}]`;
  return out;
}

// ---- screenshot ----

const SHOT_FORMATS = new Set(['png', 'jpeg', 'webp']);

export const SHOT_MAX_HEIGHT = 10000;
export const SHOT_SMALL_ELEMENT_AREA = 90000; // CSS px^2: below this an element is left at full scale unless resize is given

// Code for browser_run_code_unsafe: a downscaled CDP screenshot of the viewport, the full page, or one element.
// format null = jpeg when scaled down, else png. autoScale (element only): small elements stay at scale 1.
// The code returns { data, width, height, vw, vh, fmt, scale, ch } or { err: 'target' | 'box' }.
export function buildScreenshotCode({ scale, quality, format, fullPage, target, autoScale = false }) {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 1) throw new Error('bad scale');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('bad quality');
  if (format !== null && !SHOT_FORMATS.has(format)) throw new Error('bad format');
  if (typeof fullPage !== 'boolean') throw new Error('bad fullPage');
  if (target !== undefined && (typeof target !== 'string' || target.length === 0 || target.length > 500)) throw new Error('bad target');
  if (typeof autoScale !== 'boolean') throw new Error('bad autoScale');
  return `async (page) => {
  let scale = ${scale};
  const QUALITY = ${quality};
  const FORMAT = ${JSON.stringify(format)};
  const FULL = ${fullPage ? 'true' : 'false'};
  const TARGET = ${JSON.stringify(target ?? null)};
  const AUTO = ${autoScale ? 'true' : 'false'};
  let box = null;
  if (TARGET !== null) {
    const el = page.locator(/^(f\\d+)?e\\d+$/.test(TARGET) ? 'aria-ref=' + TARGET : TARGET);
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 5000 });
      box = await el.boundingBox({ timeout: 5000 });
    } catch (e) { return { err: 'target' }; }
    if (!box || !(box.width > 0) || !(box.height > 0)) return { err: 'box' };
  }
  const s = await page.context().newCDPSession(page);
  try {
    const lm = await s.send('Page.getLayoutMetrics');
    const vv = lm.cssVisualViewport || lm.visualViewport;
    const vp = page.viewportSize() || { width: Math.round(vv.clientWidth), height: Math.round(vv.clientHeight) };
    let x = vv.pageX || 0, y = vv.pageY || 0, w = vp.width, h = vp.height, beyond = false, ch = 0;
    if (box) {
      const bx = Math.floor(box.x), by = Math.floor(box.y); // whole pixels outward, like the stock element screenshot
      x += bx; y += by; w = Math.ceil(box.x + box.width) - bx; h = Math.min(${SHOT_MAX_HEIGHT}, Math.ceil(box.y + box.height) - by); beyond = true;
      if (AUTO && w * h < ${SHOT_SMALL_ELEMENT_AREA}) scale = 1;
    } else if (FULL) {
      const c = lm.cssContentSize || lm.contentSize;
      x = 0; y = 0; w = Math.ceil(c.width); h = Math.min(${SHOT_MAX_HEIGHT}, Math.ceil(c.height)); beyond = true;
      if (Math.ceil(c.height) > h) ch = Math.ceil(c.height);
    }
    const fmt = FORMAT || (scale < 1 ? 'jpeg' : 'png');
    const params = { format: fmt, clip: { x, y, width: w, height: h, scale }, captureBeyondViewport: beyond };
    if (fmt !== 'png') params.quality = QUALITY;
    const r = await s.send('Page.captureScreenshot', params);
    return { data: r.data, width: Math.round(w * scale), height: Math.round(h * scale), vw: vp.width, vh: vp.height, fmt, scale, ch };
  } finally {
    await s.detach().catch(() => {});
  }
}`;
}

export const imageTokens = (w, h) => Math.min(1600, Math.round((w * h) / 750));

// ---- tool-definition trimming ----

const PROP_DESC = {
  target: 'Element ref (snapshot/find) or unique selector',
  filename: 'Save the result to this server file instead',
};
const TOOL_PROP_DESC = {
  'browser_run_code_unsafe.code': 'JS function invoked with `page`, e.g. `async (page) => { return await page.title(); }`',
  'browser_evaluate.function': '`() => {...}` or `(element) => {...}` when target is given',
  'browser_console_messages.level': 'Minimum severity (includes more severe); default info',
  'browser_console_messages.all': 'All messages since session start, not just since last navigation',
  'browser_network_requests.static': 'Include successful static resources (images, fonts, scripts); default false',
  'browser_network_requests.filter': 'Only URLs matching this regexp, e.g. "/api/.*user"',
  'browser_file_upload.paths': 'Absolute paths of files to upload; omit to cancel the chooser',
  'browser_drop.data': 'Map of MIME type to string value, e.g. {"text/plain": "hello"}',
  'browser_type.slowly': 'Type one character at a time (triggers key handlers); default fills at once',
  'browser_select_option.values': 'Value(s) to select',
  'browser_tabs.index': 'Tab index for close/select; omitted for close = current tab',
  'browser_emulate_media.colorScheme': 'prefers-color-scheme',
  'browser_emulate_media.reducedMotion': 'prefers-reduced-motion',
  'browser_emulate_media.forcedColors': 'forced-colors',
  'browser_emulate_media.contrast': 'prefers-contrast',
  'browser_emulate_media.media': 'CSS media type',
  'browser_press_key.key': 'Key name or character, e.g. `ArrowLeft` or `a`',
  'browser_navigate.url': null,
  'browser_type.text': null,
  'browser_type.submit': 'Press Enter after typing',
  'browser_tabs.action': null,
  'browser_tabs.url': 'URL for a new tab',
  'browser_wait_for.time': 'Seconds to wait, at most 30',
  'browser_wait_for.text': 'Text to wait for',
  'browser_wait_for.textGone': 'Text to wait to disappear',
  'browser_handle_dialog.accept': null,
  'browser_handle_dialog.promptText': 'Text for a prompt dialog',
  'browser_click.doubleClick': 'Double click',
  'browser_click.button': 'Default left',
  'browser_click.modifiers': 'Modifier keys to hold',
  'browser_snapshot.depth': 'Subtree depth limit',
  'browser_snapshot.boxes': 'Add [box=x,y,w,h] CSS px bounding boxes',
  'browser_take_screenshot.scale': '"css" (default) or "device" (larger)',
  'browser_take_screenshot.fullPage': 'Whole scrollable page',
  'browser_take_screenshot.type': 'Default jpeg when downscaled, otherwise png',
  'browser_find.text': 'Case-insensitive substring (text or regex)',
  'browser_find.regex': 'Regex, e.g. "/error/i" for flags (text or regex)',
  'browser_fill_form.fields': 'Fields to fill. value: "true"/"false" for checkbox, option text for combobox',
};
// Item properties of array params whose descriptions are redundant (the array's own description covers them).
const ITEM_DESC_DROP = new Set(['browser_fill_form.fields']);
const TOOL_DESC = {
  browser_emulate_media: 'Emulate CSS media features (e.g. dark color scheme). Omitted params stay unchanged; null clears an override.',
  browser_drop: 'Drop files or MIME-typed data onto an element. Provide "paths" and/or "data".',
  browser_network_requests: 'Numbered list of network requests since page load. Use browser_network_request with the number for details.',
  browser_network_request: 'Full details (headers, body) of one network request, or one `part`. Use the number from browser_network_requests.',
};
const HIDDEN_PROPS = new Set(['element', 'startElement', 'endElement']);

// Returns { tool, elementRequired } where elementRequired lists hidden props that upstream requires.
export function trimTool(tool) {
  const t = JSON.parse(JSON.stringify(tool));
  const schema = t.inputSchema ?? {};
  delete schema.$schema;
  const props = schema.properties ?? {};
  const elementRequired = [];
  for (const k of Object.keys(props)) {
    if (HIDDEN_PROPS.has(k)) {
      if ((schema.required ?? []).includes(k)) elementRequired.push(k);
      delete props[k];
      continue;
    }
    // Array-of-object params (e.g. browser_fill_form.fields): trim the item props too.
    // Hidden props are optional there upstream; a required one is left listed.
    const item = props[k]?.items;
    if (item && typeof item === 'object' && item.properties) {
      for (const ik of Object.keys(item.properties)) {
        if (HIDDEN_PROPS.has(ik) && !(item.required ?? []).includes(ik)) delete item.properties[ik];
        else if (PROP_DESC[ik] !== undefined) item.properties[ik].description = PROP_DESC[ik];
        else if (ITEM_DESC_DROP.has(`${t.name}.${k}`)) delete item.properties[ik].description;
      }
    }
    const tk = `${t.name}.${k}`;
    const d = Object.hasOwn(TOOL_PROP_DESC, tk) ? TOOL_PROP_DESC[tk] : PROP_DESC[k];
    if (d === null && props[k] && typeof props[k] === 'object') delete props[k].description;
    else if (d !== undefined && props[k] && typeof props[k] === 'object') props[k].description = d;
    else if (typeof props[k]?.description === 'string' && props[k].description.length > 90) {
      props[k].description = props[k].description.replace(/ Relative file names are resolved against the workspace root\./, '');
    }
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((r) => !HIDDEN_PROPS.has(r));
    if (schema.required.length === 0) delete schema.required;
  }
  if (TOOL_DESC[t.name]) t.description = TOOL_DESC[t.name];
  delete schema.additionalProperties;
  return { tool: slimAnnotations(t), elementRequired };
}

// Drop annotation noise that equals the MCP defaults (or is meaningless): the title, destructiveHint=true,
// openWorldHint=true, idempotentHint=false, and destructive/idempotent hints on read-only tools. Returns the tool.
export function slimAnnotations(tool) {
  const a = tool.annotations;
  if (!a || typeof a !== 'object') return tool;
  const ro = a.readOnlyHint === true;
  const out = {};
  if (ro) out.readOnlyHint = true;
  if (!ro && a.destructiveHint === false) out.destructiveHint = false;
  if (!ro && a.idempotentHint === true) out.idempotentHint = true;
  if (a.openWorldHint === false) out.openWorldHint = false;
  const t = { ...tool };
  if (Object.keys(out).length) t.annotations = out; else delete t.annotations;
  return t;
}

// ---- browser_more: the extra (unlisted) upstream tools ----

const firstLine = (d, max = 140) => {
  const l = String(d ?? '').split('\n')[0].trim();
  return l.length > max ? `${l.slice(0, max - 3)}...` : l;
};

// "name {req, opt?}: description" line of one tool (its first description line).
export function moreLine(tool) {
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const req = new Set(tool.inputSchema?.required ?? []);
  const sig = props.map((p) => (req.has(p) ? p : `${p}?`)).join(', ');
  return `${tool.name} {${sig}}: ${firstLine(tool.description)}`;
}

// Text for browser_more without a tool: one line per extra tool.
export function moreIndex(tools) {
  if (!tools.length) return 'No extra tools.';
  return `${tools.map(moreLine).join('\n')}\nCall: browser_more {tool, args}. Schema: browser_more {tool}.`;
}

// Text for browser_more {tool}: the (trimmed) definition, as JSON.
export const moreSchema = (tool) => JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });

// Add placeholders for hidden-but-required props the client omitted.
export function injectRequired(args, props) {
  if (!props || props.length === 0) return args;
  const a = { ...(args ?? {}) };
  for (const p of props) if (a[p] === undefined) a[p] = 'element';
  return a;
}
