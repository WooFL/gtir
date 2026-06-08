// src/cpp-types.mjs — C++ receiver-type resolution (pure). Three pieces:
//  - extractCppMethodDefs: regex a chunk's text into {cls, method} method-definition pairs
//  - inferCppReceiverType: walk a call's enclosing function for the receiver var's declared type
//  - resolveCppMethods: upgrade ambiguous C++ member-call rows to resolved when the type pins one file

// Out-of-class definition: `RetType Class::method(params) [quals] {`. The trailing `{` body
// requirement excludes calls (`std::move(x)`) and prototypes (`Class::method();`).
// Params use `[^;{}()]*` (no nested parens) — linear (ReDoS-safe) and it rejects `if (C::m()) {`;
// a def whose params themselves contain parens (fn-pointer / std::function) is a graceful miss.
const CPP_OUT_DEF = /([A-Za-z_]\w*)\s*::\s*([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const|noexcept|override|final|mutable|volatile|\s)*\{/g;
// In-class inline definition: `method(params) [quals] {` inside a `class|struct Name { … }` chunk.
const CPP_IN_DEF = /(?:^|[\s;{}*&])([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const|noexcept|override|final|mutable|volatile|\s)*\{/g;
const CPP_CLASS = /\b(?:class|struct)\s+([A-Za-z_]\w*)/;
const CPP_CTRL = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "do"]);

export function extractCppMethodDefs(text) {
  const s = String(text || "");
  const out = [];
  CPP_OUT_DEF.lastIndex = 0;
  let m;
  while ((m = CPP_OUT_DEF.exec(s))) out.push({ cls: m[1], method: m[2] });
  const cm = s.match(CPP_CLASS);
  if (cm) {
    const cls = cm[1];
    CPP_IN_DEF.lastIndex = 0;
    let im;
    while ((im = CPP_IN_DEF.exec(s))) {
      if (im[1] !== cls && !CPP_CTRL.has(im[1])) out.push({ cls, method: im[1] });
    }
  }
  return out;
}

// Wrapper templates whose `ptr->method()` forwards to the element type's method. Std smart pointers
// universally do; a project adds custom forwarders (e.g. AEFX_SuiteScoper) via cfg.cppSmartPointers.
export const DEFAULT_SMART_PTRS = new Set(["unique_ptr", "shared_ptr", "weak_ptr"]);

// The element type of an allowlisted wrapper template, or null. Handles `unique_ptr<Foo>` (template_type)
// and `std::unique_ptr<Foo>` (qualified_identifier wrapping one). Element must be a bare type_identifier.
function templateElement(typeNode, smartPtrs) {
  let tt = typeNode;
  if (tt.type === "qualified_identifier") tt = tt.childForFieldName?.("name");
  if (!tt || tt.type !== "template_type") return null;
  const nm = tt.childForFieldName?.("name");
  if (!nm || !smartPtrs.has(nm.text)) return null;
  const args = tt.childForFieldName?.("arguments");
  for (let i = 0; i < (args?.namedChildCount ?? 0); i++) {
    const a = args.namedChild(i);
    if (a.type === "type_descriptor") {
      const t = a.childForFieldName?.("type");
      return t && t.type === "type_identifier" ? t.text : null;
    }
  }
  return null;
}

// The member-access operator of a call's field_expression callee: "->" | "." | null.
function memberOperator(callNode) {
  const fe = callNode?.childForFieldName?.("function");
  if (!fe || fe.type !== "field_expression") return null;
  for (let i = 0; i < fe.childCount; i++) {
    const t = fe.child(i).type;
    if (t === "->" || t === ".") return t;
  }
  return null;
}

// The identifier a C++ declarator ultimately names, recursing through pointer/reference/init
// declarators: `* f` → f, `& g` → g, `* p = …` → p, `h` → h.
function declName(decl) {
  if (!decl) return null;
  if (decl.type === "identifier") return decl.text;
  const inner = decl.childForFieldName?.("declarator") || decl.namedChild(0);
  return inner && inner !== decl ? declName(inner) : null;
}

// Add a (name → {type, smartPtr}) binding from a parameter_declaration or declaration node. The type
// is the `type` field; a bare `type_identifier` yields a plain binding; an allowlisted template
// (unique_ptr<Foo>) yields a smartPtr binding with the element type. Others → deferred (no binding).
// Note: a multi-declarator `Foo a, b;` binds only the first name (childForFieldName returns one) —
// the rest are an accepted miss (null receiverType → no resolution, never a wrong one).
function addCppBinding(node, bindings, smartPtrs) {
  const type = node.childForFieldName?.("type");
  if (!type) return;
  const name = declName(node.childForFieldName?.("declarator"));
  if (!name) return;
  if (type.type === "type_identifier") { bindings.set(name, { type: type.text, smartPtr: false }); return; }
  const elem = templateElement(type, smartPtrs);
  if (elem) bindings.set(name, { type: elem, smartPtr: true });
}

// Collect explicit type bindings in a function_definition: its parameters + body declarations. Does
// NOT descend into lambda_expression, so a lambda's params never overwrite an outer binding — outer
// calls stay correctly typed. Known limitation: a call INSIDE a lambda still sees the outer bindings
// (the enclosing-function walk passes through the lambda); same trade-off as the Go resolver.
function collectCppBindings(fn, smartPtrs) {
  const bindings = new Map();
  const stack = [fn];
  while (stack.length) {
    const n = stack.pop();
    if (n !== fn && n.type === "lambda_expression") continue;
    if (n.type === "parameter_declaration" || n.type === "declaration") addCppBinding(n, bindings, smartPtrs);
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return bindings;
}

// The class name owning `this` at a call site: the enclosing out-of-class def's `Class::method`
// scope, else the nearest enclosing class_specifier's name. Null if neither.
function enclosingCppClass(callNode, fn) {
  const fdecl = fn?.childForFieldName?.("declarator");          // function_declarator
  const qual = fdecl?.childForFieldName?.("declarator");        // qualified_identifier | identifier
  if (qual?.type === "qualified_identifier") {
    const name = qual.childForFieldName?.("name");
    const scope = qual.childForFieldName?.("scope");
    // Simple `Class::method` (name is a plain identifier) → scope IS the class. A nested
    // `Ns::Class::method` (name is itself qualified) is namespaced — a deferred non-goal → null.
    if (name && name.type === "identifier" && scope && scope.type === "namespace_identifier") return scope.text;
  }
  for (let p = callNode.parent; p; p = p.parent) {
    if (p.type === "class_specifier") {
      const nm = p.childForFieldName?.("name");
      if (nm) return nm.text;
      for (let i = 0; i < p.namedChildCount; i++) if (p.namedChild(i).type === "type_identifier") return p.namedChild(i).text;
    }
  }
  return null;
}

// Infer the C++ type of `receiverName` at a call site (`obj` or the literal "this"). Walks the call's
// enclosing function_definition for an explicit binding; "this" → enclosing class. Else null.
// smartPtrs: Set of template names to unwrap on `->` calls (default: std unique/shared/weak_ptr).
export function inferCppReceiverType(callNode, receiverName, smartPtrs = DEFAULT_SMART_PTRS) {
  if (!callNode || !receiverName) return null;
  let fn = callNode.parent;
  while (fn && fn.type !== "function_definition") fn = fn.parent;
  if (receiverName === "this") return enclosingCppClass(callNode, fn);
  if (!fn) return null;
  const b = collectCppBindings(fn, smartPtrs).get(receiverName);
  if (!b) return null;
  if (b.smartPtr && memberOperator(callNode) !== "->") return null;   // `.method()` is the wrapper's own
  return b.type;
}

// Upgrade ambiguous C++ member-call rows to resolved when the receiver type pins a single target FILE.
// Pure — new array; only touches kind:"calls" conf:"ambiguous" isMethod rows with a receiverType.
// Unique-PATH (not unique-def): overloads (several defs in one file) resolve; the same class#method
// in two files stays ambiguous (don't guess). Mirrors resolveGoMethods.
export function resolveCppMethods(rows, cppMethodIndex) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    const defs = cppMethodIndex.get(`${r.receiverType}#${r.ref_name}`);
    if (!defs || !defs.length) return r;
    const paths = [...new Set(defs.map((d) => d.path))];
    if (paths.length !== 1) return r;
    const d = defs.find((x) => x.path === paths[0]);
    return { ...r, conf: "resolved", to_path: paths[0], to_symbol: r.ref_name,
      to_lines: `${d.line_start}-${d.line_end}`, candidates: [] };
  });
}
