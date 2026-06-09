import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel, deriveLabel, resolveIndexes, defaultStatusFn, preflightIndexes } from "../src/mcp.mjs";
import { loadConfig } from "../src/config.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/indexer.mjs";

test("sanitizeLabel lowercases and collapses non-[a-z0-9_] to _", () => {
  assert.equal(sanitizeLabel("My Wiki!"), "my_wiki");
  assert.equal(sanitizeLabel("engine-core"), "engine_core");
  assert.equal(sanitizeLabel("code"), "code");
  assert.equal(sanitizeLabel("///"), "index"); // empty after strip -> fallback
});

test("deriveLabel: override wins; nomic=>notes; jina-code/qwen3-embedding=>code; else basename", () => {
  assert.equal(deriveLabel("/x/wiki", { model: "nomic-embed-text" }, null), "notes");
  assert.equal(deriveLabel("/x/repo", { model: "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16" }, null), "code");
  assert.equal(deriveLabel("/x/repo", { model: "qwen3-embedding:0.6b" }, null), "code");   // the new default
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

test("buildTools emits search/read/outline/similar/find/callers/callees/neighbors per index + gtir_status", () => {
  const tools = buildTools([{ label: "code", repo: "/r/code", cfg: {} }, { label: "notes", repo: "/r/wiki", cfg: {} }]);
  assert.deepEqual(tools.map((t) => t.name), [
    "context_code", "search_code", "read_code", "outline_code", "similar_code", "find_code",
    "callers_code", "callees_code", "neighbors_code", "impact_code", "orphans_code", "cycles_code", "path_code",
    "context_notes", "search_notes", "read_notes", "outline_notes", "similar_notes", "find_notes",
    "backlinks_notes", "links_notes", "neighbors_notes", "impact_notes", "orphans_notes", "cycles_notes", "path_notes",
    "gtir_status",
  ]);
  assert.deepEqual(tools[1].inputSchema.required, ["query"]);   // search
  assert.ok(tools[1].inputSchema.properties.compact);           // search gained compact
  assert.deepEqual(tools[2].inputSchema.required, ["path"]);    // read
  assert.deepEqual(tools[3].inputSchema.required, ["path"]);    // outline
  assert.deepEqual(tools[4].inputSchema.required, ["path"]);    // similar
  assert.deepEqual(tools[5].inputSchema.required, ["symbol"]);  // find
  assert.deepEqual(tools[5].inputSchema.properties.kind.enum, ["definition", "references"]);
  assert.deepEqual(tools[6].inputSchema.required, ["symbol"]);  // callers
  assert.deepEqual(tools[7].inputSchema.required, ["symbol"]);  // callees
  assert.deepEqual(tools[8].inputSchema.required, ["symbol"]);  // neighbors
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
    ["context_code", "search_code", "read_code", "outline_code", "similar_code", "find_code",
     "callers_code", "callees_code", "neighbors_code", "impact_code", "orphans_code", "cycles_code", "path_code", "gtir_status"]);
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

test("printConfig --watch appends --watch (+ --debounce); default stays clean", () => {
  const on = JSON.parse(printConfig(["G:/p/code"], { watch: true, debounceMs: 800 })).gtir.args.join(" ");
  assert.match(on, /--watch/);
  assert.match(on, /--debounce 800/);
  const off = JSON.parse(printConfig(["G:/p/code"])).gtir.args.join(" ");
  assert.doesNotMatch(off, /--watch/);
});

import { startWatchers } from "../src/mcp.mjs";

test("startWatchers starts one live watcher per index, wired to each cfg", async () => {
  const code = repoWithModel("hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16");
  const notes = repoWithModel("nomic-embed-text");
  const indexes = resolveIndexes([code, notes], {});
  const handles = startWatchers(indexes, { debounceMs: 50 });
  try {
    assert.equal(handles.length, 2);
    assert.deepEqual(handles.map((h) => h.label).sort(), ["code", "notes"]);
    assert.ok(handles.every((h) => typeof h.close === "function"));
  } finally {
    await Promise.all(handles.map((h) => h.close()));
  }
});

test("defaultStatusFn: an unbuilt index reports healthy:false + a note, never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-status-"));
  const indexes = [{ label: "code", repo: dir, cfg: loadConfig(dir) }];
  const status = await defaultStatusFn(indexes)();
  assert.equal(status.length, 1);
  assert.equal(status[0].healthy, false);
  assert.match(status[0].note, /not built/);
});

