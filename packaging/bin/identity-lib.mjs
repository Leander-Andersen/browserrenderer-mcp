// Browser identity: validation of the optional identity file and generation of the
// upstream (@playwright/mcp) config and init script. Pure functions, no I/O, so they
// can be unit tested; identity.mjs does the file handling.
//
// The identity only makes the headless browser report the same user agent, client
// hints, languages, time zone and screen as a normal desktop browser. Nothing here
// touches navigator.webdriver or any fingerprinting surface (canvas, WebGL, audio,
// fonts, plugins).

export class IdentityError extends Error {}

const fail = (msg) => { throw new IdentityError(msg); };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// BCP47-ish: language[-script][-region][-variant...], e.g. nb-NO, en, zh-Hans-CN.
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
// IANA zone names: Area/Location[/Sub], or a bare name such as UTC.
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;
const TOKEN_RE = /^[\x20-\x7e]{1,64}$/;

function str(v, name, { max, re, allowEmpty = false } = {}) {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (!allowEmpty && v.length === 0) fail(`${name} must not be empty`);
  if (!PRINTABLE_ASCII.test(v)) fail(`${name} must be printable ASCII`);
  if (max && v.length > max) fail(`${name} is longer than ${max} characters`);
  if (re && !re.test(v)) fail(`${name} has an invalid format`);
  return v;
}

function num(v, name, min, max, integer) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
  if (integer && !Number.isInteger(v)) fail(`${name} must be a whole number`);
  if (v < min || v > max) fail(`${name} must be between ${min} and ${max}`);
  return v;
}

function size(v, name) {
  if (!isObj(v)) fail(`${name} must be an object with width and height`);
  return { width: num(v.width, `${name}.width`, 100, 10000, true), height: num(v.height, `${name}.height`, 100, 10000, true) };
}

function brandList(v, name) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 10) fail(`${name} must be a list of 1 to 10 {brand, version}`);
  return v.map((b, i) => {
    if (!isObj(b)) fail(`${name}[${i}] must be an object`);
    const brand = str(b.brand, `${name}[${i}].brand`, { max: 64, re: /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/ });
    const version = str(b.version, `${name}[${i}].version`, { max: 32, re: /^[0-9][0-9.]*$/ });
    return { brand, version };
  });
}

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !TZ_RE.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function userAgentData(v) {
  if (!isObj(v)) fail('userAgentData must be an object or null');
  const out = { brands: brandList(v.brands, 'userAgentData.brands') };
  if (v.fullVersionList !== undefined) out.fullVersionList = brandList(v.fullVersionList, 'userAgentData.fullVersionList');
  if (v.mobile !== undefined) { if (typeof v.mobile !== 'boolean') fail('userAgentData.mobile must be true or false'); out.mobile = v.mobile; }
  if (v.wow64 !== undefined) { if (typeof v.wow64 !== 'boolean') fail('userAgentData.wow64 must be true or false'); out.wow64 = v.wow64; }
  for (const k of ['platform', 'platformVersion', 'architecture', 'bitness', 'model']) {
    if (v[k] !== undefined) out[k] = str(v[k], `userAgentData.${k}`, { max: 64, re: /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/, allowEmpty: true });
  }
  if (out.platform === undefined || out.platform === '') fail('userAgentData.platform is required when userAgentData is present');
  return out;
}

