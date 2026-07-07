// Admin REST client + SSE connection.
const BASE = '/__sd/api';

export async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.fields = data && data.fields;
    throw err;
  }
  return data;
}

export const get = (p) => req('GET', p);
export const post = (p, b) => req('POST', p, b);
export const patch = (p, b) => req('PATCH', p, b);
export const del = (p) => req('DELETE', p);

export function exportHref(path) { return BASE + path; }

// Subscribe to server-sent events. handlers = { request(fn), funnel(fn) }.
export function connectEvents(handlers) {
  let es;
  try { es = new EventSource(BASE + '/events'); } catch { return null; }
  for (const [ev, fn] of Object.entries(handlers)) {
    es.addEventListener(ev, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore */ } });
  }
  return es;
}
