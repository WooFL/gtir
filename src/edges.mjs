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

// Strip surrounding quotes / angle brackets from an import source literal.
function unquote(s) {
  return String(s).replace(/^["'<]/, "").replace(/["'>]$/, "");
}

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
