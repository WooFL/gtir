import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "./config.mjs";
import { walkRepo } from "./walker.mjs";
import { buildIndex } from "./indexer.mjs";
import { installHook } from "./hook.mjs";

// Prose-tuned preset for note vaults. The code defaults (jina-code, large
// chunks, maxEmbedChars 6000) are wrong for notes: prose wants smaller chunks
// and nomic-embed-text's 2048-token context demands a tight embed cap.
export const NOTES_PRESET = {
  model: "nomic-embed-text",
  maxChars: 1500,
  minChars: 80,
  overlapChars: 200,
  maxEmbedChars: 2000,
};

// Immediate subdirectories that look like Obsidian vaults (contain .obsidian/).
// When indexing CODE, these get excluded so a nested vault isn't double-indexed
// with the code model (e.g. a "wiki/" folder living inside a code repo).
function detectNestedVaults(repo) {
  try {
    return readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !DEFAULTS.skipDirs.includes(e.name))
      .filter((e) => existsSync(join(repo, e.name, ".obsidian")))
      .map((e) => e.name);
  } catch { return []; }
}

// "notes" if the repo is an Obsidian vault or markdown-dominant; else "code".
export function detectMode(repo) {
  if (existsSync(join(repo, ".obsidian"))) return "notes";
  let files;
  try { files = walkRepo(loadConfig(repo)); } catch { return "code"; }
  if (files.length === 0) return "code";
  const md = files.filter((f) => /\.(md|mdx)$/i.test(f.relPath)).length;
  return md / files.length >= 0.5 ? "notes" : "code";
}

export function presetFor(repo, mode) {
  if (mode === "notes") return { ...NOTES_PRESET };
  const cfg = { model: DEFAULTS.model };
  const vaults = detectNestedVaults(repo);
  if (vaults.length) cfg.skipDirs = [...DEFAULTS.skipDirs, ...vaults];
  return cfg;
}

// Writes <repo>/.gtir/config.json. Never clobbers an existing config.
export function writeConfig(repo, mode) {
  const dir = join(repo, ".gtir");
  const file = join(dir, "config.json");
  if (existsSync(file)) return { written: false, path: file, reason: "exists" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(presetFor(repo, mode), null, 2) + "\n");
  return { written: true, path: file };
}

// Appends `.gtir/` to .gitignore (creating it if absent). Idempotent.
export function ensureGitignore(repo) {
  const gi = join(repo, ".gitignore");
  const body = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (/^\.gtir\/?\s*$/m.test(body)) return { added: false };
  const block = "# gtir retrieval index (regenerable)\n.gtir/\n";
  const out = body ? body + (body.endsWith("\n") ? "" : "\n") + "\n" + block : block;
  writeFileSync(gi, out);
  return { added: true };
}

export function detectHookManager(repo) {
  if (["lefthook.yml", ".lefthook.yml", "lefthook.yaml", ".lefthook.yaml"].some((f) => existsSync(join(repo, f)))) return "lefthook";
  if (existsSync(join(repo, ".husky"))) return "husky";
  if (existsSync(join(repo, ".git"))) return "git";
  return "none";
}

export const LEFTHOOK_SNIPPET = `post-commit:
  commands:
    gtir-index:
      run: gtir refresh --repo . || true`;

export async function runInit({ repo, mode = null, index = true, hook = true, embedImpl = null } = {}) {
  const resolvedMode = mode ?? detectMode(repo);
  const config = writeConfig(repo, resolvedMode);
  const gitignore = ensureGitignore(repo);
  const hookManager = detectHookManager(repo);

  let indexed = null;
  if (index) {
    const cfg = loadConfig(repo); // picks up the just-written config
    if (embedImpl) cfg.embedImpl = embedImpl;
    indexed = await buildIndex(cfg, { rebuild: true });
  }

  let hookInstalled = false;
  let lefthookSnippet = null;
  if (hook) {
    if (hookManager === "git") { installHook(repo); hookInstalled = true; }
    else if (hookManager === "lefthook") { lefthookSnippet = LEFTHOOK_SNIPPET; }
  }

  return { repo, mode: resolvedMode, config, gitignore, hookManager, indexed, hookInstalled, lefthookSnippet };
}
