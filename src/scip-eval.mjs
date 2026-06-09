// Cross-check gtir resolved member-call edges against a SCIP oracle. Pure.
// Precision = correct / (correct + wrong) over gtir edges that have a SCIP truth.
// Recall    = correct / |SCIP member-refs with an in-repo def| (the honest denominator).

export function normPath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function basename(p) {
  const s = normPath(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

// True when two paths name the same file despite different relative roots
// (SCIP is package-relative, gtir is repo-relative): the longer ends with "/<shorter>".
function pathsMatch(a, b) {
  const x = normPath(a), y = normPath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [lo, sh] = x.length >= y.length ? [x, y] : [y, x];
  return lo.endsWith("/" + sh);
}

function parseLines(s) {
  const m = String(s ?? "").match(/(\d+)\s*-\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2])];
  const n = Number(s);
  return Number.isFinite(n) ? [n, n] : null;
}

function refId(r) {
  return `${r.symbol}@${r.file}:${r.line}`;
}

export function scipCrossCheck(gtirEdges, oracle, { sampleN = 10 } = {}) {
  // Index SCIP member-refs by (method, basename) for alignment.
  const refIndex = new Map();
  for (const ref of oracle.memberRefs) {
    const key = ref.method + " " + basename(ref.file);
    let arr = refIndex.get(key);
    if (!arr) { arr = []; refIndex.set(key, arr); }
    arr.push(ref);
  }

  let correct = 0, wrong = 0, external = 0, unaligned = 0;
  const samples = { wrong: [], external: [], unaligned: [], missed: [] };
  const recalledRefs = new Set(); // refIds gtir resolved correctly (for recall + missed)

  for (const e of gtirEdges) {
    const callerLine = parseLines(e.from_lines)?.[0];
    const key = e.ref_name + " " + basename(e.from_path);
    const cands = refIndex.get(key) ?? [];
    const ref = callerLine == null
      ? undefined
      : cands.find((r) => Math.abs(callerLine - r.line) <= 1);

    if (!ref) {
      unaligned++;
      if (samples.unaligned.length < sampleN)
        samples.unaligned.push({ from: e.from_path, line: e.from_lines, method: e.ref_name, gtirTo: e.to_path });
      continue;
    }
    if (!ref.defTarget) {
      external++;
      if (samples.external.length < sampleN)
        samples.external.push({ from: e.from_path, method: e.ref_name, gtirTo: e.to_path, symbol: ref.symbol });
      continue;
    }

    const def = ref.defTarget;
    const defLine1 = def.startLine + 1;
    const lines = parseLines(e.to_lines);
    let ok = pathsMatch(e.to_path ?? "", def.file) && !!lines && lines[0] <= defLine1 && defLine1 <= lines[1];
    // dispatch tier resolves to no single file — accept if SCIP's def is among its candidates.
    if (!ok && e.conf === "dispatch" && Array.isArray(e.candidates))
      ok = e.candidates.some((c) => pathsMatch(c, def.file));

    if (ok) {
      correct++;
      recalledRefs.add(refId(ref));
    } else {
      wrong++;
      if (samples.wrong.length < sampleN)
        samples.wrong.push({
          from: e.from_path, line: e.from_lines, method: e.ref_name,
          gtirTo: `${e.to_path} ${e.to_lines}`, scipTo: `${def.file}:${defLine1}`,
        });
    }
  }

  const resolvable = oracle.memberRefs.filter((r) => r.defTarget);
  for (const r of resolvable) {
    if (!recalledRefs.has(refId(r)) && samples.missed.length < sampleN)
      samples.missed.push({ at: `${r.file}:${r.line}`, method: r.method, shouldResolveTo: `${r.defTarget.file}:${r.defTarget.startLine + 1}` });
  }

  const resolvableTotal = resolvable.length;
  return {
    precision: (correct + wrong) ? correct / (correct + wrong) : null,
    recall: resolvableTotal ? correct / resolvableTotal : null,
    correct, wrong, external, unaligned,
    resolvableTotal,
    gtirResolvedTotal: gtirEdges.length,
    samples,
  };
}
