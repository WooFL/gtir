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

// Is the expected edge present among the extracted edges, and is it resolved?
export function scoreEdgeGolden(edges, entry) {
  const match = edges.find((e) =>
    e.kind === entry.kind &&
    e.from_path === entry.from &&
    (entry.symbol == null || e.to_symbol === entry.symbol) &&
    (entry.to == null || e.to_path === entry.to));
  return { found: !!match, resolved: !!match && match.conf === "resolved" };
}

// Recall over a golden set of expected edges + the resolved/ambiguous/external split of all edges.
export function evalEdges(edges, golden) {
  const found = golden.filter((g) => scoreEdgeGolden(edges, g).found).length;
  const recall = golden.length ? round(found / golden.length) : 0;
  const split = { resolved: 0, inferred: 0, ambiguous: 0, external: 0 };
  for (const e of edges) if (e.conf in split) split[e.conf]++;
  return { recall, n: golden.length, found, split };
}

// Classify one golden call edge against the extracted edge set: correct / wrong / missing.
// `missing` = extraction never produced the call (extraction-failure axis);
// `wrong`   = produced but resolved to the wrong target (resolution-failure axis);
// `correct` = a produced edge hits `g.to` (or is external/unresolved (ambiguous) when `g.to` is null). `inferred` counts.
export function scoreEdge(edges, g) {
  const produced = edges.filter((e) => e.kind === g.kind && e.from_path === g.from && e.ref_name === g.symbol);
  if (!produced.length) return "missing";
  const hit = produced.some((e) => (g.to == null ? (e.conf === "external" || !e.to_path) : e.to_path === g.to));
  return hit ? "correct" : "wrong";
}

// Per-edge correctness over a call-edge golden. byLang is keyed by the caller file's extension.
// Returns { n, tally, byLang, split, recall, wrong_rate, missing_rate } — the three rates sum to 1.
export function evalEdgeExtraction(edges, golden) {
  const tally = { correct: 0, wrong: 0, missing: 0 };
  const byLang = {};
  for (const g of golden) {
    const r = scoreEdge(edges, g);
    tally[r]++;
    const lang = g.from.includes(".") ? g.from.split(".").pop() : "?";
    (byLang[lang] ??= { correct: 0, wrong: 0, missing: 0, n: 0 });
    byLang[lang][r]++;
    byLang[lang].n++;
  }
  const denom = golden.length || 1;
  const split = { resolved: 0, inferred: 0, ambiguous: 0, external: 0 };
  for (const e of edges) if (e.conf in split) split[e.conf]++;
  return {
    n: golden.length,
    tally,
    byLang,
    split,
    recall: round(tally.correct / denom),
    wrong_rate: round(tally.wrong / denom),
    missing_rate: round(tally.missing / denom),
  };
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

// Classify one golden ambiguous-call entry against the replayed edge set.
// g = { from, symbol, expect }: expect = correct target path (positive) or null (should abstain).
// → "tp" (positive promoted to expect) | "fp" (positive promoted elsewhere, or negative promoted)
//   | "fn" (positive not promoted) | "tn" (negative not promoted).
export function scoreDisambig(edges, g) {
  const e = edges.find((x) => x.kind === "calls" && x.from_path === g.from && x.ref_name === g.symbol);
  const promoted = !!e && e.conf === "inferred";
  if (g.expect == null) return promoted ? "fp" : "tn";
  if (!promoted) return "fn";
  return e.to_path === g.expect ? "tp" : "fp";
}

// Precision-first aggregation over a disambiguation golden. precision is the gated metric;
// recall + abstain_rate are reported meters. No promotions ⇒ precision 1.0 (vacuously correct).
export function evalDisambiguation(edges, golden) {
  const cells = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let positives = 0, negatives = 0;
  for (const g of golden) {
    (g.expect == null ? negatives++ : positives++);
    cells[scoreDisambig(edges, g)]++;
  }
  const promotions = cells.tp + cells.fp;
  return {
    n: golden.length, cells, promotions,
    precision: round(promotions ? cells.tp / promotions : 1),
    recall: round(positives ? cells.tp / positives : 0),
    abstain_rate: round(negatives ? cells.tn / negatives : 1),
  };
}

// Rank sweep rows precision-first: prefer precision===1, then higher recall, then higher precision,
// then lower threshold, then lower margin. rows: [{ threshold, margin, precision, recall, promotions }].
export function rankDisambigOperatingPoint(rows) {
  return [...rows].sort((a, b) => {
    const pa = a.precision === 1 ? 1 : 0, pb = b.precision === 1 ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (b.recall !== a.recall) return b.recall - a.recall;
    if (b.precision !== a.precision) return b.precision - a.precision;
    if (a.threshold !== b.threshold) return a.threshold - b.threshold;
    return a.margin - b.margin;
  });
}

// Score orphans output against a golden of expected buckets. golden = [{ path, symbol, expect }],
// expect ∈ {"likely_dead","possible_entrypoint"}. A golden symbol the tool placed in NEITHER bucket
// (it had an inbound edge → not an orphan candidate) is "missing". false_dead (expected entrypoint,
// reported dead) is the precision-first failure to gate on.
export function evalOrphans(result, golden) {
  const dead = new Set((result.likely_dead || []).map((d) => `${d.path}#${d.symbol}`));
  const entry = new Set((result.possible_entrypoint || []).map((d) => `${d.path}#${d.symbol}`));
  let correct = 0, false_dead = 0, false_entrypoint = 0, missing = 0;
  for (const g of golden) {
    const key = `${g.path}#${g.symbol}`;
    const actual = dead.has(key) ? "likely_dead" : entry.has(key) ? "possible_entrypoint" : "missing";
    if (actual === "missing") missing++;
    else if (actual === g.expect) correct++;
    else if (g.expect === "possible_entrypoint") false_dead++;   // expected entry, got dead
    else false_entrypoint++;                                      // expected dead, got entry
  }
  const n = golden.length;
  return { n, correct, false_dead, false_entrypoint, missing, accuracy: n ? round(correct / n) : 0 };
}
