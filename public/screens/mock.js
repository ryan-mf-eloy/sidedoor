// Mock server configuration + requests tab.
import { h, raw, codeBlock, codeEditor, icons, kebabMenu, select, templateSuggestionsFor, toggle, fmtClock, fmtStamp, fmtBytes, methodColor, statusColor } from '../ui.js';
import { endpointMenuItems } from './endpoint.js';
import { authConfigured, credLabel } from './settings.js';
import { deliveriesTab, eventEditorDialog, eventTestDialog, scenarioEventsPanel } from './async-events.js';

const CT_OPTS = [
  { value: 'application/json', label: 'application/json' },
  { value: 'text/plain', label: 'text/plain' },
  { value: 'application/xml', label: 'application/xml' },
  { value: 'text/html', label: 'text/html' },
];
// Same field/operator set as the webhook's Forwarding rules (settings.js) —
// the backend's match engine (src/lib/match.js) already treats mock scenario
// rules and webhook forwarding rules identically, so there was no reason for
// the mock UI to expose a narrower set.
const WHEN_OPTS = [{ value: 'header', label: 'Header' }, { value: 'body', label: 'Body field' }, { value: 'query', label: 'Query param' }, { value: 'method', label: 'Method' }, { value: 'path', label: 'Path' }];
const OP_OPTS = [{ value: 'equals', label: 'equals' }, { value: 'contains', label: 'contains' }, { value: 'regex', label: 'matches regex' }, { value: 'exists', label: 'exists' }, { value: '>', label: 'greater than' }, { value: '<', label: 'less than' }, { value: '≠', label: 'not equal' }];
const METHOD_VALUE_OPTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'QUERY'].map((m) => ({ value: m, label: m, color: methodColor(m) }));
const KEY_PLACEHOLDER = { header: 'X-Test-Scenario', body: 'data.object.amount', query: 'user_id', method: '(not used for Method)', path: '(not used for Path)' };
const WHEN_LABELS = { header: 'Header', body: 'Body field', query: 'Query param', method: 'Method', path: 'Path' };
function contentLanguage(contentType) {
  if (/json/i.test(contentType || '')) return 'json';
  if (/xml/i.test(contentType || '')) return 'xml';
  if (/html/i.test(contentType || '')) return 'html';
  return 'text';
}

