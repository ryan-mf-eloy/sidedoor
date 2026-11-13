// Mock pipeline: enforce auth + rate limiting, resolve the scenario (matching
// rule override → sequential rotation → active), apply the artificial delay,
// and return the configured response while capturing the request.
import { verifyAuth, failStatus } from '../lib/auth.js';
import { resolveScenarioRule } from '../lib/match.js';
import { clampStatus } from './handler.js';
import { allowedMethods, methodMatches, pathMatches, renderScenarioBody } from '../lib/mockPath.js';
import { buildEventContext } from '../lib/eventTemplate.js';

const JSON_H = { 'Content-Type': 'application/json' };
const MAX_DELAY = 60000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function scenarioHeaders(sc) {
  const h = { ...(sc.headers || {}) };
  const hasCT = Object.keys(h).some((k) => k.toLowerCase() === 'content-type');
  if (!hasCT) h['Content-Type'] = sc.contentType || 'application/json';
  return h;
}

export function pickScenario(store, ep, mctx) {
  const scenarios = ep.scenarios || store.listScenarios(ep.id);
  if (!scenarios.length) return { scenario: null };
  const hit = resolveScenarioRule(ep.matchRules || store.listMatchRules(ep.id), mctx);
  if (hit) {
    const sc = scenarios.find((s) => s.id === hit.scenarioId);
    if (sc) return { scenario: sc, ruleId: hit.ruleId, source: 'rule' };
  }
  if (ep.mode === 'sequence') {
    const idx = store.advanceSeqCursor(ep.id, scenarios.length);
    return { scenario: scenarios[idx], source: 'sequence' };
  }
  return { scenario: scenarios.find((s) => s.active) || scenarios[0], source: 'active' };
}

export async function handleMock(ctx, ep, rc, respond) {
  const now = Date.now();
  const store = ctx.store;
  const cfg = ep.config;
  const base = {
    endpointId: ep.id, method: rc.method, path: rc.path, ip: rc.ip, size: rc.size, receivedAt: now,
    contentType: rc.contentType, headers: rc.headers, query: rc.query, body: rc.rawBody,
  };
  const capture = (extra) => {
    const row = store.insertRequest({ ...base, ...extra });
    store.bumpActivity(ep.id, now);
    ctx.events.broadcast('request', { endpointId: ep.id, request: row });
    return row;
  };

  // 0. Method + path must match this mock's configured shape (exact or prefix).
  if (!methodMatches(ep, rc.method)) {
    const allow = allowedMethods(ep).join(', ') || ep.method || '';
    respond(405, { ...JSON_H, Allow: allow }, JSON.stringify({ error: 'method_not_allowed', expected: allow }));
    capture({ status: 405, responseStatus: 405, outcome: 'unmatched', eventLabel: 'Method not allowed' });
    return;
  }
  if (ep.path && !pathMatches(ep, rc.subpath || '/')) {
    respond(404, JSON_H, JSON.stringify({ error: 'not_found', expected: ep.path, pathMode: ep.path_mode || 'exact' }));
    capture({ status: 404, responseStatus: 404, outcome: 'unmatched', eventLabel: 'Path not found' });
    return;
  }

  // 1. Auth
  const authRes = verifyAuth(cfg.auth, { headers: rc.headers, query: rc.query });
  if (!authRes.ok) {
    const st = failStatus(cfg.auth);
    respond(st, JSON_H, JSON.stringify({ error: 'unauthorized', reason: authRes.reason }));
    capture({ status: st, responseStatus: st, outcome: 'unauthorized', eventLabel: 'Unauthorized', note: authRes.reason });
    return;
  }

  // 2. Rate limit
  if (cfg.rate.enabled) {
    const rl = ctx.rateLimiter.check(ep.id, cfg.rate, { ip: rc.ip, headers: rc.headers }, now);
    if (!rl.allowed) {
      const st = clampStatus(cfg.rate.status, 429);
      const headers = { ...JSON_H };
      if (cfg.rate.retryAfter && rl.retryAfter) headers['Retry-After'] = String(rl.retryAfter);
      respond(st, headers, JSON.stringify({ error: 'rate_limited', retryAfter: rl.retryAfter }));
      capture({ status: st, responseStatus: st, outcome: 'rate_limited', eventLabel: 'Rate limited' });
      return;
    }
  }

  // 3. Scenario resolution
  const mctx = { method: rc.method, path: rc.path, subpath: rc.subpath, headers: rc.headers, query: rc.query, bodyObj: rc.bodyObj };
  const { scenario } = pickScenario(store, ep, mctx);
  if (!scenario) {
    respond(200, JSON_H, JSON.stringify({}));
    capture({ status: 200, responseStatus: 200, outcome: 'mock', eventLabel: 'No scenario', responseBody: '{}' });
    return;
  }

  // 4. Delay
  const delay = Math.min(Math.max(0, Number(scenario.delay) || 0), MAX_DELAY);
  if (delay > 0) await sleep(delay);

  // 5. Respond with the scenario
  const st = clampStatus(scenario.status, 200);
  const headers = scenarioHeaders(scenario);
  const body = scenario.body == null ? '' : renderScenarioBody(String(scenario.body), mctx);
  respond(st, headers, body);
  const captured = capture({
    status: st, responseStatus: st, responseHeaders: headers, responseBody: body,
    outcome: 'mock', scenarioId: scenario.id, eventLabel: scenario.name,
  });
  // The response has been written and its valid call captured before event
  // work begins. Scheduling only persists jobs and wakes the dispatcher; it
  // never waits for an outbound connection on the mock request path.
  try {
    const scenarioEvents = store.listScenarioEvents(scenario.id).filter((event) => event.enabled);
    const run = store.createEventRun({
      endpointId: ep.id,
      scenarioId: scenario.id,
      requestId: captured.id,
      source: 'ingest',
      events: scenarioEvents,
      context: buildEventContext({
        request: {
          method: rc.method, path: rc.path, subpath: rc.subpath, headers: rc.headers,
          query: rc.query, body: rc.rawBody, bodyJson: rc.bodyObj,
        },
        response: { status: st, headers, body },
      }),
    });
    if (run) {
      ctx.events.broadcast('delivery', { endpointId: ep.id, run });
      if (ctx.dispatcher) ctx.dispatcher.wake();
    }
  } catch (error) {
    // A queue persistence problem must not replace a response that was already
    // delivered successfully. The error is intentionally not enriched with
    // request data, which may contain credentials.
    // eslint-disable-next-line no-console
    console.error('[sidedoor] event scheduling error:', error && error.message || error);
  }
}
