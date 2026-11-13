import assert from 'node:assert/strict';
import test from 'node:test';
import { attachTemplateAssist, codeStatus, floatingPlacement, formatCode, highlightCode, select, textareaCaretRect, validateCode } from '../public/ui.js';
import { templateSuggestions } from '../src/lib/templateCatalog.js';

class FakeNode {
  constructor(tagName, ownerDocument, text = '') {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.nodeType = tagName === '#text' ? 3 : 1;
    this.data = text;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.listeners = new Map();
    this._rect = { top: 0, bottom: 40, left: 0, width: 180 };
  }

  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  get scrollHeight() { return Math.max(36, this.children.length * 42 + 10); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] || null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name) { const listener = this.listeners.get(name); if (listener) listener({ key: name === 'keydown' ? 'Escape' : undefined, stopPropagation() {} }); }
  getBoundingClientRect() { return this._rect; }
  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.tagName === 'template') this.content = { firstChild: new FakeNode('raw', this.ownerDocument) };
  }
  get innerHTML() { return this._innerHTML || ''; }
  set textContent(value) { this.children = [new FakeNode('#text', this.ownerDocument, String(value))]; }
  get textContent() { return this.nodeType === 3 ? this.data : this.children.map((child) => child.textContent).join(''); }
}

function fakeDocument() {
  const listeners = new Map();
  const document = {
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement(tagName) { return new FakeNode(tagName, document); },
    createTextNode(text) { return new FakeNode('#text', document, String(text)); },
    getElementById() { return null; },
    defaultView: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
    },
  };
  document.body = new FakeNode('body', document);
  return document;
}

test('formats, validates and safely highlights JSON, XML and GraphQL', () => {
  const json = formatCode('{"b":2,"a":true}', 'json');
  assert.equal(json.valid, true);
  assert.equal(json.formatted, '{\n  "b": 2,\n  "a": true\n}');
  assert.equal(validateCode('{"a": }', 'json').valid, false);

  assert.equal(validateCode('<root><item/></root>', 'xml').valid, true);
  assert.equal(validateCode('<root><item></root>', 'xml').valid, false);
  assert.match(formatCode('query Health{health}', 'graphql').formatted, /query Health \{/);
  assert.equal(validateCode('query Health { health', 'graphql').valid, false);
  assert.match(codeStatus('type Query { greeting: }', 'graphql').text, /validating SDL/);

  const highlighted = highlightCode('<root>{{request.id}}</root>', 'xml');
  assert.match(highlighted, /&lt;<\/span>/);
  assert.doesNotMatch(highlighted, /<root>/);
  assert.match(highlightCode('{"id":"{{response.body.id}}"}', 'json'), /font-weight:600/);
  const incompleteTemplate = highlightCode('{"id":"{{response.body.order"}', 'json');
  assert.match(incompleteTemplate, /text-decoration:underline wavy/);
  assert.match(incompleteTemplate, /\{\{response\.body\.order/);
  assert.equal(codeStatus('{"ok":true}', 'json').text, 'Valid JSON');
});

test('chooses a viewport-safe direction for floating select panels', () => {
  const down = floatingPlacement({ top: 100, bottom: 140, left: 30, width: 240 }, { width: 1200, height: 800 }, 180);
  assert.equal(down.direction, 'down');
  assert.equal(down.top, 146);

  const up = floatingPlacement({ top: 700, bottom: 740, left: 30, width: 240 }, { width: 1200, height: 800 }, 180);
  assert.equal(up.direction, 'up');
  assert.equal(up.top, 514);
  assert.ok(up.maxHeight >= 180);

  const inline = floatingPlacement({ top: 150, bottom: 170, left: 300, width: 2 }, { width: 1200, height: 800 }, 220, { preferredWidth: 340, minWidth: 270 });
  assert.equal(inline.width, 340);
  assert.equal(inline.left, 300);
  assert.equal(inline.top, 176);
});

test('select uses a fixed portal and updates locally before notifying its owner', () => {
  const previousDocument = globalThis.document;
  const document = fakeDocument();
  globalThis.document = document;
  try {
    const picks = [];
    const control = select({
      value: 'one',
      options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }, { value: 'three', label: 'Three' }],
      onPick: (value) => picks.push(value),
    });
    const button = control.children[0];
    button._rect = { top: 700, bottom: 740, left: 30, width: 240 };
    button.emit('click');

    const panel = document.body.children.find((node) => node.getAttribute('role') === 'listbox');
    assert.ok(panel);
    assert.equal(panel.style.position, 'fixed');
    assert.equal(panel.getAttribute('data-sd-direction'), 'up');

    panel.children[1].emit('click');
    assert.deepEqual(picks, ['two']);
    assert.equal(document.body.children.length, 0);
    assert.match(control.textContent, /Two/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('template picker surfaces and prioritizes a custom dynamic value', () => {
  const previousDocument = globalThis.document;
  const document = fakeDocument();
  globalThis.document = document;
  try {
    const control = document.createElement('textarea');
    control.value = '{{request.headers.x-tenant-id';
    control.selectionStart = control.value.length;
    control.selectionEnd = control.value.length;
    control._rect = { top: 180, bottom: 220, left: 30, width: 320 };
    document.body.appendChild(control);
    assert.deepEqual(textareaCaretRect(control), { left: 30, top: 180, width: 2, height: 40, right: 32, bottom: 220 });
    attachTemplateAssist(control, templateSuggestions('event'));
    control.emit('input');

    const panel = document.body.children.find((node) => node.getAttribute('role') === 'listbox');
    assert.ok(panel);
    assert.equal(panel.getAttribute('data-sd-template-inline'), 'true');
    assert.equal(panel.style.width, '340px');
    assert.equal(panel.style.left, '30px');
    assert.equal(panel.style.top, '226px');
    assert.match(panel.textContent, /Complete your value/);
    assert.match(panel.textContent, /\{\{request\.headers\.x-tenant-id\}\}/);
    assert.match(panel.textContent, /Type after the final dot/);
    assert.match(panel.textContent, /Enter to complete/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('template picker keeps one-line inputs anchored to the field', () => {
  const previousDocument = globalThis.document;
  const document = fakeDocument();
  globalThis.document = document;
  try {
    const control = document.createElement('input');
    control.value = '{{request.headers.x-tenant-id';
    control.selectionStart = control.value.length;
    control.selectionEnd = control.value.length;
    control._rect = { top: 180, bottom: 220, left: 30, width: 320 };
    document.body.appendChild(control);
    attachTemplateAssist(control, templateSuggestions('event'));
    control.emit('input');

    const panel = document.body.children.find((node) => node.getAttribute('role') === 'listbox');
    assert.ok(panel);
    assert.equal(panel.getAttribute('data-sd-template-inline'), 'false');
    assert.equal(panel.style.width, '320px');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
