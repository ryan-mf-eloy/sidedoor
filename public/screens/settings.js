// Endpoint settings: Authentication, HMAC verification, Forwarding rules, Rate limiting.
import { h, raw, clear, icons, select, segment, toggle, fmtClock } from '../ui.js';

const AUTH_METHODS = [{ value: 'none', label: 'None — public' }, { value: 'apikey', label: 'API key' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic auth' }];
const PROVIDERS = [{ value: 'stripe', label: 'Stripe' }, { value: 'github', label: 'GitHub' }, { value: 'shopify', label: 'Shopify' }, { value: 'twilio', label: 'Twilio' }, { value: 'slack', label: 'Slack' }, { value: 'custom', label: 'Custom HMAC' }];
const RULE_FIELDS = [{ value: 'header', label: 'Header' }, { value: 'body', label: 'Body field' }, { value: 'query', label: 'Query param' }, { value: 'method', label: 'Method' }, { value: 'path', label: 'Path' }];
const RULE_OPS = [{ value: 'equals', label: 'equals' }, { value: 'contains', label: 'contains' }, { value: 'regex', label: 'matches regex' }, { value: 'exists', label: 'exists' }, { value: '>', label: 'greater than' }, { value: '<', label: 'less than' }, { value: '≠', label: 'not equal' }];
const RULE_ACTIONS = [{ value: 'forward', label: 'Forward to local' }, { value: 'drop', label: 'Drop request' }, { value: 'tag', label: 'Tag & keep' }, { value: 'respond', label: 'Respond directly' }, { value: 'transform', label: 'Transform payload' }];

const boxInput = (value, placeholder, onInput, opts = {}) => h('input', {
  value, placeholder, type: opts.type || 'text',
  style: `width:100%;background:#17140e;border-radius:var(--radius-sm);padding:10px 13px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:${opts.color || '#e8e2d7'};font-size:13px;${opts.mono ? "font-family:'IBM Plex Mono',monospace;" : ''}${opts.center ? 'text-align:center;' : ''}`,
  oninput: (e) => onInput(e.target.value),
});
const label = (t) => h('div', { style: 'font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#5c574e;margin-bottom:9px' }, t);
const sectionCard = (...kids) => h('div', { style: 'background:#191712;border-radius:var(--radius-md);padding:19px 20px;display:flex;flex-direction:column;gap:19px' }, ...kids);

// Mirrors the backend's own fail-closed rule exactly (src/lib/auth.js) so the
// UI never claims a config is fine when the ingest pipeline would actually
// reject every request for it. Exported for reuse by the mock config screen's
// own auth summary banner.
export function authConfigured(a) {
  if (a.method === 'bearer' || a.method === 'apikey') return !!(a.token && a.token.trim());
  if (a.method === 'basic') return !!(a.user && a.user.trim()) && !!(a.pass && a.pass.trim());
  return true;
}
export function credLabel(method) { return method === 'basic' ? 'username and password' : method === 'apikey' ? 'API key value' : 'token'; }

function warnBanner(text) {
  return h('div', { style: 'display:flex;align-items:center;gap:11px;background:#1c1710;border-radius:var(--radius-sm);padding:13px 15px;font-size:12.5px;color:#c9ad7e' },
    raw(icons.warning({ w: 16, stroke: '#d69a3c', sw: 1.9, style: 'flex-shrink:0' })), h('span', {}, text));
}

// Numeric settings fields save on a debounce (patchConfig with immediate:false)
// so a full app render never fires per keystroke — recreating the <input>
// mid-typing would drop focus/caret, the same class of bug already fixed for
// the project picker. So the live "is this a valid number" feedback here is
// applied as a direct, local DOM patch (border color + error line) instead of
// going through app-level render.
function numField(value, placeholder, onInput, opts = {}) {
  const computeErr = (v) => {
    const n = Number(v);
    return v !== '' && v != null && (!Number.isFinite(n) || (opts.min != null && n < opts.min) || (opts.max != null && n > opts.max));
  };
  const okShadow = 'inset 0 0 0 1px rgba(245,240,230,0.12)';
  const errShadow = 'inset 0 0 0 1px #8a4a42';
  const errSlot = h('div', {});
  const errMsg = opts.errMsg || `Use a number${opts.min != null ? ` from ${opts.min}${opts.max != null ? `–${opts.max}` : '+'}` : ''}.`;
  const renderErr = (bad) => {
    clear(errSlot);
    if (bad) errSlot.appendChild(h('div', { style: 'display:flex;align-items:center;gap:5px;margin-top:6px;font-size:11px;color:#cf8b7f' }, raw(icons.circleInfo({ w: 12, sw: 2 })), errMsg));
  };
  const input = h('input', {
    value, placeholder, type: 'text',
    style: `width:100%;background:#17140e;border-radius:var(--radius-sm);padding:10px 13px;box-shadow:${computeErr(value) ? errShadow : okShadow};color:${opts.color || '#e8e2d7'};font-size:13px;${opts.mono !== false ? "font-family:'IBM Plex Mono',monospace;" : ''}${opts.center ? 'text-align:center;' : ''}`,
    oninput: (e) => {
      const v = e.target.value;
      onInput(v);
      const bad = computeErr(v);
      input.style.boxShadow = bad ? errShadow : okShadow;
      renderErr(bad);
    },
  });
  renderErr(computeErr(value));
  return h('div', {}, input, errSlot);
}

function toggleHeader(iconFn, iconColor, title, sub, on, onClick) {
  return h('div', { style: 'display:flex;align-items:center;gap:14px;background:#191712;border-radius:var(--radius-md);padding:16px 18px' },
    h('span', { style: `width:38px;height:38px;border-radius:var(--radius-sm);background:#221d17;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${iconColor}` }, raw(iconFn({ w: 18, sw: 1.8 }))),
    h('div', { style: 'flex:1' }, h('div', { style: 'font-size:14.5px;font-weight:600;color:#efe9df' }, title), h('div', { style: 'font-size:12.5px;color:#8a837a;margin-top:2px' }, sub)),
    toggle(on, onClick));
}

export function settingsScreen(app) {
  const s = app.s, ep = s.activeEp;
  if (!ep) return h('div', {});
  const tabs = ep.type === 'mock' ? [['auth', 'Authentication'], ['rate', 'Rate limiting']] : [['auth', 'Authentication'], ['hmac', 'HMAC verification'], ['rules', 'Forwarding rules'], ['rate', 'Rate limiting']];

  const tabBar = h('div', { style: 'display:flex;align-items:center;gap:24px;margin-bottom:26px;box-shadow:inset 0 -1px 0 #241f19' },
    ...tabs.map(([id, lbl]) => h('button', { style: `background:transparent;padding:0 0 12px 0;font-size:13.5px;font-weight:600;color:${s.settingsTab === id ? '#f2ede3' : '#8a837a'};box-shadow:${s.settingsTab === id ? 'inset 0 -2px 0 #edecec' : 'none'}`, onclick: () => app.setSettingsTab(id) }, lbl)));

  let panel;
  if (s.settingsTab === 'hmac') panel = hmacPanel(app, ep);
  else if (s.settingsTab === 'rules') panel = rulesPanel(app, ep);
  else if (s.settingsTab === 'rate') panel = ratePanel(app, ep);
  else panel = authPanel(app, ep);

  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:760px;margin:0 auto;padding:28px 40px 80px 40px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:16px', onclick: app.backFromSettings }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), ep.name),
    h('h1', { style: 'margin:0 0 4px 0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, 'Endpoint settings'),
    h('p', { style: 'margin:0 0 20px 0;font-size:13.5px;color:#8a837a' }, 'Configuration for ', h('span', { style: 'color:#c9c2b6;font-weight:500' }, ep.name), '.'),
    tabBar, panel));
}

function authPanel(app, ep) {
  const a = ep.config.auth;
  const kids = [toggleHeader(icons.lock, '#c9a76a', 'Require authentication', "Reject public requests that don't present valid credentials", a.enabled, () => app.patchConfig('auth', { enabled: !a.enabled }, true))];
  if (a.enabled) {
    const methodSel = h('div', {}, label('Method'), select(app.selectHelper('auth-method', a.method, AUTH_METHODS, (v) => app.patchConfig('auth', { method: v, enabled: true }, true))));
    let detail;
    if (a.method === 'bearer') detail = h('div', {}, label('Bearer token'), boxInput(a.token, 'sk_live_…', (v) => app.patchConfig('auth', { token: v }), { mono: true }), h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:8px' }, 'Sent as Authorization: Bearer <token>'));
    else if (a.method === 'apikey') detail = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:15px' },
      h('div', {}, label('Key name'), boxInput(a.apiKeyName, 'X-Api-Key', (v) => app.patchConfig('auth', { apiKeyName: v }), { mono: true })),
      h('div', {}, label('Location'), segment({ value: a.apiKeyLoc, options: [{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query' }], onPick: (v) => app.patchConfig('auth', { apiKeyLoc: v }, true) })),
      h('div', { style: 'grid-column:1/3' }, label('Key value'), boxInput(a.token, 'secret-key-value', (v) => app.patchConfig('auth', { token: v }), { mono: true })));
    else if (a.method === 'basic') detail = h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:15px' },
      h('div', {}, label('Username'), boxInput(a.user, 'webhook', (v) => app.patchConfig('auth', { user: v }))),
      h('div', {}, label('Password'), boxInput(a.pass, '••••••••', (v) => app.patchConfig('auth', { pass: v }), { type: 'password', mono: true })));
    else detail = h('div', { style: 'display:flex;align-items:center;gap:11px;background:#1c1710;border-radius:var(--radius-sm);padding:13px 15px;font-size:12.5px;color:#c9ad7e' }, raw(icons.warning({ w: 16, stroke: '#d69a3c', sw: 1.9 })), 'Anyone with the public URL can post to this endpoint.');

    const reject = a.method !== 'none' ? h('div', { style: 'display:flex;align-items:center;gap:14px;background:#141210;border-radius:var(--radius-sm);padding:13px 15px' },
      h('div', { style: 'flex:1' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7' }, 'Rejection response'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'Status returned when credentials are missing or invalid')),
      h('div', { style: 'width:74px' }, numField(a.failStatus, '401', (v) => app.patchConfig('auth', { failStatus: v }), { center: true, color: '#cf8b7f', min: 100, max: 599, errMsg: 'Use a status from 100–599.' }))) : null;
    if (a.method !== 'none' && !authConfigured(a)) {
      kids.push(warnBanner(`No ${credLabel(a.method)} set yet — every request will be rejected (HTTP ${a.failStatus || 401}) until you fill it in below.`));
    }
    kids.push(sectionCard(methodSel, detail, reject));
    kids.push(h('div', {}, label('Example request'), h('pre', { style: "margin:0;background:#141210;border-radius:var(--radius-sm);padding:14px 16px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;color:#b3aca1;white-space:pre-wrap;word-break:break-all" }, authCurl(ep))));
  }
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, ...kids);
}

function authCurl(ep) {
  const a = ep.config.auth;
  const url = ep.urls.public || ep.urls.local;
  let authArg = '';
  if (a.method === 'bearer') authArg = `\\\n  -H "Authorization: Bearer ${a.token || '<token>'}"`;
  else if (a.method === 'apikey') authArg = a.apiKeyLoc === 'query' ? `?${a.apiKeyName}=${a.token || '<key>'}` : `\\\n  -H "${a.apiKeyName}: ${a.token || '<key>'}"`;
  else if (a.method === 'basic') authArg = `\\\n  -u "${a.user || 'user'}:${a.pass ? '••••' : '<pass>'}"`;
  const q = a.method === 'apikey' && a.apiKeyLoc === 'query' ? authArg : '';
  const hdr = a.method === 'apikey' && a.apiKeyLoc === 'query' ? '' : authArg;
  return `curl -X ${ep.type === 'mock' ? ep.method : 'POST'} ${url}${q} ${hdr}\\\n  -H "Content-Type: application/json" \\\n  -d '{"hello":"world"}'`;
}

function hmacPanel(app, ep) {
  const s = app.s, hm = ep.config.hmac;
  const kids = [toggleHeader(icons.shield, '#7fc79b', 'Verify HMAC signatures', "Recompute the signature on every request and compare it to the provider's", hm.enabled, () => app.patchConfig('hmac', { enabled: !hm.enabled }, true))];
  if (hm.enabled) {
    if (!hm.secret || !hm.secret.trim()) {
      kids.push(warnBanner(hm.reject
        ? 'No signing secret set yet — every request will be rejected until you paste one below.'
        : 'No signing secret set yet — signatures cannot be verified, so every request will be flagged INVALID (but still accepted, since "Reject invalid signatures" is off) until you paste one below.'));
    }
    kids.push(sectionCard(
      h('div', {}, label('Provider preset'), select(app.selectHelper('hmac-provider', hm.provider, PROVIDERS, (v) => app.applyHmacProvider(v))), h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:8px' }, 'Presets fill the algorithm, header and encoding automatically.')),
      h('div', {}, label('Signing secret'), h('div', { style: 'position:relative' },
        boxInput(hm.secret, 'whsec_…', (v) => app.patchConfig('hmac', { secret: v }), { mono: true, type: s.secretReveal ? 'text' : 'password' }),
        h('button', { style: 'position:absolute;right:6px;top:6px;bottom:6px;background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:0 12px;font-size:11px;font-weight:600', onclick: app.toggleSecret }, s.secretReveal ? 'Hide' : 'Reveal'))),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:15px' },
        h('div', {}, label('Algorithm'), segment({ value: hm.algo, options: [{ value: 'sha256', label: 'SHA-256' }, { value: 'sha1', label: 'SHA-1' }, { value: 'sha512', label: 'SHA-512' }], onPick: (v) => app.patchConfig('hmac', { algo: v }, true) })),
        h('div', {}, label('Digest encoding'), segment({ value: hm.encoding, options: [{ value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }], onPick: (v) => app.patchConfig('hmac', { encoding: v }, true) }))),
      h('div', { style: 'display:grid;grid-template-columns:1.4fr 1fr;gap:15px' },
        h('div', {}, label('Signature header'), boxInput(hm.header, 'X-Signature', (v) => app.patchConfig('hmac', { header: v }), { mono: true })),
        h('div', {}, label('Tolerance (s)'), numField(hm.tolerance, '300', (v) => app.patchConfig('hmac', { tolerance: v }), { min: 0, errMsg: 'Use 0 or a positive number of seconds.' }))),
      h('div', { style: 'display:flex;align-items:center;gap:14px;background:#141210;border-radius:var(--radius-sm);padding:13px 15px' },
        h('div', { style: 'flex:1' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7' }, 'Reject invalid signatures'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'When off, requests are flagged but still captured for inspection')),
        toggle(hm.reject, () => app.patchConfig('hmac', { reject: !hm.reject }, true)))));

    const verifs = (s.settingsRequests || []).filter((r) => r.signature).slice(-5).reverse();
    kids.push(h('div', {}, label('Recent verifications'),
      verifs.length ? h('div', { style: 'background:#191712;border-radius:var(--radius-sm);overflow:hidden' }, ...verifs.map((v) => {
        const color = v.signature === 'valid' ? '#7fc79b' : v.signature === 'invalid' ? '#e08b7f' : '#8a837a';
        const bg = v.signature === 'valid' ? '#141712' : v.signature === 'invalid' ? '#1a1210' : '#141210';
        return h('div', { style: 'display:flex;align-items:center;gap:11px;padding:11px 15px;box-shadow:inset 0 -1px 0 #201b15' },
          h('span', { style: `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${color}` }),
          h('span', { style: "flex:1;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#cfc8bc" }, v.event || v.method + ' ' + v.path),
          h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6a655c" }, fmtClock(v.receivedAt)),
          h('span', { style: `font-size:10.5px;font-weight:600;letter-spacing:0.04em;color:${color};background:${bg};border-radius:var(--radius-xs);padding:3px 8px` }, v.signature.toUpperCase()));
      })) : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:20px;text-align:center;font-size:12.5px;color:#7a746a' }, 'No signed requests captured yet.')));
  }
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, ...kids);
}

function rulesPanel(app, ep) {
  const rules = ep.config.rules || [];
  const head = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:18px' },
    h('div', { style: 'font-size:12.5px;color:#8a837a;line-height:1.5' }, 'Rules run top-to-bottom. A request must satisfy ', h('span', { style: 'color:#c9c2b6;font-weight:600' }, ep.config.ruleMatch === 'all' ? 'every' : 'any'), ' enabled condition to trigger its action.'),
    h('div', { style: 'width:220px;flex-shrink:0' }, segment({ value: ep.config.ruleMatch, options: [{ value: 'all', label: 'Match ALL' }, { value: 'any', label: 'Match ANY' }], onPick: (v) => app.patchConfigTop({ ruleMatch: v }) })));
  const list = rules.length ? h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, ...rules.map((r, i) => cfgRuleRow(app, r, i)))
    : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:30px;text-align:center' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#a49c91;margin-bottom:3px' }, 'No rules yet'), h('div', { style: 'font-size:12.5px;color:#7a746a' }, ep.forward_target ? 'Every request forwards to your local server untouched.' : 'Every request is accepted and captured.'));
  const addBtn = h('button', { style: 'display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.1);color:#a49c91;border-radius:var(--radius-sm);padding:12px;font-size:13px;font-weight:600;cursor:pointer', onclick: app.addCfgRule }, raw(icons.plus({ w: 15, sw: 2 })), 'Add rule');
  const target = h('div', { style: 'background:#191712;border-radius:var(--radius-md);padding:16px 18px' }, label('Forward target (local server)'),
    boxInput(ep.forward_target || '', 'http://localhost:3000/webhook', (v) => { ep.forward_target = v; app.patchConfigTop({ forwardTarget: v }); }, { mono: true }),
    h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:8px' }, 'Where "Forward to local" sends requests. Leave blank to just accept & capture.'));
  return h('div', { style: 'display:flex;flex-direction:column;gap:15px' }, target, head, list, addBtn);
}

function cfgRuleRow(app, r, i) {
  const actionColor = { forward: '#7fc79b', drop: '#e08b7f', tag: '#d69a3c', respond: '#6a9fd4', transform: '#b28de0' }[r.action] || '#8a837a';
  const needsValue = r.op !== 'exists';
  const row = h('div', { style: `background:#191712;border-radius:var(--radius-sm);padding:14px 15px;transition:opacity .15s;opacity:${r.enabled ? 1 : 0.5}` },
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:13px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;letter-spacing:0.06em;color:#57524a" }, 'RULE ' + String(i + 1).padStart(2, '0')),
      h('span', { style: `display:flex;align-items:center;gap:6px;margin-left:auto;font-size:11.5px;font-weight:500;color:${actionColor}` }, h('span', { style: `width:6px;height:6px;border-radius:50%;background:${actionColor}` }), (RULE_ACTIONS.find((a) => a.value === r.action) || {}).label || r.action),
      toggle(r.enabled, () => app.toggleCfgRule(r.id)),
      h('button', { title: 'Delete rule', style: 'width:30px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:transparent;color:#6a655c;flex-shrink:0', onclick: () => app.deleteCfgRule(r.id) }, raw(icons.trash({ w: 15, sw: 1.9 })))),
    h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' },
      h('span', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#5c574e;width:36px;flex-shrink:0' }, 'When'),
      h('div', { style: 'flex:1;min-width:120px' }, select(app.selectHelper('cfgr-' + r.id + '-field', r.field, RULE_FIELDS, (v) => app.updateCfgRule(r.id, 'field', v)))),
      h('input', { value: r.key, placeholder: 'key', style: "flex:1.3;min-width:120px;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-family:'IBM Plex Mono',monospace;font-size:12.5px", oninput: (e) => app.updateCfgRule(r.id, 'key', e.target.value) }),
      h('div', { style: 'flex:1;min-width:118px' }, select(app.selectHelper('cfgr-' + r.id + '-op', r.op, RULE_OPS, (v) => app.updateCfgRule(r.id, 'op', v)))),
      needsValue ? h('input', { value: r.value, placeholder: 'value', style: "flex:1.3;min-width:120px;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-family:'IBM Plex Mono',monospace;font-size:12.5px", oninput: (e) => app.updateCfgRule(r.id, 'value', e.target.value) }) : null),
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:9px' },
      h('span', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#5c574e;width:36px;flex-shrink:0' }, 'Then'),
      h('div', { style: 'flex:1;max-width:300px' }, select(app.selectHelper('cfgr-' + r.id + '-action', r.action, RULE_ACTIONS, (v) => app.updateCfgRule(r.id, 'action', v)))),
      r.action === 'respond' ? h('input', { value: r.respondStatus || '', placeholder: 'status', style: "width:80px;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-family:'IBM Plex Mono',monospace;font-size:12.5px", oninput: (e) => app.updateCfgRule(r.id, 'respondStatus', e.target.value) }) : null),
    r.action === 'respond' ? h('div', { style: 'margin-top:9px' }, h('input', { value: r.respondBody || '', placeholder: 'Response body (JSON)', style: "width:100%;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-family:'IBM Plex Mono',monospace;font-size:12.5px", oninput: (e) => app.updateCfgRule(r.id, 'respondBody', e.target.value) })) : null,
    r.action === 'transform' ? h('div', { style: 'margin-top:9px' }, h('input', { value: r.transform || '', placeholder: 'Replacement body forwarded downstream (JSON)', style: "width:100%;background:#17140e;border-radius:var(--radius-sm);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-family:'IBM Plex Mono',monospace;font-size:12.5px", oninput: (e) => app.updateCfgRule(r.id, 'transform', e.target.value) })) : null);
  return row;
}

function ratePanel(app, ep) {
  const s = app.s, rt = ep.config.rate;
  const kids = [toggleHeader(icons.replay, '#8ba9d6', 'Enable rate limiting', 'Throttle bursts before they reach your local server', rt.enabled, () => app.patchConfig('rate', { enabled: !rt.enabled }, true))];
  if (rt.enabled) {
    kids.push(sectionCard(
      h('div', { style: 'display:grid;grid-template-columns:150px 1fr;gap:16px;align-items:start' },
        h('div', {}, label('Limit'), numField(rt.limit, '120', (v) => app.patchConfig('rate', { limit: v }), { min: 0, errMsg: 'Use 0 or a positive number of requests.' })),
        h('div', {}, label('Window'), segment({ value: rt.window, options: [{ value: 'second', label: 'Per second' }, { value: 'minute', label: 'Per minute' }, { value: 'hour', label: 'Per hour' }], onPick: (v) => app.patchConfig('rate', { window: v }, true) }))),
      h('div', {}, label('Bucket key'), segment({ value: rt.key, options: [{ value: 'ip', label: 'Per client IP' }, { value: 'endpoint', label: 'Per endpoint' }, { value: 'header', label: 'Per header' }], onPick: (v) => app.patchConfig('rate', { key: v }, true) }),
        rt.key === 'header' ? h('div', { style: 'margin-top:10px' }, boxInput(rt.keyHeader, 'X-Tenant-Id', (v) => app.patchConfig('rate', { keyHeader: v }), { mono: true })) : null,
        h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:8px' }, 'How requests are grouped into separate counters.')),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:15px' },
        h('div', {}, label('Burst allowance'), numField(rt.burst, '20', (v) => app.patchConfig('rate', { burst: v }), { min: 0, errMsg: 'Use 0 or a positive number.' })),
        h('div', {}, label('Response status'), numField(rt.status, '429', (v) => app.patchConfig('rate', { status: v }), { min: 100, max: 599, errMsg: 'Use a status from 100–599.' }))),
      h('div', { style: 'display:flex;align-items:center;gap:14px;background:#141210;border-radius:var(--radius-sm);padding:13px 15px' },
        h('div', { style: 'flex:1' }, h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7' }, 'Send Retry-After header'), h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'Tells well-behaved clients when to retry')),
        toggle(rt.retryAfter, () => app.patchConfig('rate', { retryAfter: !rt.retryAfter }, true)))));

    // usage from recent requests within the window
    const windowMs = { second: 1000, minute: 60000, hour: 3600000 }[rt.window] || 60000;
    const now = Date.now();
    const used = (s.settingsRequests || []).filter((r) => now - r.receivedAt < windowMs).length;
    const limit = Number(rt.limit) || 0;
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    kids.push(h('div', { style: 'background:#191712;border-radius:var(--radius-md);padding:17px 19px' },
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:11px' }, h('span', { style: 'font-size:13px;font-weight:600;color:#e8e2d7' }, 'Recent window usage'), h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#8a837a" }, `${used} / ${limit}`)),
      h('div', { style: 'height:9px;border-radius:20px;background:#141210;overflow:hidden' }, h('div', { style: `height:100%;width:${pct}%;border-radius:20px;background:${pct > 85 ? '#e5675c' : '#238636'};transition:width .2s` })),
      h('div', { style: "display:flex;justify-content:space-between;margin-top:7px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#57524a" }, h('span', {}, '0'), h('span', {}, pct + '%'), h('span', {}, String(limit)))));
  }
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, ...kids);
}
