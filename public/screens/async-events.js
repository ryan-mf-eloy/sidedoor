// Async scenario-event configuration and delivery-history UI for Mock Servers.
import { h, raw, codeBlock, codeEditor, icons, jsonEditor, select, templateInput, templateSuggestionsFor, toggle, fmtClock, fmtStamp, statusColor } from '../ui.js';

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'QUERY'].map((value) => ({ value, label: value }));
const AUTH_METHODS = [{ value: 'none', label: 'No authentication' }, { value: 'bearer', label: 'Bearer token' }, { value: 'apikey', label: 'API key' }, { value: 'basic', label: 'Basic authentication' }];
const HMAC_PROVIDERS = [{ value: 'stripe', label: 'Stripe' }, { value: 'github', label: 'GitHub' }, { value: 'shopify', label: 'Shopify' }, { value: 'twilio', label: 'Twilio' }, { value: 'slack', label: 'Slack' }, { value: 'custom', label: 'Custom HMAC' }];

const surface = 'background:#191712;border-radius:var(--radius-sm)';
const inputStyle = "width:100%;background:#0f0e0b;border-radius:var(--radius-xs);padding:9px 11px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.08);font-size:12.5px;color:#e8e2d7;font-family:'IBM Plex Mono',monospace";
const sectionLabelStyle = 'font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#746d62;margin-bottom:7px';

function field(label, control, full = false) {
  return h('div', { style: full ? 'grid-column:1/-1;min-width:0' : 'min-width:0' }, h('div', { style: sectionLabelStyle }, label), control);
}

function input(value, placeholder, onInput, opts = {}) {
  if (Array.isArray(opts.templateSuggestions) && opts.templateSuggestions.length) {
    return templateInput(value, placeholder, onInput, { ...opts, templateSuggestions: opts.templateSuggestions, style: inputStyle });
  }
  return h('input', {
    value: value == null ? '' : value, placeholder, type: opts.type || 'text',
    style: inputStyle + (opts.color ? `;color:${opts.color}` : ''),
    oninput: (event) => onInput(event.target.value),
  });
}

function payloadLanguage(contentType) {
  if (/json/i.test(contentType || '')) return 'json';
  if (/xml/i.test(contentType || '')) return 'xml';
  if (/html/i.test(contentType || '')) return 'html';
  return 'text';
}

function statusTone(status) {
  if (status === 'completed' || status === 'succeeded') return { color: '#7fc79b', bg: '#142018' };
  if (status === 'failed' || status === 'completed_with_failures' || status === 'configuration') return { color: '#e08b7f', bg: '#241512' };
  if (status === 'cancelled') return { color: '#948d83', bg: '#201c17' };
  if (status === 'running') return { color: '#d69a3c', bg: '#241d11' };
  return { color: '#78a8df', bg: '#151d26' };
}

function statusPill(status) {
  const tone = statusTone(status);
  return h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.04em;color:${tone.color};background:${tone.bg};border-radius:var(--radius-xs);padding:3px 7px;white-space:nowrap` }, String(status || 'scheduled').replaceAll('_', ' ').toUpperCase());
}

function compactSchedule(event) {
  const s = event.schedule || {};
  const bits = [s.delayMs ? `${s.delayMs}ms delay` : 'immediate'];
  if (Number(s.repeatCount) > 1) bits.push(`${s.repeatCount} sends`);
  if (Number(s.retryCount) > 0) bits.push(`${s.retryCount} retries`);
  return bits.join(' · ');
}

function moveButton(direction, disabled, onClick) {
  const path = direction === 'up' ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6';
  return h('button', {
    title: disabled ? undefined : (direction === 'up' ? 'Move event up' : 'Move event down'), disabled,
    style: `width:24px;height:21px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:transparent;color:${disabled ? '#3a342b' : '#746d62'};padding:0`,
    onclick: disabled ? undefined : onClick,
  }, raw(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`));
}

