import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { openStore } from "../src/store.mjs";
import { watchRepo } from "../src/watch.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { handleRequest, defaultSearchFn, defaultStatusFn, defaultReadFn, defaultOutlineFn, defaultSimilarFn, defaultFindFn } from "../src/mcp.mjs";

// A mock Ollama so the FULL stack (embed.mjs HTTP → store → search → watcher → doctor) runs
// end-to-end with NO real Ollama — hermetic enough for CI, yet exercising the real /api/embed path
// that unit tests skip by injecting embedImpl. This is the net the manual dogfooding becomes.
const DIM = 24;
const MODEL = "mock-embed";
const vec = (t) => { const v = Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 5; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };

let server, URL;
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)).on("end", () => {
      const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/api/version") return json({ version: "mock" });
      if (req.url === "/api/tags") return json({ models: [{ name: MODEL }] });
      if (req.url === "/api/show") return json({ capabilities: ["embedding"] });
      if (req.url === "/api/embed") {
        const input = JSON.parse(body || "{}").input;
        const arr = Array.isArray(input) ? input : [input];
        return json({ embeddings: arr.map(vec) });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const repoWith = (files) => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-int-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  return repo;
};
const FN = (name, words) => `export function ${name}(input) {\n  // ${words} — body long enough to clear the hundred-char minimum chunk threshold here ok\n  return String(input).trim()\n}\n`;
const cfgFor = (repo) => ({ ...loadConfig(repo), ollamaUrl: URL, model: MODEL });

test("integration: doctor talks to a real (mock) Ollama and reports ready", async () => {
  const r = await runDoctor(cfgFor(mkdtempSync(join(tmpdir(), "gtir-int-"))), { pull: false });
  assert.equal(r.ready, true);
  assert.equal(r.dim, DIM);
});

test("integration: index → search over the real embed HTTP path, and a fresh index carries content_hash", async () => {
  const repo = repoWith({ "auth.ts": FN("verifyToken", "reject expired session tokens"), "math.ts": FN("gcd", "greatest common divisor") });
  const cfg = cfgFor(repo);
  const built = await buildIndex(cfg, { rebuild: false });               // a plain first `index`, NOT --rebuild
  assert.ok(built.chunks >= 2 && built.dim === DIM);
  assert.equal(await (await openStore(cfg)).hasContentHash(), true, "fresh index enables the cache (regression)");
  const hits = await search("verifyToken", cfg, { k: 5 });
  assert.ok(hits[0] && hits[0].path === "auth.ts", `expected auth.ts top, got ${JSON.stringify(hits[0])}`);
});

test("integration: edit → refresh reuses unchanged content (cache engaged end-to-end)", async () => {
  const md = "# Doc\n\n## Alpha\nThe alpha section body is stable and long enough to be its own chunk for sure here.\n\n## Beta\nThe beta section body original and also long enough to be a real chunk on its own here.\n";
  const repo = repoWith({ "p.md": md });
  const cfg = cfgFor(repo);
  await buildIndex(cfg, { rebuild: false });
  writeFileSync(join(repo, "p.md"), md.replace("beta section body original", "beta section body EDITED"));
  const r = await buildIndex(cfg, { rebuild: false, paths: ["p.md"] });
  assert.ok(r.reused >= 1, "the alpha section is reused");
  assert.ok(r.embedded >= 1, "the beta section is re-embedded");
});

function hasGit() { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }

test("integration: MCP tools/call search routes through the real search path to the right hit", async () => {
  const repo = repoWith({ "auth.ts": FN("verifyToken", "reject expired session tokens"), "math.ts": FN("gcd", "greatest common divisor") });
  const cfg = cfgFor(repo);
  await buildIndex(cfg, { rebuild: false });
  const indexes = [{ label: "code", repo: cfg.repo, cfg }];
  const ctx = {
    indexes, version: "test",
    searchFn: defaultSearchFn(indexes), statusFn: defaultStatusFn(indexes),
    readFn: defaultReadFn(indexes), outlineFn: defaultOutlineFn(indexes),
    similarFn: defaultSimilarFn(indexes), findFn: defaultFindFn(indexes),
  };
  const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_code", arguments: { query: "verifyToken", k: 5 } } }, ctx);
  assert.equal(res.result.structuredContent.results[0].path, "auth.ts", "mcp dispatch → real search → mock embed returns the right file");
});

test("integration: index converges after a real rebase — the catch-up refresh reuses churned content", { skip: hasGit() ? false : "git not installed" }, async () => {
  const repo = repoWith({});
  const g = (a) => execFileSync("git", a, { cwd: repo });
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]); g(["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "base.ts"), FN("base", "base helper")); g(["add", "-A"]); g(["commit", "-qm", "base"]);
  g(["branch", "feature"]);
  writeFileSync(join(repo, "main_new.ts"), FN("mainNew", "the main-only function added on the trunk")); g(["add", "-A"]); g(["commit", "-qm", "main-advance"]);
  g(["checkout", "-q", "feature"]);
  for (const n of ["f1", "f2", "f3"]) { writeFileSync(join(repo, n + ".ts"), FN(n, `${n} feature function`)); g(["add", "-A"]); g(["commit", "-qm", n]); }

  const cfg = cfgFor(repo);
  await buildIndex(cfg, { rebuild: false });                // index the feature tip — main_new.ts NOT present
  assert.equal((await search("the main-only function added on the trunk", cfg, { k: 5 })).some((h) => h.path === "main_new.ts"), false);

  g(["rebase", "main"]);                                     // real rebase: replays f1..f3 onto main (adds main_new, churns f* mtimes)
  const r = await buildIndex(cfg, { rebuild: false });       // the catch-up the post-rewrite hook runs
  assert.ok(r.embedded >= 1, "the genuinely-new file is embedded");
  assert.ok(r.reused >= 1, "rebase churned mtimes but unchanged content is reused, not re-embedded");
  assert.ok((await search("the main-only function added on the trunk", cfg, { k: 5 })).some((h) => h.path === "main_new.ts"),
    "the rebased tree is searchable after the catch-up refresh");
});

test("integration: `gtir index` CLI gitignores .gtir/ in a git repo (audit fix, end-to-end)", { skip: hasGit() ? false : "git not installed" }, async () => {
  const repo = repoWith({ "a.ts": FN("alpha", "alpha helper words here") });
  execFileSync("git", ["init", "-q"], { cwd: repo });   // git needs no mock; brief sync block is fine
  // Write a .gtir/config.json so the CLI subprocess uses the same model name the mock Ollama serves.
  // Required now that `gtir index` runs a preflight check (model-present gate).
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ model: MODEL }));
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gtir.mjs");
  // ASYNC spawn — execFileSync would block this process's event loop and the in-process mock Ollama
  // could never answer the child's /api/embed, deadlocking the run.
  await pexec("node", [bin, "index", "--repo", repo], { env: { ...process.env, OLLAMA_URL: URL } });
  assert.ok(existsSync(join(repo, ".gitignore")), ".gitignore created");
  assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /^\.gtir\/?$/m, "the regenerable index is gitignored");
});

