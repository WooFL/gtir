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

test("contextScope defaults to true; overridable to false", () => {
  const on = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  assert.equal(loadConfig(on).contextScope, true);
  const off = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  mkdirSync(join(off, ".gtir"), { recursive: true });
  writeFileSync(join(off, ".gtir", "config.json"), JSON.stringify({ contextScope: false }));
  assert.equal(loadConfig(off).contextScope, false);
});

test("rerank defaults: off, with url/model/candidates/maxChars", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  const cfg = loadConfig(repo);
  assert.equal(cfg.rerank, false);
  assert.equal(cfg.rerankUrl, "http://127.0.0.1:8088");
  assert.equal(cfg.rerankModel, "bge-reranker-v2-m3");
  assert.equal(cfg.rerankCandidates, 24);
  assert.equal(cfg.rerankMaxChars, 2000);
});

test("rerank is overridable via .gtir/config.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ rerank: true, rerankCandidates: 30 }));
  const cfg = loadConfig(repo);
  assert.equal(cfg.rerank, true);
  assert.equal(cfg.rerankCandidates, 30);
});

test("DEFAULTS carry embed-resilience knobs", () => {
  const cfg = loadConfig(process.cwd());
  assert.equal(cfg.embedTimeoutMs, 60000);
  assert.equal(cfg.embedRetries, 2);
  assert.equal(cfg.embedRetryBackoffMs, 500);
  assert.equal(cfg.warmupOnStart, true);
});

test("DEFAULTS include centrality + context-cap knobs", () => {
  assert.equal(DEFAULTS.centralityWeight, 0.15);
  assert.equal(DEFAULTS.centralityK, 8);
  assert.equal(DEFAULTS.contextCap, 5);
});

test("DEFAULTS include disambiguation knobs", () => {
  assert.equal(DEFAULTS.disambiguate, true);
  assert.equal(DEFAULTS.disambigThreshold, 0.55);
  assert.equal(DEFAULTS.disambigMargin, 0.05);
});
