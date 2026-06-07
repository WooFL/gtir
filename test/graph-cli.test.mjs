import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGraph } from "../bin/gtir.mjs";

// Inject edges directly so the test needs no Ollama/index. runGraph accepts an
// edgesImpl override (async () => rows[]) for exactly this reason.
const ROWS = [
  { kind: "calls", conf: "resolved", from_path: "a.ts", from_lines: "5", from_symbol: "f", to_path: "b.ts", to_lines: "10", to_symbol: "g", ref_name: "g", candidates: [], content_hash: "h" },
];

test("runGraph: writes a self-contained HTML file and returns counts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-graph-"));
  const out = path.join(dir, "g.html");
  const r = await runGraph({ repo: dir, out, edgesImpl: async () => ROWS });
  assert.equal(r.out, out);
  assert.equal(r.nodes, 2);
  assert.equal(r.edges, 1);
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("__GTIR_GRAPH__"));
  assert.ok(!html.includes("<script src"));
  rmSync(dir, { recursive: true, force: true });
});

test("runGraph: no edges throws a friendly error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-graph-"));
  await assert.rejects(
    () => runGraph({ repo: dir, out: path.join(dir, "g.html"), edgesImpl: async () => [] }),
    /no edge index/);
  rmSync(dir, { recursive: true, force: true });
});

test("runGraph: focus with no match throws", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-graph-"));
  await assert.rejects(
    () => runGraph({ repo: dir, out: path.join(dir, "g.html"), focus: "nope", edgesImpl: async () => ROWS }),
    /no symbol matching/);
  rmSync(dir, { recursive: true, force: true });
});
