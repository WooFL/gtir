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
// The enclosing class/struct of a chunk. The name must be followed by `{` (body), `:` (base clause),
// or an optional `final` then one of those — anchoring on the REAL declaration. This rejects a comment
// (`// describes class Widget`) and a template type parameter (`template <class T>`), both of which
// would otherwise win the first .match() and mis-key the in-class method index.
const CPP_CLASS = /\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\b\s*)?(?:\{|:)/;
const CPP_CTRL = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "do"]);

// scopeClass: the chunker's enclosing-class breadcrumb (innermost container name), used as the class
// for in-class inline defs ONLY when this chunk has no `class X {` header of its own. The chunker drops
// an oversize class_specifier and surfaces each inline method as its own chunk — that chunk's text
// loses the header, so without the breadcrumb the method would not be keyed (chunk-robustness, #8).
// A header present in the text always wins; scopeClass=null reproduces the original single-chunk
// behavior exactly. A breadcrumb that is actually a namespace/method name yields only dead keys
// (no receiver is ever typed with it) — never a wrong resolution.
export function extractCppMethodDefs(text, scopeClass = null) {
  const s = String(text || "");
  const out = [];
  CPP_OUT_DEF.lastIndex = 0;
  let m;
  while ((m = CPP_OUT_DEF.exec(s))) out.push({ cls: m[1], method: m[2] });
  const cm = s.match(CPP_CLASS);
  const cls = cm ? cm[1] : scopeClass;
  if (cls) {
    CPP_IN_DEF.lastIndex = 0;
    let im;
    while ((im = CPP_IN_DEF.exec(s))) {
      if (im[1] !== cls && !CPP_CTRL.has(im[1])) out.push({ cls, method: im[1] });
    }
  }
  return out;
}

