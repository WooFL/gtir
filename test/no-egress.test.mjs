// The zero-egress guarantee (Moat B). gtir, during index / search / mcp-serve, makes outbound
// network requests ONLY to the user-configured endpoints (cfg.ollamaUrl, and cfg.rerankUrl when
// rerank is on). No telemetry, analytics, auto-update, or vendor/cloud calls — ever.
//
// This file IS the guarantee. It spies on GLOBAL fetch (not cfg.fetchImpl) so it catches ANY
// call site, even one that forgets the injectable seam, then runs the real runtime flows
// (buildIndex → search → MCP search_code) against a tiny fixture repo and asserts every contacted
// host is one of the configured (loopback) endpoints.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { handleRequest, defaultSearchFn, defaultStatusFn } from "../src/mcp.mjs";
import { configuredHosts, assertConfiguredUrl } from "../src/net-guard.mjs";

// ---------------------------------------------------------------------------
// Unit tests for the centralized host check.
// ---------------------------------------------------------------------------

test("configuredHosts: collects ollama + rerank host[:port] from cfg", () => {
  const hosts = configuredHosts({ ollamaUrl: "http://localhost:11434", rerankUrl: "http://127.0.0.1:8088" });
  assert.ok(hosts.has("localhost:11434"));
  assert.ok(hosts.has("127.0.0.1:8088"));
});

test("configuredHosts: lenient when rerankUrl is absent", () => {
  const hosts = configuredHosts({ ollamaUrl: "http://localhost:11434" });
  assert.ok(hosts.has("localhost:11434"));
  assert.equal(hosts.size, 1);
});

test("assertConfiguredUrl: a loopback ollama URL passes and is returned", () => {
  const cfg = { ollamaUrl: "http://localhost:11434" };
  assert.equal(assertConfiguredUrl("http://localhost:11434/api/embed", cfg), "http://localhost:11434/api/embed");
});

test("assertConfiguredUrl: the rerank host passes when rerankUrl is set", () => {
  const cfg = { ollamaUrl: "http://localhost:11434", rerankUrl: "http://127.0.0.1:8088" };
  assert.equal(assertConfiguredUrl("http://127.0.0.1:8088/rerank", cfg), "http://127.0.0.1:8088/rerank");
});

test("assertConfiguredUrl: a non-configured host throws, naming the offending host", () => {
  const cfg = { ollamaUrl: "http://localhost:11434" };
  assert.throws(() => assertConfiguredUrl("https://evil.example.com/exfil", cfg), (e) => {
    assert.match(e.message, /evil\.example\.com/);
    return true;
  });
});

test("assertConfiguredUrl: a different port on the same host is NOT configured", () => {
  const cfg = { ollamaUrl: "http://localhost:11434" };
  assert.throws(() => assertConfiguredUrl("http://localhost:9999/x", cfg), /localhost:9999/);
});

// ---------------------------------------------------------------------------
// The guarantee test: spy on GLOBAL fetch, run the real runtime flows.
// ---------------------------------------------------------------------------

const DIM = 16;
const isLoopbackHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(h);

// Deterministic embedding for a text — shaped exactly like Ollama's /api/embed parser expects
// (embed.mjs reads data.embeddings as an array of vectors, one per input, then L2-normalizes).
const vec = (t) => { const v = Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 5; return v; };

const recordedHosts = [];
let realFetch;

before(() => {
  realFetch = globalThis.fetch;
  // Recording stub for GLOBAL fetch. Captures each requested URL's host, then returns a canned
  // response shaped like Ollama's endpoints so indexing/search succeed with no real server. Any
  // call site that bypasses cfg.fetchImpl still hits this — that's the point.
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    recordedHosts.push(u.host);
    if (u.pathname === "/api/embed") {
      const input = JSON.parse(opts.body || "{}").input;
      const arr = Array.isArray(input) ? input : [input];
      return { ok: true, status: 200, json: async () => ({ embeddings: arr.map(vec) }), text: async () => "" };
    }
    if (u.pathname === "/api/version") return { ok: true, status: 200, json: async () => ({ version: "stub" }), text: async () => "" };
    if (u.pathname === "/api/tags") return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" };
    if (u.pathname === "/rerank") return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
});

