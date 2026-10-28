// Gateway configuration, read once from the environment (systemd EnvironmentFile).
import os from 'node:os';

function int(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a non-negative integer`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}
const str = (name, def = '') => (process.env[name] ?? def).trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export function loadConfig() {
  const hostnames = str('BRMCP_HOSTNAME')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hostnames.length === 0) throw new Error('BRMCP_HOSTNAME is empty');
  for (const h of hostnames) {
    if (!/^[a-z0-9._:-]+$/.test(h)) throw new Error('BRMCP_HOSTNAME contains invalid characters');
  }
  const bind = str('BRMCP_BIND', '127.0.0.1');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bind)) throw new Error('BRMCP_BIND must be an IPv4 address');

  const smtpSecurity = str('SMTP_SECURITY', 'starttls').toLowerCase();
  if (!['starttls', 'tls', 'none'].includes(smtpSecurity)) {
    throw new Error('SMTP_SECURITY must be starttls, tls or none');
  }

  const prefixes = str('ALERT_LINK_PREFIXES', 'https://www.finn.no/')
    .split(';').map((p) => p.trim()).filter(Boolean)
    .map((p) => {
      let u;
      try { u = new URL(p); } catch { throw new Error(`ALERT_LINK_PREFIXES: invalid prefix "${p}"`); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('ALERT_LINK_PREFIXES: http(s) only');
      return u.origin + u.pathname + u.search;
    });
  if (prefixes.length === 0) throw new Error('ALERT_LINK_PREFIXES is empty');

  return {
    hostnames,
    bind,
    port: int('BRMCP_PORT', 8931, { min: 1, max: 65535 }),
    upstreamPort: int('BRMCP_UPSTREAM_PORT', 8932, { min: 1, max: 65535 }),
    dataDir: str('BRMCP_GATEWAY_DATA_DIR', '/var/lib/browserrenderer-gateway'),
    sessionIdleMs: int('BRMCP_SESSION_IDLE_MS', 3600000, { min: 1000 }),
    maxSessions: int('BRMCP_MAX_SESSIONS', 20, { min: 1 }),
    upstreamCallTimeoutMs: int('BRMCP_UPSTREAM_TIMEOUT_MS', 120000, { min: 1000 }),
    smtp: {
      host: str('SMTP_HOST'),
      port: int('SMTP_PORT', 587, { min: 1, max: 65535 }),
      security: smtpSecurity,
      user: str('SMTP_USER'),
      pass: process.env.SMTP_PASS ?? '',
      from: str('MAIL_FROM'),
      to: str('MAIL_TO'),
    },
    alertPrefixes: prefixes,
    alertMaxPerDay: int('ALERT_MAX_PER_DAY', 20, { min: 1 }),
    hostname: os.hostname(),
  };
}