import { parseToolName, defaultReadFn, defaultSearchFn, declaredSymbols } from "../src/mcp.mjs";

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

function okFetch(model) {
  return async (url, opts) => {
    if (url.endsWith("/api/version")) return { ok: true, json: async () => ({ version: "0.5.0" }) };
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: model }] }) };
    if (url.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["embedding"] }) };
    if (url.endsWith("/api/embed")) return { ok: true, json: async () => ({ embeddings: JSON.parse(opts.body).input.map(() => [1, 0, 0]) }) };
    return { ok: false, status: 404, text: async () => "nf" };
  };
}

test("preflightIndexes keeps healthy indexes and drops unready ones", async () => {
  const dropped = [];
  const indexes = [
    { label: "good", repo: "/g", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: true, fetchImpl: okFetch("m") } },
    { label: "bad",  repo: "/b", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: true, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } } },
  ];
  const healthy = await preflightIndexes(indexes, { log: (m) => dropped.push(m) });
  assert.deepEqual(healthy.map((i) => i.label), ["good"]);
  assert.ok(dropped.some((m) => /bad/.test(m)), "dropped index is logged");
});

test("preflightIndexes skips the probe when warmupOnStart is false (keeps the index)", async () => {
  const indexes = [
    { label: "lazy", repo: "/l", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: false, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } } },
  ];
  const healthy = await preflightIndexes(indexes, { log: () => {} });
  assert.deepEqual(healthy.map((i) => i.label), ["lazy"], "no preflight ⇒ index kept, retry layer covers it");
});

test("preflightIndexes skips the probe when a custom embedImpl is injected (keeps the index)", async () => {
  const indexes = [
    { label: "custom", repo: "/c", cfg: { model: "m", ollamaUrl: "http://x", warmupOnStart: true, embedImpl: () => [[1, 0, 0]], fetchImpl: async () => { throw new Error("ECONNREFUSED"); } } },
  ];
  const healthy = await preflightIndexes(indexes, { log: () => {} });
  assert.deepEqual(healthy.map((i) => i.label), ["custom"], "embedImpl set ⇒ no Ollama probe, index kept");
});

// ---------------------------------------------------------------------------
// Edge tool tests (callers / callees / neighbors)
// ---------------------------------------------------------------------------

import { defaultCallersFn, defaultCalleesFn, defaultNeighborsFn } from "../src/mcp.mjs";

// Deterministic fake embedder — same pattern as indexer tests.
function fakeEmbedEdge(texts) {
  return Promise.resolve(texts.map((t) => {
    const n = t.length % 7 + 1;
    const v = [n, n + 1, n + 2];
    const len = Math.hypot(...v);
    return v.map((x) => x / len);
  }));
}

