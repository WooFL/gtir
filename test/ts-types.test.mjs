import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTsClassNames, resolveTsMethods } from "../src/ts-types.mjs";

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
