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

// Upstream tools listed directly by default; the others are reached through browser_more.
export const DEFAULT_DIRECT_TOOLS = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_take_screenshot', 'browser_evaluate',
  'browser_wait_for', 'browser_tabs', 'browser_handle_dialog', 'browser_run_code_unsafe',
];

// BRMCP_DIRECT_TOOLS: comma list of upstream tools to list directly; "all" lists every tool (no browser_more).
// Returns a Set, or null for "all".
export function parseDirectTools(raw) {
  const v = (raw ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (v === '') return new Set(DEFAULT_DIRECT_TOOLS);
  if (v.toLowerCase() === 'all') return null;
  const names = v.split(',').map((n) => n.trim()).filter(Boolean);
  for (const n of names) if (!/^[A-Za-z0-9_.-]{1,80}$/.test(n)) throw new Error('BRMCP_DIRECT_TOOLS must be "all" or a comma-separated list of tool names');
  return new Set(names);
}

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

  const snapshotMode = str('BRMCP_SNAPSHOT_MODE', 'outline').toLowerCase();
  if (!['outline', 'interactive', 'full'].includes(snapshotMode)) {
    throw new Error('BRMCP_SNAPSHOT_MODE must be outline, interactive or full');
  }

  return {
    hostnames,
    bind,
    port: int('BRMCP_PORT', 8931, { min: 1, max: 65535 }),
    upstreamPort: int('BRMCP_UPSTREAM_PORT', 8932, { min: 1, max: 65535 }),
    dataDir: str('BRMCP_GATEWAY_DATA_DIR', '/var/lib/browserrenderer-gateway'),
    sessionIdleMs: int('BRMCP_SESSION_IDLE_MS', 3600000, { min: 1000 }),
    maxSessions: int('BRMCP_MAX_SESSIONS', 20, { min: 1 }),
    sessionEvictIdleMs: int('BRMCP_SESSION_EVICT_IDLE_MS', 120000, { min: 0 }),
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
    snapshotMode,
    screenshotScalePct: int('BRMCP_SCREENSHOT_SCALE', 60, { min: 10, max: 100 }),
    maxResultChars: int('BRMCP_MAX_RESULT_CHARS', 40000, { min: 1000 }),
    pageTextChars: int('BRMCP_PAGE_TEXT_CHARS', 8000, { min: 1, max: 200000 }),
    findChars: int('BRMCP_FIND_CHARS', 6000, { min: 1, max: 200000 }),
    directTools: parseDirectTools(process.env.BRMCP_DIRECT_TOOLS),
    hostname: os.hostname(),
  };
}
