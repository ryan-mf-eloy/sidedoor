// Unified line diff via LCS dynamic programming. Ported from the design's
// diffLines(); produces context/add/delete rows with A/B line numbers.
export function diffLines(aStr, bStr) {
  const a = String(aStr == null ? '' : aStr).split('\n');
  const b = String(bStr == null ? '' : bStr).split('\n');
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, an = 1, bn = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i], an: an++, bn: bn++ }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i], an: an++, bn: '' }); i++; }
    else { out.push({ type: 'add', text: b[j], an: '', bn: bn++ }); j++; }
  }
  while (i < m) { out.push({ type: 'del', text: a[i], an: an++, bn: '' }); i++; }
  while (j < n) { out.push({ type: 'add', text: b[j], an: '', bn: bn++ }); j++; }
  return out;
}

export function diffSummary(rows) {
  let add = 0, del = 0;
  for (const r of rows) { if (r.type === 'add') add++; else if (r.type === 'del') del++; }
  return { add, del };
}
