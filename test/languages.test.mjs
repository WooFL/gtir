import { test } from "node:test";
import assert from "node:assert/strict";
import { langFor, isIndexable, targetTypes } from "../src/languages.mjs";

test("langFor maps known extensions", () => {
  assert.equal(langFor(".ts"), "typescript");
  assert.equal(langFor(".PY"), "python");   // case-insensitive
  assert.equal(langFor(".rs"), "rust");
  assert.equal(langFor(".wgsl"), null);      // Rust-like, no grammar → recursive fallback
});

test("langFor maps C/C++/Objective-C and C-style shaders", () => {
  assert.equal(langFor(".c"), "c");
  assert.equal(langFor(".h"), "cpp");        // ambiguous header → C++ superset
  assert.equal(langFor(".cpp"), "cpp");
  assert.equal(langFor(".hpp"), "cpp");
  assert.equal(langFor(".m"), "objc");
  assert.equal(langFor(".mm"), "objc");
});

test("langFor maps shaders: HLSL/GLSL first-class, Slang→hlsl, Metal→cpp, WGSL→recursive", () => {
  assert.equal(langFor(".hlsl"), "hlsl");
  assert.equal(langFor(".fx"), "hlsl");
  assert.equal(langFor(".glsl"), "glsl");
  assert.equal(langFor(".frag"), "glsl");
  assert.equal(langFor(".comp"), "glsl");
  assert.equal(langFor(".slang"), "hlsl");   // Slang is HLSL-derived
  assert.equal(langFor(".metal"), "cpp");    // Metal is C++14-based; no Metal grammar
  assert.equal(langFor(".wgsl"), null);      // Rust-like; no grammar → recursive
});

test("targetTypes for C/C++/Objective-C and shaders", () => {
  assert.ok(targetTypes("c").includes("function_definition"));
  assert.ok(targetTypes("cpp").includes("class_specifier"));
  assert.ok(targetTypes("cpp").includes("namespace_definition"));
  assert.ok(targetTypes("objc").includes("class_interface"));
  assert.ok(targetTypes("hlsl").includes("function_definition"));
  assert.ok(targetTypes("glsl").includes("struct_specifier"));
});

test("isIndexable gates on extension allowlist", () => {
  assert.equal(isIndexable(".ts"), true);
  assert.equal(isIndexable(".png"), false);
});

test("targetTypes returns node kinds for a lang, [] for unknown", () => {
  assert.ok(targetTypes("python").includes("function_definition"));
  assert.deepEqual(targetTypes("cobol"), []);
});
