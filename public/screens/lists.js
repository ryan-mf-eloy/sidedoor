// Dashboard, Webhooks list, and Mock Servers list.
import { h, raw, icons, kebabMenu, fmtRel, methodColor, statusColor, segment, sparkline } from '../ui.js';
import { endpointMenuItems, scrim, label, input, errline } from './endpoint.js';
import { protocolColor, protocolLabel } from './realtime.js';

function epKebab(app, ep) {
  const id = 'epmenu-' + ep.id;
  return kebabMenu({ open: app.s.dropdown === id, onToggle: () => app.setDropdown(id), onClose: () => app.closeDropdown(), items: endpointMenuItems(app, ep), size: 28 });
}

const PAGE = 'padding:34px 40px 64px 40px;max-width:1080px;margin:0 auto';

function groupByProject(endpoints) {
  const groups = new Map(); // key: project id, or '' for the synthetic "No project" bucket
  for (const ep of endpoints) {
    const key = ep.project ? ep.project.id : '';
    if (!groups.has(key)) groups.set(key, { project: ep.project || null, items: [] });
    groups.get(key).items.push(ep);
  }
  // "No project" last.
  return [...groups.values()].sort((a, b) => (!a.project ? 1 : !b.project ? -1 : a.project.name.localeCompare(b.project.name)));
}

function primaryBtn(label, onClick, iconFn) {
  const b = h('button', { style: 'display:flex;align-items:center;gap:8px;background:#edecec;color:#1a0e07;border-radius:var(--radius-sm);padding:10px 15px;font-size:13.5px;font-weight:600;flex-shrink:0', onclick: onClick },
    iconFn ? raw(iconFn({ w: 15, sw: 2.1 })) : null, label);
  b.addEventListener('mouseenter', () => { b.style.background = '#ffffff'; });
  b.addEventListener('mouseleave', () => { b.style.background = '#edecec'; });
  return b;
}

const OVERVIEW_PERIODS = [{ value: '24h', label: '24H' }, { value: '7d', label: '7D' }, { value: '30d', label: '30D' }];

