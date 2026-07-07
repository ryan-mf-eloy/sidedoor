// In-memory token-bucket rate limiter. Transient by design (buckets live only
// for the process lifetime). Also tracks a rolling window hit count per endpoint
// so the settings screen can show real "current window usage".
import { getHeader } from './hmac.js';

const WINDOW_MS = { second: 1000, minute: 60000, hour: 3600000 };

export class RateLimiter {
  constructor() {
    this.buckets = new Map();   // bucketKey -> { tokens, last }
    this.hits = new Map();      // endpointId -> number[] (timestamps)
  }

  windowMs(cfg) { return WINDOW_MS[cfg && cfg.window] || 60000; }

  bucketKey(endpointId, cfg, ctx) {
    let part = 'global';
    if (cfg.key === 'ip') part = (ctx.ip || '?');
    else if (cfg.key === 'header') part = String(getHeader(ctx.headers, cfg.keyHeader || '') || '?');
    return `${endpointId}|${cfg.key}|${part}`;
  }

  // Record a hit for usage tracking, pruning old timestamps.
  record(endpointId, cfg, now = Date.now()) {
    const w = this.windowMs(cfg);
    let arr = this.hits.get(endpointId);
    if (!arr) { arr = []; this.hits.set(endpointId, arr); }
    arr.push(now);
    const cutoff = now - w;
    while (arr.length && arr[0] < cutoff) arr.shift();
  }

  usage(endpointId, cfg, now = Date.now()) {
    const arr = this.hits.get(endpointId) || [];
    const cutoff = now - this.windowMs(cfg);
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] >= cutoff) count++; else break; }
    return count;
  }

  // Decide whether a request is allowed. Returns { allowed, remaining, retryAfter }.
  check(endpointId, cfg, ctx, now = Date.now()) {
    if (!cfg || !cfg.enabled) return { allowed: true };
    const limit = Math.max(0, Number(cfg.limit) || 0);
    const burst = Math.max(0, Number(cfg.burst) || 0);
    const capacity = Math.max(1, limit + burst);
    const w = this.windowMs(cfg);
    const refillPerMs = limit > 0 ? limit / w : 0;
    const key = this.bucketKey(endpointId, cfg, ctx);

    let b = this.buckets.get(key);
    if (!b) { b = { tokens: capacity, last: now }; this.buckets.set(key, b); }
    if (refillPerMs > 0) b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerMs);
    b.last = now;

    this.record(endpointId, cfg, now);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }
    const retryAfter = refillPerMs > 0 ? Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000)) : w / 1000;
    return { allowed: false, remaining: 0, retryAfter };
  }

  reset() { this.buckets.clear(); this.hits.clear(); }
}
