import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSnapshot, shapeFull, shapeInteractive, shapeOutline, interactiveLines, capFind, FIND_SEP, capText, capResult,
  parseEvalResult, formatPageText, compactFind, compileFindRegex, boxInViewport, stripSnapshotLink, stripSnapshotLinkResult, COLLAPSE_NOTE, buildPageTextFunction, buildScreenshotCode, trimTool, injectRequired, OUTLINE_HINT,
} from '../gateway/shape.mjs';

const yaml = [
  '- generic [ref=e2]:',
  '  - banner [ref=e3]:',
  '    - link "new" [ref=e17] [cursor=pointer]:',
  '      - /url: newest',
  '    - heading "Hacker News" [level=1] [ref=e5]',
  '  - main [ref=e9]:',
  '    - heading "Top" [level=2] [ref=e10]',
  '    - button "Go" [disabled] [ref=e11] [cursor=pointer]',
  '    - checkbox "Agree" [checked] [ref=e12]',
  '    - textbox "Search" [ref=e13]: hello',
  '    - link "past" [ref=e14]:',
  '      - /url: front',
  '    - text: plain',
].join('\n');
const snap = (y = yaml, extra = '') =>
  `### Page\n- Page URL: https://x.test/\n- Page Title: X\n### Snapshot\n\`\`\`yaml\n${y}\n\`\`\`${extra}`;

test('splitSnapshot', () => {
  const p = splitSnapshot(snap(yaml, '\n### Events\n- one'));
  assert.equal(p.yaml, yaml);
  assert.equal(p.after, '### Events\n- one');
  assert.equal(splitSnapshot('### Result\nnope'), null);
});

test('full: no truncation when it fits, truncation note otherwise', () => {
  assert.equal(shapeFull(snap(), 100000), snap());
  const out = shapeFull(snap(), 120);
  assert.match(out, /\[truncated: showing \d+ of \d+ chars, \d+ of 13 lines\./);
  const body = splitSnapshot(out).yaml;
  assert.ok(body.length <= 120);
  assert.ok(yaml.startsWith(body));
  assert.ok(out.startsWith('### Page'));
});

test('full keeps other sections', () => {
  assert.ok(shapeFull(snap(yaml, '\n### Events\n- one'), 100000).endsWith('### Events\n- one'));
});

test('interactive: flat, cleaned, headings, urls', () => {
  const lines = interactiveLines(yaml);
  assert.deepEqual(lines, [
    'link "new" [ref=e17]',
    'heading "Hacker News" [level=1] [ref=e5]',
    'heading "Top" [level=2] [ref=e10]',
    'button "Go" [disabled] [ref=e11]',
    'checkbox "Agree" [checked] [ref=e12]',
    'textbox "Search" [ref=e13]: hello',
    'link "past" [ref=e14]',
  ]);
  const u = interactiveLines(yaml, true);
  assert.equal(u[0], 'link "new" [ref=e17] -> newest');
  assert.equal(u.at(-1), 'link "past" [ref=e14] -> front');
  const out = shapeInteractive(snap(), { urls: false, maxChars: 60 });
  assert.match(out, /\[truncated: showing/);
});

test('outline: counts, headings, hint, page section, cap', () => {
  const out = shapeOutline(snap());
  assert.ok(out.startsWith('### Page\n- Page URL: https://x.test/\n- Page Title: X'));
  assert.match(out, /Full snapshot: 13 lines/);
  assert.match(out, /links 2/);
  assert.match(out, /buttons 1/);
  assert.match(out, /textboxes 1/);
  assert.match(out, /h2 "Top" \[ref=e10\]/);
  assert.ok(out.trimEnd().endsWith(OUTLINE_HINT));
  assert.ok(!out.includes('```'));
  const big = Array.from({ length: 500 }, (_, i) => `  - heading "Heading number ${i}" [level=2] [ref=e${i}]`).join('\n');
  const o2 = shapeOutline(snap(big));
  const inner = o2.slice(o2.indexOf('### Snapshot (outline)'), o2.indexOf(OUTLINE_HINT));
  assert.ok(inner.length < 1700, `outline too long: ${inner.length}`);
  assert.equal((o2.match(/^h2 /gm) || []).length <= 25, true);
});

test('shapers return null without yaml fence', () => {
  assert.equal(shapeOutline('### Result\nError'), null);
  assert.equal(shapeFull('x', 10), null);
  assert.equal(shapeInteractive('x', { maxChars: 10 }), null);
});

test('capFind keeps whole blocks, at least one, with note', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => `block${i} ${'x'.repeat(100)}`);
  const text = `### Result\nFound 10 matches for "a":\n\n${blocks.join(FIND_SEP)}`;
  assert.equal(capFind(text, 100000), text);
  const out = capFind(text, 350);
  assert.match(out, /\[showing 2 of 10 matches; narrow the search or raise max_chars\]$/);
  assert.ok(!out.includes("block2"));
  const one = capFind(text, 20);
  assert.ok(one.startsWith('### Result\nFound 10 matches'.slice(0, 20)));
  assert.match(one, /showing 1 of 10 matches/);
});

