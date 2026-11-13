// Shared UI helpers: a tiny hyperscript builder, formatters, colors, code
// presentation, icons, and small components.
import { codeStatus, detectCodeLanguage, escCode, formatCode, highlightCode, validateCode } from './code-format.js';
import { activeTemplateAt, contextualTemplateSuggestions, insertTemplateSuggestion } from './template-assist.js';

export { codeStatus, detectCodeLanguage, formatCode, highlightCode, validateCode } from './code-format.js';

// ---- DOM builder ----
export function h(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'style') e.setAttribute('style', v);
      else if (k === 'class' || k === 'className') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'value') e.value = v;
      else if (k === 'ref' && typeof v === 'function') v(e);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  add(e, children);
  return e;
}
function add(e, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) { add(e, c); continue; }
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

// Parse a static HTML/SVG string into a node (SVG-namespace safe).
export function raw(str) {
  const t = document.createElement('template');
  t.innerHTML = String(str).trim();
  return t.content.firstChild;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ---- formatters ----
export function fmtRel(ms, now = Date.now()) {
  if (!ms) return 'no activity';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const hh = Math.floor(m / 60);
  if (hh < 24) return hh + 'h ago';
  return Math.floor(hh / 24) + 'd ago';
}
export function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (hh > 0) return hh + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const k = n / 1024;
  if (k < 1024) return k.toFixed(k < 10 ? 1 : 0) + ' KB';
  return (k / 1024).toFixed(1) + ' MB';
}
const p2 = (x) => String(x).padStart(2, '0');
export function fmtClock(ms) { const d = new Date(ms); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
export function fmtClockMs(ms) { const d = new Date(ms); return fmtClock(ms) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
export function fmtStamp(ms) { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + fmtClockMs(ms); }

// ---- colors ----
export function methodColor(m) {
  return { GET: '#6a9fd4', POST: '#238636', PUT: '#d69a3c', PATCH: '#b28de0', DELETE: '#e5675c', HEAD: '#948d83', QUERY: '#4fb0a0' }[m] || '#948d83';
}
export function statusColor(c) {
  if (c >= 500) return '#e5675c';
  if (c >= 400) return '#d69a3c';
  if (c >= 300) return '#6a9fd4';
  if (c >= 200) return '#238636';
  return '#948d83';
}
export function authLabel(a) {
  if (!a || a.method === 'none' || !a.enabled) return 'No auth';
  return { bearer: 'Bearer token', apikey: 'API key', basic: 'Basic auth' }[a.method] || 'Auth';
}
export function slugify(v) {
  return String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function esc(s) { return escCode(s); }
export { esc };

// Backward-compatible name for existing response views. Auto detection keeps
// old JSON behavior while also making XML, GraphQL and HTTP payloads legible.
export function hlJSON(obj) {
  const value = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return highlightCode(value == null ? '' : value, 'auto');
}

export function pretty(objOrStr) {
  if (typeof objOrStr === 'string') { try { return JSON.stringify(JSON.parse(objOrStr), null, 2); } catch { return objOrStr; } }
  try { return JSON.stringify(objOrStr, null, 2); } catch { return String(objOrStr); }
}

// Read-only code surface with a consistent safe formatter and validity badge.
// Callers can opt out of the compact badge when the surrounding layout already
// names the representation (for example a small transcript row).
export function codeBlock(value, opts = {}) {
  const presentation = codeStatus(value == null ? '' : String(value), opts.language || 'auto');
  const pre = h('pre', {
    style: opts.style || "margin:0;background:#141210;border-radius:var(--radius-sm);padding:14px 16px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.6;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere",
    html: highlightCode(presentation.formatted, presentation.language),
  });
  if (opts.showMeta === false) return pre;
  const tone = presentation.valid ? '#6f9f78' : '#e08b7f';
  return h('div', { style: opts.wrapperStyle || 'min-width:0' },
    opts.label ? h('div', { style: 'font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#746d62;margin:0 0 6px' }, opts.label) : null,
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 6px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;color:#746d62" }, presentation.label.toUpperCase()),
      h('span', { style: `font-size:10.5px;color:${tone};overflow:hidden;text-overflow:ellipsis;white-space:nowrap` }, presentation.text)),
    pre);
}

// ---- clipboard + toast ----
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      return true;
    } catch { return false; }
  }
}
let toastTimer = null;
export function toast(msg) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  clear(root);
  root.appendChild(h('div', { class: 'sd-toast' }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => clear(root), 2200);
}

