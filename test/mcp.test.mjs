import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel, deriveLabel, resolveIndexes, defaultStatusFn } from "../src/mcp.mjs";
import { loadConfig } from "../src/config.mjs";
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

test("buildTools emits search/read/outline/similar per index + gtir_status", () => {
  const tools = buildTools([{ label: "code", repo: "/r/code", cfg: {} }, { label: "notes", repo: "/r/wiki", cfg: {} }]);
  assert.deepEqual(tools.map((t) => t.name), [
    "search_code", "read_code", "outline_code", "similar_code", "find_code",
    "search_notes", "read_notes", "outline_notes", "similar_notes", "find_notes",
    "gtir_status",
  ]);
  assert.deepEqual(tools[0].inputSchema.required, ["query"]);   // search
  assert.ok(tools[0].inputSchema.properties.compact);           // search gained compact
  assert.deepEqual(tools[1].inputSchema.required, ["path"]);    // read
  assert.deepEqual(tools[2].inputSchema.required, ["path"]);    // outline
  assert.deepEqual(tools[3].inputSchema.required, ["path"]);    // similar
  assert.deepEqual(tools[4].inputSchema.required, ["symbol"]);  // find
  assert.deepEqual(tools[4].inputSchema.properties.kind.enum, ["definition", "references"]);
  assert.deepEqual(tools.at(-1).inputSchema.properties, {});    // status takes no args
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
  assert.deepEqual(r.result.tools.map((t) => t.name),
    ["search_code", "read_code", "outline_code", "similar_code", "find_code", "gtir_status"]);
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

test("tools/call search compact strips the snippet from results and text", async () => {
  const ctx = { ...baseCtx, searchFn: async () => [hit] };
  const r = await handleRequest({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "search_code", arguments: { query: "x", compact: true } } }, ctx);
  assert.equal(r.result.structuredContent.results[0].snippet, undefined);   // stripped from structured data
  assert.match(r.result.content[0].text, /a\.ts:1-2/);
  assert.doesNotMatch(r.result.content[0].text, /code body/);               // and from the rendered text
});

test("tools/call read_<label> calls readFn and renders a code block", async () => {
  let got = null;
  const ctx = { ...baseCtx, readFn: async (label, a) => { got = { label, a }; return { path: a.path, lines: "10-14", text: "line A\nline B" }; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "read_code", arguments: { path: "src/x.ts", lines: "12", context: 2 } } }, ctx);
  assert.equal(got.label, "code");
  assert.deepEqual([got.a.path, got.a.lines, got.a.context], ["src/x.ts", "12", 2]);
  assert.match(r.result.content[0].text, /src\/x\.ts:10-14/);
  assert.match(r.result.content[0].text, /line A/);
  assert.equal(r.result.structuredContent.lines, "10-14");
});

test("tools/call outline_<label> lists a file's chunks", async () => {
  const ctx = { ...baseCtx, outlineFn: async (label, a) => ({ path: a.path, symbols: [{ lines: "1-9", language: "ts", signature: "export function foo()" }] }) };
  const r = await handleRequest({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "outline_code", arguments: { path: "src/x.ts" } } }, ctx);
  assert.match(r.result.content[0].text, /export function foo/);
  assert.equal(r.result.structuredContent.symbols.length, 1);
});

test("tools/call similar_<label> calls similarFn and wraps results", async () => {
  let got = null;
  const ctx = { ...baseCtx, similarFn: async (label, a) => { got = a; return [hit]; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "similar_code", arguments: { path: "a.ts", line: 5, limit: 4 } } }, ctx);
  assert.deepEqual([got.path, got.line, got.limit], ["a.ts", 5, 4]);
  assert.deepEqual(r.result.structuredContent.results, [hit]);
  assert.match(r.result.content[0].text, /a\.ts:1-2/);
});

test("tools/call read_<label> on an unknown index => isError (before readFn runs)", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "read_missing", arguments: { path: "x" } } }, baseCtx);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /unknown index: missing/);
});

