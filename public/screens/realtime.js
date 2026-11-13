// Realtime protocol screens. The controls deliberately keep raw transport
// details visible while using the same cards, tabs and input hierarchy as the
// existing endpoint screens.
import { h, raw, codeBlock, codeEditor, icons, kebabMenu, select, toggle, fmtRel, fmtStamp, fmtBytes } from '../ui.js';
import { endpointMenuItems } from './endpoint.js';
import { projectPicker } from './forms.js';

const INPUT = "width:100%;background:#141210;border-radius:var(--radius-xs);padding:9px 11px;box-shadow:inset 0 0 0 1px rgba(245,240,230,0.09);color:#e8e2d7;font-size:13px";
const TEXTAREA = `${INPUT};min-height:92px;resize:vertical;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.5`;

function label(text) { return h('div', { style: 'font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6a655c;margin:0 0 6px' }, text); }
function input(value, placeholder, oninput, extra = '') { return h('input', { value: value == null ? '' : value, placeholder, style: `${INPUT};${extra}`, oninput }); }
function textarea(value, placeholder, oninput, rows = 5) { return h('textarea', { value: value == null ? '' : value, placeholder, rows: String(rows), style: TEXTAREA, oninput }); }
function button(text, onClick, primary = false, opts = {}) {
  const b = h('button', { style: `display:inline-flex;align-items:center;justify-content:center;gap:7px;background:${primary ? '#edecec' : opts.bg || '#211d17'};color:${primary ? '#1a0e07' : opts.color || '#cfc8bc'};border-radius:var(--radius-xs);padding:${opts.compact ? '6px 10px' : '9px 13px'};font-size:${opts.compact ? '11.5px' : '12.5px'};font-weight:600;cursor:pointer;${opts.full ? 'width:100%;' : ''}`, onclick: onClick }, opts.icon ? raw(opts.icon({ w: opts.compact ? 13 : 14, sw: 1.9 })) : null, text);
  b.addEventListener('mouseenter', () => { b.style.background = primary ? '#fff' : opts.hover || '#2a241c'; });
  b.addEventListener('mouseleave', () => { b.style.background = primary ? '#edecec' : opts.bg || '#211d17'; });
  return b;
}
export function protocolLabel(protocol) { return protocol === 'socketio' ? 'Socket.IO v4' : protocol === 'graphql' ? 'GraphQL' : 'WebSocket'; }
export function protocolColor(protocol) { return protocol === 'graphql' ? '#b28de0' : protocol === 'socketio' ? '#6a9fd4' : '#45ae85'; }

export function newRealtimeScreen(app) {
  const f = app.s.form.realtime;
  const graph = f.protocol === 'graphql';
  const title = `New ${protocolLabel(f.protocol)} mock`;
  const local = app.s.baseUrls.local || 'http://localhost:4601';
  const protocolPreview = graph ? `${local}/${f.slug || 'graphql-api'}` : f.protocol === 'socketio'
    ? `${local}/_sidedoor/socket.io/  ·  namespace /${f.slug || 'socket-api'}`
    : `${local.replace(/^http/, 'ws')}/${f.slug || 'socket-api'}`;
  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:690px;margin:0 auto;padding:34px 40px 64px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.backToMockProtocol }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'Choose protocol'),
    h('h1', { style: 'margin:0 0 6px;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-.02em' }, title),
    h('p', { style: 'margin:0 0 26px;font-size:13.5px;color:#8a837a' }, 'Set the connection identity now, then configure scripts, fixtures and security from the mock server.'),
    f.submitted && f.errors && Object.keys(f.errors).length ? h('div', { style: 'background:#281815;border-radius:var(--radius-xs);padding:10px 12px;margin-bottom:16px;font-size:12px;color:#e08b7f' }, Object.values(f.errors).join(' · ')) : null,
    h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
      h('div', { style: 'display:flex;align-items:center;gap:8px;background:#191712;border-radius:var(--radius-sm);padding:11px 13px' },
        h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.07em;color:${protocolColor(f.protocol)};background:#141210;border-radius:4px;padding:4px 7px` }, protocolLabel(f.protocol).toUpperCase()),
        h('span', { style: 'font-size:12px;color:#8a837a' }, 'Protocol selected for this mock server')),
      h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px' },
        h('div', {}, label('Name'), input(f.name, graph ? 'e.g. Orders graph' : 'e.g. Order events', (event) => app.setRealtimeForm('name', event.target.value))),
        h('div', {}, label('Slug'), input(f.slug, 'orders', (event) => app.setRealtimeForm('slug', event.target.value), "font-family:'IBM Plex Mono',monospace"))),
      h('div', {}, label('Project'), projectPicker(app, { id: 'realtime-project', value: f.projectName, onPick: (value) => { f.projectName = value; }, onClear: () => { f.projectName = ''; } })),
      h('div', { style: "background:#141210;border-radius:var(--radius-xs);padding:10px 12px;font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#948d83;word-break:break-all" }, protocolPreview),
      graph ? h('div', {}, label('Schema definition language'), codeEditor(f.sdl, 9, (value, editor) => {
        f.sdl = value;
        f.sdlValidation = null;
        app.validateGraphqlSdl(value, editor, (validation) => { if (f.sdl === value) f.sdlValidation = validation; });
      }, { language: 'graphql', validation: f.sdlValidation }), h('div', { style: 'font-size:11.5px;color:#6a655c;margin-top:7px' }, 'SDL is validated before the endpoint is created.')) : null,
      h('div', { style: 'display:flex;gap:10px;justify-content:flex-end;margin-top:3px' }, button('Cancel', app.cancelNewMock), button('Create mock server', app.createRealtime, true, { icon: icons.plus })))))
}

