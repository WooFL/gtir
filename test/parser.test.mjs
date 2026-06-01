import { test } from "node:test";
import assert from "node:assert/strict";
import { grammarMissing, OPTIONAL_GRAMMARS } from "../src/parser.mjs";

test("OPTIONAL_GRAMMARS lists the build-on-demand shader grammars", () => {
  assert.ok(OPTIONAL_GRAMMARS.has("glsl"));
  assert.ok(OPTIONAL_GRAMMARS.has("hlsl"));
  assert.ok(!OPTIONAL_GRAMMARS.has("typescript")); // core grammars ship; not optional
});

test("grammarMissing returns false for unmapped and for present grammars", () => {
  assert.equal(grammarMissing("cobol"), false);       // no grammar expected → not 'missing'
  assert.equal(grammarMissing("typescript"), false);  // core grammar resolves on disk
  // The 'missing → true' branch (an optional grammar whose wasm is absent) is covered by the
  // index-time notice; asserting it here would require moving the vendored wasm during the test.
});