// Free-function definition with a leading return type: `RetType name(params) [quals] {`. Linear params
// `[^;{}()]*` (ReDoS-safe, same discipline as CPP_OUT_DEF). The return type allows one `::` qualifier
// and one non-nested `<...>` (for std::unique_ptr<T>); normalizeReturnType classifies it. The
// type/name separator `(?:\s*[*&]\s*|\s+)` requires a real boundary (ptr/ref or whitespace) so a
// run-together `Widgetmake(){` cannot false-match.
const CPP_LEADING_FN = /(?:^|[;{}])\s*(?:(?:inline|static|constexpr|virtual|friend)\s+)*((?:const\s+)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)?(?:\s*<[^<>;{}()]*>)?)(?:\s*[*&]\s*|\s+)([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const|noexcept|override|final|mutable|volatile|\s)*\{/g;
// Trailing-return form: `auto name(params) [quals] -> RetType {`.
const CPP_TRAILING_FN = /(?:^|[;{}])\s*(?:(?:inline|static|constexpr|friend)\s+)*auto\s+([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const|noexcept|\s)*->\s*((?:const\s+)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)?(?:\s*<[^<>;{}()]*>)?\s*[*&]?)\s*\{/g;
const CPP_RET_PRIMITIVES = new Set(["void", "bool", "char", "short", "int", "long", "float", "double",
  "signed", "unsigned", "wchar_t", "char8_t", "char16_t", "char32_t", "size_t", "auto"]);
// std smart-pointer return → element type. Only std unique/shared/weak_ptr (return-type wrappers are
// effectively always std); a custom forwarder as a *return* type is a deferred non-goal.
const CPP_SMART_PTR_RET = /^(?:std\s*::\s*)?(unique_ptr|shared_ptr|weak_ptr)\s*<\s*([A-Za-z_]\w*)\s*>$/;

// Reduce a captured return-type string to a bare element class name, or null when it is a primitive,
// a qualified name (Ns::Foo), or a non-smart-pointer generic (Foo<T>). Smart-pointer wrappers unwrap.
function normalizeReturnType(raw) {
  const t = String(raw).replace(/^const\s+/, "").replace(/[\s*&]+$/, "").trim();
  const sp = t.match(CPP_SMART_PTR_RET);
  if (sp) return sp[2];
  if (t.includes("::") || t.includes("<")) return null;
  if (CPP_RET_PRIMITIVES.has(t)) return null;
  return /^[A-Za-z_]\w*$/.test(t) ? t : null;
}

// Regex a chunk's text into {name, returnType} pairs for function definitions with an inferable simple
// return type (bare class / pointer / reference / const / trailing-return / std smart-pointer). In-class
// member defs are included (harmless — they resolve only an implicit-`this` `auto x = m()` call, which is
// correct); out-of-class method defs (`Class::m`) are excluded by the name pattern not allowing `::`.
export function extractCppReturnTypes(text) {
  const s = String(text || "");
  const out = [];
  CPP_LEADING_FN.lastIndex = 0;
  let m;
  while ((m = CPP_LEADING_FN.exec(s))) {
    const rt = normalizeReturnType(m[1]);
    if (rt) out.push({ name: m[2], returnType: rt });
  }
  CPP_TRAILING_FN.lastIndex = 0;
  while ((m = CPP_TRAILING_FN.exec(s))) {
    const rt = normalizeReturnType(m[2]);
    if (rt) out.push({ name: m[1], returnType: rt });
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
// field_identifier is the leaf node type for class/struct member names in tree-sitter-cpp.
function declName(decl) {
  if (!decl) return null;
  if (decl.type === "identifier" || decl.type === "field_identifier") return decl.text;
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

// The nearest enclosing class_specifier or struct_specifier of a node, or null.
function enclosingClassSpecifier(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "class_specifier" || p.type === "struct_specifier") return p;
  }
  return null;
}

// The declared type of member field `name` in a class_specifier, as {type, smartPtr}, or null. Reads
// the class body's field_declaration nodes (NOT method-local declarations) — precise, AST-based. A
// bare type_identifier → plain; an allowlisted smart-pointer template → smartPtr binding (element type).
function fieldBinding(classSpec, name, smartPtrs) {
  const body = classSpec.childForFieldName?.("body");
  if (!body) return null;
  for (let i = 0; i < body.namedChildCount; i++) {
    const fd = body.namedChild(i);
    if (fd.type !== "field_declaration") continue;
    if (declName(fd.childForFieldName?.("declarator")) !== name) continue;
    const type = fd.childForFieldName?.("type");
    if (!type) return null;
    if (type.type === "type_identifier") return { type: type.text, smartPtr: false };
    const elem = templateElement(type, smartPtrs);
    if (elem) return { type: elem, smartPtr: true };
    return null;
  }
  return null;
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
  if (b) {
    if (b.smartPtr && memberOperator(callNode) !== "->") return null;   // `.method()` is the wrapper's own
    return b.type;
  }
  // Fallback: a member field of the enclosing class (e.g. `m_w->go()`). Locals/params (above) shadow it.
  const cls = enclosingClassSpecifier(callNode);
  const fb = cls ? fieldBinding(cls, receiverName, smartPtrs) : null;
  if (!fb) return null;
  if (fb.smartPtr && memberOperator(callNode) !== "->") return null;
  return fb.type;
}

// The free-function name whose return value initializes `receiverName`, when that local is declared
// `auto x = freeFn(...)`, else null. Walks the call's enclosing function_definition (does not descend
// into lambdas — scope-bleed guard). Member/qualified factory calls (obj.make(), ns::make()) → null.
// For a uniquely-named local (the common case) the match is unambiguous; when `receiverName` is
// re-declared in a nested block, the last-textual declaration wins (deterministic). Known limitation
// (same as inferCppReceiverType): a call site inside a lambda walks up through the lambda to the outer
// function_definition, so it may still see the outer factory declaration.
export function inferCppFactory(callNode, receiverName) {
  if (!callNode || !receiverName) return null;
  let fn = callNode.parent;
  while (fn && fn.type !== "function_definition") fn = fn.parent;
  if (!fn) return null;
  const stack = [fn];
  while (stack.length) {
    const n = stack.pop();
    if (n !== fn && n.type === "lambda_expression") continue;
    if (n.type === "declaration"
      && n.childForFieldName?.("type")?.type === "placeholder_type_specifier") {
      const decl = n.childForFieldName?.("declarator");
      if (decl?.type === "init_declarator" && declName(decl.childForFieldName?.("declarator")) === receiverName) {
        const val = decl.childForFieldName?.("value");
        const callee = val?.type === "call_expression" ? val.childForFieldName?.("function") : null;
        return callee?.type === "identifier" ? callee.text : null;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return null;
}

// Method names a class declares `virtual` (incl pure `= 0`). Keyed to the in-text class, else scopeClass
// (chunk-robust). The `virtual` keyword is the polymorphism signal for resolveCppDispatch.
const CPP_VIRTUAL = /\bvirtual\b[^;{()]*?\b([A-Za-z_]\w*)\s*\(/g;
export function extractCppVirtuals(text, scopeClass = null) {
  const s = String(text || "");
  const cm = s.match(CPP_CLASS);
  const cls = cm ? cm[1] : scopeClass;
  if (!cls) return [];
  const out = [];
  CPP_VIRTUAL.lastIndex = 0;
  let m;
  while ((m = CPP_VIRTUAL.exec(s))) if (!CPP_CTRL.has(m[1])) out.push({ cls, method: m[1] });
  return out;
}

// Method names a class defines/declares with the `override` specifier (decl `;` or inline def `{`).
// A reliable derived-side signal that the method overrides a base virtual. Keyed to in-text class / scopeClass.
const CPP_OVERRIDE = /(?:^|[\s;{}*&])([A-Za-z_]\w*)\s*\([^;{}()]*\)\s*(?:const|noexcept|\s)*override\b/g;
export function extractCppOverrides(text, scopeClass = null) {
  const s = String(text || "");
  const cm = s.match(CPP_CLASS);
  const cls = cm ? cm[1] : scopeClass;
  if (!cls) return [];
  const out = [];
  CPP_OVERRIDE.lastIndex = 0;
  let m;
  while ((m = CPP_OVERRIDE.exec(s))) if (!CPP_CTRL.has(m[1])) out.push({ cls, method: m[1] });
  return out;
}

// A class/struct head with a base clause → { cls, bases:[...] }. Captures the base-clause text between
// `:` and `{`, then pulls each base's trailing identifier, skipping access/virtual keywords. Qualified
// bases (std::exception) keep the last segment; a template base (Base<int>) keeps the bare class name
// (the `<...>` args are stripped first, so the template comma is not mistaken for a base separator);
// a class with no `:` clause yields no entry. Limitation (shared with extractCppMethodDefs): a chunk
// with two class heads keys both via this pass independently — fine here since each match carries its
// own cls; but a base clause inside a commented-out class head would still match (no comment strip).
const CPP_ACCESS = new Set(["public", "private", "protected", "virtual"]);
const CPP_BASE_HEAD = /\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\b\s*)?:\s*([^{};]+)\{/g;
function stripTemplateArgs(s) {
  let prev;
  do { prev = s; s = s.replace(/<[^<>]*>/g, ""); } while (s !== prev);   // peel nested <...> innermost-first
  return s;
}
export function extractCppBases(text) {
  const s = String(text || "");
  const out = [];
  CPP_BASE_HEAD.lastIndex = 0;
  let m;
  while ((m = CPP_BASE_HEAD.exec(s))) {
    const bases = [];
    for (const part of stripTemplateArgs(m[2]).split(",")) {
      // last identifier in the part (handles `public ns::Base`, `virtual public Base`, `public Base<T>`)
      const ids = part.match(/[A-Za-z_]\w*/g) || [];
      const last = ids[ids.length - 1];
      if (last && !CPP_ACCESS.has(last)) bases.push(last);
    }
    if (bases.length) out.push({ cls: m[1], bases });
  }
  return out;
}

// Regex for a simple (non-qualified, non-template) type identifier — bare identifier only.
const CPP_BARE_TYPE = /^[A-Za-z_]\w*$/;
// std smart-pointer field wrapper: `[std::]unique_ptr<Foo>` / `shared_ptr<Foo>` / `weak_ptr<Foo>`.
// Mirrors CPP_SMART_PTR_RET but for field declarations rather than return types.
const CPP_SMART_PTR_FIELD = /^(?:std\s*::\s*)?(unique_ptr|shared_ptr|weak_ptr)\s*<\s*([A-Za-z_]\w*)\s*>$/;
// Leading keywords that mean the statement is NOT an instance field.
const CPP_FIELD_REJECT = new Set(["using", "typedef", "friend", "static", "enum", "struct", "class",
  "constexpr", "inline", "virtual", "mutable"]);
// Access specifier keywords that precede `:` (not a field statement).
const CPP_ACCESS_KW = new Set(["public", "private", "protected"]);

// Parse one candidate field statement (text of the declaration up to `;`, initializer truncated).
// Returns {field, type, smartPtr} or null when the statement is not a simple instance field.
function parseCppFieldStmt(raw) {
  // truncate at first `=` so `Widget* m_w = nullptr` → `Widget* m_w`
  const stmt = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
  const s = stmt.trim();
  if (!s) return null;
  if (s.includes("(")) return null;                       // method decl / fn-pointer — skip
  const tokens = s.match(/[A-Za-z_]\w*|[*&<>,:]/g) || []; // grab identifiers + punctuation tokens
  if (!tokens.length) return null;
  const first = tokens[0];
  if (CPP_FIELD_REJECT.has(first)) return null;           // storage/decl keyword → not an instance field
  // collect identifier tokens only (the structural punctuation tokens are for qualified-type detection)
  const ids = tokens.filter((t) => /^[A-Za-z_]/.test(t));
  if (ids.length < 2) return null;                        // need at least type + name
  const field = ids[ids.length - 1];                     // last identifier is the field name
  // rebuild the type expression: everything in `s` before the last occurrence of the field name,
  // with trailing punctuation/whitespace stripped; this handles `Widget*`, `Widget &`, bare `Widget`
  const lastIdx = s.lastIndexOf(field);
  const typeRaw = s.slice(0, lastIdx).replace(/[\s*&,]+$/, "").trim();
  if (!typeRaw) return null;
  // strip a leading cv-qualifier so `const Widget*`/`volatile T`/`mutable Foo` classify on the bare
  // type (mirrors normalizeReturnType's `.replace(/^const\s+/, "")`). Both bare and smart-ptr forms.
  const type = typeRaw.replace(/^(?:const|volatile|mutable)\s+/, "");
  if (!type) return null;
  // qualified type (contains `::`) or non-allowlisted generic (`<`) → deferred, skip
  if (type.includes("::") || type.includes("<")) {
    const sp = type.match(CPP_SMART_PTR_FIELD);
    if (sp) return { field, type: sp[2], smartPtr: true };
    return null;
  }
  if (!CPP_BARE_TYPE.test(type)) return null;
  return { field, type, smartPtr: false };
}

// Brace-tracked scan of a class-body interior for field declarations. Starts at `start`, where the
// surrounding brace `depth` is the INTERIOR level (1 just inside a body's `{` in header mode; 0 for a
// header-less chunk whose whole text IS the interior in scopeClass mode). A `;` flushes a candidate
// only at the interior depth; any `{` raises depth and its contents (a method/ctor body) are skipped,
// so method-body locals are never emitted as phantom fields. Pushes {cls, …} rows into `out`.
function scanCppFieldBody(s, start, depth, cls, out) {
  const interior = depth;        // the level at which a `;` ends a real field statement
  let buf = "";                  // accumulates characters at the interior level
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") {
      if (depth === interior) {
        // opening an inline method/ctor body — discard the pending buffer and skip to its matching `}`
        buf = "";
        let inner = 1;
        i++;
        while (i < s.length && inner > 0) {
          if (s[i] === "{") inner++;
          else if (s[i] === "}") inner--;
          i++;
        }
        i--;                     // loop will increment again; depth stays at interior
      } else {
        depth++;
      }
    } else if (ch === "}") {
      depth--;
      if (depth < interior) break;   // end of the class body (header mode: interior 1 → break at 0)
    } else if (ch === ";" && depth === interior) {
      const trimmed = buf.trim();
      if (trimmed) {
        const r = parseCppFieldStmt(trimmed);
        if (r) out.push({ cls, ...r });
      }
      buf = "";
    } else if (ch === ":" && depth === interior) {
      // access specifier `public:` / `private:` / `protected:` → clear buffer; else keep `:` (e.g. `::`)
      const kw = buf.trim();
      if (CPP_ACCESS_KW.has(kw)) buf = "";
      else buf += ch;
    } else if (depth === interior) {
      buf += ch;
    }
  }
}

// Extract member-field declarations from a class body in `text`. Returns [{cls, field, type, smartPtr}].
// Brace-depth tracking ensures declarations inside inline method/ctor bodies are never emitted as fields.
// Both modes share scanCppFieldBody: header mode scans from just after the body's opening `{` at interior
// depth 1; scopeClass mode scans the whole text at interior depth 0 (a header-less chunk is typically an
// out-of-class method body, so its `{ … }` locals must be skipped — not flushed as phantom fields).
// scopeClass: fallback class name when the chunk has no `class/struct Name` header (chunk-robustness,
// same rule as extractCppMethodDefs).
export function extractCppFields(text, scopeClass = null, smartPtrs = DEFAULT_SMART_PTRS) {
  const s = String(text || "");
  const cm = s.match(CPP_CLASS);
  const cls = cm ? cm[1] : scopeClass;
  if (!cls) return [];

  const out = [];

  // scopeClass-only mode: no class header → whole text is the class interior, scanned at depth 0.
  if (!cm) {
    scanCppFieldBody(s, 0, 0, cls, out);
    return out;
  }

  // Header mode: find the opening `{` of the class body, scan its interior starting at depth 1.
  const bodyStart = s.indexOf("{", cm.index + cm[0].length - 1);
  if (bodyStart === -1) return [];
  scanCppFieldBody(s, bodyStart + 1, 1, cls, out);
  return out;
}

// C++ source-file extensions — used to gate resolveCppMethods to C++ callers only.
const CPP_EXTS = /\.(cpp|cc|cxx|c|h|hpp|hh|hxx|metal)$/i;

// Upgrade an ambiguous C++ member call on a base/abstract-typed receiver to conf:"dispatch" — the set
// of in-repo derived classes that OVERRIDE the called virtual method. A derived D's def counts when the
// base declares the method virtual (cppVirtualMethods) OR D marks it `override` (cppOverrideMethods).
// Requires >=1 derived implementer (a non-virtual / no-override call yields nothing → left for
// resolveCppMethods to resolve concretely). When the base itself has a concrete impl AND declared the
// method virtual, the base's def is included too (the call may bind to the base). Runs BEFORE
// resolveCppMethods. Pure.
export function resolveCppDispatch(rows, cppMethodIndex, cppDerivedIndex, cppVirtualMethods, cppOverrideMethods) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    if (!CPP_EXTS.test(r.from_path ?? "")) return r;
    const B = r.receiverType, m = r.ref_name;
    const derived = cppDerivedIndex.get(B);
    if (!derived || !derived.size) return r;
    const baseVirtual = cppVirtualMethods.get(B)?.has(m) ?? false;
    const paths = new Set();
    for (const D of derived) {
      const defs = cppMethodIndex.get(`${D}#${m}`);
      if (!defs || !defs.length) continue;
      if (baseVirtual || (cppOverrideMethods.get(D)?.has(m) ?? false)) for (const d of defs) paths.add(d.path);
    }
    if (paths.size === 0) return r;                                  // no real override → not a dispatch
    if (baseVirtual) for (const d of (cppMethodIndex.get(`${B}#${m}`) || [])) paths.add(d.path);  // concrete base
    return { ...r, conf: "dispatch", to_path: null, to_symbol: m, to_lines: null, candidates: [...paths] };
  });
}

// Upgrade ambiguous C++ member-call rows to resolved when the receiver type pins a single target FILE.
// Pure — new array; only touches kind:"calls" conf:"ambiguous" isMethod rows with a resolved receiver type (direct r.receiverType, or via a unique cppReturnIndex factory lookup).
// Unique-PATH (not unique-def): overloads (several defs in one file) resolve; the same class#method
// in two files stays ambiguous (don't guess). Mirrors resolveGoMethods.
export function resolveCppMethods(rows, cppMethodIndex, cppReturnIndex = new Map()) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod) return r;
    if (!CPP_EXTS.test(r.from_path ?? "")) return r;
    let rt = r.receiverType;
    if (!rt && r.receiverFactory) {                          // auto x = factory(); x.m()
      const types = cppReturnIndex.get(r.receiverFactory);
      if (types && types.size === 1) rt = [...types][0];     // unique return type only — don't guess
    }
    if (!rt) return r;
    const defs = cppMethodIndex.get(`${rt}#${r.ref_name}`);
    if (!defs || !defs.length) return r;
    const paths = [...new Set(defs.map((d) => d.path))];
    if (paths.length !== 1) return r;
    const d = defs.find((x) => x.path === paths[0]);
    return { ...r, conf: "resolved", to_path: paths[0], to_symbol: r.ref_name,
      to_lines: `${d.line_start}-${d.line_end}`, candidates: [] };
  });
}
