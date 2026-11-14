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

// Flat list of interactive lines (+ headings for context).
export function interactiveLines(yaml, urls = false) {
  const lines = yaml.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const role = m[2];
    if (!INTERACTIVE_ROLES.has(role) && role !== 'heading') continue;
    let l = cleanLine(lines[i].trim()).replace(/^- /, '');
    if (urls && role === 'link') {
      const next = lines[i + 1]?.match(/^\s*- \/url: (.*)$/);
      if (next) l += ` -> ${next[1].trim()}`;
    }
    out.push(l);
  }
  return out;
}

export function shapeFull(text, maxChars) {
  const parts = splitSnapshot(text);
  if (!parts) return null;
  const t = truncateLines(parts.yaml, maxChars);
  return assemble(parts.head, t.text, t.truncated ? truncNote(t) : '', parts.after);
}

export function shapeInteractive(text, { urls = false, maxChars }) {
  const parts = splitSnapshot(text);
  if (!parts) return null;
  const body = interactiveLines(parts.yaml, urls).join('\n');
  const t = truncateLines(body, maxChars);
  return assemble(parts.head, t.text, t.truncated ? truncNote(t) : '', parts.after);
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
    top.length ? `Top of tree:\n${top.join('\n')}` : '',
  ].filter(Boolean);
  let outline = sections.join('\n');
  if (outline.length > maxOutlineChars) {
    const t = truncateLines(outline, maxOutlineChars);
    outline = `${t.text}\n[outline cut]`;
  }
  const page = pageSection(parts.head);
  return `${page}\n### Snapshot (outline)\n${outline}\n${OUTLINE_HINT}${parts.after ? `\n${parts.after}` : ''}`;
}

// ---- find ----

export function capFind(text, maxChars) {
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

export function buildScreenshotCode({ scale, quality, format, fullPage }) {
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 1) throw new Error('bad scale');
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('bad quality');
  if (!SHOT_FORMATS.has(format)) throw new Error('bad format');
  if (typeof fullPage !== 'boolean') throw new Error('bad fullPage');
  return `async (page) => {
  const SCALE = ${scale};
  const QUALITY = ${quality};
  const FORMAT = ${JSON.stringify(format)};
  const FULL = ${fullPage ? 'true' : 'false'};
  const s = await page.context().newCDPSession(page);
  try {
    const lm = await s.send('Page.getLayoutMetrics');
    const vv = lm.cssVisualViewport || lm.visualViewport;
    const vp = page.viewportSize() || { width: Math.round(vv.clientWidth), height: Math.round(vv.clientHeight) };
    let x = vv.pageX || 0, y = vv.pageY || 0, w = vp.width, h = vp.height, beyond = false;
    if (FULL) {
      const c = lm.cssContentSize || lm.contentSize;
      x = 0; y = 0; w = Math.ceil(c.width); h = Math.min(10000, Math.ceil(c.height)); beyond = true;
    }
    const params = { format: FORMAT, clip: { x, y, width: w, height: h, scale: SCALE }, captureBeyondViewport: beyond };
    if (FORMAT !== 'png') params.quality = QUALITY;
    const r = await s.send('Page.captureScreenshot', params);
    return { data: r.data, width: Math.round(w * SCALE), height: Math.round(h * SCALE), vw: vp.width, vh: vp.height };
  } finally {
    await s.detach().catch(() => {});
  }
}`;
}

export const imageTokens = (w, h) => Math.min(1600, Math.round((w * h) / 750));

// ---- tool-definition trimming ----

const PROP_DESC = {
  target: 'Element ref from snapshot/find, or a unique selector',
  filename: 'Save to this file on the server instead of returning the result',
};
const TOOL_PROP_DESC = {
  'browser_take_screenshot.scale': '"css" (default, CSS px) or "device" (device px, larger)',
  'browser_take_screenshot.fullPage': 'Capture the whole scrollable page, not just the viewport',
  'browser_take_screenshot.type': 'Image format; default jpeg when downscaled, otherwise png',
  'browser_find.text': 'Case-insensitive substring to search for (use text or regex)',
  'browser_find.regex': 'Regex to search for, e.g. "/error/i" for flags (use text or regex)',
  'browser_run_code_unsafe.code': 'JS function invoked with `page`, e.g. `async (page) => { return await page.title(); }`',
  'browser_snapshot.boxes': 'Add [box=x,y,w,h] viewport-relative CSS px bounding boxes',
  'browser_snapshot.depth': 'Limit the depth of the snapshot tree',
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
  'browser_fill_form.fields': 'Fields to fill: target, name, type, value ("true"/"false" for checkbox, option text for combobox)',
  'browser_emulate_media.colorScheme': 'prefers-color-scheme',
  'browser_emulate_media.reducedMotion': 'prefers-reduced-motion',
  'browser_emulate_media.forcedColors': 'forced-colors',
  'browser_emulate_media.contrast': 'prefers-contrast',
  'browser_emulate_media.media': 'CSS media type',
  'browser_press_key.key': 'Key name or character, e.g. `ArrowLeft` or `a`',
};
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
      }
    }
    const d = TOOL_PROP_DESC[`${t.name}.${k}`] ?? PROP_DESC[k];
    if (d !== undefined && props[k] && typeof props[k] === 'object') props[k].description = d;
    else if (typeof props[k]?.description === 'string' && props[k].description.length > 90) {
      props[k].description = props[k].description.replace(/ Relative file names are resolved against the workspace root\./, '');
    }
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((r) => !HIDDEN_PROPS.has(r));
    if (schema.required.length === 0) delete schema.required;
  }
  if (TOOL_DESC[t.name]) t.description = TOOL_DESC[t.name];
  return { tool: t, elementRequired };
}

// Add placeholders for hidden-but-required props the client omitted.
export function injectRequired(args, props) {
  if (!props || props.length === 0) return args;
  const a = { ...(args ?? {}) };
  for (const p of props) if (a[p] === undefined) a[p] = 'element';
  return a;
}