function trendBadge(pct) {
  if (!pct) return h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:#6a655c" }, '—');
  const up = pct > 0;
  return h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:${up ? '#238636' : '#e5675c'}` }, `${up ? '▲' : '▼'} ${Math.abs(pct)}%`);
}

function statusRow(dotColor, label, count, total) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return h('div', { style: 'display:flex;align-items:center;gap:9px;padding:6px 0' },
    h('span', { style: `width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0` }),
    h('span', { style: 'font-size:12.5px;color:#a8a196;flex:1' }, label),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#cfc8bc" }, String(count)),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6a655c;width:34px;text-align:right" }, `${pct}%`));
}

// "Traffic overview": total requests across webhooks + mocks, trend vs the
// previous equivalent period, a volume sparkline, and a status-code
// breakdown. The webhook/mock-specific stat tiles above already say *how
// many endpoints* of each kind exist — this answers the different question
// of "is traffic healthy right now," which is genuinely useful in an
// inspection tool regardless of endpoint type.
function requestsOverviewCard(app) {
  const ov = app.s.overview || { period: '24h', total: 0, changePct: 0, series: [], statusBreakdown: {} };
  const b = ov.statusBreakdown || {};
  const total = ov.total || 0;

  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:20px 20px 10px 20px' },
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px' },
      h('h2', { style: 'margin:0;font-size:14px;font-weight:600;color:#c9c2b6' }, 'Traffic overview'),
      segment({ value: ov.period, options: OVERVIEW_PERIODS, onPick: app.setOverviewPeriod })),
    h('div', { style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:3px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:30px;font-weight:500;color:#f2ede3;line-height:1" }, String(total)),
      trendBadge(ov.changePct || 0)),
    h('div', { style: 'font-size:12px;color:#7a746a;margin-bottom:16px' }, 'requests · webhooks + mocks · vs previous period'),
    h('div', { style: 'margin-bottom:14px' }, raw(sparkline(ov.series, { w: 280, h: 56 }))),
    h('div', { style: 'border-top:1px solid rgba(245,240,230,0.06);padding-top:4px' },
      statusRow('#238636', '2xx Success', b.ok || 0, total),
      statusRow('#d69a3c', '4xx Client error', b.clientError || 0, total),
      statusRow('#e5675c', '5xx Server error', b.serverError || 0, total),
      (b.other || 0) > 0 ? statusRow('#948d83', 'Other', b.other, total) : null));
}

export function dashboardScreen(app) {
  const s = app.s;
  const now = Date.now();
  const counts = s.counts || {};
  const funnelActive = s.funnel.state && s.funnel.state.active;
  const funnelColor = funnelActive ? '#7fc79b' : '#8a837a';
  const unsigned = s.endpoints.filter((e) => e.type === 'inspector' && (e.protocol || 'http') === 'http' && !e.signed);
  const hasWarn = funnelActive && unsigned.length > 0;

  // create split-button
  const createMenu = s.createMenuOpen ? h('div', {},
    h('div', { style: 'position:fixed;inset:0;z-index:40', onclick: app.closeCreateMenu }),
    h('div', { style: 'position:absolute;top:calc(100% + 8px);right:0;z-index:41;width:288px;background:#211d17;border-radius:var(--radius-md);padding:6px;box-shadow:0 20px 48px rgba(0,0,0,0.62);animation:sd-in .12s ease' },
      h('div', { style: 'padding:8px 11px 7px 11px;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6a655c' }, 'Create'),
      createMenuItem(icons.webhook, '#238636', 'Webhook', 'Receive & inspect requests', () => { app.closeCreateMenu(); app.newWebhook(); }),
      createMenuItem(icons.mock, '#d69a3c', 'Mock server', 'HTTP, WebSocket, Socket.IO or GraphQL', () => { app.closeCreateMenu(); app.chooseMockProtocol(); }))) : null;

  const createBtn = h('button', { style: 'display:flex;align-items:center;gap:9px;background:#edecec;color:#1a0e07;border-radius:var(--radius-sm);padding:10px 14px;font-size:13.5px;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,0.5),0 6px 18px rgba(0,0,0,0.34);cursor:pointer', onclick: app.toggleCreateMenu },
    raw(icons.plus({ w: 16, sw: 2.2 })), h('span', {}, 'New endpoint'),
    h('span', { style: 'width:1px;height:15px;background:rgba(26,14,7,0.16)' }),
    raw(icons.chevDown({ w: 13, sw: 2.3, style: `transition:transform .16s;transform:rotate(${s.createMenuOpen ? 180 : 0}deg)` })));

  const stat = (label, value, extra) => h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:17px 18px' },
    h('div', { style: 'font-size:12px;color:#8a837a' }, label),
    extra || h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:26px;font-weight:500;color:#f2ede3;margin-top:9px;line-height:1" }, String(value)));

  const funnelStat = h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:11px' },
    h('span', { style: `width:8px;height:8px;border-radius:50%;background:${funnelActive ? '#238636' : '#4c473f'}` }),
    h('span', { style: `font-size:16px;font-weight:600;color:${funnelColor}` }, funnelActive ? 'Online' : 'Offline'));

  const activityRows = (s.activity || []).map((a, i) => {
    const isMock = a.epType === 'mock';
    const row = h('div', { style: `display:grid;grid-template-columns:88px 54px 1fr 150px 46px;gap:14px;align-items:center;padding:11px 18px;cursor:pointer;background:${i % 2 ? 'rgba(255,255,255,0.014)' : 'transparent'}`, onclick: () => app.openRequest(a.id, a.endpointId) },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#6a655c" }, fmtRel(a.receivedAt, now)),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:${methodColor(a.method)}` }, a.method),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#d3ccc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, a.event || a.path),
      h('span', { style: 'display:flex;align-items:center;gap:6px;font-size:12.5px;color:#8a837a;overflow:hidden' },
        raw(icons[isMock ? 'mock' : 'webhook']({ w: 12, stroke: isMock ? '#d69a3c' : '#238636' })),
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.epName)),
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11.5px;font-weight:600;color:${statusColor(a.status)};text-align:right` }, String(a.status)));
    row.addEventListener('mouseenter', () => { row.style.background = '#201c16'; });
    row.addEventListener('mouseleave', () => { row.style.background = i % 2 ? 'rgba(255,255,255,0.014)' : 'transparent'; });
    return row;
  });

  return h('div', { style: PAGE },
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:30px' },
      h('div', {},
        h('h1', { style: 'margin:0;font-size:26px;font-weight:600;color:#f2ede3;letter-spacing:-0.025em' }, 'Overview'),
        h('p', { style: 'margin:7px 0 0 0;font-size:14px;color:#8a837a' }, `Local debugging endpoints running on ${(s.baseUrls.local || '').replace(/^https?:\/\//, '')}`)),
      h('div', { style: 'position:relative;flex-shrink:0' }, createBtn, createMenu)),
    h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:38px' },
      stat('Webhooks', counts.webhooks || 0), stat('Requests received', counts.totalRequests || 0),
      stat('Mock servers', counts.mocks || 0), stat('Funnel', 0, funnelStat)),
    hasWarn ? h('div', { style: 'display:flex;align-items:center;gap:12px;background:#1c1710;border-radius:var(--radius-sm);padding:13px 16px;margin-bottom:30px' },
      raw(icons.warning({ w: 17, stroke: '#d69a3c', sw: 1.8 })),
      h('span', { style: 'flex:1;font-size:13px;color:#c9ad7e' }, `${unsigned.length} webhook${unsigned.length > 1 ? 's' : ''} receiving public traffic without signature validation`),
      h('button', { style: 'background:transparent;color:#d69a3c;font-size:12.5px;font-weight:600;padding:0', onclick: app.navTailscale }, 'Review →')) : null,
    h('div', { style: 'display:grid;grid-template-columns:1fr 300px;gap:20px;align-items:start' },
      h('div', {},
        h('div', { style: 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px' },
          h('h2', { style: 'margin:0;font-size:14px;font-weight:600;color:#c9c2b6' }, 'Recent activity'),
          h('span', { style: 'font-size:12px;color:#6a655c' }, 'webhooks & mocks combined')),
        h('div', { style: 'background:#191712;border-radius:var(--radius-sm);overflow:hidden' },
          activityRows.length ? activityRows : h('div', { style: 'padding:40px;text-align:center;font-size:13px;color:#7a746a' }, 'No activity yet — point a provider at a webhook URL, or call a mock.'))),
      requestsOverviewCard(app)));
}

