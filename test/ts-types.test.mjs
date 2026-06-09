import { test } from "node:test";
import assert from "node:assert/strict";
import { getParser } from "../src/parser.mjs";
import { extractTsClassNames, resolveTsMethods, extractTsImplements, resolveTsDispatch, inferTsObjectLiteralTarget } from "../src/ts-types.mjs";

// Parse `src`, return the FIRST call_expression node in source order.
async function firstCall(src) {
  const parser = await getParser("typescript");
  const tree = parser.parse(src);
  let found = null;
  const walk = (n) => {
    if (found) return;
    if (n.type === "call_expression") { found = n; return; }
    for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i));
  };
  walk(tree.rootNode);
  return found;
}

test("extractTsClassNames: class / export class / multiple", () => {
  assert.deepEqual(extractTsClassNames(`class Foo {}`), ["Foo"]);
  assert.deepEqual(extractTsClassNames(`export class Bar extends Base {}`), ["Bar"]);
  assert.deepEqual(extractTsClassNames(`class A{} class B{}`), ["A", "B"]);
});
test("extractTsClassNames: interface / empty are not classes", () => {
  assert.deepEqual(extractTsClassNames(`interface I { run(): void; }`), []);
  assert.deepEqual(extractTsClassNames(``), []);
});

const classFiles = new Map([["Encoder", new Set(["encoder.ts"])], ["Sink", new Set(["sink.ts"])]]);
const callFiles = new Map([["flush", [
  { path: "encoder.ts", line_start: 1, line_end: 3 },
  { path: "sink.ts", line_start: 1, line_end: 3 },
]]]);
const ambRow = (over = {}) => ({ kind: "calls", conf: "ambiguous", isMethod: true, ref_name: "flush",
  from_path: "use.ts", to_path: null, to_symbol: null, to_lines: null, candidates: ["encoder.ts", "sink.ts"], ...over });

test("resolveTsMethods: unique class∩method file → resolved", () => {
  const [r] = resolveTsMethods([ambRow({ receiverType: "Encoder" })], classFiles, callFiles);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "encoder.ts");
  assert.equal(r.to_symbol, "flush");
  assert.equal(r.to_lines, "1-3");
  assert.deepEqual(r.candidates, []);
});
test("resolveTsMethods: .cjs CommonJS caller is gated in (not skipped) → resolved", () => {
  const cjsClassFiles = new Map([["Encoder", new Set(["encoder.cjs"])]]);
  const cjsCallFiles = new Map([["flush", [{ path: "encoder.cjs", line_start: 1, line_end: 3 }]]]);
  const [r] = resolveTsMethods([ambRow({ receiverType: "Encoder", from_path: "use.cjs" })], cjsClassFiles, cjsCallFiles);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "encoder.cjs");
  assert.equal(r.to_symbol, "flush");
});
test("resolveTsMethods: method not defined in the class's file → ambiguous", () => {
  const only = new Map([["flush", [{ path: "sink.ts", line_start: 1, line_end: 3 }]]]);
  const [r] = resolveTsMethods([ambRow({ receiverType: "Encoder" })], classFiles, only);
  assert.equal(r.conf, "ambiguous");
});
test("resolveTsMethods: class declared in 2 files → ambiguous", () => {
  const two = new Map([["Encoder", new Set(["a.ts", "b.ts"])]]);
  const both = new Map([["flush", [{ path: "a.ts", line_start: 1, line_end: 3 }, { path: "b.ts", line_start: 1, line_end: 3 }]]]);
  const [r] = resolveTsMethods([ambRow({ receiverType: "Encoder" })], two, both);
  assert.equal(r.conf, "ambiguous");
});
test("resolveTsMethods: no receiverType / non-method → unchanged", () => {
  assert.equal(resolveTsMethods([ambRow({ receiverType: null })], classFiles, callFiles)[0].conf, "ambiguous");
  assert.equal(resolveTsMethods([ambRow({ isMethod: false, receiverType: "Encoder" })], classFiles, callFiles)[0].conf, "ambiguous");
});

