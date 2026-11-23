#!/usr/bin/env node
// Startup step of start.sh: reads the optional identity file, validates it and writes
// the upstream config (and init script) that start.sh then passes with --config.
//
//   identity.mjs --out DIR --viewport WxH [--file PATH] [--require-file] [--exe PATH] [--app DIR]
//
// Exit 0: files written, one log line on stderr.  Exit 78: invalid identity (message on stderr).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { IdentityError, parseChromeMajor, parseViewport, resolveIdentity, validateIdentity } from './identity-lib.mjs';

const MAX_FILE_BYTES = 64 * 1024;

function die(msg) {
  process.stderr.write(`browserrenderer-mcp: ERROR: ${msg}\n`);
  process.exit(78);
}

function parseArgs(argv) {
  const a = { requireFile: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--require-file') a.requireFile = true;
    else if (['--out', '--viewport', '--file', '--exe', '--app'].includes(k)) a[k.slice(2)] = argv[++i];
    else die(`identity step: unknown argument '${k}'`);
  }
  return a;
}

function readIdentityFile(file, required) {
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e.code === 'ENOENT' && !required) return null;
    if (e.code === 'ENOENT') die(`BRMCP_IDENTITY_FILE '${file}' does not exist.`);
    die(`cannot read identity file '${file}': ${e.code || e.message}`);
  }
  if (!st.isFile()) die(`identity file '${file}' is not a regular file.`);
  if (st.size > MAX_FILE_BYTES) die(`identity file '${file}' is larger than ${MAX_FILE_BYTES} bytes.`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    die(`cannot read identity file '${file}': ${e.code || e.message} (it must be readable by the browserrenderer user).`);
  }
  let json;
  try { json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch {
    die(`identity file '${file}' is not valid JSON (syntax error).`);
  }
  try { return validateIdentity(json); } catch (e) {
    if (e instanceof IdentityError) die(`identity file '${file}': ${e.message}.`);
    throw e;
  }
}

// Major version of the browser that will run: `<exe> --version`, or Playwright's own
// Chromium when no executable is configured. Returns null when it cannot be found out.
function detectBrowserMajor(exe, app) {
  let bin = exe;
  if (!bin && app) {
    try {
      const req = createRequire(path.join(app, 'package.json'));
      bin = req('playwright-core').chromium.executablePath();
    } catch { /* fall through */ }
  }
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseChromeMajor(out);
  } catch { return null; }
}

const args = parseArgs(process.argv.slice(2));
if (!args.out) die('identity step: --out is required');
let viewport;
try { viewport = parseViewport(args.viewport || '1440x900'); } catch (e) { die(`BRMCP_VIEWPORT: ${e.message}`); }

const identity = args.file ? readIdentityFile(args.file, args.requireFile) : null;
const major = identity ? null : detectBrowserMajor(args.exe, args.app);
const outDir = path.resolve(args.out);
const initPath = path.join(outDir, 'init.js');
const r = resolveIdentity({ identity, browser: { major }, viewport, initScriptPath: initPath });

fs.mkdirSync(outDir, { recursive: true, mode: 0o750 });
const write = (name, text) => {
  const tmp = path.join(outDir, `.${name}.${process.pid}`);
  fs.writeFileSync(tmp, text, { mode: 0o640 });
  fs.renameSync(tmp, path.join(outDir, name));
};
write('config.json', JSON.stringify(r.config, null, 2) + '\n');
if (r.initScript) write('init.js', r.initScript);
else fs.rmSync(initPath, { force: true });

const ua = r.userAgent ? JSON.stringify(r.userAgent) : '(unchanged)';
process.stderr.write(`browserrenderer-mcp: identity: source=${r.source} userAgent=${ua}${r.note ? ` (${r.note})` : ''}\n`);