function createMenuItem(iconFn, color, title, sub, onClick) {
  const b = h('button', { style: 'width:100%;display:flex;align-items:center;gap:12px;padding:10px 11px;border-radius:var(--radius-sm);text-align:left;background:transparent;cursor:pointer', onclick: onClick },
    h('span', { style: `width:34px;height:34px;border-radius:var(--radius-sm);background:#221d17;display:flex;align-items:center;justify-content:center;color:${color};flex-shrink:0` }, raw(iconFn({ w: 18 }))),
    h('span', { style: 'flex:1;min-width:0' },
      h('span', { style: 'display:block;font-size:13.5px;font-weight:600;color:#efe9df' }, title),
      h('span', { style: 'display:block;font-size:11.5px;color:#8a837a;margin-top:1px' }, sub)),
    raw(icons.chevRight({ w: 15, stroke: '#6a655c', sw: 1.9 })));
  b.addEventListener('mouseenter', () => { b.style.background = '#2f2921'; });
  b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
  return b;
}

export function webhooksScreen(app) {
  const s = app.s;
  const eps = s.endpoints.filter((e) => e.type === 'inspector' && (e.protocol || 'http') === 'http');
  return h('div', { style: PAGE },
    listHeader('Webhooks', 'Receive & inspect incoming requests. Each endpoint gets a unique URL and keeps full history.', primaryBtn('New webhook', app.newWebhook, icons.plus)),
    eps.length ? groupedGrid(app, eps, webhookCard) : emptyState('No webhooks yet', 'Create one to start capturing requests.'));
}