// ---- icons (SVG string builders) ----
const svg = (inner, o = {}) => `<svg width="${o.w || 17}" height="${o.h || o.w || 17}" viewBox="0 0 24 24" fill="none" stroke="${o.stroke || 'currentColor'}" stroke-width="${o.sw || 1.7}" stroke-linecap="round" stroke-linejoin="round" style="${o.style || ''}">${inner}</svg>`;

export const WS_ICON_PATHS = {
  box: ['M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z', 'm3.3 7 8.7 5 8.7-5', 'M12 22V12'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  flask: ['M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2', 'M6.453 15h11.094', 'M8.5 2h7'],
  globe: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 2a14.5 14.5 0 0 0 0 20', 'M12 2a14.5 14.5 0 0 1 0 20', 'M2 12h20'],
  rocket: ['M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z', 'M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z', 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0', 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'],
  layers: ['m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12', 'M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'],
};
export const WS_COLORS = ['#edecec', '#238636', '#d69a3c', '#6ea8fe', '#b79cff', '#f0857d'];

export function wsIconSvg(key, o = {}) {
  const paths = (WS_ICON_PATHS[key] || WS_ICON_PATHS.box).map((d) => `<path d="${d}"></path>`).join('');
  return `<svg width="${o.w || 16}" height="${o.h || o.w || 16}" viewBox="0 0 24 24" fill="none" stroke="${o.stroke || '#1a0e07'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

export const icons = {
  webhook: (o = {}) => svg('<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>', o),
  mock: (o = {}) => svg('<rect x="2.5" y="3" width="19" height="7.5" rx="2"/><rect x="2.5" y="13.5" width="19" height="7.5" rx="2"/><path d="M6.5 6.75h.01M6.5 17.25h.01"/>', o),
  dashboard: (o = {}) => svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>', o),
  layers: (o = {}) => svg('<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>', o),
  chevDown: (o = {}) => svg('<path d="M6 9l6 6 6-6"/>', o),
  chevRight: (o = {}) => svg('<path d="M9 18l6-6-6-6"/>', o),
  chevLeft: (o = {}) => svg('<path d="M15 18l-6-6 6-6"/>', o),
  chevUpDown: (o = {}) => svg('<path d="M8 9l4-4 4 4"/><path d="M16 15l-4 4-4-4"/>', o),
  plus: (o = {}) => svg('<path d="M12 5v14M5 12h14"/>', { sw: 2, ...o }),
  check: (o = {}) => svg('<path d="M20 6 9 17l-5-5"/>', { sw: 2.2, ...o }),
  copy: (o = {}) => svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', o),
  trash: (o = {}) => svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>', o),
  edit: (o = {}) => svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>', o),
  gear: (o = {}) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', o),
  search: (o = {}) => svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>', { sw: 1.9, ...o }),
  warning: (o = {}) => svg('<path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>', { sw: 1.8, ...o }),
  shield: (o = {}) => svg('<path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>', { sw: 2, ...o }),
  lock: (o = {}) => svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', { sw: 1.8, ...o }),
  replay: (o = {}) => svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', { sw: 1.9, ...o }),
  compare: (o = {}) => svg('<path d="M9 3v18M4 8h5M4 14h5M20 8h-5M20 14h-5M15 3v18"/>', { sw: 1.8, ...o }),
  download: (o = {}) => svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>', { sw: 1.8, ...o }),
  x: (o = {}) => svg('<path d="M18 6 6 18M6 6l12 12"/>', { sw: 1.9, ...o }),
  circleInfo: (o = {}) => svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>', { sw: 2, ...o }),
  collapse: (o = {}) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', o),
  arrowRight: (o = {}) => svg('<path d="M5 12h14M13 6l6 6-6 6"/>', { sw: 1.8, ...o }),
  eye: (o = {}) => svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>', { sw: 1.8, ...o }),
  tag: (o = {}) => svg('<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l8 8a2 2 0 0 0 2.82 0l7.17-7.17a2 2 0 0 0 0-2.82Z"/><circle cx="7.5" cy="7.5" r="1.5"/>', { sw: 2, ...o }),
  kebab: (o = {}) => `<svg width="${o.w || 18}" height="${o.h || o.w || 18}" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="${o.style || ''}"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>`,
};

// Overflow "⋯" menu. opts: { open, onToggle, onClose, items:[{label, icon(fn), danger, onClick}], size, bg, align, width }
export function kebabMenu(opts) {
  const size = opts.size || 30;
  const btn = h('button', { title: 'More actions', style: `display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:var(--radius-xs);background:${opts.bg || 'transparent'};color:#6a655c;flex-shrink:0;cursor:pointer`, onclick: (e) => { e.stopPropagation(); opts.onToggle(); } }, raw(icons.kebab({ w: 16 })));
  btn.addEventListener('mouseenter', () => { btn.style.background = opts.hoverBg || '#211d17'; btn.style.color = '#cfc8bc'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = opts.bg || 'transparent'; btn.style.color = '#6a655c'; });
  const wrap = h('div', { style: 'position:relative;flex-shrink:0' }, btn);
  if (opts.open) {
    wrap.appendChild(h('div', { style: 'position:fixed;inset:0;z-index:60', onclick: (e) => { e.stopPropagation(); opts.onClose(); } }));
    const menu = h('div', { style: `position:absolute;top:calc(100% + 6px);${opts.align === 'left' ? 'left:0' : 'right:0'};z-index:61;width:${opts.width || 184}px;background:#211d17;border-radius:var(--radius-md);padding:6px;box-shadow:0 20px 48px rgba(0,0,0,0.62);animation:sd-in .12s ease` });
    for (const it of opts.items) {
      const row = h('button', { style: `width:100%;display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--radius-sm);text-align:left;background:transparent;cursor:pointer;font-size:13px;font-weight:500;color:${it.danger ? '#e08b7f' : '#d9d3c7'}`, onclick: (e) => { e.stopPropagation(); it.onClick(); } },
        it.icon ? raw(it.icon({ w: 15, sw: 1.9 })) : null, it.label);
      row.addEventListener('mouseenter', () => { row.style.background = it.danger ? 'rgba(207,139,127,0.14)' : '#2f2921'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      menu.appendChild(row);
    }
    wrap.appendChild(menu);
  }
  return wrap;
}

// ---- floating select / popover placement ----
// A fixed layer avoids clipping inside scroll containers and never changes
// document flow. It is shared by selects and richer pickers so all choices
// open toward the side with the usable viewport space.
export function floatingPlacement(rect, viewport, desiredHeight, opts = {}) {
  const margin = opts.margin == null ? 8 : opts.margin;
  const gap = opts.gap == null ? 6 : opts.gap;
  const maxPreferred = opts.maxHeight || 280;
  const desiredWidth = opts.preferredWidth == null ? rect.width || 0 : opts.preferredWidth;
  const minWidth = Math.max(0, Number(opts.minWidth) || 0);
  const width = Math.min(Math.max(minWidth, Number(desiredWidth) || 0), Math.max(0, viewport.width - margin * 2));
  const below = Math.max(0, viewport.height - (rect.bottom || 0) - gap - margin);
  const above = Math.max(0, (rect.top || 0) - gap - margin);
  const direction = below >= Math.min(desiredHeight, maxPreferred) || below >= above ? 'down' : 'up';
  const available = direction === 'down' ? below : above;
  const maxHeight = Math.min(maxPreferred, available);
  const height = Math.min(Math.max(0, desiredHeight), maxHeight);
  const left = Math.max(margin, Math.min(rect.left || 0, viewport.width - margin - width));
  const top = direction === 'down'
    ? Math.min(viewport.height - margin, (rect.bottom || 0) + gap)
    : Math.max(margin, (rect.top || 0) - gap - height);
  return { direction, top, left, width, maxHeight };
}

const floatingClosers = new Set();
export function closeFloatingPanels() {
  for (const close of [...floatingClosers]) close();
}

function fallbackCaretRect(control) {
  const rect = control && typeof control.getBoundingClientRect === 'function'
    ? control.getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 20 };
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const height = Math.max(16, Number(rect.height) || Number(rect.bottom) - top || 20);
  return { left, top, width: 2, height, right: left + 2, bottom: top + height };
}

function textareaLineHeight(styles) {
  const lineHeight = Number.parseFloat(styles && styles.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(styles && styles.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.6 : 20;
}

// Textareas do not expose a native caret rectangle. A short-lived invisible
// mirror gives the portal a real viewport anchor without moving the page or
// mutating the editor, including after soft wraps and local scrolling.
export function textareaCaretRect(control) {
  const fallback = fallbackCaretRect(control);
  const doc = control && control.ownerDocument;
  const view = doc && doc.defaultView;
  if (!control || !doc || !doc.body || !view || typeof view.getComputedStyle !== 'function' || typeof doc.createElement !== 'function') return fallback;

  const styles = view.getComputedStyle(control);
  if (!styles) return fallback;
  const mirror = doc.createElement('div');
  const copiedStyles = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontVariantLigatures',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'MozTabSize',
  ];
  for (const property of copiedStyles) mirror.style[property] = styles[property];

  const source = String(control.value == null ? '' : control.value);
  const caret = Math.max(0, Math.min(source.length, Number(control.selectionStart) || 0));
  const lineHeight = textareaLineHeight(styles);
  const width = Math.max(1, Number(control.clientWidth) || fallback.width);
  mirror.style.position = 'fixed';
  mirror.style.left = `${fallback.left - (Number(control.scrollLeft) || 0)}px`;
  mirror.style.top = `${fallback.top - (Number(control.scrollTop) || 0)}px`;
  mirror.style.width = `${width}px`;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '0';
  mirror.style.boxSizing = 'border-box';
  mirror.style.border = '0';
  mirror.style.overflow = 'visible';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.zIndex = '-1';
  mirror.textContent = source.slice(0, caret);

  const marker = doc.createElement('span');
  marker.textContent = '\u200b';
  marker.style.display = 'inline-block';
  marker.style.width = '2px';
  marker.style.height = `${lineHeight}px`;
  marker.style.verticalAlign = 'top';
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  try {
    const markerRect = marker.getBoundingClientRect();
    const left = Number(markerRect.left);
    const top = Number(markerRect.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return fallback;
    const height = Math.max(16, Number(markerRect.height) || lineHeight);
    const width = Math.max(2, Number(markerRect.width) || 2);
    return { left, top, width, height, right: left + width, bottom: top + height };
  } finally {
    mirror.remove();
  }
}

function textareaCaretAnchor(control) {
  return {
    ownerDocument: control.ownerDocument,
    getBoundingClientRect: () => textareaCaretRect(control),
  };
}

export function mountFloatingPanel(anchor, panel, opts = {}) {
  const doc = anchor.ownerDocument || document;
  const root = doc.body;
  const view = doc.defaultView || (typeof window === 'undefined' ? null : window);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    panel.remove();
    backdrop.remove();
    if (view && view.removeEventListener) {
      view.removeEventListener('resize', position);
      view.removeEventListener('scroll', position, true);
      view.removeEventListener('keydown', onKeyDown);
    }
    floatingClosers.delete(close);
    if (opts.onClosed) opts.onClosed();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (opts.onDismiss) opts.onDismiss(); else close();
    }
  };
  const backdrop = h('div', {
    style: `position:fixed;inset:0;z-index:${opts.zIndex || 80}`,
    onclick: (event) => { event.stopPropagation(); if (opts.onDismiss) opts.onDismiss(); else close(); },
  });
  const position = () => {
    if (closed || !anchor.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    const viewport = {
      width: (view && view.innerWidth) || doc.documentElement && doc.documentElement.clientWidth || rect.width,
      height: (view && view.innerHeight) || doc.documentElement && doc.documentElement.clientHeight || rect.bottom,
    };
    const requestedHeight = Math.min(opts.maxHeight || 280, Math.max(panel.scrollHeight || 0, opts.minHeight || 0));
    const placement = floatingPlacement(rect, viewport, requestedHeight, opts);
    panel.style.position = 'fixed';
    panel.style.left = `${placement.left}px`;
    panel.style.top = `${placement.top}px`;
    panel.style.width = `${placement.width}px`;
    panel.style.maxHeight = `${placement.maxHeight}px`;
    panel.setAttribute('data-sd-direction', placement.direction);
  };
  root.appendChild(backdrop);
  root.appendChild(panel);
  floatingClosers.add(close);
  position();
  if (view && view.addEventListener) {
    view.addEventListener('resize', position);
    view.addEventListener('scroll', position, true);
    view.addEventListener('keydown', onKeyDown);
  }
  return { close, position };
}

// ---- template variable assistance ----
// This control updates only the active field. It intentionally does not touch
// application state beyond the normal input event, which keeps the caret and
// the surrounding form stable while a user browses or filters variables.
function templateTrigger(label = 'Variables', compact = false) {
  const button = h('button', {
    type: 'button', title: 'Insert template variable', 'aria-label': 'Insert template variable',
    style: `display:inline-flex;align-items:center;gap:${compact ? '0' : '5px'};background:transparent;color:#9c927f;font:600 11.5px/1 'IBM Plex Sans',system-ui,sans-serif;padding:${compact ? '4px' : '3px 4px'};border:0;border-radius:var(--radius-xs);cursor:pointer;transition:color .12s,background .12s;flex-shrink:0`,
  }, h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:#e8b88a" }, '{ }'), compact ? null : h('span', {}, label));
  button.addEventListener('mouseenter', () => { button.style.color = '#e8e2d7'; button.style.background = '#211d17'; });
  button.addEventListener('mouseleave', () => { button.style.color = '#9c927f'; button.style.background = 'transparent'; });
  button.addEventListener('mousedown', (event) => event.preventDefault());
  return button;
}

function templatePanelRow(suggestion, selected, onPick) {
  const row = h('button', {
    type: 'button', role: 'option', 'aria-selected': selected ? 'true' : 'false',
    style: `width:100%;display:flex;align-items:flex-start;gap:10px;padding:8px 9px;border-radius:var(--radius-xs);background:${selected ? '#2c251c' : 'transparent'};color:#d9d3c7;text-align:left;cursor:pointer`,
    onmousedown: (event) => event.preventDefault(),
    onclick: (event) => { event.stopPropagation(); onPick(suggestion); },
  },
  h('span', { style: "min-width:0;flex:1;font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.45;color:#e8b88a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, suggestion.token),
  h('span', { style: 'width:42%;min-width:0;font-size:10.5px;line-height:1.35;color:#8e867a;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical' }, suggestion.description || suggestion.label || ''));
  row.addEventListener('mouseenter', () => { if (!selected) row.style.background = '#29231b'; });
  row.addEventListener('mouseleave', () => { if (!selected) row.style.background = 'transparent'; });
  return row;
}

function templateDynamicHint(suggestions) {
  const kinds = [...new Set((Array.isArray(suggestions) ? suggestions : [])
    .map((suggestion) => suggestion && suggestion.dynamicKind)
    .filter(Boolean))];
  if (!kinds.length) return '';
  const names = kinds.length === 1 ? kinds[0]
    : kinds.length === 2 ? `${kinds[0]} or ${kinds[1]}`
      : `${kinds.slice(0, -1).join(', ')}, or ${kinds.at(-1)}`;
  return `Type after the final dot to use any ${names} that is not listed.`;
}

// Attaches contextual autocomplete to a native input or textarea. Catalog data
// is supplied by the admin bootstrap, so this helper never invents variables.
export function attachTemplateAssist(control, suggestions, opts = {}) {
  const available = Array.isArray(suggestions) ? suggestions : [];
  if (!control || !available.length) return { open() {}, close() {} };

  const anchor = opts.anchor || control;
  const inline = opts.inline == null ? String(control.tagName || '').toLowerCase() === 'textarea' : !!opts.inline;
  const panelAnchor = inline ? textareaCaretAnchor(control) : anchor;
  const floatingZIndex = 140;
  let panel = null;
  let layer = null;
  let matches = [];
  let selectedIndex = 0;
  let mode = null;

  const setTriggerLayer = (open) => {
    if (!opts.trigger) return;
    opts.trigger.style.position = opts.trigger.style.position || 'relative';
    opts.trigger.style.zIndex = open ? String(floatingZIndex + 2) : '';
  };

  const layerClosed = () => {
    panel = null;
    layer = null;
    matches = [];
    mode = null;
    setTriggerLayer(false);
  };
  const close = () => {
    if (!panel) return;
    const activeLayer = layer;
    panel = null;
    layer = null;
    matches = [];
    mode = null;
    setTriggerLayer(false);
    if (activeLayer) activeLayer.close();
  };
  const apply = (suggestion) => {
    if (!suggestion) return;
    const next = insertTemplateSuggestion(control.value, control.selectionStart, control.selectionEnd, suggestion);
    control.value = next.value;
    try { control.setSelectionRange(next.selectionStart, next.selectionEnd); } catch (_) { /* unsupported input type */ }
    control.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    try { control.focus({ preventScroll: true }); } catch (_) { control.focus(); }
  };
  const renderPanel = (query) => {
    if (!panel) return;
    matches = contextualTemplateSuggestions(available, query);
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, matches.length - 1)));
    clear(panel);
    panel.appendChild(h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:7px 8px 8px' },
      h('div', {},
        h('div', { style: 'font-size:11.5px;font-weight:700;color:#e8e2d7' }, inline ? 'Complete variable' : 'Template variables'),
        h('div', { style: 'margin-top:2px;font-size:10.5px;line-height:1.35;color:#746d62' }, mode === 'auto'
          ? (inline ? 'Enter to complete · ↑↓ to choose · Esc to dismiss' : `Matching {{${query || ''}`)
          : 'Choose a value to insert')),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#6f685e;white-space:nowrap" }, inline ? 'IDE assist' : '⌘/Ctrl Space')));
    if (!matches.length) {
      panel.appendChild(h('div', { style: 'padding:12px 9px 10px;font-size:11.5px;color:#746d62' }, 'No matching variable'));
    } else {
      let group = null;
      matches.forEach((suggestion, index) => {
        if (suggestion.group !== group) {
          group = suggestion.group;
          panel.appendChild(h('div', { style: 'margin:7px 8px 4px;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#655e54' }, group || 'Variables'));
        }
        panel.appendChild(templatePanelRow(suggestion, index === selectedIndex, apply));
      });
    }
    const dynamicHint = templateDynamicHint(available);
    if (dynamicHint) {
      panel.appendChild(h('div', { style: 'margin:8px 8px 4px;padding-top:8px;border-top:1px solid #2c271f;font-size:10.5px;line-height:1.4;color:#746d62' },
        h('span', { style: 'font-weight:700;color:#9c927f' }, 'Tip · '), dynamicHint));
    }
    if (layer) layer.position();
  };
  const open = (nextMode = 'manual', query = '') => {
    if (!panel) {
      closeFloatingPanels();
      mode = nextMode;
      setTriggerLayer(true);
      panel = h('div', { role: 'listbox', 'aria-label': 'Template variables', 'data-sd-template-inline': inline ? 'true' : 'false', style: `z-index:${floatingZIndex + 1};background:#211d17;border-radius:var(--radius-sm);padding:5px;box-shadow:0 18px 42px rgba(0,0,0,.58);animation:sd-in .12s ease;overflow-y:auto;box-sizing:border-box;${inline ? 'border:1px solid rgba(232,184,138,.26)' : ''}` });
      layer = mountFloatingPanel(panelAnchor, panel, {
        maxHeight: inline ? 260 : 330,
        minHeight: 72,
        preferredWidth: inline ? 340 : undefined,
        minWidth: inline ? 270 : undefined,
        zIndex: floatingZIndex,
        onDismiss: close,
        onClosed: layerClosed,
      });
    } else mode = nextMode;
    renderPanel(query);
  };
  const refreshFromCaret = () => {
    const active = activeTemplateAt(control.value, control.selectionStart);
    if (active) {
      selectedIndex = 0;
      open('auto', active.query);
    } else if (mode === 'auto') close();
  };

  control.addEventListener('input', refreshFromCaret);
  if (inline) {
    const navigationKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
    control.addEventListener('focus', refreshFromCaret);
    control.addEventListener('click', refreshFromCaret);
    control.addEventListener('keyup', (event) => {
      if (!navigationKeys.has(event.key) || (panel && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) return;
      refreshFromCaret();
    });
    control.addEventListener('scroll', () => { if (layer) layer.position(); });
  }
  control.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.code === 'Space') {
      event.preventDefault();
      selectedIndex = 0;
      open('manual');
      return;
    }
    if (!panel) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!matches.length) return;
      selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      const active = activeTemplateAt(control.value, control.selectionStart);
      renderPanel(active ? active.query : '');
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      if (!matches.length) return;
      event.preventDefault();
      apply(matches[selectedIndex]);
    }
  });
  control.addEventListener('blur', () => {
    setTimeout(() => {
      const doc = control.ownerDocument || document;
      if (panel && doc.activeElement !== control) close();
    }, 0);
  });
  if (opts.trigger) opts.trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    selectedIndex = 0;
    if (panel) close(); else open('manual');
  });
  return { open, close };
}

