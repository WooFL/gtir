import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCppMethodDefs, resolveCppMethods, extractCppReturnTypes } from "../src/cpp-types.mjs";

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
test("resolveCppMethods: a .metal caller is gated in (regression)", () => {
  const metalIdx = new Map([["Shader#run", [{ path: "shader.metal", line_start: 1, line_end: 5 }]]]);
  const [r] = resolveCppMethods(
    [ambRow({ from_path: "shader.metal", ref_name: "run", receiverType: "Shader",
      candidates: ["shader.metal"] })],
    metalIdx);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "shader.metal");
  assert.equal(r.to_symbol, "run");
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

test("extractCppReturnTypes: bare class return", () => {
  assert.deepEqual(extractCppReturnTypes(`Widget makeWidget(){ return Widget(); }`), [{ name: "makeWidget", returnType: "Widget" }]);
});
test("extractCppReturnTypes: pointer and reference returns", () => {
  assert.deepEqual(extractCppReturnTypes(`Foo* a(){ return 0; }`), [{ name: "a", returnType: "Foo" }]);
  assert.deepEqual(extractCppReturnTypes(`Foo& b(){ static Foo f; return f; }`), [{ name: "b", returnType: "Foo" }]);
  assert.deepEqual(extractCppReturnTypes(`Foo *c(){ return 0; }`), [{ name: "c", returnType: "Foo" }]);
});
test("extractCppReturnTypes: const-qualified return", () => {
  assert.deepEqual(extractCppReturnTypes(`const Foo c(){ return Foo(); }`), [{ name: "c", returnType: "Foo" }]);
});
test("extractCppReturnTypes: trailing return type", () => {
  assert.deepEqual(extractCppReturnTypes(`auto t() -> Gadget { return Gadget(); }`), [{ name: "t", returnType: "Gadget" }]);
});
test("extractCppReturnTypes: smart-pointer return unwraps to element", () => {
  assert.deepEqual(extractCppReturnTypes(`std::unique_ptr<Widget> u(){ return {}; }`), [{ name: "u", returnType: "Widget" }]);
  assert.deepEqual(extractCppReturnTypes(`shared_ptr<Gadget> s(){ return {}; }`), [{ name: "s", returnType: "Gadget" }]);
});
test("extractCppReturnTypes: NEGATIVES yield no entry", () => {
  assert.deepEqual(extractCppReturnTypes(`Foo Bar::m(){ return Foo(); }`), []);   // out-of-class method
  assert.deepEqual(extractCppReturnTypes(`struct W { W(){} };`), []);             // constructor
  assert.deepEqual(extractCppReturnTypes(`void f(){ if (g()) { h(); } }`), []);   // control flow / void
  assert.deepEqual(extractCppReturnTypes(`Foo f();`), []);                        // prototype (no body)
  assert.deepEqual(extractCppReturnTypes(`void g(){ Foo x = make(); }`), []);     // variable, not a def
  assert.deepEqual(extractCppReturnTypes(`int n(){ return 0; }`), []);            // primitive return
  assert.deepEqual(extractCppReturnTypes(`Ns::Foo q(){ return {}; }`), []);       // qualified return
  assert.deepEqual(extractCppReturnTypes(`Vec<int> v(){ return {}; }`), []);      // non-smart-ptr generic
  assert.deepEqual(extractCppReturnTypes(`auto d(){ return 1; }`), []);           // deduced auto, no trailing
});

test("resolveCppMethods: factory path resolves via cppReturnIndex", () => {
  const rows = [{ kind: "calls", conf: "ambiguous", isMethod: true, receiverType: null,
    receiverFactory: "makeFoo", ref_name: "run", from_path: "use.cpp", candidates: ["a.cpp"] }];
  const methodIdx = new Map([["Foo#run", [{ path: "a.cpp", line_start: 2, line_end: 4 }]]]);
  const returnIdx = new Map([["makeFoo", new Set(["Foo"])]]);
  const out = resolveCppMethods(rows, methodIdx, returnIdx);
  assert.equal(out[0].conf, "resolved");
  assert.equal(out[0].to_path, "a.cpp");
  assert.equal(out[0].to_symbol, "run");
});
test("resolveCppMethods: factory with 2 return types stays ambiguous", () => {
  const rows = [{ kind: "calls", conf: "ambiguous", isMethod: true, receiverType: null,
    receiverFactory: "make", ref_name: "run", from_path: "use.cpp", candidates: ["a.cpp", "b.cpp"] }];
  const methodIdx = new Map([["Foo#run", [{ path: "a.cpp", line_start: 1, line_end: 1 }]]]);
  const returnIdx = new Map([["make", new Set(["Foo", "Bar"])]]);
  assert.equal(resolveCppMethods(rows, methodIdx, returnIdx)[0].conf, "ambiguous");
});
test("resolveCppMethods: factory absent from return index stays ambiguous", () => {
  const rows = [{ kind: "calls", conf: "ambiguous", isMethod: true, receiverType: null,
    receiverFactory: "missing", ref_name: "run", from_path: "use.cpp", candidates: ["a.cpp"] }];
  const methodIdx = new Map([["Foo#run", [{ path: "a.cpp", line_start: 1, line_end: 1 }]]]);
  assert.equal(resolveCppMethods(rows, methodIdx, new Map())[0].conf, "ambiguous");
});
test("resolveCppMethods: existing receiverType path still works with the 3rd arg", () => {
  const rows = [{ kind: "calls", conf: "ambiguous", isMethod: true, receiverType: "Foo",
    ref_name: "run", from_path: "use.cpp", candidates: ["a.cpp"] }];
  const methodIdx = new Map([["Foo#run", [{ path: "a.cpp", line_start: 2, line_end: 4 }]]]);
  assert.equal(resolveCppMethods(rows, methodIdx, new Map())[0].conf, "resolved");
});
test("resolveCppMethods: receiverType wins when both receiverType and receiverFactory are set", () => {
  const rows = [{ kind: "calls", conf: "ambiguous", isMethod: true, receiverType: "Foo",
    receiverFactory: "makeBar", ref_name: "run", from_path: "use.cpp", candidates: ["a.cpp"] }];
  const methodIdx = new Map([["Foo#run", [{ path: "a.cpp", line_start: 1, line_end: 1 }]]]);
  const returnIdx = new Map([["makeBar", new Set(["Bar"])]]);   // would resolve to Bar#run if used
  const out = resolveCppMethods(rows, methodIdx, returnIdx);
  assert.equal(out[0].conf, "resolved");
  assert.equal(out[0].to_path, "a.cpp");   // resolved via Foo (receiverType), not Bar (factory)
});
