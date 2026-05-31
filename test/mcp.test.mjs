import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel, deriveLabel, resolveIndexes } from "../src/mcp.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sanitizeLabel lowercases and collapses non-[a-z0-9_] to _", () => {
  assert.equal(sanitizeLabel("My Wiki!"), "my_wiki");
  assert.equal(sanitizeLabel("engine-core"), "engine_core");
  assert.equal(sanitizeLabel("code"), "code");
  assert.equal(sanitizeLabel("///"), "index"); // empty after strip -> fallback
});

test("deriveLabel: override wins; nomic=>notes; jina-code=>code; else basename", () => {
  assert.equal(deriveLabel("/x/wiki", { model: "nomic-embed-text" }, null), "notes");
  assert.equal(deriveLabel("/x/repo", { model: "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16" }, null), "code");
  assert.equal(deriveLabel("/x/My Repo", { model: "something-else" }, null), "my_repo");
  assert.equal(deriveLabel("/x/repo", { model: "nomic-embed-text" }, "custom"), "custom");
});

function repoWithModel(model) {
  const d = mkdtempSync(join(tmpdir(), "gtir-mcp-"));
  mkdirSync(join(d, ".gtir"), { recursive: true });
  writeFileSync(join(d, ".gtir", "config.json"), JSON.stringify({ model }));
  return d;
}

test("resolveIndexes builds {label,repo,cfg} and applies model-derived labels", () => {
  const code = repoWithModel("hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16");
  const notes = repoWithModel("nomic-embed-text");
  const ix = resolveIndexes([code, notes], {});
  assert.deepEqual(ix.map((i) => i.label), ["code", "notes"]);
  assert.equal(ix[0].cfg.model, "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16");
});

test("resolveIndexes throws on label collision, unless --label disambiguates", () => {
  const a = repoWithModel("nomic-embed-text");
  const b = repoWithModel("nomic-embed-text");
  assert.throws(() => resolveIndexes([a, b], {}), /disambiguate with --label/);
  const ix = resolveIndexes([a, b], { [b]: "notes2" });
  assert.deepEqual(ix.map((i) => i.label).sort(), ["notes", "notes2"]);
});

import { buildTools } from "../src/mcp.mjs";

test("buildTools emits search_<label> per index plus gtir_status", () => {
  const tools = buildTools([{ label: "code", repo: "/r/code", cfg: {} }, { label: "notes", repo: "/r/wiki", cfg: {} }]);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ["search_code", "search_notes", "gtir_status"]);
  const search = tools[0];
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.ok(search.inputSchema.properties.k);
  assert.ok(search.inputSchema.properties.path_prefix);
  assert.deepEqual(tools[2].inputSchema.properties, {}); // status takes no args
});