// A compact text-field variant used for templated URLs and other single-line
// fields. The visible { } affordance and Ctrl/⌘+Space use the same picker as
// code editors, including viewport-aware portal placement.
export function templateInput(value, placeholder, onInput, opts = {}) {
  const suggestions = Array.isArray(opts.templateSuggestions) ? opts.templateSuggestions : [];
  const wrap = h('div', { style: 'position:relative;min-width:0' });
  const control = h('input', {
    value: value == null ? '' : value, placeholder, type: opts.type || 'text',
    style: `${opts.style || ''}${suggestions.length ? ';padding-right:38px' : ''}${opts.color ? `;color:${opts.color}` : ''}`,
    oninput: (event) => onInput(event.target.value),
  });
  wrap.appendChild(control);
  if (suggestions.length) {
    const trigger = templateTrigger('', true);
    trigger.style.position = 'absolute';
    trigger.style.right = '8px';
    trigger.style.top = '50%';
    trigger.style.transform = 'translateY(-50%)';
    wrap.appendChild(trigger);
    attachTemplateAssist(control, suggestions, { anchor: control, trigger });
  }
  return wrap;
}

export function templateSuggestionsFor(app, context) {
  return app && typeof app.templateSuggestions === 'function' ? app.templateSuggestions(context) : [];
}

