import { edgeTypes } from "./languages.mjs";

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

// Strip surrounding quotes / angle brackets from an import source literal.
function unquote(s) {
  return String(s).replace(/^["'<]/, "").replace(/["'>]$/, "");
}

// Collect named import specifiers from an import node (best-effort; precise for JS/TS-style
// `import { a, b } from "..."`). Returns a Set of identifier names.
function importNames(node) {
  const names = new Set();
  walk(node, (n) => {
    if (n.type === "import_specifier" || n.type === "named_imports") {
      const id = n.childForFieldName?.("name") || n.namedChild(0);
      if (id && /identifier/.test(id.type) && id.text) names.add(id.text);
    }
  });
  return names;
}

// The string literal source of an import node, if any (handles ts `from "x"`, c `#include <x>`,
// and Python `from module_name import ...` where the source is a dotted_name, not a string).
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
  return src;
}

export function extractCodeEdges(tree, langId, relPath) {
  const types = edgeTypes(langId);
  if (!tree?.rootNode) return [];
  const callSet = new Set(types.call);
  const importSet = new Set(types.import);
  const edges = [];
  const seen = new Set();
  walk(tree.rootNode, (n) => {
    if (callSet.has(n.type)) {
      const name = calleeName(calleeOf(n));
      if (name) {
        const key = `c:${name}:${n.startIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ kind: "calls", refName: name, fromPath: relPath, fromLine: n.startPosition.row + 1 });
        }
      }
    } else if (importSet.has(n.type)) {
      const source = importSource(n);
      const names = importNames(n);
      const key = `i:${source}:${n.startIndex}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push({ kind: "imports", source, names, fromPath: relPath, fromLine: n.startPosition.row + 1 });
      }
    }
  });
  return edges;
}