// Build a real index (with edges) from an in-memory file map and return the indexes array.
async function makeIndex(files) {
  const repo = mkdtempSync(join(tmpdir(), "gtir-mcp-edge-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbedEdge };
  await buildIndex(cfg, { rebuild: true });
  return resolveIndexes([repo], {});
}

test("callers tool returns spans that call a symbol", async () => {
  const indexes = await makeIndex({
    "token.ts": [
      "export function verifyToken(x) {",
      "  // Verify the supplied token value and return it if valid.",
      "  // Throws if the token is missing or malformed by the caller.",
      "  return x;",
      "}",
    ].join("\n") + "\n",
    "mw.ts": [
      "import { verifyToken } from './token';",
      "export function mw(req) {",
      "  // Middleware that verifies the auth token on every request.",
      "  // Delegates to verifyToken for the actual validation logic.",
      "  return verifyToken(req);",
      "}",
    ].join("\n") + "\n",
  });
  const callers = await defaultCallersFn(indexes)(indexes[0].label, { symbol: "verifyToken" });
  assert.ok(callers.some((c) => c.path === "mw.ts"));
  assert.equal(callers[0].conf, "resolved");
});

test("callees tool returns what a function calls (end-to-end)", async () => {
  const indexes = await makeIndex({
    "token.ts": [
      "export function verifyToken(x){",
      "  // Verify the supplied token value and return it if valid.",
      "  // Uses the decode helper to process the raw token bytes.",
      "  return decode(x);",
      "}",
      "function decode(x){",
      "  // Decode the raw token bytes into a usable payload.",
      "  // Called internally by verifyToken during validation.",
      "  return x;",
      "}",
    ].join("\n") + "\n",
    "mw.ts": [
      "import { verifyToken } from './token';",
      "export function mw(r){",
      "  // Middleware that verifies the auth token on every request.",
      "  // Delegates to verifyToken for the actual validation logic.",
      "  return verifyToken(r);",
      "}",
    ].join("\n") + "\n",
  });
  const callees = await defaultCalleesFn(indexes)(indexes[0].label, { symbol: "verifyToken" });
  assert.ok(callees.some((c) => c.symbol === "decode"), `expected decode, got ${JSON.stringify(callees)}`);
});

import { openStore } from "../src/store.mjs";
import { defaultImpactFn, defaultOrphansFn, defaultCyclesFn, defaultPathFn } from "../src/mcp.mjs";

test("buildTools registers impact_/orphans_/cycles_ per index", () => {
  const tools = buildTools([{ label: "code", repo: "/r", cfg: { model: "qwen3" } }]);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("impact_code"));
  assert.ok(names.includes("orphans_code"));
  assert.ok(names.includes("cycles_code"));
  const impact = tools.find((t) => t.name === "impact_code");
  assert.deepEqual(impact.inputSchema.required, ["symbol"]);
});

test("tools/call dispatches impact_ and returns parseable JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-gq-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3" };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){ g(); }", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
      { id: "2", path: "b.mjs", line_start: 1, line_end: 3, language: "js", text: "function g(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h2" },
    ]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "b.mjs", to_lines: "1", to_symbol: "g", candidates: [], content_hash: "h1" }]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, impactFn: defaultImpactFn(indexes), orphansFn: defaultOrphansFn(indexes), cyclesFn: defaultCyclesFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "impact_code", arguments: { symbol: "g" } } }, ctx);
    const payload = JSON.parse(res.result.content[0].text);
    assert.deepEqual(payload.nodes.map((n) => n.symbol), ["f"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/call dispatches orphans_ and returns parseable JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-orph-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3" };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){ g(); }", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
      { id: "2", path: "b.mjs", line_start: 1, line_end: 3, language: "js", text: "function g(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h2" },
      { id: "3", path: "u.mjs", line_start: 1, line_end: 2, language: "js", text: "function dead(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h3" },
    ]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "b.mjs", to_lines: "1", to_symbol: "g", candidates: [], content_hash: "h1" }]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, orphansFn: defaultOrphansFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "orphans_code", arguments: {} } }, ctx);
    const payload = JSON.parse(res.result.content[0].text);
    assert.ok(payload.likely_dead.some((d) => d.symbol === "dead"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/call dispatches cycles_ and returns parseable JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-cyc-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3" };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([{ id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" }]);
    await store.upsertEdges([
      { kind: "imports", conf: "resolved", from_path: "p.mjs", from_lines: "1", from_symbol: "./q", to_path: "q.mjs", to_lines: "0-0", to_symbol: null, candidates: [], content_hash: "h" },
      { kind: "imports", conf: "resolved", from_path: "q.mjs", from_lines: "1", from_symbol: "./p", to_path: "p.mjs", to_lines: "0-0", to_symbol: null, candidates: [], content_hash: "h" },
    ]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, cyclesFn: defaultCyclesFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cycles_code", arguments: {} } }, ctx);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.import_cycles.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("neighbors tool returns callers, callees, and siblings", async () => {
  const indexes = await makeIndex({
    "token.ts": [
      "export function verifyToken(x) {",
      "  // Verify the token and decode its contents before returning.",
      "  // Delegates to decode for the actual decoding operation.",
      "  return decode(x);",
      "}",
      "function decode(x) {",
      "  // Decode the raw token value and return the parsed result.",
      "  // Used internally by verifyToken to parse the token bytes.",
      "  return x;",
      "}",
    ].join("\n") + "\n",
    "mw.ts": [
      "import { verifyToken } from './token';",
      "export function mw(req) {",
      "  // Middleware that verifies the auth token on every request.",
      "  // Delegates to verifyToken for the actual validation logic.",
      "  return verifyToken(req);",
      "}",
    ].join("\n") + "\n",
  });
  const out = await defaultNeighborsFn(indexes)(indexes[0].label, { symbol: "verifyToken", path: "token.ts", lines: "1-5" });
  assert.ok(out.callers.some((c) => c.path === "mw.ts"));
  assert.ok(out.callees.some((c) => c.symbol === "decode"));
  assert.ok(Array.isArray(out.siblings));
});

test("search_ schema has centrality+edges; read_ schema has edges", () => {
  const tools = buildTools([{ label: "code", repo: "/r", cfg: { model: "qwen3" } }]);
  const search = tools.find((t) => t.name === "search_code");
  assert.ok(search.inputSchema.properties.centrality);
  assert.ok(search.inputSchema.properties.edges);
  const read = tools.find((t) => t.name === "read_code");
  assert.ok(read.inputSchema.properties.edges);
});