export function scenarioEventsPanel(app, scenario) {
  const events = (scenario.events || []).slice().sort((a, b) => a.position - b.position);
  const header = h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin:22px 0 11px;flex-wrap:wrap' },
    h('div', {},
      h('h3', { style: 'margin:0;font-size:13.5px;font-weight:600;color:#d7d0c5' }, 'Async events'),
      h('p', { style: 'margin:4px 0 0;font-size:11.5px;line-height:1.45;color:#7a746a;max-width:530px' }, 'Run after a valid mock response. Events are serial, preserve this order, and continue after a final failure.')),
    h('div', { style: 'display:flex;align-items:center;gap:7px;flex-wrap:wrap' },
      h('button', { style: 'background:#211d17;color:#c9c2b6;border-radius:var(--radius-xs);padding:7px 10px;font-size:11.5px;font-weight:600', onclick: () => app.openEventTest(scenario.id) }, raw(icons.replay({ w: 14, sw: 1.8 })), ' Run test flow'),
      h('button', { style: 'display:flex;align-items:center;gap:6px;background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:7px 10px;font-size:11.5px;font-weight:700', onclick: () => app.openAddScenarioEvent(scenario.id) }, raw(icons.plus({ w: 13, sw: 2 })), 'Add event')));
  if (!events.length) {
    return h('div', {}, header, h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:17px 15px;text-align:center;color:#7a746a;font-size:12px' }, 'No async events yet. Add one to notify another API after this response.'));
  }
  return h('div', {}, header, h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, ...events.map((event, index) => eventCard(app, event, index, events.length))));
}

