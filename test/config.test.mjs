import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS } from "../src/config.mjs";

test("loadConfig returns defaults when no override file", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  const cfg = loadConfig(repo);
  assert.equal(cfg.repo, repo);
  assert.equal(cfg.model, DEFAULTS.model);
  assert.equal(cfg.maxChars, DEFAULTS.maxChars);
  assert.equal(cfg.indexDir, join(repo, ".gtir", "index.lance"));
});

test("loadConfig merges .gtir/config.json over defaults", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"),
    JSON.stringify({ model: "jina-code-embeddings-1.5b", maxChars: 3000 }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.model, "jina-code-embeddings-1.5b");
  assert.equal(cfg.maxChars, 3000);
  assert.equal(cfg.minChars, DEFAULTS.minChars); // untouched default preserved
});

test("noCache defaults to false", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  assert.equal(loadConfig(repo).noCache, false);
});
