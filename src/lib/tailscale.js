// Real Tailscale Funnel control via the tailscale CLI. The `run` function is
// injectable so tests can drive it with canned CLI output.
import { execFile } from 'node:child_process';

function defaultRun(bin) {
  return (args, timeout = 8000) => new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err ? String(err.message || err) : null,
      });
    });
  });
}

// Parse `tailscale status --json` → machine identity + tailnet base URL.
export function parseStatus(json) {
  let d;
  try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!d || !d.Self) return null;
  const dns = String(d.Self.DNSName || '').replace(/\.$/, '');
  const machine = d.Self.HostName || (dns ? dns.split('.')[0] : '');
  const tailnet = dns ? dns.split('.').slice(1).join('.') : '';
  return { dnsName: dns, machine, tailnet, baseUrl: dns ? `https://${dns}` : null, region: d.Self.Relay || '' };
}

// Parse `tailscale funnel status --json` → is OUR ingest port exposed publicly?
export function parseFunnelStatus(json, ingestPort) {
  let d;
  try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return { active: false }; }
  if (!d) return { active: false };
  const web = d.Web || {};
  const allow = d.AllowFunnel || {};
  for (const [host, cfg] of Object.entries(web)) {
    const handlers = (cfg && cfg.Handlers) || {};
    for (const h of Object.values(handlers)) {
      if (h && typeof h.Proxy === 'string' && h.Proxy.includes(':' + ingestPort)) {
        const hostname = host.split(':')[0];
        const funnelled = allow[host] === true
          || Object.keys(allow).some((k) => k.split(':')[0] === hostname && allow[k]);
        return { active: !!funnelled, baseHost: hostname };
      }
    }
  }
  return { active: false };
}

export class Tailscale {
  constructor({ store, config, events, run } = {}) {
    this.store = store;
    this.config = config;
    this.events = events;
    this.run = run || defaultRun(config ? config.tailscaleBin : 'tailscale');
  }

  get port() { return this.config.ingestPort; }

  async summary() { return this.store.getFunnel(); }

  // Query the CLI and reconcile persisted funnel state.
  async refresh() {
    const statusRes = await this.run(['status', '--json']);
    let ident = null, err = null;
    if (statusRes.code === 0) ident = parseStatus(statusRes.stdout);
    else err = (statusRes.stderr || statusRes.error || 'tailscale status failed').trim();

    let active = false, baseHost = null;
    const funnelRes = await this.run(['funnel', 'status', '--json']);
    if (funnelRes.code === 0) {
      const f = parseFunnelStatus(funnelRes.stdout, this.port);
      active = f.active;
      baseHost = f.baseHost;
    }

    const cur = this.store.getFunnel() || {};
    const baseUrl = (baseHost ? `https://${baseHost}` : (ident && ident.baseUrl)) || cur.base_url || null;
    const next = this.store.setFunnel({
      active: active ? 1 : 0,
      since: active ? (cur.since || Date.now()) : null,
      base_url: baseUrl,
      region: ident ? ident.region : cur.region,
      machine: ident ? ident.machine : cur.machine,
      ingest_port: this.port,
      last_error: err,
    });
    if (this.events) this.events.broadcast('funnel', next);
    return next;
  }

  async enable() {
    const res = await this.run(['funnel', '--bg', String(this.port)]);
    if (res.code !== 0) {
      const msg = (res.stderr || res.error || 'Failed to enable Funnel').trim();
      const state = this.store.setFunnel({ last_error: msg });
      this.store.addFunnelHistory({ label: 'Funnel enable failed', detail: msg, kind: 'error' });
      if (this.events) this.events.broadcast('funnel', state);
      return state;
    }
    const state = await this.refresh();
    if (state.active) {
      this.store.addFunnelHistory({ label: 'Funnel enabled', detail: `${state.base_url || ''} → :${this.port}`, kind: 'up' });
    }
    return this.store.getFunnel();
  }

  async disable() {
    // Targeted "off" for OUR port only — never a global `funnel reset`, so any
    // other funnels the user runs on this machine are left untouched.
    const res = await this.run(['funnel', String(this.port), 'off']);
    const state = await this.refresh();
    if (res.code === 0 && !state.active) {
      this.store.addFunnelHistory({ label: 'Funnel disabled', detail: `:${this.port}`, kind: 'down' });
    } else if (res.code !== 0) {
      const msg = (res.stderr || res.error || 'Failed to disable Funnel').trim();
      this.store.setFunnel({ last_error: msg });
      this.store.addFunnelHistory({ label: 'Funnel disable failed', detail: msg, kind: 'error' });
    }
    return this.store.getFunnel();
  }
}
