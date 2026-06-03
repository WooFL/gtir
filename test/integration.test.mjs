import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { search } from "../src/search.mjs";
import { openStore } from "../src/store.mjs";
import { watchRepo } from "../src/watch.mjs";
import { runDoctor } from "../src/doctor.mjs";

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

test("integration: `gtir index` CLI gitignores .gtir/ in a git repo (audit fix, end-to-end)", { skip: hasGit() ? false : "git not installed" }, async () => {
  const repo = repoWith({ "a.ts": FN("alpha", "alpha helper words here") });
  execFileSync("git", ["init", "-q"], { cwd: repo });   // git needs no mock; brief sync block is fine
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
