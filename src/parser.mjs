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
  python: "python", rust: "rust", go: "go" };

function wasmsDir() {
  // Prefer the grammars bundled into the package (grammars/, populated at prepack). Fall back to
  // the tree-sitter-wasms devDependency for a fresh git clone before anything's been bundled.
  const bundled = fileURLToPath(new URL("../grammars", import.meta.url));
  if (existsSync(join(bundled, "tree-sitter-typescript.wasm"))) return bundled;
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

export async function getParser(langId) {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
  if (langCache.has(langId)) return langCache.get(langId);
  const name = WASM_NAME[langId];
  if (!name) { langCache.set(langId, null); return null; }
  try {
    const lang = await Language.load(join(wasmsDir(), `tree-sitter-${name}.wasm`));
    const parser = new Parser();
    parser.setLanguage(lang);
    langCache.set(langId, parser);
    return parser;
  } catch {
    langCache.set(langId, null);
    return null;
  }
}
