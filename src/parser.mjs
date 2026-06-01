import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let initPromise = null;
const langCache = new Map();

// The grammars gtir loads — exactly the languages that have AST target types in languages.mjs.
// getParser is only ever reached for these (chunkWithTreesitter recurses for the rest), so the
// other ~30 grammars in tree-sitter-wasms are never used. Keep in sync with scripts/bundle-grammars.mjs.
const WASM_NAME = { typescript: "typescript", tsx: "tsx", javascript: "javascript",
  python: "python", rust: "rust", go: "go", c: "c", cpp: "cpp", objc: "objc" };

function grammarPath(name) {
  // Prefer the grammar bundled into the package (grammars/, populated at prepack), checked PER
  // grammar so a partial bundle still works; fall back to the tree-sitter-wasms devDependency
  // (present in a git clone). A published install has the full bundle; a clone has the devDep.
  const file = `tree-sitter-${name}.wasm`;
  const bundled = fileURLToPath(new URL(`../grammars/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out", file);
}

export async function getParser(langId) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  if (langCache.has(langId)) return langCache.get(langId);
  const name = WASM_NAME[langId];
  if (!name) { langCache.set(langId, null); return null; }
  try {
    const lang = await Language.load(grammarPath(name));
    const parser = new Parser();
    parser.setLanguage(lang);
    langCache.set(langId, parser);
    return parser;
  } catch {
    langCache.set(langId, null);
    return null;
  }
}
