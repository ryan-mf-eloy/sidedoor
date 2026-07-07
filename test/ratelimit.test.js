import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/lib/ratelimit.js';

test('disabled → always allowed', () => {
  const rl = new RateLimiter();
  for (let i = 0; i < 100; i++) assert.equal(rl.check('ep', { enabled: false }, { ip: '1' }).allowed, true);
});

test('allows up to capacity (limit + burst) then denies', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '3', window: 'minute', key: 'ip', burst: '2' }; // capacity 5
  const t0 = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 5; i++) if (rl.check('ep', cfg, { ip: 'a' }, t0).allowed) allowed++;
  assert.equal(allowed, 5);
  const denied = rl.check('ep', cfg, { ip: 'a' }, t0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfter >= 1);
});

test('refills over time', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '60', window: 'minute', key: 'ip', burst: '0' }; // 1 token/sec
  const t0 = 2_000_000;
  for (let i = 0; i < 60; i++) rl.check('ep', cfg, { ip: 'a' }, t0);
  assert.equal(rl.check('ep', cfg, { ip: 'a' }, t0).allowed, false);
  // 2 seconds later → ~2 tokens back
  assert.equal(rl.check('ep', cfg, { ip: 'a' }, t0 + 2000).allowed, true);
});

test('separate buckets per ip', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '1', window: 'minute', key: 'ip', burst: '0' };
  const t0 = 3_000_000;
  assert.equal(rl.check('ep', cfg, { ip: 'a' }, t0).allowed, true);
  assert.equal(rl.check('ep', cfg, { ip: 'a' }, t0).allowed, false);
  assert.equal(rl.check('ep', cfg, { ip: 'b' }, t0).allowed, true); // different bucket
});

test('global key shares one bucket', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '1', window: 'minute', key: 'endpoint', burst: '0' };
  const t0 = 4_000_000;
  assert.equal(rl.check('ep', cfg, { ip: 'a' }, t0).allowed, true);
  assert.equal(rl.check('ep', cfg, { ip: 'b' }, t0).allowed, false); // same global bucket
});

test('header bucket key', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '1', window: 'minute', key: 'header', keyHeader: 'X-Tenant', burst: '0' };
  const t0 = 5_000_000;
  assert.equal(rl.check('ep', cfg, { headers: { 'x-tenant': 't1' } }, t0).allowed, true);
  assert.equal(rl.check('ep', cfg, { headers: { 'x-tenant': 't1' } }, t0).allowed, false);
  assert.equal(rl.check('ep', cfg, { headers: { 'x-tenant': 't2' } }, t0).allowed, true);
});

test('usage tracks rolling window count', () => {
  const rl = new RateLimiter();
  const cfg = { enabled: true, limit: '100', window: 'second', key: 'ip', burst: '0' };
  const t0 = 6_000_000;
  rl.check('ep', cfg, { ip: 'a' }, t0);
  rl.check('ep', cfg, { ip: 'a' }, t0 + 100);
  assert.equal(rl.usage('ep', cfg, t0 + 200), 2);
  assert.equal(rl.usage('ep', cfg, t0 + 2000), 0); // outside 1s window
});