// Only one select's panel is open at a time. The state stays inside this
// module so opening and closing a choice never asks the application to render.
let openSelectClose = null;

export function select(opts) {
  const mono = opts.mono ? "font-family:'IBM Plex Mono',monospace;font-weight:600;" : '';
  let currentValue = opts.value;
  const selectedOption = () => opts.options.find((option) => option.value === currentValue) || {};
  const initial = selectedOption();
  const chev = raw(icons.chevDown({ w: 15, stroke: '#8a837a', sw: 1.8, style: 'flex-shrink:0;transition:transform .16s;transform:rotate(0deg)' }));
  const label = h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, initial.label != null ? initial.label : (opts.placeholder || 'Select'));
  const btnStyle = `width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#17140e;border-radius:var(--radius-sm);padding:10px 13px;font-size:13.5px;text-align:left;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:${initial.color || '#e8e2d7'};${mono}`;
  const wrap = h('div', { style: `${opts.width ? `width:${opts.width};` : ''}` });
  let panel = null;
  let layer = null;
  let btn = null;

  function syncButton() {
    const option = selectedOption();
    label.textContent = option.label != null ? option.label : (opts.placeholder || 'Select');
    btn.style.color = option.color || '#e8e2d7';
  }
  function close() {
    if (!panel) return;
    panel = null;
    if (layer) { const activeLayer = layer; layer = null; activeLayer.close(); }
    chev.style.transform = 'rotate(0deg)';
    btn.setAttribute('aria-expanded', 'false');
    if (openSelectClose === close) openSelectClose = null;
  }
  function layerClosed() {
    if (!panel) return;
    panel = null;
    layer = null;
    chev.style.transform = 'rotate(0deg)';
    btn.setAttribute('aria-expanded', 'false');
    if (openSelectClose === close) openSelectClose = null;
  }
  function open() {
    if (openSelectClose) openSelectClose();
    closeFloatingPanels();
    panel = h('div', { role: 'listbox', style: `z-index:81;background:#211d17;border-radius:var(--radius-sm);padding:5px;box-shadow:0 16px 38px rgba(0,0,0,0.55);animation:sd-in .12s ease;overflow-y:auto;box-sizing:border-box` });
    for (const option of opts.options) {
      const selected = option.value === currentValue;
      const rowColor = option.color || (selected ? '#f2ede3' : '#cfc8bc');
      const row = h('button', {
        type: 'button', role: 'option', 'aria-selected': selected ? 'true' : 'false',
        style: `width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-radius:var(--radius-xs);cursor:pointer;text-align:left;font-size:13px;background:${selected ? '#282219' : 'transparent'};color:${rowColor};${mono}`,
        onclick: (event) => {
          event.stopPropagation();
          if (option.value === currentValue) { close(); return; }
          currentValue = option.value;
          syncButton();
          close();
          if (opts.onPick) opts.onPick(option.value);
        },
      }, h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, option.label), selected ? raw(icons.check({ w: 14, stroke: '#238636', sw: 2.2 })) : null);
      row.addEventListener('mouseenter', () => { if (!selected) row.style.background = '#2f2921'; });
      row.addEventListener('mouseleave', () => { if (!selected) row.style.background = 'transparent'; });
      panel.appendChild(row);
    }
    layer = mountFloatingPanel(btn, panel, { maxHeight: 280, onDismiss: close, onClosed: layerClosed });
    chev.style.transform = 'rotate(180deg)';
    btn.setAttribute('aria-expanded', 'true');
    openSelectClose = close;
  }

  btn = h('button', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', style: btnStyle, onclick: (event) => { event.stopPropagation(); if (panel) close(); else open(); } }, label, chev);
  wrap.appendChild(btn);
  return wrap;
}