export function mockScreen(app) {
  const s = app.s, ep = s.activeEp;
  if (!ep) return h('div', {});
  const active = (ep.scenarios || []).find((x) => x.active) || (ep.scenarios || [])[0];

  const copyBtn = (label, url, key, primary) => h('button', { style: `background:${primary ? '#edecec' : '#211d17'};color:${primary ? '#1a0e07' : '#a49c91'};border-radius:var(--radius-xs);padding:9px 14px;font-size:12.5px;font-weight:${primary ? 700 : 600}`, onclick: () => app.copy(url, key) }, s.copied === key ? 'Copied' : label);

  const tabBtn = (id, label, count) => h('button', { style: `background:transparent;padding:0 0 14px 0;font-size:14px;font-weight:600;color:${s.mockTab === id ? '#f2ede3' : '#7a746a'};box-shadow:${s.mockTab === id ? 'inset 0 -2px 0 #edecec' : 'none'}`, onclick: () => app.setMockTab(id) },
    label, count != null ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#57524a;margin-left:6px" }, String(count)) : null);

  const head = h('div', {},
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.navMocks }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'All mock servers'),
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px' },
      h('div', { style: 'min-width:0' },
        h('h1', { style: 'margin:0 0 8px 0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, ep.name),
        h('div', { style: 'display:flex;align-items:center;gap:8px' },
          h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${methodColor(ep.method)};background:#191712;border-radius:var(--radius-xs);padding:3px 9px` }, ep.method),
          h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:13px;color:#b3aca1" }, ep.path))),
      h('div', { style: 'display:flex;gap:8px;flex-shrink:0' },
        copyBtn('Copy local', ep.urls.local, 'mk-local'),
        copyBtn(ep.urls.public ? 'Copy public' : 'Copy URL', ep.urls.public || ep.urls.local, 'mk-pub', true),
        h('button', { title: 'Endpoint settings', style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-xs);width:33px;height:33px;flex-shrink:0', onclick: app.navSettings }, raw(icons.gear({ w: 16, sw: 1.7 }))),
        kebabMenu({ open: app.s.dropdown === 'epmenu-' + ep.id, onToggle: () => app.setDropdown('epmenu-' + ep.id), onClose: () => app.closeDropdown(), items: endpointMenuItems(app, ep), size: 33, bg: '#211d17', hoverBg: '#282219' }))),
    h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#948d83;background:#141210;border-radius:var(--radius-xs);padding:8px 12px;margin-bottom:22px;display:inline-block" }, (ep.urls.public || ep.urls.local)),
    h('div', { style: 'display:flex;align-items:center;gap:22px;margin-bottom:24px;box-shadow:inset 0 -1px 0 rgba(245,240,230,0.06);flex-wrap:wrap' },
      tabBtn('config', 'Configuration'), tabBtn('requests', 'Requests', ep.requestCount), tabBtn('deliveries', 'Deliveries')));

  const body = s.mockTab === 'config' ? configTab(app, ep, active) : s.mockTab === 'deliveries' ? deliveriesTab(app, ep) : requestsTab(app, ep);

  return h('div', { style: 'height:100%;overflow-y:auto' },
    h('div', { style: 'max-width:900px;margin:0 auto;padding:22px 28px 64px 28px' }, head, body),
    eventEditorDialog(app), eventTestDialog(app));
}

function configTab(app, ep, active) {
  const s = app.s;
  const sequential = ep.mode === 'sequence';

  const authMissing = ep.config.auth.enabled && !authConfigured(ep.config.auth);
  const authBanner = h('div', { style: `display:flex;align-items:center;gap:12px;background:${authMissing ? '#1c1710' : '#191712'};border-radius:var(--radius-sm);padding:15px 18px;margin-bottom:26px` },
    h('span', { style: `width:34px;height:34px;border-radius:var(--radius-sm);background:#221d17;color:${authMissing ? '#d69a3c' : '#b28de0'};display:flex;align-items:center;justify-content:center;flex-shrink:0` }, raw((authMissing ? icons.warning : icons.lock)({ w: 17 }))),
    h('div', { style: 'flex:1' },
      h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7' }, 'Authentication'),
      authMissing
        ? h('div', { style: 'font-size:12px;color:#c9ad7e;margin-top:2px' }, `Requires ${ep.config.auth.method} — no ${credLabel(ep.config.auth.method)} set, every request is rejected`)
        : ep.config.auth.enabled
          ? h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'Requires ', h('span', { style: 'color:#b28de0' }, ep.config.auth.method), ' — configure in settings')
          : h('div', { style: 'font-size:12px;color:#8a837a;margin-top:2px' }, 'Open — no authentication required')),
    h('button', { style: 'font-size:12px;color:#7a746a;background:#141210;border-radius:var(--radius-xs);padding:5px 10px', onclick: app.navSettings }, 'Edit'));

  const modeRow = h('div', { style: 'display:flex;align-items:center;gap:16px;background:#191712;border-radius:var(--radius-sm);padding:15px 18px;margin-bottom:26px' },
    h('div', { style: 'flex:1' },
      h('div', { style: 'font-size:11.5px;color:#8a837a;margin-bottom:5px' }, 'Currently responding with'),
      h('div', { style: 'display:flex;align-items:center;gap:9px' },
        h('span', { style: 'font-size:16px;font-weight:600;color:#f2ede3' }, sequential ? 'Sequence' : (active ? active.name : '—')),
        active ? h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${statusColor(active.status)};background:#141210;border-radius:var(--radius-xs);padding:2px 8px` }, String(active.status)) : null)),
    h('div', { style: 'display:flex;align-items:center;gap:11px' },
      h('div', { style: 'text-align:right' },
        h('div', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7' }, 'Response mode'),
        h('div', { style: 'font-size:11px;color:#7a746a;max-width:200px' }, sequential ? 'Cycle scenarios in order per request' : 'Always the active scenario')),
      h('div', { style: 'display:flex;align-items:center;gap:9px' },
        h('span', { style: `font-size:12px;font-weight:600;color:${sequential ? '#7a746a' : '#e8e2d7'}` }, 'Single'),
        modeToggle(sequential, app.toggleSequential),
        h('span', { style: `font-size:12px;font-weight:600;color:${sequential ? '#e8e2d7' : '#7a746a'}` }, 'Sequential'))));

  const scenarioCards = (ep.scenarios || []).map((sc, i) => scenarioCard(app, ep, sc, i, sequential));
  const addScenario = s.addScenarioOpen ? addScenarioForm(app) : h('button', { style: 'display:flex;align-items:center;justify-content:center;gap:8px;background:#141210;color:#8a837a;border-radius:var(--radius-sm);padding:12px;font-size:13px;font-weight:600', onclick: app.openAddScenario }, raw(icons.plus({ w: 15, sw: 2 })), 'Add scenario');

  const rulesHeader = h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:13px' },
    h('div', {},
      h('h2', { style: 'margin:0;font-size:15px;font-weight:600;color:#c9c2b6' }, 'Matching rules'),
      h('p', { style: 'margin:4px 0 0 0;font-size:12px;color:#7a746a' }, 'Override the active scenario when a request matches a condition.')),
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:#211d17;color:#d9d3c7;border-radius:var(--radius-xs);padding:8px 13px;font-size:12.5px;font-weight:600;flex-shrink:0', onclick: app.openAddRule }, raw(icons.plus({ w: 14, sw: 2 })), 'Add rule'));
  const addRule = s.addRuleOpen ? addRuleForm(app, ep) : null;
  const rules = ep.matchRules || [];
  const ruleList = rules.length ? h('div', { style: 'display:flex;flex-direction:column;gap:9px' }, ...rules.map((r, i) => ruleRow(app, ep, r, i, rules.length)))
    : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:22px;text-align:center;font-size:12.5px;color:#7a746a' }, 'No matching rules — every request gets the active scenario.');

  return h('div', {}, authBanner, modeRow,
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:13px' },
      h('h2', { style: 'margin:0;font-size:15px;font-weight:600;color:#c9c2b6' }, 'Response scenarios'),
      h('span', { style: 'font-size:12px;color:#7a746a' }, `${(ep.scenarios || []).length} total`)),
    h('div', { style: 'display:flex;flex-direction:column;gap:11px;margin-bottom:34px' }, ...scenarioCards, addScenario),
    rulesHeader, addRule, ruleList);
}

function modeToggle(on, onClick) {
  return h('button', { style: `position:relative;width:44px;height:24px;border-radius:20px;padding:0;flex-shrink:0;cursor:pointer;background:${on ? '#238636' : 'rgba(245,240,230,0.13)'}`, onclick: onClick },
    h('span', { style: `position:absolute;top:3px;left:${on ? '23px' : '3px'};width:18px;height:18px;border-radius:50%;background:#fff;transition:left .16s` }));
}

function scenarioCard(app, ep, sc, i, sequential) {
  const s = app.s;
  const editing = s.editingScenario === sc.id;
  const expanded = s.expandedScenario === sc.id || editing;
  const head = h('div', { style: 'display:flex;align-items:center;gap:13px;padding:14px 16px' },
    sequential
      ? h('span', { style: "width:22px;height:22px;flex-shrink:0;border-radius:var(--radius-xs);background:#221d17;color:#238636;display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700" }, String(i + 1))
      : h('button', { title: 'Set active', style: `width:22px;height:22px;flex-shrink:0;border-radius:50%;background:${sc.active ? '#238636' : 'transparent'};box-shadow:${sc.active ? 'none' : 'inset 0 0 0 1.5px #3a342b'};display:flex;align-items:center;justify-content:center`, onclick: () => app.activateScenario(sc.id) }, sc.active ? raw(icons.check({ w: 11, stroke: '#0d1f14', sw: 3 })) : null),
    h('div', { style: 'flex:1;min-width:0;cursor:pointer;display:flex;align-items:center;gap:10px', onclick: () => app.expandScenario(sc.id) },
      h('span', { style: 'font-size:14.5px;font-weight:600;color:#efe9df' }, sc.name),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:${statusColor(sc.status)};background:#141210;border-radius:var(--radius-xs);padding:2px 8px` }, String(sc.status)),
      h('span', { style: 'font-size:11.5px;color:#7a746a' }, sc.delay ? sc.delay + 'ms delay' : 'no delay')),
    !sequential && sc.active ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:0.08em;color:#238636" }, 'ACTIVE') : null,
    h('button', { title: 'Edit scenario', style: 'background:transparent;color:#57524a;padding:4px;display:flex', onclick: () => app.openEditScenario(sc) }, raw(icons.edit({ w: 15, sw: 1.8 }))),
    (ep.scenarios || []).length > 1 ? h('button', { title: 'Delete scenario', style: 'background:transparent;color:#57524a;padding:4px;display:flex', onclick: () => app.deleteScenario(sc.id) }, raw(icons.trash({ w: 15, sw: 1.8 }))) : null,
    h('button', { style: 'background:transparent;color:#6a655c;padding:4px;display:flex', onclick: () => app.expandScenario(sc.id) }, raw(icons.chevRight({ w: 16, sw: 2, style: `transition:transform .16s;transform:rotate(${expanded ? 90 : 0}deg)` }))));

  const card = h('div', { style: `background:#191712;border-radius:var(--radius-sm);overflow:hidden;box-shadow:${sc.active && !sequential ? 'inset 0 0 0 1px rgba(35,134,54,0.35)' : 'none'}` }, head);
  if (editing) {
    card.appendChild(scenarioEditForm(app));
    card.appendChild(h('div', { style: 'padding:0 16px 16px' }, scenarioEventsPanel(app, sc)));
  } else if (expanded) {
    const headersArr = Object.entries(sc.headers || {});
    card.appendChild(h('div', { style: 'padding:2px 16px 16px 16px' },
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px' },
        h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:10px 12px' }, h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:4px' }, 'Status code'), h('div', { style: `font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:${statusColor(sc.status)}` }, String(sc.status))),
        h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:10px 12px' }, h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:4px' }, 'Artificial delay'), h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:#c2bbb0" }, sc.delay ? sc.delay + 'ms' : 'none'))),
      headersArr.length ? h('div', {}, h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:6px' }, 'Response headers'),
        h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:4px 0;margin-bottom:12px' }, ...headersArr.map(([k, v]) => h('div', { style: 'display:grid;grid-template-columns:200px 1fr;gap:12px;padding:6px 12px' }, h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#6a9fd4" }, k), h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#c2bbb0" }, String(v)))))) : null,
      codeBlock(sc.body || '', { language: contentLanguage(sc.contentType), label: 'Response body', style: "margin:0;background:#141210;border-radius:var(--radius-xs);padding:13px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.6;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" }),
      scenarioEventsPanel(app, sc)));
  }
  return card;
}

