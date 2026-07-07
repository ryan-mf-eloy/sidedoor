import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffSummary } from '../src/lib/diff.js';

test('identical inputs are all context', () => {
  const rows = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.type === 'ctx'));
  assert.deepEqual(diffSummary(rows), { add: 0, del: 0 });
});

test('detects an added line', () => {
  const rows = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(diffSummary(rows), { add: 1, del: 0 });
  const added = rows.find((r) => r.type === 'add');
  assert.equal(added.text, 'b');
  assert.equal(added.an, '');
  assert.equal(added.bn, 2);
});

test('detects a deleted line', () => {
  const rows = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(diffSummary(rows), { add: 0, del: 1 });
  assert.equal(rows.find((r) => r.type === 'del').text, 'b');
});

test('changed line = del + add', () => {
  const rows = diffLines('x: 1', 'x: 2');
  const s = diffSummary(rows);
  assert.equal(s.add, 1);
  assert.equal(s.del, 1);
});

test('line numbering stays consistent', () => {
  const rows = diffLines('a\nb', 'a\nB\nc');
  // a(ctx an1/bn1), b->B (del an2, add bn2), c(add bn3)
  const ctx = rows.filter((r) => r.type === 'ctx');
  assert.equal(ctx[0].an, 1);
  assert.equal(ctx[0].bn, 1);
});
