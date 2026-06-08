import { dirname, join, basename } from "node:path";
import { edgeTypes, targetTypes } from "./languages.mjs";
import { inferReceiverType } from "./go-types.mjs";

// Walk every named node depth-first, calling visit(node). Iterative (no recursion depth limit),
// mirrors chunker.collectNodes' traversal.
function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    visit(n);
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
}

// Rightmost identifier of a callee expression: `foo` -> foo, `a.b.foo` -> foo, `a::b::foo` -> foo.
// Returns null for computed/dynamic callees we can't name.
function calleeName(node) {
  if (!node) return null;
  if (/identifier/.test(node.type) && !/computed/.test(node.type)) return node.text;
  const prop = node.childForFieldName?.("property")
    || node.childForFieldName?.("name")
    || node.childForFieldName?.("field");
  if (prop?.text) return prop.text;
  // Computed/subscript callees (e.g. a[b]()) must return null — we can't statically name them.
  if (/subscript|index/.test(node.type)) return null;
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;
  }
  return null;
}

// The callee subexpression of a call node, across grammars (field name varies).
function calleeOf(node) {
  return node.childForFieldName?.("function")
    || node.childForFieldName?.("callee")
    || node.childForFieldName?.("name")
    || node.namedChild(0);
}

// A value member-call's callee is a member/attribute/field/selector expression (obj.method()).
// Rust module paths (mod::func()) are `scoped_identifier` and are intentionally NOT matched —
// they stay disambiguatable. Used to gate embedding-disambiguation away from method-name coincidences.
// Known gap: ObjC `[obj method]` (message_expression) has a non-member callee, so isMethod stays
// false there — an acceptable under-filter (leaves it disambiguatable rather than wrongly suppressing).
const MEMBER_CALL = /^(member_expression|attribute|selector_expression|field_expression)$/;
function isMemberCall(callee) {
  return !!callee && MEMBER_CALL.test(callee.type);
}

// The receiver of a member call as a plain identifier (`b.M()` → "b"), or null for a chained or
// non-identifier receiver (`a.b.M()`, `pkg.X.M()`) — those defer to the embedding tier.
function memberReceiver(callee) {
  const recv = callee.childForFieldName?.("operand")   // go selector_expression
    || callee.childForFieldName?.("object")            // ts/js member_expression
    || callee.namedChild(0);
  return recv && /^identifier$/.test(recv.type) ? recv.text : null;
}

// Strip surrounding quotes / angle brackets from an import source literal.
function unquote(s) {
  return String(s).replace(/^["'<]/, "").replace(/["'>]$/, "");
}

// Strip a known source-file extension to get a path stem, so an import source ("./token")
// and an indexed candidate path ("src/token.ts") compare equal.
const SRC_EXT = /\.(m?[jt]sx?|d\.ts|py|rs|go|c|cc|cpp|cxx|h|hpp|hh)$/i;
export function stripExt(p) { return String(p).replace(SRC_EXT, ""); }

// Collect named import specifiers from an import node (best-effort; precise for JS/TS-style
// `import { a, b } from "..."` and Python `from module import a, b`). Returns a Set of identifier names.
function importNames(node) {
  const names = new Set();

  // Python import_from_statement: names are dotted_name/identifier direct children that are NOT
  // the module_name field (which is the module being imported from).
  if (node.type === "import_from_statement") {
    const moduleNameNode = node.childForFieldName?.("module_name");
    // tree-sitter returns new wrapper objects on each access, so compare by startIndex not identity
    const moduleNameStart = moduleNameNode?.startIndex ?? -1;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.startIndex === moduleNameStart) continue; // skip the module source
      // Each imported name is a dotted_name or identifier
      if (c.type === "dotted_name" || c.type === "identifier") {
        names.add(c.text);
      } else if (c.type === "import_specifier") {
        // JS/TS specifier inside from-import (shouldn't happen for Python, but be safe)
        const id = c.childForFieldName?.("name") || c.namedChild(0);
        if (id && /identifier/.test(id.type) && id.text) names.add(id.text);
      }
    }
    return names;
  }

  // JS/TS: import_specifier nodes inside import_statement.
  // Note: the `named_imports` node type is intentionally not handled here — its namedChild(0)
  // is an import_specifier, not an identifier, so it never contributed names.
  walk(node, (n) => {
    if (n.type === "import_specifier") {
      const id = n.childForFieldName?.("name") || n.namedChild(0);
      if (id && /identifier/.test(id.type) && id.text) names.add(id.text);
    }
  });
  return names;
}

