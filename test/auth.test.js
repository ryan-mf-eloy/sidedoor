import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuth, failStatus } from '../src/lib/auth.js';

test('disabled / none → ok', () => {
  assert.equal(verifyAuth(null, {}).ok, true);
  assert.equal(verifyAuth({ enabled: false }, {}).ok, true);
  assert.equal(verifyAuth({ enabled: true, method: 'none' }, {}).ok, true);
});

test('bearer token', () => {
  const cfg = { enabled: true, method: 'bearer', header: 'Authorization', token: 'sk_live_abc' };
  assert.equal(verifyAuth(cfg, { headers: { authorization: 'Bearer sk_live_abc' } }).ok, true);
  assert.equal(verifyAuth(cfg, { headers: { authorization: 'Bearer wrong' } }).ok, false);
  assert.equal(verifyAuth(cfg, { headers: {} }).ok, false);
});

test('api key in header', () => {
  const cfg = { enabled: true, method: 'apikey', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', token: 'key123' };
  assert.equal(verifyAuth(cfg, { headers: { 'x-api-key': 'key123' } }).ok, true);
  assert.equal(verifyAuth(cfg, { headers: { 'x-api-key': 'nope' } }).ok, false);
});

test('api key in query', () => {
  const cfg = { enabled: true, method: 'apikey', apiKeyName: 'api_key', apiKeyLoc: 'query', token: 'key123' };
  assert.equal(verifyAuth(cfg, { query: { api_key: 'key123' } }).ok, true);
  assert.equal(verifyAuth(cfg, { query: {} }).ok, false);
});

test('basic auth', () => {
  const cfg = { enabled: true, method: 'basic', user: 'webhook', pass: 's3cret' };
  const good = 'Basic ' + Buffer.from('webhook:s3cret').toString('base64');
  const bad = 'Basic ' + Buffer.from('webhook:wrong').toString('base64');
  assert.equal(verifyAuth(cfg, { headers: { authorization: good } }).ok, true);
  assert.equal(verifyAuth(cfg, { headers: { authorization: bad } }).ok, false);
  assert.equal(verifyAuth(cfg, { headers: {} }).ok, false);
});

test('unconfigured credentials never match an empty presented value (fail closed)', () => {
  // A freshly-enabled auth method with no credential typed in yet must reject
  // every request — including one that (accidentally or by an attacker's
  // probing) presents an equally-empty value, which safeEqual('', '') would
  // otherwise treat as a match.
  const bearer = { enabled: true, method: 'bearer', token: '' };
  assert.equal(verifyAuth(bearer, { headers: { authorization: 'Bearer ' } }).ok, false);
  assert.equal(verifyAuth(bearer, { headers: { authorization: 'Bearer x' } }).ok, false);

  const apikey = { enabled: true, method: 'apikey', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', token: '' };
  assert.equal(verifyAuth(apikey, { headers: { 'x-api-key': '' } }).ok, false);
  assert.equal(verifyAuth(apikey, { headers: {} }).ok, false);

  const apikeyQuery = { enabled: true, method: 'apikey', apiKeyName: 'key', apiKeyLoc: 'query', token: '' };
  assert.equal(verifyAuth(apikeyQuery, { query: { key: '' } }).ok, false);

  const basic = { enabled: true, method: 'basic', user: '', pass: '' };
  const emptyCreds = 'Basic ' + Buffer.from(':').toString('base64');
  assert.equal(verifyAuth(basic, { headers: { authorization: emptyCreds } }).ok, false);

  // Half-configured (only a username, no password yet) must also reject —
  // not just the both-empty case — since the empty half is still guessable.
  const halfBasic = { enabled: true, method: 'basic', user: 'svc', pass: '' };
  const svcEmptyPass = 'Basic ' + Buffer.from('svc:').toString('base64');
  assert.equal(verifyAuth(halfBasic, { headers: { authorization: svcEmptyPass } }).ok, false);
});

test('failStatus clamps to valid range', () => {
  assert.equal(failStatus({ failStatus: '403' }), 403);
  assert.equal(failStatus({ failStatus: 'garbage' }), 401);
  assert.equal(failStatus({}), 401);
});