function scenarioEditForm(app) {
  const s = app.s, es = s.editScenario;
  const responseVariables = templateSuggestionsFor(app, 'mockResponse');
  return h('div', { style: 'padding:2px 16px 16px 16px' },
    h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', {}, fieldLabel('Name'), textInput(es.name, 'e.g. Rate limited', (v) => app.setEditScenario('name', v))),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:10px' },
        h('div', {}, fieldLabel('Status'), textInput(es.status, '', (v) => app.setEditScenario('status', v), true)),
        h('div', {}, fieldLabel('Delay (ms)'), textInput(es.delay, '', (v) => app.setEditScenario('delay', v), true)),
        h('div', {}, fieldLabel('Content-Type'), select(app.selectHelper('scen-edit-ct', es.contentType, CT_OPTS, (v) => { app.setEditScenario('contentType', v); return true; }, { mono: true })))),
      h('div', {}, fieldLabel('Response body'), codeEditor(es.body, 5, (v) => app.setEditScenario('body', v), { language: contentLanguage(es.contentType), templateSuggestions: responseVariables })),
      h('div', { style: 'display:flex;gap:8px' },
        h('button', { style: 'background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.saveEditScenario }, 'Save changes'),
        h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.cancelEditScenario }, 'Cancel'))));
}

function fieldLabel(t) { return h('div', { style: 'font-size:11.5px;color:#948d83;margin-bottom:6px' }, t); }
function textInput(value, placeholder, onInput, mono) {
  return h('input', { value, placeholder, style: `width:100%;background:#0f0e0b;border-radius:var(--radius-xs);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.05);font-size:13px;color:#e8e2d7;${mono ? "font-family:'IBM Plex Mono',monospace;" : ''}`, oninput: (e) => onInput(e.target.value) });
}

