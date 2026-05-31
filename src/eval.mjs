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
  if (entry.path == null) throw new Error(`golden entry missing 'path': ${JSON.stringify(entry)}`);
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

// Flatten a metrics object to scalar { "recall@1": ..., mrr: ..., "sec_hit@1": ... }.
// Null sec_hit values (n_sec === 0) are omitted so they never read as regressions.
export function flattenMetrics(m) {
  const out = {};
  for (const k of Object.keys(m.recall || {})) out[`recall@${k}`] = m.recall[k];
  if (typeof m.mrr === "number") out.mrr = m.mrr;
  for (const k of Object.keys(m.sec_hit || {})) {
    if (m.sec_hit[k] !== null && m.sec_hit[k] !== undefined) out[`sec_hit@${k}`] = m.sec_hit[k];
  }
  return out;
}

// Return [{ metric, cur, base, delta }] for every metric that dropped by more than tol.
// A metric absent from the baseline is skipped (not a false regression).
export function compareBaseline(cur, base, tol = 0.005) {
  const c = flattenMetrics(cur), b = flattenMetrics(base);
  const regressions = [];
  for (const key of Object.keys(c)) {
    if (!(key in b)) continue;
    const delta = c[key] - b[key];
    if (delta < -tol) regressions.push({ metric: key, cur: c[key], base: b[key], delta: round(delta) });
  }
  return regressions;
}

// Run a golden set through an injected async searchFn(query, k) -> results[], score, aggregate.
// Each record carries its entry's tier (default "gate"); returns overall metrics + per-tier breakdown.
export async function evalGolden(golden, searchFn, { maxK = 10, ks } = {}) {
  if (!Array.isArray(golden) || golden.length === 0) throw new Error("golden set is empty");
  const records = [];
  for (const entry of golden) {
    const results = await searchFn(entry.query, maxK);
    const rec = scoreGolden(results, entry);
    rec.tier = entry.tier || "gate";
    records.push(rec);
  }
  const overall = aggregate(records, ks);
  const byTier = {};
  for (const tier of [...new Set(records.map((r) => r.tier))]) {
    byTier[tier] = aggregate(records.filter((r) => r.tier === tier), ks);
  }
  return { ...overall, byTier };
}

// Compare per-tier metrics. Returns regressions with metric names prefixed "<tier>:".
// A tier present in cur but absent from base is skipped (mirrors compareBaseline's missing-metric rule).
export function compareTiers(cur, base, tol = 0.005) {
  const out = [];
  const curTiers = cur.byTier || {};
  const baseTiers = base.byTier || {};
  for (const tier of Object.keys(curTiers)) {
    if (!(tier in baseTiers)) continue;
    for (const r of compareBaseline(curTiers[tier], baseTiers[tier], tol)) {
      out.push({ ...r, metric: `${tier}:${r.metric}` });
    }
  }
  return out;
}

// All regressions the CLI gates on: overall metrics plus every shared tier.
export function allRegressions(cur, base, tol = 0.005) {
  return [...compareBaseline(cur, base, tol), ...compareTiers(cur, base, tol)];
}
