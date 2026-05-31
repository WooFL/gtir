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

import { handleRequest } from "../src/mcp.mjs";

const baseCtx = {
  indexes: [{ label: "code", repo: "/r", cfg: {} }],
  searchFn: async () => [],
  statusFn: async () => [],
  version: "9.9.9",
};

test("handleRequest: initialize returns serverInfo + tools capability", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, baseCtx);
  assert.equal(r.result.serverInfo.name, "gtir");
  assert.equal(r.result.serverInfo.version, "9.9.9");
  assert.ok(r.result.capabilities.tools);
});

test("handleRequest: notifications/initialized returns null (no reply)", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, baseCtx);
  assert.equal(r, null);
});

test("handleRequest: tools/list returns the tool set", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, baseCtx);
  assert.deepEqual(r.result.tools.map((t) => t.name), ["search_code", "gtir_status"]);
});

test("handleRequest: unknown method => JSON-RPC -32601", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 3, method: "bogus/x" }, baseCtx);
  assert.equal(r.error.code, -32601);
});

const hit = { path: "a.ts", lines: "1-2", language: "ts", score: 0.5, vec_rank: 1, fts_rank: 2, snippet: "code body" };

test("tools/call search_<label> calls searchFn and wraps results", async () => {
  let got = null;
  const ctx = { ...baseCtx, searchFn: async (label, args) => { got = { label, args }; return [hit]; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_code", arguments: { query: "find foo", k: 3, path_prefix: "src/" } } }, ctx);
  assert.equal(got.label, "code");
  assert.equal(got.args.query, "find foo");
  assert.equal(got.args.k, 3);
  assert.equal(got.args.pathPrefix, "src/"); // path_prefix mapped to pathPrefix
  assert.deepEqual(r.result.structuredContent.results, [hit]);
  assert.match(r.result.content[0].text, /a\.ts:1-2/);
  assert.match(r.result.content[0].text, /v1\+f2/); // branch annotation
});

test("tools/call gtir_status calls statusFn", async () => {
  const status = [{ label: "code", files: 3, dim: "896" }];
  const ctx = { ...baseCtx, statusFn: async () => status };
  const r = await handleRequest({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gtir_status", arguments: {} } }, ctx);
  assert.deepEqual(r.result.structuredContent.indexes, status);
});

test("tools/call unknown index => isError", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_missing", arguments: { query: "x" } } }, baseCtx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown index: missing/);
});

test("tools/call: a thrown searchFn error becomes a graceful isError result", async () => {
  const ctx = { ...baseCtx, searchFn: async () => { throw new Error("ollama down"); } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_code", arguments: { query: "x" } } }, ctx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /ollama down/);
});

test("tools/call gtir_status: a thrown statusFn error becomes a graceful isError result", async () => {
  const ctx = { ...baseCtx, statusFn: async () => { throw new Error("store unreadable"); } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "gtir_status", arguments: {} } }, ctx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /store unreadable/);
});

test("handleRequest preserves a numeric id of 0 (JSON-RPC allows it)", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 0, method: "tools/list" }, baseCtx);
  assert.equal(r.id, 0);
});

import { printConfig } from "../src/mcp.mjs";

test("printConfig emits a stdio .mcp.json snippet with node + the repos", () => {
  const snippet = JSON.parse(printConfig(["G:/p/code", "G:/p/wiki"]));
  assert.equal(snippet.gtir.type, "stdio");
  assert.equal(snippet.gtir.command, "node");
  assert.match(snippet.gtir.args.join(" "), /bin\/gtir\.mjs mcp/);
  assert.ok(snippet.gtir.args.includes("G:/p/code"));
  assert.ok(snippet.gtir.args.includes("G:/p/wiki"));
});
