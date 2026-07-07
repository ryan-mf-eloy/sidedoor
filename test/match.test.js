import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractField, compareOp, matchRule, resolveScenarioRule, evaluateForwarding } from '../src/lib/match.js';

const ctx = {
  method: 'POST',
  path: '/v1/charges',
  headers: { 'x-test-scenario': 'decline', 'content-type': 'application/json' },
  query: { mode: 'test', n: '5' },
  bodyObj: { amount: 100000, data: { object: { amount: 4990 } }, type: 'charge.succeeded' },
};

test('extractField across sources', () => {
  assert.equal(extractField('header', 'X-Test-Scenario', ctx), 'decline');
  assert.equal(extractField('query', 'mode', ctx), 'test');
  assert.equal(extractField('body', 'data.object.amount', ctx), 4990);
  assert.equal(extractField('method', null, ctx), 'POST');
  assert.equal(extractField('path', null, ctx), '/v1/charges');
  assert.equal(extractField('body', 'missing.key', ctx), undefined);
});

test('operators', () => {
  assert.equal(compareOp('equals', 'a', 'a'), true);
  assert.equal(compareOp('equals', 'a', 'b'), false);
  assert.equal(compareOp('≠', 'a', 'b'), true);
  assert.equal(compareOp('contains', 'hello world', 'world'), true);
  assert.equal(compareOp('contains', null, 'x'), false);
  assert.equal(compareOp('exists', 'x', ''), true);
  assert.equal(compareOp('exists', null, ''), false);
  assert.equal(compareOp('exists', '', ''), false);
  assert.equal(compareOp('regex', 'abc123', '^abc\\d+$'), true);
  assert.equal(compareOp('regex', 'x', '('), false); // invalid regex → false
  assert.equal(compareOp('>', 100000, '1000000'), false);
  assert.equal(compareOp('>', 2000000, '1000000'), true);
  assert.equal(compareOp('<', 5, '10'), true);
});

test('matchRule end-to-end', () => {
  assert.equal(matchRule({ when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline' }, ctx), true);
  assert.equal(matchRule({ when: 'body', key: 'amount', op: '>', value: '1000000' }, ctx), false);
  assert.equal(matchRule({ when: 'body', key: 'amount', op: '>', value: '50000' }, ctx), true);
});

test('resolveScenarioRule first-match wins', () => {
  const rules = [
    { id: 'r1', when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'approve', then: 'sc-ok' },
    { id: 'r2', when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline', then: 'sc-declined' },
  ];
  assert.deepEqual(resolveScenarioRule(rules, ctx), { scenarioId: 'sc-declined', ruleId: 'r2' });
  assert.equal(resolveScenarioRule([], ctx), null);
});

test('resolveScenarioRule skips disabled rules', () => {
  const rules = [
    { id: 'r1', enabled: false, when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline', then: 'sc-declined' },
    { id: 'r2', enabled: true, when: 'header', key: 'X-Test-Scenario', op: 'equals', value: 'decline', then: 'sc-declined-2' },
  ];
  // r1 matches but is disabled — must be skipped in favor of the next matching enabled rule.
  assert.deepEqual(resolveScenarioRule(rules, ctx), { scenarioId: 'sc-declined-2', ruleId: 'r2' });
  // a disabled rule with no enabled rule behind it must not fire at all.
  assert.equal(resolveScenarioRule([rules[0]], ctx), null);
});

test('evaluateForwarding any vs all', () => {
  const rules = [
    { id: 'a', enabled: true, field: 'body', key: 'type', op: 'equals', value: 'charge.succeeded', action: 'forward' },
    { id: 'b', enabled: true, field: 'header', key: 'x-livemode', op: 'equals', value: 'false', action: 'drop' },
    { id: 'c', enabled: false, field: 'path', key: '', op: 'equals', value: '/x', action: 'respond' },
  ];
  // 'any' → first enabled matching rule (a matches)
  assert.equal(evaluateForwarding(rules, 'any', ctx).id, 'a');
  // 'all' → not every enabled rule matches (b fails), so null
  assert.equal(evaluateForwarding(rules, 'all', ctx), null);
  // 'all' where every enabled matches → first
  const rules2 = [{ id: 'a', enabled: true, field: 'method', key: '', op: 'equals', value: 'POST', action: 'forward' }];
  assert.equal(evaluateForwarding(rules2, 'all', ctx).id, 'a');
  assert.equal(evaluateForwarding([], 'any', ctx), null);
});