// Validate the parsed JSON of an identity file and return a normalised copy that only
// holds known fields. Unknown fields are ignored (forward compatible). Throws IdentityError.
export function validateIdentity(raw) {
  if (!isObj(raw)) fail('the file must contain a JSON object');
  if (raw.version !== undefined && raw.version !== 1) fail('version must be 1');
  const id = {};
  if (raw.userAgent !== undefined) id.userAgent = str(raw.userAgent, 'userAgent', { max: 512 });
  if (raw.platform !== undefined) id.platform = str(raw.platform, 'platform', { max: 64 });
  if (raw.userAgentData !== undefined && raw.userAgentData !== null) id.userAgentData = userAgentData(raw.userAgentData);
  if (raw.languages !== undefined) {
    if (!Array.isArray(raw.languages) || raw.languages.length === 0 || raw.languages.length > 10) fail('languages must be a list of 1 to 10 entries');
    id.languages = raw.languages.map((l, i) => str(l, `languages[${i}]`, { max: 35, re: LANG_RE }));
  }
  if (raw.timezone !== undefined) {
    str(raw.timezone, 'timezone', { max: 64 });
    if (!isValidTimezone(raw.timezone)) fail(`timezone '${raw.timezone}' is not a valid IANA time zone`);
    id.timezone = raw.timezone;
  }
  if (raw.screen !== undefined) id.screen = size(raw.screen, 'screen');
  if (raw.viewport !== undefined) id.viewport = size(raw.viewport, 'viewport');
  if (raw.deviceScaleFactor !== undefined) id.deviceScaleFactor = num(raw.deviceScaleFactor, 'deviceScaleFactor', 0.5, 4);
  if (raw.colorScheme !== undefined) {
    if (!['light', 'dark', 'no-preference'].includes(raw.colorScheme)) fail("colorScheme must be 'light', 'dark' or 'no-preference'");
    id.colorScheme = raw.colorScheme;
  }
  return id;
}

// "1440x900" or "1440,900" -> {width, height}
export function parseViewport(s) {
  const m = /^(\d+)[x,](\d+)$/.exec(String(s).trim());
  if (!m) fail(`viewport '${s}' must look like 1440x900`);
  return size({ width: +m[1], height: +m[2] }, 'viewport');
}

// Major version out of `chromium --version` output ("Chromium 156.0.8078.79 built on ...").
export function parseChromeMajor(versionOutput) {
  const m = /(\d{2,4})\.\d+\.\d+\.\d+/.exec(String(versionOutput));
  return m ? Number(m[1]) : null;
}

// What Chromium's own UA looks like with "HeadlessChrome" replaced by "Chrome"
// (UA reduction: only the major version is real).
export function defaultUserAgent(major, arch = process.arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'ia32' ? 'i686' : 'x86_64';
  return `Mozilla/5.0 (X11; Linux ${cpu}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const brandHeader = (list) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

function acceptLanguage(languages) {
  return languages.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(1 - i * 0.1, 0.1).toFixed(1)}`)).join(',');
}

// Upstream config (--config JSON) for an identity. `viewport` is the fallback from
// BRMCP_VIEWPORT; the file's viewport wins. `initScriptPath` is set when an init script
// is needed (see buildInitScript).
export function buildConfig(identity, { viewport, initScriptPath } = {}) {
  const ctx = {};
  if (identity.userAgent) ctx.userAgent = identity.userAgent;
  const vp = identity.viewport || viewport;
  if (vp) ctx.viewport = vp;
  if (identity.screen) ctx.screen = identity.screen;
  if (identity.deviceScaleFactor !== undefined) ctx.deviceScaleFactor = identity.deviceScaleFactor;
  if (identity.colorScheme) ctx.colorScheme = identity.colorScheme;
  if (identity.timezone) ctx.timezoneId = identity.timezone;
  const headers = {};
  if (identity.languages) {
    headers['Accept-Language'] = acceptLanguage(identity.languages);
  }
  const uad = identity.userAgentData;
  if (uad) {
    headers['Sec-CH-UA'] = brandHeader(uad.brands);
    headers['Sec-CH-UA-Mobile'] = uad.mobile ? '?1' : '?0';
    headers['Sec-CH-UA-Platform'] = `"${uad.platform}"`;
  }
  if (Object.keys(headers).length) ctx.extraHTTPHeaders = headers;
  const browser = { contextOptions: ctx };
  if (initScriptPath) browser.initScript = [initScriptPath];
  return { browser };
}

