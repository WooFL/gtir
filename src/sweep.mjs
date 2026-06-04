// Fusion-weight sweep for `gtir eval --tune`. Pure: no DB, no I/O, no embed calls.
// The eval + per-combo search functions are injected, mirroring eval.mjs, so the whole
// grid/ranking core is unit-testable without Ollama or LanceDB. The CLI (bin/gtir.mjs)
// supplies a real searchFnFor(weights) that re-runs search() with cfg fusion-weight
// overrides against an already-built index — fusion is a query-time step, so one index
// build serves every combo.

// Cartesian product of named numeric axes, axis order preserved.
//   gridCombos({ ftsWeight: [0, 0.1], ftsWeightMixed: [0.3] })
//   -> [{ ftsWeight: 0, ftsWeightMixed: 0.3 }, { ftsWeight: 0.1, ftsWeightMixed: 0.3 }]
// An empty/non-object axes set (or one whose every axis is empty) yields a single empty combo.
export function gridCombos(axes) {
  let combos = [{}];
  for (const key of Object.keys(axes || {})) {
    const vals = axes[key];
    if (!Array.isArray(vals) || vals.length === 0) continue;
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [key]: v })));
  }
  return combos;
}

// Parse a CLI grid spec into an axes object:
//   "ftsWeight=0,0.1,0.2;ftsWeightMixed=0.3" -> { ftsWeight: [0,0.1,0.2], ftsWeightMixed: [0.3] }
// Axes are ';'-separated, values ','-separated. Empty/falsey input -> {} (caller picks a default grid).
// Throws on a malformed axis or a non-numeric value so a typo fails loudly instead of silently
// sweeping nothing.
export function parseGridSpec(spec) {
  const axes = {};
  for (const part of String(spec || "").split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq < 1) throw new Error(`bad sweep axis (want key=v1,v2,...): "${s}"`);
    const key = s.slice(0, eq).trim();
    const vals = s.slice(eq + 1).split(",").map((x) => Number(x.trim()));
    if (!key || vals.length === 0 || vals.some((v) => !Number.isFinite(v))) {
      throw new Error(`bad sweep axis values (want finite numbers): "${s}"`);
    }
    axes[key] = vals;
  }
  return axes;
}

// Run evalFn once per weight combo, serially (the injected search reuses a shared query-embed
// cache, so concurrency would only thrash it). searchFnFor(weights) -> async (query, k) => results;
// evalFn(golden, searchFn, { maxK }) -> metrics (eval.mjs's evalGolden shape).
// Returns [{ weights, metrics }] in combo order. onProgress(i, n, weights) is called before each run.
export async function sweepWeights(golden, combos, searchFnFor, evalFn, { maxK = 10, onProgress = null } = {}) {
  const rows = [];
  for (let i = 0; i < combos.length; i++) {
    const weights = combos[i];
    if (onProgress) onProgress(i, combos.length, weights);
    const metrics = await evalFn(golden, searchFnFor(weights), { maxK });
    rows.push({ weights, metrics });
  }
  return rows;
}

// Objective for ranking a combo, as a tuple compared lexicographically, all higher-is-better:
// overall MRR first (rank quality across the whole set), then recall@1, then recall@5 as tiebreaks.
// MRR leads because it moves on every rank change, not just the @1 boundary, so it discriminates
// combos the coarse recall@k buckets tie.
export function defaultObjective(m) {
  const r = (m && m.recall) || {};
  return [m && m.mrr || 0, r[1] || 0, r[5] || 0];
}

// Stable sort of sweep rows best-first by objectiveOf(metrics) -> number | number[].
// Ties keep input (combo) order, so the first-listed equal combo (typically the lower weight)
// wins — preferring the simpler/cheaper setting when nothing separates them.
export function rankSweep(rows, objectiveOf = defaultObjective) {
  const asTuple = (x) => (Array.isArray(x) ? x : [x]);
  const cmp = (a, b) => {
    const x = asTuple(objectiveOf(a.metrics)), y = asTuple(objectiveOf(b.metrics));
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] || 0) - (x[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  return rows.map((r, i) => [r, i])
    .sort((p, q) => cmp(p[0], q[0]) || (p[1] - q[1]))
    .map(([r]) => r);
}

// Format a weights object as a compact stable key: "ftsWeight=0,ftsWeightMixed=0.3".
export function weightsKey(w) {
  return Object.keys(w || {}).map((k) => `${k}=${w[k]}`).join(",") || "(defaults)";
}
