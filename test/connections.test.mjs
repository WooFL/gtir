import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";

test("connections config defaults exist with sane values", () => {
  assert.equal(DEFAULTS.connK, 12);
  assert.equal(DEFAULTS.connGraphWeight, 0.25);
  assert.equal(DEFAULTS.connGraphHops, 2);
  assert.equal(DEFAULTS.connFusion, true);
});
