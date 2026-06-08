// src/callstats.mjs — member-call resolution classifier (PURE, no I/O).
//
// memberCallStats(rows, { sets, lang }) reports, over a repo's MEMBER-call edges (kind "calls" &&
// isMethod), the resolution rate + the conf split + a classifier of WHY each unresolved member-call
// stayed ambiguous. The resolution rate (resolved+dispatch / total member-calls) is exactly the
// receiver-type arc's reach — member calls are never import-resolved, so anything that left the
// ambiguous bucket did so via the receiver-type resolver chain.
//
// `sets` carries the in-repo type/method universe the classifier needs to distinguish
// receiver-external (a type we never declared) from method-external (an in-repo type whose method
// we don't define): { types: Set<typeName>, methods: Map<typeName, Set<methodName>> }. The
// indexer's collect seam builds these from the same per-language indexes the resolvers use, so the
// classifier stays a pure function of the rows + sets (the indexer collect seam is impure; this is not).

// Caller-file extension (the part after the final dot, lowercased), or "" when none. Keys by_lang and
// drives the --lang filter — "caller-file extension" per the design (ts, tsx, cpp, cc, go, …). Kept a
// plain string op so this module imports nothing and stays pure.
function fileExt(p) {
  const s = String(p ?? "");
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// Empty per-language (and overall) accumulator.
function emptyBucket() {
  return {
    total_member_calls: 0,
    resolved: 0,
    external: 0,
    inferred: 0,
    rate: 0,
    by_reason: {
      "no-enclosing-class": 0,
      "receiver-untyped": 0,
      "receiver-external": 0,
      "method-external": 0,
      "multi-candidate": 0,
      other: 0,
    },
  };
}

// Classify ONE ambiguous member-call row into a by_reason key. FIRST MATCH WINS, in the order the
// design pins. Predicates use only fields present on the in-memory resolved row (src/edges.mjs row()):
//   receiver        — the receiver identifier ("obj", "this") or null for a chained/non-id receiver
//   receiverType    — the inferred receiver type name, or null (cpp/go/ts inference)
//   enclosingClass  — the class owning `this` at the call site. POPULATED ONLY for C++ rows
//                     (extractCodeEdges sets it for langId "cpp"); null for go/ts even inside a class.
//   candidates      — the ambiguous candidate file set
// Because enclosingClass is cpp-only, no-enclosing-class vs receiver-untyped is a meaningful split
// ONLY for C++ callers; for go/ts an untyped receiver always lands in no-enclosing-class (enclosingClass
// is null there). We do NOT invent a scope field — see the design note. The split is honest where the
// data supports it (C++) and collapses where it doesn't, which is the documented behavior.
function classifyAmbiguous(r, sets) {
  const recv = r.receiver ?? null;
  const rt = r.receiverType ?? null;
  const candCount = r.candidates?.length ?? 0;

  // no-enclosing-class: a member call whose receiver has no class/local type context — receiver
  // present, receiverType null, and no enclosing class binding.
  if (recv && !rt && !r.enclosingClass) return "no-enclosing-class";

  // receiver-untyped: receiver present, receiverType null, but inside a class/function scope
  // (enclosingClass present — currently C++ only). Distinct from no-enclosing-class by the scope.
  if (recv && !rt && r.enclosingClass) return "receiver-untyped";

  // receiver-external: a receiver type that is NOT an in-repo declared class/type (e.g. std::vector).
  if (rt && !sets.types.has(rt)) return "receiver-external";

  // method-external: an in-repo receiver type, but the called method isn't defined on it in-repo.
  if (rt && sets.types.has(rt) && !(sets.methods.get(rt)?.has(r.ref_name))) return "method-external";

  // multi-candidate: still ambiguous across >1 candidate file (resolved to no unique target).
  if (candCount > 1) return "multi-candidate";

  // other: matched none — kept visible, never silently dropped.
  return "other";
}

// Fold one member-call row into a bucket (mutates the bucket).
function tally(bucket, r, sets) {
  bucket.total_member_calls++;
  if (r.conf === "resolved" || r.conf === "dispatch") bucket.resolved++;
  else if (r.conf === "external") bucket.external++;
  else if (r.conf === "inferred") bucket.inferred++;
  else if (r.conf === "ambiguous") bucket.by_reason[classifyAmbiguous(r, sets)]++;
  else bucket.by_reason.other++;   // an unexpected conf — keep it visible rather than drop the row
}

// Finalize a bucket: compute rate = resolved / total (0 when no member calls).
function finalize(bucket) {
  bucket.rate = bucket.total_member_calls > 0 ? bucket.resolved / bucket.total_member_calls : 0;
  return bucket;
}

// Pure classifier. rows: the in-memory resolved edge rows (from the indexEdges collect seam). Returns
// { total_member_calls, resolved, external, inferred, rate, by_reason, by_lang }. by_lang is keyed by
// caller-file extension → the same shape (no nested by_lang). When `lang` is given, the population is
// restricted to caller files of that extension. `sets` defaults to an empty universe (everything
// receiver-typed then reads as receiver-external) so the function is callable without it.
export function memberCallStats(rows, { sets, lang } = {}) {
  const universe = {
    types: sets?.types ?? new Set(),
    methods: sets?.methods ?? new Map(),
  };
  const overall = emptyBucket();
  const byLang = new Map();

  for (const r of rows ?? []) {
    if (r.kind !== "calls" || !r.isMethod) continue;
    const ext = fileExt(r.from_path);
    if (lang && ext !== lang) continue;
    tally(overall, r, universe);
    let lb = byLang.get(ext);
    if (!lb) { lb = emptyBucket(); byLang.set(ext, lb); }
    tally(lb, r, universe);
  }

  finalize(overall);
  const by_lang = {};
  for (const [ext, b] of byLang) by_lang[ext] = finalize(b);

  return {
    total_member_calls: overall.total_member_calls,
    resolved: overall.resolved,
    external: overall.external,
    inferred: overall.inferred,
    rate: overall.rate,
    by_reason: overall.by_reason,
    by_lang,
  };
}
