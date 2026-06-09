import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { buildGraph } from "../src/edge-graph.mjs";
import { linkProximity, proximityScore } from "../src/connections.mjs";

test("connections config defaults exist with sane values", () => {
  assert.equal(DEFAULTS.connK, 12);
  assert.equal(DEFAULTS.connGraphWeight, 0.25);
  assert.equal(DEFAULTS.connGraphHops, 2);
  assert.equal(DEFAULTS.connFusion, true);
});

// helper: a links edge row as the indexer emits for notes
const link = (from, to) => ({ kind: "links", conf: "resolved", from_path: from, from_symbol: null, to_path: to });

test("linkProximity: direct link is hop 1, two-step is hop 2, unrelated is null", () => {
  // a -> b -> c ; a -> d (so d is hop1, c is hop2 from a)
  const g = buildGraph([link("a.md", "b.md"), link("b.md", "c.md"), link("a.md", "d.md")]);
  const prox = linkProximity(g, "a.md", ["b.md", "c.md", "d.md", "z.md"], { hops: 2 });
  assert.equal(prox.get("b.md").hop, 1);
  assert.equal(prox.get("d.md").hop, 1);
  assert.equal(prox.get("c.md").hop, 2);
  assert.equal(prox.get("z.md").hop, null);
});

test("linkProximity: co-citation counts shared neighbors", () => {
  // a and x both link to shared.md -> co-citation 1 between a and x
  const g = buildGraph([link("a.md", "shared.md"), link("x.md", "shared.md")]);
  const prox = linkProximity(g, "a.md", ["x.md"], { hops: 2 });
  assert.equal(prox.get("x.md").coCite, 1);
});

test("proximityScore: direct link dominates, bounded to [0,1]", () => {
  assert.equal(proximityScore({ hop: 1, coCite: 0 }), 1);
  assert.equal(proximityScore({ hop: null, coCite: 0 }), 0);
  assert.ok(proximityScore({ hop: 2, coCite: 0 }) > 0 && proximityScore({ hop: 2, coCite: 0 }) < 1);
  assert.ok(proximityScore({ hop: null, coCite: 9 }) <= 1);
});

import { sectionOf, snippetOf, lexicalQuery, queryTermsOf, bestTerm, fuseConnections } from "../src/connections.mjs";

test("sectionOf returns the first heading text", () => {
  assert.equal(sectionOf("## Edge confidence tiers\nbody text"), "Edge confidence tiers");
  assert.equal(sectionOf("no heading here"), "");
});

test("snippetOf strips headings and trims to a short body excerpt", () => {
  const s = snippetOf("# Title\n\nThe resolved tier never lies. ".repeat(20));
  assert.ok(!s.startsWith("# Title"));
  assert.ok(s.length <= 200);
  assert.ok(s.includes("resolved tier"));
});

test("lexicalQuery joins de-slugified title and headings", () => {
  const q = lexicalQuery("notes/edge-confidence.md", [{ text: "## Resolved tier\nbody\n### Inferred" }]);
  assert.ok(q.includes("edge confidence"));
  assert.ok(q.includes("Resolved tier"));
  assert.ok(q.includes("Inferred"));
});

test("queryTermsOf + bestTerm pick a shared salient term", () => {
  const terms = queryTermsOf("Resolved tier inferred promotion");
  assert.ok(terms.includes("resolved"));
  assert.ok(!terms.includes("the")); // too short
  assert.equal(bestTerm("the promotion was inferred here", terms), "promotion"); // longest present
  assert.equal(bestTerm("nothing matches", terms), null);
});

test("fuseConnections ranks, bounds the graph boost, and tags why", () => {
  const entries = [
    { path: "edges.md", sem: { rank: 1, sim: 0.7, lineStart: 12, lineEnd: 40, text: "## Edge tiers\nresolved vs inferred" }, lex: null },
    { path: "fusion.md", sem: null, lex: { rank: 1, lineStart: 5, lineEnd: 22, text: "## RRF\nreciprocal rank fusion", term: "fusion" } },
  ];
  const proximity = new Map([["edges.md", { hop: 2, coCite: 0 }], ["fusion.md", { hop: null, coCite: 0 }]]);
  const out = fuseConnections(entries, proximity, { connGraphWeight: 0.25 });

  const edges = out.find((r) => r.path === "edges.md");
  const fusion = out.find((r) => r.path === "fusion.md");
  assert.deepEqual(edges.why, ["semantic", "link:2hop"]);
  assert.deepEqual(fusion.why, ["term:fusion"]);
  assert.equal(edges.section, "Edge tiers");
  assert.equal(edges.lines, "12-40");
  // graph multiplier is bounded: edges' score <= base_rrf * (1 + 0.25)
  const baseEdges = 1 / (60 + 1);
  assert.ok(edges.score <= Number((baseEdges * 1.25).toFixed(4)) + 1e-9);
  // results are sorted by score descending
  assert.deepEqual(out.map((r) => r.path), [...out].sort((a, b) => b.score - a.score).map((r) => r.path));
});

