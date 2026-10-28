// browserrenderer gateway: public MCP endpoint that proxies the stock
// @playwright/mcp (running separately on loopback) and adds watchlist/alert tools.
import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema, CallToolResultSchema, isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { TOOL_DEFS, TOOL_NAMES, createGatewayTools } from './tools.mjs';
import { smtpProblem } from './mail.mjs';

const log = (m) => console.error(`gateway: ${m}`);
let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`browserrenderer-gateway: ERROR: ${e.message}`);
  process.exit(78);
}
const callGatewayTool = createGatewayTools(cfg);
const problem = smtpProblem(cfg.smtp);
log(problem ? `alerts disabled: ${problem}` : 'alerts enabled');

const UPSTREAM_URL = new URL(`http://127.0.0.1:${cfg.upstreamPort}/mcp`);
const MAX_BODY = 4 * 1024 * 1024;
const sessions = new Map(); // id -> session

const errResult = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function createSession() {
  const s = {
    id: null, transport: null, server: null, upstream: null, upstreamPending: null,
    lastActive: Date.now(), inflight: 0, closed: false,
  };

  // Lazily open (and re-open after failure) this session's own upstream session.
  s.getUpstream = async () => {
    if (s.upstream) return s.upstream;
    if (!s.upstreamPending) {
      s.upstreamPending = (async () => {
        const client = new Client({ name: 'browserrenderer-gateway', version: '1.0.0' });
        const t = new StreamableHTTPClientTransport(UPSTREAM_URL);
        client.onclose = () => { if (s.upstream === client) s.upstream = null; };
        await client.connect(t);
        if (s.closed) { await client.close().catch(() => {}); throw new Error('session closed'); }
        s.upstream = client;
        return client;
      })().finally(() => { s.upstreamPending = null; });
    }
    return s.upstreamPending;
  };
  s.dropUpstream = async () => {
    const c = s.upstream;
    s.upstream = null;
    if (c) await c.close().catch(() => {});
  };

  const server = new Server(
    { name: 'browserrenderer-gateway', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];
    try {
      const up = await s.getUpstream();
      let cursor;
      do {
        const r = await up.listTools(cursor ? { cursor } : undefined, { timeout: 30000 });
        for (const t of r.tools) {
          if (TOOL_NAMES.has(t.name)) { log(`ignoring upstream tool with reserved name ${t.name}`); continue; }
          tools.push(t);
        }
        cursor = r.nextCursor;
      } while (cursor);
    } catch (e) {
      log(`upstream list failed: ${e.message}`);
      await s.dropUpstream();
    }
    return { tools: [...tools, ...TOOL_DEFS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    if (TOOL_NAMES.has(name)) return callGatewayTool(name, args);
    let up;
    try {
      up = await s.getUpstream();
    } catch (e) {
      log(`upstream connect failed: ${e.message}`);
      return errResult('The browser backend is unavailable right now (playwright-mcp is not reachable). Try again shortly.');
    }
    try {
      // Raw request: result is passed through verbatim (incl. images/structured content).
      return await up.request(
        { method: 'tools/call', params: req.params },
        CallToolResultSchema,
        { timeout: cfg.upstreamCallTimeoutMs, resetTimeoutOnProgress: true, signal: extra?.signal },
      );
    } catch (e) {
      // Protocol-level upstream errors (e.g. unknown tool, bad args) keep the upstream session.
      if (e && [-32600, -32601, -32602].includes(e.code)) throw e;
      log(`upstream call failed: ${e.message}`);
      if (!/timed out/i.test(String(e.message))) await s.dropUpstream();
      return errResult(`Browser backend error: ${e.message}`);
    }
  });

  s.server = server;
  s.cleanup = async () => {
    if (s.closed) return;
    s.closed = true;
    if (s.id) sessions.delete(s.id);
    await s.dropUpstream();
  };
  return s;
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) { const e = new Error('too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reply(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
const rpcError = (res, status, code, message) =>
  reply(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });

const httpServer = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding protection: exact Host match (case-insensitive).
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!cfg.hostnames.includes(host)) return reply(res, 403, { error: 'forbidden host' });

    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/mcp') return reply(res, 404, { error: 'not found' });
    if (!['POST', 'GET', 'DELETE'].includes(req.method)) {
      return reply(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST, DELETE' });
    }

    const sid = req.headers['mcp-session-id'];
    let s = typeof sid === 'string' ? sessions.get(sid) : undefined;
    let body;

    if (req.method === 'POST') {
      let raw;
      try { raw = await readBody(req); } catch (e) {
        return rpcError(res, e.status || 400, -32700, e.status === 413 ? 'Payload too large' : 'Bad request');
      }
      try { body = JSON.parse(raw); } catch { return rpcError(res, 400, -32700, 'Parse error'); }
      if (!s && !sid && isInitializeRequest(body)) {
        if (sessions.size >= cfg.maxSessions) return rpcError(res, 503, -32000, 'Too many sessions');
        const ns = createSession();
        ns.transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { ns.id = id; sessions.set(id, ns); },
        });
        ns.transport.onclose = () => { ns.cleanup().catch(() => {}); };
        await ns.server.connect(ns.transport);
        s = ns;
      }
    }

    if (!s) {
      if (sid) return rpcError(res, 404, -32001, 'Session not found');
      return rpcError(res, 400, -32000, 'Bad request: no valid session ID provided');
    }

    s.lastActive = Date.now();
    if (req.method === 'POST') s.inflight++;
    try {
      await s.transport.handleRequest(req, res, body);
    } finally {
      if (req.method === 'POST') s.inflight--;
      s.lastActive = Date.now();
    }
  } catch (e) {
    log(`request error: ${e.message}`);
    rpcError(res, 500, -32603, 'Internal server error');
  }
});
httpServer.headersTimeout = 30000;
httpServer.requestTimeout = 0; // tool calls can be long; streams stay open

// Reap sessions idle too long (orphaned claude.ai sessions never send DELETE).
const reaper = setInterval(() => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.inflight === 0 && now - s.lastActive > cfg.sessionIdleMs) {
      log(`reaping idle session ${s.id}`);
      s.transport.close().catch(() => {});
      s.cleanup().catch(() => {});
    }
  }
}, Math.min(60000, Math.max(1000, Math.floor(cfg.sessionIdleMs / 2))));
reaper.unref();

httpServer.listen(cfg.port, cfg.bind, () => log(`listening on ${cfg.bind}:${cfg.port}, upstream ${UPSTREAM_URL.origin}`));

function shutdown() {
  log('shutting down');
  clearInterval(reaper);
  httpServer.close();
  Promise.allSettled([...sessions.values()].map((s) => s.cleanup())).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
