// Tailscale Funnel control: real status, toggle, exposed endpoints, history.
import { h, raw, icons, fmtRel, fmtDur } from '../ui.js';

export function tailscaleScreen(app) {
  const s = app.s;
  const f = s.funnel.state || {};
  const active = !!f.active;
  const now = Date.now();
  const stateColor = active ? '#7fc79b' : '#8a837a';
  const baseUrl = f.base_url || (s.baseUrls.publicBase) || '';
  const exposed = s.funnel.exposed || [];
  const history = s.funnel.history || [];
  const unsigned = exposed.filter((e) => e.type === 'inspector' && !e.signed);

  const dot = h('span', { style: `width:11px;height:11px;border-radius:50%;flex-shrink:0;background:${active ? '#238636' : '#4c473f'};${active ? 'box-shadow:0 0 0 3px rgba(35,134,54,0.15)' : ''}` });

  const toggleBtn = h('button', { style: `position:relative;width:46px;height:26px;border-radius:20px;padding:0;flex-shrink:0;cursor:pointer;background:${active ? '#238636' : 'rgba(245,240,230,0.13)'}`, onclick: app.toggleFunnel },
    h('span', { style: `position:absolute;top:3px;left:${active ? '23px' : '3px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left .16s` }));

  const statusCard = h('div', { style: 'background:#191712;border-radius:var(--radius-md);padding:22px 24px;margin-bottom:14px' },
    h('div', { style: 'display:flex;align-items:center;gap:15px' }, dot,
      h('div', { style: 'flex:1' },
        h('span', { style: `font-size:21px;font-weight:600;color:${stateColor};letter-spacing:-0.01em` }, active ? 'Funnel online' : 'Funnel offline'),
        h('div', { style: 'font-size:13px;color:#8a837a;margin-top:2px' }, active && f.since ? `up ${fmtDur(now - f.since)} · ${f.machine || 'this machine'}${f.region ? ' · ' + f.region : ''}` : (f.machine ? `${f.machine}${f.region ? ' · ' + f.region : ''}` : 'Not exposed publicly'))),
      h('div', { style: 'display:flex;align-items:center;gap:10px' }, h('span', { style: 'font-size:12.5px;color:#7a746a' }, active ? 'On' : 'Off'), toggleBtn)),
    h('div', { style: 'display:flex;align-items:center;gap:11px;margin-top:18px;background:#141210;border-radius:var(--radius-sm);padding:11px 14px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:0.06em;color:#f5602a" }, 'PUBLIC BASE URL'),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:13px;color:#d3ccc0;flex:1;overflow:hidden;text-overflow:ellipsis" }, baseUrl || '—'),
      baseUrl ? h('button', { style: `background:#211d17;color:${s.copied === 'ts-base' ? '#7fc79b' : '#a49c91'};border-radius:var(--radius-xs);padding:6px 12px;font-size:11.5px;font-weight:600`, onclick: () => app.copy(baseUrl, 'ts-base') }, s.copied === 'ts-base' ? 'Copied' : 'Copy') : null));

  const errorBanner = f.last_error ? h('div', { style: 'display:flex;align-items:center;gap:12px;background:#1c1710;border-radius:var(--radius-sm);padding:13px 16px;margin-bottom:14px' },
    raw(icons.warning({ w: 17, stroke: '#d69a3c', sw: 1.9 })), h('span', { style: 'flex:1;font-size:13px;color:#c9ad7e' }, f.last_error)) : null;

  const warnBanner = active && unsigned.length ? h('div', { style: 'display:flex;align-items:center;gap:12px;background:#1c1710;border-radius:var(--radius-sm);padding:13px 16px;margin-bottom:28px' },
    raw(icons.warning({ w: 17, stroke: '#d69a3c', sw: 1.9 })),
    h('span', { style: 'flex:1;font-size:13px;color:#c9ad7e' }, `${unsigned.length} webhook${unsigned.length > 1 ? 's' : ''} receiving public traffic without signature validation — ${unsigned.map((e) => e.name).join(', ')}`)) : null;

  const exposedList = h('div', {},
    h('h2', { style: 'margin:0 0 13px 0;font-size:14px;font-weight:600;color:#c9c2b6' }, 'Exposed endpoints ', h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#57524a;font-weight:400" }, `(${exposed.length})`)),
    active
      ? (exposed.length ? h('div', { style: 'display:flex;flex-direction:column;gap:9px' }, ...exposed.map((e) => exposedRow(app, e)))
        : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:30px;text-align:center;font-size:13px;color:#7a746a' }, 'No endpoints yet.'))
      : h('div', { style: 'background:#141210;border-radius:var(--radius-sm);padding:30px;text-align:center;font-size:13px;color:#7a746a' }, 'Funnel is offline — nothing is reachable publicly.'));

  const historyCol = h('div', {},
    h('h2', { style: 'margin:0 0 13px 0;font-size:14px;font-weight:600;color:#c9c2b6' }, 'Exposure history'),
    history.length ? h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:4px 2px' }, ...history.map((hh) => h('div', { style: 'display:flex;gap:11px;padding:11px 14px' },
      h('div', { style: 'display:flex;flex-direction:column;align-items:center;flex-shrink:0' }, h('span', { style: `width:8px;height:8px;border-radius:50%;background:${hh.kind === 'up' ? '#238636' : hh.kind === 'error' ? '#e5675c' : '#6a655c'};margin-top:3px` }), h('span', { style: 'width:1px;flex:1;background:rgba(245,240,230,0.08);margin-top:4px' })),
      h('div', { style: 'flex:1;min-width:0;padding-bottom:3px' }, h('div', { style: 'display:flex;align-items:baseline;gap:8px' }, h('span', { style: 'font-size:12.5px;font-weight:600;color:#e8e2d7' }, hh.label), h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;color:#6a655c;margin-left:auto" }, fmtRel(hh.at, now))), hh.detail ? h('div', { style: 'font-size:11.5px;color:#7a746a;margin-top:2px' }, hh.detail) : null))))
      : h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:22px;text-align:center;font-size:12.5px;color:#7a746a' }, 'No exposure events yet.'));

  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:920px;margin:0 auto;padding:34px 40px 64px 40px' },
    h('h1', { style: 'margin:0 0 22px 0;font-size:26px;font-weight:600;color:#f2ede3;letter-spacing:-0.025em' }, 'Tailscale Funnel'),
    statusCard, errorBanner, warnBanner,
    h('div', { style: 'display:grid;grid-template-columns:1.3fr 1fr;gap:22px;margin-top:8px' }, exposedList, historyCol)));
}

function exposedRow(app, e) {
  const s = app.s;
  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:13px 15px' },
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:8px' },
      h('span', { style: `width:26px;height:26px;border-radius:var(--radius-xs);background:#221d17;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${e.type === 'mock' ? '#d69a3c' : '#238636'}` }, raw((e.type === 'mock' ? icons.mock : icons.webhook)({ w: 14, sw: 1.7 }))),
      h('span', { style: 'font-size:14px;font-weight:600;color:#efe9df;flex:1' }, e.name),
      e.type === 'inspector' ? h('span', { style: `display:flex;align-items:center;gap:6px;font-size:11.5px;color:${e.signed ? '#7fc79b' : '#d69a3c'}` }, h('span', { style: `width:6px;height:6px;border-radius:50%;background:${e.signed ? '#238636' : '#d69a3c'}` }), e.signed ? 'Signed' : 'Unsigned') : null),
    h('div', { style: 'display:flex;align-items:center;gap:9px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#8a837a;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, e.url),
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6a655c" }, `${e.requestCount || 0} reqs`),
      h('button', { style: `background:#211d17;color:${s.copied === 'ts-' + e.id ? '#7fc79b' : '#a49c91'};border-radius:var(--radius-xs);padding:4px 10px;font-size:11px;font-weight:600`, onclick: () => app.copy(e.url, 'ts-' + e.id) }, s.copied === 'ts-' + e.id ? 'Copied' : 'Copy')));
}
