// Rendering for asynchronous scenario-event templates. Event templates are
// intentionally separate from mock-response templates: they have a stable,
// documented context and fail closed when a value cannot be resolved.
import { randomUUID } from 'node:crypto';
import { templateExamples } from './templateCatalog.js';

export class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TemplateError';
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseBody(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return undefined; }
}

function normalizedHeaders(headers) {
  return Object.fromEntries(Object.entries(asObject(headers)).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function getPath(value, path) {
  if (!path) return { found: true, value };
  let current = value;
  for (const part of path.split('.')) {
    if (!part || current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function stringifyValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Build the immutable data shape stored with a run. Raw bodies are kept so a
// template can opt into exact bytes; parsed bodies are derived only for lookup.
export function buildEventContext({ request = {}, response = {} } = {}) {
  const requestBody = request.body == null ? '' : (typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
  const responseBody = response.body == null ? '' : (typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  return {
    request: {
      method: String(request.method || 'POST').toUpperCase(),
      path: String(request.path || '/'),
      subpath: String(request.subpath || request.path || '/'),
      headers: normalizedHeaders(request.headers),
      query: asObject(request.query),
      body: requestBody,
      bodyJson: request.bodyJson !== undefined ? request.bodyJson : parseBody(requestBody),
    },
    response: {
      status: Number(response.status) || 200,
      headers: normalizedHeaders(response.headers),
      body: responseBody,
      bodyJson: response.bodyJson !== undefined ? response.bodyJson : parseBody(responseBody),
    },
  };
}

function resolveExpression(expression, context) {
  const token = String(expression || '').trim();
  if (token === 'randomUuid') return randomUUID();

  const sections = token.split('.');
  const root = sections.shift();
  if (root !== 'request' && root !== 'response') throw new TemplateError(`Unknown template variable "${token}"`);

  const section = sections.shift();
  if (!section) throw new TemplateError(`Unknown template variable "${token}"`);
  const data = context[root] || {};

  if (section === 'body') {
    if (!sections.length) return stringifyValue(data.body);
    const resolved = getPath(data.bodyJson, sections.join('.'));
    if (!resolved.found) throw new TemplateError(`Unknown template variable "${token}"`);
    return stringifyValue(resolved.value);
  }

  if (section === 'headers') {
    if (!sections.length) throw new TemplateError(`Unknown template variable "${token}"`);
    const header = data.headers && data.headers[sections.join('.').toLowerCase()];
    if (header === undefined) throw new TemplateError(`Unknown template variable "${token}"`);
    return stringifyValue(header);
  }

  if (section === 'query') {
    if (!sections.length) throw new TemplateError(`Unknown template variable "${token}"`);
    const resolved = getPath(data.query, sections.join('.'));
    if (!resolved.found) throw new TemplateError(`Unknown template variable "${token}"`);
    return stringifyValue(resolved.value);
  }

  if (sections.length) throw new TemplateError(`Unknown template variable "${token}"`);
  if (!Object.prototype.hasOwnProperty.call(data, section)) throw new TemplateError(`Unknown template variable "${token}"`);
  return stringifyValue(data[section]);
}

export function renderEventTemplate(template, context) {
  const source = template == null ? '' : String(template);
  let sawTemplate = false;
  const rendered = source.replace(/\{\{([^{}]+)\}\}/g, (_whole, expression) => {
    sawTemplate = true;
    return resolveExpression(expression, context);
  });
  if (rendered.includes('{{') || rendered.includes('}}')) {
    throw new TemplateError('Invalid template syntax');
  }
  return sawTemplate ? rendered : source;
}

export function eventTemplateExamples() {
  return templateExamples('event');
}
