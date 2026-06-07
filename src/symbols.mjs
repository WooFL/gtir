// keywords, not definitions — excluded from the C-family pass below.
const NOT_A_DEFINITION = new Set([
  "if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else", "decltype",
  "constexpr", "requires", "static_assert", "function", "operator", "typedef", "using", "namespace",
]);

// Every identifier this chunk *declares* — heuristic (not tree-sitter-precise), used to tell a
// definition site from a mention. Two passes:
//   1) keyword-declared symbols (function/def/class/struct/… across languages).
//   2) C-family function/method DEFINITIONS — `[Class::]name(params) [quals] [: init] {`. The body
//      brace distinguishes a definition from a call (`foo();`) or prototype (`int foo();`); the
//      optional `Class::` prefix captures the method name (so `void Cache::write(...) {` → `write`).
export function declaredSymbols(text) {
  const s = String(text || "");
  const out = new Set();
  let m;
  const kw = /\b(?:function|func|def|class|fn|interface|type|struct|impl|trait|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = kw.exec(s))) out.add(m[1]);
  const cfn = /(?:^|[\s;{}*&])(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:noexcept|const|override|final|mutable|volatile|->[\w:<>,*&\s]+|\s)*(?::[^{};]*)?\{/g;
  while ((m = cfn.exec(s))) if (!NOT_A_DEFINITION.has(m[1])) out.add(m[1]);
  return [...out];
}
