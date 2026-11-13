// Webhook inspector (live feed), request detail, and diff.
import { h, raw, codeBlock, icons, kebabMenu, fmtClock, fmtStamp, fmtBytes, methodColor, statusColor } from '../ui.js';
import { endpointMenuItems } from './endpoint.js';

const METHODS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'];

function iconBtn(app, iconFn, label, onClick, opts = {}) {
  const b = h('button', { title: label, style: `display:flex;align-items:center;gap:7px;background:${opts.bg || '#211d17'};color:${opts.color || '#a49c91'};border-radius:var(--radius-xs);padding:8px 12px;font-size:12.5px;font-weight:600`, onclick: onClick },
    iconFn ? raw(iconFn({ w: 14, sw: 1.8 })) : null, opts.hideLabel ? null : label);
  b.addEventListener('mouseenter', () => { b.style.background = opts.hoverBg || '#282219'; });
  b.addEventListener('mouseleave', () => { b.style.background = opts.bg || '#211d17'; });
  return b;
}

export function inspectorScreen(app) {
  const s = app.s, ep = s.activeEp;
  if (!ep) return h('div', {});
  const now = Date.now();
  const recentCount = s.feed.filter((r) => now - r.receivedAt < 60000).length;

  const back = h('button', { style: 'background:#191712;border-radius:var(--radius-xs);width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:#948d83;flex-shrink:0', onclick: app.navWebhooks }, raw(icons.chevLeft({ w: 16, sw: 1.9 })));

  const compareBtn = h('button', { style: `display:flex;align-items:center;gap:7px;border-radius:var(--radius-xs);padding:8px 12px;font-size:12.5px;font-weight:600;background:${s.compareMode ? '#2a2119' : '#211d17'};color:${s.compareMode ? '#e8b88a' : '#a49c91'}`, onclick: app.toggleCompare },
    raw(icons.compare({ w: 14, sw: 1.8 })), s.compareMode ? `Comparing ${s.selected.length}/2` : 'Compare');
  const diffBtn = s.compareMode ? h('button', { style: `border-radius:var(--radius-xs);padding:8px 13px;font-size:12.5px;font-weight:600;background:${s.selected.length === 2 ? '#edecec' : '#211d17'};color:${s.selected.length === 2 ? '#1a0e07' : '#57524a'}`, onclick: app.startDiff }, 'View diff →') : null;

  const urlChip = (labelText, labelColor, url, key, primary) => h('div', { style: 'display:flex;align-items:center;gap:8px;background:#141210;border-radius:var(--radius-xs);padding:7px 8px 7px 11px' },
    h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:0.06em;color:${labelColor}` }, labelText),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#b3aca1" }, url.replace(/^https?:\/\//, '')),
    h('button', { style: `background:${primary ? '#edecec' : '#211d17'};color:${primary ? '#1a0e07' : '#a49c91'};border-radius:var(--radius-xs);padding:4px 10px;font-size:11px;font-weight:${primary ? 700 : 600}`, onclick: () => app.copy(url, key) }, s.copied === key ? 'Copied' : 'Copy'));

  const signedBadge = ep.signed
    ? h('span', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:#7fc79b;background:#141712;border-radius:var(--radius-xs);padding:6px 10px' }, raw(icons.shield({ w: 13, sw: 2 })), 'Signed · ' + (ep.config.hmac.provider || 'custom'))
    : h('span', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;color:#d69a3c;background:#1a1610;border-radius:var(--radius-xs);padding:6px 10px' }, raw(icons.warning({ w: 13, sw: 2 })), 'Unsigned');

  const methodChips = h('div', { style: 'display:flex;gap:5px' }, ...METHODS.map((m) => {
    const sel = s.feedFilter.method === m;
    return h('button', { style: `font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;border-radius:var(--radius-xs);padding:5px 9px;background:${sel ? '#2a2119' : '#191712'};color:${sel ? '#e8b88a' : '#7a746a'}`, onclick: () => app.setMethodFilter(m) }, m);
  }));

  const header = h('div', { style: 'padding:20px 28px 15px 28px;flex-shrink:0' },
    h('div', { style: 'display:flex;align-items:center;gap:13px;margin-bottom:14px' }, back,
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:10px' },
          h('span', { style: 'font-size:19px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, ep.name),
          h('span', { style: "display:flex;align-items:center;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:600;letter-spacing:0.08em;color:#238636" },
            h('span', { style: 'width:6px;height:6px;border-radius:50%;background:#238636;animation:sd-pulse 1.5s infinite' }), `LIVE · ${recentCount}/min`)),
        h('div', { style: 'font-size:12.5px;color:#7a746a;margin-top:2px' }, 'Webhook Inspector · every request is captured & kept')),
      h('div', { style: 'display:flex;align-items:center;gap:8px;flex-shrink:0' }, compareBtn, diffBtn,
        iconBtn(app, icons.download, 'Export', () => app.exportEndpoint(ep.id)),
        iconBtn(app, icons.gear, 'Endpoint settings', app.navSettings, { hideLabel: true }),
        kebabMenu({ open: app.s.dropdown === 'epmenu-' + ep.id, onToggle: () => app.setDropdown('epmenu-' + ep.id), onClose: () => app.closeDropdown(), items: endpointMenuItems(app, ep), size: 33, bg: '#211d17', hoverBg: '#282219' }))),
    h('div', { style: 'display:flex;align-items:center;gap:9px;flex-wrap:wrap' },
      urlChip('LOCAL', '#57524a', ep.urls.local, 'ins-local'),
      ep.urls.public ? urlChip('PUBLIC · FUNNEL', '#f5602a', ep.urls.public, 'ins-public', true) : null,
      signedBadge));

  const filterBar = h('div', { style: 'display:flex;align-items:center;gap:11px;padding:10px 28px;flex-shrink:0' },
    h('div', { style: 'display:flex;align-items:center;gap:8px;flex:1;max-width:400px;background:#191712;border-radius:var(--radius-xs);padding:7px 12px' },
      raw(icons.search({ w: 15, stroke: '#57524a' })),
      h('input', { value: s.feedFilter.search, placeholder: 'Filter by header, body, method…', style: 'flex:1;background:transparent;border:none;color:#e8e2d7;font-size:13px', oninput: (e) => app.setFeedSearch(e.target.value) })),
    methodChips,
    h('span', { style: "margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#57524a" }, `${s.feed.length}`));

  // feed
  const feedScroll = h('div', { id: 'feed-scroll', style: 'flex:1;min-height:0;overflow-y:auto' });
  if (s.feed.length === 0) {
    feedScroll.appendChild(h('div', { style: 'height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;padding:40px;text-align:center' },
      h('span', { style: 'width:11px;height:11px;border-radius:50%;background:#238636;box-shadow:0 0 0 6px rgba(35,134,54,0.12);animation:sd-pulse 1.8s infinite' }),
      h('div', { style: 'font-size:14.5px;font-weight:600;color:#c9c2b6' }, 'Listening for requests…'),
      h('div', { style: 'font-size:12.5px;color:#7a746a;max-width:320px' }, `Point a provider at ${ep.urls.public ? 'the public URL' : ep.urls.local} above. Requests stream in here live.`)));
  } else {
    for (const r of s.feed) feedScroll.appendChild(feedRow(app, r));
  }

  const feedPane = h('div', { style: 'display:flex;flex-direction:column;min-height:0;background:#141210;border-radius:var(--radius-sm);overflow:hidden' },
    h('div', { style: "display:grid;grid-template-columns:24px 100px 52px 1fr 42px 58px;gap:11px;padding:9px 16px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:0.06em;color:#4c473f;flex-shrink:0" },
      h('span', {}), h('span', {}, 'TIME'), h('span', {}, 'METHOD'), h('span', {}, 'EVENT'), h('span', {}, 'ST'), h('span', { style: 'text-align:right' }, 'SIZE')),
    feedScroll,
    h('div', { style: "display:flex;align-items:center;gap:8px;padding:8px 16px;flex-shrink:0;font-family:'IBM Plex Mono',monospace;font-size:10px;color:#4c473f" },
      h('span', { style: 'width:5px;height:5px;border-radius:50%;background:#238636;animation:sd-pulse 1.5s infinite' }), 'tailing live · newest at bottom'));

  const preview = previewPane(app);

  return h('div', { style: 'height:100%;display:flex;flex-direction:column;overflow:hidden' }, header, filterBar,
    h('div', { style: 'flex:1;min-height:0;display:grid;grid-template-columns:1.1fr 0.9fr;gap:14px;padding:0 28px 20px 28px' }, feedPane, preview));
}

function feedRow(app, r) {
  const s = app.s;
  const selIdx = s.selected.indexOf(r.id);
  const isPreview = s.previewReqId === r.id && !s.compareMode;
  const row = h('div', {
    style: `display:grid;grid-template-columns:24px 100px 52px 1fr 42px 58px;gap:11px;align-items:center;padding:9px 16px;cursor:pointer;background:${isPreview ? '#1c1913' : 'transparent'}`,
    onclick: () => (s.compareMode ? app.toggleSelect(r.id) : app.selectPreview(r.id)),
  },
    h('div', { style: 'display:flex;align-items:center;justify-content:center' },
      s.compareMode
        ? h('span', { style: `width:18px;height:18px;border-radius:var(--radius-xs);display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;background:${selIdx >= 0 ? '#238636' : '#211d17'};color:${selIdx >= 0 ? '#0d1f14' : '#57524a'};box-shadow:${selIdx >= 0 ? 'none' : 'inset 0 0 0 1px rgba(245,240,230,0.12)'}` }, selIdx >= 0 ? String(selIdx + 1) : '')
        : h('span', { style: `width:6px;height:6px;border-radius:50%;background:${methodColor(r.method)}` })),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7a746a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, fmtClock(r.receivedAt)),
    h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;color:${methodColor(r.method)}` }, r.method),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#d3ccc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, r.event || r.path),
    h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:${statusColor(r.status)}` }, String(r.status)),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6a655c;text-align:right" }, fmtBytes(r.size)));
  row.addEventListener('mouseenter', () => { row.style.background = '#1c1913'; });
  row.addEventListener('mouseleave', () => { row.style.background = isPreview ? '#1c1913' : 'transparent'; });
  return row;
}

function previewPane(app) {
  const s = app.s;
  const r = s.feed.find((x) => x.id === s.previewReqId);
  const wrap = h('div', { style: 'min-height:0;overflow-y:auto;background:#191712;border-radius:var(--radius-sm)' });
  if (!r) {
    wrap.appendChild(h('div', { style: 'height:100%;display:flex;align-items:center;justify-content:center;padding:40px;text-align:center;font-size:13px;color:#6a655c' }, 'Select a request to preview it.'));
    return wrap;
  }
  const metaCard = (label, value) => h('div', { style: 'background:#0f0e0b;border-radius:var(--radius-xs);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.05)' },
    h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:3px' }, label), h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#b3aca1;overflow-wrap:anywhere" }, value));
  wrap.appendChild(h('div', { style: 'padding:18px 20px 32px 20px' },
    h('div', { style: 'display:flex;align-items:center;gap:9px;margin-bottom:6px' },
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${methodColor(r.method)}` }, r.method),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:13px;color:#e8e2d7" }, r.path),
      h('span', { style: `margin-left:auto;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${statusColor(r.status)}` }, String(r.status))),
    h('div', { style: 'font-size:15px;font-weight:600;color:#f2ede3;margin-bottom:15px' }, r.event || 'Request'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:15px' },
      metaCard('Received', fmtStamp(r.receivedAt)), metaCard('Source IP', r.ip || '—'),
      metaCard('Size', fmtBytes(r.size)), metaCard('Content-Type', r.contentType || '—')),
    h('button', { style: 'display:flex;align-items:center;gap:6px;background:#211d17;color:#d9d3c7;border-radius:var(--radius-xs);padding:8px 12px;font-size:12px;font-weight:600;margin-bottom:14px', onclick: () => app.openRequest(r.id, r.endpointId) }, 'Open full detail', raw(icons.chevRight({ w: 13, sw: 2 }))),
    r.body ? codeBlock(r.body, { label: 'Payload', style: "margin:0;background:#141210;border-radius:var(--radius-sm);padding:14px 16px;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.6;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" }) : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:20px;text-align:center;font-size:12.5px;color:#7a746a' }, 'No body')));
  return wrap;
}

