import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, verify, presetFor, getHeader, HMAC_PRESETS } from '../src/lib/hmac.js';

const secret = 'whsec_test_secret';
const body = '{"type":"charge.succeeded","amount":4990}';

test('getHeader is case-insensitive', () => {
  assert.equal(getHeader({ 'x-sig': 'a' }, 'X-Sig'), 'a');
  assert.equal(getHeader({ 'X-Sig': 'a' }, 'x-sig'), 'a');
  assert.equal(getHeader({}, 'missing'), undefined);
});

test('disabled config → skipped', () => {
  assert.equal(verify({ enabled: false }, { headers: {}, rawBody: body }).result, 'skipped');
});

test('enabled without secret → invalid, not a silent bypass', () => {
  // A freshly-created endpoint has hmac.enabled possibly true but secret ''.
  // This must behave like any other failed verification (so the existing
  // `reject` toggle still applies) — never like verification was skipped.
  const r = verify({ enabled: true, provider: 'custom', secret: '' }, { headers: {}, rawBody: body });
  assert.equal(r.result, 'invalid');
  assert.equal(r.reason, 'no-secret-configured');
});

test('custom provider: valid and invalid', () => {
  const cfg = { enabled: true, provider: 'custom', secret, algo: 'sha256', header: 'X-Signature', encoding: 'hex' };
  const sig = compute('sha256', secret, body, 'hex');
  assert.equal(verify(cfg, { headers: { 'x-signature': sig }, rawBody: body }).result, 'valid');
  assert.equal(verify(cfg, { headers: { 'x-signature': 'deadbeef' }, rawBody: body }).result, 'invalid');
  assert.equal(verify(cfg, { headers: {}, rawBody: body }).result, 'invalid'); // missing
});

test('github provider: sha256= prefix over body', () => {
  const p = presetFor('github');
  const cfg = { enabled: true, provider: 'github', secret, algo: p.algo, header: p.header, encoding: p.encoding };
  const sig = 'sha256=' + compute('sha256', secret, body, 'hex');
  assert.equal(verify(cfg, { headers: { 'x-hub-signature-256': sig }, rawBody: body }).result, 'valid');
  assert.equal(verify(cfg, { headers: { 'x-hub-signature-256': 'sha256=00' }, rawBody: body }).result, 'invalid');
});

test('shopify provider: base64 over body', () => {
  const p = presetFor('shopify');
  const cfg = { enabled: true, provider: 'shopify', secret, algo: p.algo, header: p.header, encoding: p.encoding };
  const sig = compute('sha256', secret, body, 'base64');
  assert.equal(verify(cfg, { headers: { 'x-shopify-hmac-sha256': sig }, rawBody: body }).result, 'valid');
});

test('stripe provider: t.payload with tolerance', () => {
  const p = presetFor('stripe');
  const now = Date.now();
  const t = Math.floor(now / 1000);
  const cfg = { enabled: true, provider: 'stripe', secret, algo: p.algo, header: p.header, encoding: p.encoding, tolerance: '300' };
  const v1 = compute('sha256', secret, `${t}.${body}`, 'hex');
  const header = `t=${t},v1=${v1}`;
  assert.equal(verify(cfg, { headers: { 'stripe-signature': header }, rawBody: body, now }).result, 'valid');
  // wrong signature
  assert.equal(verify(cfg, { headers: { 'stripe-signature': `t=${t},v1=00` }, rawBody: body, now }).result, 'invalid');
  // stale timestamp beyond tolerance
  const stale = t - 10000;
  const v1s = compute('sha256', secret, `${stale}.${body}`, 'hex');
  assert.equal(verify(cfg, { headers: { 'stripe-signature': `t=${stale},v1=${v1s}` }, rawBody: body, now }).result, 'invalid');
});

test('slack provider: v0 scheme with request timestamp', () => {
  const p = presetFor('slack');
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const cfg = { enabled: true, provider: 'slack', secret, algo: p.algo, header: p.header, encoding: p.encoding, tolerance: '300' };
  const sig = 'v0=' + compute('sha256', secret, `v0:${ts}:${body}`, 'hex');
  const headers = { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) };
  assert.equal(verify(cfg, { headers, rawBody: body, now }).result, 'valid');
});

test('presets cover the six providers', () => {
  for (const k of ['stripe', 'github', 'shopify', 'twilio', 'slack', 'custom']) {
    assert.ok(HMAC_PRESETS[k], `preset ${k}`);
  }
  assert.equal(presetFor('nonexistent').scheme, 'body'); // falls back to custom
});
