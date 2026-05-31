import { test } from "node:test";
import assert from "node:assert/strict";
import { langFor, isIndexable, targetTypes } from "../src/languages.mjs";

test("langFor maps known extensions", () => {
  assert.equal(langFor(".ts"), "typescript");
  assert.equal(langFor(".PY"), "python");   // case-insensitive
  assert.equal(langFor(".rs"), "rust");
  assert.equal(langFor(".wgsl"), null);      // no grammar → recursive fallback
});

test("isIndexable gates on extension allowlist", () => {
  assert.equal(isIndexable(".ts"), true);
  assert.equal(isIndexable(".png"), false);
});

test("targetTypes returns node kinds for a lang, [] for unknown", () => {
  assert.ok(targetTypes("python").includes("function_definition"));
  assert.deepEqual(targetTypes("cobol"), []);
});