function addScenarioForm(app) {
  const s = app.s, ns = s.newScenario;
  const responseVariables = templateSuggestionsFor(app, 'mockResponse');
  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:16px;animation:sd-in .14s ease' },
    h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7;margin-bottom:14px' }, 'New scenario'),
    h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', {}, fieldLabel('Name'), textInput(ns.name, 'e.g. Rate limited', (v) => app.setNewScenario('name', v))),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:10px' },
        h('div', {}, fieldLabel('Status'), textInput(ns.status, '', (v) => app.setNewScenario('status', v), true)),
        h('div', {}, fieldLabel('Delay (ms)'), textInput(ns.delay, '', (v) => app.setNewScenario('delay', v), true)),
        h('div', {}, fieldLabel('Content-Type'), select(app.selectHelper('scen-ct', ns.contentType, CT_OPTS, (v) => { app.setNewScenario('contentType', v); return true; }, { mono: true })))),
      h('div', {}, fieldLabel('Response body'), codeEditor(ns.body, 5, (v) => app.setNewScenario('body', v), { language: contentLanguage(ns.contentType), templateSuggestions: responseVariables })),
      h('div', { style: 'display:flex;gap:8px' },
        h('button', { style: 'background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.addScenario }, 'Add scenario'),
        h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.cancelAddScenario }, 'Cancel'))));
}

