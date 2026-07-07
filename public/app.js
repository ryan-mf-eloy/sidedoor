// Sidedoor SPA controller: state, actions, live updates, and the app shell
// (sidebar + header). Screen bodies live in ./screens/*.
import * as api from './api.js';
import { h, raw, clear, icons, wsIconSvg, copy as clip, toast } from './ui.js';
import { dashboardScreen } from './screens/lists.js';
import { webhooksScreen, mocksScreen, projectEditor, projectDeleteConfirm } from './screens/lists.js';
import { inspectorScreen, requestScreen, diffScreen } from './screens/inspector.js';
import { mockScreen } from './screens/mock.js';
import { settingsScreen } from './screens/settings.js';
import { tailscaleScreen } from './screens/tailscale.js';
import { newInspectorScreen, newMockScreen } from './screens/forms.js';
import { workspaceEditor, workspaceDeleteConfirm } from './screens/workspace.js';
import { endpointEditor, endpointDeleteConfirm } from './screens/endpoint.js';

const state = {
  route: 'dashboard', loading: true, now: Date.now(),
  workspaces: [], activeWorkspace: null, sidebarCollapsed: false,
  counts: {}, funnel: { state: null, history: [], exposed: [] }, baseUrls: { local: '', publicBase: null },
  endpoints: [], projects: [], activity: [], projQuery: '',
  overview: null, overviewPeriod: '24h',
  activeEp: null, feed: [], feedFilter: { search: '', method: 'ALL' }, previewReqId: null,
  activeReq: null, compareMode: false, selected: [], detailTab: 'body',
  replayOpen: false, replayTarget: '', replayResult: null,
  mockTab: 'config', mockReqSelected: null, mockReqTab: 'body', expandedScenario: null,
  addScenarioOpen: false, newScenario: { name: '', status: 200, delay: 0, contentType: 'application/json', body: '{ "ok": true }' },
  editingScenario: null, editScenario: null,
  addRuleOpen: false, newRule: { when: 'header', key: '', op: 'equals', value: '', then: '' },
  settingsTab: 'auth', secretReveal: false, settingsRequests: [],
  diff: null,
  dropdown: null, wsMenuOpen: false, wsEditor: null, wsConfirmDelete: null, createMenuOpen: false,
  epEditor: null, epConfirmDelete: null,
  projEditor: null, projConfirmDelete: null,
  form: {
    insp: { name: '', slug: '', slugEdited: false, projectName: '', validate: false, provider: 'stripe', hmacSecret: '', errors: {}, submitted: false },
    mock: { name: '', projectName: '', method: 'POST', path: '/', status: 200, contentType: 'application/json', delay: 0, auth: 'none', authToken: '', authApiKeyName: 'X-Api-Key', authApiKeyLoc: 'header', authUser: '', authPass: '', body: '{\n  "ok": true\n}', errors: {}, submitted: false },
  },
  copied: null,
};

