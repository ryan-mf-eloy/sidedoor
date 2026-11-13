import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isNavigationChange, navigationViewKey } from '../public/navigation-motion.js';

const navigationStyles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

function view(overrides = {}) {
  return {
    route: 'mock', activeWorkspace: 'workspace-a', activeEp: { id: 'endpoint-a' },
    mockTab: 'config', realtimeTab: 'sessions', settingsTab: 'auth', detailTab: 'body',
    mockReqTab: 'body', activeReq: null, mockReqSelected: null,
    selectedDeliveryRun: null, realtimeSelectedSession: null,
    ...overrides,
  };
}

test('navigation view key distinguishes every navigable context', () => {
  const base = navigationViewKey(view());
  const changes = [
    view({ route: 'settings' }),
    view({ activeWorkspace: 'workspace-b' }),
    view({ activeEp: { id: 'endpoint-b' } }),
    view({ activeReq: { id: 'request-a' } }),
  ];

  for (const next of changes) assert.notEqual(navigationViewKey(next), base);
});

test('tabs and local detail panels stay within the current view', () => {
  const base = navigationViewKey(view());
  const localInteractions = [
    view({ mockTab: 'requests' }),
    view({ realtimeTab: 'messages' }),
    view({ settingsTab: 'rate' }),
    view({ detailTab: 'headers' }),
    view({ mockReqTab: 'response' }),
    view({ mockReqSelected: { id: 'mock-request-a' } }),
    view({ selectedDeliveryRun: { id: 'run-a' } }),
    view({ realtimeSelectedSession: { id: 'session-a' } }),
  ];

  for (const next of localInteractions) assert.equal(navigationViewKey(next), base);
});

test('only a later, distinct view is treated as navigation', () => {
  const current = navigationViewKey(view());
  assert.equal(isNavigationChange(null, current), false);
  assert.equal(isNavigationChange(current, current), false);
  assert.equal(isNavigationChange(current, navigationViewKey(view({ mockTab: 'requests' }))), false);
  assert.equal(isNavigationChange(current, navigationViewKey(view({ route: 'settings' }))), true);
});

test('navigation styles keep the screen visible and sidebar links marker-free', () => {
  assert.doesNotMatch(navigationStyles, /@keyframes sd-route-enter\s*\{[^}]*opacity\s*:/);
  assert.doesNotMatch(navigationStyles, /@keyframes sd-navigation-chrome-enter\s*\{[^}]*opacity\s*:/);
  assert.doesNotMatch(navigationStyles, /sd-nav-button--active|sd-nav-button-active|box-shadow:\s*inset\s+2px\s+0/);
});
