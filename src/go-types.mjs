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

// The Go type name a type node denotes, or null for non-local-named types (qualified, slice, map,
// interface, func, etc.). Pointer types unwrap to their element type.
function goTypeName(t) {
  if (!t) return null;
  if (t.type === "pointer_type") return goTypeName(t.namedChild(0));
  if (t.type === "type_identifier") return t.text;
  return null;
}

// Add every (name → goTypeName(type)) binding declared by a parameter_declaration or var_spec node.
// Both shapes are: one or more identifier children + a `type` field. `:=` (short_var_declaration) is
// a different node type and is intentionally never visited here.
function addBinding(decl, bindings) {
  const tn = goTypeName(decl.childForFieldName?.("type"));
  if (!tn) return;
  for (let i = 0; i < decl.namedChildCount; i++) {
    const c = decl.namedChild(i);
    if (c.type === "identifier") bindings.set(c.text, tn);
  }
}

// Collect all explicit single-hop type bindings visible in a function/method node: its receiver and
// parameters (parameter_declaration) and its body's `var` specs (var_spec). Nested func-literal
// scopes are NOT descended into — a same-name closure param must not shadow an outer binding (that
// would be a false-positive resolution, not just a miss).
function collectGoBindings(fn) {
  const bindings = new Map();
  const stack = [fn];
  while (stack.length) {
    const n = stack.pop();
    if (n !== fn && n.type === "func_literal") continue; // don't bleed nested-closure scopes
    if (n.type === "parameter_declaration" || n.type === "var_spec") addBinding(n, bindings);
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return bindings;
}

// Infer the Go type of `receiverName` at a call site by walking the call's enclosing function for an
// explicit binding (typed param, `var` decl, or the method's own receiver). Returns the type name or
// null. receiverName must be a plain identifier (chained/qualified receivers are passed as null).
export function inferReceiverType(callNode, receiverName) {
  if (!callNode || !receiverName) return null;
  let fn = callNode.parent;
  while (fn && fn.type !== "function_declaration" && fn.type !== "method_declaration") fn = fn.parent;
  if (!fn) return null;
  return collectGoBindings(fn).get(receiverName) ?? null;
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
