// Sidedoor SPA controller: state, actions, live updates, and the app shell
// (sidebar + header). Screen bodies live in ./screens/*.
import * as api from './api.js';
import { h, raw, clear, closeFloatingPanels, icons, wsIconSvg, copy as clip, toast } from './ui.js';
import { dashboardScreen } from './screens/lists.js';
import { webhooksScreen, mocksScreen, mockProtocolPickerScreen, isMockServerEndpoint, projectEditor, projectDeleteConfirm } from './screens/lists.js';
import { inspectorScreen, requestScreen, diffScreen } from './screens/inspector.js';
import { mockScreen } from './screens/mock.js';
import { settingsScreen } from './screens/settings.js';
import { tailscaleScreen } from './screens/tailscale.js';
import { newInspectorScreen, newMockScreen } from './screens/forms.js';
import { workspaceEditor, workspaceDeleteConfirm } from './screens/workspace.js';
import { endpointEditor, endpointDeleteConfirm } from './screens/endpoint.js';
import { newRealtimeScreen, realtimeScreen } from './screens/realtime.js';
import { isNavigationChange, navigationViewKey } from './navigation-motion.js';

const state = {
  route: 'dashboard', loading: true, now: Date.now(),
  workspaces: [], activeWorkspace: null, sidebarCollapsed: false,
  counts: {}, funnel: { state: null, history: [], exposed: [] }, baseUrls: { local: '', publicBase: null },
  templateCatalog: {},
  endpoints: [], projects: [], activity: [], projQuery: '',
  overview: null, overviewPeriod: '24h',
  activeEp: null, feed: [], feedFilter: { search: '', method: 'ALL' }, previewReqId: null,
  activeReq: null, compareMode: false, selected: [], detailTab: 'body',
  replayOpen: false, replayTarget: '', replayResult: null,
  mockTab: 'config', mockProtocolFilter: 'all', mockReqSelected: null, mockReqTab: 'body', expandedScenario: null,
  addScenarioOpen: false, newScenario: { name: '', status: 200, delay: 0, contentType: 'application/json', body: '{ "ok": true }' },
  editingScenario: null, editScenario: null,
  mockDeliveries: [], selectedDeliveryRun: null, eventEditor: null, eventTest: null,
  realtimeTab: 'sessions', realtimeSessions: [], realtimeSelectedSession: null,
  realtimeScripts: [], realtimeSchema: null, realtimeFixtures: [],
  realtimeError: '', realtimeSchemaValidation: null, realtimeTest: null, realtimeTestResult: null,
  addRuleOpen: false, newRule: { when: 'header', key: '', op: 'equals', value: '', then: '' },
  settingsTab: 'auth', secretReveal: false, settingsRequests: [],
  diff: null,
  dropdown: null, wsMenuOpen: false, wsEditor: null, wsConfirmDelete: null, createMenuOpen: false,
  epEditor: null, epConfirmDelete: null,
  projEditor: null, projConfirmDelete: null,
  form: {
    insp: { name: '', slug: '', slugEdited: false, projectName: '', validate: false, provider: 'stripe', hmacSecret: '', errors: {}, submitted: false },
    mock: { name: '', projectName: '', method: 'POST', path: '/', status: 200, contentType: 'application/json', delay: 0, auth: 'none', authToken: '', authApiKeyName: 'X-Api-Key', authApiKeyLoc: 'header', authUser: '', authPass: '', body: '{\n  "ok": true\n}', errors: {}, submitted: false },
    realtime: { protocol: 'websocket', type: 'mock', name: '', slug: '', projectName: '', sdl: 'type Query { health: String }', sdlValidation: { source: 'type Query { health: String }', valid: true }, errors: {}, submitted: false },
  },
  copied: null,
};

const app = {
  state,
  get s() { return state; },
  templateSuggestions(context) {
    const catalog = state.templateCatalog && state.templateCatalog[context];
    return catalog && Array.isArray(catalog.suggestions) ? catalog.suggestions : [];
  },
  set(patch) { Object.assign(state, patch); render(); },
  render,
};

// ---------------- data loading ----------------
async function boot() {
  try {
    const st = await api.get('/state');
    Object.assign(state, {
      workspaces: st.workspaces, activeWorkspace: st.activeWorkspace,
      sidebarCollapsed: st.sidebarCollapsed, counts: st.counts, baseUrls: st.baseUrls,
      templateCatalog: st.templateCatalog || {},
      funnel: { ...state.funnel, state: st.funnel }, loading: false,
    });
    await loadEndpoints();
    await Promise.all([loadActivity(), loadFunnel(), loadOverview()]);
    // Reconstruct whatever screen/tab/request the hash points at *before* the
    // first paint, so a hard reload never flashes the dashboard first.
    await applyHashRoute();
  } catch (e) {
    state.loading = false;
    toast('Failed to reach the server');
  }
  render();
  api.connectEvents({
    request: (evt) => onLiveRequest(evt),
    delivery: (evt) => onLiveDelivery(evt),
    realtime_session: (evt) => onLiveRealtime(evt),
    realtime_message: (evt) => onLiveRealtime(evt),
    funnel: (fs) => { state.funnel = { ...state.funnel, state: fs }; if (['dashboard', 'tailscale', 'webhooks', 'mocks'].includes(state.route)) render(); },
  });
  window.addEventListener('hashchange', applyHashRoute);
}

async function loadEndpoints() {
  const [eps, projects] = await Promise.all([
    api.get('/endpoints?workspace=' + encodeURIComponent(state.activeWorkspace || '')),
    api.get('/workspaces/' + encodeURIComponent(state.activeWorkspace) + '/projects'),
  ]);
  state.endpoints = eps;
  state.projects = projects;
}
async function loadActivity() { state.activity = await api.get('/activity?workspace=' + encodeURIComponent(state.activeWorkspace || '')); }
async function loadCounts() { const st = await api.get('/state'); state.counts = st.counts; state.baseUrls = st.baseUrls; state.funnel.state = st.funnel; }
async function loadFunnel() { try { state.funnel = await api.get('/funnel'); } catch { /* ignore */ } }
async function loadOverview() {
  state.overview = await api.get('/requests/overview?workspace=' + encodeURIComponent(state.activeWorkspace || '') + '&period=' + state.overviewPeriod);
}

app.loadEndpoints = loadEndpoints;
async function loadDeliveryRuns() {
  if (!state.activeEp) { state.mockDeliveries = []; return; }
  state.mockDeliveries = await api.get('/endpoints/' + state.activeEp.id + '/event-runs?limit=200');
}
app.loadDeliveryRuns = loadDeliveryRuns;

function isRealtimeEndpoint(endpoint) {
  return !!(endpoint && endpoint.protocol && endpoint.protocol !== 'http');
}
function realtimeListRoute() { return 'mocks'; }
function endpointListRoute(endpoint) {
  if (isRealtimeEndpoint(endpoint)) return realtimeListRoute(endpoint);
  return endpoint && endpoint.type === 'mock' ? 'mocks' : 'webhooks';
}
async function loadRealtimeData() {
  const endpoint = state.activeEp;
  if (!isRealtimeEndpoint(endpoint)) {
    state.realtimeSessions = []; state.realtimeSelectedSession = null;
    state.realtimeScripts = []; state.realtimeSchema = null; state.realtimeSchemaValidation = null; state.realtimeFixtures = [];
    return;
  }
  const sessions = await api.get('/endpoints/' + endpoint.id + '/realtime-sessions?limit=200');
  state.realtimeSessions = sessions;
  const selectedId = state.realtimeSelectedSession && state.realtimeSelectedSession.id;
  if (selectedId) {
    try { state.realtimeSelectedSession = await api.get('/realtime-sessions/' + selectedId); }
    catch { state.realtimeSelectedSession = null; }
  }
  if (endpoint.protocol === 'graphql') {
    const [schema, fixtures] = await Promise.all([
      api.get('/endpoints/' + endpoint.id + '/graphql/schema'),
      api.get('/endpoints/' + endpoint.id + '/graphql/fixtures'),
    ]);
    state.realtimeSchema = schema;
    state.realtimeSchemaValidation = { source: schema.sdl, valid: true };
    state.realtimeFixtures = fixtures;
    state.realtimeScripts = [];
  } else if (endpoint.type === 'mock') {
    state.realtimeScripts = await api.get('/endpoints/' + endpoint.id + '/realtime-scripts');
    state.realtimeSchema = null; state.realtimeSchemaValidation = null; state.realtimeFixtures = [];
  } else {
    state.realtimeScripts = []; state.realtimeSchema = null; state.realtimeSchemaValidation = null; state.realtimeFixtures = [];
  }
}
app.loadRealtimeData = loadRealtimeData;