const app = {
  state,
  get s() { return state; },
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

// ---------------- live feed ----------------
function onLiveRequest(evt) {
  // Update the list card counts.
  const listEp = state.endpoints.find((e) => e.id === evt.endpointId);
  if (listEp) { listEp.requestCount = (listEp.requestCount || 0) + 1; listEp.lastActivity = evt.request.receivedAt; }
  if (state.activeEp && state.activeEp.id === evt.endpointId && (state.route === 'inspector' || (state.route === 'mock' && state.mockTab === 'requests'))) {
    if (matchesFilter(evt.request)) {
      state.feed.push(evt.request);
      if (state.feed.length > 500) state.feed.shift();
      if (state.route === 'inspector' && !state.previewReqId) state.previewReqId = evt.request.id;
      render();
      scrollFeedToBottom();
      return;
    }
  }
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
  if (state.activeEp && ['inspector', 'mock', 'request', 'diff', 'settings'].includes(state.route)) p.set('ep', state.activeEp.id);
  if (state.route === 'mock') {
    p.set('tab', state.mockTab);
    if (state.mockTab === 'requests' && state.mockReqSelected) { p.set('req', state.mockReqSelected.id); p.set('reqTab', state.mockReqTab); }
  } else if (state.route === 'settings') {
    p.set('tab', state.settingsTab);
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
  const route = routePart || 'dashboard';
  const p = new URLSearchParams(queryPart || '');
  const epId = p.get('ep');
  const NEEDS_EP = ['inspector', 'mock', 'request', 'diff', 'settings'];

  try {
    if (!NEEDS_EP.includes(route)) {
      state.route = route; state.dropdown = null;
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
      state.mockTab = p.get('tab') === 'requests' ? 'requests' : 'config';
      state.mockReqSelected = null; state.expandedScenario = null;
      if (state.mockTab === 'requests') {
        await reloadFeed();
        const reqId = p.get('req');
        if (reqId) { state.mockReqSelected = await api.get('/requests/' + reqId); state.mockReqTab = p.get('reqTab') || 'body'; }
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
  // Every pick closes the dropdown AND re-renders — matching the design's
  // React setState behavior, so selects update even when the underlying
  // setter (e.g. setNewScenario) doesn't render on its own.
  onPick: (v) => { state.dropdown = null; onPick(v); app.rerender(); },
  open: state.dropdown === id, onToggle: () => app.setDropdown(id), onClose: () => app.closeDropdown(),
  ...extra,
});

// ---------------- endpoints ----------------
app.openEndpoint = async (ep) => {
  const full = await api.get('/endpoints/' + ep.id);
  state.activeEp = full;
  if (full.type === 'inspector') {
    state.route = 'inspector'; state.compareMode = false; state.selected = []; state.feedFilter = { search: '', method: 'ALL' };
    await reloadFeed();
    state.previewReqId = state.feed.length ? state.feed[state.feed.length - 1].id : null;
    syncHash(); render(); scrollFeedToBottom();
  } else {
    state.route = 'mock'; state.mockTab = 'config'; state.mockReqSelected = null;
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
  setRoute(ep.type === 'mock' ? 'mocks' : 'webhooks');
};

// ---- edit / delete via modals ----
app.openEpEditor = (ep) => app.set({
  dropdown: null,
  epEditor: {
    id: ep.id, type: ep.type, name: ep.name, slug: ep.slug,
    method: ep.method || 'POST', path: ep.path || '/',
    projectName: ep.project ? ep.project.name : '',
    forwardTarget: ep.forward_target || ep.forwardTarget || '', error: {},
  },
});
app.cancelEpEditor = () => app.set({ epEditor: null, dropdown: null, projQuery: '' });
app.saveEpEditor = async () => {
  const e = state.epEditor; if (!e) return;
  const patch = { name: e.name };
  if (e.type === 'inspector') { patch.slug = e.slug; patch.forwardTarget = e.forwardTarget || null; }
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
app.askDeleteEp = (ep) => app.set({ dropdown: null, epConfirmDelete: { id: ep.id, name: ep.name, type: ep.type } });
app.cancelDeleteEp = () => app.set({ epConfirmDelete: null });
app.confirmDeleteEp = async () => {
  const t = state.epConfirmDelete; if (!t) return;
  try {
    await api.del('/endpoints/' + t.id);
    if (state.activeEp && state.activeEp.id === t.id) state.activeEp = null;
    await loadEndpoints(); await loadCounts();
    app.set({ epConfirmDelete: null, route: t.type === 'mock' ? 'mocks' : 'webhooks' });
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
  state.mockTab = tab; state.mockReqSelected = null;
  if (tab === 'requests') { state.feedFilter = { search: '', method: 'ALL' }; await reloadFeed(); }
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
app.setNewRule = (k, v) => { state.newRule[k] = v; if (k === 'when' || k === 'op') render(); };
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

// ---------------- settings ----------------
app.navSettings = async () => {
  state.settingsRequests = [];
  if (state.activeEp) { try { state.settingsRequests = await api.get('/endpoints/' + state.activeEp.id + '/requests?limit=25'); } catch { /* ignore */ } }
  setRoute('settings', { settingsTab: 'auth', secretReveal: false });
};
app.backFromSettings = () => setRoute(state.activeEp && state.activeEp.type === 'mock' ? 'mock' : 'inspector');
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
app.updateCfgRule = (id, key, val) => { const r = state.activeEp.config.rules.find((x) => x.id === id); if (r) { r[key] = val; scheduleRulesSave(); if (key === 'field' || key === 'action') render(); } };
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

  const wsMenu = state.wsMenuOpen ? wsMenuPanel() : null;

  const counts = state.counts || {};
  const nav = h('nav', { style: 'padding:0 12px;display:flex;flex-direction:column;gap:2px' },
    navBtn('Dashboard', icons.dashboard, state.route === 'dashboard', app.navDashboard),
    navBtn('Webhooks', icons.webhook, ['webhooks', 'inspector', 'request', 'diff'].includes(state.route), app.navWebhooks, counts.webhooks),
    navBtn('Mock Servers', icons.mock, ['mocks', 'mock'].includes(state.route), app.navMocks, counts.mocks));

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

function wsMenuPanel() {
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
    h('div', { style: 'position:absolute;left:12px;right:12px;top:calc(100% - 4px);z-index:41;background:#1a1712;border-radius:var(--radius-md);padding:7px;box-shadow:0 20px 48px rgba(0,0,0,0.62);animation:sd-in .12s ease' },
      h('div', { style: 'padding:7px 9px 6px 9px;font-size:10.5px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#5c574e' }, 'Workspaces'),
      ...items,
      h('div', { style: 'height:1px;background:#2a251e;margin:6px 6px' }),
      createBtn));
}

function header() {
  const crumbRoot = { dashboard: 'Overview', webhooks: 'Webhooks', mocks: 'Mock Servers', tailscale: 'Tailscale', 'new-inspector': 'Webhooks', 'new-mock': 'Mock Servers' }[state.route]
    || (state.activeEp ? (state.activeEp.type === 'mock' ? 'Mock Servers' : 'Webhooks') : 'Sidedoor');
  const hasCrumb = ['inspector', 'request', 'diff', 'mock', 'settings'].includes(state.route) && state.activeEp;
  const funnelActive = state.funnel.state && state.funnel.state.active;
  const funnelHost = (state.funnel.state && state.funnel.state.base_url) ? state.funnel.state.base_url.replace(/^https?:\/\//, '') : (state.baseUrls.local || '').replace(/^https?:\/\//, '');
  const dot = h('span', { style: `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${funnelActive ? '#238636' : '#4c473f'};${funnelActive ? 'box-shadow:0 0 0 3px rgba(35,134,54,0.15)' : ''}` });
  const funnelBtn = h('button', { title: 'Open Tailscale Funnel', style: `display:flex;align-items:center;gap:8px;background:${state.route === 'tailscale' ? '#211d17' : '#191712'};border-radius:var(--radius-sm);padding:6px 11px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83`, onclick: app.navTailscale },
    dot, funnelHost || 'localhost', h('span', { style: "color:#57524a;font-family:'IBM Plex Sans';font-weight:500;margin-left:1px" }, funnelActive ? 'Funnel' : 'Offline'));
  funnelBtn.addEventListener('mouseenter', () => { funnelBtn.style.background = '#211d17'; });
  funnelBtn.addEventListener('mouseleave', () => { funnelBtn.style.background = '#191712'; });

  return h('header', { style: 'display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:54px;flex-shrink:0;background:#100e0b' },
    h('div', { style: 'display:flex;align-items:center;gap:9px;min-width:0' },
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
function computeViewKey() {
  return [
    state.route, state.activeEp && state.activeEp.id, state.mockTab,
    state.settingsTab, state.detailTab, state.mockReqTab,
    state.activeReq && state.activeReq.id,
  ].join('|');
}

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
  const viewKey = computeViewKey();
  const sameView = lastViewKey === viewKey;
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
  root.appendChild(h('div', { style: rootGridStyle() },
    sidebar(),
    h('div', { style: 'display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden' },
      header(),
      h('main', { style: 'flex:1;min-height:0;overflow:auto' }, mainBody()))));
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
