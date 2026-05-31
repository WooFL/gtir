import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let initPromise = null;
const langCache = new Map();

// tree-sitter-wasms ships prebuilt grammar wasm at out/tree-sitter-<name>.wasm.
// Our lang ids mostly match; map the exceptions.
const WASM_NAME = { typescript: "typescript", tsx: "tsx", javascript: "javascript",
  python: "python", rust: "rust", go: "go", bash: "bash", json: "json",
  toml: "toml", yaml: "yaml", css: "css", html: "html", markdown: "markdown" };

function wasmsDir() {
  // Resolve the installed package.json (its broken `main` is irrelevant here),
  // then its out/ dir.
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkg), "out");
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
