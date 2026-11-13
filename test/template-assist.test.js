import assert from 'node:assert/strict';
import test from 'node:test';
import { renderScenarioBody } from '../src/lib/mockPath.js';
import { buildEventContext, eventTemplateExamples, renderEventTemplate } from '../src/lib/eventTemplate.js';
import { templateExamples, templateSuggestions } from '../src/lib/templateCatalog.js';
import { activeTemplateAt, contextualTemplateSuggestions, dynamicTemplateSuggestion, filterTemplateSuggestions, insertTemplateSuggestion } from '../public/template-assist.js';

test('template catalog stays aligned with the runtime contexts it advertises', () => {
  assert.deepEqual(eventTemplateExamples(), templateExamples('event'));
  assert.equal(templateSuggestions('event').length, 12);
  assert.equal(templateSuggestions('mockResponse').length, 7);

  const context = { subpath: '/1/sales/pay_123', bodyObj: { MerchantOrderId: 'order_123' } };
  for (const suggestion of templateSuggestions('mockResponse')) {
    const rendered = renderScenarioBody(suggestion.token, context);
    assert.equal(rendered.includes('{{'), false, `${suggestion.token} must be rendered by mock responses`);
  }
});

test('autocomplete detects the unfinished expression at the caret and ranks contextual matches', () => {
  const value = '{"id":"{{response.bo"}';
  const caret = value.indexOf('{{response.bo') + '{{response.bo'.length;
  assert.deepEqual(activeTemplateAt(value, caret), {
    start: value.indexOf('{{'), end: caret, query: 'response.bo',
  });
  assert.equal(activeTemplateAt('{{request.path}} next', '{{request.path}}'.length + 1), null);

  const suggestions = filterTemplateSuggestions(templateSuggestions('event'), 'response body');
  assert.equal(suggestions[0].token, '{{response.body}}');
  assert.equal(suggestions[1].token, '{{response.body.field}}');
});

test('autocomplete replaces a partial token and selects an editable placeholder', () => {
  const suggestion = templateSuggestions('event').find((item) => item.token === '{{response.body.field}}');
  const source = '{"id":"{{response.bo"}';
  const caret = source.indexOf('{{response.bo') + '{{response.bo'.length;
  const inserted = insertTemplateSuggestion(source, caret, caret, suggestion);

  assert.equal(inserted.value, '{"id":"{{response.body.field}}"}');
  assert.equal(inserted.selectionStart, inserted.value.indexOf('field'));
  assert.equal(inserted.selectionEnd, inserted.selectionStart + 'field'.length);

  const randomUuid = templateSuggestions('event').find((item) => item.token === '{{randomUuid}}');
  const plain = insertTemplateSuggestion('prefix ', 7, 7, randomUuid);
  assert.deepEqual(plain, { value: 'prefix {{randomUuid}}', selectionStart: 21, selectionEnd: 21 });
});

test('autocomplete completes dynamic headers and JSON paths that are not in the catalog', () => {
  const eventSuggestions = templateSuggestions('event');
  const header = dynamicTemplateSuggestion(eventSuggestions, 'request.headers.x-tenant-id');
  assert.deepEqual(header, {
    token: '{{request.headers.x-tenant-id}}',
    group: 'Complete your value',
    label: 'Custom request header',
    description: 'Use the header you typed; it does not need to be listed.',
    custom: true,
  });

  const bodyPath = dynamicTemplateSuggestion(eventSuggestions, 'response.body.order.reference');
  assert.equal(bodyPath.token, '{{response.body.order.reference}}');
  assert.equal(bodyPath.label, 'Custom response body field');
  assert.equal(dynamicTemplateSuggestion(eventSuggestions, 'request.headers.'), null);
  assert.equal(dynamicTemplateSuggestion(eventSuggestions, 'request.headers.x tenant'), null);
  assert.equal(dynamicTemplateSuggestion(eventSuggestions, 'unknown.value'), null);

  const ranked = contextualTemplateSuggestions(eventSuggestions, 'request.headers.x-tenant-id');
  assert.equal(ranked[0].token, '{{request.headers.x-tenant-id}}');
  const source = '{{request.headers.x-tenant-id';
  const completed = insertTemplateSuggestion(source, source.length, source.length, ranked[0]);
  assert.deepEqual(completed, {
    value: '{{request.headers.x-tenant-id}}',
    selectionStart: '{{request.headers.x-tenant-id}}'.length,
    selectionEnd: '{{request.headers.x-tenant-id}}'.length,
  });

  const rendered = renderEventTemplate(`${header.token} ${bodyPath.token}`, buildEventContext({
    request: { headers: { 'X-Tenant-Id': 'tenant_42' } },
    response: { body: { order: { reference: 'order_42' } } },
  }));
  assert.equal(rendered, 'tenant_42 order_42');

  const mockBody = dynamicTemplateSuggestion(templateSuggestions('mockResponse'), '$body.Metadata.correlationId');
  assert.equal(mockBody.token, '{{$body.Metadata.correlationId}}');
  assert.equal(mockBody.label, 'Custom request body field');
  assert.equal(renderScenarioBody(mockBody.token, { bodyObj: { Metadata: { correlationId: 'corr_42' } } }), 'corr_42');
});
