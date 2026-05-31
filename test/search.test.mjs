import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF } from "../src/search.mjs";

test("fuseRRF ranks a doc appearing in both branches above single-branch docs", () => {
  const vec = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "y", path: "y.py", line_start: 1, line_end: 2, language: "python", text: "y" }];
  const fts = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "z", path: "z.py", line_start: 1, line_end: 2, language: "python", text: "z" }];
  const ranked = fuseRRF(vec, fts, 5);
  assert.equal(ranked[0].path, "x.py");          // in both branches → top
  assert.equal(typeof ranked[0].score, "number");
  assert.ok(ranked[0].vec_rank === 1 && ranked[0].fts_rank === 1);
});