function protocolConnectionCard(app, ep) {
  const s = app.s;
  const rawUrl = ep.protocol === 'graphql' ? (ep.urls.graphql.wsPublic || ep.urls.graphql.wsLocal) : ep.protocol === 'socketio' ? (ep.urls.socketio.public || ep.urls.socketio.local) : (ep.urls.websocket.public || ep.urls.websocket.local);
  const httpUrl = ep.protocol === 'graphql' ? (ep.urls.graphql.httpPublic || ep.urls.graphql.httpLocal) : null;
  const rows = [];
  if (httpUrl) rows.push(['HTTP', httpUrl, 'rt-http']);
  if (ep.protocol === 'socketio') rows.push(['SOCKET.IO', `${rawUrl}${ep.urls.socketio.path}  ·  namespace ${ep.urls.socketio.namespace}`, 'rt-sio']);
  else rows.push([ep.protocol === 'graphql' ? 'SUBSCRIPTIONS' : 'WEBSOCKET', rawUrl, 'rt-ws']);
  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:13px 14px;margin:16px 0 20px' }, ...rows.map(([name, url, key]) => h('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0;padding:5px 0' },
    h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:700;letter-spacing:.06em;color:${protocolColor(ep.protocol)};width:96px;flex-shrink:0` }, name),
    h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#b3aca1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" }, url),
    button(s.copied === key ? 'Copied' : 'Copy', () => app.copy(url, key), false, { compact: true }))));
}

function tabButton(app, id, text, count) {
  const selected = app.s.realtimeTab === id;
  return h('button', { style: `background:transparent;padding:0 0 13px;font-size:13px;font-weight:600;color:${selected ? '#f2ede3' : '#7a746a'};box-shadow:${selected ? 'inset 0 -2px 0 #edecec' : 'none'}`, onclick: () => app.setRealtimeTab(id) }, text, count != null ? h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#57524a;margin-left:6px" }, String(count)) : null);
}

function sessionBadge(session) {
  const colors = { connected: '#45ae85', closed: '#7a746a', rejected: '#e5675c' };
  return h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.06em;color:${colors[session.state] || '#8a837a'};background:#141210;border-radius:4px;padding:3px 6px` }, session.state.toUpperCase());
}

