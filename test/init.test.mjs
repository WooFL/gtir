import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { detectMode, writeConfig, ensureGitignore, detectHookManager, presetFor, runInit, NOTES_PRESET } from "../src/init.mjs";
import { DEFAULTS } from "../src/config.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "gtir-init-"));
function put(dir, rel, body = "some content long enough to clear the minimum chunk size here easily") {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

test("detectMode: .obsidian dir => notes", () => {
  const r = tmp();
  mkdirSync(join(r, ".obsidian"));
  put(r, "note.md");
  assert.equal(detectMode(r), "notes");
});

test("detectMode: markdown-majority => notes; code-majority => code", () => {
  const n = tmp();
  for (const f of ["a.md", "b.md", "c.md", "d.ts"]) put(n, f);
  assert.equal(detectMode(n), "notes");
  const c = tmp();
  for (const f of ["a.ts", "b.ts", "c.ts", "d.md"]) put(c, f);
  assert.equal(detectMode(c), "code");
});

test("writeConfig: notes preset = nomic + maxEmbedChars 2000; no clobber", () => {
  const r = tmp();
  assert.equal(writeConfig(r, "notes").written, true);
  const cfg = JSON.parse(readFileSync(join(r, ".gtir", "config.json"), "utf8"));
  assert.equal(cfg.model, "nomic-embed-text");
  assert.equal(cfg.maxEmbedChars, 2000);
  assert.equal(cfg.minChars, NOTES_PRESET.minChars);
  assert.equal(writeConfig(r, "code").written, false); // never clobbers
});

test("writeConfig: code preset uses the default model", () => {
  const r = tmp();
  writeConfig(r, "code");
  const cfg = JSON.parse(readFileSync(join(r, ".gtir", "config.json"), "utf8"));
  assert.equal(cfg.model, DEFAULTS.model);
});

test("presetFor: code mode auto-excludes a nested Obsidian vault via skipDirs", () => {
  const r = tmp();
  mkdirSync(join(r, "wiki", ".obsidian"), { recursive: true });
  put(r, "src/a.ts");
  const cfg = presetFor(r, "code");
  assert.ok(cfg.skipDirs.includes("wiki"), "nested vault dir must be skipped");
  // notes mode does not add skipDirs
  assert.equal(presetFor(r, "notes").skipDirs, undefined);
});

test("ensureGitignore: adds .gtir/, idempotent, creates file if missing", () => {
  const r = tmp();
  assert.equal(ensureGitignore(r).added, true);
  assert.match(readFileSync(join(r, ".gitignore"), "utf8"), /^\.gtir\/$/m);
  assert.equal(ensureGitignore(r).added, false);
});

test("detectHookManager: lefthook.yml => lefthook; .git => git; none", () => {
  const l = tmp(); writeFileSync(join(l, "lefthook.yml"), "pre-push:\n");
  assert.equal(detectHookManager(l), "lefthook");
  const g = tmp(); mkdirSync(join(g, ".git"));
  assert.equal(detectHookManager(g), "git");
  assert.equal(detectHookManager(tmp()), "none");
});

test("runInit (no index, no hook): writes config + gitignore, detects mode", async () => {
  const r = tmp();
  mkdirSync(join(r, ".obsidian"));
  put(r, "note.md", "# A real note with plenty of words to be a genuine page here");
  const res = await runInit({ repo: r, index: false, hook: false });
  assert.equal(res.mode, "notes");
  assert.equal(res.config.written, true);
  assert.equal(res.gitignore.added, true);
  assert.ok(existsSync(join(r, ".gtir", "config.json")));
});

test("runInit with index uses the written config + injected embedder", async () => {
  const r = tmp();
  const body = "export function foo(input) {\n  // pad this function body so the AST node comfortably exceeds the 100-char minimum chunk size threshold\n  return String(input).trim().toUpperCase();\n}";
  for (const f of ["a.ts", "b.ts"]) put(r, f, body);
  const fakeEmbed = (texts) => Promise.resolve(texts.map(() => { const v = [1, 2, 3]; const n = Math.hypot(...v); return v.map((x) => x / n); }));
  const res = await runInit({ repo: r, index: true, hook: false, embedImpl: fakeEmbed });
  assert.equal(res.mode, "code");
  assert.ok(res.indexed.chunks >= 1);
});

test("runInit with hook on a plain git repo installs the post-commit hook", async () => {
  const r = tmp();
  mkdirSync(join(r, ".git", "hooks"), { recursive: true });
  put(r, "a.ts");
  const res = await runInit({ repo: r, index: false, hook: true });
  assert.equal(res.hookManager, "git");
  assert.equal(res.hookInstalled, true);
  assert.ok(existsSync(join(r, ".git", "hooks", "post-commit")));
});

test("runInit with hook on a lefthook repo returns the snippet, installs nothing", async () => {
  const r = tmp();
  mkdirSync(join(r, ".git", "hooks"), { recursive: true });
  writeFileSync(join(r, "lefthook.yml"), "pre-push:\n");
  put(r, "a.ts");
  const res = await runInit({ repo: r, index: false, hook: true });
  assert.equal(res.hookManager, "lefthook");
  assert.equal(res.hookInstalled, false);
  assert.match(res.lefthookSnippet, /gtir refresh --repo \./);
  assert.equal(existsSync(join(r, ".git", "hooks", "post-commit")), false); // did NOT clobber lefthook
});