// Mirror of chunker.mjs nodeName: prefer the `name` field, else first identifier-like named child.
function nodeName(n) {
  const f = n.childForFieldName ? n.childForFieldName("name") : null;
  if (f && f.text) return f.text;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;
  }
  return null;
}

// Walk node.parent upward; return the name of the nearest ancestor whose type is in `declSet`
// and has a `nodeName`. Returns null when the call is at module top-level (no enclosing decl).
function enclosingSymbol(node, declSet) {
  for (let p = node.parent; p; p = p.parent) {
    if (declSet.has(p.type)) {
      const nm = nodeName(p);
      if (nm) return nm;
    }
  }
  return null;
}

// The string literal source of an import node, if any (handles ts `from "x"`, c `#include <x>`,
// Python `from module_name import ...` where the source is a dotted_name, and Rust `use path::Type`
// where the source is a scoped_identifier / identifier under the `argument` field).
function importSource(node) {
  // Python-style: module_name field holds a dotted_name (e.g. `from os.path import join`).
  const moduleNameField = node.childForFieldName?.("module_name");
  if (moduleNameField) return moduleNameField.text;

  let src = null;
  walk(node, (n) => {
    if (src) return;
    if (/string|system_lib_string|string_literal/.test(n.type)) src = unquote(n.text);
    // Python import_statement: `import os` — name field is a dotted_name.
    else if (n.type === "dotted_name" && n !== node) src = n.text;
  });
  if (src) return src;

  // Rust `use std::collections::HashMap` — the argument field is a scoped_identifier/identifier
  // with no string literal anywhere in the subtree.
  const argField = node.childForFieldName?.("argument");
  if (argField && /scoped_identifier|identifier/.test(argField.type)) return argField.text;

  return null;
}

// Returns an array of { source, names } for all modules referenced in an import node.
// For single-source imports (JS/TS, Python from-import, C include) this is a 1-element array.
// For multi-source imports (Python `import os, sys`; Go grouped `import ("fmt" "os")`) it returns
// one entry per module source.
function importSources(node) {
  // Go: import_declaration containing import_spec_list with multiple import_spec children.
  // Each import_spec has a `path` field (string literal). Collect directly from children.
  const specSources = [];
  walk(node, (n) => {
    if (n.type === "import_spec" && n !== node) {
      const pathField = n.childForFieldName?.("path");
      const src = pathField ? unquote(pathField.text) : null;
      if (src) specSources.push({ source: src, names: new Set() });
    }
  });
  if (specSources.length > 0) return specSources;

  // Python: import_statement with multiple name: dotted_name fields (import os, sys).
  // The module_name field only exists on import_from_statement, not import_statement,
  // so if there's no module_name, gather all direct dotted_name children.
  const moduleNameField = node.childForFieldName?.("module_name");
  if (!moduleNameField && node.type === "import_statement") {
    const dotted = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === "dotted_name" || c.type === "identifier") {
        dotted.push({ source: c.text, names: new Set() });
      }
    }
    if (dotted.length > 1) return dotted;
    // Fall through to single-source logic for the 1-child case.
  }

  // Single-source fallback (JS/TS, Python from-import, C include, single Python import).
  const src = importSource(node);
  const names = importNames(node);
  return [{ source: src, names }];
}

// [[target]], [[target#heading]], [[target|alias]], and ![[embed]]. The leading "!" marks an embed.
const WIKILINK = /(!)?\[\[([^\]]+)\]\]/g;

export function extractNotesEdges(relPath, text) {
  const norm = String(text).replace(/\r\n?/g, "\n");
  const lines = norm.split("\n");
  const edges = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { inFence = !inFence; continue; }
    if (inFence) continue;
    let m;
    WIKILINK.lastIndex = 0;
    while ((m = WIKILINK.exec(lines[i]))) {
      const isEmbed = m[1] === "!";
      const target = m[2].split("|")[0].split("#")[0].trim();
      if (!target) continue;
      edges.push({ kind: isEmbed ? "embeds" : "links", target, fromPath: relPath, fromLine: i + 1 });
    }
  }
  return edges;
}