test('generic cap', () => {
  assert.equal(capText('abc', 10), 'abc');
  assert.match(capText('a'.repeat(50), 10), /^a{10}\n\[truncated by gateway: 10 of 50 chars; narrow the request\]$/);
  const r = { content: [{ type: 'text', text: 'a'.repeat(50) }, { type: 'image', data: 'zzz', mimeType: 'image/png' }] };
  const c = capResult(r, 10);
  assert.equal(c.content[1], r.content[1]);
  assert.match(c.content[0].text, /truncated by gateway/);
  assert.equal(capResult({ content: [{ type: 'text', text: 'ok' }] }, 10).content[0].text, 'ok');
});

test('page text: eval result parsing and formatting', () => {
  const o = { title: 'T', url: 'u', total: 10, text: 'hello' };
  const txt = `### Result\n${JSON.stringify(o, null, 2)}\n### Other\nstuff`;
  assert.deepEqual(parseEvalResult(txt), o);
  assert.equal(parseEvalResult('### Result\nnot json'), undefined);
  assert.equal(parseEvalResult('nothing'), undefined);
  assert.equal(formatPageText(o, 0, 5), 'Title: T\nURL: u\nText (chars 0-5 of 10):\nhello\n[truncated: continue with offset=5]');
  assert.equal(formatPageText({ ...o, total: 5 }, 0, 5), 'Title: T\nURL: u\nText (chars 0-5 of 5):\nhello');
  assert.throws(() => buildPageTextFunction({ selector: 'a', offset: -1, maxChars: 5 }));
  assert.throws(() => buildPageTextFunction({ selector: 'a', offset: 0, maxChars: 1e9 }));
});

test('page text function embeds selector safely and evaluates', () => {
  const sel = 'a"); process.exit(1); //';
  const fn = buildPageTextFunction({ selector: sel, offset: 3, maxChars: 7 });
  assert.ok(fn.includes(JSON.stringify(sel)));
  const f = new Function(`return (${buildPageTextFunction({ offset: 2, maxChars: 8 })})`)();
  const body = { innerText: 'ab\tc  d \n\n\n\n  e  f\n' };
  globalThis.document = { body, title: 'Ti', querySelector: () => null };
  globalThis.location = { href: 'http://h/' };
  try {
    const r = f();
    assert.equal(r.title, 'Ti');
    assert.equal(r.total, 'ab c d\n\ne f'.length);
    assert.equal(r.text, 'ab c d\n\ne f'.slice(2, 10));
  } finally { delete globalThis.document; delete globalThis.location; }
});

test('screenshot code: validated interpolation only', () => {
  const code = buildScreenshotCode({ scale: 0.6, quality: 60, format: 'jpeg', fullPage: true });
  assert.match(code, /const SCALE = 0\.6;/);
  assert.match(code, /const FORMAT = "jpeg";/);
  assert.match(code, /const FULL = true;/);
  assert.match(code, /Math\.min\(10000/);
  assert.throws(() => buildScreenshotCode({ scale: 0.6, quality: 60, format: 'jpeg"; evil()', fullPage: false }));
  assert.throws(() => buildScreenshotCode({ scale: '1;evil()', quality: 60, format: 'png', fullPage: false }));
  assert.throws(() => buildScreenshotCode({ scale: 0.5, quality: 60.5, format: 'png', fullPage: false }));
  assert.throws(() => buildScreenshotCode({ scale: 0.5, quality: 60, format: 'png', fullPage: 'yes' }));
  assert.throws(() => buildScreenshotCode({ scale: 2, quality: 60, format: 'png', fullPage: false }));
});

test('trimTool: $schema, element hidden, descriptions shortened, props kept', () => {
  const up = {
    name: 'browser_click',
    description: 'Click',
    inputSchema: {
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Human-readable element description used to obtain permission to interact with the element' },
        target: { type: 'string', description: 'Exact target element reference from the page snapshot, or a unique element selector' },
        doubleClick: { type: 'boolean' },
      },
      required: ['target'],
      $schema: 'x',
      additionalProperties: false,
    },
  };
  const { tool, elementRequired } = trimTool(up);
  assert.equal(tool.inputSchema.$schema, undefined);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target', 'doubleClick']);
  assert.equal(tool.inputSchema.properties.target.description, 'Element ref from snapshot/find, or a unique selector');
  assert.deepEqual(tool.inputSchema.required, ['target']);
  assert.deepEqual(elementRequired, []);
  assert.ok(up.inputSchema.properties.element, 'input not mutated');

  const req = trimTool({ name: 'x', inputSchema: { type: 'object', properties: { element: { type: 'string' }, a: { type: 'string' } }, required: ['element', 'a'] } });
  assert.deepEqual(req.elementRequired, ['element']);
  assert.deepEqual(req.tool.inputSchema.required, ['a']);
  assert.deepEqual(injectRequired({ a: '1' }, req.elementRequired), { a: '1', element: 'element' });
  assert.deepEqual(injectRequired({ a: '1', element: 'mine' }, req.elementRequired), { a: '1', element: 'mine' });
  assert.deepEqual(injectRequired({ a: '1' }, undefined), { a: '1' });
});