function addRuleForm(app, ep) {
  const s = app.s, nr = s.newRule;
  const thenOpts = (ep.scenarios || []).map((sc) => ({ value: sc.id, label: sc.name, color: statusColor(sc.status) }));
  const noKey = nr.when === 'method' || nr.when === 'path'; // extractField ignores key for these
  const noValueNeeded = nr.op === 'exists';

  const valueField = nr.when === 'method'
    ? select(app.selectHelper('rule-value-method', nr.value, METHOD_VALUE_OPTS, (v) => app.setNewRule('value', v), { mono: true }))
    : textInput(nr.value, noValueNeeded ? '(not used for "exists")' : 'decline', (v) => app.setNewRule('value', v), true);

  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:16px;margin-bottom:10px;animation:sd-in .14s ease' },
    h('div', { style: 'font-size:13.5px;font-weight:600;color:#e8e2d7;margin-bottom:14px' }, 'New matching rule'),
    h('div', { style: 'display:grid;grid-template-columns:150px 1fr 130px 1fr;gap:10px;margin-bottom:12px' },
      h('div', {}, fieldLabel('When'), select(app.selectHelper('rule-when', nr.when, WHEN_OPTS, (v) => app.setNewRule('when', v)))),
      h('div', {}, fieldLabel('Key'), noKey
        ? h('div', { style: "display:flex;align-items:center;height:37px;padding:0 12px;font-size:12.5px;color:#57524a;font-style:italic" }, KEY_PLACEHOLDER[nr.when])
        : textInput(nr.key, KEY_PLACEHOLDER[nr.when] || 'key', (v) => app.setNewRule('key', v), true)),
      h('div', {}, fieldLabel('Operator'), select(app.selectHelper('rule-op', nr.op, OP_OPTS, (v) => app.setNewRule('op', v)))),
      h('div', {}, fieldLabel('Value'), noValueNeeded
        ? h('div', { style: "display:flex;align-items:center;height:37px;padding:0 12px;font-size:12.5px;color:#57524a;font-style:italic" }, '(not used for "exists")')
        : valueField)),
    h('div', { style: 'max-width:280px;margin-bottom:14px' }, fieldLabel('Return scenario'), select(app.selectHelper('rule-then', nr.then, thenOpts, (v) => app.setNewRule('then', v)))),
    h('div', { style: 'display:flex;gap:8px' },
      h('button', { style: 'background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.addRule }, 'Add rule'),
      h('button', { style: 'background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:9px 16px;font-size:13px;font-weight:600', onclick: app.cancelAddRule }, 'Cancel')));
}

function moveBtn(dir, disabled, onClick) {
  const path = dir === 'up' ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6';
  return h('button', {
    title: disabled ? null : (dir === 'up' ? 'Move up' : 'Move down'),
    disabled,
    style: `width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:transparent;color:${disabled ? '#3a342b' : '#6a655c'};flex-shrink:0`,
    onclick: disabled ? null : onClick,
  }, raw(`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`));
}

function ruleRow(app, ep, r, i, total) {
  const thenSc = (ep.scenarios || []).find((sc) => sc.id === r.then);
  const whenLabel = WHEN_LABELS[r.when] || r.when;
  const row = h('div', { style: `display:flex;align-items:center;gap:9px;background:#191712;border-radius:var(--radius-sm);padding:12px 16px;flex-wrap:wrap;transition:opacity .15s;opacity:${r.enabled ? 1 : 0.5}` },
    h('div', { style: 'display:flex;flex-direction:column;gap:1px;margin-right:2px' },
      moveBtn('up', i === 0, () => app.moveRule(r.id, 'up')),
      moveBtn('down', i === total - 1, () => app.moveRule(r.id, 'down'))),
    h('span', { style: 'font-size:11px;font-weight:600;color:#8a837a' }, 'WHEN'),
    h('span', { style: 'font-size:11.5px;color:#b28de0;background:#1a1620;border-radius:var(--radius-xs);padding:3px 8px' }, whenLabel),
    r.key ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#e8e2d7" }, r.key) : null,
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#6a9fd4" }, r.op),
    r.op !== 'exists' ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#8fb98a" }, r.value) : null,
    raw(icons.arrowRight({ w: 16, stroke: '#57524a', sw: 1.8, style: 'margin:0 3px' })),
    h('span', { style: 'font-size:11px;font-weight:600;color:#8a837a' }, 'RETURN'),
    h('span', { style: `font-size:12.5px;font-weight:600;color:${thenSc ? statusColor(thenSc.status) : '#cfc8bc'}` }, thenSc ? thenSc.name : '—'),
    h('span', { style: 'margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0' },
      toggle(r.enabled, () => app.toggleRuleEnabled(r)),
      h('button', { title: 'Delete rule', style: 'background:transparent;color:#57524a;padding:4px;display:flex', onclick: () => app.deleteRule(r.id) }, raw(icons.trash({ w: 15, sw: 1.8 })))));
  return row;
}

// ---------------- requests tab ----------------
function requestsTab(app, ep) {
  const s = app.s;
  if (s.mockReqSelected) return mockReqDetail(app, s.mockReqSelected);
  if (!s.feed.length) return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:52px;text-align:center' },
    h('div', { style: 'font-size:14.5px;font-weight:600;color:#c9c2b6;margin-bottom:6px' }, 'No requests yet'),
    h('div', { style: 'font-size:12.5px;color:#7a746a' }, 'Calls made to this mock server will show up here.'));
  const rows = s.feed.slice().reverse().map((r) => {
    const row = h('div', { style: 'display:grid;grid-template-columns:24px 100px 60px 1fr 50px 64px;gap:11px;align-items:center;padding:9px 16px;cursor:pointer', onclick: () => app.selectMockReq(r.id) },
      h('span', { style: 'display:flex;align-items:center;justify-content:center' }, h('span', { style: `width:6px;height:6px;border-radius:50%;background:${methodColor(r.method)}` })),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7a746a" }, fmtClock(r.receivedAt)),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:${methodColor(r.method)}` }, r.method),
      h('span', { style: 'font-size:12.5px;color:#d3ccc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.event || r.path),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:${statusColor(r.status)}` }, String(r.status)),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6a655c;text-align:right" }, fmtBytes(r.size)));
    row.addEventListener('mouseenter', () => { row.style.background = '#1c1913'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
    return row;
  });
  return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);overflow:hidden' },
    h('div', { style: "display:grid;grid-template-columns:24px 100px 60px 1fr 50px 64px;gap:11px;padding:9px 16px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:0.06em;color:#4c473f" },
      h('span', {}), h('span', {}, 'TIME'), h('span', {}, 'METHOD'), h('span', {}, 'SCENARIO'), h('span', {}, 'ST'), h('span', { style: 'text-align:right' }, 'SIZE')),
    ...rows);
}

function mockReqDetail(app, r) {
  const s = app.s;
  const tab = (id, label) => h('button', { style: `background:transparent;padding:0 0 10px 0;font-size:13px;font-weight:600;color:${s.mockReqTab === id ? '#f2ede3' : '#7a746a'};box-shadow:${s.mockReqTab === id ? 'inset 0 -2px 0 #edecec' : 'none'}`, onclick: () => app.setMockReqTab(id) }, label);
  const meta = (label, value) => h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:13px 15px' }, h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:5px' }, label), h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#d3ccc0;overflow-wrap:anywhere" }, value));
  const headersArr = Object.entries(r.headers || {});
  const queryArr = Object.entries(r.query || {});
  let content;
  if (s.mockReqTab === 'headers') content = kv(headersArr);
  else if (s.mockReqTab === 'query') content = queryArr.length ? kv(queryArr) : box('No query parameters on this request.');
  else if (s.mockReqTab === 'response') content = codeBlock(r.responseBody || '', { label: 'Response', style: "margin:0;background:#141210;border-radius:var(--radius-sm);padding:18px 20px;font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.65;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" });
  else content = r.body ? codeBlock(r.body, { label: 'Request body', style: "margin:0;background:#141210;border-radius:var(--radius-sm);padding:18px 20px;font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.65;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" }) : box('No request body on this call.');
  return h('div', { style: 'animation:sd-in .12s ease' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.backToMockReqs }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Back to requests'),
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap' },
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${methodColor(r.method)};background:#191712;border-radius:var(--radius-xs);padding:4px 9px` }, r.method),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:14px;color:#e8e2d7" }, r.path),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:700;color:${statusColor(r.status)}` }, '→ ' + r.status),
      h('span', { style: 'margin-left:auto;font-size:12.5px;color:#7a746a' }, 'matched ', h('span', { style: 'color:#c9c2b6;font-weight:600' }, r.event || '—'))),
    h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:22px' },
      meta('Received at', fmtStamp(r.receivedAt)), meta('Source IP', r.ip || '—'), meta('Payload size', fmtBytes(r.size)), meta('Content-Type', r.contentType || '—')),
    h('div', { style: 'display:flex;align-items:center;gap:22px;margin-bottom:18px;box-shadow:inset 0 -1px 0 rgba(245,240,230,0.06)' },
      tab('body', 'Request body'), tab('headers', `Headers (${headersArr.length})`), tab('query', 'Query params'), tab('response', 'Response returned')),
    content);
}
function kv(entries) {
  return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);overflow:hidden' }, ...entries.map(([k, v]) =>
    h('div', { style: 'display:grid;grid-template-columns:230px 1fr;gap:16px;padding:11px 18px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#6a9fd4;overflow-wrap:anywhere" }, k),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#c2bbb0;overflow-wrap:anywhere" }, String(v)))));
}
function box(msg) { return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:26px;text-align:center;font-size:13px;color:#7a746a' }, msg); }
