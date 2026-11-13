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

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

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
    execCommand: () => true,
  };
}

function visibleText(node) {
  if (node.nodeType === 3) return node.data;
  return node.children.map(visibleText).join('');
}

function editingScenarioApp() {
  const scenario = {
    id: 'sc-editing', name: 'Default', status: 202, delay: 0,
    contentType: 'application/json', body: '{"accepted":true}', active: true,
    headers: {}, events: [],
  };
  return {
    s: {
      activeEp: {
        id: 'ep-editing', name: 'Async events visibility', method: 'POST', path: '/orders',
        urls: { local: 'http://localhost/orders', public: null }, requestCount: 0, mode: 'single',
        scenarios: [scenario], matchRules: [], config: { auth: { enabled: false } },
      },
      mockTab: 'config', copied: null, dropdown: null, expandedScenario: scenario.id,
      editingScenario: scenario.id,
      editScenario: { name: scenario.name, status: scenario.status, delay: scenario.delay, contentType: scenario.contentType, body: scenario.body },
      addScenarioOpen: false, newScenario: {}, addRuleOpen: false, newRule: {},
      eventEditor: null, eventTest: null,
    },
    selectHelper: (_id, value, options, onPick, extra = {}) => ({ value, options, onPick, ...extra }),
  };
}

test('keeps Async events available while editing a mock scenario', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const { mockScreen } = await import('../public/screens/mock.js');
    const screen = mockScreen(editingScenarioApp());
    const text = visibleText(screen);

    assert.match(text, /Async events/);
    assert.match(text, /Add event/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
