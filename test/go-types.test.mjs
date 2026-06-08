import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGoMethodDefs, resolveGoMethods } from "../src/go-types.mjs";

test("extractGoMethodDefs: pointer receiver", () => {
  assert.deepEqual(extractGoMethodDefs(`func (b *Batcher) Batch(x int) int { return x }`), [{ type: "Batcher", method: "Batch" }]);
});
test("extractGoMethodDefs: value receiver", () => {
  assert.deepEqual(extractGoMethodDefs(`func (l Logger) flush() {}`), [{ type: "Logger", method: "flush" }]);
});
test("extractGoMethodDefs: nameless receiver", () => {
  assert.deepEqual(extractGoMethodDefs(`func (*Batcher) Reset() {}`), [{ type: "Batcher", method: "Reset" }]);
});
test("extractGoMethodDefs: multiple methods in one text", () => {
  const defs = extractGoMethodDefs(`func (b *Batcher) Add(x int){}\nfunc (b *Batcher) Flush(){}`);
  assert.deepEqual(defs, [{ type: "Batcher", method: "Add" }, { type: "Batcher", method: "Flush" }]);
});
test("extractGoMethodDefs: a free function is NOT a method", () => {
  assert.deepEqual(extractGoMethodDefs(`func Free(x int) int { return x }`), []);
});
test("extractGoMethodDefs: empty / non-go text", () => {
  assert.deepEqual(extractGoMethodDefs(``), []);
  assert.deepEqual(extractGoMethodDefs(`function f(){}`), []);
});

const idx = new Map([
  ["Batcher#Flush", [{ path: "batcher.go", line_start: 1, line_end: 5 }]],
  ["Logger#Flush", [{ path: "logger.go", line_start: 1, line_end: 5 }]],
]);
const ambRow = (over = {}) => ({ kind: "calls", conf: "ambiguous", isMethod: true, ref_name: "Flush",
  from_path: "use.go", to_path: null, to_symbol: null, to_lines: null, candidates: ["batcher.go", "logger.go"], ...over });

test("resolveGoMethods: upgrades a type-pinned ambiguous method call to resolved", () => {
  const [r] = resolveGoMethods([ambRow({ receiverType: "Batcher" })], idx);
  assert.equal(r.conf, "resolved");
  assert.equal(r.to_path, "batcher.go");
  assert.equal(r.to_symbol, "Flush");
  assert.equal(r.to_lines, "1-5");
  assert.deepEqual(r.candidates, []);
});
test("resolveGoMethods: no receiverType → unchanged", () => {
  const [r] = resolveGoMethods([ambRow({ receiverType: null })], idx);
  assert.equal(r.conf, "ambiguous");
});
test("resolveGoMethods: type has no such method → unchanged", () => {
  const [r] = resolveGoMethods([ambRow({ receiverType: "Nonexistent" })], idx);
  assert.equal(r.conf, "ambiguous");
});
test("resolveGoMethods: non-method / non-ambiguous rows pass through", () => {
  const resolved = { kind: "calls", conf: "resolved", isMethod: true, ref_name: "Flush", receiverType: "Batcher", to_path: "x.go" };
  const bare = ambRow({ isMethod: false, receiverType: "Batcher" });
  const out = resolveGoMethods([resolved, bare], idx);
  assert.equal(out[0].to_path, "x.go");
  assert.equal(out[1].conf, "ambiguous");
});
test("resolveGoMethods: two defs for the same type#method → unchanged (genuinely ambiguous)", () => {
  const dup = new Map([["Batcher#Flush", [{ path: "a.go", line_start: 1, line_end: 2 }, { path: "b.go", line_start: 1, line_end: 2 }]]]);
  const [r] = resolveGoMethods([ambRow({ receiverType: "Batcher" })], dup);
  assert.equal(r.conf, "ambiguous");
});
