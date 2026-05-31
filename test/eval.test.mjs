import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines, overlaps } from "../src/eval.mjs";

test("parseLines: 'start-end' string", () => {
  assert.deepEqual(parseLines("12-40"), [12, 40]);
});
test("parseLines: single number", () => {
  assert.deepEqual(parseLines("7"), [7, 7]);
});
test("parseLines: whitespace and array forms", () => {
  assert.deepEqual(parseLines(" 3 - 9 "), [3, 9]);
  assert.deepEqual(parseLines([5, 8]), [5, 8]);
});

test("overlaps: touching, nested, disjoint, identical", () => {
  assert.equal(overlaps([1, 5], [5, 9]), true);
  assert.equal(overlaps([2, 8], [4, 6]), true);
  assert.equal(overlaps([1, 3], [4, 9]), false);
  assert.equal(overlaps([10, 20], [10, 20]), true);
});
