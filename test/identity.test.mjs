import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  IdentityError, validateIdentity, parseViewport, parseChromeMajor, defaultUserAgent, isValidTimezone,
  buildConfig, buildInitScript, resolveIdentity,
} from '../packaging/bin/identity-lib.mjs';

const example = JSON.parse(fs.readFileSync(new URL('../packaging/etc/identity.example.json', import.meta.url), 'utf8'));
const bad = (raw, re) => assert.throws(() => validateIdentity(raw), (e) => e instanceof IdentityError && re.test(e.message));

test('the shipped example validates and round-trips known fields', () => {
  const id = validateIdentity(example);
  assert.equal(id.userAgent, example.userAgent);
  assert.equal(id.userAgentData.brands.length, 2);
  assert.deepEqual(id.viewport, { width: 1440, height: 900 });
});

test('an empty object and absent userAgentData are fine; null userAgentData is dropped', () => {
  assert.deepEqual(validateIdentity({}), {});
  assert.equal(validateIdentity({ userAgent: 'x', userAgentData: null }).userAgentData, undefined);
});

test('unknown fields are ignored', () => {
  assert.deepEqual(validateIdentity({ version: 1, whatever: 1 }), {});
});

test('validation rejects wrong shapes and absurd values', () => {
  bad([], /JSON object/);
  bad('x', /JSON object/);
  bad({ version: 2 }, /version/);
  bad({ userAgent: 5 }, /userAgent must be a string/);
  bad({ userAgent: '' }, /must not be empty/);
  bad({ userAgent: 'é' }, /printable ASCII/);
  bad({ userAgent: 'a\nb' }, /printable ASCII/);
  bad({ userAgent: 'a'.repeat(513) }, /longer than 512/);
  bad({ languages: [] }, /1 to 10/);
  bad({ languages: Array(11).fill('en') }, /1 to 10/);
  bad({ languages: ['en_US'] }, /invalid format/);
  bad({ languages: ['en, fr'] }, /invalid format/);
  bad({ languages: 'en' }, /list/);
  bad({ timezone: 'Mars/Olympus' }, /not a valid IANA/);
  bad({ timezone: '+01:00' }, /not a valid IANA/);
  bad({ timezone: 5 }, /timezone must be a string/);
  bad({ screen: { width: 99, height: 500 } }, /screen\.width/);
  bad({ screen: { width: 500, height: 10001 } }, /screen\.height/);
  bad({ viewport: { width: 1.5, height: 500 } }, /whole number/);
  bad({ viewport: 'big' }, /object/);
  bad({ deviceScaleFactor: 0.1 }, /between 0.5 and 4/);
  bad({ deviceScaleFactor: 5 }, /between 0.5 and 4/);
  bad({ deviceScaleFactor: '1' }, /number/);
  bad({ colorScheme: 'sepia' }, /colorScheme/);
  bad({ platform: 5 }, /platform must be a string/);
  bad({ userAgentData: 'x' }, /object or null/);
  bad({ userAgentData: { platform: 'Linux' } }, /brands/);
  bad({ userAgentData: { brands: [{ brand: 'A"B', version: '1' }], platform: 'Linux' } }, /brand/);
  bad({ userAgentData: { brands: [{ brand: 'A', version: 'x' }], platform: 'Linux' } }, /version/);
  bad({ userAgentData: { brands: [{ brand: 'A', version: '1' }] } }, /platform is required/);
  bad({ userAgentData: { brands: [{ brand: 'A', version: '1' }], platform: 'Linux', mobile: 'no' } }, /mobile/);
});

test('timezone check accepts IANA names only', () => {
  for (const tz of ['Europe/Oslo', 'UTC', 'America/Argentina/Buenos_Aires', 'Etc/GMT+1']) assert.equal(isValidTimezone(tz), true, tz);
  for (const tz of ['', 'Oslo', 'Europe/Nowhere', '../etc', 'a b', 5]) assert.equal(isValidTimezone(tz), false, String(tz));
});

test('parseViewport', () => {
  assert.deepEqual(parseViewport('1440x900'), { width: 1440, height: 900 });
  assert.deepEqual(parseViewport('1280,720'), { width: 1280, height: 720 });
  assert.throws(() => parseViewport('big'), IdentityError);
  assert.throws(() => parseViewport('50x50'), IdentityError);
});

