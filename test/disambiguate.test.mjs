import { test } from "node:test";
import assert from "node:assert/strict";
import { cosine, disambiguateEdges } from "../src/disambiguate.mjs";

test("cosine: identical=1, orthogonal=0, length-mismatch=0", () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 2, 3], [1, 2]), 0);
});

// near.mjs def embeds like the call site ([1,0,0]); far.mjs is orthogonal ([0,1,0]).
const symbolIndex = new Map([["target", [
  { path: "near.mjs", line_start: 10, line_end: 20, embedding: [1, 0, 0] },
  { path: "far.mjs", line_start: 5, line_end: 9, embedding: [0, 1, 0] },
]]]);
const callSiteVec = new Map([["hc", [1, 0, 0]]]);
const ambRow = (cands) => ({ kind: "calls", conf: "ambiguous", from_path: "caller.mjs", from_symbol: "use",
  to_path: null, to_symbol: null, ref_name: "target", candidates: cands, content_hash: "hc" });

test("disambiguateEdges: promotes the clear winner to inferred", () => {
  const [r] = disambiguateEdges([ambRow(["near.mjs", "far.mjs"])], { symbolIndex, callSiteVec });
  assert.equal(r.conf, "inferred");
  assert.equal(r.to_path, "near.mjs");
  assert.equal(r.to_symbol, "target");
  assert.equal(r.to_lines, "10-20");
  assert.equal(r.score, 1);
  assert.deepEqual(r.candidates, []);
});

test("disambiguateEdges: stays ambiguous when top is below threshold", () => {
  const csv = new Map([["hc", [0, 0, 1]]]);
  const [r] = disambiguateEdges([ambRow(["near.mjs", "far.mjs"])], { symbolIndex, callSiteVec: csv });
  assert.equal(r.conf, "ambiguous");
});

test("disambiguateEdges: stays ambiguous when two candidates are within margin", () => {
  const si = new Map([["target", [
    { path: "near.mjs", line_start: 10, line_end: 20, embedding: [1, 0, 0] },
    { path: "far.mjs", line_start: 5, line_end: 9, embedding: [0.99, 0.14, 0] },
  ]]]);
  const [r] = disambiguateEdges([ambRow(["near.mjs", "far.mjs"])], { symbolIndex: si, callSiteVec });
  assert.equal(r.conf, "ambiguous");
});

test("disambiguateEdges: single candidate promotes on threshold alone", () => {
  const [r] = disambiguateEdges([ambRow(["near.mjs"])], { symbolIndex, callSiteVec });
  assert.equal(r.conf, "inferred");
  assert.equal(r.to_path, "near.mjs");
});

test("disambiguateEdges: missing call-site vector leaves the row unchanged", () => {
  const [r] = disambiguateEdges([ambRow(["near.mjs", "far.mjs"])], { symbolIndex, callSiteVec: new Map() });
  assert.equal(r.conf, "ambiguous");
});

test("disambiguateEdges: non-calls / resolved / external pass through untouched", () => {
  const rows = [
    { kind: "calls", conf: "resolved", to_path: "x.mjs", to_symbol: "y", ref_name: "y", candidates: [], content_hash: "h" },
    { kind: "imports", conf: "resolved", from_path: "a.mjs", to_path: "b.mjs", candidates: [], content_hash: "h" },
    { kind: "calls", conf: "external", ref_name: "Error", candidates: [], content_hash: "h" },
  ];
  const out = disambiguateEdges(rows, { symbolIndex, callSiteVec });
  assert.deepEqual(out, rows);
});
