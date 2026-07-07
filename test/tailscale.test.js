import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseFunnelStatus, Tailscale } from '../src/lib/tailscale.js';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';

const STATUS = JSON.stringify({
  Self: { DNSName: 'mymachine.tail1234.ts.net.', HostName: 'mymachine', Relay: 'nyc' },
});

function funnelJson(active, port = 4601) {
  return JSON.stringify({
    Web: { 'mymachine.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
    AllowFunnel: active ? { 'mymachine.tail1234.ts.net:443': true } : {},
  });
}

test('parseStatus extracts machine + tailnet + base url', () => {
  const s = parseStatus(STATUS);
  assert.equal(s.machine, 'mymachine');
  assert.equal(s.tailnet, 'tail1234.ts.net');
  assert.equal(s.baseUrl, 'https://mymachine.tail1234.ts.net');
  assert.equal(s.region, 'nyc');
  assert.equal(parseStatus('garbage'), null);
  assert.equal(parseStatus('{}'), null);
});

test('parseFunnelStatus detects our port', () => {
  assert.deepEqual(parseFunnelStatus(funnelJson(true), 4601), { active: true, baseHost: 'mymachine.tail1234.ts.net' });
  assert.equal(parseFunnelStatus(funnelJson(false), 4601).active, false); // AllowFunnel empty
  assert.equal(parseFunnelStatus(funnelJson(true, 3000), 4601).active, false); // different port
  assert.equal(parseFunnelStatus('{}', 4601).active, false);
  assert.equal(parseFunnelStatus('nope', 4601).active, false);
});

test('Tailscale.enable/disable reconciles store via fake CLI', async () => {
  const store = new Store(openDb(':memory:'));
  let funnelOn = false;
  const run = async (args) => {
    const [a, b, c] = args;
    if (a === 'status' && b === '--json') return { code: 0, stdout: STATUS, stderr: '' };
    if (a === 'funnel' && b === 'status') return { code: 0, stdout: funnelJson(funnelOn), stderr: '' };
    if (a === 'funnel' && b === '--bg') { funnelOn = true; return { code: 0, stdout: '', stderr: '' }; }
    if (a === 'funnel' && c === 'off') { funnelOn = false; return { code: 0, stdout: '', stderr: '' }; }
    if (a === 'funnel' && b === 'reset') { funnelOn = false; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  const ts = new Tailscale({ store, config: { ingestPort: 4601, tailscaleBin: 'x' }, events: null, run });

  let state = await ts.enable();
  assert.equal(state.active, 1);
  assert.equal(state.base_url, 'https://mymachine.tail1234.ts.net');
  assert.equal(state.machine, 'mymachine');
  assert.ok(store.listFunnelHistory().some((h) => h.kind === 'up'));

  state = await ts.disable();
  assert.equal(state.active, 0);
  assert.ok(store.listFunnelHistory().some((h) => h.kind === 'down'));
});

test('Tailscale.enable surfaces CLI errors', async () => {
  const store = new Store(openDb(':memory:'));
  const run = async (args) => {
    if (args[0] === 'status') return { code: 0, stdout: STATUS, stderr: '' };
    if (args[0] === 'funnel' && args[1] === '--bg') return { code: 1, stdout: '', stderr: 'Funnel not available: HTTPS must be enabled' };
    if (args[0] === 'funnel' && args[1] === 'status') return { code: 0, stdout: funnelJson(false), stderr: '' };
    return { code: 1, stdout: '', stderr: 'x' };
  };
  const ts = new Tailscale({ store, config: { ingestPort: 4601, tailscaleBin: 'x' }, events: null, run });
  const state = await ts.enable();
  assert.equal(state.active, 0);
  assert.match(state.last_error, /HTTPS must be enabled/);
  assert.ok(store.listFunnelHistory().some((h) => h.kind === 'error'));
});
