// Pure session-eviction choice (no I/O). Used by server.mjs when the session cap is reached.

// Pick one session to evict: not in flight, idle at least minIdleMs; prefer sessions that never opened an
// upstream connection, then the least recently active. Returns undefined when none qualifies.
export function pickEvictable(sessions, now, minIdleMs) {
  let best;
  for (const s of sessions) {
    if (s.closed || s.inflight > 0 || now - s.lastActive < minIdleMs) continue;
    if (!best || rank(s) < rank(best) || (rank(s) === rank(best) && s.lastActive < best.lastActive)) best = s;
  }
  return best;
}

const rank = (s) => (s.upstreamEver ? 1 : 0);
