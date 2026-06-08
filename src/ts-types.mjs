// src/ts-types.mjs — TS/JS receiver-type resolution (pure). Three pieces:
//  - extractTsClassNames: class names declared in a chunk's text (for the class→file index)
//  - inferTsReceiverType: walk a call's enclosing scope for the receiver's type (added in a later task)
//  - resolveTsMethods: upgrade ambiguous member-call rows by intersecting class→file with method→file

// Class names declared in chunk text. `interface` is excluded (no method bodies → not a resolve target).
const TS_CLASS = /\bclass\s+([A-Za-z_$][\w$]*)/g;
export function extractTsClassNames(text) {
  const out = [];
  const s = String(text || "");
  TS_CLASS.lastIndex = 0;
  let m;
  while ((m = TS_CLASS.exec(s))) out.push(m[1]);
  return out;
}

// Function-scope node types: the boundary for collecting local var/param bindings.
const TS_FN_SCOPES = new Set(["function_declaration", "method_definition", "arrow_function",
  "function_expression", "generator_function_declaration", "generator_function"]);

// The bare type name a `type_annotation` denotes, or null (generic/union/predefined → null, deferred).
function tsTypeName(typeAnnotation) {
  if (!typeAnnotation || typeAnnotation.type !== "type_annotation") return null;
  const t = typeAnnotation.namedChild(0);
  return t && t.type === "type_identifier" ? t.text : null;
}

// Add a (name → typeName) binding from a parameter or a variable_declarator. A typed param/var uses its
// `type_annotation`; an untyped `const x = new Bar()` uses the new_expression's constructor identifier.
function addTsBinding(node, bindings) {
  if (node.type === "required_parameter" || node.type === "optional_parameter") {
    const name = node.childForFieldName?.("pattern");
    const ty = tsTypeName(node.childForFieldName?.("type"));
    if (name && name.type === "identifier" && ty) bindings.set(name.text, ty);
    return;
  }
  const nm = node.childForFieldName?.("name");
  if (!nm || nm.type !== "identifier") return;
  const ty = tsTypeName(node.childForFieldName?.("type"));
  if (ty) { bindings.set(nm.text, ty); return; }
  const val = node.childForFieldName?.("value");
  if (val && val.type === "new_expression") {
    const ctor = val.childForFieldName?.("constructor");
    if (ctor && ctor.type === "identifier") bindings.set(nm.text, ctor.text);
  }
}

// Collect param + local bindings in a scope, NOT descending into nested function scopes (so a nested
// closure's params don't shadow an outer binding — same guard as the Go/C++ resolvers).
function collectTsBindings(scope) {
  const bindings = new Map();
  const stack = [scope];
  while (stack.length) {
    const n = stack.pop();
    if (n !== scope && TS_FN_SCOPES.has(n.type)) continue;
    if (n.type === "required_parameter" || n.type === "optional_parameter" || n.type === "variable_declarator") addTsBinding(n, bindings);
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return bindings;
}

// Regular functions rebind `this` (its value is caller-dependent, not the class). method_definition
// and arrow_function do NOT — a method's this is the instance, an arrow's this is lexical. So `this`
// crossing one of these before reaching the class means it is not the class.
const TS_THIS_REBINDERS = new Set(["function_declaration", "function_expression",
  "generator_function_declaration", "generator_function"]);

// The class name enclosing a call site (for `this`), or null.
function enclosingTsClass(callNode) {
  for (let p = callNode.parent; p; p = p.parent) {
    if (TS_THIS_REBINDERS.has(p.type)) return null;   // a regular function rebinds this → not the class
    if (p.type === "class_declaration" || p.type === "class") {
      const nm = p.childForFieldName?.("name");
      if (nm) return nm.text;
    }
  }
  return null;
}

// Infer the type of `receiverName` at a call site. "this" → enclosing class; else the receiver's
// binding in the nearest enclosing function scope (or the program root for a module-level call).
export function inferTsReceiverType(callNode, receiverName) {
  if (!callNode || !receiverName) return null;
  if (receiverName === "this") return enclosingTsClass(callNode);
  let scope = callNode.parent;
  while (scope && !TS_FN_SCOPES.has(scope.type) && scope.parent) scope = scope.parent;
  if (!scope) return null;
  return collectTsBindings(scope).get(receiverName) ?? null;
}

// TS/JS source-file extensions — used to gate resolveTsMethods to TS/JS callers only.
const TS_EXTS = /\.(m?[jt]sx?|d\.ts)$/i;

// Upgrade an ambiguous TS/JS member-call row to resolved when the receiver type pins a unique file.
// Chunk-robust: TS/JS methods are in-class only, so instead of a `class#method` key (which breaks when
// the chunker splits a method out of its class), intersect the file(s) declaring class T with the
// file(s) defining a callable m — both live in the same file regardless of chunk boundaries.
export function resolveTsMethods(rows, tsClassFiles, tsCallableFiles) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    if (!TS_EXTS.test(r.from_path ?? "")) return r;
    const classFiles = tsClassFiles.get(r.receiverType);
    const defs = tsCallableFiles.get(r.ref_name);
    if (!classFiles || !defs) return r;
    const inClass = defs.filter((d) => classFiles.has(d.path));
    const paths = [...new Set(inClass.map((d) => d.path))];
    if (paths.length !== 1) return r;
    const d = inClass.find((x) => x.path === paths[0]);
    return { ...r, conf: "resolved", to_path: paths[0], to_symbol: r.ref_name,
      to_lines: `${d.line_start}-${d.line_end}`, candidates: [] };
  });
}
