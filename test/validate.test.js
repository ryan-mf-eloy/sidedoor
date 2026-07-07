import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInspector, validateMock, isEmpty } from '../src/lib/validate.js';

test('inspector validation', () => {
  assert.ok(isEmpty(validateInspector({ name: 'Stripe', slug: 'stripe-prod' }, [])));
  assert.equal(validateInspector({ name: '', slug: 'x' }, []).name, 'Enter a name for this endpoint');
  assert.ok(validateInspector({ name: 'a', slug: '' }, []).slug);
  assert.ok(validateInspector({ name: 'a', slug: 'Bad Slug' }, []).slug); // uppercase/space
  assert.ok(validateInspector({ name: 'a', slug: 'taken' }, ['taken']).slug); // duplicate
});

test('mock validation', () => {
  assert.ok(isEmpty(validateMock({ name: 'Pay', path: '/v1/charges', status: 200, body: '{"ok":true}' })));
  assert.ok(validateMock({ name: '', path: '/x', status: 200, body: '{}' }).name);
  assert.ok(validateMock({ name: 'a', path: 'no-slash', status: 200, body: '{}' }).path);
  assert.ok(validateMock({ name: 'a', path: '/x', status: 99, body: '{}' }).status);
  assert.ok(validateMock({ name: 'a', path: '/x', status: 700, body: '{}' }).status);
  assert.ok(validateMock({ name: 'a', path: '/x', status: 200, body: '{bad json' }).body);
  assert.ok(isEmpty(validateMock({ name: 'a', path: '/x', status: 200, body: '' }))); // empty body ok
});
