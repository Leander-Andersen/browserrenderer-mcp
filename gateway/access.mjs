// Cloudflare Access JWT verification (Cf-Access-Jwt-Assertion), no dependencies.
// RS256 only; keys come from https://<team>/cdn-cgi/access/certs (JWKS), cached 1 h,
// refetched on an unknown kid at most once per minute.
import crypto from 'node:crypto';

const KEY_TTL_MS = 3600000;
const REFETCH_MIN_MS = 60000;
const FETCH_TIMEOUT_MS = 5000;
const LEEWAY_S = 60;
const MAX_TOKEN = 8192;
const b64u = (s) => Buffer.from(s, 'base64url');

export function validTeamHost(t) {
  return typeof t === 'string' && t.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(t);
}

// opts: { team, aud, fetchImpl?, now? (ms clock) }  -> { verify(token) -> Promise<boolean> }
export function createAccessVerifier({ team, aud, fetchImpl = globalThis.fetch, now = Date.now }) {
  const issuer = `https://${team}`;
  let keys = new Map(); // kid -> KeyObject
  let fetchedAt = -Infinity;
  let lastAttempt = -Infinity;
  let pending = null;

  function refetch() {
    if (pending) return pending;
    lastAttempt = now();
    pending = (async () => {
      try {
        const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
        if (!res.ok) return;
        const body = await res.json();
        const next = new Map();
        for (const jwk of Array.isArray(body && body.keys) ? body.keys : []) {
          if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
          try { next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* skip bad key */ }
        }
        if (next.size) { keys = next; fetchedAt = now(); }
      } catch { /* keep the old keys */ } finally { pending = null; }
    })();
    return pending;
  }

  async function keyFor(kid) {
    const t = now();
    if (pending) await pending;
    else if ((t - fetchedAt > KEY_TTL_MS || !keys.has(kid)) && t - lastAttempt >= REFETCH_MIN_MS) await refetch();
    return keys.get(kid) || null;
  }

  async function verify(token) {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN) return false;
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return false;
      const header = JSON.parse(b64u(parts[0]).toString('utf8'));
      if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
      const key = await keyFor(header.kid);
      if (!key) return false;
      if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2]))) return false;
      const c = JSON.parse(b64u(parts[1]).toString('utf8'));
      if (!c || typeof c !== 'object' || c.iss !== issuer) return false;
      const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (!auds.includes(aud)) return false;
      const nowS = Math.floor(now() / 1000);
      if (typeof c.exp !== 'number' || nowS > c.exp + LEEWAY_S) return false;
      if (c.nbf !== undefined && (typeof c.nbf !== 'number' || nowS < c.nbf - LEEWAY_S)) return false;
      return true;
    } catch { return false; }
  }

  return { verify };
}