export function mocksScreen(app) {
  const s = app.s;
  const all = s.endpoints.filter(isMockServerEndpoint);
  const selectedProtocol = s.mockProtocolFilter || 'all';
  const eps = selectedProtocol === 'all' ? all : all.filter((endpoint) => (endpoint.protocol || 'http') === selectedProtocol);
  const filterOptions = [
    { value: 'all', label: 'All', count: all.length },
    { value: 'http', label: 'HTTP', count: all.filter((endpoint) => (endpoint.protocol || 'http') === 'http').length },
    { value: 'websocket', label: 'WebSocket', count: all.filter((endpoint) => endpoint.protocol === 'websocket').length },
    { value: 'socketio', label: 'Socket.IO', count: all.filter((endpoint) => endpoint.protocol === 'socketio').length },
    { value: 'graphql', label: 'GraphQL', count: all.filter((endpoint) => endpoint.protocol === 'graphql').length },
  ];
  return h('div', { style: PAGE },
    listHeader('Mock Servers', 'Build and exercise HTTP, WebSocket, Socket.IO and GraphQL APIs from one place.', primaryBtn('New mock server', app.chooseMockProtocol, icons.plus)),
    h('div', { style: 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:-8px 0 22px' }, ...filterOptions.map((option) => mockProtocolFilter(app, option, selectedProtocol))),
    all.length
      ? eps.length
        ? groupedGrid(app, eps, mockCard)
        : emptyState(`No ${filterOptions.find((option) => option.value === selectedProtocol).label} mock servers yet`, 'Choose another protocol filter or create a new mock server.')
      : emptyState('No mock servers yet', 'Choose a protocol to create your first mock server.'));
}

// A realtime inspector created before the unified navigation remains visible
// here. Hiding it after removing the old WebSockets/GraphQL entries would
// make a user-owned endpoint impossible to reach; new endpoints are always
// created as mocks from the protocol picker.
export function isMockServerEndpoint(endpoint) {
  return endpoint && (endpoint.type === 'mock' || (endpoint.protocol || 'http') !== 'http');
}

function mockProtocolFilter(app, option, selectedProtocol) {
  const selected = option.value === selectedProtocol;
  const button = h('button', {
    'aria-pressed': selected ? 'true' : 'false',
    style: `display:inline-flex;align-items:center;gap:7px;background:${selected ? '#2f2820' : '#191712'};color:${selected ? '#f2ede3' : '#948d83'};border-radius:var(--radius-xs);padding:7px 10px;font-size:12px;font-weight:600;box-shadow:${selected ? 'inset 0 0 0 1px rgba(245,240,230,.1)' : 'inset 0 0 0 1px rgba(245,240,230,.04)'};cursor:pointer`,
    onclick: () => app.setMockProtocolFilter(option.value),
  }, option.label, h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:${selected ? '#cfc8bc' : '#6a655c'}` }, String(option.count)));
  button.addEventListener('mouseenter', () => { if (!selected) button.style.background = '#211d17'; });
  button.addEventListener('mouseleave', () => { if (!selected) button.style.background = '#191712'; });
  return button;
}

export function mockProtocolPickerScreen(app) {
  const choices = [
    { protocol: 'http', title: 'HTTP API', detail: 'Routes, responses, auth, scenarios and callbacks.', icon: icons.mock, color: '#d69a3c', onPick: app.newMock },
    { protocol: 'websocket', title: 'WebSocket', detail: 'Stateful RFC 6455 conversations with ordered scripts.', icon: icons.webhook, color: '#45ae85', onPick: () => app.newRealtime('websocket') },
    { protocol: 'socketio', title: 'Socket.IO', detail: 'Events, acknowledgements, polling and WebSocket transport.', icon: icons.webhook, color: '#6a9fd4', onPick: () => app.newRealtime('socketio') },
    { protocol: 'graphql', title: 'GraphQL', detail: 'SDL, deterministic fixtures and subscriptions.', icon: icons.layers, color: '#b28de0', onPick: () => app.newRealtime('graphql') },
  ];
  return h('div', { style: 'height:100%;overflow-y:auto' },
    h('div', { style: 'max-width:860px;margin:0 auto;padding:34px 40px 64px' },
      h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.navMocks }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Mock Servers'),
      h('h1', { style: 'margin:0 0 6px;font-size:24px;font-weight:600;color:#f2ede3;letter-spacing:-.02em' }, 'New mock server'),
      h('p', { style: 'margin:0 0 26px;font-size:13.5px;line-height:1.5;color:#8a837a;max-width:620px' }, 'Choose the protocol your client will call. You can configure behavior, security and test data after creating it.'),
      h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:13px' }, ...choices.map((choice) => mockProtocolChoice(choice)))
    )
  );
}

function mockProtocolChoice(choice) {
  const card = h('button', { style: 'min-height:168px;display:flex;flex-direction:column;align-items:flex-start;text-align:left;background:#191712;border-radius:var(--radius-sm);padding:18px;box-shadow:inset 0 0 0 1px rgba(245,240,230,.05);cursor:pointer;transition:background .14s,transform .14s', onclick: choice.onPick },
    h('span', { style: `width:36px;height:36px;border-radius:var(--radius-sm);background:#221d17;color:${choice.color};display:flex;align-items:center;justify-content:center;margin-bottom:16px` }, raw(choice.icon({ w: 18, sw: 1.8 }))),
    h('span', { style: 'font-size:15px;font-weight:600;color:#efe9df' }, choice.title),
    h('span', { style: 'font-size:12px;line-height:1.45;color:#8a837a;margin-top:5px' }, choice.detail),
    h('span', { style: `display:flex;align-items:center;gap:5px;margin-top:auto;padding-top:14px;font-size:11.5px;font-weight:600;color:${choice.color}` }, 'Configure mock', raw(icons.chevRight({ w: 14, stroke: 'currentColor', sw: 2 }))));
  card.addEventListener('mouseenter', () => { card.style.background = '#211d17'; card.style.transform = 'translateY(-1px)'; });
  card.addEventListener('mouseleave', () => { card.style.background = '#191712'; card.style.transform = 'translateY(0)'; });
  return card;
}

function listHeader(title, sub, action) {
  return h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:28px;flex-wrap:wrap' },
    h('div', {}, h('h1', { style: 'margin:0;font-size:26px;font-weight:600;color:#f2ede3;letter-spacing:-0.025em' }, title),
      h('p', { style: 'margin:7px 0 0 0;font-size:14px;color:#8a837a' }, sub)), action);
}
function emptyState(title, sub) {
  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:52px;text-align:center' },
    h('div', { style: 'font-size:15px;font-weight:600;color:#c9c2b6;margin-bottom:6px' }, title),
    h('div', { style: 'font-size:13px;color:#7a746a' }, sub));
}
function projKebab(app, project) {
  const id = 'projmenu-' + project.id;
  const items = [
    { label: 'Rename', icon: icons.edit, onClick: () => app.openProjEditor(project) },
    { label: 'Delete', icon: icons.trash, danger: true, onClick: () => app.askDeleteProj(project) },
  ];
  return kebabMenu({ open: app.s.dropdown === id, onToggle: () => app.setDropdown(id), onClose: () => app.closeDropdown(), items, size: 24 });
}

