// Public descriptions of the template values that the runtime resolves. Keep
// this catalog close to the renderers so the UI never advertises a token that
// a delivery or mock response cannot actually use.

const event = [
  {
    token: '{{request.method}}', group: 'Incoming request', label: 'Request method',
    description: 'HTTP method received by the mock.',
  },
  {
    token: '{{request.path}}', group: 'Incoming request', label: 'Request path',
    description: 'Full path received by the mock.',
  },
  {
    token: '{{request.subpath}}', group: 'Incoming request', label: 'Matched subpath',
    description: 'Path after the mock endpoint slug.',
  },
  {
    token: '{{request.headers.header-name}}', example: '{{request.headers.x-request-id}}', placeholder: 'header-name', dynamicPrefix: 'request.headers.', dynamicLabel: 'Custom request header', dynamicKind: 'header', group: 'Incoming request', label: 'Request header',
    description: 'Value of a received header. Header names are case-insensitive.',
  },
  {
    token: '{{request.query.parameter}}', example: '{{request.query.orderId}}', placeholder: 'parameter', dynamicPrefix: 'request.query.', dynamicLabel: 'Custom query parameter', dynamicKind: 'query parameter', group: 'Incoming request', label: 'Query parameter',
    description: 'A query-string value from the incoming request.',
  },
  {
    token: '{{request.body}}', group: 'Incoming request', label: 'Raw request body',
    description: 'The complete incoming request body.',
  },
  {
    token: '{{request.body.field}}', example: '{{request.body.customer.id}}', placeholder: 'field', dynamicPrefix: 'request.body.', dynamicLabel: 'Custom request body field', dynamicKind: 'JSON field', group: 'Incoming request', label: 'Request body field',
    description: 'A nested JSON field from the incoming request body.',
  },
  {
    token: '{{response.status}}', group: 'Mock response', label: 'Response status',
    description: 'Status code returned by the mock scenario.',
  },
  {
    token: '{{response.headers.header-name}}', example: '{{response.headers.x-request-id}}', placeholder: 'header-name', dynamicPrefix: 'response.headers.', dynamicLabel: 'Custom response header', dynamicKind: 'header', group: 'Mock response', label: 'Response header',
    description: 'Value of a response header configured for this scenario.',
  },
  {
    token: '{{response.body}}', group: 'Mock response', label: 'Raw response body',
    description: 'The complete body returned by the mock scenario.',
  },
  {
    token: '{{response.body.field}}', example: '{{response.body.id}}', placeholder: 'field', dynamicPrefix: 'response.body.', dynamicLabel: 'Custom response body field', dynamicKind: 'JSON field', group: 'Mock response', label: 'Response body field',
    description: 'A nested JSON field from the mock response body.',
  },
  {
    token: '{{randomUuid}}', group: 'Generated', label: 'Random UUID',
    description: 'A new UUID generated when the template is rendered.',
  },
];

const mockResponse = [
  {
    token: '{{randomUuid}}', group: 'Generated', label: 'Random UUID',
    description: 'A new UUID generated for this mock response.',
  },
  {
    token: '{{pendingPaymentId}}', group: 'Payment presets', label: 'Pending payment ID',
    description: 'A generated ID with the pending payment prefix.',
  },
  {
    token: '{{paidPaymentId}}', group: 'Payment presets', label: 'Paid payment ID',
    description: 'A generated ID with the paid payment prefix.',
  },
  {
    token: '{{refundedPaymentId}}', group: 'Payment presets', label: 'Refunded payment ID',
    description: 'A generated ID with the refunded payment prefix.',
  },
  {
    token: '{{deniedPaymentId}}', group: 'Payment presets', label: 'Denied payment ID',
    description: 'A generated ID with the denied payment prefix.',
  },
  {
    token: '{{$pathPaymentId}}', group: 'Incoming request', label: 'Payment ID from path',
    description: 'The payment ID captured from a /1/sales/:id path.',
  },
  {
    token: '{{$body.field}}', example: '{{$body.MerchantOrderId}}', placeholder: 'field', dynamicPrefix: '$body.', dynamicLabel: 'Custom request body field', dynamicKind: 'JSON field', group: 'Incoming request', label: 'Request body field',
    description: 'A nested JSON field from the incoming request body.',
  },
];

export const TEMPLATE_CATALOG = Object.freeze({
  event: Object.freeze({
    title: 'Event variables',
    description: 'Values available after a mock has received a request and returned its response.',
    syntax: '{{variable}}',
    suggestions: Object.freeze(event.map((item) => Object.freeze(item))),
  }),
  mockResponse: Object.freeze({
    title: 'Response variables',
    description: 'Values available while Sidedoor renders a mock scenario response.',
    syntax: '{{variable}}',
    suggestions: Object.freeze(mockResponse.map((item) => Object.freeze(item))),
  }),
});

export function templateSuggestions(context) {
  return TEMPLATE_CATALOG[context] ? TEMPLATE_CATALOG[context].suggestions : [];
}

export function templateExamples(context) {
  return templateSuggestions(context).map((item) => item.example || item.token);
}

export function publicTemplateCatalog() {
  return TEMPLATE_CATALOG;
}