// Init script that makes navigator.* agree with the identity. Only defines
// userAgentData, platform and languages; returns null when none is needed.
// A file without userAgentData but with a userAgent means "browser without client
// hints" (Firefox, Safari): navigator.userAgentData is removed instead of keeping
// Chromium's brands next to a contradicting UA.
export function buildInitScript(identity) {
  const parts = [];
  if (identity.platform !== undefined) parts.push(`def(Navigator.prototype, 'platform', ${JSON.stringify(identity.platform)});`);
  if (identity.languages) {
    parts.push(`def(Navigator.prototype, 'languages', Object.freeze(${JSON.stringify(identity.languages)}));`);
    parts.push(`def(Navigator.prototype, 'language', ${JSON.stringify(identity.languages[0])});`);
  }
  const uad = identity.userAgentData;
  if (uad) {
    const data = {
      brands: uad.brands,
      mobile: uad.mobile === true,
      platform: uad.platform,
      high: {
        architecture: uad.architecture ?? '',
        bitness: uad.bitness ?? '',
        model: uad.model ?? '',
        platformVersion: uad.platformVersion ?? '',
        wow64: uad.wow64 === true,
        fullVersionList: uad.fullVersionList ?? uad.brands.map((b) => ({ brand: b.brand, version: b.version })),
      },
    };
    parts.push(`
  if (typeof NavigatorUAData !== 'undefined') {
    const D = ${JSON.stringify(data)};
    const P = NavigatorUAData.prototype;
    const lowEntropy = () => ({ brands: copy(D.brands), mobile: D.mobile, platform: D.platform });
    def(P, 'brands', null, () => copy(D.brands));
    def(P, 'mobile', null, () => D.mobile);
    def(P, 'platform', null, () => D.platform);
    Object.defineProperty(P, 'toJSON', { configurable: true, writable: true, enumerable: true, value: function toJSON() { return lowEntropy(); } });
    Object.defineProperty(P, 'getHighEntropyValues', { configurable: true, writable: true, enumerable: true, value: function getHighEntropyValues(hints) {
      if (!Array.isArray(hints)) return Promise.reject(new TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value cannot be converted to a sequence."));
      const out = lowEntropy();
      for (const h of hints) {
        if (h === 'fullVersionList') out.fullVersionList = copy(D.high.fullVersionList);
        else if (h in D.high) out[h] = D.high[h];
      }
      return Promise.resolve(out);
    } });
  }`);
  } else if (identity.userAgent && !identity.nativeClientHints) {
    parts.push(`
  try { delete Navigator.prototype.userAgentData; } catch (e) {}`);
  }
  if (!parts.length) return null;
  return `// Generated by browserrenderer-mcp from the browser identity. Do not edit.
(() => {
  'use strict';
  const copy = (list) => list.map((b) => Object.freeze({ brand: b.brand, version: b.version }));
  // def(obj, name, value) or def(obj, name, null, getter): accessor properties like the native ones.
  const def = (obj, name, value, getter) => {
    const get = getter || (() => value);
    Object.defineProperty(get, 'name', { value: 'get ' + name });
    Object.defineProperty(obj, name, { configurable: true, enumerable: true, get });
  };
  ${parts.join('\n  ')}
})();
`;
}

// Everything the CLI needs: { identity, source, config, initScript }.
// `identity` is the validated file content (or null for the default identity);
// `browser.major` is the installed browser's major version (null when unknown).
export function resolveIdentity({ identity = null, browser = {}, viewport, initScriptPath } = {}) {
  let effective; let source; let note = null;
  if (identity) {
    effective = identity; source = 'file';
  } else {
    source = 'default';
    // Chromium's own client hints already name "Chromium", never "HeadlessChrome":
    // keep them (nativeClientHints) and only fix the user agent string.
    effective = { nativeClientHints: true };
    if (browser.major) effective.userAgent = defaultUserAgent(browser.major, browser.arch);
    else note = 'browser version unknown, user agent left unchanged';
  }
  const initScript = buildInitScript(effective);
  const config = buildConfig(effective, { viewport, initScriptPath: initScript ? initScriptPath : undefined });
  return { source, note, userAgent: effective.userAgent || null, config, initScript };
}