test("integration: watcher — a real file event drives a targeted refresh that becomes searchable", async () => {
  const repo = repoWith({ "a.ts": FN("alpha", "the alpha helper") });
  const cfg = cfgFor(repo);
  await buildIndex(cfg, { rebuild: false });
  let resolveRefresh; const refreshed = new Promise((r) => (resolveRefresh = r));
  const w = watchRepo(cfg, { debounceMs: 40, sweepMs: 0, initialRefresh: false, isBusy: () => false, log: (m) => { if (/refreshed/.test(m)) resolveRefresh(); } });
  await new Promise((r) => w.watcher.on("ready", r));
  writeFileSync(join(repo, "checkout.ts"), FN("orderCheckout", "process the shopping cart payment charge"));
  await Promise.race([refreshed, new Promise((_, rej) => setTimeout(() => rej(new Error("watch timeout")), 20000))]);
  await w.close();
  const hits = await search("orderCheckout", cfg, { k: 5 });
  assert.ok(hits.some((h) => h.path === "checkout.ts"), `new file searchable after watcher refresh; got ${JSON.stringify(hits.map((h) => h.path))}`);
});

test("integration: index build survives a dropped first /api/embed (retry layer)", async () => {
  let embedHits = 0;
  const srv = createServer((req, res) => {
    if (req.url === "/api/version") { res.end(JSON.stringify({ version: "0.5.0" })); return; }
    if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "m" }] })); return; }
    if (req.url === "/api/show") { res.end(JSON.stringify({ capabilities: ["embedding"] })); return; }
    if (req.url === "/api/embed") {
      embedHits++;
      if (embedHits === 1) { req.destroy(); return; }            // drop first call → network error → retryable
      let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
        const input = JSON.parse(body).input;
        res.end(JSON.stringify({ embeddings: input.map(() => [1, 0, 0]) }));
      });
      return;
    }
    res.statusCode = 404; res.end("nf");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}`;

  // Use the repoWith helper and FN to get a file long enough to clear minChars (100).
  // Then override ollamaUrl+model+embedRetryBackoffMs via cfgFor-style spread.
  const repo = repoWith({ "a.js": FN("helloRetry", "retry resilience check helper function here") });
  mkdirSync(join(repo, ".gtir"), { recursive: true });
  writeFileSync(join(repo, ".gtir", "config.json"), JSON.stringify({ ollamaUrl: url, model: "m", embedRetryBackoffMs: 0 }));

  const cfg = loadConfig(repo);
  try {
    const out = await buildIndex(cfg, { rebuild: true });
    assert.ok(embedHits >= 2, "first embed dropped, retry succeeded");
    assert.ok(out?.chunks >= 1, "index built (>=1 chunk) despite the dropped request");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
