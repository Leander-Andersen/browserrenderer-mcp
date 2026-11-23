import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectTools, DEFAULT_DIRECT_TOOLS } from '../gateway/config.mjs';

test('BRMCP_DIRECT_TOOLS: default, all, list, invalid', () => {
  assert.deepEqual([...parseDirectTools(undefined)], DEFAULT_DIRECT_TOOLS);
  assert.deepEqual([...parseDirectTools('  ')], DEFAULT_DIRECT_TOOLS);
  assert.equal(parseDirectTools('ALL'), null);
  assert.equal(parseDirectTools('"all"'), null);
  assert.deepEqual([...parseDirectTools('browser_navigate, browser_hover,')], ['browser_navigate', 'browser_hover']);
  assert.throws(() => parseDirectTools('browser_navigate;rm'));
  for (const n of ['browser_close', 'browser_hover', 'browser_drag', 'browser_file_upload', 'browser_resize']) assert.ok(!DEFAULT_DIRECT_TOOLS.includes(n));
});
