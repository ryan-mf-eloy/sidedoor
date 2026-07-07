// HTTP method + status colors, ported from the design so backend-computed
// labels can match the UI where needed. The frontend keeps its own copy.
export function methodColor(m) {
  return {
    GET: '#6a9fd4', POST: '#238636', PUT: '#d69a3c',
    PATCH: '#b28de0', DELETE: '#e5675c', HEAD: '#948d83', QUERY: '#4fb0a0',
  }[m] || '#948d83';
}

export function statusColor(c) {
  if (c >= 500) return '#e5675c';
  if (c >= 400) return '#d69a3c';
  if (c >= 300) return '#6a9fd4';
  if (c >= 200) return '#238636';
  return '#948d83';
}