// Resolve a relative import source (e.g. "./token") against the importing file's dir into a
// repo-relative path stem (no extension). Returns null for bare/external sources ("lodash").
function resolveSourceStem(fromPath, source) {
  if (!source || !/^[./]/.test(source)) return null;
  const joined = join(dirname(fromPath), source).replace(/\\/g, "/");
  return stripExt(joined);
}

const noteKey = (s) => basename(String(s)).replace(/\.(md|mdx)$/i, "").toLowerCase();

function row(kind, from, to, conf, candidates, contentHash, refName, score = null, isMethod = false, receiverType = null) {
  return {
    kind, conf,
    from_path: from.path, from_lines: from.lines ?? `${from.fromLine}`, from_symbol: from.symbol ?? null,
    to_path: to?.path ?? null, to_lines: to ? `${to.line_start}-${to.line_end}` : null,
    to_symbol: to?.symbol ?? null,
    ref_name: refName ?? null,
    candidates: candidates ?? [],
    content_hash: contentHash ?? null,
    score: score ?? null,
    isMethod,
    receiverType,
  };
}

export function resolveEdges(rawEdges, symbolIndex, noteIndex, opts = {}) {
  const contentHash = opts.contentHash ?? null;
  // Per-file import map: imported name -> resolved source stem.
  const importByName = new Map(); // fromPath -> Map(name -> stem)
  for (const e of rawEdges) {
    if (e.kind !== "imports") continue;
    const stem = resolveSourceStem(e.fromPath, e.source);
    if (!stem || !e.names) continue;
    const m = importByName.get(e.fromPath) ?? new Map();
    for (const n of e.names) m.set(n, stem);
    importByName.set(e.fromPath, m);
  }

  const out = [];
  for (const e of rawEdges) {
    if (e.kind === "calls") {
      const cands = symbolIndex.get(e.refName) ?? [];
      const from = { path: e.fromPath, fromLine: e.fromLine, symbol: e.fromSymbol ?? null };
      if (cands.length === 0) { out.push(row("calls", from, null, "external", [], contentHash, e.refName)); continue; }
      const stem = importByName.get(e.fromPath)?.get(e.refName);
      const scoped = stem ? cands.find((c) => stripExt(c.path) === stem) : null;
      if (scoped) { out.push(row("calls", from, { ...scoped, symbol: e.refName }, "resolved", [], contentHash, e.refName)); continue; }
      // Unique-name fallback. A single same-file candidate is a real intra-file call. A single
      // candidate in ANOTHER file with no import vouching for it is a name coincidence (a builtin
      // like Error, a method like .split, a stdlib name) — surface it as a guess, not a fact.
      if (cands.length === 1) {
        const only = cands[0];
        if (only.path === e.fromPath) { out.push(row("calls", from, { ...only, symbol: e.refName }, "resolved", [], contentHash, e.refName)); continue; }
        out.push(row("calls", from, null, "ambiguous", [only.path], contentHash, e.refName, null, e.isMethod, e.receiverType));
        continue;
      }
      out.push(row("calls", from, null, "ambiguous", cands.map((c) => c.path), contentHash, e.refName, null, e.isMethod, e.receiverType));
    } else if (e.kind === "imports") {
      const stem = resolveSourceStem(e.fromPath, e.source);
      const from = { path: e.fromPath, fromLine: e.fromLine };
      const conf = stem ? "resolved" : "external";
      // ref_name = the module specifier (same value as from_symbol here). It names the
      // TARGET node for the graph layer: an unresolved import renders as ext:<specifier>.
      out.push(row("imports", { ...from, symbol: e.source },
        stem ? { path: stem, line_start: 0, line_end: 0, symbol: null } : null, conf, [], contentHash, e.source));
    } else if (e.kind === "links" || e.kind === "embeds") {
      const cands = noteIndex.get(noteKey(e.target)) ?? [];
      const noteSymbol = basename(String(e.fromPath)).replace(/\.(md|mdx)$/i, "");
      const from = { path: e.fromPath, fromLine: e.fromLine, symbol: noteSymbol || null };
      if (cands.length === 0) { out.push(row(e.kind, from, null, "external", [], contentHash, e.target)); continue; }
      if (cands.length === 1) { out.push(row(e.kind, from, { ...cands[0], line_start: 0, line_end: 0, symbol: e.target }, "resolved", [], contentHash, e.target)); continue; }
      out.push(row(e.kind, from, null, "ambiguous", cands.map((c) => c.path), contentHash, e.target));
    }
  }
  return out;
}

