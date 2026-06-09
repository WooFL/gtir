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
