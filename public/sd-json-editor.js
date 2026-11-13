import { codeStatus, formatCode, highlightCode } from './code-format.js';

/* <sd-json-editor> — a code body editor with live syntax highlighting and
 * inline validation that marks the error at its exact character position.
 *
 * Emits a bubbling `input` event (React onInput reads e.target.value from the
 * inner <textarea>). Reflects an external `value` (attribute or property) only
 * when it actually differs from what's typed, so React re-renders never disturb
 * the caret. Formats valid JSON on blur and via the Format button.
 *
 * It keeps the legacy element name so JSON forms remain compatible while a
 * language attribute enables XML, GraphQL, HTTP and template editors.
 */
(function () {
  if (window.customElements && customElements.get('sd-json-editor')) return;

  var C = {
    key: '#6a9fd4', colon: '#57524a', str: '#8fb98a', bool: '#b28de0',
    nul: '#e5675c', num: '#d69a3c', punct: '#8a837a', text: '#c2bbb0',
    err: '#e5675c', ok: '#6f9f78', muted: '#8a837a'
  };
  var FONT = "12.5px/1.6 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace";
  var PAD = '12px 14px';

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // A strict recursive-descent JSON scanner that reports the FIRST error and its
  // exact character index — independent of the engine's error-message format.
  function locateError(s) {
    var i = 0, n = s.length;
    function ws() { while (i < n) { var c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } }
    function err(msg, at) { var e = new Error(msg); e.at = (at == null ? i : at); return e; }
    function value() {
      ws();
      if (i >= n) throw err('Unexpected end of input — a value is missing', n);
      var c = s.charAt(i);
      if (c === '{') return obj();
      if (c === '[') return arr();
      if (c === '"') return str();
      if (c === '-' || (c >= '0' && c <= '9')) return num();
      if (s.substr(i, 4) === 'true') { i += 4; return; }
      if (s.substr(i, 5) === 'false') { i += 5; return; }
      if (s.substr(i, 4) === 'null') { i += 4; return; }
      throw err("Unexpected token '" + c + "' — expected a value");
    }
    function str() {
      var start = i; i++;
      while (i < n) {
        var c = s.charAt(i);
        if (c === '\\') { i += 2; if (i > n) throw err('Unterminated string', start); continue; }
        if (c === '"') { i++; return; }
        if (c === '\n' || c === '\r') throw err('Unterminated string', start);
        i++;
      }
      throw err('Unterminated string', start);
    }
    function num() {
      var m = /^-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?/.exec(s.slice(i));
      if (!m) throw err('Invalid number');
      i += m[0].length;
    }
    function obj() {
      i++; ws();
      if (s.charAt(i) === '}') { i++; return; }
      while (true) {
        ws();
        if (s.charAt(i) !== '"') throw err(i >= n ? 'Unterminated object — expected "}"' : 'Property name must be in double quotes');
        str(); ws();
        if (s.charAt(i) !== ':') throw err("Expected ':' after property name");
        i++; value(); ws();
        var c = s.charAt(i);
        if (c === ',') { i++; continue; }
        if (c === '}') { i++; return; }
        throw err("Expected ',' or '}' after property value");
      }
    }
    function arr() {
      i++; ws();
      if (s.charAt(i) === ']') { i++; return; }
      while (true) {
        value(); ws();
        var c = s.charAt(i);
        if (c === ',') { i++; continue; }
        if (c === ']') { i++; return; }
        throw err("Expected ',' or ']' after array element");
      }
    }
    try {
      value(); ws();
      if (i < n) throw err('Unexpected trailing characters');
      return null;
    } catch (e) {
      var at = (e.at == null ? i : e.at); if (at > n) at = n; if (at < 0) at = 0;
      return { pos: at, message: e.message };
    }
  }

  // Validity is authoritative from JSON.parse; the scanner pinpoints the spot.
  function lint(src) {
    if (!src || !src.trim()) return null;
    try { JSON.parse(src); return null; }
    catch (_) {
      var loc = locateError(src) || { pos: src.length, message: 'Invalid JSON' };
      var upto = src.slice(0, loc.pos).split('\n');
      return { message: loc.message, pos: loc.pos, line: upto.length, col: upto[upto.length - 1].length + 1 };
    }
  }

  function lintLanguage(src, language) {
    if (language === 'json') return lint(src);
    if (!src || !src.trim()) return null;
    var checked = codeStatus(src, language);
    if (checked.valid) return null;
    return { message: checked.message || 'Invalid ' + checked.label, pos: checked.position, line: checked.line, col: checked.column };
  }

  function positionAt(src, line, column) {
    var rows = String(src).split('\n');
    var targetLine = Math.max(1, Number(line) || 1);
    var targetColumn = Math.max(1, Number(column) || 1);
    var offset = 0;
    for (var index = 0; index < targetLine - 1 && index < rows.length; index++) offset += rows[index].length + 1;
    var row = rows[Math.min(rows.length - 1, targetLine - 1)] || '';
    return Math.min(String(src).length, offset + Math.min(row.length, targetColumn - 1));
  }

  // Transparent overlay that carries only a wavy underline under the bad char.
  function errorLayer(src, pos) {
    var mid, tail = '';
    if (pos >= src.length) { mid = '&nbsp;'; }
    else if (src.charAt(pos) === '\n') { mid = '&nbsp;'; tail = '\n'; }
    else { mid = esc(src.charAt(pos)); }
    return esc(src.slice(0, pos)) +
      '<span style="color:transparent;text-decoration:underline wavy ' + C.err +
      ';text-decoration-thickness:2px;text-underline-offset:3px;-webkit-text-decoration:underline wavy ' + C.err + '">' +
      mid + '</span>' + tail + esc(src.slice(pos + 1));
  }

  var PROTO = Object.create(HTMLElement.prototype);

  var ICON_FMT = '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>';
  var ICON_ERR = '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>';
  var ICON_OK = '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  function SdJsonEditor() { return Reflect.construct(HTMLElement, [], SdJsonEditor); }
  SdJsonEditor.prototype = PROTO;
  PROTO.constructor = SdJsonEditor;

  Object.defineProperty(SdJsonEditor, 'observedAttributes', { get: function () { return ['value', 'rows', 'language']; } });

  PROTO.connectedCallback = function () {
    if (this._built) { return; }
    this._built = true;
    if (!Object.prototype.hasOwnProperty.call(this, '_externalValidation')) this._externalValidation = null;
    var rows = parseInt(this.getAttribute('rows') || '6', 10);
    this._language = this.getAttribute('language') || 'json';
    var initial = this.getAttribute('value');
    if (initial == null) initial = this.textContent || '';
    this.textContent = '';

    this.style.display = 'block';

    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;border-radius:var(--radius-sm);background:#141210;' +
      'box-shadow:inset 0 0 0 1px rgba(245,240,230,0.07);transition:box-shadow .12s;overflow:hidden';

    var common = 'margin:0;padding:' + PAD + ';font:' + FONT + ';font-variant-ligatures:none;' +
      'white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;tab-size:2;-moz-tab-size:2;';

    var hl = document.createElement('pre');       // colored tokens (defines height)
    hl.setAttribute('aria-hidden', 'true');
    hl.style.cssText = common + 'position:relative;z-index:0;color:' + C.text + ';min-height:' + (rows * 1.6) + 'em;pointer-events:none;';

    var errl = document.createElement('pre');     // wavy underline at exact error
    errl.setAttribute('aria-hidden', 'true');
    errl.style.cssText = common + 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:1;color:transparent;pointer-events:none;';

    var ta = document.createElement('textarea');  // real input, transparent text
    ta.spellcheck = false;
    ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off');
    ta.wrap = 'soft';
    ta.value = initial;
    ta.style.cssText = common + 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;resize:none;' +
      'z-index:2;background:transparent;color:transparent;caret-color:#edecec;outline:none;display:block;';

    wrap.appendChild(hl); wrap.appendChild(errl); wrap.appendChild(ta);

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:8px;min-height:18px';
    var status = document.createElement('div');
    status.style.cssText = 'flex:1;min-width:0;display:flex;align-items:center;gap:6px;font:500 11.5px/1.4 ' +
      "'IBM Plex Sans',system-ui,sans-serif;letter-spacing:.005em";
    var fmt = document.createElement('button');
    fmt.type = 'button';
    fmt.innerHTML = ICON_FMT + '<span style="margin-left:5px">Format</span>';
    fmt.style.cssText = 'display:inline-flex;align-items:center;background:transparent;color:' + C.muted +
      ";font:600 11.5px/1 'IBM Plex Sans',system-ui,sans-serif;padding:3px 4px;border:0;cursor:pointer;transition:color .12s;flex-shrink:0";
    var templateBtn = document.createElement('button');
    templateBtn.type = 'button';
    templateBtn.title = 'Insert template variable';
    templateBtn.setAttribute('aria-label', 'Insert template variable');
    templateBtn.innerHTML = '<span style="font-family:IBM Plex Mono,monospace;font-size:10px;font-weight:700;color:#e8b88a">{ }</span><span style="margin-left:5px">Variables</span>';
    templateBtn.style.cssText = 'display:none;align-items:center;background:transparent;color:#9c927f;' +
      "font:600 11.5px/1 'IBM Plex Sans',system-ui,sans-serif;padding:3px 4px;border:0;border-radius:var(--radius-xs);cursor:pointer;transition:color .12s,background .12s;flex-shrink:0";
    foot.appendChild(status); foot.appendChild(templateBtn); foot.appendChild(fmt);

    this.appendChild(wrap); this.appendChild(foot);
    this._ta = ta; this._hl = hl; this._errl = errl; this._status = status; this._wrap = wrap; this._fmt = fmt; this._templateButton = templateBtn;

    var self = this;
    ta.addEventListener('input', function () { self._externalValidation = null; self._render(); });
    ta.addEventListener('scroll', function () { hl.scrollTop = ta.scrollTop; errl.scrollTop = ta.scrollTop; });
    ta.addEventListener('focus', function () { wrap.style.boxShadow = 'inset 0 0 0 1px rgba(245,240,230,0.07), 0 0 0 2px rgba(237,236,236,0.6)'; });
    ta.addEventListener('blur', function () {
      wrap.style.boxShadow = 'inset 0 0 0 1px rgba(245,240,230,0.07)';
      self._format();   // tidy valid structured code when leaving the field
    });
    fmt.addEventListener('mouseenter', function () { if (!fmt.disabled) fmt.style.color = '#e8e2d7'; });
    fmt.addEventListener('mouseleave', function () { if (!fmt.disabled) fmt.style.color = C.muted; });
    fmt.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep textarea focus
    fmt.addEventListener('click', function () { self._format(); self._ta.focus(); });
    templateBtn.addEventListener('mouseenter', function () { templateBtn.style.color = '#e8e2d7'; templateBtn.style.background = '#211d17'; });
    templateBtn.addEventListener('mouseleave', function () { templateBtn.style.color = '#9c927f'; templateBtn.style.background = 'transparent'; });
    templateBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });

    this._syncTemplateControl();
    this._render();
    this.dispatchEvent(new CustomEvent('sd-editor-ready'));
  };

  PROTO.attributeChangedCallback = function (name, oldV, newV) {
    if (!this._built) return;
    if (name === 'value') this.value = newV == null ? '' : newV;
    else if (name === 'rows' && this._hl) this._hl.style.minHeight = (parseInt(newV || '6', 10) * 1.6) + 'em';
    else if (name === 'language') { this._language = newV || 'json'; this._render(); }
  };

  Object.defineProperty(PROTO, 'value', {
    get: function () { return this._ta ? this._ta.value : (this.getAttribute('value') || ''); },
    set: function (v) {
      v = v == null ? '' : String(v);
      if (!this._ta) { this.setAttribute('value', v); return; }
      if (v === this._ta.value) return;            // no-op during typing → caret preserved
      var s = this._ta.selectionStart, e = this._ta.selectionEnd;
      this._ta.value = v;
      try { this._ta.setSelectionRange(Math.min(s, v.length), Math.min(e, v.length)); } catch (_) {}
      this._render();
    }
  });

  Object.defineProperty(PROTO, 'externalValidation', {
    get: function () { return this._externalValidation || null; },
    set: function (value) {
      this._externalValidation = value && typeof value === 'object' ? value : null;
      if (this._built) this._render();
    }
  });

  PROTO.setExternalValidation = function (value) {
    this.externalValidation = value;
  };

  Object.defineProperty(PROTO, 'templateSuggestions', {
    get: function () { return this._templateSuggestions || []; },
    set: function (value) {
      this._templateSuggestions = Array.isArray(value) ? value : [];
      if (this._built) this._syncTemplateControl();
    }
  });

  Object.defineProperty(PROTO, 'templateButton', {
    get: function () { return this._templateButton || null; }
  });

  PROTO.getInputElement = function () {
    return this._ta || null;
  };

  PROTO._syncTemplateControl = function () {
    if (!this._templateButton) return;
    this._templateButton.style.display = this._templateSuggestions && this._templateSuggestions.length ? 'inline-flex' : 'none';
  };

  PROTO._format = function () {
    var v = this._ta.value;
    if (!v || !v.trim()) return;
    var checked = codeStatus(v, this._language);
    if (!checked.valid) return;
    var pretty = formatCode(v, this._language).formatted;
    if (pretty !== v) { this._ta.value = pretty; this._render(); this._emit(); }
  };

  PROTO._emit = function () {
    this._ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  PROTO._render = function () {
    var v = this._ta.value;
    var language = this._language || 'json';
    this._hl.innerHTML = highlightCode(v, language, { format: false }) || '&nbsp;';
    if (v.charAt(v.length - 1) === '\n') this._hl.innerHTML += '\n';
    var err = lintLanguage(v, language);
    var checked = codeStatus(v, language);
    var external = this._externalValidation && this._externalValidation.source === v ? this._externalValidation : null;
    if (!err && external && external.valid === false) {
      var externalLine = Math.max(1, Number(external.line) || 1);
      var externalColumn = Math.max(1, Number(external.column) || 1);
      err = {
        message: external.message || 'Invalid GraphQL SDL',
        pos: Number.isInteger(external.position) ? Math.max(0, Math.min(v.length, external.position)) : positionAt(v, externalLine, externalColumn),
        line: externalLine,
        col: externalColumn
      };
    }
    var canFormat = ['json', 'xml', 'html', 'graphql', 'http'].indexOf(checked.language) !== -1;
    if (err) {
      this._errl.innerHTML = errorLayer(v, err.pos);
      this._errl.style.display = 'block';
      this._status.style.color = C.err;
      this._status.innerHTML = ICON_ERR +
        '<span style="flex-shrink:0;font-weight:700">Line ' + err.line + ', Col ' + err.col + '</span>' +
        '<span style="color:#9a6f68;margin:0 2px">·</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(err.message) + '</span>';
      this._fmt.disabled = true; this._fmt.style.opacity = '.4'; this._fmt.style.cursor = 'default';
    } else {
      this._errl.style.display = 'none'; this._errl.innerHTML = '';
      var empty = !v || !v.trim();
      if (empty) {
        this._status.innerHTML = '';
        this._fmt.disabled = true; this._fmt.style.opacity = '.4'; this._fmt.style.cursor = 'default';
      } else {
        var statusText = external && external.pending ? 'Checking GraphQL SDL…' : external && external.valid === true ? 'Valid GraphQL SDL' : checked.text;
        this._status.style.color = external && external.pending ? C.muted : C.ok;
        this._status.innerHTML = (external && external.pending ? '' : ICON_OK) + '<span>' + esc(statusText) + '</span>';
        this._fmt.disabled = !canFormat; this._fmt.style.opacity = canFormat ? '1' : '.4'; this._fmt.style.cursor = canFormat ? 'pointer' : 'default';
      }
    }
    // keep overlays aligned with any textarea scroll
    this._hl.scrollTop = this._ta.scrollTop; this._errl.scrollTop = this._ta.scrollTop;
  };

  window.SdJsonEditor = SdJsonEditor;
  customElements.define('sd-json-editor', SdJsonEditor);
})();