// segmented control: { value, options:[{value,label}], onPick }
export function segment(opts) {
  const box = h('div', { style: 'display:flex;gap:3px;background:#141210;border-radius:var(--radius-sm);padding:3px' });
  for (const o of opts.options) {
    const sel = o.value === opts.value;
    box.appendChild(h('button', {
      style: `flex:1;padding:8px 6px;border-radius:var(--radius-xs);font-size:12.5px;font-weight:600;cursor:pointer;text-align:center;transition:background .12s;background:${sel ? '#2f2820' : 'transparent'};color:${sel ? '#edecec' : '#8a837a'};box-shadow:${sel ? 'inset 0 0 0 1px rgba(245,240,230,0.07)' : 'none'}`,
      onclick: () => opts.onPick(o.value),
    }, o.label));
  }
  return box;
}

// toggle switch
export function toggle(on, onClick) {
  const track = h('button', {
    style: `position:relative;width:46px;height:26px;border-radius:20px;padding:0;flex-shrink:0;cursor:pointer;transition:background .16s;background:${on ? '#238636' : 'rgba(245,240,230,0.13)'}`,
    onclick: onClick,
  }, h('span', { style: `position:absolute;top:3px;left:${on ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .16s` }));
  return track;
}

// Small inline area+line sparkline (SVG string, use with raw()). Deliberately
// monochrome by default — this app's colors (green/amber/red) already carry
// meaning elsewhere (webhook/mock/error), so a colorful sparkline here would
// read as a status signal it isn't.
export function sparkline(values, opts = {}) {
  const w = opts.w || 280, h = opts.h || 56;
  const stroke = opts.stroke || '#a39c90';
  const fill = opts.fill || 'rgba(163,156,144,0.14)';
  const vals = values && values.length ? values : [0];
  const max = Math.max(1, ...vals);
  const n = vals.length;
  const stepX = n > 1 ? w / (n - 1) : 0;
  const pad = 3;
  const pts = vals.map((v, i) => [n > 1 ? i * stepX : w / 2, pad + (h - pad * 2) * (1 - Math.min(1, v / max))]);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;width:100%;height:${h}px">` +
    `<path d="${area}" fill="${fill}" stroke="none"/>` +
    (n > 1 ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>` : '') +
    `</svg>`;
}

// Reused code editor wrapper. The legacy custom-element name remains stable
// while its language attribute drives highlighting, validation and formatting.
export function codeEditor(value, rows, onInput, opts = {}) {
  const el = document.createElement('sd-json-editor');
  el.setAttribute('rows', String(rows || 6));
  el.setAttribute('language', opts.language || 'json');
  el.setAttribute('value', value == null ? '' : String(value));
  if (opts.validation) el.externalValidation = opts.validation;
  if (Array.isArray(opts.templateSuggestions) && opts.templateSuggestions.length) {
    el.templateSuggestions = opts.templateSuggestions;
    el.addEventListener('sd-editor-ready', () => {
      const control = typeof el.getInputElement === 'function' ? el.getInputElement() : null;
      if (control) attachTemplateAssist(control, opts.templateSuggestions, { anchor: el._wrap || control, trigger: el.templateButton, inline: true });
    }, { once: true });
  }
  if (onInput) el.addEventListener('input', (e) => onInput(e.target.value, el));
  return el;
}

export function jsonEditor(value, rows, onInput, opts = {}) {
  return codeEditor(value, rows, onInput, { ...opts, language: 'json' });
}

// Attach a background hover swap to a node.
export function hover(node, hoverBg, baseBg = 'transparent', hoverColor, baseColor) {
  node.addEventListener('mouseenter', () => { node.style.background = hoverBg; if (hoverColor) node.style.color = hoverColor; });
  node.addEventListener('mouseleave', () => { node.style.background = baseBg; if (baseColor) node.style.color = baseColor; });
  return node;
}