test("tools/call search_ with edges:true attaches callers/callees", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-gr-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3", embedImpl: (t) => Promise.resolve(t.map(() => [1, 0, 0])), ftsWeight: 0, ftsWeightSymbol: 0, ftsWeightMixed: 0, testPenalty: 1, centralityWeight: 0.15, centralityK: 8, contextCap: 5 };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([{ id: "1", path: "hub.mjs", line_start: 1, line_end: 3, language: "js", text: "function hub(){}", embedding: [1, 0, 0], mtime_ms: 1, content_hash: "h1" }]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "c0.mjs", from_lines: "1", from_symbol: "f0", to_path: "hub.mjs", to_lines: "1", to_symbol: "hub", candidates: [], content_hash: "h" }]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, searchFn: defaultSearchFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_code", arguments: { query: "hub", edges: true } } }, ctx);
    assert.ok(res.result.structuredContent.results.some((r) => Array.isArray(r.callers)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orphans_ tool no longer advertises include_ambiguous (always-on now)", () => {
  const tools = buildTools([{ label: "code", repo: "/r", cfg: { model: "qwen3" } }]);
  const orphans = tools.find((t) => t.name === "orphans_code");
  assert.ok(orphans);
  assert.equal(orphans.inputSchema.properties.include_ambiguous, undefined);
});

// ---------------------------------------------------------------------------
// path_ tool tests (TDD — written before implementation)
// ---------------------------------------------------------------------------

test("parseToolName('path_code') -> { verb: 'path', label: 'code' }", () => {
  assert.deepEqual(parseToolName("path_code"), { verb: "path", label: "code" });
  assert.deepEqual(parseToolName("path_my_wiki"), { verb: "path", label: "my_wiki" });
});

test("buildTools registers path_ per index with from+to required", () => {
  const tools = buildTools([{ label: "code", repo: "/r", cfg: { model: "qwen3" } }]);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("path_code"), `expected path_code in ${names}`);
  const pathTool = tools.find((t) => t.name === "path_code");
  assert.deepEqual(pathTool.inputSchema.required, ["from", "to"]);
  assert.ok(pathTool.inputSchema.properties.from);
  assert.ok(pathTool.inputSchema.properties.to);
  assert.ok(pathTool.inputSchema.properties.from_path);
  assert.ok(pathTool.inputSchema.properties.to_path);
  assert.ok(pathTool.inputSchema.properties.depth);
  assert.ok(pathTool.inputSchema.properties.include_ambiguous);
});

test("tools/list includes path_<label> with from+to required", async () => {
  const r = await handleRequest({ jsonrpc: "2.0", id: 99, method: "tools/list" }, baseCtx);
  const pathTool = r.result.tools.find((t) => t.name === "path_code");
  assert.ok(pathTool, "path_code should appear in tools/list");
  assert.deepEqual(pathTool.inputSchema.required, ["from", "to"]);
});

test("tools/call path_<label>: connected pair returns path in structuredContent", async () => {
  const pathFn = async (label, opts) => ({ from: opts.from, to: opts.to, path: [`a.mjs#${opts.from}`, `b.mjs#${opts.to}`] });
  const ctx = { ...baseCtx, pathFn };
  const r = await handleRequest({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "path_code", arguments: { from: "f", to: "g" } } }, ctx);
  const payload = JSON.parse(r.result.content[0].text);
  assert.ok(Array.isArray(payload.path), "path should be an array");
  assert.equal(payload.path.length, 2);
  assert.deepEqual(r.result.structuredContent.path, payload.path);
});

test("tools/call path_<label>: disconnected pair returns path: null", async () => {
  const pathFn = async (label, opts) => ({ from: opts.from, to: opts.to, path: null });
  const ctx = { ...baseCtx, pathFn };
  const r = await handleRequest({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "path_code", arguments: { from: "x", to: "y" } } }, ctx);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.path, null);
  assert.equal(r.result.structuredContent.path, null);
});

test("tools/call path_<label>: unknown symbol returns { error } as text, not a throw", async () => {
  const pathFn = async (label, opts) => ({ from: opts.from, to: opts.to, path: null, error: `symbol '${opts.from}' not found` });
  const ctx = { ...baseCtx, pathFn };
  const r = await handleRequest({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "path_code", arguments: { from: "nope", to: "g" } } }, ctx);
  assert.equal(r.result.isError, undefined, "should not be an MCP error");
  const payload = JSON.parse(r.result.content[0].text);
  assert.ok(payload.error, "expected an error field");
  assert.match(payload.error, /not found/);
});

