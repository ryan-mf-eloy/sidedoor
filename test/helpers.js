// Test harness: boot an isolated app (in-memory DB, ephemeral ports, fake
// Tailscale) and drive it over real HTTP.
import { createApp } from '../src/server.js';

export function makeFakeTailscale() {
  const st = { active: 0, base_url: 'https://mock-host.tailnet.ts.net', machine: 'mock-host', region: 'nyc', since: null };
  const ts = {
    store: null,
    _persist() {
      if (this.store) {
        this.store.setFunnel({
          active: st.active, since: st.since, base_url: st.base_url,
          region: st.region, machine: st.machine, ingest_port: 4601, last_error: null,
        });
      }
    },
    async summary() { return this.store ? this.store.getFunnel() : { ...st }; },
    async refresh() { this._persist(); return this.store ? this.store.getFunnel() : { ...st }; },
    async enable() {
      st.active = 1; st.since = Date.now(); this._persist();
      if (this.store) this.store.addFunnelHistory({ label: 'Funnel enabled', kind: 'up' });
      return this.store ? this.store.getFunnel() : { ...st };
    },
    async disable() {
      st.active = 0; st.since = null; this._persist();
      if (this.store) this.store.addFunnelHistory({ label: 'Funnel disabled', kind: 'down' });
      return this.store ? this.store.getFunnel() : { ...st };
    },
  };
  return ts;
}

export async function bootTestApp(overrides = {}) {
  const tailscale = overrides.tailscale || makeFakeTailscale();
  const app = createApp({
    dbPath: ':memory:', adminPort: 0, ingestPort: 0,
    adminHost: '127.0.0.1', ingestHost: '127.0.0.1', funnelPollMs: 0,
    tailscale, ...overrides,
  });
  if (tailscale) tailscale.store = app.store;
  await app.start();
  app.adminUrl = `http://127.0.0.1:${app.adminServer.address().port}`;
  app.ingestUrl = `http://127.0.0.1:${app.ingestServer.address().port}`;
  app.fakeTailscale = tailscale;
  return app;
}

export async function api(app, method, path, body) {
  const res = await fetch(app.adminUrl + '/__sd/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

// Connect to the SSE stream, run `trigger`, and resolve with the first matching
// event's parsed data (or reject on timeout).
export async function sseWaitFor(app, eventName, trigger, timeoutMs = 4000) {
  const controller = new AbortController();
  const resp = await fetch(app.adminUrl + '/__sd/api/events', { signal: controller.signal });
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    await new Promise((r) => setTimeout(r, 50)); // ensure subscription is registered
    await trigger();
    while (true) {
      const { value, done: fin } = await reader.read();
      if (fin) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const f of frames) {
        if (f.includes(`event: ${eventName}`)) {
          const line = f.split('\n').find((l) => l.startsWith('data:'));
          controller.abort();
          return line ? JSON.parse(line.slice(5).trim()) : {};
        }
      }
    }
  })();
  const timeout = new Promise((_, rej) => setTimeout(() => { controller.abort(); rej(new Error('sse timeout')); }, timeoutMs));
  return Promise.race([done, timeout]);
}