test("extractTsImplements: implements only", () => {
  assert.deepEqual(extractTsImplements(`class A implements IFoo {}`), [{ cls: "A", bases: ["IFoo"] }]);
});
test("extractTsImplements: extends + implements", () => {
  assert.deepEqual(extractTsImplements(`class A extends Base implements IFoo, IBar {}`),
    [{ cls: "A", bases: ["Base", "IFoo", "IBar"] }]);
});
test("extractTsImplements: generics stripped", () => {
  assert.deepEqual(extractTsImplements(`class A extends Base<T> implements IFoo<U> {}`),
    [{ cls: "A", bases: ["Base", "IFoo"] }]);
});
test("extractTsImplements: no clause → empty", () => {
  assert.deepEqual(extractTsImplements(`class A {}`), []);
});
test("extractTsImplements: two classes in one chunk", () => {
  assert.deepEqual(
    extractTsImplements(`class A implements IFoo {} class B extends C {}`),
    [{ cls: "A", bases: ["IFoo"] }, { cls: "B", bases: ["C"] }]
  );
});
test("extractTsImplements: JS extends only", () => {
  assert.deepEqual(extractTsImplements(`class A extends B {}`), [{ cls: "A", bases: ["B"] }]);
});
test("extractTsImplements: interface extends → empty", () => {
  assert.deepEqual(extractTsImplements(`interface X extends Y {}`), []);
});
test("extractTsImplements: export abstract class implements", () => {
  assert.deepEqual(extractTsImplements(`export abstract class A implements IFoo {}`),
    [{ cls: "A", bases: ["IFoo"] }]);
});

// ── resolveTsDispatch ─────────────────────────────────────────────────────────

// Shared helpers for dispatch tests.
const dispatchRow = (over = {}) => ({
  kind: "calls", conf: "ambiguous", isMethod: true,
  from_path: "u.ts", receiverType: "Sender", ref_name: "send",
  to_path: null, to_symbol: null, to_lines: null, candidates: [],
  ...over,
});

test("resolveTsDispatch: interface receiver → dispatch with all implementer files", () => {
  // Sender is an interface (no tsClassFiles entry). Two implementers each define send().
  const tsImplementers = new Map([["Sender", new Set(["EmailSender", "SmsSender"])]]);
  const tsClassFiles   = new Map([
    ["EmailSender", new Set(["a.ts"])],
    ["SmsSender",   new Set(["b.ts"])],
  ]);
  const tsCallableFiles = new Map([["send", [
    { path: "a.ts", line_start: 1, line_end: 3 },
    { path: "b.ts", line_start: 4, line_end: 6 },
  ]]]);
  const [r] = resolveTsDispatch([dispatchRow()], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "dispatch");
  assert.equal(r.to_path, null);
  assert.equal(r.to_symbol, "send");
  assert.equal(r.to_lines, null);
  assert.deepEqual([...r.candidates].sort(), ["a.ts", "b.ts"]);
});

test("resolveTsDispatch: base-class receiver → dispatch candidates include both base and sub files", () => {
  // Base is a class (has a tsClassFiles entry). Sub also defines m. Both paths must appear.
  const tsImplementers  = new Map([["Base", new Set(["Sub"])]]);
  const tsClassFiles    = new Map([
    ["Base", new Set(["base.ts"])],
    ["Sub",  new Set(["sub.ts"])],
  ]);
  const tsCallableFiles = new Map([["m", [
    { path: "base.ts", line_start: 1, line_end: 2 },
    { path: "sub.ts",  line_start: 1, line_end: 2 },
  ]]]);
  const row = dispatchRow({ receiverType: "Base", ref_name: "m" });
  const [r] = resolveTsDispatch([row], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "dispatch");
  assert.deepEqual([...r.candidates].sort(), ["base.ts", "sub.ts"]);
});

test("resolveTsDispatch: no implementers for receiverType → row unchanged", () => {
  const tsImplementers  = new Map();  // nothing registered for "Sender"
  const tsClassFiles    = new Map();
  const tsCallableFiles = new Map([["send", [{ path: "a.ts", line_start: 1, line_end: 1 }]]]);
  const [r] = resolveTsDispatch([dispatchRow()], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "ambiguous");
});

test("resolveTsDispatch: implementer exists but does NOT define the method → excluded; no other impl → unchanged", () => {
  // SmsSender is registered but has no tsCallableFiles entry for "send".
  const tsImplementers  = new Map([["Sender", new Set(["SmsSender"])]]);
  const tsClassFiles    = new Map([["SmsSender", new Set(["sms.ts"])]]);
  const tsCallableFiles = new Map([["send", [
    { path: "other.ts", line_start: 1, line_end: 1 },  // not in SmsSender's files
  ]]]);
  const [r] = resolveTsDispatch([dispatchRow()], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "ambiguous");
});

test("resolveTsDispatch: only base defines method, no implementer override → unchanged (left for resolveTsMethods)", () => {
  // Base defines m; Sub is an implementer but Sub has no entry in tsCallableFiles for m.
  const tsImplementers  = new Map([["Base", new Set(["Sub"])]]);
  const tsClassFiles    = new Map([
    ["Base", new Set(["base.ts"])],
    ["Sub",  new Set(["sub.ts"])],
  ]);
  const tsCallableFiles = new Map([["m", [
    { path: "base.ts", line_start: 1, line_end: 2 },  // only base defines it
  ]]]);
  const row = dispatchRow({ receiverType: "Base", ref_name: "m" });
  const [r] = resolveTsDispatch([row], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "ambiguous");  // no implementer defines it → not a dispatch
});