test("tools/call path_<label>: passes from_path, to_path, depth, include_ambiguous to pathFn", async () => {
  let gotOpts;
  const pathFn = async (label, opts) => { gotOpts = opts; return { from: opts.from, to: opts.to, path: null }; };
  const ctx = { ...baseCtx, pathFn };
  await handleRequest({ jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "path_code", arguments: { from: "a", to: "b", from_path: "src/a.ts", to_path: "src/b.ts", depth: 5, include_ambiguous: true } } }, ctx);
  assert.equal(gotOpts.fromPath, "src/a.ts");
  assert.equal(gotOpts.toPath, "src/b.ts");
  assert.equal(gotOpts.depth, 5);
  assert.equal(gotOpts.includeAmbiguous, true);
});

test("tools/call dispatches path_ end-to-end with real defaultPathFn (connected)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-path-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3" };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){ g(); }", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
      { id: "2", path: "b.mjs", line_start: 1, line_end: 3, language: "js", text: "function g(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h2" },
    ]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "b.mjs", to_lines: "1", to_symbol: "g", candidates: [], content_hash: "h1" }]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, pathFn: defaultPathFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "path_code", arguments: { from: "f", to: "g" } } }, ctx);
    const payload = JSON.parse(res.result.content[0].text);
    assert.ok(Array.isArray(payload.path), `expected path array, got ${JSON.stringify(payload)}`);
    assert.ok(payload.path.some((k) => k.includes("f")));
    assert.ok(payload.path.some((k) => k.includes("g")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/call dispatches path_ end-to-end: unknown symbol -> { error }, not throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-mcp-path2-"));
  const cfg = { indexDir: join(dir, ".gtir"), model: "qwen3" };
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
    ]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "b.mjs", to_lines: "1", to_symbol: "g", candidates: [], content_hash: "h1" }]);
    const indexes = [{ label: "code", repo: dir, cfg }];
    const ctx = { indexes, pathFn: defaultPathFn(indexes) };
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "path_code", arguments: { from: "doesNotExist", to: "f" } } }, ctx);
    assert.equal(res.result.isError, undefined, "should not be an MCP error");
    const payload = JSON.parse(res.result.content[0].text);
    assert.ok(payload.error, `expected error field, got ${JSON.stringify(payload)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tools/call path_<label>: no-edge-index path surfaces error, does not throw", async () => {
  // Stub pathFn to return the no-edge-index error (mirrors what pathQuery returns when hasEdges=false).
  const pathFn = async (label, opts) => ({ from: opts.from, to: opts.to, path: null, steps: null, error: "no edge index — run: gtir index" });
  const ctx = { ...baseCtx, pathFn };
  const r = await handleRequest({ jsonrpc: "2.0", id: 200, method: "tools/call", params: { name: "path_code", arguments: { from: "f", to: "g" } } }, ctx);
  assert.equal(r.result.isError, undefined, "should not be an MCP-level error");
  const payload = JSON.parse(r.result.content[0].text);
  assert.ok(payload.error, "expected an error field");
  assert.match(payload.error, /no edge index/i);
  assert.equal(r.result.structuredContent.error, payload.error, "structuredContent should surface the error too");
});

test("tools/call path_<label>: connected pair result includes steps[] of {symbol,path} objects", async () => {
  // pathFn returns the new { path, steps } shape for a connected pair.
  const pathFn = async (label, opts) => ({
    from: opts.from, to: opts.to,
    path: [`a.mjs#${opts.from}`, `b.mjs#${opts.to}`],
    steps: [{ symbol: opts.from, path: "a.mjs" }, { symbol: opts.to, path: "b.mjs" }],
  });
  const ctx = { ...baseCtx, pathFn };
  const r = await handleRequest({ jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "path_code", arguments: { from: "f", to: "g" } } }, ctx);
  const payload = JSON.parse(r.result.content[0].text);
  assert.ok(Array.isArray(payload.steps), "steps should be an array");
  assert.equal(payload.steps.length, 2);
  assert.deepEqual(payload.steps[0], { symbol: "f", path: "a.mjs" });
  assert.deepEqual(payload.steps[1], { symbol: "g", path: "b.mjs" });
  assert.deepEqual(r.result.structuredContent.steps, payload.steps);
});
