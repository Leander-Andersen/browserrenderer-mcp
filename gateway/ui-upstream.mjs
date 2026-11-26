// Upstream sessions for the price compare page: a small pool owned by the gateway itself
// (not one of the public MCP sessions). One upstream session per slot key, opened lazily, closed
// after idleMs without use, never more than maxSlots open at once. Stock @playwright/mcp runs
// concurrent tools/call on one session in parallel (measured), so the page uses a single slot.
import { errorResult } from './shape.mjs';

// connect() -> Promise<{ callTool(name, args, { timeout, signal }) -> result, close() }>
export function createUiUpstream({ connect, maxSlots = 5, idleMs = 600000, timeoutMs = 120000, log = () => {}, now = Date.now }) {
  const slots = new Map(); // key -> { client, connecting, last, inflight }

  async function open(slot) {
    if (slot.client) return slot.client;
    if (!slot.connecting) {
      slot.connecting = connect().then((c) => { slot.client = c; return c; }).finally(() => { slot.connecting = null; });
    }
    return slot.connecting;
  }

  async function drop(key) {
    const slot = slots.get(key);
    if (!slot) return;
    slots.delete(key);
    const c = slot.client;
    slot.client = null;
    if (c) await c.close().catch(() => {});
  }

  // call(key, name, args, extra) -> tool result (an error result, never a throw, on backend trouble).
  function call(key, name, args, extra) {
    let slot = slots.get(key);
    if (!slot) {
      if (slots.size >= maxSlots) return Promise.resolve(errorResult('Too many browser sessions in use.'));
      slot = { client: null, connecting: null, last: now(), inflight: 0 };
      slots.set(key, slot);
    }
    slot.inflight++;
    const run = async () => {
      if (extra?.signal?.aborted) return errorResult('Request cancelled.');
      try {
        const c = await open(slot);
        return await c.callTool(name, args, { timeout: timeoutMs, signal: extra?.signal });
      } catch (e) {
        log(`ui upstream call failed: ${String(e && e.message).slice(0, 120)}`);
        if (!/timed out|abort/i.test(String(e && e.message))) {
          const c = slot.client;
          slot.client = null;
          if (c) c.close().catch(() => {});
        }
        return errorResult('Browser backend error.');
      }
    };
    return run().finally(() => { slot.inflight--; slot.last = now(); });
  }

  // Close slots idle for idleMs (called by a timer).
  async function sweep() {
    const t = now();
    for (const [key, slot] of [...slots]) if (slot.inflight === 0 && t - slot.last >= idleMs) { log(`ui upstream closing idle slot`); await drop(key); }
  }
  const timer = setInterval(() => { sweep().catch(() => {}); }, Math.min(60000, Math.max(1000, Math.floor(idleMs / 2))));
  timer.unref();

  async function closeAll() {
    clearInterval(timer);
    await Promise.allSettled([...slots.keys()].map(drop));
  }

  return { call, sweep, closeAll, size: () => slots.size };
}
