import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCppMethodDefs, resolveCppMethods } from "../src/cpp-types.mjs";

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
test("extractCppMethodDefs: a qualified call inside an if is not a def (regression)", () => {
  assert.deepEqual(extractCppMethodDefs(`if (Foo::ok()) { go(); }`), []);
});
test("extractCppMethodDefs: a def with paren-containing params is a graceful miss (precision-first)", () => {
  // function-pointer param contains (); excluded by [^;{}()] — we'd rather miss than false-positive.
  assert.deepEqual(extractCppMethodDefs(`void Foo::set(void (*cb)(int)) { }`), []);
});

const idx = new Map([
  ["Encoder#flush", [{ path: "encoder.cpp", line_start: 1, line_end: 5 }]],
  ["Sink#flush", [{ path: "sink.cpp", line_start: 1, line_end: 5 }]],
]);
const ambRow = (over = {}) => ({ kind: "calls", conf: "ambiguous", isMethod: true, ref_name: "flush",
  from_path: "use.cpp", to_path: null, to_symbol: null, to_lines: null, candidates: ["encoder.cpp", "sink.cpp"], ...over });

test("resolveCppMethods: upgrades a type-pinned ambiguous member call to resolved", () => {
  const [r] = resolveCppMethods([ambRow({ receiverType: "Encoder" })], idx);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "encoder.cpp");
  assert.equal(r.to_symbol, "flush");
  assert.equal(r.to_lines, "1-5");
  assert.deepEqual(r.candidates, []);
});
test("resolveCppMethods: overloads (several defs, one file) still resolve", () => {
  const over = new Map([["Encoder#flush", [
    { path: "encoder.cpp", line_start: 1, line_end: 5 },
    { path: "encoder.cpp", line_start: 7, line_end: 11 },
  ]]]);
  const [r] = resolveCppMethods([ambRow({ receiverType: "Encoder" })], over);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "encoder.cpp");
});
test("resolveCppMethods: same class#method in two files → stays ambiguous", () => {
  const split = new Map([["Encoder#flush", [
    { path: "a.cpp", line_start: 1, line_end: 5 },
    { path: "b.cpp", line_start: 1, line_end: 5 },
  ]]]);
  const [r] = resolveCppMethods([ambRow({ receiverType: "Encoder" })], split);
  assert.equal(r.conf, "ambiguous");
});
test("resolveCppMethods: no receiverType / unknown type / non-method → unchanged", () => {
  assert.equal(resolveCppMethods([ambRow({ receiverType: null })], idx)[0].conf, "ambiguous");
  assert.equal(resolveCppMethods([ambRow({ receiverType: "Nope" })], idx)[0].conf, "ambiguous");
  assert.equal(resolveCppMethods([ambRow({ isMethod: false, receiverType: "Encoder" })], idx)[0].conf, "ambiguous");
});