function groupedGrid(app, eps, cardFn) {
  return h('div', {}, ...groupByProject(eps).map(({ project, items }) => h('div', { style: 'margin-bottom:28px' },
    h('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:13px' },
      h('h2', { style: 'margin:0;font-size:13px;font-weight:600;color:#948d83' }, project ? project.name : 'No project'),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#57524a" }, String(items.length)),
      project ? projKebab(app, project) : null),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(324px,1fr));gap:13px' }, ...items.map((ep) => cardFn(app, ep))))));
}

export function projectEditor(app) {
  const e = app.s.projEditor;
  if (!e) return h('div', {});
  return scrim(90, 404, app.cancelProjEditor,
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:20px' },
      h('span', { style: 'width:34px;height:34px;border-radius:var(--radius-sm);background:#221d17;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#948d83' }, raw(icons.edit({ w: 16 }))),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, 'Rename project'),
        h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, 'Applies to every endpoint in it')),
      h('button', { title: 'Close', style: 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:transparent;color:#6a655c;cursor:pointer;flex-shrink:0', onclick: app.cancelProjEditor }, raw(icons.x({ w: 16, sw: 1.9 })))),
    label('Name'), input(e.name, 'e.g. Gateway', (v) => { e.name = v; }, e.error), errline(e.error),
    h('div', { style: 'display:flex;gap:9px;margin-top:23px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;background:#edecec;color:#1a0e07;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.saveProjEditor }, 'Save changes'),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelProjEditor }, 'Cancel')));
}

export function projectDeleteConfirm(app) {
  const t = app.s.projConfirmDelete;
  if (!t) return h('div', {});
  return scrim(92, 404, app.cancelDeleteProj,
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:15px' },
      h('span', { style: 'width:40px;height:40px;border-radius:var(--radius-md);background:rgba(207,139,127,0.14);display:flex;align-items:center;justify-content:center;flex-shrink:0' }, raw(icons.trash({ w: 20, stroke: '#e08b7f', sw: 1.9 }))),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, 'Delete project?'),
        h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, "This can't be undone"))),
    h('div', { style: 'font-size:13.5px;line-height:1.5;color:#b8b0a4;padding:2px 1px 0' },
      "You're about to delete ", h('span', { style: 'color:#f2ede3;font-weight:600' }, t.name), '. Its endpoints are kept and just become unassigned.'),
    h('div', { style: 'display:flex;gap:9px;margin-top:22px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;gap:7px;background:#c8574a;color:#fdeeec;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.confirmDeleteProj }, raw(icons.trash({ w: 15, sw: 1.9 })), 'Delete project'),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelDeleteProj }, 'Cancel')));
}

function copyBtn(app, text, key, labelIdle, labelHoverColor) {
  const copied = app.s.copied === key;
  const b = h('button', { style: `background:transparent;color:${copied ? '#7fc79b' : '#948d83'};font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;padding:2px 4px`, onclick: (e) => { e.stopPropagation(); app.copy(text, key); } }, copied ? 'Copied' : labelIdle);
  return b;
}

function webhookCard(app, ep) {
  const card = h('div', { style: 'background:#191712;border-radius:var(--radius-sm);transition:background .14s' });
  card.appendChild(h('div', { style: 'display:flex;align-items:center;gap:11px;padding:13px 12px 12px 16px' },
    h('span', { style: 'width:32px;height:32px;border-radius:var(--radius-sm);background:#221d17;color:#238636;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer', onclick: () => app.openEndpoint(ep) }, raw(icons.webhook({ w: 17 }))),
    h('div', { style: 'flex:1;min-width:0;cursor:pointer', onclick: () => app.openEndpoint(ep) }, h('div', { style: 'font-size:14.5px;font-weight:600;color:#efe9df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, ep.name)),
    !ep.signed && (app.s.funnel.state && app.s.funnel.state.active) ? raw(icons.warning({ w: 15, stroke: '#d69a3c', sw: 2 })) : null,
    epKebab(app, ep)));
  card.appendChild(h('div', { style: 'display:flex;align-items:center;gap:7px;margin:0 16px;background:#141210;border-radius:var(--radius-xs);padding:8px 10px' },
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, '/' + ep.slug),
    copyBtn(app, ep.urls.local, 'cl-' + ep.id, 'Local'),
    ep.urls.public ? copyBtn(app, ep.urls.public, 'cp-' + ep.id, 'Public') : null));
  card.appendChild(h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px 14px 16px;cursor:pointer', onclick: () => app.openEndpoint(ep) },
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#8a837a" }, h('span', { style: 'color:#efe9df;font-weight:600' }, String(ep.requestCount || 0)), ' reqs')));
  card.addEventListener('mouseenter', () => { card.style.background = '#1d1a14'; });
  card.addEventListener('mouseleave', () => { card.style.background = '#191712'; });
  return card;
}

function mockCard(app, ep) {
  if ((ep.protocol || 'http') !== 'http') return realtimeMockCard(app, ep);
  const active = (ep.scenarios || []).find((x) => x.active) || (ep.scenarios || [])[0];
  const card = h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px 12px 15px 16px;transition:background .14s' },
    h('div', { style: 'display:flex;align-items:center;gap:11px;margin-bottom:13px' },
      h('span', { style: 'width:32px;height:32px;border-radius:var(--radius-sm);background:#221d17;color:#d69a3c;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer', onclick: () => app.openEndpoint(ep) }, raw(icons.mock({ w: 17 }))),
      h('div', { style: 'flex:1;min-width:0;cursor:pointer', onclick: () => app.openEndpoint(ep) }, h('div', { style: 'font-size:14.5px;font-weight:600;color:#efe9df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, ep.name)),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#7a746a" }, ep.config.auth.enabled ? (ep.config.auth.method === 'bearer' ? 'Bearer' : ep.config.auth.method === 'apikey' ? 'API key' : ep.config.auth.method === 'basic' ? 'Basic' : 'Auth') : 'No auth'),
      epKebab(app, ep)),
    h('div', { style: 'display:flex;align-items:center;gap:8px;background:#141210;border-radius:var(--radius-xs);padding:8px 10px;margin:0 4px 13px 0;cursor:pointer', onclick: () => app.openEndpoint(ep) },
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:${methodColor(ep.method)}` }, ep.method),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, ep.path)),
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;cursor:pointer', onclick: () => app.openEndpoint(ep) },
      h('span', { style: 'font-size:12px;color:#8a837a' }, h('span', { style: 'color:#cfc8bc' }, String((ep.scenarios || []).length)), ' scenarios · active ', h('span', { style: 'color:#cfc8bc' }, active ? active.name : '—'))));
  card.addEventListener('mouseenter', () => { card.style.background = '#1d1a14'; });
  card.addEventListener('mouseleave', () => { card.style.background = '#191712'; });
  return card;
}

function realtimeMockCard(app, ep) {
  const protocol = ep.protocol || 'websocket';
  const icon = protocol === 'graphql' ? icons.layers : icons.webhook;
  const behavior = protocol === 'graphql'
    ? 'HTTP operations + subscriptions'
    : protocol === 'socketio'
      ? 'Events · polling + WebSocket'
      : 'Stateful message conversation';
  const mode = ep.type === 'mock' ? 'Mock' : 'Inspector';
  const card = h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px 12px 15px 16px;transition:background .14s' },
    h('div', { style: 'display:flex;align-items:center;gap:11px;margin-bottom:13px' },
      h('span', { style: `width:32px;height:32px;border-radius:var(--radius-sm);background:#221d17;color:${protocolColor(protocol)};display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer`, onclick: () => app.openEndpoint(ep) }, raw(icon({ w: 17 }))),
      h('div', { style: 'flex:1;min-width:0;cursor:pointer', onclick: () => app.openEndpoint(ep) },
        h('div', { style: 'font-size:14.5px;font-weight:600;color:#efe9df;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, ep.name),
        h('div', { style: 'font-size:10.5px;color:#7a746a;margin-top:2px' }, behavior)),
      epKebab(app, ep)),
    h('div', { style: 'display:flex;align-items:center;gap:8px;background:#141210;border-radius:var(--radius-xs);padding:8px 10px;margin:0 4px 13px 0;cursor:pointer', onclick: () => app.openEndpoint(ep) },
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;color:${protocolColor(protocol)}` }, protocolLabel(protocol).toUpperCase()),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, '/' + ep.slug)),
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;cursor:pointer', onclick: () => app.openEndpoint(ep) },
      h('span', { style: 'font-size:12px;color:#8a837a' }, mode, ' · ', ep.lastActivity ? `activity ${fmtRel(ep.lastActivity)}` : 'no activity yet'),
      h('span', { style: `font-size:11.5px;font-weight:600;color:${ep.config && ep.config.auth && ep.config.auth.enabled ? '#b28de0' : '#7a746a'}` }, ep.config && ep.config.auth && ep.config.auth.enabled ? 'Protected' : 'Open')));
  card.addEventListener('mouseenter', () => { card.style.background = '#1d1a14'; });
  card.addEventListener('mouseleave', () => { card.style.background = '#191712'; });
  return card;
}
