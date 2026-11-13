// New webhook + new mock creation forms.
import { h, raw, clear, closeFloatingPanels, icons, mountFloatingPanel, select, segment, jsonEditor, slugify, methodColor, templateSuggestionsFor } from '../ui.js';

const METHOD_OPTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'QUERY'].map((m) => ({ value: m, label: m, color: methodColor(m) }));
const AUTH_OPTS = [{ value: 'none', label: 'None — public' }, { value: 'bearer', label: 'Bearer token' }, { value: 'apikey', label: 'API key' }, { value: 'basic', label: 'Basic auth' }];
const PROVIDER_OPTS = [{ value: 'stripe', label: 'Stripe' }, { value: 'github', label: 'GitHub' }, { value: 'shopify', label: 'Shopify' }, { value: 'twilio', label: 'Twilio' }, { value: 'slack', label: 'Slack' }, { value: 'custom', label: 'Custom' }];

function fieldLabel(t) { return h('div', { style: 'font-size:12.5px;color:#948d83;margin-bottom:7px' }, t); }
function errline(msg) { return msg ? h('div', { style: 'display:flex;align-items:center;gap:5px;margin-top:7px;font-size:11.5px;color:#cf8b7f' }, raw(icons.circleInfo({ w: 13, sw: 2 })), msg) : null; }
function fieldInput(value, placeholder, onInput, err, ref, type) {
  return h('input', { value, placeholder, ref, type: type || 'text', style: `width:100%;background:#17140e;border-radius:var(--radius-sm);padding:11px 13px;box-shadow:inset 0 0 0 1px ${err ? '#8a4a42' : 'rgba(245,240,230,0.12)'};color:#e8e2d7;font-size:14px`, oninput: (e) => onInput(e.target.value) });
}
// Searchable / creatable project picker. Its floating layer follows the same
// viewport-aware behavior as selects, while typing and choosing stay entirely
// local so neither the page nor the input caret is rebuilt.
export function projectPicker(app, opts) {
  const projects = app.s.projects || [];
  let currentValue = opts.value || '';
  let panel = null;
  let layer = null;
  const valueSlot = h('span', { style: 'display:flex;align-items:center;min-width:0;flex:1' });
  const actionSlot = h('span', { style: 'display:flex;align-items:center;gap:4px;flex-shrink:0' });
  const chevron = raw(icons.chevDown({ w: 15, stroke: '#8a837a', sw: 1.8, style: 'flex-shrink:0;transition:transform .16s' }));
  let btn = null;

  function close() {
    if (!panel) return;
    panel = null;
    if (layer) { const activeLayer = layer; layer = null; activeLayer.close(); }
    chevron.style.transform = 'rotate(0deg)';
    btn.setAttribute('aria-expanded', 'false');
  }
  function layerClosed() {
    if (!panel) return;
    panel = null;
    layer = null;
    chevron.style.transform = 'rotate(0deg)';
    btn.setAttribute('aria-expanded', 'false');
  }
  function renderValue() {
    clear(valueSlot);
    clear(actionSlot);
    if (currentValue) {
      valueSlot.appendChild(h('span', { style: 'display:inline-flex;align-items:center;gap:6px;background:#2a2119;color:#e8b88a;border-radius:var(--radius-xs);padding:5px 10px;font-size:12.5px;font-weight:600;max-width:100%;overflow:hidden' },
        raw(icons.tag({ w: 12, sw: 2 })), h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, currentValue)));
      const clearX = h('span', { title: 'Clear project', role: 'button', tabindex: '0', style: 'display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:var(--radius-xs);color:#6a655c;cursor:pointer', onclick: (event) => { event.stopPropagation(); opts.onClear(); currentValue = ''; renderValue(); } }, raw(icons.x({ w: 11, sw: 2.4 })));
      clearX.addEventListener('mouseenter', () => { clearX.style.background = '#2f2921'; clearX.style.color = '#cfc8bc'; });
      clearX.addEventListener('mouseleave', () => { clearX.style.background = 'transparent'; clearX.style.color = '#6a655c'; });
      actionSlot.appendChild(clearX);
    } else valueSlot.appendChild(h('span', { style: 'font-size:13.5px;color:#6a655c' }, 'No project'));
    actionSlot.appendChild(chevron);
  }
  function pick(name) {
    currentValue = name;
    opts.onPick(name);
    renderValue();
    close();
  }
  function open() {
    closeFloatingPanels();
    let query = '';
    panel = h('div', { role: 'dialog', style: 'z-index:81;background:#211d17;border-radius:var(--radius-sm);padding:7px;box-shadow:0 16px 38px rgba(0,0,0,0.55);animation:sd-in .12s ease;overflow:auto;box-sizing:border-box' });
    const listBox = h('div', { role: 'listbox', style: 'max-height:180px;overflow-y:auto' });
    const createSlot = h('div', {});
    const refresh = () => {
      const normalized = query.trim().toLowerCase();
      const matches = projects.filter((project) => project.name.toLowerCase().includes(normalized));
      const exact = projects.some((project) => project.name.toLowerCase() === normalized);
      clear(listBox);
      for (const project of matches) {
        const selected = project.name === currentValue;
        const row = h('button', { type: 'button', role: 'option', 'aria-selected': selected ? 'true' : 'false', style: `width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 9px;border-radius:var(--radius-xs);cursor:pointer;text-align:left;font-size:13px;background:${selected ? '#2f2921' : 'transparent'};color:#cfc8bc`, onclick: (event) => { event.stopPropagation(); pick(project.name); } },
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, project.name), selected ? raw(icons.check({ w: 14, stroke: '#238636', sw: 2.2 })) : null);
        row.addEventListener('mouseenter', () => { if (!selected) row.style.background = '#2f2921'; });
        row.addEventListener('mouseleave', () => { if (!selected) row.style.background = 'transparent'; });
        listBox.appendChild(row);
      }
      if (!matches.length && !normalized) listBox.appendChild(h('div', { style: 'padding:9px;font-size:12.5px;color:#6a655c' }, 'No projects yet'));
      clear(createSlot);
      if (normalized && !exact) {
        createSlot.appendChild(h('div', { style: 'height:1px;background:#2a251e;margin:5px 3px' }));
        const create = h('button', { type: 'button', style: 'width:100%;display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:var(--radius-xs);cursor:pointer;text-align:left;font-size:13px;color:#e8b88a;background:transparent', onclick: (event) => { event.stopPropagation(); pick(query.trim()); } },
          h('span', { style: 'width:20px;height:20px;border-radius:var(--radius-xs);background:#2a2119;display:flex;align-items:center;justify-content:center;flex-shrink:0' }, raw(icons.plus({ w: 12, sw: 2.4 }))),
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, `Create "${query.trim()}"`));
        create.addEventListener('mouseenter', () => { create.style.background = '#2f2921'; });
        create.addEventListener('mouseleave', () => { create.style.background = 'transparent'; });
        createSlot.appendChild(create);
      }
      if (layer) layer.position();
    };
    const search = h('input', {
      autocomplete: 'off', spellcheck: 'false', placeholder: 'Search or create a project…',
      style: 'width:100%;background:#141210;border-radius:var(--radius-xs);padding:8px 10px;font-size:13px;color:#e8e2d7;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.1);margin-bottom:6px',
      oninput: (event) => { query = event.target.value; refresh(); },
    });
    panel.appendChild(search);
    panel.appendChild(listBox);
    panel.appendChild(createSlot);
    refresh();
    layer = mountFloatingPanel(btn, panel, { maxHeight: 280, onDismiss: close, onClosed: layerClosed });
    chevron.style.transform = 'rotate(180deg)';
    btn.setAttribute('aria-expanded', 'true');
    try { search.focus({ preventScroll: true }); } catch (_) { search.focus(); }
  }

  btn = h('button', {
    type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    style: 'width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);cursor:pointer',
    onclick: (event) => { event.stopPropagation(); if (panel) close(); else open(); },
  }, valueSlot, actionSlot);
  renderValue();
  return h('div', {}, btn);
}
// Progressive disclosure: reveal exactly the credential field(s) the chosen
// mock auth method needs. Unlike a webhook's HMAC secret (issued by a
// third-party provider only after the URL is registered with them), a mock's
// credentials are invented by whoever builds the mock — known up front, so
// capturing them here means the mock actually works the moment it's created
// instead of silently rejecting everything until a trip to Settings.
function mockAuthFields(app, f) {
  if (f.auth === 'bearer') {
    return h('div', {}, fieldLabel('Bearer token'), fieldInput(f.authToken, 'sk_test_…', (v) => { f.authToken = v; }),
      h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:7px' }, 'Callers must send Authorization: Bearer <token>.'));
  }
  if (f.auth === 'apikey') {
    return h('div', {},
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        h('div', {}, fieldLabel('Key name'), fieldInput(f.authApiKeyName, 'X-Api-Key', (v) => { f.authApiKeyName = v; })),
        h('div', {}, fieldLabel('Location'), segment({ value: f.authApiKeyLoc, options: [{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query' }], onPick: (v) => { f.authApiKeyLoc = v; app.rerender(); } }))),
      h('div', { style: 'margin-top:12px' }, fieldLabel('Key value'), fieldInput(f.authToken, 'secret-key-value', (v) => { f.authToken = v; })));
  }
  if (f.auth === 'basic') {
    return h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
      h('div', {}, fieldLabel('Username'), fieldInput(f.authUser, 'webhook', (v) => { f.authUser = v; })),
      h('div', {}, fieldLabel('Password'), fieldInput(f.authPass, '••••••••', (v) => { f.authPass = v; }, null, null, 'password')));
  }
  return null;
}

function cancelBtn(label, onClick) {
  return h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:11px 18px;font-size:14px;font-weight:600', onclick: onClick }, label);
}
function submitBtn(label, onClick) {
  const b = h('button', { style: 'flex:1;background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:11px 18px;font-size:14px;font-weight:600', onclick: onClick }, label);
  b.addEventListener('mouseenter', () => { b.style.background = '#ffffff'; });
  b.addEventListener('mouseleave', () => { b.style.background = '#edecec'; });
  return b;
}

export function newInspectorScreen(app) {
  const f = app.s.form.insp;
  const localBase = (app.s.baseUrls.local || 'http://localhost:4601');
  const pubBase = app.s.funnel.state && app.s.funnel.state.active && app.s.funnel.state.base_url;
  let slugField, localPrev, pubPrev;
  const updatePreview = () => {
    const sl = f.slug || 'your-slug';
    if (localPrev) localPrev.textContent = `${localBase}/${sl}`;
    if (pubPrev) pubPrev.textContent = pubBase ? `${pubBase}/${sl}` : '(enable Funnel for a public URL)';
  };
  const onName = (v) => { f.name = v; if (!f.slugEdited) { f.slug = slugify(v); if (slugField) slugField.value = f.slug; } updatePreview(); };
  const onSlug = (v) => { f.slug = slugify(v); f.slugEdited = true; updatePreview(); };

  const form = h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    h('div', {}, fieldLabel('Name'), fieldInput(f.name, 'e.g. Stripe Webhooks', onName, f.errors.name), errline(f.submitted && f.errors.name)),
    h('div', {}, fieldLabel('Project'), projectPicker(app, { id: 'insp-project', value: f.projectName, onPick: (name) => { f.projectName = name; }, onClear: () => { f.projectName = ''; } })),
    h('div', {}, fieldLabel('Slug'), fieldInput(f.slug, 'stripe-prod', onSlug, f.errors.slug, (el) => { slugField = el; }), errline(f.submitted && f.errors.slug),
      h('div', { style: 'margin-top:9px;background:#141210;border-radius:var(--radius-xs);padding:10px 12px' },
        h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#8a837a;margin-bottom:3px", ref: (el) => { localPrev = el; } }, `${localBase}/${f.slug || 'your-slug'}`),
        h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#f5602a", ref: (el) => { pubPrev = el; } }, pubBase ? `${pubBase}/${f.slug || 'your-slug'}` : '(enable Funnel for a public URL)'))),
    h('div', { style: 'display:flex;align-items:center;gap:13px;background:#191712;border-radius:var(--radius-sm);padding:14px 16px' },
      h('div', { style: 'flex:1' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7' }, 'Validate signatures'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'Verify an HMAC signature on every request')),
      h('button', { style: `position:relative;width:46px;height:26px;border-radius:20px;padding:0;flex-shrink:0;cursor:pointer;background:${f.validate ? '#238636' : 'rgba(245,240,230,0.13)'}`, onclick: () => { f.validate = !f.validate; app.rerender(); } }, h('span', { style: `position:absolute;top:3px;left:${f.validate ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff` }))),
    f.validate ? h('div', {}, fieldLabel('Signature provider'), select(app.selectHelper('insp-provider', f.provider, PROVIDER_OPTS, (v) => { f.provider = v; }))) : null,
    f.validate ? h('div', {}, fieldLabel('Signing secret (optional)'), fieldInput(f.hmacSecret, 'whsec_…', (v) => { f.hmacSecret = v; }),
      h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:7px' }, "Most providers only issue this after you register the URL below with them — leave it blank and paste it into this endpoint's Settings once you have it.")) : null,
    h('div', { style: 'display:flex;gap:10px;margin-top:6px' }, submitBtn('Create webhook', app.createWebhook), cancelBtn('Cancel', app.cancelNew)));

  updatePreview();
  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:580px;margin:0 auto;padding:34px 40px 64px 40px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.cancelNew }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Webhooks'),
    h('h1', { style: 'margin:0 0 6px 0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, 'New webhook'),
    h('p', { style: 'margin:0 0 26px 0;font-size:13.5px;color:#8a837a' }, 'Creates a unique URL that captures every request it receives.'),
    form));
}

export function newMockScreen(app) {
  const f = app.s.form.mock;
  const base = (app.s.baseUrls.local || 'http://localhost:4601');
  let pathPrev;
  const updatePreview = () => { if (pathPrev) pathPrev.textContent = `${base}/<slug>  ·  responds to ${f.method} ${f.path || '/'}`; };

  const form = h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    h('div', {}, fieldLabel('Name'), fieldInput(f.name, 'e.g. Payments API', (v) => { f.name = v; }, f.errors.name), errline(f.submitted && f.errors.name)),
    h('div', {}, fieldLabel('Project'), projectPicker(app, { id: 'mock-project', value: f.projectName, onPick: (name) => { f.projectName = name; }, onClear: () => { f.projectName = ''; } })),
    h('div', { style: 'display:grid;grid-template-columns:130px 1fr;gap:12px' },
      h('div', {}, fieldLabel('Method'), select(app.selectHelper('mock-method', f.method, METHOD_OPTS, (v) => { f.method = v; updatePreview(); }, { mono: true }))),
      h('div', {}, fieldLabel('Path'), fieldInput(f.path, '/v1/charges', (v) => { f.path = v; updatePreview(); }, f.errors.path), errline(f.submitted && f.errors.path))),
    h('div', { style: "background:#141210;border-radius:var(--radius-xs);padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#8a837a", ref: (el) => { pathPrev = el; } }, `${base}/<slug>  ·  responds to ${f.method} ${f.path || '/'}`),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px' },
      h('div', {}, fieldLabel('Status'), fieldInput(f.status, '', (v) => { f.status = v; }, f.errors.status), errline(f.submitted && f.errors.status)),
      h('div', {}, fieldLabel('Delay (ms)'), fieldInput(f.delay, '0', (v) => { f.delay = v; })),
      h('div', {}, fieldLabel('Auth'), select(app.selectHelper('mock-auth', f.auth, AUTH_OPTS, (v) => { f.auth = v; return true; })))),
    f.auth !== 'none' ? mockAuthFields(app, f) : null,
    h('div', {}, fieldLabel('Response body'), jsonEditor(f.body, 6, (v) => { f.body = v; }, { templateSuggestions: templateSuggestionsFor(app, 'mockResponse') })),
    h('div', { style: 'display:flex;gap:10px;margin-top:6px' }, submitBtn('Create mock server', app.createMock), cancelBtn('Cancel', app.cancelNewMock)));

  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:620px;margin:0 auto;padding:34px 40px 64px 40px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.backToMockProtocol }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Choose protocol'),
    h('h1', { style: 'margin:0 0 6px 0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, 'New mock server'),
    h('p', { style: 'margin:0 0 26px 0;font-size:13.5px;color:#8a837a' }, 'Define a path and a first response. Add scenarios and rules afterwards.'),
    form));
}
