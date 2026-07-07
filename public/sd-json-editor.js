/* <sd-json-editor> — a JSON body editor with live syntax highlighting and
 * inline linting that marks the error at its exact character position.
 *
 * Emits a bubbling `input` event (React onInput reads e.target.value from the
 * inner <textarea>). Reflects an external `value` (attribute or property) only
 * when it actually differs from what's typed, so React re-renders never disturb
 * the caret. Formats valid JSON on blur and via the Format button.
 *
 * Colors mirror the app's hlJSON() scheme so editors match read-only previews.
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

  // Tokenize raw (possibly invalid) text — never reformats, so the caret is safe.
  var TOK = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?|[{}\[\],])/g;
  function highlight(src) {
    var out = esc(src).replace(TOK, function (m) {
      if (m.charAt(0) === '"') {
        if (/:\s*$/.test(m)) {
          return '<span style="color:' + C.key + '">' + m.replace(/:\s*$/, '') +
                 '</span><span style="color:' + C.colon + '">:</span>';
        }
        return '<span style="color:' + C.str + '">' + m + '</span>';
      }
      if (m === 'true' || m === 'false') return '<span style="color:' + C.bool + '">' + m + '</span>';
      if (m === 'null') return '<span style="color:' + C.nul + '">' + m + '</span>';
      if (/^[{}\[\],]$/.test(m)) return '<span style="color:' + C.punct + '">' + m + '</span>';
      return '<span style="color:' + C.num + '">' + m + '</span>';
    });
    // Preserve a trailing blank line so the highlight height matches the textarea.
    if (src.charAt(src.length - 1) === '\n') out += '\n';
    return out || '&nbsp;';
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

  Object.defineProperty(SdJsonEditor, 'observedAttributes', { get: function () { return ['value', 'rows']; } });

  PROTO.connectedCallback = function () {
    if (this._built) { return; }
    this._built = true;
    var rows = parseInt(this.getAttribute('rows') || '6', 10);
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
    foot.appendChild(status); foot.appendChild(fmt);

    this.appendChild(wrap); this.appendChild(foot);
    this._ta = ta; this._hl = hl; this._errl = errl; this._status = status; this._wrap = wrap; this._fmt = fmt;

    var self = this;
    ta.addEventListener('input', function () { self._render(); });
    ta.addEventListener('scroll', function () { hl.scrollTop = ta.scrollTop; errl.scrollTop = ta.scrollTop; });
    ta.addEventListener('focus', function () { wrap.style.boxShadow = 'inset 0 0 0 1px rgba(245,240,230,0.07), 0 0 0 2px rgba(237,236,236,0.6)'; });
    ta.addEventListener('blur', function () {
      wrap.style.boxShadow = 'inset 0 0 0 1px rgba(245,240,230,0.07)';
      self._format();   // tidy valid JSON when leaving the field
    });
    fmt.addEventListener('mouseenter', function () { if (!fmt.disabled) fmt.style.color = '#e8e2d7'; });
    fmt.addEventListener('mouseleave', function () { if (!fmt.disabled) fmt.style.color = C.muted; });
    fmt.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep textarea focus
    fmt.addEventListener('click', function () { self._format(); self._ta.focus(); });

    this._render();
  };

  PROTO.attributeChangedCallback = function (name, oldV, newV) {
    if (!this._built) return;
    if (name === 'value') this.value = newV == null ? '' : newV;
    else if (name === 'rows' && this._hl) this._hl.style.minHeight = (parseInt(newV || '6', 10) * 1.6) + 'em';
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

  PROTO._format = function () {
    var v = this._ta.value;
    if (!v || !v.trim()) return;
    try {
      var pretty = JSON.stringify(JSON.parse(v), null, 2);
      if (pretty !== v) { this._ta.value = pretty; this._render(); this._emit(); }
    } catch (_) { /* invalid — leave as typed */ }
  };

  PROTO._emit = function () {
    this._ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  PROTO._render = function () {
    var v = this._ta.value;
    this._hl.innerHTML = highlight(v);
    var err = lint(v);
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
        this._status.style.color = C.ok;
        this._status.innerHTML = ICON_OK + '<span>Valid JSON</span>';
        this._fmt.disabled = false; this._fmt.style.opacity = '1'; this._fmt.style.cursor = 'pointer';
      }
    }
    // keep overlays aligned with any textarea scroll
    this._hl.scrollTop = this._ta.scrollTop; this._errl.scrollTop = this._ta.scrollTop;
  };

  window.SdJsonEditor = SdJsonEditor;
  customElements.define('sd-json-editor', SdJsonEditor);
})();
