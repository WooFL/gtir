import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGoMethodDefs } from "../src/go-types.mjs";

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
