import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessVerifier, validTeamHost } from '../gateway/access.mjs';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function keypair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}
function sign(kp, claims, header = {}) {
  const h = b64u({ alg: 'RS256', kid: kp.kid, typ: 'JWT', ...header });
  const p = b64u(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), kp.privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}
const good = (now, over = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(now / 1000) + 600, nbf: Math.floor(now / 1000) - 5, ...over });

// A fake JWKS endpoint whose key set can change; counts fetches.
function jwks(initial) {
  const state = { keys: initial, calls: 0, urls: [] };
  state.fetchImpl = async (url) => {
    state.calls++;
    state.urls.push(String(url));
    return { ok: true, json: async () => ({ keys: state.keys.map((k) => k.jwk) }) };
  };
  return state;
}

test('team host validation', () => {
  assert.ok(validTeamHost('example.cloudflareaccess.com'));
  for (const bad of ['', 'localhost', 'a b.com', 'https://x.com', 'x.com/path', 'x.com:443', '-a.com', undefined]) assert.ok(!validTeamHost(bad), String(bad));
});

test('valid token verifies and keys come from the team certs URL', async () => {
  const kp = keypair('k1');
  const J = jwks([kp]);
  const now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: J.fetchImpl, now: () => now });
  assert.equal(await v.verify(sign(kp, good(now))), true);
  assert.deepEqual(J.urls, [`https://${TEAM}/cdn-cgi/access/certs`]);
  assert.equal(await v.verify(sign(kp, good(now, { aud: AUD }))), true, 'aud as a plain string');
  assert.equal(J.calls, 1, 'keys are cached');
});

test('bad signature, wrong aud, wrong iss are rejected', async () => {
  const kp = keypair('k1');
  const other = keypair('k1'); // same kid, different key
  const J = jwks([kp]);
  const now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: J.fetchImpl, now: () => now });
  assert.equal(await v.verify(sign(other, good(now))), false);
  const t = sign(kp, good(now));
  const [h, p, s] = t.split('.');
  assert.equal(await v.verify(`${h}.${b64u(good(now, { aud: ['x'.repeat(64)] }))}.${s}`), false, 'payload swapped');
  assert.equal(await v.verify(sign(kp, good(now, { aud: ['b'.repeat(64)] }))), false);
  assert.equal(await v.verify(sign(kp, good(now, { iss: 'https://evil.cloudflareaccess.com' }))), false);
  assert.equal(await v.verify(sign(kp, good(now, { iss: undefined }))), false);
  assert.equal(await v.verify(sign(kp, good(now, { aud: undefined }))), false);
  assert.equal(await v.verify(''), false);
  assert.equal(await v.verify('a.b'), false);
  assert.equal(await v.verify(undefined), false);
  assert.equal(await v.verify(`${h}.${p}.`), false);
  assert.equal(await v.verify('x'.repeat(9000)), false);
});

test('exp and nbf use a 60 second leeway', async () => {
  const kp = keypair('k1');
  const J = jwks([kp]);
  const now = Date.now();
  const s = Math.floor(now / 1000);
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: J.fetchImpl, now: () => now });
  assert.equal(await v.verify(sign(kp, good(now, { exp: s - 30 }))), true, 'expired 30 s ago, inside leeway');
  assert.equal(await v.verify(sign(kp, good(now, { exp: s - 120 }))), false, 'expired');
  assert.equal(await v.verify(sign(kp, good(now, { exp: undefined }))), false, 'no exp');
  assert.equal(await v.verify(sign(kp, good(now, { nbf: s + 30 }))), true, 'nbf 30 s ahead, inside leeway');
  assert.equal(await v.verify(sign(kp, good(now, { nbf: s + 300 }))), false, 'nbf in the future');
});

test('alg none, HS256 and other algs are rejected', async () => {
  const kp = keypair('k1');
  const J = jwks([kp]);
  const now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: J.fetchImpl, now: () => now });
  const claims = good(now);
  assert.equal(await v.verify(`${b64u({ alg: 'none', kid: 'k1' })}.${b64u(claims)}.`), false);
  assert.equal(await v.verify(`${b64u({ alg: 'none', kid: 'k1' })}.${b64u(claims)}.AAAA`), false);
  // HS256 signed with the public key bytes as the secret (classic confusion attack).
  const h = b64u({ alg: 'HS256', kid: 'k1' });
  const p = b64u(claims);
  const mac = crypto.createHmac('sha256', JSON.stringify(kp.jwk)).update(`${h}.${p}`).digest('base64url');
  assert.equal(await v.verify(`${h}.${p}.${mac}`), false);
  assert.equal(await v.verify(sign(kp, claims, { alg: 'RS512' })), false);
  assert.equal(await v.verify(sign(kp, claims, { kid: undefined })), false, 'no kid');
});

test('unknown kid refetches the keys, at most once per minute', async () => {
  const k1 = keypair('k1');
  const k2 = keypair('k2');
  const J = jwks([k1]);
  let now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: J.fetchImpl, now: () => now });
  assert.equal(await v.verify(sign(k1, good(now))), true);
  assert.equal(J.calls, 1);
  // k2 appears at the team, but we have not fetched since: first unknown kid within a minute is NOT refetched.
  J.keys = [k1, k2];
  now += 10000;
  assert.equal(await v.verify(sign(k2, good(now))), false);
  assert.equal(J.calls, 1, 'no refetch inside the 60 s window');
  now += 61000;
  assert.equal(await v.verify(sign(k2, good(now))), true, 'refetched after a minute');
  assert.equal(J.calls, 2);
  // Garbage kids cannot hammer the endpoint.
  const bogus = keypair('nope');
  assert.equal(await v.verify(sign(bogus, good(now))), false);
  assert.equal(await v.verify(sign(bogus, good(now))), false);
  assert.ok(J.calls <= 3);
});

test('keys are refetched after an hour; a failing endpoint keeps the old keys', async () => {
  const k1 = keypair('k1');
  const J = jwks([k1]);
  let now = Date.now();
  const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl: (u) => J.fetchImpl(u), now: () => now });
  assert.equal(await v.verify(sign(k1, good(now))), true);
  now += 3600000 + 1000;
  J.fetchImpl = async () => { J.calls++; throw new Error('network'); };
  assert.equal(await v.verify(sign(k1, good(now))), true, 'old keys still used when the refetch fails');
});

test('a fetch that fails or returns junk never lets a token through', async () => {
  const kp = keypair('k1');
  const now = Date.now();
  for (const fetchImpl of [
    async () => { throw new Error('down'); },
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ keys: 'x' }) }),
    async () => ({ ok: true, json: async () => ({ keys: [{ kty: 'RSA', kid: 'k1', n: 'zz', e: 'AQAB' }] }) }),
  ]) {
    const v = createAccessVerifier({ team: TEAM, aud: AUD, fetchImpl, now: () => now });
    assert.equal(await v.verify(sign(kp, good(now))), false);
  }
});
