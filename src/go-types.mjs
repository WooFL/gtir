// src/go-types.mjs — Go receiver-type resolution (pure). Three pieces:
//  - extractGoMethodDefs: regex a chunk's text into {type, method} pairs (builds the global index)
//  - inferReceiverType: walk a call's enclosing function for the receiver var's declared type
//  - resolveGoMethods: upgrade ambiguous Go method-call rows to resolved when the type pins the target

// Matches a Go method definition `func ([name] [*]Type) Method(`. The receiver name is optional
// (`func (*T) M()` is legal); pointer/value receivers both captured. A free function `func F(` has
// no receiver-paren group before the name, so it never matches.
const GO_METHOD_DEF = /func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/g;

export function extractGoMethodDefs(text) {
  const out = [];
  const s = String(text || "");
  GO_METHOD_DEF.lastIndex = 0;
  let m;
  while ((m = GO_METHOD_DEF.exec(s))) out.push({ type: m[1], method: m[2] });
  return out;
}

// Upgrade ambiguous Go method-call rows to resolved when the receiver type pins a unique target.
// Pure — returns a NEW array; only touches kind:"calls" conf:"ambiguous" isMethod rows that carry a
// receiverType. 0 or >1 matching defs → left ambiguous (don't guess). Mirrors disambiguateEdges' shape.
export function resolveGoMethods(rows, goMethodIndex) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    const defs = goMethodIndex.get(`${r.receiverType}#${r.ref_name}`);
    if (!defs || defs.length !== 1) return r;
    const d = defs[0];
    return { ...r, conf: "resolved", to_path: d.path, to_symbol: r.ref_name,
      to_lines: `${d.line_start}-${d.line_end}`, candidates: [] };
  });
}
