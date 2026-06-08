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

// The class node enclosing a call site (class_declaration | class), or null. Like enclosingTsClass but
// returns the NODE so we can read its field definitions.
function enclosingTsClassNode(callNode) {
  for (let p = callNode.parent; p; p = p.parent) {
    if (TS_THIS_REBINDERS.has(p.type)) return null;   // a regular function rebinds this → not the class
    if (p.type === "class_declaration" || p.type === "class") return p;
  }
  return null;
}

// The declared type of `field` among a class node's public_field_definition members: its type_annotation
// (bare type) or a `= new Ctor()` initializer's constructor identifier. Null otherwise.
function tsFieldType(classNode, field) {
  const body = classNode.childForFieldName?.("body");
  if (!body) return null;
  for (let i = 0; i < body.namedChildCount; i++) {
    const m = body.namedChild(i);
    if (m.type !== "public_field_definition") continue;
    const nm = m.childForFieldName?.("name");
    if (!nm || nm.text !== field) continue;
    const ty = tsTypeName(m.childForFieldName?.("type"));
    if (ty) return ty;
    const val = m.childForFieldName?.("value");
    if (val && val.type === "new_expression") {
      const ctor = val.childForFieldName?.("constructor");
      if (ctor && ctor.type === "identifier") return ctor.text;
    }
    return null;
  }
  return null;
}

// Infer the type of a `this.<field>.method()` receiver: the field's declared/initialized type, read from
// the enclosing class body. Returns null unless the call's callee is `this.<field>.<method>(...)`.
export function inferTsFieldReceiverType(callNode) {
  const callee = callNode?.childForFieldName?.("function");
  if (!callee || callee.type !== "member_expression") return null;
  const obj = callee.childForFieldName?.("object");                  // the `this.<field>` part
  if (!obj || obj.type !== "member_expression") return null;
  const inner = obj.childForFieldName?.("object");
  if (!inner || inner.type !== "this") return null;                  // require `this.<field>`
  const fieldName = obj.childForFieldName?.("property");
  if (!fieldName) return null;
  const classNode = enclosingTsClassNode(callNode);
  return classNode ? tsFieldType(classNode, fieldName.text) : null;
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

// [{cls, bases}] for each class head in `text`. `bases` = extends base (≤1) then implements interfaces,
// in order. Classes with neither clause are omitted. `interface X extends Y` yields no entry.
// Generic args are stripped: `Base<T>` → `Base`. Multi-class per chunk is fully supported.
const TS_CLASS_HEAD = /(?<![A-Za-z_$\w])class\s+([A-Za-z_$][\w$]*)(?:\s*<[^{]*?>)?\s*((?:extends|implements)\s[^{]*?)\s*\{/g;
function stripTsGenerics(s) {
  let prev;
  do { prev = s; s = s.replace(/<[^<>]*>/g, ""); } while (s !== prev);
  return s;
}
export function extractTsImplements(text) {
  const s = String(text || "");
  // Reject if preceded by "interface " — check by scanning the full string with a negative lookbehind
  // that is position-aware. We use a fresh regex to locate each class head, then pre-scan for
  // "interface ... class" patterns to skip. Simplest: reject any match where the preceding non-ws token
  // is "interface". We do this by checking the substring before the match start.
  const out = [];
  // Reset state-carrying regex
  TS_CLASS_HEAD.lastIndex = 0;
  let m;
  while ((m = TS_CLASS_HEAD.exec(s))) {
    // Ensure this `class` is not inside an interface declaration:
    // look back at text before match and check the immediately preceding keyword token isn't "interface"
    const before = s.slice(0, m.index);
    const prevToken = before.match(/([A-Za-z_$][\w$]*)[\s]*$/);
    if (prevToken && prevToken[1] === "interface") continue;

    const cls = m[1];
    const clauseRaw = m[2];
    const clause = stripTsGenerics(clauseRaw);

    // Parse extends and implements from the clause text
    const bases = [];

    // extends: optional single base
    const extendsMatch = clause.match(/\bextends\s+([A-Za-z_$][\w$]*)/);
    if (extendsMatch) bases.push(extendsMatch[1]);

    // implements: comma-separated list
    const implMatch = clause.match(/\bimplements\s+([\s\S]+)/);
    if (implMatch) {
      for (const part of implMatch[1].split(",")) {
        const id = part.trim().match(/^([A-Za-z_$][\w$]*)/);
        if (id) bases.push(id[1]);
      }
    }

    if (bases.length > 0) out.push({ cls, bases });
  }
  return out;
}

// TS/JS source-file extensions — used to gate resolveTsMethods to TS/JS callers only.
// Matches .ts/.tsx/.js/.jsx plus the .mjs/.cjs/.mts/.cts module variants (.d.ts via its .ts suffix).
const TS_EXTS = /\.[cm]?[jt]sx?$/i;

// Upgrade an ambiguous TS/JS member call on an interface/abstract-base-typed receiver to
// conf:"dispatch" — the set of in-repo implementers (and the base itself, if it defines the method)
// that define the called method. Requires >=1 IMPLEMENTER def (real polymorphism): if only the base
// defines the method (no implementer override), the row is left unchanged for resolveTsMethods to
// handle concretely. For an interface receiver, tsClassFiles.get(interfaceName) is undefined — the
// base contributes nothing, only implementers. Runs BEFORE resolveTsMethods. Pure.
export function resolveTsDispatch(rows, tsImplementers, tsClassFiles, tsCallableFiles) {
  // Returns the files where `cls` is declared AND `method` is defined (intersection by path).
  const filesDefiningMethodInClass = (cls, method) => {
    const classFiles = tsClassFiles.get(cls);
    const defs = tsCallableFiles.get(method);
    if (!classFiles || !defs) return [];
    return defs.filter((d) => classFiles.has(d.path)).map((d) => d.path);
  };
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    if (!TS_EXTS.test(r.from_path ?? "")) return r;
    const implementers = tsImplementers.get(r.receiverType);
    if (!implementers || !implementers.size) return r;
    // Collect files from implementers that define the method (polymorphism signal).
    const implPaths = new Set();
    for (const cls of implementers)
      for (const p of filesDefiningMethodInClass(cls, r.ref_name)) implPaths.add(p);
    if (implPaths.size === 0) return r;                 // no implementer defines it → not a dispatch
    // Also include the base's own def, if any (the call may bind to the base for abstract/virtual impls).
    const paths = new Set(implPaths);
    for (const p of filesDefiningMethodInClass(r.receiverType, r.ref_name)) paths.add(p);
    return { ...r, conf: "dispatch", to_path: null, to_symbol: r.ref_name, to_lines: null, candidates: [...paths] };
  });
}

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
