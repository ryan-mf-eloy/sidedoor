// Workspace create/edit modal + delete-confirmation modal.
import { h, raw, icons, wsIconSvg, WS_ICON_PATHS, WS_COLORS } from '../ui.js';

function scrim(onClose, ...kids) {
  const overlay = h('div', { style: 'position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,7,5,0.64);backdrop-filter:blur(4px);animation:sd-scrim .16s ease', onclick: onClose });
  const stop = (e) => e.stopPropagation();
  const card = h('div', { onclick: stop, style: 'width:452px;max-width:100%;background:#17140f;border-radius:var(--radius-lg);box-shadow:0 44px 120px rgba(0,0,0,0.74),inset 0 0 0 1px rgba(245,240,230,0.08);padding:24px 26px 26px;animation:sd-pop .2s cubic-bezier(.22,.9,.32,1.16)' }, ...kids);
  overlay.appendChild(card);
  return overlay;
}

export function workspaceEditor(app) {
  const e = app.s.wsEditor;
  if (!e) return h('div', {});
  const title = e.mode === 'create' ? 'New workspace' : 'Edit workspace';
  const cta = e.mode === 'create' ? 'Create workspace' : 'Save changes';

  const nameInput = h('input', {
    value: e.name, placeholder: 'Workspace name',
    style: 'width:100%;background:#0f0d0a;border-radius:var(--radius-sm);padding:11px 13px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.12);color:#e8e2d7;font-size:14px',
    oninput: (ev) => { e.name = ev.target.value; },
    onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); app.saveWsEditor(); } },
  });

  const iconGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:8px' },
    ...Object.keys(WS_ICON_PATHS).map((k) => {
      const sel = e.icon === k;
      return h('button', { style: `display:flex;align-items:center;justify-content:center;height:38px;border-radius:var(--radius-sm);cursor:pointer;background:${sel ? '#312a20' : '#211d17'};box-shadow:inset 0 0 0 ${sel ? '1.5px #efe4d0' : '1px rgba(245,240,230,0.08)'};color:${sel ? '#f2ede3' : '#9a9186'}`, onclick: () => app.setWsField('icon', k) }, raw(wsIconSvg(k, { w: 19, stroke: 'currentColor' })));
    }));

  const colorGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:8px' },
    ...WS_COLORS.map((c) => {
      const sel = e.color === c;
      return h('button', { style: `display:flex;align-items:center;justify-content:center;height:30px;border-radius:var(--radius-sm);cursor:pointer;background:${c};box-shadow:${sel ? '0 0 0 2px #1a1712,0 0 0 3.6px ' + c : 'inset 0 0 0 1px rgba(0,0,0,0.18)'}`, onclick: () => app.setWsField('color', c) }, sel ? raw(icons.check({ w: 15, stroke: '#1a0e07', sw: 2.6 })) : null);
    }));

  return scrim(app.cancelWsEditor,
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:21px' },
      h('span', { style: `width:30px;height:30px;border-radius:var(--radius-sm);background:${e.color};display:flex;align-items:center;justify-content:center;flex-shrink:0` }, raw(wsIconSvg(e.icon, { w: 20 }))),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, title), h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, 'Name it, pick an icon and a color')),
      h('button', { title: 'Close', style: 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:transparent;color:#6a655c;cursor:pointer;flex-shrink:0', onclick: app.cancelWsEditor }, raw(icons.x({ w: 16, sw: 1.9 })))),
    h('div', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#5c574e;margin:0 2px 8px' }, 'Name'),
    nameInput,
    h('div', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#5c574e;margin:17px 2px 9px' }, 'Icon'), iconGrid,
    h('div', { style: 'font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#5c574e;margin:18px 2px 9px' }, 'Color'), colorGrid,
    h('div', { style: 'display:flex;gap:9px;margin-top:23px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;background:#edecec;color:#1a0e07;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.saveWsEditor }, cta),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelWsEditor }, 'Cancel')));
}

export function workspaceDeleteConfirm(app) {
  const t = app.s.wsConfirmDelete;
  if (!t) return h('div', {});
  const overlay = h('div', { style: 'position:fixed;inset:0;z-index:92;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,7,5,0.64);backdrop-filter:blur(4px);animation:sd-scrim .16s ease', onclick: app.cancelDeleteWs });
  const card = h('div', { onclick: (e) => e.stopPropagation(), style: 'width:404px;max-width:100%;background:#17140f;border-radius:var(--radius-lg);box-shadow:0 44px 120px rgba(0,0,0,0.74),inset 0 0 0 1px rgba(245,240,230,0.08);padding:24px 26px 24px;animation:sd-pop .2s cubic-bezier(.22,.9,.32,1.16)' },
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:15px' },
      h('span', { style: 'width:40px;height:40px;border-radius:var(--radius-md);background:rgba(207,139,127,0.14);display:flex;align-items:center;justify-content:center;flex-shrink:0' }, raw(icons.trash({ w: 20, stroke: '#e08b7f', sw: 1.9 }))),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font-size:16.5px;font-weight:600;color:#f4efe6;letter-spacing:-0.01em' }, 'Delete workspace?'), h('div', { style: 'font-size:12px;color:#7a746a;margin-top:2px' }, "This can't be undone"))),
    h('div', { style: 'font-size:13.5px;line-height:1.5;color:#b8b0a4;padding:2px 1px 0' }, "You're about to delete ", h('span', { style: 'color:#f2ede3;font-weight:600' }, t.name), ' and everything scoped to it — its endpoints, mocks and settings will be permanently removed.'),
    h('div', { style: 'display:flex;gap:9px;margin-top:22px' },
      h('button', { style: 'flex:1;display:flex;align-items:center;justify-content:center;gap:7px;background:#c8574a;color:#fdeeec;border-radius:var(--radius-sm);padding:11px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.confirmDeleteWs }, raw(icons.trash({ w: 15, sw: 1.9 })), 'Delete workspace'),
      h('button', { style: 'display:flex;align-items:center;justify-content:center;background:#211d17;color:#a49c91;border-radius:var(--radius-sm);padding:11px 18px;font-size:13.5px;font-weight:600;cursor:pointer', onclick: app.cancelDeleteWs }, 'Cancel')));
  overlay.appendChild(card);
  return overlay;
}