const hn = [
  '- table [ref=e3]:',
  '  - row [ref=e5]:',
  '    - cell [ref=e13]:',
  '      - link "comments" [ref=e19] [cursor=pointer]:',
  '        - /url: newcomments',
  '      - text: "|"',
  '      - link "2324 comments" [ref=e55] [cursor=pointer]:',
  '        - /url: item?id=50467087',
  '      - text: "42 points by bob"',
  '      - textbox "Search" [ref=e60]: hello',
  '      - link "dup" [ref=e61]:',
  '        - /url: dup',
  '      - link "dup" [ref=e61]:',
  '        - /url: dup',
].join('\n');

test('compact find: text match, url-line match dedupes into parent link', () => {
  const r = compactFind(hn, { text: 'COMMENTS', maxChars: 5000 }).text;
  assert.equal(r, '### Result\nFound 2 matches for "COMMENTS":\n' +
    'link "comments" [ref=e19] -> newcomments\nlink "2324 comments" [ref=e55] -> item?id=50467087');
  const u = compactFind(hn, { text: 'newcomments', maxChars: 5000 }).text;
  assert.equal(u, '### Result\nFound 1 match for "newcomments":\nlink "comments" [ref=e19] -> newcomments');
});

test('compact find: no-ref line gets [in ref], textbox keeps value, dedupe', () => {
  const r = compactFind(hn, { text: 'points', maxChars: 5000 }).text;
  assert.match(r, /\ntext: "42 points by bob" \[in ref=e13\]$/);
  assert.match(compactFind(hn, { text: 'Search', maxChars: 5000 }).text, /\ntextbox "Search" \[ref=e60\]: hello$/);
  const d = compactFind(hn, { text: 'dup', maxChars: 5000 }).text;
  assert.equal(d, '### Result\nFound 1 match for "dup":\nlink "dup" [ref=e61] -> dup');
});

