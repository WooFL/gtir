import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { retrievalQuality } from "../src/context.mjs";

test("context config defaults exist", () => {
  assert.equal(DEFAULTS.contextK, 5);
  assert.equal(DEFAULTS.contextMarginHigh, 0.30);
  assert.equal(DEFAULTS.contextMarginLow, 0.08);
});

test("retrievalQuality query mode: dominant top hit -> high", () => {
  const r = retrievalQuality([{ score: 0.05, vec_rank: 1 }, { score: 0.02 }], "query");
  assert.equal(r.retrieval_quality, "high");
  assert.equal(r.best_guesses, false);
});

test("retrievalQuality query mode: near-tied -> low + best_guesses + note", () => {
  const r = retrievalQuality([{ score: 0.031 }, { score: 0.030 }], "query");
  assert.equal(r.retrieval_quality, "low");
  assert.equal(r.best_guesses, true);
  assert.match(r.note, /verify/);
});

test("retrievalQuality query mode: empty -> low", () => {
  assert.equal(retrievalQuality([], "query").retrieval_quality, "low");
});

test("retrievalQuality query mode: mid-margin -> medium", () => {
  const r = retrievalQuality([{ score: 0.04, vec_rank: 2 }, { score: 0.035 }], "query");
  assert.equal(r.retrieval_quality, "medium"); // margin 0.125 -> between 0.08 and 0.30
});

test("retrievalQuality targets mode: resolution success drives quality", () => {
  assert.equal(retrievalQuality([{ path: "a" }, { path: "b" }], "targets").retrieval_quality, "high");
  assert.equal(retrievalQuality([{ error: "not found" }], "targets").retrieval_quality, "low");
  assert.equal(retrievalQuality([{ path: "a" }, { error: "not found" }], "targets").retrieval_quality, "medium");
});
