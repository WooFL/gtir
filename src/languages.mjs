export const INDEXABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".wgsl", ".slang",
  ".py", ".rs", ".go", ".sh",
  ".json", ".toml", ".yml", ".yaml",
  ".css", ".html", ".md", ".mdx",
]);

// null => no tree-sitter grammar; use recursive char splitter.
const EXT_TO_TS_LANG = {
  ".ts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go", ".sh": "bash",
  ".json": "json", ".toml": "toml", ".yml": "yaml", ".yaml": "yaml",
  ".css": "css", ".html": "html", ".md": "markdown", ".mdx": "markdown",
  ".wgsl": null, ".slang": null,
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
