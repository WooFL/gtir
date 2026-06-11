import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS, pickEmbedModel, resolveAutoModel, embedIdentity } from "../src/config.mjs";

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

test("embedIdentity: ollama (default) is the bare model tag — back-compatible with pre-backend indexes", () => {
  assert.equal(embedIdentity({ embedBackend: "ollama", model: "qwen3-embedding:0.6b" }), "qwen3-embedding:0.6b");
  // an absent embedBackend behaves like ollama (defaults applied elsewhere)
  assert.equal(embedIdentity({ model: "nomic-embed-text" }), "nomic-embed-text");
});

test("embedIdentity: transformers folds backend + dtype into the key so a switch invalidates the cache", () => {
  const m = "qwen3-embedding:0.6b";
  assert.equal(embedIdentity({ embedBackend: "transformers", model: m, transformersDtype: "fp32" }), `${m}|transformers|fp32`);
  assert.equal(embedIdentity({ embedBackend: "transformers", model: m, transformersDtype: "q8" }), `${m}|transformers|q8`);
  // dtype omitted → defaults to fp32 (matches DEFAULTS.transformersDtype)
  assert.equal(embedIdentity({ embedBackend: "transformers", model: m }), `${m}|transformers|fp32`);
  // every pair distinct: ollama vs fp32 vs q8 are three different identities for the same model
  const ids = new Set([
    embedIdentity({ embedBackend: "ollama", model: m }),
    embedIdentity({ embedBackend: "transformers", model: m, transformersDtype: "fp32" }),
    embedIdentity({ embedBackend: "transformers", model: m, transformersDtype: "q8" }),
  ]);
  assert.equal(ids.size, 3);
});

test("loadConfig: transformers backend (default) attaches an embedImpl; ollama override does not", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cfg-"));
  // Default backend is transformers → loadConfig hangs the in-process embedder on cfg.embedImpl.
  assert.equal(typeof loadConfig(repo).embedImpl, "function");
  // Opting back to the ollama HTTP backend leaves embedImpl unset (consumers use embedTexts).
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ embedBackend: "ollama" }));
  assert.equal(typeof loadConfig(repo).embedImpl, "undefined");
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

test("pickEmbedModel: markdown-only repo → nomic", () => {
  assert.equal(pickEmbedModel(["a.md", "notes/b.md", "c.mdx"]), "nomic-embed-text");
});
test("pickEmbedModel: any code file → null (default/qwen)", () => {
  assert.equal(pickEmbedModel(["a.md", "src/x.ts"]), null);
  assert.equal(pickEmbedModel(["a.md", "main.cpp"]), null);
});
test("pickEmbedModel: markdown + only data/markup files → still nomic", () => {
  assert.equal(pickEmbedModel(["a.md", "settings.json", "x.yaml", "canvas.json"]), "nomic-embed-text");
});
test("pickEmbedModel: no markdown → null", () => {
  assert.equal(pickEmbedModel(["a.json", "b.yaml"]), null);
  assert.equal(pickEmbedModel([]), null);
});

test("resolveAutoModel: md-only repo with no pin → nomic, persisted to config.json", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-am-"));
  try {
    mkdirSync(join(repo, ".gtir"), { recursive: true });
    const cfg = loadConfig(repo);
    assert.equal(resolveAutoModel(cfg, ["a.md", "b.md"]), "nomic-embed-text");
    const written = JSON.parse(readFileSync(join(repo, ".gtir", "config.json"), "utf8"));
    assert.equal(written.model, "nomic-embed-text");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("resolveAutoModel: repo with code → returns cfg.model, writes nothing", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-am-"));
  try {
    mkdirSync(join(repo, ".gtir"), { recursive: true });
    const cfg = loadConfig(repo);
    assert.equal(resolveAutoModel(cfg, ["a.md", "x.ts"]), cfg.model); // qwen default
    assert.equal(existsSync(join(repo, ".gtir", "config.json")), false); // no write
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("resolveAutoModel: explicit model pin is respected (no flip)", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-am-"));
  try {
    mkdirSync(join(repo, ".gtir"), { recursive: true });
    writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ model: "x-custom" }));
    const cfg = loadConfig(repo);  // cfg.model === "x-custom"
    assert.equal(resolveAutoModel(cfg, ["a.md", "b.md"]), "x-custom");  // respected, not nomic
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
