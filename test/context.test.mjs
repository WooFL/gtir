import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";

test("context config defaults exist", () => {
  assert.equal(DEFAULTS.contextK, 5);
  assert.equal(DEFAULTS.contextMarginHigh, 0.30);
  assert.equal(DEFAULTS.contextMarginLow, 0.08);
});
