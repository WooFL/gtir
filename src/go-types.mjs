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
