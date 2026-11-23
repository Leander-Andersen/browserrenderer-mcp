import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenshotCode } from '../gateway/shape.mjs';

// Run generated screenshot code against a fake page and CDP session.
async function runShot(opts, { box, vp = { width: 1440, height: 900 }, content = { width: 1440, height: 3000 }, sent = [], failTarget = false } = {}) {
  const code = buildScreenshotCode({ quality: 60, fullPage: false, format: null, ...opts });
  const session = {
    send: async (m, p) => {
      sent.push([m, p]);
      if (m === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 100, clientWidth: vp.width, clientHeight: vp.height }, cssContentSize: content };
      return { data: 'QUJD' };
    },
    detach: async () => {},
  };
  const loc = { scrollIntoViewIfNeeded: async () => { if (failTarget) throw new Error('x'); }, boundingBox: async () => box };
  const page = { context: () => ({ newCDPSession: async () => session }), viewportSize: () => vp, locator: (sel) => { sent.push(['locator', sel]); return loc; } };
  return (0, eval)(`(${code})`)(page);
}
const clipOf = (sent) => sent.find((s) => s[0] === 'Page.captureScreenshot')[1].clip;

test('screenshot code: viewport', async () => {
  const sent = [];
  const v = await runShot({ scale: 0.6 }, { sent });
  assert.deepEqual([v.width, v.height, v.fmt, v.scale, v.ch], [864, 540, 'jpeg', 0.6, 0]);
  assert.deepEqual(clipOf(sent), { x: 0, y: 100, width: 1440, height: 900, scale: 0.6 });
});

test('screenshot code: element target, ref vs selector, auto scale for small elements', async () => {
  const e1 = [];
  const big = await runShot({ scale: 0.5, target: 'e12', autoScale: true }, { box: { x: 10, y: 20, width: 600, height: 400 }, sent: e1 });
  assert.deepEqual(e1[0], ['locator', 'aria-ref=e12']);
  assert.deepEqual([big.width, big.height, big.fmt], [300, 200, 'jpeg']);
  assert.deepEqual(clipOf(e1), { x: 10, y: 120, width: 600, height: 400, scale: 0.5 });

  const ef = [];
  await runShot({ scale: 0.5, target: 'e3', autoScale: true }, { box: { x: 10.4, y: 20.6, width: 600.2, height: 400.2 }, sent: ef });
  assert.deepEqual(clipOf(ef), { x: 10, y: 120, width: 601, height: 401, scale: 0.5 });

  const e2 = [];
  const small = await runShot({ scale: 0.6, target: '#b', autoScale: true }, { box: { x: 0, y: 0, width: 68, height: 22 }, sent: e2 });
  assert.deepEqual(e2[0], ['locator', '#b']);
  assert.deepEqual([small.width, small.height, small.fmt, small.scale], [68, 22, 'png', 1]);
  const forced = await runShot({ scale: 0.6, target: '#b', autoScale: false }, { box: { x: 0, y: 0, width: 68, height: 22 } });
  assert.deepEqual([forced.scale, forced.fmt], [0.6, 'jpeg']);
  const fixed = await runShot({ scale: 0.6, format: 'png', target: '#b', autoScale: false }, { box: { x: 0, y: 0, width: 68, height: 22 } });
  assert.equal(fixed.fmt, 'png');
});

test('screenshot code: target errors, tall page cut is reported, validation', async () => {
  assert.deepEqual(await runShot({ scale: 0.6, target: 'e1' }, { failTarget: true }), { err: 'target' });
  assert.deepEqual(await runShot({ scale: 0.6, target: 'e1' }, { box: null }), { err: 'box' });
  const tall = await runShot({ scale: 0.5, fullPage: true }, { content: { width: 1440, height: 30000 } });
  assert.deepEqual([tall.height, tall.ch], [5000, 30000]);
  assert.equal((await runShot({ scale: 0.5, fullPage: true })).ch, 0);
  assert.throws(() => buildScreenshotCode({ scale: 0.5, quality: 60, format: 'png', fullPage: false, target: 5 }));
  assert.throws(() => buildScreenshotCode({ scale: 0.5, quality: 60, format: 'png', fullPage: false, target: '' }));
  assert.throws(() => buildScreenshotCode({ scale: 0.5, quality: 60, format: 'png', fullPage: false, autoScale: 'yes' }));
  assert.match(buildScreenshotCode({ scale: 0.5, quality: 60, format: null, fullPage: false, target: 'a"; evil(); "' }), /const TARGET = "a\\"; evil\(\); \\"";/);
});
