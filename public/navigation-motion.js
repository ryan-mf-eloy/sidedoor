// A view change is broader than a render: live updates and form edits should
// keep the current surface still, while route-level context changes may enter.
function valuePart(value) {
  return value == null ? '' : String(value);
}

export function navigationViewKey(state = {}) {
  return [
    valuePart(state.route),
    valuePart(state.activeWorkspace),
    valuePart(state.activeEp && state.activeEp.id),
    valuePart(state.activeReq && state.activeReq.id),
  ].join('|');
}

export function isNavigationChange(previousKey, nextKey) {
  return previousKey != null && previousKey !== nextKey;
}