// Index resolved edges for O(1) traversal. callers: target symbol -> incoming rows;
// callees: source symbol -> outgoing rows.
export function buildAdjacency(rows) {
  const callers = new Map();      // to_symbol -> rows[]
  const callees = new Map();      // from_symbol -> rows[]
  for (const r of rows) {
    if (r.to_symbol) {
      if (!callers.has(r.to_symbol)) callers.set(r.to_symbol, []);
      callers.get(r.to_symbol).push(r);
    }
    if (r.from_symbol) {
      if (!callees.has(r.from_symbol)) callees.set(r.from_symbol, []);
      callees.get(r.from_symbol).push(r);
    }
  }
  return { callers, callees };
}

const callerRec = (r) => ({ path: r.from_path, lines: r.from_lines, kind: r.kind, conf: r.conf,
  ...(r.score ? { score: r.score } : {}) });
const calleeRec = (r) => ({ path: r.to_path, lines: r.to_lines, symbol: r.to_symbol, kind: r.kind,
  conf: r.conf, ...(r.score ? { score: r.score } : {}),
  ...(r.candidates?.length ? { candidates: r.candidates } : {}) });

export function callersOf(adj, symbol) {
  return (adj.callers.get(symbol) ?? []).map(callerRec);
}

export function calleesOf(adj, symbol) {
  return (adj.callees.get(symbol) ?? []).map(calleeRec);
}

// Blast radius around a span: callers + callees of its symbol, plus derived siblings (the
// other chunks in the same file — the `contains` relation we compute on demand, never store).
export function neighborsOf(adj, { symbol, path, lines, siblings = [] }) {
  return {
    symbol, path, lines,
    callers: symbol ? callersOf(adj, symbol) : [],
    callees: symbol ? calleesOf(adj, symbol) : [],
    siblings: siblings
      .filter((s) => `${s.line_start}-${s.line_end}` !== lines)
      .map((s) => ({ lines: `${s.line_start}-${s.line_end}`, signature: s.signature })),
  };
}

export function extractCodeEdges(tree, langId, relPath) {
  const types = edgeTypes(langId);
  if (!tree?.rootNode) return [];
  const callSet = new Set(types.call);
  const importSet = new Set(types.import);
  // Enclosing-scope detection: walk to the nearest ancestor whose type is a target declaration type.
  const declSet = new Set(targetTypes(langId));
  const edges = [];
  const seen = new Set();
  walk(tree.rootNode, (n) => {
    if (callSet.has(n.type)) {
      const callee = calleeOf(n);
      const name = calleeName(callee);
      if (name) {
        const key = `c:${name}:${n.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          // Best-effort: null when at module top-level or grammar doesn't expose a name.
          const fromSymbol = declSet.size > 0 ? enclosingSymbol(n, declSet) : null;
          const isMethod = isMemberCall(callee);
          const receiver = isMethod ? memberReceiver(callee) : null;
          const receiverType = (langId === "go" && receiver) ? inferReceiverType(n, receiver) : null;
          edges.push({ kind: "calls", refName: name, fromPath: relPath, fromLine: n.startPosition.row + 1, fromSymbol, isMethod, receiver, receiverType });
        }
      }
    } else if (importSet.has(n.type)) {
      for (const { source, names } of importSources(n)) {
        const key = `i:${source}:${n.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ kind: "imports", source, names, fromPath: relPath, fromLine: n.startPosition.row + 1 });
        }
      }
    }
  });
  return edges;
}
