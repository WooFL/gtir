// Copy the grammars gtir actually loads out of the tree-sitter-wasms devDependency into
// grammars/, which ships in the npm tarball (see package.json "files" + "prepack"). gtir only
// AST-chunks the languages with target types in src/languages.mjs — the other ~30 grammars in
// tree-sitter-wasms are never loaded (src/parser.mjs only calls getParser for these), so we don't
// ship them. Keep NEEDED in sync with WASM_NAME in src/parser.mjs.
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NEEDED = ["typescript", "tsx", "javascript", "python", "rust", "go"];

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const dest = join(root, "grammars");

rmSync(dest, { recursive: true, force: true });   // start clean so a removed grammar can't linger
mkdirSync(dest, { recursive: true });
for (const name of NEEDED) {
  const file = `tree-sitter-${name}.wasm`;
  const src = join(out, file);
  if (!existsSync(src)) throw new Error(`grammar not found: ${src} (is tree-sitter-wasms installed?)`);
  copyFileSync(src, join(dest, file));
}
console.log(`bundled ${NEEDED.length} grammars → grammars/`);
