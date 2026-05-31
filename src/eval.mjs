// Pure retrieval-eval helpers — no I/O, no DB. Search results are injected.

const round = (x) => Number(x.toFixed(4));

// Parse search()'s "start-end" line string into [start, end].
// Tolerant of a single number ("7" -> [7,7]), surrounding whitespace, and a [s,e] array.
export function parseLines(s) {
  if (Array.isArray(s)) return [Number(s[0]), Number(s[1] ?? s[0])];
  const str = String(s).trim();
  const m = str.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(str);
  return Number.isFinite(n) ? [n, n] : [NaN, NaN];
}

// Inclusive range overlap: [as,ae] overlaps [bs,be] iff as <= be && bs <= ae.
export function overlaps(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

// Score one golden entry against a query's result list (ordered best-first).
// Returns { pageRank, secRank, hasLines } with 1-indexed ranks (null if no hit).
export function scoreGolden(results, entry) {
  const wanted = new Set((Array.isArray(entry.path) ? entry.path : [entry.path]).map(String));
  const hasLines = Array.isArray(entry.lines) && entry.lines.length === 2;
  let pageRank = null, secRank = null;
  for (let i = 0; i < results.length; i++) {
    const isPage = wanted.has(String(results[i].path));
    if (!isPage) continue;
    if (pageRank === null) pageRank = i + 1;
    if (hasLines && secRank === null && overlaps(parseLines(results[i].lines), entry.lines)) {
      secRank = i + 1;
    }
  }
  return { pageRank, secRank, hasLines };
}

// Aggregate per-query records into metrics. ks selects the reported cutoffs.
export function aggregate(records, ks = { recall: [1, 5, 10], sec: [1, 5] }) {
  const n = records.length;
  const recall = {};
  for (const k of ks.recall) {
    const hits = records.filter((r) => r.pageRank !== null && r.pageRank <= k).length;
    recall[k] = n ? round(hits / n) : 0;
  }
  const mrr = n
    ? round(records.reduce((s, r) => s + (r.pageRank ? 1 / r.pageRank : 0), 0) / n)
    : 0;
  const secRecords = records.filter((r) => r.hasLines);
  const nSec = secRecords.length;
  const sec_hit = {};
  for (const k of ks.sec) {
    sec_hit[k] = nSec
      ? round(secRecords.filter((r) => r.secRank !== null && r.secRank <= k).length / nSec)
      : null;
  }
  return { n, n_sec: nSec, recall, mrr, sec_hit };
}
