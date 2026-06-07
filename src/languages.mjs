export const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".sh",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",        // C / C++
  ".m", ".mm",                                                      // Objective-C / Objective-C++
  ".metal", ".hlsl", ".hlsli", ".fx", ".fxh",                       // shaders: Metal, HLSL
  ".glsl", ".vert", ".frag", ".comp", ".geom", ".tesc", ".tese",    // shaders: GLSL stages
  ".wgsl", ".slang",                                                // shaders: WGSL, Slang
  ".json", ".toml", ".yml", ".yaml",
  ".css", ".html", ".md", ".mdx",
]);

// null => no tree-sitter grammar; use recursive char splitter.
const EXT_TO_TS_LANG = {
  ".ts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".sh": "bash",
  // C / C++ — real grammars. `.h` maps to cpp (the superset that parses both C and C++ headers).
  ".c": "c", ".h": "cpp",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
  // Objective-C / Objective-C++ — real grammar.
  ".m": "objc", ".mm": "objc",
  // Shaders: HLSL and GLSL have first-class grammars (vendored). Slang is HLSL-derived → hlsl.
  // Metal is C++14-based → cpp (no Metal grammar). WGSL is Rust-like → grammarless (recursive).
  ".hlsl": "hlsl", ".hlsli": "hlsl", ".fx": "hlsl", ".fxh": "hlsl", ".slang": "hlsl",
  ".glsl": "glsl", ".vert": "glsl", ".frag": "glsl", ".comp": "glsl", ".geom": "glsl", ".tesc": "glsl", ".tese": "glsl",
  ".metal": "cpp", ".wgsl": null,
  ".json": "json", ".toml": "toml", ".yml": "yaml", ".yaml": "yaml",
  ".css": "css", ".html": "html", ".md": "markdown", ".mdx": "markdown",
};

const CHUNK_TARGET_TYPES_BY_LANG = {
  typescript: [
    "class_declaration", "abstract_class_declaration", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "module_declaration",
    "internal_module", "function_declaration", "function_signature",
    "method_definition", "method_signature",
  ],
  tsx: [
    "class_declaration", "abstract_class_declaration", "interface_declaration",
    "type_alias_declaration", "enum_declaration", "function_declaration",
    "method_definition", "method_signature",
  ],
  javascript: ["class_declaration", "function_declaration", "method_definition"],
  python: ["class_definition", "function_definition", "decorated_definition"],
  rust: ["function_item", "struct_item", "enum_item", "trait_item", "impl_item", "type_item", "mod_item"],
  go: ["function_declaration", "method_declaration", "type_declaration"],
  c: ["function_definition", "struct_specifier", "enum_specifier", "union_specifier", "type_definition"],
  cpp: ["function_definition", "class_specifier", "struct_specifier", "enum_specifier",
    "union_specifier", "namespace_definition", "template_declaration", "type_definition"],
  objc: ["class_interface", "class_implementation", "method_definition", "function_definition"],
  glsl: ["function_definition", "struct_specifier", "enum_specifier", "type_definition"],
  hlsl: ["function_definition", "struct_specifier", "enum_specifier", "type_definition"],
};

export function langFor(ext) {
  const k = String(ext).toLowerCase();
  return k in EXT_TO_TS_LANG ? EXT_TO_TS_LANG[k] : null;
}
export function isIndexable(ext) {
  return INDEXABLE_EXTENSIONS.has(String(ext).toLowerCase());
}
export function targetTypes(langId) {
  return CHUNK_TARGET_TYPES_BY_LANG[langId] ?? [];
}

// Tree-sitter node types that denote a call site or an import, per grammar. Siblings of
// CHUNK_TARGET_TYPES_BY_LANG. A language with no entry yields no code edges (grammarless and
// edgeless degrade the same way chunking does). `call` types are extracted for callee names;
// `import` types are extracted for module sources (+ named specifiers where the grammar exposes them).
const EDGE_NODE_TYPES_BY_LANG = {
  typescript: { call: ["call_expression", "new_expression"], import: ["import_statement"] },
  tsx:        { call: ["call_expression", "new_expression"], import: ["import_statement"] },
  javascript: { call: ["call_expression", "new_expression"], import: ["import_statement"] },
  python:     { call: ["call"], import: ["import_statement", "import_from_statement"] },
  rust:       { call: ["call_expression", "macro_invocation"], import: ["use_declaration"] },
  go:         { call: ["call_expression"], import: ["import_declaration"] },
  c:          { call: ["call_expression"], import: ["preproc_include"] },
  cpp:        { call: ["call_expression"], import: ["preproc_include", "using_declaration"] },
  objc:       { call: ["call_expression", "message_expression"], import: ["preproc_include"] },
  glsl:       { call: ["call_expression"], import: [] },
  hlsl:       { call: ["call_expression"], import: ["preproc_include"] },
};

export function edgeTypes(langId) {
  return EDGE_NODE_TYPES_BY_LANG[langId] ?? { call: [], import: [] };
}
