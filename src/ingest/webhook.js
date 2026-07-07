// Webhook (inspector) pipeline: capture every request, enforce auth + HMAC +
// rate limiting, then apply forwarding rules (forward / drop / respond /
// transform / tag) or accept-and-capture by default.
import { verifyAuth, failStatus } from '../lib/auth.js';
import { verify as verifyHmac } from '../lib/hmac.js';
import { evaluateForwarding } from '../lib/match.js';
import { clampStatus } from './handler.js';

const JSON_H = { 'Content-Type': 'application/json' };

async function relay(target, method, headers, body) {
  const skip = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (!skip.has(k.toLowerCase())) out[k] = v;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const hasBody = method !== 'GET' && method !== 'HEAD' && body != null && body !== '';
    const resp = await fetch(target, { method, headers: out, body: hasBody ? body : undefined, signal: controller.signal });
    const text = await resp.text();
    const rh = {};
    resp.headers.forEach((v, k) => { rh[k] = v; });
    return { status: resp.status, headers: rh, body: text };
  } catch (e) {
    return { status: 502, headers: JSON_H, body: JSON.stringify({ error: 'forward failed' }), error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleWebhook(ctx, ep, rc, respond) {
  const now = Date.now();
  const store = ctx.store;
  const cfg = ep.config;
  const base = {
    endpointId: ep.id, method: rc.method, path: rc.path, ip: rc.ip, size: rc.size, receivedAt: now,
    contentType: rc.contentType, headers: rc.headers, query: rc.query, body: rc.rawBody,
    eventLabel: (rc.bodyObj && (rc.bodyObj.type || rc.bodyObj.event)) || `${rc.method} ${rc.path}`,
  };
  const capture = (extra) => {
    const row = store.insertRequest({ ...base, ...extra });
    store.bumpActivity(ep.id, now);
    ctx.events.broadcast('request', { endpointId: ep.id, request: row });
    return row;
  };

  // 1. Auth
  const authRes = verifyAuth(cfg.auth, { headers: rc.headers, query: rc.query });
  if (!authRes.ok) {
    const st = failStatus(cfg.auth);
    respond(st, JSON_H, JSON.stringify({ error: 'unauthorized', reason: authRes.reason }));
    capture({ status: st, responseStatus: st, outcome: 'unauthorized', note: authRes.reason });
    return;
  }

  // 2. HMAC signature
  let signature = null;
  if (cfg.hmac.enabled) {
    const v = verifyHmac(cfg.hmac, { headers: rc.headers, rawBody: rc.rawBody, now });
    signature = v.result;
    if (v.result === 'invalid' && cfg.hmac.reject) {
      respond(401, JSON_H, JSON.stringify({ error: 'invalid signature' }));
      capture({ status: 401, responseStatus: 401, outcome: 'unauthorized', signature, note: v.reason });
      return;
    }
  }

  // 3. Rate limit
  if (cfg.rate.enabled) {
    const rl = ctx.rateLimiter.check(ep.id, cfg.rate, { ip: rc.ip, headers: rc.headers }, now);
    if (!rl.allowed) {
      const st = clampStatus(cfg.rate.status, 429);
      const headers = { ...JSON_H };
      if (cfg.rate.retryAfter && rl.retryAfter) headers['Retry-After'] = String(rl.retryAfter);
      respond(st, headers, JSON.stringify({ error: 'rate_limited', retryAfter: rl.retryAfter }));
      capture({ status: st, responseStatus: st, outcome: 'rate_limited', signature });
      return;
    }
  }

  // 4. Forwarding rules
  const mctx = { method: rc.method, path: rc.path, headers: rc.headers, query: rc.query, bodyObj: rc.bodyObj };
  const rule = evaluateForwarding(cfg.rules, cfg.ruleMatch, mctx);
  const action = rule ? rule.action : (ep.forward_target ? 'forward' : 'accept');
  const note = rule ? `rule:${rule.action}` : null;

  if (action === 'drop') {
    respond(200, JSON_H, JSON.stringify({ dropped: true }));
    capture({ status: 200, responseStatus: 200, outcome: 'dropped', signature, note });
    return;
  }
  if (action === 'respond') {
    const st = clampStatus(rule.respondStatus, 200);
    const body = rule.respondBody != null ? String(rule.respondBody) : '{}';
    respond(st, JSON_H, body);
    capture({ status: st, responseStatus: st, outcome: 'responded', signature, note, responseBody: body, responseHeaders: JSON_H });
    return;
  }
  if (action === 'tag') {
    respond(200, JSON_H, JSON.stringify({ received: true }));
    capture({ status: 200, responseStatus: 200, outcome: 'captured', signature, note: `tag:${rule.value || rule.key || ''}` });
    return;
  }
  if ((action === 'forward' || action === 'transform') && ep.forward_target) {
    const outBody = action === 'transform' && rule && rule.transform ? String(rule.transform) : rc.rawBody;
    const fwd = await relay(ep.forward_target, rc.method, rc.headers, outBody);
    respond(fwd.status, fwd.headers, fwd.body);
    capture({
      status: fwd.status, responseStatus: fwd.status, responseHeaders: fwd.headers, responseBody: fwd.body,
      outcome: 'forwarded', signature, note: fwd.error ? `forward error: ${fwd.error}` : note,
    });
    return;
  }

  // 5. Default: accept + capture (webhook.site-style receiver)
  respond(200, JSON_H, JSON.stringify({ received: true }));
  capture({ status: 200, responseStatus: 200, outcome: 'captured', signature, note });
}
