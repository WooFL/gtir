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
