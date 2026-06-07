// src/disambiguate.mjs — pure embedding-disambiguation of ambiguous call edges.
import { stripExt } from "./edges.mjs";

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

// Common container / iterator / promise / event / test-framework method names. A member-call
// (receiver.method()) to one of these is almost never resolvable by bare-name matching: the real
// target is the receiver's class method, which name-matching can't find — the candidate set is noise
// and embedding similarity just picks the least-wrong. Leave such calls ambiguous, do not promote.
const DENY_METHODS = new Set([
  "get", "set", "has", "delete", "add", "clear", "find", "findIndex", "findLast",
  "filter", "map", "flatMap", "forEach", "reduce", "reduceRight", "some", "every",
  "includes", "indexOf", "lastIndexOf", "push", "pop", "shift", "unshift", "slice",
  "splice", "concat", "join", "split", "sort", "reverse", "fill", "keys", "values", "entries",
  "next", "then", "catch", "finally",
  "on", "off", "emit", "once", "addListener", "removeListener", "addEventListener", "removeEventListener", "dispatchEvent",
  "toString", "valueOf", "hasOwnProperty", "call", "apply", "bind",
  "mock", "spy", "fn", "mockReturnValue", "mockResolvedValue", "mockImplementation",
]);

// Promote ambiguous `calls` rows to conf:"inferred" when embedding similarity confidently picks one
// candidate. Pure — returns a NEW array; non-calls / non-ambiguous rows pass through unchanged.
// ctx: { symbolIndex: Map(name → [{path,line_start,line_end,embedding,content_hash}]),
//        callSiteVec: Map(content_hash → embedding), threshold = 0.55, margin = 0.05 }
export function disambiguateEdges(rows, { symbolIndex, callSiteVec, importMap, threshold = 0.55, margin = 0.05 } = {}) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous") return r;
    if (r.isMethod && DENY_METHODS.has(r.ref_name)) return r; // structural filter: leave ambiguous
    const callVec = callSiteVec?.get(r.content_hash);
    if (!callVec) return r;
    // Import-reachability pre-filter: a candidate is eligible only if it is the same file as the call
    // site, or the call-site file directly imports it. importMap absent → no filter (backward-compatible).
    const imports = importMap?.get(r.from_path);
    const eligible = importMap
      ? (p) => p === r.from_path || (imports != null && imports.has(stripExt(p)))
      : () => true;
    const defs = symbolIndex?.get(r.ref_name) || [];
    const scored = (r.candidates || []).filter(eligible).map((path) => {
      let sim = -1, def = null;
      for (const d of defs) {
        if (d.path !== path || !d.embedding) continue;
        // Skip a def that IS the call-site chunk: cosine(chunk, itself) ≈ 1.0 is a degenerate signal,
        // not evidence — it's almost always a method/builtin name colliding with a same-chunk decl.
        if (d.content_hash && d.content_hash === r.content_hash) continue;
        const s = cosine(callVec, d.embedding);
        if (s > sim) { sim = s; def = d; }
      }
      return { path, sim, def };
    }).filter((c) => c.def).sort((a, b) => b.sim - a.sim);
    if (!scored.length) return r;
    const [top, second] = scored;
    const passesMargin = !second || (top.sim - second.sim) >= margin;
    if (top.sim >= threshold && passesMargin) {
      return { ...r, conf: "inferred", to_path: top.path, to_symbol: r.ref_name,
        to_lines: `${top.def.line_start}-${top.def.line_end}`,
        score: Number(top.sim.toFixed(4)), candidates: [] };
    }
    return r;
  });
}