test("tools/call find_<label> defaults kind to definition and passes it through", async () => {
  let got = null;
  const ctx = { ...baseCtx, findFn: async (label, a) => { got = a; return [{ path: "src/s.mjs", lines: "19-36", language: "js", kind: "definition", snippet: "export function fuseRRF()" }]; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "find_code", arguments: { symbol: "fuseRRF" } } }, ctx);
  assert.deepEqual([got.symbol, got.kind], ["fuseRRF", "definition"]);  // kind defaulted
  assert.equal(r.result.structuredContent.kind, "definition");
  assert.match(r.result.content[0].text, /src\/s\.mjs:19-36/);
  assert.match(r.result.content[0].text, /definition/);
});

test("tools/call find_<label> honors kind=references", async () => {
  let got = null;
  const ctx = { ...baseCtx, findFn: async (label, a) => { got = a; return []; } };
  const r = await handleRequest({ jsonrpc: "2.0", id: 26, method: "tools/call", params: { name: "find_code", arguments: { symbol: "x", kind: "references" } } }, ctx);
  assert.equal(got.kind, "references");
  assert.match(r.result.content[0].text, /no references found for "x"/);
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

test("defaultStatusFn: an unbuilt index reports healthy:false + a note, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-status-"));
  const indexes = [{ label: "code", repo: dir, cfg: loadConfig(dir) }];
  const status = await defaultStatusFn(indexes)();
  assert.equal(status.length, 1);
  assert.equal(status[0].healthy, false);
  assert.match(status[0].note, /not built/);
});

import { parseToolName, defaultReadFn, declaredSymbols } from "../src/mcp.mjs";

test("declaredSymbols extracts all declared names across languages, de-duped", () => {
  assert.deepEqual(declaredSymbols("export function fuseRRF(a) {}\nconst RRF_K = 60"), ["fuseRRF", "RRF_K"]);
  assert.deepEqual(declaredSymbols("class LRU:\n  def get(self): pass\n  def put(self): pass"), ["LRU", "get", "put"]);
  assert.deepEqual(declaredSymbols("pub fn rotate() {}\nstruct Vec3 {}"), ["rotate", "Vec3"]);
  assert.deepEqual(declaredSymbols("// fuseRRF is called here\nfuseRRF()"), []);  // a mention, not a declaration
});

test("declaredSymbols detects C-family function/method definitions (body brace, not calls)", () => {
  // free function with no declaring keyword — the gap this fixes
  assert.deepEqual(declaredSymbols("DiskCache& disk_cache() {\n  static DiskCache d;\n  return d;\n}"), ["disk_cache"]);
  // qualified method definition → captures the method name, not the class
  assert.deepEqual(declaredSymbols("void DiskCache::write(int x) const {\n  buf_ = x;\n}"), ["write"]);
  // const method inside a class body (+ the class keyword)
  assert.deepEqual(declaredSymbols("struct Vec {\n  float length() const { return 0; }\n}"), ["Vec", "length"]);
  // a CALL is not a definition (no body brace)
  assert.deepEqual(declaredSymbols("feedback::disk_cache().write(buf);"), []);
  // a prototype is not a definition
  assert.deepEqual(declaredSymbols("int compute(int n);"), []);
  // control flow is not a definition
  assert.deepEqual(declaredSymbols("if (ready) {\n  while (busy) {}\n}"), []);
});

test("parseToolName splits a verb prefix off, keeping underscores in the label", () => {
  assert.deepEqual(parseToolName("search_code"), { verb: "search", label: "code" });
  assert.deepEqual(parseToolName("read_my_wiki"), { verb: "read", label: "my_wiki" });
  assert.deepEqual(parseToolName("outline_x"), { verb: "outline", label: "x" });
  assert.equal(parseToolName("gtir_status"), null);
  assert.equal(parseToolName("bogus_x"), null);
});

test("defaultReadFn slices a span with context and blocks path traversal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-read-"));
  writeFileSync(join(dir, "f.txt"), "L1\nL2\nL3\nL4\nL5\n");
  const read = defaultReadFn([{ label: "code", repo: dir, cfg: {} }]);
  const out = await read("code", { path: "f.txt", lines: "2-3", context: 1 });
  assert.equal(out.lines, "1-4");                 // 2-3 padded by 1 each side, clamped to file
  assert.equal(out.text, "L1\nL2\nL3\nL4");
  await assert.rejects(read("code", { path: "../escape", lines: "1" }), /escapes the repo/);
});
