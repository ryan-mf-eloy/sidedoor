// Ingest dispatch. Every request to the funnel-exposed port lands here: resolve
// the endpoint by its first path segment (globally-unique slug), read the body,
// and hand off to the webhook or mock pipeline.
import { tryParse } from '../lib/json.js';
import { handleWebhook } from './webhook.js';
import { handleMock } from './mock.js';

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > cap) { tooLarge = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ raw: tooLarge ? '' : Buffer.concat(chunks).toString('utf8'), size, tooLarge }));
    req.on('error', () => resolve({ raw: '', size, tooLarge }));
  });
}

export function createIngestHandler(ctx) {
  return async (req, res) => {
    const respond = (status, headers, body) => {
      if (res.writableEnded) return;
      const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Allow,Retry-After', ...(headers || {}) };
      res.writeHead(status, h);
      res.end(body == null ? undefined : body);
    };

    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return respond(400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'bad request' })); }

    // CORS preflight — answered without capture.
    if (req.method === 'OPTIONS') {
      return respond(204, {
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,QUERY,OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
        'Access-Control-Max-Age': '600',
      });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return respond(200, { 'Content-Type': 'application/json' }, JSON.stringify({ service: 'sidedoor-ingest', hint: 'POST to /<slug>' }));
    }

    const slug = segments[0];
    const ep = ctx.store.getEndpointBySlug(slug);
    if (!ep) {
      return respond(404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'no endpoint for /' + slug }));
    }

    const { raw, size, tooLarge } = await readBody(req, ctx.config.maxBodyBytes);
    if (tooLarge) {
      return respond(413, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'payload too large' }));
    }

    const bodyObj = tryParse(raw).value;
    const rc = {
      method: req.method,
      path: url.pathname,
      subpath: '/' + segments.slice(1).join('/'),
      headers: req.headers,
      query: Object.fromEntries(url.searchParams.entries()),
      rawBody: raw,
      bodyObj: bodyObj !== undefined && typeof bodyObj === 'object' ? bodyObj : (bodyObj !== undefined ? bodyObj : undefined),
      ip: clientIp(req),
      size,
      contentType: req.headers['content-type'] || null,
    };

    try {
      if (ep.type === 'mock') await handleMock(ctx, ep, rc, respond);
      else await handleWebhook(ctx, ep, rc, respond);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[sidedoor] ingest error:', e && e.stack || e);
      respond(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'ingest error' }));
    }
  };
}

export function clampStatus(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : dflt;
}
