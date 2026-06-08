import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCppMethodDefs } from "../src/cpp-types.mjs";

test("extractCppMethodDefs: out-of-class definition", () => {
  assert.deepEqual(extractCppMethodDefs(`int Foo::bar(int x) { return x; }`), [{ cls: "Foo", method: "bar" }]);
});
test("extractCppMethodDefs: out-of-class const-qualified", () => {
  assert.deepEqual(extractCppMethodDefs(`void Foo::tick() const { }`), [{ cls: "Foo", method: "tick" }]);
});
test("extractCppMethodDefs: in-class inline defs (constructor skipped)", () => {
  const defs = extractCppMethodDefs(`class Foo { public: Foo(){} int baz(int x){ return x; } void qux(){} };`);
  assert.deepEqual(defs, [{ cls: "Foo", method: "baz" }, { cls: "Foo", method: "qux" }]);
});
test("extractCppMethodDefs: in-class skips control keywords in bodies", () => {
  const defs = extractCppMethodDefs(`struct S { int m(int x){ if (x) { return 1; } for (;;) {} return 0; } };`);
  assert.deepEqual(defs, [{ cls: "S", method: "m" }]);
});
test("extractCppMethodDefs: prototype (no body) is not a def", () => {
  assert.deepEqual(extractCppMethodDefs(`void Foo::bar();`), []);
});
test("extractCppMethodDefs: a qualified CALL is not a def", () => {
  assert.deepEqual(extractCppMethodDefs(`auto y = std::move(x); if (Foo::ok()) { go(); }`), []);
});
test("extractCppMethodDefs: free function is not a method", () => {
  assert.deepEqual(extractCppMethodDefs(`int free_fn(int x){ return x; }`), []);
});
test("extractCppMethodDefs: empty", () => {
  assert.deepEqual(extractCppMethodDefs(``), []);
});