// ---------------- request detail ----------------
export function requestScreen(app) {
  const s = app.s, r = s.activeReq;
  if (!r) return h('div', {});
  const headersArr = Object.entries(r.headers || {});
  const queryArr = Object.entries(r.query || {});
  const tab = (id, label) => h('button', { style: `background:transparent;padding:0 0 12px 0;font-size:13px;font-weight:600;color:${s.detailTab === id ? '#f2ede3' : '#7a746a'};box-shadow:${s.detailTab === id ? 'inset 0 -2px 0 #edecec' : 'none'}`, onclick: () => app.setDetailTab(id) }, label);

  const replayPanel = s.replayOpen ? h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px;margin-bottom:20px;animation:sd-in .14s ease' },
    h('div', { style: 'font-size:12px;color:#8a837a;margin-bottom:9px' }, 'Replay this payload to a target URL'),
    h('div', { style: 'display:flex;gap:9px' },
      h('input', { value: s.replayTarget, placeholder: s.activeEp && s.activeEp.forward_target || s.activeEp && s.activeEp.urls.local || 'http://localhost:3000/webhook', style: "flex:1;background:#0f0e0b;border-radius:var(--radius-xs);padding:9px 12px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.05);font-family:'IBM Plex Mono',monospace;font-size:12px;color:#e8e2d7", oninput: (e) => app.setReplayTarget(e.target.value) }),
      h('button', { style: 'background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 18px;font-size:13px;font-weight:700', onclick: app.doReplay }, 'Send replay')),
    s.replayResult ? h('div', { style: 'margin-top:12px' }, replayResultView(s.replayResult)) : null) : null;

  const meta = (label, value) => h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:13px 15px' },
    h('div', { style: 'font-size:10.5px;color:#6a655c;margin-bottom:5px' }, label), h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#d3ccc0;overflow-wrap:anywhere" }, value));

  let tabContent;
  if (s.detailTab === 'headers') tabContent = kvTable(headersArr);
  else if (s.detailTab === 'query') tabContent = queryArr.length ? kvTable(queryArr) : emptyBox('No query parameters on this request.');
  else tabContent = r.body ? h('div', { style: 'position:relative' },
    h('button', { style: 'position:absolute;top:34px;right:12px;z-index:2;background:#211d17;color:#a49c91;border-radius:var(--radius-xs);padding:5px 11px;font-size:11px;font-weight:600', onclick: () => app.copy(r.body, 'detail-body') }, s.copied === 'detail-body' ? 'Copied' : 'Copy'),
    codeBlock(r.body, { label: 'Payload', style: "margin:0;background:#141210;border-radius:var(--radius-sm);padding:18px 20px;font-family:'IBM Plex Mono',monospace;font-size:13px;line-height:1.65;color:#c2bbb0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" })) : emptyBox('No request body.');

  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:900px;margin:0 auto;padding:22px 28px 64px 28px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:20px', onclick: app.backToInspector }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Back to live feed'),
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px' },
      h('div', { style: 'min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' },
          h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;color:${methodColor(r.method)};background:#191712;border-radius:var(--radius-xs);padding:4px 9px` }, r.method),
          h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:14px;color:#e8e2d7" }, r.path),
          h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:700;color:${statusColor(r.status)}` }, '→ ' + r.status)),
        h('h1', { style: 'margin:0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, r.event || 'Request')),
      h('div', { style: 'display:flex;gap:8px;flex-shrink:0' },
        h('button', { style: 'display:flex;align-items:center;gap:7px;background:#edecec;color:#1a0e07;border-radius:var(--radius-xs);padding:9px 13px;font-size:12.5px;font-weight:600', onclick: app.toggleReplay }, raw(icons.replay({ w: 14, sw: 1.9 })), 'Replay'),
        h('button', { style: 'display:flex;align-items:center;gap:7px;background:#211d17;color:#d9d3c7;border-radius:var(--radius-xs);padding:9px 13px;font-size:12.5px;font-weight:600', onclick: () => app.exportRequest(r.id) }, raw(icons.download({ w: 14, sw: 1.8 })), 'Export'))),
    replayPanel,
    h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:24px' },
      meta('Received at', fmtStamp(r.receivedAt)), meta('Source IP', r.ip || '—'), meta('Payload size', fmtBytes(r.size)), meta('Content-Type', r.contentType || '—')),
    h('div', { style: 'display:flex;align-items:center;gap:22px;margin-bottom:18px;box-shadow:inset 0 -1px 0 rgba(245,240,230,0.06)' },
      tab('body', 'Body'), tab('headers', `Headers (${headersArr.length})`), tab('query', 'Query params')),
    tabContent));
}

function replayResultView(res) {
  if (!res.ok) return h('div', { style: 'background:#1a1210;border-radius:var(--radius-xs);padding:11px 13px;font-size:12px;color:#e08b7f' }, 'Error: ' + res.error);
  return h('div', { style: 'background:#0f0e0b;border-radius:var(--radius-xs);padding:11px 13px' },
    h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;margin-bottom:6px" },
      h('span', { style: `font-weight:700;color:${statusColor(res.status)}` }, String(res.status)), h('span', { style: 'color:#7a746a' }, ` ${res.statusText || ''} · ${res.durationMs}ms`)),
    res.body ? codeBlock(res.body, { label: 'Response', showMeta: false, style: "margin:0;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#b3aca1;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere" }) : null);
}

function kvTable(entries) {
  return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);overflow:hidden' }, ...entries.map(([k, v]) =>
    h('div', { style: 'display:grid;grid-template-columns:230px 1fr;gap:16px;padding:11px 18px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#6a9fd4;overflow-wrap:anywhere" }, k),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#c2bbb0;overflow-wrap:anywhere" }, String(v)))));
}
function emptyBox(msg) { return h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:26px;text-align:center;font-size:13px;color:#7a746a' }, msg); }

// ---------------- diff ----------------
export function diffScreen(app) {
  const s = app.s, d = s.diff;
  const back = h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.backFromDiff }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Back to feed');
  if (!d) return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:1040px;margin:0 auto;padding:22px 28px' }, back, emptyBox("Select two requests in the feed's compare mode to see a diff.")));

  const rows = d.rows.map((l) => {
    const bg = l.type === 'add' ? 'rgba(35,134,54,0.10)' : l.type === 'del' ? 'rgba(207,80,68,0.10)' : 'transparent';
    const mark = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
    const markColor = l.type === 'add' ? '#7fc79b' : l.type === 'del' ? '#e08b7f' : '#4c473f';
    const textColor = l.type === 'add' ? '#a9d3ac' : l.type === 'del' ? '#e0aca4' : '#8a837a';
    return h('div', { style: `display:grid;grid-template-columns:52px 22px 1fr;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;background:${bg}` },
      h('span', { style: 'padding:0 14px 0 0;text-align:right;color:#4c473f;user-select:none' }, String(l.an || '') + (l.bn ? ':' + l.bn : '')),
      h('span', { style: `text-align:center;color:${markColor};font-weight:700;user-select:none` }, mark),
      h('span', { style: `padding-left:8px;padding-right:16px;color:${textColor};white-space:pre` }, l.text));
  });

  const side = (tag, tagColor, label, req) => h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:14px 16px' },
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' },
      h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:700;letter-spacing:0.08em;color:${tagColor}` }, tag),
      h('span', { style: 'font-size:11px;color:#7a746a' }, label)),
    h('div', { style: 'font-size:14px;font-weight:600;color:#efe9df;margin-bottom:4px' }, req.event || req.path),
    h('div', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#8a837a" }, `${fmtStamp(req.receivedAt)} · ${req.ip || '—'}`));

  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:1040px;margin:0 auto;padding:22px 28px 64px 28px' }, back,
    h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:20px' },
      h('h1', { style: 'margin:0;font-size:22px;font-weight:600;color:#f2ede3;letter-spacing:-0.02em' }, 'Compare requests'),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:#238636;background:#141712;border-radius:var(--radius-xs);padding:4px 9px" }, '+' + d.summary.add),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:#e5675c;background:#1a1210;border-radius:var(--radius-xs);padding:4px 9px" }, '−' + d.summary.del)),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px' },
      side('REQUEST A', '#e5675c', 'baseline', d.a), side('REQUEST B', '#238636', 'comparison', d.b)),
    h('div', { style: 'background:#141210;border-radius:var(--radius-sm);overflow:hidden' },
      h('div', { style: 'display:flex;align-items:center;gap:9px;padding:11px 16px;background:#191712' },
        raw(icons.compare({ w: 14, stroke: '#8a837a', sw: 1.8 })),
        h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#c2bbb0" }, 'request body'),
        h('span', { style: 'margin-left:auto;font-size:11px;color:#6a655c' }, 'unified diff')),
      h('div', { style: 'overflow-x:auto;padding:8px 0' }, ...rows))));
}
