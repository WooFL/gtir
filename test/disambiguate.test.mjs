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

test("disambiguateEdges: excludes the call-site's own chunk (self-comparison artifact)", () => {
  // 'self' def lives in the SAME chunk as the call site (content_hash "hc") → cosine 1.0 but degenerate.
  // 'other' def is a different chunk, orthogonal. Without exclusion, self would promote at 1.0.
  const si = new Map([["g", [
    { path: "self.mjs", line_start: 1, line_end: 5, embedding: [1, 0, 0], content_hash: "hc" },
    { path: "other.mjs", line_start: 1, line_end: 5, embedding: [0, 1, 0], content_hash: "h2" },
  ]]]);
  const csv = new Map([["hc", [1, 0, 0]]]);
  const row = { kind: "calls", conf: "ambiguous", from_path: "self.mjs", from_symbol: "f",
    to_path: null, to_symbol: null, ref_name: "g", candidates: ["self.mjs", "other.mjs"], content_hash: "hc" };
  const [r] = disambiguateEdges([row], { symbolIndex: si, callSiteVec: csv });
  assert.equal(r.conf, "ambiguous"); // self excluded; other scores 0 < threshold → not promoted
});

test("disambiguateEdges: a different-chunk same-name def still promotes (no over-exclusion)", () => {
  const si = new Map([["g", [{ path: "real.mjs", line_start: 1, line_end: 5, embedding: [1, 0, 0], content_hash: "h2" }]]]);
  const csv = new Map([["hc", [1, 0, 0]]]);
  const row = { kind: "calls", conf: "ambiguous", from_path: "caller.mjs", from_symbol: "f",
    to_path: null, to_symbol: null, ref_name: "g", candidates: ["real.mjs"], content_hash: "hc" };
  const [r] = disambiguateEdges([row], { symbolIndex: si, callSiteVec: csv });
  assert.equal(r.conf, "inferred");
  assert.equal(r.to_path, "real.mjs");
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

test("disambiguateEdges: member-call to a denylisted name is NOT promoted", () => {
  // perfect-score candidate in a DIFFERENT chunk — would promote if not for the structural filter.
  const si = new Map([["get", [{ path: "store.ts", line_start: 1, line_end: 5, embedding: [1, 0, 0], content_hash: "h2" }]]]);
  const csv = new Map([["hc", [1, 0, 0]]]);
  const row = { kind: "calls", conf: "ambiguous", from_path: "c.ts", from_symbol: "f", to_path: null, to_symbol: null,
    ref_name: "get", candidates: ["store.ts"], content_hash: "hc", isMethod: true };
  const [r] = disambiguateEdges([row], { symbolIndex: si, callSiteVec: csv });
  assert.equal(r.conf, "ambiguous"); // suppressed despite cosine 1.0
  assert.deepEqual(r.candidates, ["store.ts"]); // returned unchanged — candidates preserved
});

test("disambiguateEdges: a BARE denylisted name still promotes (free function)", () => {
  const si = new Map([["get", [{ path: "store.ts", line_start: 1, line_end: 5, embedding: [1, 0, 0], content_hash: "h2" }]]]);
  const csv = new Map([["hc", [1, 0, 0]]]);
  const row = { kind: "calls", conf: "ambiguous", from_path: "c.ts", from_symbol: "f", to_path: null, to_symbol: null,
    ref_name: "get", candidates: ["store.ts"], content_hash: "hc", isMethod: false };
  const [r] = disambiguateEdges([row], { symbolIndex: si, callSiteVec: csv });
  assert.equal(r.conf, "inferred");
});

test("disambiguateEdges: a member-call to a DISTINCTIVE name still promotes", () => {
  const si = new Map([["canUndo", [{ path: "history.ts", line_start: 1, line_end: 5, embedding: [1, 0, 0], content_hash: "h2" }]]]);
  const csv = new Map([["hc", [1, 0, 0]]]);
  const row = { kind: "calls", conf: "ambiguous", from_path: "c.ts", from_symbol: "f", to_path: null, to_symbol: null,
    ref_name: "canUndo", candidates: ["history.ts"], content_hash: "hc", isMethod: true };
  const [r] = disambiguateEdges([row], { symbolIndex: si, callSiteVec: csv });
  assert.equal(r.conf, "inferred");
});
