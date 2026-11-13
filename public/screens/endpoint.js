// Edit + delete modals for webhooks and mock servers, styled to match the
// workspace editor / delete-confirm modals in the design system. Also
// exports the shared modal-shell primitives (scrim/label/input/errline) so
// other entities (e.g. projects, in screens/lists.js) get the same look
// without duplicating them.
import { h, raw, icons, select, slugify, methodColor } from '../ui.js';
import { projectPicker } from './forms.js';

const METHOD_OPTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'QUERY'].map((m) => ({ value: m, label: m, color: methodColor(m) }));

export function scrim(z, width, onClose, ...kids) {
  const overlay = h('div', { style: `position:fixed;inset:0;z-index:${z};display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,7,5,0.64);backdrop-filter:blur(4px);animation:sd-scrim .16s ease`, onclick: onClose });
  overlay.appendChild(h('div', { onclick: (e) => e.stopPropagation(), style: `width:${width}px;max-width:100%;background:#17140f;border-radius:var(--radius-lg);box-shadow:0 44px 120px rgba(0,0,0,0.74),inset 0 0 0 1px rgba(245,240,230,0.08);padding:24px 26px 26px;animation:sd-pop .2s cubic-bezier(.22,.9,.32,1.16)` }, ...kids));
  return overlay;
}
export const label = (t) => h('div', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#5c574e;margin:0 2px 8px' }, t);
export function input(value, ph, onInput, err, opts = {}) {
  return h('input', { value, placeholder: ph, style: `width:100%;background:#0f0d0a;border-radius:var(--radius-sm);padding:11px 13px;box-shadow:inset 0 0 0 1px ${err ? '#8a4a42' : 'rgba(245,240,230,0.12)'};color:#e8e2d7;font-size:14px;${opts.mono ? "font-family:'IBM Plex Mono',monospace;font-size:13px;" : ''}`, oninput: (e) => onInput(e.target.value) });
}
export function errline(msg) { return msg ? h('div', { style: 'display:flex;align-items:center;gap:5px;margin-top:7px;font-size:11.5px;color:#cf8b7f' }, raw(icons.circleInfo({ w: 13, sw: 2 })), msg) : null; }

export function endpointEditor(app) {
  const e = app.s.epEditor;
  if (!e) return h('div', {});
  const isRealtime = (e.protocol || 'http') !== 'http';
  const isMock = e.type === 'mock' && !isRealtime;
  const protocolLabel = e.protocol === 'graphql' ? 'GraphQL endpoint' : e.protocol === 'socketio' ? 'Socket.IO endpoint' : e.protocol === 'websocket' ? 'WebSocket endpoint' : null;
  const err = e.error || {};

  const fields = [
    h('div', {}, label('Name'), input(e.name, isMock ? 'e.g. Payments API' : 'e.g. Stripe Webhooks', (v) => { e.name = v; }, err.name), errline(err.name)),
    h('div', { style: 'margin-top:15px' }, label('Project'), projectPicker(app, { id: 'ep-edit-project', value: e.projectName, onPick: (name) => { e.projectName = name; }, onClear: () => { e.projectName = ''; } })),
  ];
  if (isMock) {
    fields.push(h('div', { style: 'margin-top:15px;display:grid;grid-template-columns:130px 1fr;gap:12px' },
      h('div', {}, label('Method'), select(app.selectHelper('ep-edit-method', e.method, METHOD_OPTS, (v) => { e.method = v; }, { mono: true }))),
      h('div', {}, label('Path'), input(e.path, '/v1/charges', (v) => { e.path = v; }, err.path, { mono: true }))));
    if (err.path) fields.push(errline(err.path));
  } else {
    fields.push(h('div', { style: 'margin-top:15px' }, label('Slug'), input(e.slug, 'stripe-prod', (v) => { e.slug = slugify(v); const el = document.getElementById('ep-edit-slug-preview'); if (el) el.textContent = `${(app.s.baseUrls.local || '')}/${e.slug || 'your-slug'}`; }, err.slug, { mono: true }), errline(err.slug),
      h('div', { id: 'ep-edit-slug-preview', style: "margin-top:8px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#8a837a" }, `${(app.s.baseUrls.local || '')}/${e.slug || 'your-slug'}`)));
    if (!isRealtime) fields.push(h('div', { style: 'margin-top:15px' }, label('Forward target (optional)'), input(e.forwardTarget, 'http://localhost:3000/webhook', (v) => { e.forwardTarget = v; }, null, { mono: true }),
      h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:8px' }, 'Where "Forward to local" rules relay requests.')));
  }

  return scrim(90, 452, app.cancelEpEditor,
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:20px' },
      h('span', { style: `width:34px;height:34px;border-radius:var(--radius-sm);background:#221d17;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${isMock ? '#d69a3c' : isRealtime ? '#b28de0' : '#238636'}` }, raw((isMock ? icons.mock : icons.webhook)({ w: 18 }))),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, isMock ? 'Edit mock server' : isRealtime ? `Edit ${protocolLabel}` : 'Edit webhook'), h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, 'Update its details')),
      h('button', { title: 'Close', style: 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:transparent;color:#6a655c;cursor:pointer;flex-shrink:0', onclick: app.cancelEpEditor }, raw(icons.x({ w: 16, sw: 1.9 })))),
    ...fields,
    h('div', { style: 'display:flex;gap:9px;margin-top:23px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;background:#edecec;color:#1a0e07;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.saveEpEditor }, 'Save changes'),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelEpEditor }, 'Cancel')));
}

export function endpointDeleteConfirm(app) {
  const t = app.s.epConfirmDelete;
  if (!t) return h('div', {});
  const isRealtime = (t.protocol || 'http') !== 'http';
  const isMock = t.type === 'mock' && !isRealtime;
  const noun = isRealtime ? (t.protocol === 'graphql' ? 'GraphQL endpoint' : 'realtime endpoint') : isMock ? 'mock server' : 'webhook';
  return scrim(92, 404, app.cancelDeleteEp,
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:15px' },
      h('span', { style: 'width:40px;height:40px;border-radius:var(--radius-md);background:rgba(207,139,127,0.14);display:flex;align-items:center;justify-content:center;flex-shrink:0' }, raw(icons.trash({ w: 20, stroke: '#e08b7f', sw: 1.9 }))),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, `Delete ${noun}?`), h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, "This can't be undone"))),
    h('div', { style: 'font-size:13.5px;line-height:1.5;color:#b8b0a4;padding:2px 1px 0' }, "You're about to delete ", h('span', { style: 'color:#f2ede3;font-weight:600' }, t.name), isRealtime ? ' and all of its schemas, scripts, fixtures and session history.' : isMock ? ' and all of its scenarios, rules and captured requests.' : ' and all of its captured requests and settings.'),
    h('div', { style: 'display:flex;gap:9px;margin-top:22px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;gap:7px;background:#c8574a;color:#fdeeec;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.confirmDeleteEp }, raw(icons.trash({ w: 15, sw: 1.9 })), isRealtime ? 'Delete endpoint' : isMock ? 'Delete mock' : 'Delete webhook'),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelDeleteEp }, 'Cancel')));
}

// Shared menu items for the "⋯" overflow menu on cards and detail headers.
export function endpointMenuItems(app, ep) {
  return [
    { label: 'Edit details', icon: icons.edit, onClick: () => app.openEpEditor(ep) },
    { label: 'Delete', icon: icons.trash, danger: true, onClick: () => app.askDeleteEp(ep) },
  ];
}
