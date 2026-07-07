import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryParse, safeParse, isJSONValid, pretty, getPath, toColumn } from '../src/lib/json.js';
import { slugify, newId } from '../src/lib/ids.js';

test('tryParse / safeParse', () => {
  assert.deepEqual(tryParse('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(tryParse('nope').ok, false);
  assert.deepEqual(safeParse('bad', { d: 1 }), { d: 1 });
  assert.deepEqual(safeParse('[1,2]', null), [1, 2]);
});

test('isJSONValid (empty is valid)', () => {
  assert.equal(isJSONValid(''), true);
  assert.equal(isJSONValid('   '), true);
  assert.equal(isJSONValid('{"a":1}'), true);
  assert.equal(isJSONValid('{bad'), false);
});

test('pretty formats strings and objects', () => {
  assert.equal(pretty('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(pretty({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(pretty('not json'), 'not json');
});

test('getPath dot navigation', () => {
  assert.equal(getPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(getPath({ a: 1 }, 'a.b'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});

test('toColumn serializes', () => {
  assert.equal(toColumn(null), null);
  assert.equal(toColumn('str'), 'str');
  assert.equal(toColumn({ a: 1 }), '{"a":1}');
});

test('slugify', () => {
  assert.equal(slugify('Stripe Prod!'), 'stripe-prod');
  assert.equal(slugify('  --Hello__World--  '), 'hello-world');
  assert.equal(slugify(''), '');
});

test('newId is unique-ish and prefixed', () => {
  const a = newId('ep'), b = newId('ep');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('ep-'));
});