test('compact find: regex plain is case-sensitive, /re/flags supplies flags', () => {
  assert.match(compactFind(hn, { regex: '\\d+ points', maxChars: 5000 }).text, /Found 1 match for \/\\d\+ points\/:/);
  assert.match(compactFind(hn, { regex: 'COMMENTS', maxChars: 5000 }).text, /^### Result\nNo matches for \/COMMENTS\/\.$/);
  assert.match(compactFind(hn, { regex: '/COMMENTS/i', maxChars: 5000 }).text, /Found 2 matches for \/COMMENTS\/i:/);
  assert.ok(compileFindRegex('/a/gi').flags === 'i');
});

test('compact find: errors, zero matches, cap note', () => {
  assert.match(compactFind(hn, { maxChars: 5000 }).error, /exactly one/);
  assert.match(compactFind(hn, { text: 'a', regex: 'b', maxChars: 5000 }).error, /exactly one/);
  assert.match(compactFind(hn, { regex: '(', maxChars: 5000 }).error, /Invalid regex/);
  assert.equal(compactFind(hn, { text: 'zzz', maxChars: 5000 }).text, '### Result\nNo matches for "zzz".');
  const many = Array.from({ length: 50 }, (_, i) => `- link "item ${i}" [ref=e${i}]`).join('\n');
  const c = compactFind(many, { text: 'item', maxChars: 200 }).text;
  assert.match(c, /\[showing \d+ of 50 matches; narrow the search or raise max_chars\]$/);
  assert.ok(c.length < 300);
  assert.match(compactFind(many, { text: 'item', maxChars: 1 }).text, /showing 1 of 50/);
});

const boxed = [
  '- generic [ref=e1]:',
  '  - link "in" [ref=e2] [box=10,10,100,20]',
  '  - link "partly" [ref=e3] [box=1400,880,100,100]',
  '  - link "below" [ref=e4] [box=10,900,100,20]',
  '  - link "zero" [ref=e5] [box=10,10,0,0]',
  '  - link "left" [ref=e6] [box=-200,10,100,20]',
  '  - button "Go" [ref=e7] [box=5,5,10,10]',
  '  - link "nobox" [ref=e8]',
].join('\n');

test('viewport filter is a pure function of boxes + viewport size', () => {
  const vp = { width: 1440, height: 900 };
  assert.equal(boxInViewport('- x [box=10,10,5,5]', vp), true);
  assert.equal(boxInViewport('- x [box=0,900,5,5]', vp), false);
  assert.equal(boxInViewport('- x', vp), false);
  assert.deepEqual(interactiveLines(boxed, false, { viewport: vp, stripBoxes: true }), [
    'link "in" [ref=e2]', 'link "partly" [ref=e3]', 'button "Go" [ref=e7]',
  ]);
  assert.equal(interactiveLines(boxed, false, { viewport: vp })[0], 'link "in" [ref=e2] [box=10,10,100,20]');
});

const reps = (n) => [
  '- main [ref=e1]:',
  ...Array.from({ length: n }, (_, i) => `  - link "hide" [ref=e${50 + i}] [cursor=pointer]:\n    - /url: hide?id=${i}`),
  '  - link "other" [ref=e9]',
  '  - heading "Top" [level=2] [ref=e10]',
  '  - img "pic" [ref=e11]',
].join('\n');

test('interactive filters: roles and name', () => {
  assert.deepEqual(interactiveLines(yaml, false, { roles: ['heading'] }), [
    'heading "Hacker News" [level=1] [ref=e5]', 'heading "Top" [level=2] [ref=e10]',
  ]);
  assert.deepEqual(interactiveLines(reps(2), false, { roles: ['img'] }), ['img "pic" [ref=e11]']);
  assert.deepEqual(interactiveLines(yaml, false, { name: 'SEARCH' }), ['textbox "Search" [ref=e13]: hello']);
  assert.match(shapeInteractive(snap(), { maxChars: 1000, name: 'nomatch' }), /\(no matching elements\)/);
});

test('interactive collapsing: threshold 4, urls hidden, none with name', () => {
  assert.equal(interactiveLines(reps(3), true).filter((l) => l.startsWith('link "hide"')).length, 3);
  assert.ok(!interactiveLines(reps(3)).includes(COLLAPSE_NOTE));
  const c = interactiveLines(reps(30), true);
  assert.deepEqual(c, [
    'link "hide" x30 [refs e50, e51, e52, ...]', 'link "other" [ref=e9]', 'heading "Top" [level=2] [ref=e10]', COLLAPSE_NOTE,
  ]);
  assert.equal(interactiveLines(reps(4)).filter((l) => l.includes('x4')).length, 1);
  const n = interactiveLines(reps(30), true, { name: 'hide' });
  assert.equal(n.length, 30);
  assert.equal(n[0], 'link "hide" [ref=e50] -> hide?id=0');
  assert.ok(!n.includes(COLLAPSE_NOTE));
});

test('stripSnapshotLink: removes link-only section, keeps the rest', () => {
  const link = '### Snapshot\n- [Snapshot](output/page-2026.yml)';
  assert.equal(stripSnapshotLink(`### Ran code\nx\n### Page\n- Page URL: u\n${link}`), '### Ran code\nx\n### Page\n- Page URL: u');
  assert.equal(stripSnapshotLink(`### Page\n- u\n${link}\n### Events\n- one`), '### Page\n- u\n### Events\n- one');
  assert.equal(stripSnapshotLink(link), '');
  const inline = '### Page\n- u\n### Snapshot\n```yaml\n- a [ref=e1]\n```';
  assert.equal(stripSnapshotLink(inline), inline);
  const other = '### Snapshot\n- [Snapshot](out/a.yml)\n- extra line';
  assert.equal(stripSnapshotLink(other), other);
  const notYml = '### Snapshot\n- [Snapshot](out/a.png)';
  assert.equal(stripSnapshotLink(notYml), notYml);
  const r = { content: [{ type: 'text', text: `a\n${link}` }, { type: 'image', data: 'z', mimeType: 'image/png' }] };
  const o = stripSnapshotLinkResult(r);
  assert.equal(o.content[0].text, 'a');
  assert.equal(o.content[1], r.content[1]);
  const same = { content: [{ type: 'text', text: 'plain' }] };
  assert.equal(stripSnapshotLinkResult(same), same);
});
