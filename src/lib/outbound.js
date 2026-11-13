// Executes one outbound scenario-event request. All request construction is
// deterministic and validates before fetch, so a bad template/configuration
// is visible in history without ever opening a network connection.
import { buildOutboundHmacHeaders } from './hmac.js';
import { EventConfigError, isRetryableDelivery, redactEventUrl, redactHeaders, redactResponseBody, validateHeader, validateRenderedEventUrl } from './eventConfig.js';
import { renderEventTemplate } from './eventTemplate.js';

const RESPONSE_BODY_LIMIT = 40_000;

function findHeader(headers, name) {
  return Object.keys(headers).find((key) => key.toLowerCase() === String(name).toLowerCase());
}

function addAuth(url, headers, auth) {
  if (!auth || !auth.enabled || auth.method === 'none') return url;
  if (auth.method === 'bearer') {
    headers[auth.header || 'Authorization'] = `Bearer ${auth.token}`;
    return url;
  }
  if (auth.method === 'basic') {
    headers[auth.header || 'Authorization'] = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
    return url;
  }
  if (auth.method === 'apikey') {
    if (auth.apiKeyLoc === 'query') {
      const parsed = new URL(url);
      parsed.searchParams.set(auth.apiKeyName || 'X-Api-Key', auth.token);
      return parsed.toString();
    }
    headers[auth.apiKeyName || 'X-Api-Key'] = auth.token;
  }
  return url;
}

function redactOutboundUrl(url, auth) {
  try {
    const parsed = new URL(url);
    // An API-key name is configurable, so a generic key-name heuristic is
    // not enough to prevent this generated credential from entering history.
    if (auth && auth.enabled && auth.method === 'apikey' && auth.apiKeyLoc === 'query') {
      parsed.searchParams.set(auth.apiKeyName || 'X-Api-Key', '••••••');
    }
    return redactEventUrl(parsed.toString());
  } catch {
    return redactEventUrl(url);
  }
}

function redactOutboundHeaders(headers, auth, hmacHeaders) {
  const safe = redactHeaders(headers);
  const mask = (name) => {
    const actual = findHeader(headers, name);
    if (actual) safe[actual] = '••••••';
  };
  if (auth && auth.enabled) {
    if (auth.method === 'bearer' || auth.method === 'basic') mask(auth.header || 'Authorization');
    if (auth.method === 'apikey' && auth.apiKeyLoc !== 'query') mask(auth.apiKeyName || 'X-Api-Key');
  }
  for (const name of Object.keys(hmacHeaders || {})) mask(name);
  return safe;
}

export function buildOutboundEventRequest(event, context, now = Date.now()) {
  const request = event && event.request;
  if (!request) throw new EventConfigError('Event request configuration is missing');
  const renderedUrl = renderEventTemplate(request.url, context);
  const parsedUrl = validateRenderedEventUrl(renderedUrl, request.origin);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers || {})) {
    const [safeName, safeValue] = validateHeader(name, renderEventTemplate(value, context));
    headers[safeName] = safeValue;
  }
  const payload = renderEventTemplate(request.payload || '', context);
  if (request.contentType && !findHeader(headers, 'content-type')) headers['Content-Type'] = request.contentType;
  const method = String(request.method || 'POST').toUpperCase();
  const omitBody = method === 'GET' || method === 'HEAD';
  const sentBody = omitBody ? '' : payload;
  const target = addAuth(parsedUrl.toString(), headers, request.auth);
  const hmacHeaders = buildOutboundHmacHeaders(request.hmac, { body: sentBody, now });
  Object.assign(headers, hmacHeaders);
  return {
    url: target,
    method,
    headers,
    body: omitBody ? undefined : payload,
    timeoutMs: Number(request.timeoutMs) || 10_000,
    safeUrl: redactOutboundUrl(target, request.auth),
    safeHeaders: redactOutboundHeaders(headers, request.auth, hmacHeaders),
  };
}

function safeError(error, timedOut, unsafeUrl = '', safeUrl = '') {
  if (timedOut) return 'Request timed out';
  if (error && error.name === 'AbortError') return 'Request aborted';
  let message = String(error && error.message || error || 'Request failed');
  if (unsafeUrl) message = message.split(unsafeUrl).join(safeUrl || '[redacted URL]');
  return message.slice(0, 1_000);
}

export async function sendOutboundEvent(event, context, { fetchImpl = globalThis.fetch, signal, now = Date.now } = {}) {
  const startedAt = now();
  let built;
  try {
    built = buildOutboundEventRequest(event, context, startedAt);
  } catch (error) {
    return {
      ok: false, retryable: false, kind: 'configuration', error: safeError(error, false), durationMs: now() - startedAt,
      requestUrl: null, requestMethod: event && event.request && event.request.method || null,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, built.timeoutMs);
  try {
    const response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      // Do not follow redirects. Keeping the response visible lets the
      // retry classifier treat 3xx as the required final delivery failure.
      redirect: 'manual',
      signal: controller.signal,
    });
    const responseHeaders = {};
    response.headers.forEach((value, name) => { responseHeaders[name] = value; });
    let responseBody = '';
    try { responseBody = redactResponseBody((await response.text()).slice(0, RESPONSE_BODY_LIMIT)); } catch { responseBody = ''; }
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok, retryable: !ok && isRetryableDelivery(response.status), kind: ok ? 'succeeded' : 'response',
      status: response.status, responseHeaders: redactHeaders(responseHeaders), responseBody,
      requestUrl: built.safeUrl, requestMethod: built.method, durationMs: now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false, retryable: true, kind: 'network', error: safeError(error, timedOut, built.url, built.safeUrl),
      requestUrl: built.safeUrl, requestMethod: built.method, durationMs: now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