function eventCard(app, event, index, total) {
  const request = event.request || {};
  const card = h('div', { style: `${surface};display:flex;align-items:center;gap:10px;padding:11px 12px;flex-wrap:wrap;opacity:${event.enabled ? 1 : .55}` },
    h('div', { style: 'display:flex;flex-direction:column;gap:1px' },
      moveButton('up', index === 0, () => app.moveScenarioEvent(event.id, 'up')),
      moveButton('down', index === total - 1, () => app.moveScenarioEvent(event.id, 'down'))),
    h('span', { style: 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:#221d17;color:#7fc79b;font-family:IBM Plex Mono,monospace;font-size:11px;font-weight:700;flex-shrink:0' }, String(index + 1)),
    h('div', { style: 'min-width:0;flex:1;cursor:pointer', onclick: () => app.openEditScenarioEvent(event) },
      h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0' },
        h('span', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, event.name),
        h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:#8fb98a;background:#142018;border-radius:var(--radius-xs);padding:2px 6px" }, request.method || 'POST')),
      h('div', { style: "margin-top:3px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#8a837a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" }, request.url || 'No destination configured'),
      h('div', { style: 'margin-top:4px;font-size:10.5px;color:#6f685e' }, compactSchedule(event))),
    toggle(!!event.enabled, () => app.toggleScenarioEvent(event)),
    h('button', { title: 'Edit async event', style: 'width:27px;height:27px;display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-xs)', onclick: () => app.openEditScenarioEvent(event) }, raw(icons.edit({ w: 14, sw: 1.8 }))),
    h('button', { title: 'Delete async event', style: 'width:27px;height:27px;display:flex;align-items:center;justify-content:center;background:transparent;color:#6a655c;border-radius:var(--radius-xs)', onclick: () => app.deleteScenarioEvent(event.id) }, raw(icons.trash({ w: 14, sw: 1.8 }))));
  return card;
}

function previewTemplate(value) {
  const lookup = {
    'request.method': 'POST', 'request.path': '/orders/ord_preview', 'request.subpath': '/orders/ord_preview',
    'request.query.ref': 'preview-ref', 'request.headers.x-request-id': 'preview-request',
    'request.body.order.id': 'ord_preview', 'request.body.id': 'ord_preview',
    'response.status': '202', 'response.body.id': 'mock_preview', 'response.body.state': 'accepted', 'randomUuid': 'preview-uuid',
  };
  return String(value || '').replace(/\{\{([^{}]+)\}\}/g, (_all, key) => lookup[key.trim()] || `<${key.trim()}>`);
}

function safeHeaderPreview(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Headers must be a JSON object';
    return Object.entries(parsed).map(([key, value]) => `${key}: ${previewTemplate(value)}`).join('\n') || 'No custom headers';
  } catch {
    return 'Headers JSON is invalid';
  }
}

export function eventEditorDialog(app) {
  const editor = app.s.eventEditor;
  if (!editor) return null;
  const request = editor.request;
  const auth = request.auth;
  const hmac = request.hmac;
  const schedule = editor.schedule;
  const eventVariables = templateSuggestionsFor(app, 'event');
  const grid = (children) => h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:11px;align-items:start' }, ...children);
  const section = (title, description, children) => h('section', { style: `${surface};padding:16px;display:flex;flex-direction:column;gap:12px` },
    h('div', {}, h('div', { style: 'font-size:13px;font-weight:600;color:#e8e2d7' }, title), h('div', { style: 'font-size:11.5px;line-height:1.45;color:#7a746a;margin-top:3px' }, description)), children);
  const authDetails = !auth.enabled ? null : auth.method === 'bearer'
    ? field('Bearer token', input(auth.token, 'Token for the destination', (value) => app.setScenarioEventField('request.auth.token', value)), true)
    : auth.method === 'apikey'
      ? grid([
        field('Key name', input(auth.apiKeyName, 'X-Api-Key', (value) => app.setScenarioEventField('request.auth.apiKeyName', value))),
        field('Location', select(app.selectHelper('async-auth-location', auth.apiKeyLoc, [{ value: 'header', label: 'HTTP header' }, { value: 'query', label: 'Query parameter' }], (value) => app.setScenarioEventField('request.auth.apiKeyLoc', value)))),
        field('API key value', input(auth.token, 'Destination API key', (value) => app.setScenarioEventField('request.auth.token', value), { type: 'password' }), true),
      ])
      : auth.method === 'basic'
        ? grid([
          field('Username', input(auth.user, 'service-account', (value) => app.setScenarioEventField('request.auth.user', value))),
          field('Password', input(auth.pass, 'Password', (value) => app.setScenarioEventField('request.auth.pass', value), { type: 'password' })),
        ]) : null;
  const hmacDetails = !hmac.enabled ? null : grid([
    field('Provider preset', select(app.selectHelper('async-hmac-provider', hmac.provider, HMAC_PROVIDERS, (value) => app.setScenarioHmacProvider(value)))),
    field('Signing secret', input(hmac.secret, 'Shared signing secret', (value) => app.setScenarioEventField('request.hmac.secret', value), { type: 'password' })),
    field('Signature header', input(hmac.header, 'X-Signature', (value) => app.setScenarioEventField('request.hmac.header', value))),
    field('Algorithm', select(app.selectHelper('async-hmac-algo', hmac.algo, [{ value: 'sha256', label: 'SHA-256' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha384', label: 'SHA-384' }, { value: 'sha512', label: 'SHA-512' }], (value) => app.setScenarioEventField('request.hmac.algo', value)))),
    field('Encoding', select(app.selectHelper('async-hmac-encoding', hmac.encoding, [{ value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }, { value: 'base64url', label: 'Base64 URL' }], (value) => app.setScenarioEventField('request.hmac.encoding', value)))),
  ]);
  const overlay = h('div', { style: 'position:fixed;inset:0;z-index:120;background:rgba(8,7,5,.8);display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;animation:sd-scrim .14s ease', onclick: (event) => { if (event.target === overlay) app.closeScenarioEventEditor(); } });
  const panel = h('div', { style: 'width:min(980px,100%);margin:auto;background:#15130f;border-radius:var(--radius-md);box-shadow:0 28px 80px rgba(0,0,0,.62);overflow:hidden;animation:sd-pop .16s ease' },
    h('div', { style: 'display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-bottom:1px solid #28231c' },
      h('span', { style: 'width:34px;height:34px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;background:#1f1b15;color:#7fc79b;flex-shrink:0' }, raw(icons.webhook({ w: 17, sw: 1.9 }))),
      h('div', { style: 'flex:1' }, h('div', { style: 'font-size:16px;font-weight:600;color:#f2ede3' }, editor.id ? 'Edit async event' : 'New async event'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:3px' }, 'Saved configuration is snapshotted when a mock response schedules a run.')),
      h('button', { title: 'Close editor', style: 'width:30px;height:30px;background:#211d17;color:#a49c91;border-radius:var(--radius-xs);display:flex;align-items:center;justify-content:center', onclick: app.closeScenarioEventEditor }, raw(icons.x({ w: 15, sw: 1.9 })))),
    h('div', { style: 'padding:18px 20px 20px;display:flex;flex-direction:column;gap:13px' },
      grid([
        field('Event name', input(editor.name, 'e.g. Send payment notification', (value) => app.setScenarioEventField('name', value)), true),
      ]),
      section('Request', 'Use HTTP/HTTPS only. Templates can vary path/query, headers and payload, never the destination origin. Select Variables or type {{ to browse compatible values.', grid([
        field('Destination URL', input(request.url, 'https://api.example.com/events/{{response.body.id}}', (value) => app.setScenarioEventField('request.url', value), { templateSuggestions: eventVariables }), true),
        field('Method', select(app.selectHelper('async-method', request.method, METHODS, (value) => app.setScenarioEventField('request.method', value)))),
        field('Content-Type', input(request.contentType, 'application/json', (value) => app.setScenarioEventField('request.contentType', value))),
        field('Timeout (ms)', input(request.timeoutMs, '10000', (value) => app.setScenarioEventField('request.timeoutMs', value))),
        field('Headers (JSON)', codeEditor(editor.headersText, 4, (value) => app.setScenarioEventField('headersText', value), { language: 'json', templateSuggestions: eventVariables }), true),
        field('Payload template', codeEditor(request.payload, 5, (value) => app.setScenarioEventField('request.payload', value), { language: payloadLanguage(request.contentType), templateSuggestions: eventVariables }), true),
      ])),
      section('Authentication', 'Credentials are sent only to this fixed destination and never appear in delivery history.', h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { style: 'display:flex;align-items:center;gap:12px;background:#141210;border-radius:var(--radius-xs);padding:11px 12px' }, h('div', { style: 'flex:1' }, h('div', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7' }, 'Authenticate this callback'), h('div', { style: 'font-size:11px;color:#7a746a;margin-top:2px' }, 'Bearer token, API key, or Basic authentication')), toggle(!!auth.enabled, () => { app.setScenarioEventField('request.auth.enabled', !auth.enabled); app.rerender(); })),
        auth.enabled ? h('div', { style: 'display:flex;flex-direction:column;gap:11px' }, field('Method', select(app.selectHelper('async-auth-method', auth.method, AUTH_METHODS, (value) => app.setScenarioEventField('request.auth.method', value, true))), true), authDetails) : null)),
      section('HMAC', 'Sign the rendered payload with the same provider presets available for inbound verification.', h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { style: 'display:flex;align-items:center;gap:12px;background:#141210;border-radius:var(--radius-xs);padding:11px 12px' }, h('div', { style: 'flex:1' }, h('div', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7' }, 'Sign outbound payload'), h('div', { style: 'font-size:11px;color:#7a746a;margin-top:2px' }, 'Signature header is overridden at send time')), toggle(!!hmac.enabled, () => { app.setScenarioEventField('request.hmac.enabled', !hmac.enabled); app.rerender(); })), hmacDetails)),
      section('Delivery behavior', 'The first delay starts after the mock response. Later event delays start after the previous event finishes.', grid([
        field('Initial / event delay (ms)', input(schedule.delayMs, '0', (value) => app.setScenarioEventField('schedule.delayMs', value))),
        field('Intentional sends', input(schedule.repeatCount, '1', (value) => app.setScenarioEventField('schedule.repeatCount', value))),
        field('Interval between sends (ms)', input(schedule.repeatIntervalMs, '0', (value) => app.setScenarioEventField('schedule.repeatIntervalMs', value))),
        field('Retries after failure', input(schedule.retryCount, '0', (value) => app.setScenarioEventField('schedule.retryCount', value))),
        field('Retry base delay (ms)', input(schedule.retryBaseDelayMs, '250', (value) => app.setScenarioEventField('schedule.retryBaseDelayMs', value))),
      ])),
      h('section', { style: 'background:#141210;border-radius:var(--radius-sm);padding:14px 15px' },
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap' }, h('div', { style: 'font-size:12.5px;font-weight:600;color:#d7d0c5' }, 'Rendered preview'), h('button', { style: 'background:#211d17;color:#c9c2b6;border-radius:var(--radius-xs);padding:5px 8px;font-size:11px;font-weight:600', onclick: app.refreshScenarioEventPreview }, 'Refresh preview')),
        h('div', { style: 'font-size:10.5px;color:#6f685e;margin-bottom:9px' }, 'Using a safe sample request/response. Use Run test flow to provide exact fixtures.'),
        codeBlock(`${request.method || 'POST'} ${previewTemplate(request.url)}\n${safeHeaderPreview(editor.headersText)}\n\n${previewTemplate(request.payload)}`, { language: 'http', showMeta: false, style: "margin:0;max-height:190px;overflow:auto;font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.55;color:#b9c4b5;white-space:pre-wrap;overflow-wrap:anywhere" })),
      h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:2px' },
        h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:9px 13px;font-size:12.5px;font-weight:600', onclick: app.closeScenarioEventEditor }, 'Cancel'),
        h('button', { style: 'background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 14px;font-size:12.5px;font-weight:700', onclick: app.saveScenarioEvent }, editor.id ? 'Save event' : 'Create event'))));
  overlay.appendChild(panel);
  return overlay;
}

export function eventTestDialog(app) {
  const test = app.s.eventTest;
  if (!test) return null;
  const overlay = h('div', { style: 'position:fixed;inset:0;z-index:121;background:rgba(8,7,5,.8);display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto;animation:sd-scrim .14s ease', onclick: (event) => { if (event.target === overlay) app.closeEventTest(); } });
  const panel = h('div', { style: 'width:min(780px,100%);margin:0 auto;background:#15130f;border-radius:var(--radius-md);box-shadow:0 28px 80px rgba(0,0,0,.62);overflow:hidden;animation:sd-pop .16s ease' },
    h('div', { style: 'display:flex;align-items:flex-start;gap:13px;padding:18px 20px;border-bottom:1px solid #28231c' },
      h('span', { style: 'width:33px;height:33px;display:flex;align-items:center;justify-content:center;background:#1f1b15;color:#78a8df;border-radius:var(--radius-sm);flex-shrink:0' }, raw(icons.replay({ w: 17, sw: 1.9 }))),
      h('div', { style: 'flex:1' }, h('div', { style: 'font-size:16px;font-weight:600;color:#f2ede3' }, 'Run test flow'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:3px' }, 'Starts immediately, preserves event order and retries, and is marked as a test in Deliveries.')),
      h('button', { title: 'Close test flow', style: 'width:30px;height:30px;background:#211d17;color:#a49c91;border-radius:var(--radius-xs);display:flex;align-items:center;justify-content:center', onclick: app.closeEventTest }, raw(icons.x({ w: 15, sw: 1.9 })))),
    h('div', { style: 'padding:18px 20px 20px;display:flex;flex-direction:column;gap:14px' },
      h('div', { style: 'background:#1c1710;border-radius:var(--radius-xs);padding:11px 13px;font-size:11.5px;line-height:1.5;color:#c9ad7e' }, raw(icons.warning({ w: 14, stroke: '#d69a3c', sw: 1.8, style: 'vertical-align:middle;margin-right:6px' })), 'This sends real outbound calls to the configured event destinations.'),
      h('div', {}, h('div', { style: sectionLabelStyle }, 'Incoming request fixture'), jsonEditor(test.requestText, 9, (value) => app.setEventTestField('requestText', value))),
      h('div', {}, h('div', { style: sectionLabelStyle }, 'Mock response fixture'), jsonEditor(test.responseText, 9, (value) => app.setEventTestField('responseText', value))),
      test.error ? h('div', { style: 'font-size:12px;color:#e08b7f;background:#241512;border-radius:var(--radius-xs);padding:9px 11px' }, test.error) : null,
      h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap' },
        h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:9px 13px;font-size:12.5px;font-weight:600', onclick: app.closeEventTest }, 'Cancel'),
        h('button', { style: 'display:flex;align-items:center;gap:7px;background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 14px;font-size:12.5px;font-weight:700', onclick: app.runEventTest }, raw(icons.replay({ w: 14, sw: 2 })), 'Run test flow'))));
  overlay.appendChild(panel);
  return overlay;
}

export function deliveriesTab(app, endpoint) {
  const state = app.s;
  const selected = state.selectedDeliveryRun;
  if (selected) return deliveryDetail(app, selected);
  const runs = state.mockDeliveries || [];
  const header = h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap' },
    h('div', {}, h('h2', { style: 'margin:0;font-size:16px;font-weight:600;color:#e8e2d7' }, 'Deliveries'), h('p', { style: 'margin:4px 0 0;font-size:12px;line-height:1.45;color:#7a746a' }, 'Live delivery runs for this mock. Credentials and signature values are never shown here.')),
    h('button', { style: 'display:flex;align-items:center;gap:6px;background:#211d17;color:#d9d3c7;border-radius:var(--radius-xs);padding:8px 11px;font-size:12px;font-weight:600', onclick: app.refreshDeliveryRuns }, raw(icons.replay({ w: 14, sw: 1.9 })), 'Refresh'));
  if (!runs.length) return h('div', {}, header, h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:42px 20px;text-align:center' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#bdb5a9;margin-bottom:5px' }, 'No deliveries yet'), h('div', { style: 'font-size:12px;color:#7a746a' }, 'Valid mock calls and test flows will appear here.')));
  return h('div', {}, header, h('div', { style: 'display:flex;flex-direction:column;gap:9px' }, ...runs.map((run) => deliveryRunCard(app, run))));
}

function deliveryRunCard(app, run) {
  const pending = run.pendingJobs || 0;
  const row = h('button', { style: `${surface};width:100%;display:flex;align-items:center;gap:12px;padding:13px 15px;text-align:left;color:inherit;flex-wrap:wrap`, onclick: () => app.selectDeliveryRun(run.id) },
    h('span', { style: `width:8px;height:8px;border-radius:50%;background:${statusTone(run.status).color};flex-shrink:0` }),
    h('div', { style: 'flex:1;min-width:170px' }, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, h('span', { style: 'font-size:13px;font-weight:600;color:#e8e2d7' }, run.source === 'test' ? 'Test flow' : 'Mock callback flow'), statusPill(run.status)), h('div', { style: 'margin-top:4px;font-size:11.5px;color:#7a746a' }, `${run.totalJobs} ${run.totalJobs === 1 ? 'delivery' : 'deliveries'} · ${run.succeededJobs || 0} succeeded${run.failedJobs ? ` · ${run.failedJobs} failed` : ''}${run.cancelledJobs ? ` · ${run.cancelledJobs} cancelled` : ''}`)),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#746d62" }, fmtClock(run.createdAt)),
    pending ? h('span', { style: 'font-size:11px;color:#78a8df;background:#151d26;border-radius:var(--radius-xs);padding:3px 7px' }, `${pending} pending`) : null,
    raw(icons.chevRight({ w: 16, stroke: '#746d62', sw: 1.9 })));
  return row;
}

function deliveryDetail(app, run) {
  const meta = (label, value) => h('div', { style: 'background:#191712;border-radius:var(--radius-xs);padding:11px 12px;min-width:0' }, h('div', { style: sectionLabelStyle }, label), h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#cfc8bc;overflow-wrap:anywhere" }, value));
  return h('div', { style: 'animation:sd-in .13s ease' },
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap' },
      h('button', { style: 'display:flex;align-items:center;gap:6px;background:transparent;color:#8a837a;font-size:12.5px;font-weight:600;padding:0', onclick: app.backToDeliveries }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'All deliveries'),
      h('span', { style: 'margin-left:auto' }, statusPill(run.status)),
      run.pendingJobs ? h('button', { style: 'background:#2a1714;color:#e08b7f;border-radius:var(--radius-xs);padding:7px 10px;font-size:11.5px;font-weight:700', onclick: () => app.cancelDeliveryRun(run.id) }, 'Cancel pending') : null),
    h('h2', { style: 'margin:0 0 5px;font-size:17px;font-weight:600;color:#e8e2d7' }, run.source === 'test' ? 'Test flow' : 'Mock callback flow'),
    h('div', { style: 'font-size:12px;color:#7a746a;margin-bottom:16px' }, `Created ${fmtStamp(run.createdAt)}`),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:18px' },
      meta('Source', run.source === 'test' ? 'Manual test' : 'Mock request'), meta('Deliveries', String(run.totalJobs)), meta('Succeeded', String(run.succeededJobs || 0)), meta('Failed', String(run.failedJobs || 0))),
    h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, ...(run.jobs || []).map((job) => deliveryJob(app, job))));
}

function deliveryJob(_app, job) {
  const attempts = job.attempts || [];
  const card = h('div', { style: `${surface};padding:14px 15px` },
    h('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' },
      h('span', { style: 'width:24px;height:24px;border-radius:var(--radius-xs);background:#221d17;color:#cfc8bc;display:flex;align-items:center;justify-content:center;font-family:IBM Plex Mono,monospace;font-size:10.5px;font-weight:700' }, String(job.sequenceIndex + 1)),
      h('span', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7' }, job.eventName),
      job.repeatIndex > 0 ? h('span', { style: 'font-size:10.5px;color:#8a837a' }, `send ${job.repeatIndex + 1}`) : null,
      h('span', { style: 'margin-left:auto' }, statusPill(job.status))),
    h('div', { style: 'font-size:11px;color:#746d62;margin:6px 0 0 33px' }, `${job.attemptCount || 0} attempt${job.attemptCount === 1 ? '' : 's'}${job.responseStatus ? ` · HTTP ${job.responseStatus}` : ''}${job.lastError ? ` · ${job.lastError}` : ''}`));
  if (attempts.length) {
    card.appendChild(h('div', { style: 'margin:12px 0 0 33px;display:flex;flex-direction:column;gap:7px' }, ...attempts.map((attempt) => h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:9px 10px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#a49c91" }, `ATTEMPT ${attempt.attemptNo}`), statusPill(attempt.status), attempt.responseStatus ? h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${statusColor(attempt.responseStatus)}` }, `HTTP ${attempt.responseStatus}`) : null, h('span', { style: 'font-size:10.5px;color:#746d62;margin-left:auto' }, `${attempt.durationMs}ms`)),
      attempt.requestUrl ? h('div', { style: "margin-top:5px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#8a837a;overflow-wrap:anywhere" }, attempt.requestMethod || 'POST', ' ', attempt.requestUrl) : null,
      attempt.error ? h('div', { style: 'margin-top:5px;font-size:11px;color:#e08b7f;overflow-wrap:anywhere' }, attempt.error) : null,
      attempt.responseBody ? codeBlock(attempt.responseBody, { label: 'Response body', style: "margin:7px 0 0;background:#100e0b;border-radius:var(--radius-xs);padding:8px;max-height:140px;overflow:auto;font-family:'IBM Plex Mono',monospace;font-size:10.5px;line-height:1.45;color:#b7b0a4;white-space:pre-wrap;overflow-wrap:anywhere" }) : null,
    ))));
  }
  return card;
}
