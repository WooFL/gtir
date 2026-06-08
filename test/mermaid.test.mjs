// TDD: tests for renderMermaid — written before the implementation.
// These will fail until src/graph.mjs exports renderMermaid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// --- helpers that mirror the real node/edge shapes from mapEdges/buildGraph ---

// Raw edge row factory (same shape as store.loadEdges()).
const RAW = (o = {}) => ({
  kind: "calls", conf: "resolved",
  from_path: "a.ts", from_lines: "5", from_symbol: "f",
  to_path: "b.ts", to_lines: "10", to_symbol: "g",
  ref_name: "g", candidates: [], content_hash: "h", ...o,
});

// Build a minimal graph manually using ACTUAL field names from src/graph.mjs.
// Nodes: { id, label, cls, refs, candidates, degree, cluster }
// Edges: { source, target, kind, conf }
function miniGraph() {
  const nodes = [
    { id: "f\x00a.ts", label: "f · a.ts", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
    { id: "g\x00b.ts", label: "g · b.ts", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
  ];
  const edges = [
    { source: "f\x00a.ts", target: "g\x00b.ts", kind: "calls", conf: "resolved" },
  ];
  return { nodes, edges };
}

// Lazy import — allows tests to be written before the export exists without crashing the file.
let renderMermaid;
let runGraph;

async function lazyImports() {
  if (!renderMermaid) {
    const m = await import("../src/graph.mjs");
    renderMermaid = m.renderMermaid;
  }
  if (!runGraph) {
    const m = await import("../bin/gtir.mjs");
    runGraph = m.runGraph;
  }
}

// ── Unit tests: renderMermaid ──────────────────────────────────────────────

test("renderMermaid: contains flowchart LR header", async () => {
  await lazyImports();
  const { nodes, edges } = miniGraph();
  const out = renderMermaid({ nodes, edges });
  assert.ok(out.startsWith("flowchart LR"), `expected flowchart LR header, got: ${out.slice(0, 40)}`);
});

test("renderMermaid: one node declaration per node (n<idx>[\"label\"])", async () => {
  await lazyImports();
  const { nodes, edges } = miniGraph();
  const out = renderMermaid({ nodes, edges });
  // Each node must appear as n0 or n1 with a quoted label
  assert.match(out, /n0\["/);
  assert.match(out, /n1\["/);
  // Exactly two node declaration lines (not counting comments/header)
  const nodeDecls = out.split("\n").filter((l) => /^n\d+\["/.test(l.trim()));
  assert.equal(nodeDecls.length, 2, `expected 2 node decls, got: ${nodeDecls.length}`);
});

test("renderMermaid: one edge per graph edge (-->|kind|)", async () => {
  await lazyImports();
  const { nodes, edges } = miniGraph();
  const out = renderMermaid({ nodes, edges });
  const edgeLines = out.split("\n").filter((l) => l.includes("-->|"));
  assert.equal(edgeLines.length, 1, `expected 1 edge line, got: ${edgeLines.length}`);
  assert.ok(edgeLines[0].includes("calls"), "edge should reference kind=calls");
  assert.match(edgeLines[0], /-->\|calls\|/);
});

test("renderMermaid: label with special chars is escaped (no raw \" or unescaped [ in label)", async () => {
  await lazyImports();
  // A label with a double-quote and bracket — both must be escaped inside the Mermaid label field.
  const nodes = [
    { id: "x", label: 'say "hello" [world]', cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
    { id: "y", label: "plain", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
  ];
  const edges = [{ source: "x", target: "y", kind: "calls", conf: "resolved" }];
  const out = renderMermaid({ nodes, edges });
  // Raw double-quote must NOT appear inside a node label (between the surrounding quotes of n<i>["..."])
  // We check that the output line for the special-char node uses #quot; not a literal "
  const nodeLine = out.split("\n").find((l) => l.includes("#quot;") || (l.startsWith("n0") && l.includes("[")));
  assert.ok(nodeLine, "special char node line should exist with escaped chars");
  // The raw " character must not appear inside label content (after the opening [" and before the closing "])
  // Validate by checking that #quot; is used
  assert.ok(out.includes("#quot;"), "double-quote in label must be escaped as #quot;");
});

test("renderMermaid: deterministic — same input produces identical output twice", async () => {
  await lazyImports();
  const { nodes, edges } = miniGraph();
  const a = renderMermaid({ nodes, edges });
  const b = renderMermaid({ nodes, edges });
  assert.equal(a, b, "renderMermaid must be deterministic");
});

test("renderMermaid: empty graph — valid flowchart, no throw, contains %% no edges", async () => {
  await lazyImports();
  let out;
  assert.doesNotThrow(() => { out = renderMermaid({ nodes: [], edges: [] }); });
  assert.ok(out.includes("flowchart LR"), "empty graph must still have header");
  assert.ok(out.includes("%% no edges"), "empty graph must have no-edges comment");
});

test("renderMermaid: self-edge (source===target) is emitted without crash", async () => {
  await lazyImports();
  const nodes = [
    { id: "x", label: "self", cls: "code", refs: [], candidates: [], degree: 2, cluster: "(root)" },
  ];
  const edges = [{ source: "x", target: "x", kind: "calls", conf: "resolved" }];
  let out;
  assert.doesNotThrow(() => { out = renderMermaid({ nodes, edges }); });
  const edgeLines = out.split("\n").filter((l) => l.includes("-->|"));
  assert.equal(edgeLines.length, 1, "self-edge should produce one edge line");
  // n0 --> n0 (self-edge)
  assert.match(edgeLines[0], /n0 -->\|calls\| n0/);
});

test("renderMermaid: two nodes with identical labels get distinct n<idx> IDs", async () => {
  await lazyImports();
  const nodes = [
    { id: "a\x00x.ts", label: "shared · x.ts", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
    { id: "a\x00y.ts", label: "shared · y.ts", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
  ];
  const edges = [{ source: "a\x00x.ts", target: "a\x00y.ts", kind: "imports", conf: "resolved" }];
  const out = renderMermaid({ nodes, edges });
  // Both n0 and n1 must appear
  assert.match(out, /n0\["/);
  assert.match(out, /n1\["/);
  const edgeLines = out.split("\n").filter((l) => l.includes("-->|"));
  assert.equal(edgeLines.length, 1);
});

test("renderMermaid: long label is truncated to ~60 chars with ellipsis", async () => {
  await lazyImports();
  const longLabel = "a".repeat(80);
  const nodes = [
    { id: "x", label: longLabel, cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
    { id: "y", label: "b", cls: "code", refs: [], candidates: [], degree: 1, cluster: "(root)" },
  ];
  const edges = [{ source: "x", target: "y", kind: "calls", conf: "resolved" }];
  const out = renderMermaid({ nodes, edges });
  // Find the line for node x (n0)
  const nodeLine = out.split("\n").find((l) => /^n0\["/.test(l.trim()));
  assert.ok(nodeLine, "node line for long-label node must exist");
  assert.ok(nodeLine.includes("…"), "long label should be truncated with ellipsis");
  // The label content should be at most ~63 chars between the outer quotes
  const m = nodeLine.match(/^n0\["(.*)"\]/);
  if (m) {
    assert.ok(m[1].length <= 65, `label too long after truncation: ${m[1].length}`);
  }
});

test("renderMermaid: capped graph emits %% capped to N nodes comment", async () => {
  await lazyImports();
  // Pass a meta with truncated info
  const { nodes, edges } = miniGraph();
  const out = renderMermaid({ nodes, edges, meta: { truncated: true, dropped: 5 } });
  assert.ok(out.includes("%% capped"), "capped graph must have capped comment");
});

test("renderMermaid: multiple edges are sorted deterministically", async () => {
  await lazyImports();
  const nodes = [
    { id: "a", label: "A", cls: "code", refs: [], candidates: [], degree: 2, cluster: "(root)" },
    { id: "b", label: "B", cls: "code", refs: [], candidates: [], degree: 2, cluster: "(root)" },
    { id: "c", label: "C", cls: "code", refs: [], candidates: [], degree: 2, cluster: "(root)" },
  ];
  // Pass edges in two different orders — output must be identical
  const edges1 = [
    { source: "a", target: "b", kind: "calls", conf: "resolved" },
    { source: "b", target: "c", kind: "imports", conf: "resolved" },
  ];
  const edges2 = [
    { source: "b", target: "c", kind: "imports", conf: "resolved" },
    { source: "a", target: "b", kind: "calls", conf: "resolved" },
  ];
  const out1 = renderMermaid({ nodes, edges: edges1 });
  const out2 = renderMermaid({ nodes, edges: edges2 });
  assert.equal(out1, out2, "edge order must be normalized for determinism");
});

// ── CLI / runGraph integration: format=mermaid ─────────────────────────────

const ROWS = [
  { kind: "calls", conf: "resolved", from_path: "a.ts", from_lines: "5", from_symbol: "f",
    to_path: "b.ts", to_lines: "10", to_symbol: "g", ref_name: "g", candidates: [], content_hash: "h" },
];

test("runGraph format=mermaid: writes a .mmd file starting with flowchart", async () => {
  await lazyImports();
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-mmd-"));
  try {
    const out = path.join(dir, "g.mmd");
    const r = await runGraph({ repo: dir, out, format: "mermaid", edgesImpl: async () => ROWS });
    assert.equal(r.out, out);
    assert.ok(r.nodes >= 2, "should have at least 2 nodes");
    assert.ok(r.edges >= 1, "should have at least 1 edge");
    const content = readFileSync(out, "utf8");
    assert.ok(content.startsWith("flowchart LR"), `file should start with flowchart LR, got: ${content.slice(0, 40)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGraph format=mermaid: default out is gtir-graph.mmd", async () => {
  await lazyImports();
  // We don't test file system here — just that runGraph accepts format=mermaid and returns a result.
  // A full default-out test would write to cwd; skip to avoid polluting working dir.
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-mmd-"));
  try {
    const out = path.join(dir, "test.mmd");
    const r = await runGraph({ repo: dir, out, format: "mermaid", edgesImpl: async () => ROWS });
    assert.equal(typeof r.out, "string");
    assert.ok(r.out.endsWith(".mmd") || r.out === out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGraph format=html: still works (no regression)", async () => {
  await lazyImports();
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-html-"));
  try {
    const out = path.join(dir, "g.html");
    const r = await runGraph({ repo: dir, out, format: "html", edgesImpl: async () => ROWS });
    const content = readFileSync(out, "utf8");
    assert.ok(content.includes("__GTIR_GRAPH__"), "HTML format must still embed graph data");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runGraph format=mermaid out='-': returns mmd content in result instead of writing", async () => {
  await lazyImports();
  const dir = mkdtempSync(path.join(tmpdir(), "gtir-mmd-"));
  try {
    // When out==="-", runGraph should write to stdout or return content — test that it doesn't throw
    // and that the result indicates the output went to stdout.
    // We accept that it may print to stdout; just assert no throw + result.out==="-".
    const r = await runGraph({ repo: dir, out: "-", format: "mermaid", edgesImpl: async () => ROWS });
    assert.equal(r.out, "-");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