after(() => { globalThis.fetch = realFetch; });

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-egress-"));
  // A couple of small source files, each long enough to clear the minChars chunk threshold.
  writeFileSync(join(repo, "auth.ts"),
    "export function verifyToken(tok) {\n" +
    "  // Validate the supplied session token and reject expired or malformed values.\n" +
    "  // Returns the token string when it passes the integrity and expiry checks here.\n" +
    "  return String(tok).trim();\n}\n");
  writeFileSync(join(repo, "math.ts"),
    "export function greatestCommonDivisor(a, b) {\n" +
    "  // Euclid's algorithm — repeatedly take the remainder until the divisor reaches zero.\n" +
    "  // The last non-zero value is the greatest common divisor of the two integer inputs.\n" +
    "  while (b) { [a, b] = [b, a % b]; }\n  return a;\n}\n");
  return repo;
}

test("zero egress: gtir serve /connections only contacts configured loopback hosts", async () => {
  const { startServer } = await import("../src/serve.mjs");
  recordedHosts.length = 0;
  const repo = fixtureRepo();
  const cfg = { ...loadConfig(repo), ollamaUrl: "http://localhost:11434" };
  let server;
  try {
    await buildIndex(cfg, { rebuild: true });
    server = await startServer(cfg, { host: "127.0.0.1", port: 0 }); // ephemeral port
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await realFetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    const conn = await realFetch(`${base}/connections`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "auth.ts", k: 5 }),
    }).then((r) => r.json());
    assert.ok(Array.isArray(conn.results), "serve /connections returned results");

    // /search embeds the query through the engine's embedder — a SERVE-originated outbound call.
    const sr = await realFetch(`${base}/search`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "validate a session token", k: 5 }),
    }).then((r) => r.json());
    assert.ok(Array.isArray(sr.results), "serve /search returned results");

    // Non-vacuous: the build + the serve query-embed must have made at least one recorded fetch.
    assert.ok(recordedHosts.length > 0, "the serve flow made at least one fetch (guard isn't vacuous)");

    // The engine work (embedding the query path) went through GLOBAL fetch -> recordedHosts.
    const allowed = configuredHosts(cfg);
    for (const h of recordedHosts) {
      assert.ok(allowed.has(h), `serve egress to a NON-configured host: ${h}`);
    }
    assert.deepEqual(recordedHosts.filter((h) => !isLoopbackHost(h)), [], "no non-loopback egress from serve");
  } finally {
    if (server) await new Promise((r) => server.close(r));
    rmSync(repo, { recursive: true, force: true });
  }
});

test("zero egress: index → search → MCP search_code only ever contact configured loopback hosts", async () => {
  recordedHosts.length = 0;
  const repo = fixtureRepo();
  // Default loopback ollamaUrl; pin DIM-matching model name is irrelevant — the stub ignores it.
  const cfg = { ...loadConfig(repo), ollamaUrl: "http://localhost:11434" };

  try {
    // 1. INDEX — drives the real embed.mjs HTTP path through GLOBAL fetch (no cfg.fetchImpl set).
    const built = await buildIndex(cfg, { rebuild: true });
    assert.ok(built.chunks >= 2, `indexed >=2 chunks, got ${built.chunks}`);

    // 2. SEARCH — embeds the query through the same path, then fuses + returns hits.
    const hits = await search("validate a session token", cfg, { k: 5 });
    assert.ok(hits.length >= 1, "search returned hits");

    // 3. MCP search_code tool call — the serve-time entrypoint, routed through the real search path.
    const indexes = [{ label: "code", repo: cfg.repo, cfg }];
    const ctx = { indexes, version: "test", searchFn: defaultSearchFn(indexes), statusFn: defaultStatusFn(indexes) };
    const res = await handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_code", arguments: { query: "verifyToken", k: 5 } } },
      ctx,
    );
    assert.ok(Array.isArray(res.result.structuredContent.results), "MCP search_code returned results");

    // We must have actually made network calls (otherwise the guarantee is vacuously true).
    assert.ok(recordedHosts.length > 0, "the runtime flows made at least one fetch (guard isn't vacuous)");

    // THE GUARANTEE: every contacted host is one of the configured endpoints…
    const allowed = configuredHosts(cfg);
    for (const h of recordedHosts) {
      assert.ok(allowed.has(h), `egress to a NON-configured host: ${h} (allowed: ${[...allowed].join(", ")})`);
    }
    // …and explicitly, NO contacted host is non-loopback / a public domain.
    const offenders = recordedHosts.filter((h) => !isLoopbackHost(h));
    assert.deepEqual(offenders, [], `non-loopback egress detected: ${offenders.join(", ")}`);
    assert.equal(recordedHosts.some((h) => /\.(com|net|org|io|dev|ai)\b/i.test(h)), false, "no public-domain host contacted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
