import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fileURLToPath as f2 } from "node:url";
import { dirname as d2, join as j2 } from "node:path";
import { runIndex, runSearch, runStatus } from "../bin/gtir.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Deterministic fake embedder shared by index + search so cosine is meaningful:
// vector is a 3-dim bag-of-keyword count over a tiny vocabulary.
const VOCAB = ["session", "token", "authentication", "revoke"];
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const low = t.toLowerCase();
    const v = VOCAB.slice(0, 3).map((w) => (low.split(w).length - 1) + 0.01);
    const len = Math.hypot(...v) || 1;
    return v.map((x) => x / len);
  }));
}

function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cli-"));
  cpSync(join(here, "fixtures", "sample-repo"), repo, { recursive: true });
  return repo;
}

test("index then search finds the session manager; gitignored file excluded", async () => {
  const repo = freshRepo();
  const res = await runIndex({ repo, rebuild: true, embedImpl: fakeEmbed });
  assert.ok(res.chunks >= 2);

  const status = await runStatus({ repo });
  assert.equal(status.files, 2); // auth.py + README.md only; secret.py is gitignored, never indexed

  const hits = await runSearch({ repo, query: "create a session token", k: 5, embedImpl: fakeEmbed });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.path === "auth.py"));
  assert.equal(hits.some((h) => h.path === "secret.py"), false); // gitignored
});

test("gtir mcp --print-config prints a valid .mcp.json snippet and exits", () => {
  const bin = j2(d2(f2(import.meta.url)), "..", "bin", "gtir.mjs");
  const out = execFileSync("node", [bin, "mcp", "--repo", "G:/p/code", "--repo", "G:/p/wiki", "--print-config"], { encoding: "utf8" });
  const snippet = JSON.parse(out);
  assert.equal(snippet.gtir.command, "node");
  assert.ok(snippet.gtir.args.includes("G:/p/code"));
});

import { runImpact, runOrphans, runCycles } from "../bin/gtir.mjs";
import { openStore } from "../src/store.mjs";
import { loadConfig } from "../src/config.mjs";

test("runImpact/runOrphans/runCycles delegate to the query layer", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cli-gq-"));
  const cfg = loadConfig(repo);
  const store = await openStore(cfg);
  await store.upsertRows([
    { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){ g(); }", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
    { id: "2", path: "b.mjs", line_start: 1, line_end: 3, language: "js", text: "function g(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h2" },
    { id: "3", path: "u.mjs", line_start: 1, line_end: 2, language: "js", text: "function dead(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h3" },
  ]);
  await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "b.mjs", to_lines: "1", to_symbol: "g", candidates: [], content_hash: "h1" }]);

  const imp = await runImpact({ repo, symbol: "g" });
  assert.deepEqual(imp.nodes.map((n) => n.symbol), ["f"]);
  const orph = await runOrphans({ repo });
  assert.ok(orph.likely_dead.some((d) => d.symbol === "dead"));
  const cyc = await runCycles({ repo });
  assert.deepEqual(cyc.call_cycles, []);
});