function sessionsPanel(app, ep, focusMessages = false) {
  const s = app.s;
  const sessions = s.realtimeSessions || [];
  const selected = s.realtimeSelectedSession;
  const rows = sessions.map((session) => {
    const active = selected && selected.id === session.id;
    const row = h('button', { style: `width:100%;display:flex;align-items:center;gap:10px;text-align:left;background:${active ? '#252019' : 'transparent'};border-radius:var(--radius-xs);padding:10px;cursor:pointer`, onclick: () => app.selectRealtimeSession(session.id) },
      h('span', { style: 'width:8px;height:8px;border-radius:50%;background:' + (session.state === 'connected' ? '#45ae85' : session.state === 'rejected' ? '#e5675c' : '#4c473f') }),
      h('span', { style: 'flex:1;min-width:0' }, h('span', { style: 'display:block;font-family:IBM Plex Mono,monospace;font-size:11.5px;color:#d3ccc0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, session.remoteIp || 'local test'), h('span', { style: 'display:block;font-size:10.5px;color:#6a655c;margin-top:2px' }, `${session.transport} · ${session.messageCount} messages · ${fmtRel(session.connectedAt)}`)),
      sessionBadge(session));
    return row;
  });
  const transcript = selected
    ? h('div', { style: 'display:flex;flex-direction:column;gap:7px;min-width:0' },
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:3px' }, h('div', {}, h('div', { style: 'font-size:13px;font-weight:600;color:#e8e2d7' }, 'Transcript'), h('div', { style: 'font-size:11px;color:#6a655c;margin-top:2px' }, `${selected.protocol} · ${selected.transport} · started ${fmtStamp(selected.connectedAt)}`)), selected.state === 'connected' ? button('Disconnect', () => app.disconnectRealtimeSession(selected.id), false, { compact: true, color: '#e8b88a' }) : null),
      ...(selected.messages || []).map((message) => h('div', { style: `background:${message.direction === 'in' ? '#161c19' : message.direction === 'out' ? '#191722' : '#211d17'};border-radius:var(--radius-xs);padding:9px 10px;min-width:0` },
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px' }, h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:700;letter-spacing:.06em;color:${message.direction === 'in' ? '#7fc79b' : message.direction === 'out' ? '#b28de0' : '#d69a3c'}` }, `${message.direction.toUpperCase()} · ${message.kind}${message.eventName ? ` · ${message.eventName}` : ''}`), h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;color:#57524a" }, fmtStamp(message.at))),
        codeBlock(message.payload || '∅', { label: 'Payload', showMeta: false, style: "margin:0;white-space:pre-wrap;word-break:break-word;font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.5;color:#cfc8bc" }),
        message.truncated ? h('div', { style: 'font-size:10.5px;color:#d69a3c;margin-top:5px' }, `Preview truncated · original ${fmtBytes(message.payloadSize)}`) : null)))
    : h('div', { style: 'height:100%;min-height:220px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12.5px;color:#6a655c;padding:28px' }, sessions.length ? 'Select a session to inspect its redacted transcript.' : 'Sessions will appear here when a client connects.');
  return h('div', {},
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:13px;flex-wrap:wrap' }, h('div', {}, h('h2', { style: 'margin:0;font-size:15px;color:#c9c2b6' }, focusMessages ? 'Message timeline' : 'Sessions'), h('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a746a' }, focusMessages ? 'Select a session to filter its durable, redacted message transcript.' : 'A transcript persists after a socket closes; secret fields are redacted.')), h('div', { style: 'display:flex;gap:8px' }, button('Run test flow', app.openRealtimeTest, true, { compact: true, icon: icons.replay }), button('Clear history', () => app.clearRealtimeSessions(ep.id), false, { compact: true, color: '#cf8b7f' }))),
    h('div', { style: 'display:grid;grid-template-columns:minmax(240px,.8fr) minmax(0,1.6fr);gap:12px;align-items:stretch' },
      h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:7px;max-height:520px;overflow-y:auto' }, rows.length ? rows : h('div', { style: 'padding:26px 12px;text-align:center;font-size:12px;color:#6a655c' }, 'No sessions yet.')),
      h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:14px;min-width:0;max-height:520px;overflow-y:auto' }, transcript)));
}

function actionDraft(action = {}) {
  return { type: action.type || 'send', event: action.event || '', payloadText: typeof action.payload === 'string' ? action.payload : JSON.stringify(action.payload == null ? {} : action.payload, null, 2), delayMs: action.delayMs || 0, code: action.code || 1000, reason: action.reason || '' };
}
function scriptStepCard(app, ep, step, index) {
  const action = step.actions[0] || null;
  const isSocketIo = ep.protocol === 'socketio';
  const replyOptions = isSocketIo
    ? [{ value: 'emit', label: 'Emit event' }, { value: 'send', label: 'Send message' }, { value: 'close', label: 'Close' }]
    : [{ value: 'send', label: 'Send message' }, { value: 'close', label: 'Close' }];
  const ensureAction = () => {
    if (!step.actions[0]) step.actions[0] = actionDraft({ type: isSocketIo ? 'emit' : 'send' });
    return step.actions[0];
  };
  return h('div', { style: 'background:#141210;border-radius:var(--radius-xs);padding:12px' },
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px' },
      h('span', { style: "font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:#8a837a" }, `STEP ${index + 1}`),
      h('div', { style: 'display:flex;gap:6px' },
        button('Save', () => app.saveRealtimeStep(step), false, { compact: true }),
        button('↑', () => app.moveRealtimeStep(step.id, 'up'), false, { compact: true }),
        button('↓', () => app.moveRealtimeStep(step.id, 'down'), false, { compact: true }),
        button('Delete', () => app.deleteRealtimeStep(step.id), false, { compact: true, color: '#cf8b7f' }))),
    h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px' },
      h('div', {}, label(isSocketIo ? 'Expected event payload' : 'Expected message'), codeEditor(step.matchText, 3, (value) => { step.matchText = value; }, { language: 'auto' })),
      h('div', {}, label('Response payload'), codeEditor((action && action.payloadText) || '{}', 3, (value) => { ensureAction().payloadText = value; }, { language: 'auto' }))),
    isSocketIo ? h('div', { style: 'margin-top:10px;max-width:320px' }, label('Expected event name'), input((step.match && step.match.event) || 'message', 'message', (event) => { step.match = { ...(step.match || {}), event: event.target.value, kind: 'event' }; })) : null,
    h('div', { style: 'display:grid;grid-template-columns:140px minmax(0,1fr) 100px;gap:10px;margin-top:10px' },
      h('div', {}, label('Reply kind'), select({ value: (action && action.type) || (isSocketIo ? 'emit' : 'send'), options: replyOptions, onPick: (value) => { ensureAction().type = value; app.rerender(); } })),
      h('div', {}, label(isSocketIo ? 'Response event' : 'Delay / reason'), isSocketIo
        ? input((action && action.event) || 'message', 'accepted', (event) => { ensureAction().event = event.target.value; })
        : input((action && action.reason) || '', 'optional close reason', (event) => { ensureAction().reason = event.target.value; })),
      h('div', {}, label('Delay ms'), input((action && action.delayMs) || 0, '0', (event) => { ensureAction().delayMs = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace"))));
}
function scriptsPanel(app, ep) {
  const scripts = app.s.realtimeScripts || [];
  const cards = scripts.map((script, scriptIndex) => {
    if (!script._drafted) {
      script._drafted = true;
      script.connectActions = (script.connectActions || []).map(actionDraft);
      script.steps = (script.steps || []).map((step) => ({ ...step, matchText: step.match && step.match.payload != null ? JSON.stringify(step.match.payload, null, 2) : step.match && step.match.text || '', actions: (step.actions || []).map(actionDraft) }));
    }
    const steps = script.steps || [];
    const connectAction = script.connectActions[0] || null;
    return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px;box-shadow:inset 0 0 0 1px rgba(245,240,230,.04)' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:13px;flex-wrap:wrap' },
        h('span', { style: "width:23px;height:23px;border-radius:var(--radius-xs);background:#221d17;color:#b28de0;display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700" }, String(scriptIndex + 1)),
        h('div', { style: 'flex:1;min-width:180px' }, input(script.name, 'Conversation name', (event) => { script.name = event.target.value; })),
        toggle(script.enabled, () => { script.enabled = !script.enabled; app.saveRealtimeScript(script); }),
        button('Save', () => app.saveRealtimeScript(script), false, { compact: true }),
        button('↑', () => app.moveRealtimeScript(script.id, 'up'), false, { compact: true }),
        button('↓', () => app.moveRealtimeScript(script.id, 'down'), false, { compact: true }),
        button('Delete', () => app.deleteRealtimeScript(script.id), false, { compact: true, color: '#cf8b7f' })),
      h('div', { style: 'font-size:11.5px;color:#7a746a;margin:0 0 10px' }, 'Expected incoming messages run in order. A mismatch is recorded and closes the mock conversation.'),
      connectAction
        ? h('div', { style: 'background:#17140e;border-radius:var(--radius-xs);padding:12px;margin:0 0 10px' },
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px' }, h('div', {}, h('div', { style: 'font-size:12px;font-weight:600;color:#d3ccc0' }, 'On connection'), h('div', { style: 'font-size:10.5px;color:#6a655c;margin-top:2px' }, 'Push a message, emit an event, or close immediately after the client connects.')), button('Remove', () => { script.connectActions = []; app.rerender(); }, false, { compact: true, color: '#cf8b7f' })),
          h('div', { style: 'display:grid;grid-template-columns:140px minmax(0,1fr) 100px;gap:10px' },
            h('div', {}, label('Action'), select({ value: connectAction.type, options: ep.protocol === 'socketio' ? [{ value: 'emit', label: 'Emit event' }, { value: 'send', label: 'Send message' }, { value: 'close', label: 'Close' }] : [{ value: 'send', label: 'Send message' }, { value: 'close', label: 'Close' }], onPick: (value) => { connectAction.type = value; app.rerender(); } })),
            h('div', {}, label(connectAction.type === 'close' ? 'Close reason' : ep.protocol === 'socketio' && connectAction.type === 'emit' ? 'Event name' : 'Message payload'), connectAction.type === 'close'
              ? input(connectAction.reason, 'script complete', (event) => { connectAction.reason = event.target.value; })
              : ep.protocol === 'socketio' && connectAction.type === 'emit'
                ? input(connectAction.event, 'connected', (event) => { connectAction.event = event.target.value; })
                : codeEditor(connectAction.payloadText, 3, (value) => { connectAction.payloadText = value; }, { language: 'auto' })),
            h('div', {}, label('Delay ms'), input(connectAction.delayMs || 0, '0', (event) => { connectAction.delayMs = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace"))))
        : button('Add connection action', () => { script.connectActions.push(actionDraft({ type: ep.protocol === 'socketio' ? 'emit' : 'send', event: 'connected', payload: { connected: true } })); app.rerender(); }, false, { compact: true, icon: icons.plus, bg: '#17140e' }),
      h('div', { style: 'display:flex;flex-direction:column;gap:9px' }, ...steps.map((step, index) => scriptStepCard(app, ep, step, index))),
      button('Add expected step', () => app.addRealtimeStep(script.id), false, { compact: true, icon: icons.plus, bg: '#17140e' }));
  });
  return h('div', {},
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:13px;flex-wrap:wrap' }, h('div', {}, h('h2', { style: 'margin:0;font-size:15px;color:#c9c2b6' }, 'Conversation scripts'), h('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a746a' }, 'Mocks select the first enabled script. Actions can send, emit, delay or close.')), button('Add script', () => app.addRealtimeScript(ep.id), true, { compact: true, icon: icons.plus })),
    cards.length ? h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, ...cards) : h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:32px;text-align:center' }, h('div', { style: 'font-size:13px;color:#8a837a;margin-bottom:12px' }, 'No script yet. This mock currently records conversations without responding.'), button('Create first script', () => app.addRealtimeScript(ep.id), true, { compact: true, icon: icons.plus })));
}

function fixtureDraft(fixture) {
  if (!fixture._drafted) Object.assign(fixture, { _drafted: true, variablesText: fixture.variablesMatch == null ? '' : JSON.stringify(fixture.variablesMatch, null, 2), responseText: JSON.stringify(fixture.response || {}, null, 2), eventsText: JSON.stringify(fixture.subscriptionEvents || [], null, 2) });
  return fixture;
}
function fixturesPanel(app, ep, subscriptionOnly = false) {
  const fixtures = (app.s.realtimeFixtures || []).filter((fixture) => !subscriptionOnly || fixture.operationType === 'subscription');
  const cards = fixtures.map((rawFixture) => {
    const fixture = fixtureDraft(rawFixture);
    return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px;box-shadow:inset 0 0 0 1px rgba(245,240,230,.04)' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap' },
        h('div', { style: 'flex:1;min-width:180px' }, input(fixture.name, 'Fixture name', (event) => { fixture.name = event.target.value; })),
        toggle(fixture.enabled, () => { fixture.enabled = !fixture.enabled; app.saveGraphqlFixture(fixture); }),
        button('Save', () => app.saveGraphqlFixture(fixture), false, { compact: true }),
        button('↑', () => app.moveGraphqlFixture(fixture.id, 'up'), false, { compact: true }),
        button('↓', () => app.moveGraphqlFixture(fixture.id, 'down'), false, { compact: true }),
        button('Delete', () => app.deleteGraphqlFixture(fixture.id), false, { compact: true, color: '#cf8b7f' })),
      h('div', { style: 'display:grid;grid-template-columns:150px minmax(0,1fr) 110px;gap:10px;margin-bottom:10px' },
        h('div', {}, label('Operation type'), select({ value: fixture.operationType, options: [{ value: 'query', label: 'Query' }, { value: 'mutation', label: 'Mutation' }, { value: 'subscription', label: 'Subscription' }], onPick: (value) => { fixture.operationType = value; app.rerender(); } })),
        h('div', {}, label('Operation name'), input(fixture.operationName, 'e.g. GetOrder', (event) => { fixture.operationName = event.target.value; }, "font-family:'IBM Plex Mono',monospace")),
        h('div', {}, label('Delay ms'), input(fixture.delayMs || 0, '0', (event) => { fixture.delayMs = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace"))),
      h('div', { style: 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:10px' },
        h('div', {}, label('Variables matcher (optional)'), codeEditor(fixture.variablesText, 4, (value) => { fixture.variablesText = value; }, { language: 'json' })),
        h('div', {}, label('GraphQL response'), codeEditor(fixture.responseText, 4, (value) => { fixture.responseText = value; }, { language: 'json' }))),
      fixture.operationType === 'subscription' ? h('div', { style: 'margin-top:10px' }, label('Subscription events — [{ delayMs, payload }]'), codeEditor(fixture.eventsText, 5, (value) => { fixture.eventsText = value; }, { language: 'json' })) : null);
  });
  return h('div', {},
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:13px;flex-wrap:wrap' }, h('div', {}, h('h2', { style: 'margin:0;font-size:15px;color:#c9c2b6' }, subscriptionOnly ? 'Subscription fixtures' : 'Operation fixtures'), h('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a746a' }, subscriptionOnly ? 'Each matching subscription emits its events in order, then completes.' : 'Specific variable matchers take precedence over a base fixture.')), button('Add fixture', () => app.addGraphqlFixture(ep.id, subscriptionOnly ? 'subscription' : 'query'), true, { compact: true, icon: icons.plus })),
    cards.length ? h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, ...cards) : h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:32px;text-align:center;font-size:12.5px;color:#7a746a' }, subscriptionOnly ? 'No subscription fixtures yet.' : 'No fixtures yet. Valid operations without a fixture return SIDEDOOR_FIXTURE_NOT_FOUND.'));
}

function schemaPanel(app) {
  const schema = app.s.realtimeSchema || { sdl: '' };
  return h('div', { style: 'max-width:850px' },
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:13px;flex-wrap:wrap' }, h('div', {}, h('h2', { style: 'margin:0;font-size:15px;color:#c9c2b6' }, 'Schema definition language'), h('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a746a' }, 'Saved SDL drives validation and standard introspection. Errors remain inline and no invalid schema is persisted.')), button('Save SDL', app.saveGraphqlSchema, true, { compact: true, icon: icons.check })),
    codeEditor(schema.sdl || '', 20, (value, editor) => {
      schema.sdl = value;
      app.s.realtimeSchemaValidation = null;
      app.validateGraphqlSdl(value, editor);
    }, { language: 'graphql', validation: app.s.realtimeSchemaValidation }),
    app.s.realtimeError ? h('div', { style: 'margin-top:9px;font-size:12px;color:#cf8b7f' }, app.s.realtimeError) : null);
}

function testPanel(app, ep) {
  const test = app.s.realtimeTest;
  const graph = ep.protocol === 'graphql';
  const output = app.s.realtimeTestResult;
  if (!test) {
    return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:22px;text-align:center;margin-top:16px' },
      h('div', { style: 'font-size:13px;font-weight:600;color:#c9c2b6;margin-bottom:5px' }, graph ? 'Test an operation' : 'Test this conversation'),
      h('div', { style: 'font-size:12px;color:#7a746a;margin-bottom:13px' }, graph ? 'Run a query, mutation, or subscription against the saved SDL and fixtures.' : 'Run a local scripted conversation and inspect its durable transcript.'),
      button(graph ? 'Open operation console' : 'Run test flow', app.openRealtimeTest, true, { compact: true, icon: icons.replay }));
  }
  return h('div', { style: 'background:#191712;border-radius:var(--radius-sm);padding:15px;margin-top:16px;box-shadow:inset 0 0 0 1px rgba(245,240,230,.04)' },
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px' }, h('div', {}, h('div', { style: 'font-size:14px;font-weight:600;color:#e8e2d7' }, graph ? 'Run test operation' : 'Run test flow'), h('div', { style: 'font-size:11.5px;color:#7a746a;margin-top:2px' }, graph ? 'Uses the same validation and fixture matching as public HTTP/WS.' : 'Creates an identified local test session without a network client.')), button('Close', app.closeRealtimeTest, false, { compact: true })),
    graph
      ? h('div', { style: 'display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:10px' }, h('div', {}, label('Operation'), codeEditor(test.input, 8, (value) => { test.input = value; }, { language: 'graphql' })), h('div', {}, label('Variables'), codeEditor(test.variables, 8, (value) => { test.variables = value; }, { language: 'json' })))
      : h('div', {}, label(ep.protocol === 'socketio' ? 'Messages — [{ event, payload }]' : 'Messages — JSON array'), codeEditor(test.input, 7, (value) => { test.input = value; }, { language: 'json' })),
    h('div', { style: 'display:flex;justify-content:flex-end;margin-top:11px' }, button(graph ? 'Run operation' : 'Run flow', app.runRealtimeTest, true, { compact: true, icon: icons.replay })),
    test.error ? h('div', { style: 'margin-top:9px;font-size:12px;color:#cf8b7f' }, test.error) : null,
    output ? h('div', { style: 'margin-top:12px;background:#141210;border-radius:var(--radius-xs);padding:11px' }, codeBlock(JSON.stringify(output.messages || output, null, 2), { label: 'Test transcript', language: 'json', style: "margin:0;white-space:pre-wrap;word-break:break-word;font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.5;color:#cfc8bc" })) : null);
}

function settingsPanel(app, ep) {
  const cfg = ep.config.realtime;
  return h('div', { style: 'max-width:820px' },
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap' }, h('div', {}, h('h2', { style: 'margin:0;font-size:15px;color:#c9c2b6' }, 'Realtime settings'), h('p', { style: 'margin:4px 0 0;font-size:12px;color:#7a746a' }, 'Caps are enforced per endpoint. Payload previews are redacted and never retain complete over-limit messages.')), button('Save limits', app.saveRealtimeSettings, true, { compact: true, icon: icons.check })),
    h('div', { style: 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px' },
      h('div', {}, label('Max connections'), input(cfg.maxConnections, '100', (event) => { cfg.maxConnections = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace")),
      h('div', {}, label('Max message bytes'), input(cfg.maxMessageBytes, '1048576', (event) => { cfg.maxMessageBytes = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace")),
      h('div', {}, label('Messages retained / session'), input(cfg.maxMessagesPerSession, '1000', (event) => { cfg.maxMessagesPerSession = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace")),
      h('div', {}, label('Payload preview bytes'), input(cfg.maxPayloadCaptureBytes, '65536', (event) => { cfg.maxPayloadCaptureBytes = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace")),
      h('div', {}, label('Idle timeout ms'), input(cfg.idleTimeoutMs, '120000', (event) => { cfg.idleTimeoutMs = Number(event.target.value) || 0; }, "font-family:'IBM Plex Mono',monospace")),
      h('div', {}, label('Authentication source'), select({ value: cfg.authSource, options: [{ value: 'handshake', label: 'Handshake' }, { value: 'protocol_init', label: 'Protocol init' }, { value: 'both', label: 'Both (cumulative)' }], onPick: (value) => { cfg.authSource = value; } }))),
    h('div', { style: 'margin-top:11px' }, label('Allowed origins (one per line; * allows all)'), textarea((cfg.allowedOrigins || []).join('\n'), 'https://app.example.com\n*', (event) => { cfg._originsText = event.target.value; }, 3)),
    (ep.protocol === 'graphql' || ep.protocol === 'socketio') ? h('div', { style: 'margin-top:11px' }, label('Protocol credential path'), input(cfg.protocolAuthPath, 'authorization', (event) => { cfg.protocolAuthPath = event.target.value; }, "font-family:'IBM Plex Mono',monospace"), h('div', { style: 'font-size:11px;color:#6a655c;margin-top:6px' }, 'Reads a value from connection_init or handshake.auth, then applies the endpoint authentication method.')) : null,
    h('div', { style: 'display:flex;align-items:center;gap:12px;background:#141210;border-radius:var(--radius-xs);padding:11px 12px;margin-top:12px' }, toggle(!!cfg.messageRate.enabled, () => { cfg.messageRate.enabled = !cfg.messageRate.enabled; app.rerender(); }), h('div', { style: 'flex:1' }, h('div', { style: 'font-size:12.5px;font-weight:600;color:#d3ccc0' }, 'Message rate limit'), h('div', { style: 'font-size:11px;color:#6a655c;margin-top:2px' }, 'Prevent a connected client from flooding a session.')), input(cfg.messageRate.limit, '120', (event) => { cfg.messageRate.limit = Number(event.target.value) || 0; }, "width:92px;font-family:'IBM Plex Mono',monospace")),
    h('div', { style: 'margin-top:11px;max-width:220px' }, label('Rate window'), select({ value: cfg.messageRate.window, options: [{ value: 'second', label: 'Per second' }, { value: 'minute', label: 'Per minute' }, { value: 'hour', label: 'Per hour' }], onPick: (value) => { cfg.messageRate.window = value; } })),
    app.s.realtimeError ? h('div', { style: 'margin-top:9px;font-size:12px;color:#cf8b7f' }, app.s.realtimeError) : null);
}

export function realtimeScreen(app) {
  const ep = app.s.activeEp;
  if (!ep) return h('div', {});
  const graph = ep.protocol === 'graphql';
  const tabs = graph
    ? [['operations', 'Operations'], ['schema', 'Schema'], ['fixtures', 'Fixtures', (app.s.realtimeFixtures || []).length], ['subscriptions', 'Subscriptions'], ['history', 'History', (app.s.realtimeSessions || []).length], ['settings', 'Settings']]
    : [['sessions', 'Sessions', (app.s.realtimeSessions || []).length], ['messages', 'Messages'], ...(ep.type === 'mock' ? [['script', 'Script']] : []), ['settings', 'Settings']];
  let body;
  if (graph && app.s.realtimeTab === 'schema') body = schemaPanel(app);
  else if (graph && app.s.realtimeTab === 'fixtures') body = fixturesPanel(app, ep);
  else if (graph && app.s.realtimeTab === 'subscriptions') body = fixturesPanel(app, ep, true);
  else if (graph && app.s.realtimeTab === 'operations') body = testPanel(app, ep);
  else if (app.s.realtimeTab === 'settings') body = settingsPanel(app, ep);
  else if (!graph && app.s.realtimeTab === 'messages') body = h('div', {}, sessionsPanel(app, ep, true), testPanel(app, ep));
  else if (!graph && app.s.realtimeTab === 'script' && ep.type === 'mock') body = scriptsPanel(app, ep);
  else body = h('div', {}, sessionsPanel(app, ep), testPanel(app, ep));
  return h('div', { style: 'height:100%;overflow-y:auto' }, h('div', { style: 'max-width:980px;margin:0 auto;padding:22px 28px 64px' },
    h('button', { style: 'display:flex;align-items:center;gap:7px;background:transparent;color:#8a837a;font-size:13px;font-weight:500;padding:0;margin-bottom:18px', onclick: app.navMocks }, raw(icons.chevLeft({ w: 16, sw: 1.9 })), 'All Mock Servers'),
    h('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap' },
      h('div', { style: 'min-width:0' }, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, h('h1', { style: 'margin:0;font-size:23px;font-weight:600;color:#f2ede3;letter-spacing:-.02em' }, ep.name), h('span', { style: `font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:700;letter-spacing:.07em;color:${protocolColor(ep.protocol)};background:#191712;border-radius:4px;padding:4px 7px` }, protocolLabel(ep.protocol).toUpperCase()), h('span', { style: 'font-size:11.5px;color:#7a746a' }, ep.type === 'mock' ? 'Mock' : 'Inspector')), h('div', { style: 'font-size:12px;color:#7a746a;margin-top:5px' }, graph ? 'GraphQL HTTP + graphql-transport-ws subscriptions' : `${protocolLabel(ep.protocol)} endpoint · real-time transcript history`)),
      h('div', { style: 'display:flex;gap:8px' }, button('Test', app.openRealtimeTest, false, { compact: true, icon: icons.replay }), button('Security', app.navSettings, false, { compact: true, icon: icons.lock }), button('Settings', () => app.setRealtimeTab('settings'), false, { compact: true, icon: icons.gear }), kebabMenu({ open: app.s.dropdown === `epmenu-${ep.id}`, onToggle: () => app.setDropdown(`epmenu-${ep.id}`), onClose: () => app.closeDropdown(), items: endpointMenuItems(app, ep), size: 31, bg: '#211d17' }))),
    protocolConnectionCard(app, ep),
    h('div', { style: 'display:flex;align-items:center;gap:20px;box-shadow:inset 0 -1px 0 rgba(245,240,230,.07);margin-bottom:22px;overflow-x:auto;white-space:nowrap' }, ...tabs.map(([id, text, count]) => tabButton(app, id, text, count))),
    body));
}