test("fuseConnections: a result with no graph proximity gets multiplier 1 (no invented boost)", () => {
  const entries = [{ path: "x.md", sem: { rank: 1, sim: 0.5, lineStart: 1, lineEnd: 3, text: "body only" }, lex: null }];
  const out = fuseConnections(entries, new Map(), { connGraphWeight: 0.25 });
  assert.equal(out[0].score, Number((1 / 61).toFixed(4)));
  assert.deepEqual(out[0].why, ["semantic"]);
  assert.equal(out[0].section, ""); // no heading
});

import { before as _before, after as _after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex, indexEdges } from "../src/indexer.mjs";
import { openStore } from "../src/store.mjs";
import { computeConnections, graphNeighborhood } from "../src/connections.mjs";

const DIM = 16;
// Deterministic embed shaped like Ollama /api/embed (one vector per input), same as no-egress test.
const evec = (t) => { const v = Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 5; return v; };
let _realFetch;
_before(() => {
  _realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/embed") {
      const input = JSON.parse(opts.body || "{}").input;
      const arr = Array.isArray(input) ? input : [input];
      return { ok: true, status: 200, json: async () => ({ embeddings: arr.map(evec) }), text: async () => "" };
    }
    if (u.pathname === "/api/version") return { ok: true, status: 200, json: async () => ({ version: "stub" }), text: async () => "" };
    if (u.pathname === "/api/tags") return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
});
_after(() => { globalThis.fetch = _realFetch; });

function notesVault() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-conn-"));
  // alpha links to beta; gamma is about the same topic but not linked.
  writeFileSync(join(repo, "alpha.md"),
    "# Alpha\n\nThis note covers retrieval fusion and reciprocal rank fusion.\nSee [[beta]] for the edge details.\n");
  writeFileSync(join(repo, "beta.md"),
    "# Beta\n\n## Edge confidence tiers\nResolved versus inferred edges and how promotion works.\n");
  writeFileSync(join(repo, "gamma.md"),
    "# Gamma\n\n## Reciprocal rank fusion\nReciprocal rank fusion blends vector and lexical retrieval.\n");
  return repo;
}

test("computeConnections returns related notes with a link-graph why-tag", async () => {
  const repo = notesVault();
  // Force notes mode so the edge layer emits links/embeds. nomic model name -> isNotesMode true.
  const cfg = { ...loadConfig(repo), model: "nomic-embed-text", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(cfg, { rebuild: true });
    await indexEdges(cfg, { rebuild: true, collect: false });
    const store = await openStore(cfg);
    assert.equal(await store.hasEdges(), true, "fixture built link edges");

    const res = await computeConnections(cfg, { path: "alpha.md", k: 5 });
    assert.equal(res.note, "alpha.md");
    assert.ok(res.results.length >= 1, "returned at least one related note");
    // beta is directly linked from alpha -> must appear with a link: why-tag.
    const beta = res.results.find((r) => r.path === "beta.md");
    assert.ok(beta, "beta.md is among results");
    assert.ok(beta.why.some((w) => w.startsWith("link:")), `beta carries a link tag: ${beta.why.join(",")}`);
    // every result has the response shape.
    for (const r of res.results) {
      assert.equal(typeof r.score, "number");
      assert.match(r.lines, /^\d+-\d+$/);
      assert.ok(Array.isArray(r.why));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("computeConnections errors cleanly on a missing path arg and an unindexed note", async () => {
  const repo = notesVault();
  const cfg = { ...loadConfig(repo), model: "nomic-embed-text" };
  try {
    assert.equal((await computeConnections(cfg, {})).error, "path is required");
    await buildIndex(cfg, { rebuild: true });
    const r = await computeConnections(cfg, { path: "does-not-exist.md", k: 5 });
    assert.deepEqual([r.note, r.status, r.results], ["does-not-exist.md", "not-indexed", []]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("graphNeighborhood returns the active note's neighborhood (center + nodes + a link edge)", async () => {
  const repo = notesVault();
  const cfg = { ...loadConfig(repo), model: "nomic-embed-text", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(cfg, { rebuild: true });
    await indexEdges(cfg, { rebuild: true, collect: false });
    const g = await graphNeighborhood(cfg, { path: "alpha.md", k: 5 });
    assert.equal(g.center, "alpha.md");
    const center = g.nodes.find((n) => n.path === "alpha.md");
    assert.ok(center && center.center === true, "center node flagged");
    assert.ok(g.nodes.some((n) => n.path === "beta.md"), "beta in the neighborhood");
    // alpha [[beta]] -> an edge between them (either a link edge or center->related)
    assert.ok(g.edges.some((e) =>
      (e.from === "alpha.md" && e.to === "beta.md") || (e.from === "beta.md" && e.to === "alpha.md")),
      "alpha–beta edge present");
    for (const n of g.nodes) {
      assert.equal(typeof n.weight, "number");
      assert.equal(typeof n.label, "string");
      assert.equal(typeof n.group, "string");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("graphNeighborhood errors on missing path and reports an unindexed note", async () => {
  const repo = notesVault();
  const cfg = { ...loadConfig(repo), model: "nomic-embed-text" };
  try {
    assert.equal((await graphNeighborhood(cfg, {})).error, "path is required");
    await buildIndex(cfg, { rebuild: true });
    const r = await graphNeighborhood(cfg, { path: "nope.md" });
    assert.deepEqual([r.center, r.status, r.nodes, r.edges], ["nope.md", "not-indexed", [], []]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