// ---------------- live feed ----------------
function onLiveRequest(evt) {
  // Update the list card counts.
  const listEp = state.endpoints.find((e) => e.id === evt.endpointId);
  if (listEp) { listEp.requestCount = (listEp.requestCount || 0) + 1; listEp.lastActivity = evt.request.receivedAt; }
  const activeMatches = state.activeEp && state.activeEp.id === evt.endpointId;
  if (activeMatches) {
    state.activeEp.requestCount = (state.activeEp.requestCount || 0) + 1;
    state.activeEp.lastActivity = evt.request.receivedAt;
  }
  if (activeMatches && (state.route === 'inspector' || (state.route === 'mock' && state.mockTab === 'requests'))) {
    if (matchesFilter(evt.request)) {
      state.feed.push(evt.request);
      if (state.feed.length > 500) state.feed.shift();
      if (state.route === 'inspector' && !state.previewReqId) state.previewReqId = evt.request.id;
      render();
      scrollFeedToBottom();
      return;
    }
  }
  if (activeMatches && state.route === 'mock') { render(); return; }
  // Keep "Recent verifications" (HMAC tab) and "Recent window usage" (Rate
  // tab) live while Settings is open, instead of the one-time snapshot
  // fetched when the screen was first opened.
  if (state.route === 'settings' && state.activeEp && state.activeEp.id === evt.endpointId) {
    state.settingsRequests = (state.settingsRequests || []).concat([evt.request]).slice(-25);
    render();
    return;
  }
  if (state.route === 'dashboard') { Promise.all([loadActivity(), loadCounts(), loadOverview()]).then(render); }
  else if (state.route === 'webhooks' || state.route === 'mocks') render();
}
function onLiveDelivery(evt) {
  if (!evt || !evt.run || !state.activeEp || state.activeEp.id !== evt.endpointId) return;
  const summary = evt.run;
  const existing = state.mockDeliveries || [];
  state.mockDeliveries = [summary, ...existing.filter((run) => run.id !== summary.id)]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (state.route !== 'mock' || state.mockTab !== 'deliveries') return;
  if (state.selectedDeliveryRun && state.selectedDeliveryRun.id === summary.id) {
    api.get('/event-runs/' + summary.id).then((run) => {
      if (state.selectedDeliveryRun && state.selectedDeliveryRun.id === summary.id) {
        state.selectedDeliveryRun = run;
        render();
      }
    }).catch(() => {});
  } else render();
}
function onLiveRealtime(evt) {
  if (!evt || !evt.endpointId) return;
  const listEp = state.endpoints.find((endpoint) => endpoint.id === evt.endpointId);
  if (listEp) listEp.lastActivity = Date.now();
  if (!state.activeEp || state.activeEp.id !== evt.endpointId) {
    if (state.route === 'mocks') render();
    return;
  }
  if (state.route !== 'realtime') return;
  loadRealtimeData().then(render).catch(() => {});
}
function matchesFilter(r) {
  const f = state.feedFilter;
  if (f.method && f.method !== 'ALL' && r.method !== f.method) return false;
  if (f.search && f.search.trim()) {
    const q = f.search.toLowerCase();
    const hay = `${r.method} ${r.event || ''} ${r.path} ${r.body || ''} ${JSON.stringify(r.headers || {})}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
function scrollFeedToBottom() {
  requestAnimationFrame(() => { const el = document.getElementById('feed-scroll'); if (el) el.scrollTop = el.scrollHeight; });
}
app.scrollFeedToBottom = scrollFeedToBottom;

// ---------------- navigation ----------------
function setRoute(route, extra = {}) { Object.assign(state, { route, dropdown: null, ...extra }); syncHash(); render(); }
app.setRoute = setRoute;
app.navDashboard = () => { Promise.all([loadActivity(), loadCounts(), loadOverview()]).then(() => setRoute('dashboard')); };
app.navWebhooks = () => setRoute('webhooks');
app.navMocks = () => setRoute('mocks');
app.navWebSockets = app.navMocks;
app.navGraphql = app.navMocks;
app.navTailscale = () => { loadFunnel().then(() => setRoute('tailscale')); };
app.setOverviewPeriod = (period) => { state.overviewPeriod = period; loadOverview().then(render); };

// The hash is the sole source of truth for "where the user is" across a
// reload — it encodes exactly the dimensions computeViewKey() already treats
// as a distinct view (route, endpoint, sub-tab, open request/diff), so a
// hard reload restores the same place a same-tab render() would show.
// lastSyncedHash lets the 'hashchange' listener tell "we just wrote this
// ourselves" apart from an actual external change (back/forward, or the
// user editing the URL) — otherwise every internal navigation would
// re-trigger applyHashRoute right after syncHash just set the same state.
let lastSyncedHash = null;
function syncHash() {
  const p = new URLSearchParams();
  if (state.activeEp && ['inspector', 'mock', 'request', 'diff', 'settings', 'realtime'].includes(state.route)) p.set('ep', state.activeEp.id);
  if (state.route === 'mock') {
    p.set('tab', state.mockTab);
    if (state.mockTab === 'requests' && state.mockReqSelected) { p.set('req', state.mockReqSelected.id); p.set('reqTab', state.mockReqTab); }
  } else if (state.route === 'settings') {
    p.set('tab', state.settingsTab);
  } else if (state.route === 'realtime') {
    p.set('tab', state.realtimeTab);
  } else if (state.route === 'request' && state.activeReq) {
    p.set('req', state.activeReq.id); p.set('tab', state.detailTab);
  } else if (state.route === 'diff' && state.diff) {
    p.set('a', state.diff.a.id); p.set('b', state.diff.b.id);
  }
  const qs = p.toString();
  const hash = '#/' + state.route + (qs ? '?' + qs : '');
  lastSyncedHash = hash;
  location.hash = hash;
}

async function applyHashRoute() {
  const raw = location.hash;
  if (raw === lastSyncedHash) return; // our own syncHash() triggered this 'hashchange', not an external navigation
  lastSyncedHash = raw;
  const body = raw.replace(/^#\/?/, '');
  if (!body) return; // no hash yet — keep the default boot state (dashboard)

  const [routePart, queryPart] = body.split('?');
  const requestedRoute = routePart || 'dashboard';
  const route = ['websockets', 'graphql'].includes(requestedRoute) ? 'mocks' : requestedRoute;
  const p = new URLSearchParams(queryPart || '');
  const epId = p.get('ep');
  const NEEDS_EP = ['inspector', 'mock', 'request', 'diff', 'settings', 'realtime'];

  try {
    if (!NEEDS_EP.includes(route)) {
      state.route = route; state.dropdown = null;
      if (route !== requestedRoute) { syncHash(); render(); return; }
      render();
      return;
    }
    if (!epId) { state.route = 'dashboard'; render(); return; }
    state.activeEp = await api.get('/endpoints/' + epId);

    if (route === 'inspector') {
      state.compareMode = false; state.selected = []; state.feedFilter = { search: '', method: 'ALL' };
      await reloadFeed();
      state.previewReqId = state.feed.length ? state.feed[state.feed.length - 1].id : null;
    } else if (route === 'mock') {
      state.mockTab = ['requests', 'deliveries'].includes(p.get('tab')) ? p.get('tab') : 'config';
      state.mockReqSelected = null; state.selectedDeliveryRun = null; state.expandedScenario = null;
      if (state.mockTab === 'requests') {
        await reloadFeed();
        const reqId = p.get('req');
        if (reqId) { state.mockReqSelected = await api.get('/requests/' + reqId); state.mockReqTab = p.get('reqTab') || 'body'; }
      } else if (state.mockTab === 'deliveries') {
        await loadDeliveryRuns();
      }
    } else if (route === 'request') {
      const reqId = p.get('req');
      if (!reqId) throw new Error('missing req');
      state.activeReq = await api.get('/requests/' + reqId);
      state.detailTab = p.get('tab') || 'body';
      state.replayOpen = false; state.replayResult = null; state.replayTarget = '';
    } else if (route === 'diff') {
      const a = p.get('a'), b = p.get('b');
      if (!a || !b) throw new Error('missing a/b');
      state.diff = await api.get(`/requests/diff?a=${a}&b=${b}`);
    } else if (route === 'settings') {
      state.settingsTab = p.get('tab') || 'auth';
      state.secretReveal = false;
      try { state.settingsRequests = await api.get('/endpoints/' + epId + '/requests?limit=25'); } catch { state.settingsRequests = []; }
    } else if (route === 'realtime') {
      if (!isRealtimeEndpoint(state.activeEp)) throw new Error('not realtime');
      const defaultTab = state.activeEp.protocol === 'graphql' ? 'operations' : 'sessions';
      state.realtimeTab = p.get('tab') || defaultTab;
      state.realtimeSelectedSession = null; state.realtimeError = '';
      state.realtimeTest = null; state.realtimeTestResult = null;
      await loadRealtimeData();
    }
    state.route = route; state.dropdown = null;
  } catch (e) {
    // The endpoint/request the hash pointed at no longer exists (deleted
    // since the last visit) — fall back cleanly instead of getting stuck.
    state.activeEp = null; state.route = 'dashboard';
  }
  render();
}

// ---------------- workspaces ----------------
app.toggleWsMenu = () => app.set({ wsMenuOpen: !state.wsMenuOpen, wsEditor: null });
app.closeWsMenu = () => app.set({ wsMenuOpen: false });
app.selectWorkspace = async (id) => {
  await api.post('/workspaces/' + id + '/activate');
  state.activeWorkspace = id; state.wsMenuOpen = false; state.activeEp = null;
  await loadEndpoints(); await Promise.all([loadActivity(), loadCounts(), loadOverview()]);
  setRoute('dashboard');
};
app.openWsCreate = () => app.set({ wsEditor: { mode: 'create', id: null, name: '', icon: 'box', color: '#238636' }, wsMenuOpen: false });
app.openWsEdit = (ws) => app.set({ wsEditor: { mode: 'edit', id: ws.id, name: ws.name, icon: ws.icon, color: ws.color }, wsMenuOpen: false });
app.setWsField = (k, v) => { state.wsEditor[k] = v; render(); };
app.cancelWsEditor = () => app.set({ wsEditor: null });
app.saveWsEditor = async () => {
  const e = state.wsEditor; if (!e) return;
  const payload = { name: (e.name || '').trim() || 'Untitled', icon: e.icon, color: e.color };
  if (e.mode === 'create') { const ws = await api.post('/workspaces', payload); state.activeWorkspace = ws.id; }
  else await api.patch('/workspaces/' + e.id, payload);
  state.wsEditor = null; state.wsMenuOpen = false;
  const st = await api.get('/state'); state.workspaces = st.workspaces; state.activeWorkspace = st.activeWorkspace;
  await loadEndpoints(); await Promise.all([loadActivity(), loadCounts(), loadOverview()]);
  setRoute('dashboard');
};
app.askDeleteWs = (ws) => app.set({ wsConfirmDelete: { id: ws.id, name: ws.name }, wsMenuOpen: false, wsEditor: null });
app.cancelDeleteWs = () => app.set({ wsConfirmDelete: null });
app.confirmDeleteWs = async () => {
  const t = state.wsConfirmDelete; if (!t) return;
  try {
    const res = await api.del('/workspaces/' + t.id);
    state.wsConfirmDelete = null;
    const st = await api.get('/state'); state.workspaces = st.workspaces; state.activeWorkspace = res.active || st.activeWorkspace;
    state.activeEp = null;
    await loadEndpoints(); await Promise.all([loadActivity(), loadCounts(), loadOverview()]);
    setRoute('dashboard');
  } catch (e) { state.wsConfirmDelete = null; toast(e.message); render(); }
};

app.toggleSidebar = async () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  api.post('/prefs/sidebar', { collapsed: state.sidebarCollapsed }).catch(() => {});
  render();
};

// ---------------- create menu ----------------
app.toggleCreateMenu = () => app.set({ createMenuOpen: !state.createMenuOpen });
app.closeCreateMenu = () => app.set({ createMenuOpen: false });

// ---------------- dropdown open-state ----------------
app.setDropdown = (id) => app.set({ dropdown: state.dropdown === id ? null : id });
app.closeDropdown = () => app.set({ dropdown: null });
app.selectHelper = (id, value, options, onPick, extra = {}) => ({
  value, options,
  // Local selects update their own label. A caller explicitly returns true
  // only when changing the choice also changes which controls are visible.
  onPick: (v) => { state.dropdown = null; if (onPick(v) === true || extra.rerender) app.rerender(); },
  ...extra,
});

// ---------------- endpoints ----------------
app.openEndpoint = async (ep) => {
  const full = await api.get('/endpoints/' + ep.id);
  state.activeEp = full;
  if (isRealtimeEndpoint(full)) {
    state.route = 'realtime';
    state.realtimeTab = full.protocol === 'graphql' ? 'operations' : 'sessions';
    state.realtimeSessions = []; state.realtimeSelectedSession = null;
    state.realtimeScripts = []; state.realtimeSchema = null; state.realtimeSchemaValidation = null; state.realtimeFixtures = [];
    state.realtimeError = ''; state.realtimeTest = null; state.realtimeTestResult = null;
    await loadRealtimeData();
    syncHash(); render();
  } else if (full.type === 'inspector') {
    state.route = 'inspector'; state.compareMode = false; state.selected = []; state.feedFilter = { search: '', method: 'ALL' };
    await reloadFeed();
    state.previewReqId = state.feed.length ? state.feed[state.feed.length - 1].id : null;
    syncHash(); render(); scrollFeedToBottom();
  } else {
    state.route = 'mock'; state.mockTab = 'config'; state.mockReqSelected = null; state.mockDeliveries = []; state.selectedDeliveryRun = null;
    state.expandedScenario = null; // scenarios start collapsed by default
    syncHash(); render();
  }
};
app.reloadActiveEp = async () => { if (state.activeEp) state.activeEp = await api.get('/endpoints/' + state.activeEp.id); };
app.refreshEndpointsView = async () => { await loadEndpoints(); await loadCounts(); render(); };

async function reloadFeed() {
  if (!state.activeEp) return;
  const f = state.feedFilter;
  const qs = `?search=${encodeURIComponent(f.search || '')}&method=${encodeURIComponent(f.method || 'ALL')}`;
  state.feed = await api.get('/endpoints/' + state.activeEp.id + '/requests' + qs);
}
app.reloadFeed = reloadFeed;

let searchTimer = null;
app.setFeedSearch = (v) => {
  state.feedFilter.search = v;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { await reloadFeed(); render(); }, 200);
};
app.setMethodFilter = async (m) => { state.feedFilter.method = m; await reloadFeed(); render(); };

app.deleteEndpoint = async (ep) => {
  await api.del('/endpoints/' + ep.id);
  if (state.activeEp && state.activeEp.id === ep.id) state.activeEp = null;
  await loadEndpoints(); await loadCounts();
  setRoute(endpointListRoute(ep));
};

// ---- edit / delete via modals ----
app.openEpEditor = (ep) => app.set({
  dropdown: null,
  epEditor: {
    id: ep.id, type: ep.type, protocol: ep.protocol || 'http', name: ep.name, slug: ep.slug,
    method: ep.method || 'POST', path: ep.path || '/',
    projectName: ep.project ? ep.project.name : '',
    forwardTarget: ep.forward_target || ep.forwardTarget || '', error: {},
  },
});
app.cancelEpEditor = () => app.set({ epEditor: null, dropdown: null, projQuery: '' });
app.saveEpEditor = async () => {
  const e = state.epEditor; if (!e) return;
  const patch = { name: e.name };
  if (e.protocol !== 'http') patch.slug = e.slug;
  else if (e.type === 'inspector') { patch.slug = e.slug; patch.forwardTarget = e.forwardTarget || null; }
  else { patch.method = e.method; patch.path = e.path; }
  if (e.projectName && e.projectName.trim()) patch.projectName = e.projectName.trim();
  else patch.projectId = null;
  try {
    await api.patch('/endpoints/' + e.id, patch);
    await loadEndpoints();
    if (state.activeEp && state.activeEp.id === e.id) state.activeEp = await api.get('/endpoints/' + e.id);
    app.set({ epEditor: null, projQuery: '' });
    toast('Changes saved');
  } catch (err) { state.epEditor.error = err.fields || { name: err.message }; render(); }
};
app.askDeleteEp = (ep) => app.set({ dropdown: null, epConfirmDelete: { id: ep.id, name: ep.name, type: ep.type, protocol: ep.protocol || 'http' } });
app.cancelDeleteEp = () => app.set({ epConfirmDelete: null });
app.confirmDeleteEp = async () => {
  const t = state.epConfirmDelete; if (!t) return;
  try {
    await api.del('/endpoints/' + t.id);
    if (state.activeEp && state.activeEp.id === t.id) state.activeEp = null;
    await loadEndpoints(); await loadCounts();
    app.set({ epConfirmDelete: null, route: endpointListRoute(t) });
  } catch (err) { app.set({ epConfirmDelete: null }); toast(err.message); }
};

// ---- projects: edit / delete via modals ----
app.openProjEditor = (project) => app.set({ dropdown: null, projEditor: { id: project.id, name: project.name, error: null } });
app.cancelProjEditor = () => app.set({ projEditor: null });
app.saveProjEditor = async () => {
  const e = state.projEditor; if (!e) return;
  try {
    await api.patch('/projects/' + e.id, { name: e.name });
    await loadEndpoints();
    app.set({ projEditor: null });
    toast('Project renamed');
  } catch (err) { state.projEditor.error = (err.fields && err.fields.name) || err.message; render(); }
};
app.askDeleteProj = (project) => app.set({ dropdown: null, projConfirmDelete: { id: project.id, name: project.name } });
app.cancelDeleteProj = () => app.set({ projConfirmDelete: null });
app.confirmDeleteProj = async () => {
  const t = state.projConfirmDelete; if (!t) return;
  try {
    await api.del('/projects/' + t.id);
    await loadEndpoints();
    app.set({ projConfirmDelete: null });
  } catch (err) { app.set({ projConfirmDelete: null }); toast(err.message); }
};

// ---------------- requests / inspector ----------------
app.selectPreview = (id) => app.set({ previewReqId: id });
app.openRequest = async (id, epId) => {
  if (epId && (!state.activeEp || state.activeEp.id !== epId)) state.activeEp = await api.get('/endpoints/' + epId);
  state.activeReq = await api.get('/requests/' + id);
  setRoute('request', { detailTab: 'body', replayOpen: false, replayResult: null, replayTarget: '' });
};
app.backToInspector = () => setRoute('inspector', { activeReq: null });
app.setDetailTab = (t) => { state.detailTab = t; syncHash(); render(); };
app.toggleReplay = () => app.set({ replayOpen: !state.replayOpen });
app.setReplayTarget = (v) => { state.replayTarget = v; };
app.doReplay = async () => {
  const r = state.activeReq; if (!r) return;
  try {
    const res = await api.post('/requests/' + r.id + '/replay', { target: state.replayTarget || undefined });
    state.replayResult = res;
    toast(res.ok ? `Replayed → ${res.status} (${res.durationMs}ms)` : `Replay failed: ${res.error}`);
    render();
  } catch (e) { toast(e.message); }
};
app.exportRequest = (id) => window.open(api.exportHref('/requests/' + id + '/export'), '_blank');
app.exportEndpoint = (id) => window.open(api.exportHref('/endpoints/' + id + '/requests/export'), '_blank');

app.toggleCompare = () => app.set({ compareMode: !state.compareMode, selected: [] });
app.toggleSelect = (id) => {
  const has = state.selected.includes(id);
  let sel = has ? state.selected.filter((x) => x !== id) : state.selected.concat([id]);
  if (sel.length > 2) sel = sel.slice(sel.length - 2);
  app.set({ selected: sel });
};
app.startDiff = async () => {
  if (state.selected.length !== 2) return;
  state.diff = await api.get(`/requests/diff?a=${state.selected[0]}&b=${state.selected[1]}`);
  setRoute('diff');
};
app.backFromDiff = () => setRoute('inspector');
app.clearFeed = async () => { await api.del('/endpoints/' + state.activeEp.id + '/requests'); state.feed = []; state.previewReqId = null; await loadCounts(); render(); };

// ---------------- mock config ----------------
app.setMockTab = async (tab) => {
  state.mockTab = tab; state.mockReqSelected = null; state.selectedDeliveryRun = null;
  if (tab === 'requests') { state.feedFilter = { search: '', method: 'ALL' }; await reloadFeed(); }
  if (tab === 'deliveries') { await loadDeliveryRuns(); }
  syncHash(); render();
};
app.activateScenario = async (scId) => { await api.post('/scenarios/' + scId + '/activate'); await app.reloadActiveEp(); render(); };
app.toggleSequential = async () => {
  const mode = state.activeEp.mode === 'sequence' ? 'single' : 'sequence';
  await api.patch('/endpoints/' + state.activeEp.id, { mode });
  await app.reloadActiveEp(); render();
};
app.expandScenario = (id) => app.set({ expandedScenario: state.expandedScenario === id ? null : id });
app.openAddScenario = () => app.set({ addScenarioOpen: true, addRuleOpen: false });
app.cancelAddScenario = () => app.set({ addScenarioOpen: false });
app.setNewScenario = (k, v) => { state.newScenario[k] = v; };
app.addScenario = async () => {
  const ns = state.newScenario;
  await api.post('/endpoints/' + state.activeEp.id + '/scenarios', { name: ns.name || 'New scenario', status: Number(ns.status) || 200, delay: Number(ns.delay) || 0, contentType: ns.contentType, body: ns.body });
  state.addScenarioOpen = false;
  state.newScenario = { name: '', status: 200, delay: 0, contentType: 'application/json', body: '{ "ok": true }' };
  await app.reloadActiveEp(); render();
};
app.deleteScenario = async (id) => { await api.del('/scenarios/' + id); await app.reloadActiveEp(); render(); };
app.openEditScenario = (sc) => app.set({
  editingScenario: sc.id, expandedScenario: sc.id, addScenarioOpen: false,
  editScenario: { name: sc.name, status: sc.status, delay: sc.delay, contentType: sc.contentType, body: sc.body },
});
app.cancelEditScenario = () => app.set({ editingScenario: null });
app.setEditScenario = (k, v) => { state.editScenario[k] = v; };
app.saveEditScenario = async () => {
  const id = state.editingScenario, es = state.editScenario; if (!id) return;
  await api.patch('/scenarios/' + id, { name: es.name || 'Scenario', status: Number(es.status) || 200, delay: Number(es.delay) || 0, contentType: es.contentType, body: es.body });
  state.editingScenario = null;
  await app.reloadActiveEp(); render();
};
app.openAddRule = () => {
  const first = state.activeEp.scenarios && state.activeEp.scenarios[0];
  app.set({ addRuleOpen: true, addScenarioOpen: false, newRule: { when: 'header', key: '', op: 'equals', value: '', then: first ? first.id : '' } });
};
app.cancelAddRule = () => app.set({ addRuleOpen: false });
app.setNewRule = (k, v) => { state.newRule[k] = v; return k === 'when' || k === 'op'; };
app.addRule = async () => {
  const nr = state.newRule;
  await api.post('/endpoints/' + state.activeEp.id + '/match-rules', nr);
  state.addRuleOpen = false;
  await app.reloadActiveEp(); render();
};
app.deleteRule = async (id) => { await api.del('/match-rules/' + id); await app.reloadActiveEp(); render(); };
app.toggleRuleEnabled = async (rule) => { await api.patch('/match-rules/' + rule.id, { enabled: !rule.enabled }); await app.reloadActiveEp(); render(); };
app.moveRule = async (id, direction) => { await api.post('/match-rules/' + id + '/move', { direction }); await app.reloadActiveEp(); render(); };
app.selectMockReq = async (id) => { state.mockReqSelected = await api.get('/requests/' + id); state.mockReqTab = 'body'; syncHash(); render(); };
app.backToMockReqs = () => { state.mockReqSelected = null; syncHash(); render(); };
app.setMockReqTab = (t) => { state.mockReqTab = t; syncHash(); render(); };

function newScenarioEventEditor(scenarioId) {
  return {
    id: null, scenarioId, name: 'Async event', enabled: true, headersText: '{}',
    request: {
      url: '', method: 'POST', headers: {}, contentType: 'application/json', payload: '', timeoutMs: 10000,
      auth: { enabled: false, method: 'none', header: 'Authorization', token: '', apiKeyName: 'X-Api-Key', apiKeyLoc: 'header', user: '', pass: '' },
      hmac: { enabled: false, provider: 'custom', secret: '', algo: 'sha256', header: 'X-Signature', encoding: 'hex' },
    },
    schedule: { delayMs: 0, repeatCount: 1, repeatIntervalMs: 0, retryCount: 0, retryBaseDelayMs: 250 },
  };
}
function editorFromScenarioEvent(event) {
  const copy = JSON.parse(JSON.stringify(event));
  copy.headersText = JSON.stringify((copy.request && copy.request.headers) || {}, null, 2);
  return copy;
}
function setNestedValue(root, path, value) {
  const keys = path.split('.');
  let target = root;
  for (let index = 0; index < keys.length - 1; index++) target = target[keys[index]] || (target[keys[index]] = {});
  target[keys[keys.length - 1]] = value;
}
app.openAddScenarioEvent = (scenarioId) => app.set({ eventEditor: newScenarioEventEditor(scenarioId), eventTest: null });
app.openEditScenarioEvent = (event) => app.set({ eventEditor: editorFromScenarioEvent(event), eventTest: null });
app.closeScenarioEventEditor = () => app.set({ eventEditor: null });
app.setScenarioEventField = (path, value, rerender = false) => {
  if (!state.eventEditor) return;
  setNestedValue(state.eventEditor, path, value);
  return rerender;
};
app.refreshScenarioEventPreview = () => render();
app.setScenarioHmacProvider = (provider) => {
  if (!state.eventEditor) return;
  const presets = {
    stripe: { algo: 'sha256', header: 'Stripe-Signature', encoding: 'hex' },
    github: { algo: 'sha256', header: 'X-Hub-Signature-256', encoding: 'hex' },
    shopify: { algo: 'sha256', header: 'X-Shopify-Hmac-Sha256', encoding: 'base64' },
    twilio: { algo: 'sha1', header: 'X-Twilio-Signature', encoding: 'base64' },
    slack: { algo: 'sha256', header: 'X-Slack-Signature', encoding: 'hex' },
    custom: { algo: 'sha256', header: 'X-Signature', encoding: 'hex' },
  };
  Object.assign(state.eventEditor.request.hmac, { provider, ...(presets[provider] || {}) });
  return true;
};
app.saveScenarioEvent = async () => {
  const editor = state.eventEditor;
  if (!editor) return;
  let headers;
  try {
    headers = JSON.parse(editor.headersText || '{}');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('Headers must be a JSON object');
  } catch (error) {
    toast(error.message || 'Headers must be valid JSON');
    return;
  }
  const payload = {
    name: editor.name, enabled: !!editor.enabled,
    request: { ...editor.request, headers }, schedule: editor.schedule,
  };
  try {
    if (editor.id) await api.patch('/scenario-events/' + editor.id, payload);
    else await api.post('/scenarios/' + editor.scenarioId + '/events', payload);
    state.eventEditor = null;
    await app.reloadActiveEp();
    render();
    toast(editor.id ? 'Async event saved' : 'Async event created');
  } catch (error) { toast(error.message || 'Could not save async event'); }
};
app.toggleScenarioEvent = async (event) => {
  try {
    await api.patch('/scenario-events/' + event.id, { enabled: !event.enabled });
    await app.reloadActiveEp(); render();
  } catch (error) { toast(error.message); }
};
app.moveScenarioEvent = async (id, direction) => {
  try {
    await api.post('/scenario-events/' + id + '/move', { direction });
    await app.reloadActiveEp(); render();
  } catch (error) { toast(error.message); }
};
app.deleteScenarioEvent = async (id) => {
  try {
    await api.del('/scenario-events/' + id);
    await app.reloadActiveEp(); render(); toast('Async event deleted');
  } catch (error) { toast(error.message); }
};
app.openEventTest = (scenarioId) => {
  const request = { method: 'POST', path: '/orders/ord_preview', headers: { 'x-request-id': 'preview-request' }, query: { ref: 'preview-ref' }, body: { order: { id: 'ord_preview' } } };
  const response = { status: 202, headers: { 'content-type': 'application/json' }, body: { id: 'mock_preview', state: 'accepted' } };
  app.set({ eventEditor: null, eventTest: { scenarioId, requestText: JSON.stringify(request, null, 2), responseText: JSON.stringify(response, null, 2), error: '' } });
};
app.closeEventTest = () => app.set({ eventTest: null });
app.setEventTestField = (field, value) => { if (state.eventTest) { state.eventTest[field] = value; state.eventTest.error = ''; } };
app.runEventTest = async () => {
  const test = state.eventTest;
  if (!test) return;
  let request, response;
  try {
    request = JSON.parse(test.requestText || '{}');
    response = JSON.parse(test.responseText || '{}');
  } catch {
    state.eventTest.error = 'Fixtures must be valid JSON objects.';
    render();
    return;
  }
  try {
    const run = await api.post('/scenarios/' + test.scenarioId + '/event-runs/test', { request, response });
    state.eventTest = null; state.mockTab = 'deliveries'; state.selectedDeliveryRun = run;
    state.mockDeliveries = [run, ...(state.mockDeliveries || []).filter((item) => item.id !== run.id)];
    syncHash(); render();
    toast('Test flow queued');
  } catch (error) {
    state.eventTest.error = error.message || 'Could not start test flow';
    render();
  }
};
app.refreshDeliveryRuns = async () => {
  try { await loadDeliveryRuns(); render(); } catch (error) { toast(error.message || 'Could not load deliveries'); }
};
app.selectDeliveryRun = async (id) => {
  try { state.selectedDeliveryRun = await api.get('/event-runs/' + id); render(); }
  catch (error) { toast(error.message || 'Could not load delivery'); }
};
app.backToDeliveries = () => { state.selectedDeliveryRun = null; render(); };
app.cancelDeliveryRun = async (id) => {
  try {
    state.selectedDeliveryRun = await api.post('/event-runs/' + id + '/cancel', {});
    await loadDeliveryRuns(); render(); toast('Pending deliveries cancelled');
  } catch (error) { toast(error.message || 'Could not cancel delivery'); }
};

// ---------------- realtime protocols ----------------
function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON`); }
}
function parseJsonOrText(value) {
  try { return JSON.parse(value); }
  catch { return value; }
}
function actionForApi(action = {}) {
  const type = action.type || 'send';
  const result = { type, delayMs: Number(action.delayMs) || 0 };
  if (type === 'close') {
    result.code = Number(action.code) || 1000;
    result.reason = action.reason || '';
  } else {
    result.payload = action.payloadText == null ? action.payload : parseJsonOrText(action.payloadText);
    if (type === 'emit') result.event = action.event || '';
  }
  return result;
}
function scriptForApi(script) {
  return { name: script.name, enabled: !!script.enabled, connectActions: (script.connectActions || []).map(actionForApi) };
}
function stepForApi(step, endpoint) {
  const raw = step.matchText == null ? ((step.match && step.match.text) || '') : step.matchText;
  const match = {
    kind: endpoint.protocol === 'socketio' ? 'event' : 'message',
    event: endpoint.protocol === 'socketio' ? ((step.match && step.match.event) || 'message') : '',
    text: '', payload: null,
  };
  try { match.payload = JSON.parse(raw); }
  catch { match.text = raw; }
  return { match, actions: (step.actions || []).map(actionForApi) };
}
function fixtureForApi(fixture) {
  const variablesText = String(fixture.variablesText == null ? '' : fixture.variablesText).trim();
  return {
    name: fixture.name, operationName: fixture.operationName || '', documentHash: fixture.documentHash || '',
    operationType: fixture.operationType || 'query',
    variablesMatch: variablesText ? parseJson(variablesText, 'Variables matcher') : null,
    response: fixture.responseText == null ? fixture.response || {} : parseJson(fixture.responseText, 'GraphQL response'),
    subscriptionEvents: fixture.eventsText == null ? fixture.subscriptionEvents || [] : parseJson(fixture.eventsText, 'Subscription events'),
    delayMs: Number(fixture.delayMs) || 0, enabled: !!fixture.enabled,
  };
}
async function refreshRealtime() {
  await app.reloadActiveEp();
  await loadRealtimeData();
  await loadEndpoints();
  await loadCounts();
}
function realtimeFailure(error) {
  state.realtimeError = error && error.message || 'Could not update realtime endpoint';
  toast(state.realtimeError);
  render();
}