test("resolveTsDispatch: non-TS from_path → row unchanged", () => {
  const tsImplementers  = new Map([["Sender", new Set(["EmailSender"])]]);
  const tsClassFiles    = new Map([["EmailSender", new Set(["a.ts"])]]);
  const tsCallableFiles = new Map([["send", [{ path: "a.ts", line_start: 1, line_end: 1 }]]]);
  const row = dispatchRow({ from_path: "x.go" });
  const [r] = resolveTsDispatch([row], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "ambiguous");
});

test("resolveTsDispatch: no receiverType → row unchanged", () => {
  const tsImplementers  = new Map([["Sender", new Set(["EmailSender"])]]);
  const tsClassFiles    = new Map([["EmailSender", new Set(["a.ts"])]]);
  const tsCallableFiles = new Map([["send", [{ path: "a.ts", line_start: 1, line_end: 1 }]]]);
  const row = dispatchRow({ receiverType: null });
  const [r] = resolveTsDispatch([row], tsImplementers, tsClassFiles, tsCallableFiles);
  assert.equal(r.conf, "ambiguous");
});

// ── inferTsObjectLiteralTarget ────────────────────────────────────────────────

test("inferTsObjectLiteralTarget resolves a shorthand method on an object-literal local", async () => {
  const src = `function go() {
  const chop = { scalar() { return 1; } };
  chop.scalar();
}`;
  const call = await firstCall(src);
  const t = inferTsObjectLiteralTarget(call, "chop", "scalar");
  assert.deepEqual(t, { line_start: 2, line_end: 2 });
});

test("inferTsObjectLiteralTarget resolves an arrow-function property", async () => {
  const src = `function go() {
  const o = { vec: () => 2 };
  o.vec();
}`;
  const call = await firstCall(src);
  assert.deepEqual(inferTsObjectLiteralTarget(call, "o", "vec"), { line_start: 2, line_end: 2 });
});

test("inferTsObjectLiteralTarget resolves a function-expression property", async () => {
  const src = `function go() {
  const o = { fn: function () { return 3; } };
  o.fn();
}`;
  const call = await firstCall(src);
  assert.deepEqual(inferTsObjectLiteralTarget(call, "o", "fn"), { line_start: 2, line_end: 2 });
});

test("inferTsObjectLiteralTarget returns null when the literal lacks the method", async () => {
  const src = `function go() {
  const o = { scalar() {} };
  o.missing();
}`;
  const call = await firstCall(src);
  assert.equal(inferTsObjectLiteralTarget(call, "o", "missing"), null);
});

test("inferTsObjectLiteralTarget returns null for a class-instance receiver (new Ctor)", async () => {
  const src = `function go() {
  const e = new Engine();
  e.start();
}`;
  const call = await firstCall(src);
  assert.equal(inferTsObjectLiteralTarget(call, "e", "start"), null);
});

test("inferTsObjectLiteralTarget returns null for a non-function member", async () => {
  const src = `function go() {
  const o = { x: 1 };
  o.x();
}`;
  const call = await firstCall(src);
  assert.equal(inferTsObjectLiteralTarget(call, "o", "x"), null);
});

test("inferTsObjectLiteralTarget returns null when the receiver has no binding", async () => {
  const src = `function go(p) {
  p.run();
}`;
  const call = await firstCall(src);
  assert.equal(inferTsObjectLiteralTarget(call, "p", "run"), null);
});

test("inferTsObjectLiteralTarget does not descend into an inner-closure binding when resolving an outer-scope call", async () => {
  const src = `function go() {
  const chop = { a() {} };
  const inner = () => {
    const chop = { b() {} };
    return chop;
  };
  chop.a();
  chop.b();
}`;
  const parser = await getParser("typescript");
  const tree = parser.parse(src);
  const calls = [];
  const walk = (n) => { if (n.type === "call_expression") calls.push(n); for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)); };
  walk(tree.rootNode);
  const aCall = calls.find((c) => c.text.startsWith("chop.a"));
  const bCall = calls.find((c) => c.text.startsWith("chop.b"));
  assert.deepEqual(inferTsObjectLiteralTarget(aCall, "chop", "a"), { line_start: 2, line_end: 2 });
  assert.equal(inferTsObjectLiteralTarget(bCall, "chop", "b"), null);
});

test("inferTsObjectLiteralTarget resolves a module-level binding", async () => {
  const src = `const h = { run() { return 1; } };\nh.run();`;
  const call = await firstCall(src);
  assert.deepEqual(inferTsObjectLiteralTarget(call, "h", "run"), { line_start: 1, line_end: 1 });
});
