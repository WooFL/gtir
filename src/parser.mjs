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
  python: "python", rust: "rust", go: "go", c: "c", cpp: "cpp", objc: "objc",
  glsl: "glsl", hlsl: "hlsl" };

function grammarPath(name) {
  // Resolve a grammar wasm per grammar (so a partial bundle still works):
  //   1) vendor/grammars/ — committed grammars NOT in tree-sitter-wasms (the shader grammars,
  //      built from source with the tree-sitter CLI; see scripts/build-shader-grammars.mjs).
  //   2) grammars/ — the prepack bundle copied from the tree-sitter-wasms devDependency.
  //   3) the tree-sitter-wasms devDependency itself (present in a dev clone before prepack).
  const file = `tree-sitter-${name}.wasm`;
  const vendored = fileURLToPath(new URL(`../vendor/grammars/${file}`, import.meta.url));
  if (existsSync(vendored)) return vendored;
  const bundled = fileURLToPath(new URL(`../grammars/${file}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out", file);
}

// Grammars that are NOT in tree-sitter-wasms and aren't bundled at publish: the shader
// grammars, built on demand (npm run build:shaders) and therefore possibly absent. When a
// repo contains files for one of these but the wasm isn't on disk, gtir still indexes them
// (line-window fallback) — the indexer surfaces a notice so AST chunking can be enabled.
export const OPTIONAL_GRAMMARS = new Set(["glsl", "hlsl"]);

// True when langId maps to a grammar whose wasm can't be found on disk. Pure filesystem
// check — no WASM load — so the indexer can cheaply detect a missing optional grammar.
export function grammarMissing(langId) {
  const name = WASM_NAME[langId];
  if (!name) return false;
  try { return !existsSync(grammarPath(name)); } catch { return true; }
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
