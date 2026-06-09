import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";

test("crossLinkCap default exists", () => {
  assert.equal(DEFAULTS.crossLinkCap, 15);
});
