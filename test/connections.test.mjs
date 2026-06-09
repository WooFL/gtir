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

import { sectionOf, snippetOf, lexicalQuery, queryTermsOf, bestTerm } from "../src/connections.mjs";

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