test('parseChromeMajor and defaultUserAgent', () => {
  assert.equal(parseChromeMajor('Chromium 156.0.8078.79 built on Debian GNU/Linux 13 (trixie)'), 156);
  assert.equal(parseChromeMajor('Google Chrome 142.0.7444.59'), 142);
  assert.equal(parseChromeMajor('nope'), null);
  const ua = defaultUserAgent(156, 'x64');
  assert.equal(ua, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
  assert.ok(!/Headless/.test(ua));
  assert.match(defaultUserAgent(156, 'arm64'), /Linux aarch64/);
});

test('default identity: Chrome UA from the browser version, viewport from env, nothing else', () => {
  const r = resolveIdentity({ browser: { major: 156, arch: 'x64' }, viewport: { width: 1440, height: 900 }, initScriptPath: '/x/init.js' });
  assert.equal(r.source, 'default');
  assert.match(r.userAgent, /Chrome\/156\.0\.0\.0/);
  assert.equal(r.initScript, null);
  assert.deepEqual(r.config, { browser: { contextOptions: { userAgent: r.userAgent, viewport: { width: 1440, height: 900 } } } });
});

test('default identity with unknown browser version leaves the UA alone', () => {
  const r = resolveIdentity({ browser: { major: null }, viewport: { width: 1440, height: 900 } });
  assert.equal(r.userAgent, null);
  assert.equal(r.initScript, null);
  assert.deepEqual(r.config.browser.contextOptions, { viewport: { width: 1440, height: 900 } });
  assert.match(r.note, /unknown/);
});

test('file identity: config carries UA, viewport (file wins), screen, scale, scheme, zone, headers', () => {
  const r = resolveIdentity({ identity: validateIdentity({ ...example, viewport: { width: 1000, height: 700 } }), viewport: { width: 1440, height: 900 }, initScriptPath: '/x/init.js' });
  assert.equal(r.source, 'file');
  const c = r.config.browser;
  assert.equal(c.contextOptions.userAgent, example.userAgent);
  assert.deepEqual(c.contextOptions.viewport, { width: 1000, height: 700 });
  assert.deepEqual(c.contextOptions.screen, example.screen);
  assert.equal(c.contextOptions.deviceScaleFactor, 1);
  assert.equal(c.contextOptions.colorScheme, 'light');
  assert.equal(c.contextOptions.timezoneId, example.timezone);
  assert.equal('locale' in c.contextOptions, false, 'locale would override the Accept-Language header');
  const h = c.contextOptions.extraHTTPHeaders;
  assert.equal(h['Accept-Language'], 'en-GB,en;q=0.9');
  assert.equal(h['Sec-CH-UA'], '"Chromium";v="142", "Not_A Brand";v="99"');
  assert.equal(h['Sec-CH-UA-Mobile'], '?0');
  assert.equal(h['Sec-CH-UA-Platform'], '"Linux"');
  assert.deepEqual(c.initScript, ['/x/init.js']);
  assert.ok(r.initScript);
});

test('file without a viewport falls back to BRMCP_VIEWPORT', () => {
  const r = resolveIdentity({ identity: validateIdentity({ userAgent: 'x' }), viewport: { width: 1280, height: 720 } });
  assert.deepEqual(r.config.browser.contextOptions.viewport, { width: 1280, height: 720 });
});

test('Accept-Language q values step down and stop at 0.1', () => {
  const langs = ['a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1', 'i1', 'j1'].map((l) => l.replace(/\d/, 'x'));
  const c = buildConfig({ languages: langs });
  const parts = c.browser.contextOptions.extraHTTPHeaders['Accept-Language'].split(',');
  assert.equal(parts[0], 'ax');
  assert.equal(parts[1], 'bx;q=0.9');
  assert.equal(parts[9], 'jx;q=0.1');
});

test('init script defines platform, languages and userAgentData and is valid JS', () => {
  const s = buildInitScript(validateIdentity(example));
  new Function(s); // syntax check
  assert.match(s, /'platform', "Linux x86_64"/);
  assert.match(s, /'languages', Object\.freeze\(\["en-GB","en"\]\)/);
  assert.match(s, /NavigatorUAData\.prototype/);
  assert.match(s, /"platformVersion":"6\.12\.0"/);
});

test('init script behaves: fake navigator gets the identity values', async () => {
  const s = buildInitScript(validateIdentity(example));
  class NavigatorUAData {}
  class Navigator {}
  new Function('Navigator', 'NavigatorUAData', s)(Navigator, NavigatorUAData);
  const uad = new NavigatorUAData();
  assert.deepEqual(uad.brands.map((b) => `${b.brand}/${b.version}`), ['Chromium/142', 'Not_A Brand/99']);
  assert.equal(uad.mobile, false);
  assert.equal(uad.platform, 'Linux');
  const hi = await uad.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList', 'wow64']);
  assert.equal(hi.platformVersion, '6.12.0');
  assert.equal(hi.architecture, 'x86');
  assert.equal(hi.bitness, '64');
  assert.equal(hi.fullVersionList[0].version, '142.0.7444.59');
  assert.equal(hi.platform, 'Linux');
  assert.equal(hi.wow64, false);
  assert.equal((await uad.getHighEntropyValues(['bitness'])).architecture, undefined, 'only requested high entropy values are returned');
  const nav = new Navigator();
  assert.equal(nav.platform, 'Linux x86_64');
  assert.deepEqual([...nav.languages], ['en-GB', 'en']);
  assert.equal(nav.language, 'en-GB');
  assert.deepEqual(JSON.parse(JSON.stringify(uad)).brands.length, 2);
});

test('no client hints in the file: userAgentData is removed, not left saying Chromium', () => {
  const s = buildInitScript(validateIdentity({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }));
  assert.match(s, /delete Navigator\.prototype\.userAgentData/);
  const c = buildConfig(validateIdentity({ userAgent: 'x' }));
  const h = c.browser.contextOptions.extraHTTPHeaders;
  assert.equal(h, undefined, 'no Sec-CH-UA headers are added');
});

test('nothing to define means no init script', () => {
  assert.equal(buildInitScript({}), null);
  assert.equal(buildInitScript({ timezone: 'UTC', colorScheme: 'dark' }), null);
});

test('the init script never touches automation or fingerprint surfaces', () => {
  const s = buildInitScript(validateIdentity(example));
  for (const w of ['webdriver', 'plugins', 'mimeTypes', 'canvas', 'WebGL', 'AudioContext', 'fonts']) assert.ok(!s.includes(w), w);
});