let graphqlValidationTimer = null;
let graphqlValidationSequence = 0;
app.validateGraphqlSdl = (value, editor, onResult) => {
  const source = String(value == null ? '' : value);
  const sequence = ++graphqlValidationSequence;
  clearTimeout(graphqlValidationTimer);
  if (editor && editor.setExternalValidation) editor.setExternalValidation({ source, pending: true });
  graphqlValidationTimer = setTimeout(async () => {
    let result;
    try {
      result = await api.post('/graphql/validate', { sdl: source });
    } catch {
      result = { valid: false, message: 'SDL validation is unavailable. Save will validate again.', line: 1, column: 1 };
    }
    if (sequence !== graphqlValidationSequence) return;
    const validation = { source, ...result };
    if (state.route === 'realtime' && state.realtimeSchema && state.realtimeSchema.sdl === source) state.realtimeSchemaValidation = validation;
    if (onResult) onResult(validation);
    // Apply the result directly to the existing editor. A render here would
    // recreate its textarea and interrupt the user's cursor while typing.
    if (editor && editor.isConnected !== false && editor.value === source && editor.setExternalValidation) editor.setExternalValidation(validation);
  }, 220);
};

app.newRealtime = (protocol = 'websocket') => {
  state.form.realtime = {
    protocol, type: 'mock', name: '', slug: '', projectName: '',
    sdl: 'type Query { health: String }', sdlValidation: { source: 'type Query { health: String }', valid: true }, errors: {}, submitted: false,
  };
  state.realtimeSchemaValidation = null;
  setRoute('new-realtime');
};
app.setMockProtocolFilter = (protocol) => app.set({ mockProtocolFilter: protocol });
app.setRealtimeForm = (key, value) => {
  state.form.realtime[key] = value;
  if (key === 'protocol' && value === 'graphql' && !state.form.realtime.sdl) state.form.realtime.sdl = 'type Query { health: String }';
  render();
};
app.createRealtime = async () => {
  const form = state.form.realtime;
  try {
    const endpoint = await api.post('/endpoints', {
      protocol: form.protocol, type: form.type, name: form.name, slug: form.slug,
      projectName: form.projectName || undefined, sdl: form.protocol === 'graphql' ? form.sdl : undefined,
    });
    await loadEndpoints(); await loadCounts();
    await app.openEndpoint(endpoint);
  } catch (error) {
    form.errors = error.fields || { name: error.message };
    form.submitted = true;
    toast(error.message || 'Could not create endpoint');
    render();
  }
};
app.setRealtimeTab = async (tab) => {
  state.realtimeTab = tab;
  state.realtimeError = '';
  syncHash(); render();
};
app.selectRealtimeSession = async (id) => {
  try { state.realtimeSelectedSession = await api.get('/realtime-sessions/' + id); render(); }
  catch (error) { realtimeFailure(error); }
};
app.disconnectRealtimeSession = async (id) => {
  try {
    await api.post('/realtime-sessions/' + id + '/disconnect', {});
    await loadRealtimeData(); render();
    toast('Session disconnected');
  } catch (error) { realtimeFailure(error); }
};
app.clearRealtimeSessions = async (endpointId) => {
  try {
    await api.del('/endpoints/' + endpointId + '/realtime-sessions');
    state.realtimeSessions = []; state.realtimeSelectedSession = null;
    render(); toast('Realtime history cleared');
  } catch (error) { realtimeFailure(error); }
};
app.addRealtimeScript = async (endpointId) => {
  try {
    await api.post('/endpoints/' + endpointId + '/realtime-scripts', { name: 'Conversation', enabled: true, connectActions: [] });
    await loadRealtimeData(); render();
  } catch (error) { realtimeFailure(error); }
};
app.saveRealtimeScript = async (script) => {
  try {
    await api.patch('/realtime-scripts/' + script.id, scriptForApi(script));
    await loadRealtimeData(); render(); toast('Script saved');
  } catch (error) { realtimeFailure(error); }
};
app.deleteRealtimeScript = async (id) => {
  try { await api.del('/realtime-scripts/' + id); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.moveRealtimeScript = async (id, direction) => {
  try { await api.post('/realtime-scripts/' + id + '/move', { direction }); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.addRealtimeStep = async (scriptId) => {
  const endpoint = state.activeEp;
  try {
    await api.post('/realtime-scripts/' + scriptId + '/steps', {
      match: endpoint.protocol === 'socketio'
        ? { kind: 'event', event: 'message', payload: {} }
        : { kind: 'message', payload: {} },
      actions: [{ type: endpoint.protocol === 'socketio' ? 'emit' : 'send', event: endpoint.protocol === 'socketio' ? 'message' : undefined, payload: {}, delayMs: 0 }],
    });
    await loadRealtimeData(); render();
  } catch (error) { realtimeFailure(error); }
};
app.saveRealtimeStep = async (step) => {
  try {
    await api.patch('/realtime-steps/' + step.id, stepForApi(step, state.activeEp));
    await loadRealtimeData(); render(); toast('Step saved');
  } catch (error) { realtimeFailure(error); }
};
app.deleteRealtimeStep = async (id) => {
  try { await api.del('/realtime-steps/' + id); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.moveRealtimeStep = async (id, direction) => {
  try { await api.post('/realtime-steps/' + id + '/move', { direction }); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.saveGraphqlSchema = async () => {
  try {
    state.realtimeSchema = await api.put('/endpoints/' + state.activeEp.id + '/graphql/schema', { sdl: state.realtimeSchema.sdl });
    state.realtimeSchemaValidation = { source: state.realtimeSchema.sdl, valid: true };
    state.realtimeError = ''; render(); toast('SDL saved');
  } catch (error) {
    state.realtimeSchemaValidation = {
      source: state.realtimeSchema && state.realtimeSchema.sdl || '',
      valid: false,
      message: error.fields && error.fields.sdl || error.message || 'Invalid GraphQL SDL',
      line: 1,
      column: 1,
    };
    realtimeFailure(error);
  }
};
app.addGraphqlFixture = async (endpointId, operationType = 'query') => {
  try {
    await api.post('/endpoints/' + endpointId + '/graphql/fixtures', {
      name: operationType === 'subscription' ? 'Subscription fixture' : 'Operation fixture', operationType,
      response: { data: {} }, subscriptionEvents: [], enabled: true,
    });
    await loadRealtimeData(); render();
  } catch (error) { realtimeFailure(error); }
};
app.saveGraphqlFixture = async (fixture) => {
  try {
    await api.patch('/graphql-fixtures/' + fixture.id, fixtureForApi(fixture));
    await loadRealtimeData(); render(); toast('Fixture saved');
  } catch (error) { realtimeFailure(error); }
};
app.deleteGraphqlFixture = async (id) => {
  try { await api.del('/graphql-fixtures/' + id); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.moveGraphqlFixture = async (id, direction) => {
  try { await api.post('/graphql-fixtures/' + id + '/move', { direction }); await loadRealtimeData(); render(); }
  catch (error) { realtimeFailure(error); }
};
app.openRealtimeTest = () => {
  const graph = state.activeEp && state.activeEp.protocol === 'graphql';
  if (graph) state.realtimeTab = 'operations';
  else if (!['sessions', 'messages'].includes(state.realtimeTab)) state.realtimeTab = 'sessions';
  state.realtimeTest = graph
    ? { input: 'query Health { health }', variables: '{}', error: '' }
    : { input: state.activeEp && state.activeEp.protocol === 'socketio' ? '[{ "event": "message", "payload": {} }]' : '[{}]', variables: '', error: '' };
  state.realtimeTestResult = null;
  syncHash();
  render();
};
app.closeRealtimeTest = () => { state.realtimeTest = null; state.realtimeTestResult = null; render(); };
app.runRealtimeTest = async () => {
  const test = state.realtimeTest;
  if (!test || !state.activeEp) return;
  try {
    const body = state.activeEp.protocol === 'graphql'
      ? { query: test.input, variables: parseJson(test.variables || '{}', 'Variables') }
      : { messages: parseJson(test.input || '[]', 'Messages') };
    if (state.activeEp.protocol !== 'graphql' && !Array.isArray(body.messages)) throw new Error('Messages must be a JSON array');
    const session = await api.post('/endpoints/' + state.activeEp.id + '/realtime-test', body);
    state.realtimeTestResult = session;
    state.realtimeSelectedSession = session;
    await loadRealtimeData(); render(); toast('Test flow completed');
  } catch (error) {
    test.error = error.message || 'Could not run test flow';
    state.realtimeError = test.error; render();
  }
};
app.saveRealtimeSettings = async () => {
  const current = state.activeEp && state.activeEp.config && state.activeEp.config.realtime;
  if (!current) return;
  const originsText = current._originsText == null ? (current.allowedOrigins || []).join('\n') : current._originsText;
  const realtime = {
    ...current,
    allowedOrigins: String(originsText).split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
  };
  delete realtime._originsText;
  try {
    state.activeEp = await api.patch('/endpoints/' + state.activeEp.id, { realtime });
    state.realtimeError = '';
    await refreshRealtime(); render(); toast('Realtime settings saved');
  } catch (error) { realtimeFailure(error); }
};

// ---------------- settings ----------------
app.navSettings = async () => {
  state.settingsRequests = [];
  if (state.activeEp) { try { state.settingsRequests = await api.get('/endpoints/' + state.activeEp.id + '/requests?limit=25'); } catch { /* ignore */ } }
  setRoute('settings', { settingsTab: 'auth', secretReveal: false });
};
app.backFromSettings = () => setRoute(isRealtimeEndpoint(state.activeEp) ? 'realtime' : state.activeEp && state.activeEp.type === 'mock' ? 'mock' : 'inspector');
app.setSettingsTab = (t) => { state.settingsTab = t; syncHash(); render(); };
app.toggleSecret = () => app.set({ secretReveal: !state.secretReveal });
let cfgTimer = null;
app.patchConfig = (section, patch, immediate = false) => {
  // Update local activeEp.config immediately for responsiveness.
  Object.assign(state.activeEp.config[section], patch);
  const save = () => api.patch('/endpoints/' + state.activeEp.id, { [section]: state.activeEp.config[section] }).then(() => { const le = state.endpoints.find((e) => e.id === state.activeEp.id); if (le) { le.config = state.activeEp.config; le.signed = state.activeEp.config.hmac.enabled; } }).catch(() => {});
  if (immediate) { render(); save(); }
  else { clearTimeout(cfgTimer); cfgTimer = setTimeout(save, 350); }
};
app.patchConfigTop = async (patch) => { Object.assign(state.activeEp.config, patch); await api.patch('/endpoints/' + state.activeEp.id, patch); render(); };
app.applyHmacProvider = async (provider) => {
  const presets = { stripe: { algo: 'sha256', header: 'Stripe-Signature', encoding: 'hex' }, github: { algo: 'sha256', header: 'X-Hub-Signature-256', encoding: 'hex' }, shopify: { algo: 'sha256', header: 'X-Shopify-Hmac-Sha256', encoding: 'base64' }, twilio: { algo: 'sha1', header: 'X-Twilio-Signature', encoding: 'base64' }, slack: { algo: 'sha256', header: 'X-Slack-Signature', encoding: 'hex' }, custom: {} };
  app.patchConfig('hmac', { provider, ...(presets[provider] || {}) }, true);
};
app.addCfgRule = () => { const rules = state.activeEp.config.rules.concat([{ id: 'r' + Date.now(), enabled: true, field: 'header', key: '', op: 'equals', value: '', action: 'forward' }]); state.activeEp.config.rules = rules; api.patch('/endpoints/' + state.activeEp.id, { rules }).catch(() => {}); render(); };
app.updateCfgRule = (id, key, val) => {
  const rule = state.activeEp.config.rules.find((item) => item.id === id);
  if (!rule) return false;
  rule[key] = val;
  scheduleRulesSave();
  return key === 'field' || key === 'action';
};
app.toggleCfgRule = (id) => { const r = state.activeEp.config.rules.find((x) => x.id === id); if (r) { r.enabled = !r.enabled; saveRules(); render(); } };
app.deleteCfgRule = (id) => { state.activeEp.config.rules = state.activeEp.config.rules.filter((x) => x.id !== id); saveRules(); render(); };
let rulesTimer = null;
function scheduleRulesSave() { clearTimeout(rulesTimer); rulesTimer = setTimeout(saveRules, 350); }
function saveRules() { api.patch('/endpoints/' + state.activeEp.id, { rules: state.activeEp.config.rules }).catch(() => {}); }
app.saveRules = saveRules;

// ---------------- funnel ----------------
app.toggleFunnel = async () => {
  const active = state.funnel.state && state.funnel.state.active;
  toast(active ? 'Disabling Funnel…' : 'Enabling Funnel…');
  try { state.funnel = await api.post(active ? '/funnel/disable' : '/funnel/enable'); await loadCounts(); render(); }
  catch (e) { toast(e.message); }
};

// ---------------- create endpoints ----------------
app.newWebhook = () => { state.form.insp = { name: '', slug: '', slugEdited: false, projectName: '', validate: false, provider: 'stripe', hmacSecret: '', errors: {}, submitted: false }; setRoute('new-inspector'); };
app.chooseMockProtocol = () => setRoute('new-mock-protocol');
app.backToMockProtocol = () => setRoute('new-mock-protocol');
app.newMock = () => { state.form.mock = { name: '', projectName: '', method: 'POST', path: '/', status: 200, contentType: 'application/json', delay: 0, auth: 'none', authToken: '', authApiKeyName: 'X-Api-Key', authApiKeyLoc: 'header', authUser: '', authPass: '', body: '{\n  "ok": true\n}', errors: {}, submitted: false }; setRoute('new-mock'); };
app.cancelNew = () => setRoute('webhooks');
app.cancelNewMock = () => setRoute('mocks');
app.createWebhook = async () => {
  const f = state.form.insp;
  try {
    const ep = await api.post('/endpoints', { type: 'inspector', name: f.name, slug: f.slug, validate: f.validate, provider: f.provider, hmacSecret: f.hmacSecret || undefined, projectName: f.projectName || undefined });
    await loadEndpoints(); await loadCounts();
    app.openEndpoint(ep);
  } catch (e) { f.errors = e.fields || { name: e.message }; f.submitted = true; render(); }
};
app.createMock = async () => {
  const f = state.form.mock;
  try {
    const ep = await api.post('/endpoints', {
      type: 'mock', name: f.name, method: f.method, path: f.path, status: f.status, delay: f.delay, contentType: f.contentType,
      auth: f.auth, authToken: f.authToken || undefined, authApiKeyName: f.authApiKeyName || undefined, authApiKeyLoc: f.authApiKeyLoc,
      authUser: f.authUser || undefined, authPass: f.authPass || undefined, body: f.body, projectName: f.projectName || undefined,
    });
    await loadEndpoints(); await loadCounts();
    app.openEndpoint(ep);
  } catch (e) { f.errors = e.fields || { name: e.message }; f.submitted = true; render(); }
};

// ---------------- clipboard ----------------
app.copy = async (text, key) => {
  await clip(text);
  state.copied = key;
  render();
  setTimeout(() => { state.copied = null; render(); }, 1400);
};
app.toast = toast;

// ---------------- shell ----------------
function rootGridStyle() {
  return `display:grid;grid-template-columns:${state.sidebarCollapsed ? 68 : 248}px 1fr;height:100vh;overflow:hidden`;
}

function navBtn(label, iconFn, active, onClick, badge) {
  const collapsed = state.sidebarCollapsed;
  const btn = h('button', {
    title: label,
    style: `display:flex;align-items:center;gap:11px;width:100%;background:${active ? '#191712' : 'transparent'};border-radius:var(--radius-sm);padding:${collapsed ? '9px' : '9px 11px'};justify-content:${collapsed ? 'center' : 'flex-start'};color:${active ? '#edecec' : '#948d83'};font-size:13.5px;font-weight:${active ? 600 : 500};transition:background .12s`,
    onclick: onClick,
  }, raw(iconFn({ w: 17, sw: 1.7 })),
    !collapsed ? h('span', {}, label) : null,
    !collapsed && badge != null ? h('span', { style: "margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#57524a" }, String(badge)) : null);
  if (!active) btn.addEventListener('mouseenter', () => { btn.style.background = '#141210'; });
  if (!active) btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
  return btn;
}

function sidebar() {
  const collapsed = state.sidebarCollapsed;
  const activeWs = state.workspaces.find((w) => w.id === state.activeWorkspace) || state.workspaces[0] || { name: '', color: '#edecec', icon: 'box' };
  const wsBtn = h('button', {
    title: activeWs.name,
    style: `display:flex;align-items:center;gap:10px;width:100%;background:#100e0b;border-radius:var(--radius-sm);padding:${collapsed ? '8px' : '8px 10px'};justify-content:${collapsed ? 'center' : 'flex-start'};cursor:pointer;transition:background .12s`,
    onclick: app.toggleWsMenu,
  },
    h('span', { style: `width:30px;height:30px;border-radius:var(--radius-sm);background:${activeWs.color};display:flex;align-items:center;justify-content:center;flex-shrink:0` }, raw(wsIconSvg(activeWs.icon, { w: 16 }))),
    !collapsed ? h('span', { style: 'flex:1;min-width:0;text-align:left' },
      h('span', { style: 'display:block;font-size:14px;font-weight:600;color:#f2ede3;letter-spacing:-0.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, activeWs.name),
      h('span', { style: 'display:block;font-size:10.5px;color:#6a655c;margin-top:1px;letter-spacing:0.02em' }, 'Workspace')) : null,
    !collapsed ? raw(icons.chevUpDown({ w: 15, stroke: '#6a655c', sw: 1.9, style: 'flex-shrink:0' })) : null);
  wsBtn.addEventListener('mouseenter', () => { wsBtn.style.background = '#161310'; });
  wsBtn.addEventListener('mouseleave', () => { wsBtn.style.background = '#100e0b'; });

  const wsMenu = state.wsMenuOpen ? wsMenuPanel(collapsed) : null;

  const counts = state.counts || {};
  const activeMock = ['mocks', 'mock', 'new-mock', 'new-mock-protocol', 'new-realtime'].includes(state.route)
    || (!!state.activeEp && isMockServerEndpoint(state.activeEp) && ['realtime', 'request', 'diff', 'settings'].includes(state.route));
  const activeWebhook = ['webhooks', 'new-inspector', 'inspector'].includes(state.route)
    || (!!state.activeEp && !isMockServerEndpoint(state.activeEp) && ['request', 'diff', 'settings'].includes(state.route));
  const mockCount = state.endpoints.filter(isMockServerEndpoint).length;
  const nav = h('nav', { style: 'padding:0 12px;display:flex;flex-direction:column;gap:2px' },
    navBtn('Dashboard', icons.dashboard, state.route === 'dashboard', app.navDashboard),
    navBtn('Webhooks', icons.webhook, activeWebhook, app.navWebhooks, counts.webhooks),
    navBtn('Mock Servers', icons.mock, activeMock, app.navMocks, mockCount));

  const collapseBtn = h('button', {
    title: collapsed ? 'Expand' : 'Collapse',
    style: `display:flex;align-items:center;gap:11px;width:100%;background:transparent;border-radius:var(--radius-sm);padding:${collapsed ? '9px' : '9px 11px'};justify-content:${collapsed ? 'center' : 'flex-start'};color:#6a655c;font-size:13px;font-weight:500`,
    onclick: app.toggleSidebar,
  }, raw(icons.collapse({ w: 16, sw: 1.7 })), !collapsed ? h('span', {}, 'Collapse') : null);
  collapseBtn.addEventListener('mouseenter', () => { collapseBtn.style.background = '#161310'; collapseBtn.style.color = '#a49c91'; });
  collapseBtn.addEventListener('mouseleave', () => { collapseBtn.style.background = 'transparent'; collapseBtn.style.color = '#6a655c'; });

  return h('aside', { style: 'display:flex;flex-direction:column;height:100vh;background:#0c0b09;min-width:0' },
    h('div', { style: 'position:relative;padding:13px 12px 10px 12px' }, wsBtn, wsMenu),
    nav,
    h('div', { style: 'flex:1' }),
    h('div', { style: 'padding:8px 12px 12px 12px' }, collapseBtn));
}

function wsMenuPanel(collapsed = false) {
  // A menu inside the 68 px collapsed rail cannot retain its readable rows.
  // Keep the expanded layout anchored below its trigger, but let the compact
  // rail open a bounded popover alongside it instead.
  const panelStyle = collapsed
    ? 'position:fixed;left:80px;top:12px;z-index:41;box-sizing:border-box;width:min(320px,calc(100vw - 92px));max-height:calc(100vh - 24px);overflow:auto;background:#1a1712;border-radius:var(--radius-md);padding:7px;box-shadow:0 20px 48px rgba(0,0,0,0.62);animation:sd-in .12s ease'
    : 'position:absolute;left:12px;right:12px;top:calc(100% - 4px);z-index:41;background:#1a1712;border-radius:var(--radius-md);padding:7px;box-shadow:0 20px 48px rgba(0,0,0,0.62);animation:sd-in .12s ease';
  const items = state.workspaces.map((w) => {
    const row = h('div', { style: 'display:flex;align-items:center;gap:4px;padding:5px 6px 5px 8px;border-radius:var(--radius-sm)' },
      h('button', { style: 'flex:1;min-width:0;display:flex;align-items:center;gap:9px;background:transparent;text-align:left;cursor:pointer', onclick: () => app.selectWorkspace(w.id) },
        h('span', { style: `width:26px;height:26px;border-radius:var(--radius-sm);background:${w.color};display:flex;align-items:center;justify-content:center;flex-shrink:0` }, raw(wsIconSvg(w.icon, { w: 14 }))),
        h('span', { style: 'flex:1;min-width:0;font-size:13px;font-weight:500;color:#e8e2d7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, w.name),
        w.id === state.activeWorkspace ? raw(icons.check({ w: 15, stroke: '#238636', sw: 2.3, style: 'flex-shrink:0' })) : null),
      h('button', { title: 'Rename & customize', style: 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:transparent;color:#6a655c;cursor:pointer;flex-shrink:0', onclick: () => app.openWsEdit(w) }, raw(icons.edit({ w: 14, sw: 1.9 }))),
      state.workspaces.length > 1 ? h('button', { title: 'Delete workspace', style: 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:transparent;color:#6a655c;cursor:pointer;flex-shrink:0', onclick: () => app.askDeleteWs(w) }, raw(icons.trash({ w: 14, sw: 1.9 }))) : null);
    row.querySelectorAll('button').forEach((b) => {
      b.addEventListener('mouseenter', () => { if (b.title === 'Delete workspace') { b.style.background = 'rgba(207,139,127,0.16)'; b.style.color = '#e08b7f'; } else if (b.title === 'Rename & customize') { b.style.background = '#322c23'; b.style.color = '#d3ccc0'; } });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = '#6a655c'; });
    });
    return row;
  });
  const createBtn = h('button', { style: 'width:100%;display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:var(--radius-sm);background:transparent;cursor:pointer;color:#a49c91', onclick: app.openWsCreate },
    h('span', { style: 'width:26px;height:26px;border-radius:var(--radius-sm);background:#221d17;display:flex;align-items:center;justify-content:center;flex-shrink:0' }, raw(icons.plus({ w: 15, sw: 2, stroke: 'currentColor' }))),
    h('span', { style: 'font-size:13px;font-weight:500' }, 'New workspace'));
  createBtn.addEventListener('mouseenter', () => { createBtn.style.background = '#252019'; });
  createBtn.addEventListener('mouseleave', () => { createBtn.style.background = 'transparent'; });

  return h('div', {},
    h('div', { style: 'position:fixed;inset:0;z-index:40', onclick: app.closeWsMenu }),
    h('div', { style: panelStyle },
      h('div', { style: 'padding:7px 9px 6px 9px;font-size:10.5px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#5c574e' }, 'Workspaces'),
      ...items,
      h('div', { style: 'height:1px;background:#2a251e;margin:6px 6px' }),
      createBtn));
}

function header(navigationChanged = false) {
  const crumbRoot = { dashboard: 'Overview', webhooks: 'Webhooks', mocks: 'Mock Servers', tailscale: 'Tailscale', 'new-inspector': 'Webhooks', 'new-mock': 'Mock Servers', 'new-mock-protocol': 'Mock Servers', 'new-realtime': 'Mock Servers' }[state.route]
    || (state.activeEp ? (isMockServerEndpoint(state.activeEp) ? 'Mock Servers' : 'Webhooks') : 'Sidedoor');
  const hasCrumb = ['inspector', 'request', 'diff', 'mock', 'settings', 'realtime'].includes(state.route) && state.activeEp;
  const funnelActive = state.funnel.state && state.funnel.state.active;
  const funnelHost = (state.funnel.state && state.funnel.state.base_url) ? state.funnel.state.base_url.replace(/^https?:\/\//, '') : (state.baseUrls.local || '').replace(/^https?:\/\//, '');
  const dot = h('span', { style: `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${funnelActive ? '#238636' : '#4c473f'};${funnelActive ? 'box-shadow:0 0 0 3px rgba(35,134,54,0.15)' : ''}` });
  const funnelBtn = h('button', { title: 'Open Tailscale Funnel', style: `display:flex;align-items:center;gap:8px;background:${state.route === 'tailscale' ? '#211d17' : '#191712'};border-radius:var(--radius-sm);padding:6px 11px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83`, onclick: app.navTailscale },
    dot, funnelHost || 'localhost', h('span', { style: "color:#57524a;font-family:'IBM Plex Sans';font-weight:500;margin-left:1px" }, funnelActive ? 'Funnel' : 'Offline'));
  funnelBtn.addEventListener('mouseenter', () => { funnelBtn.style.background = '#211d17'; });
  funnelBtn.addEventListener('mouseleave', () => { funnelBtn.style.background = '#191712'; });

  return h('header', { style: 'display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:54px;flex-shrink:0;background:#100e0b' },
    h('div', { class: navigationChanged ? 'sd-navigation-chrome-enter' : '', style: 'display:flex;align-items:center;gap:9px;min-width:0' },
      h('span', { style: 'font-size:13.5px;font-weight:500;color:#948d83' }, crumbRoot),
      hasCrumb ? raw(icons.chevRight({ w: 14, stroke: '#4c473f', sw: 1.7 })) : null,
      hasCrumb ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#cfc8bc" }, state.activeEp.name) : null),
    funnelBtn);
}

function mainBody() {
  switch (state.route) {
    case 'dashboard': return dashboardScreen(app);
    case 'webhooks': return webhooksScreen(app);
    case 'mocks': return mocksScreen(app);
    case 'inspector': return inspectorScreen(app);
    case 'request': return requestScreen(app);
    case 'diff': return diffScreen(app);
    case 'mock': return mockScreen(app);
    case 'settings': return settingsScreen(app);
    case 'tailscale': return tailscaleScreen(app);
    case 'new-inspector': return newInspectorScreen(app);
    case 'new-mock': return newMockScreen(app);
    case 'new-mock-protocol': return mockProtocolPickerScreen(app);
    case 'new-realtime': return newRealtimeScreen(app);
    case 'realtime': return realtimeScreen(app);
    default: return h('div', {}, 'Not found');
  }
}

// render() rebuilds the whole tree from scratch on every state change (no
// framework, no diffing). That means a freshly-created <main> always starts
// at scrollTop 0, so any click that merely opens a dropdown or flips a toggle
// would otherwise snap the page back to the top. We treat the render as "the
// same view" (and restore scroll) when none of these route-level
// discriminators changed; a genuine navigation still starts scrolled to top.
let lastViewKey = null;

// Several screens (settings, mock config, request/diff, forms, tailscale)
// wrap their content in their own `height:100%;overflow-y:auto` div, which is
// the element that actually scrolls — <main> itself never overflows since
// that single child already fills it. Others (dashboard/webhooks/mocks lists)
// have no such wrapper, so <main> is the real scroll owner. Detect which one
// applies by checking <main>'s first child, which is always the screen's own
// top-level node.
function scrollScopeEl(root) {
  const main = root.querySelector('main');
  if (!main) return null;
  const first = main.firstElementChild;
  if (first && /overflow-y:\s*auto/.test(first.getAttribute('style') || '')) return first;
  return main;
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  closeFloatingPanels();
  const viewKey = navigationViewKey(state);
  const sameView = lastViewKey === viewKey;
  const navigationChanged = isNavigationChange(lastViewKey, viewKey);
  const prevMain = sameView ? scrollScopeEl(root) : null;
  const mainScroll = prevMain ? prevMain.scrollTop : 0;
  const prevFeed = sameView ? document.getElementById('feed-scroll') : null;
  const feedScroll = prevFeed ? prevFeed.scrollTop : 0;

  clear(root);
  if (state.loading) {
    root.appendChild(h('div', { style: 'height:100vh;display:flex;align-items:center;justify-content:center;color:#6a655c;font-size:14px' }, 'Loading Sidedoor…'));
    lastViewKey = viewKey;
    return;
  }
  root.appendChild(h('div', { class: 'sd-app-shell', style: rootGridStyle() },
    sidebar(),
    h('div', { style: 'display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden' },
      header(navigationChanged),
      h('main', { class: navigationChanged ? 'sd-route-enter' : '', 'data-sd-navigation': navigationChanged ? 'enter' : 'stable', style: 'flex:1;min-height:0;overflow:auto' }, mainBody()))));
  if (state.wsEditor) root.appendChild(workspaceEditor(app));
  if (state.wsConfirmDelete) root.appendChild(workspaceDeleteConfirm(app));
  if (state.epEditor) root.appendChild(endpointEditor(app));
  if (state.epConfirmDelete) root.appendChild(endpointDeleteConfirm(app));
  if (state.projEditor) root.appendChild(projectEditor(app));
  if (state.projConfirmDelete) root.appendChild(projectDeleteConfirm(app));

  if (sameView) {
    const newMain = scrollScopeEl(root);
    if (newMain) newMain.scrollTop = mainScroll;
    const newFeed = document.getElementById('feed-scroll');
    if (newFeed) newFeed.scrollTop = feedScroll;
  }
  lastViewKey = viewKey;
}

app.rerender = render;
boot();
