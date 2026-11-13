import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {
  constructor(tagName, text = '') {
    this.tagName = tagName;
    this.nodeType = tagName === '#text' ? 3 : 1;
    this.data = text;
    this.children = [];
    this.attributes = {};
    this.style = {};
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.tagName === 'template') this.content = { firstChild: new FakeNode('raw') };
  }
  get innerHTML() { return this._innerHTML || ''; }
}

function fakeDocument() {
  return {
    body: new FakeNode('body'),
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (text) => new FakeNode('#text', String(text)),
    getElementById: () => null,
  };
}
function visibleText(node) { return node.nodeType === 3 ? node.data : node.children.map(visibleText).join(''); }

function appFor(protocol) {
  const endpoint = {
    id: 'ep-realtime', name: protocol === 'graphql' ? 'Orders graph' : 'Orders stream', type: 'mock', protocol,
    requestCount: 0, lastActivity: null,
    config: {
      auth: { enabled: false },
      realtime: { maxConnections: 100, maxMessageBytes: 1048576, maxMessagesPerSession: 1000, maxPayloadCaptureBytes: 65536, idleTimeoutMs: 120000, allowedOrigins: ['*'], authSource: 'handshake', protocolAuthPath: 'authorization', messageRate: { enabled: false, limit: 120, window: 'minute' } },
    },
    urls: {
      websocket: { local: 'ws://localhost/orders', public: null },
      graphql: { httpLocal: 'http://localhost/orders', httpPublic: null, wsLocal: 'ws://localhost/orders', wsPublic: null },
      socketio: { local: 'http://localhost', public: null, path: '/_sidedoor/socket.io/', namespace: '/orders' },
    },
  };
  return {
    s: {
      activeEp: endpoint, endpoints: [endpoint], baseUrls: { local: 'http://localhost' }, copied: null, dropdown: null,
      form: { realtime: { protocol, type: 'mock', name: '', slug: '', projectName: '', sdl: 'type Query { health: String }', errors: {}, submitted: false } },
      realtimeTab: protocol === 'graphql' ? 'operations' : 'sessions', realtimeSessions: [], realtimeSelectedSession: null,
      realtimeScripts: [], realtimeFixtures: [], realtimeSchema: { sdl: 'type Query { health: String }' }, realtimeError: '', realtimeTest: null, realtimeTestResult: null,
    },
  };
}

test('Mock Servers unifies protocol selection, list filters and realtime management tabs', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const { realtimeScreen, newRealtimeScreen } = await import('../public/screens/realtime.js');
    const { mocksScreen, mockProtocolPickerScreen, isMockServerEndpoint } = await import('../public/screens/lists.js');
    const { settingsTabs } = await import('../public/screens/settings.js');
    const { icons } = await import('../public/ui.js');
    assert.match(icons.layers(), /<svg/);
    const socketApp = appFor('websocket');
    const newSocketText = visibleText(newRealtimeScreen(socketApp));
    assert.match(newSocketText, /New WebSocket mock/);
    assert.match(newSocketText, /Protocol selected for this mock server/);
    assert.doesNotMatch(newSocketText, /Choose inspector/);
    const socketText = visibleText(realtimeScreen(socketApp));
    for (const tab of ['All Mock Servers', 'Sessions', 'Messages', 'Script', 'Settings', 'Security']) assert.match(socketText, new RegExp(tab));
    socketApp.s.realtimeTab = 'script';
    socketApp.s.realtimeScripts = [{
      id: 'script-1', name: 'Order flow', enabled: true, connectActions: [],
      steps: [{ id: 'step-1', match: { kind: 'message', payload: { type: 'ready' } }, actions: [{ type: 'send', payload: { ok: true } }] }],
    }];
    const scriptText = visibleText(realtimeScreen(socketApp));
    assert.match(scriptText, /STEP 1/);
    assert.match(scriptText, /Expected message/);

    const graphApp = appFor('graphql');
    const graphText = visibleText(realtimeScreen(graphApp));
    for (const tab of ['Operations', 'Schema', 'Fixtures', 'Subscriptions', 'History', 'Settings', 'Security']) assert.match(graphText, new RegExp(tab));
    assert.deepEqual(settingsTabs(graphApp.s.activeEp).map(([id]) => id), ['auth', 'hmac', 'rate']);
    assert.deepEqual(settingsTabs(socketApp.s.activeEp).map(([id]) => id), ['auth', 'rate']);

    const httpMock = {
      id: 'ep-http', name: 'Payments API', type: 'mock', protocol: 'http', method: 'POST', path: '/charges',
      scenarios: [], config: { auth: { enabled: false } }, project: null,
    };
    const socketMock = { ...socketApp.s.activeEp, project: null };
    const graphMock = { ...graphApp.s.activeEp, project: null };
    const unifiedApp = {
      ...socketApp,
      s: { ...socketApp.s, endpoints: [httpMock, socketMock, graphMock], mockProtocolFilter: 'all' },
    };
    const unifiedText = visibleText(mocksScreen(unifiedApp));
    for (const label of ['Mock Servers', 'All', 'HTTP', 'WebSocket', 'Socket.IO', 'GraphQL', 'Payments API', 'Orders stream', 'Orders graph']) {
      assert.match(unifiedText, new RegExp(label));
    }
    const pickerText = visibleText(mockProtocolPickerScreen(unifiedApp));
    for (const choice of ['HTTP API', 'WebSocket', 'Socket.IO', 'GraphQL', 'Configure mock']) assert.match(pickerText, new RegExp(choice));
    assert.equal(isMockServerEndpoint({ type: 'inspector', protocol: 'graphql' }), true);
    assert.equal(isMockServerEndpoint({ type: 'inspector', protocol: 'http' }), false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
