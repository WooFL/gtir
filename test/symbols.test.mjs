import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredCallables } from "../src/symbols.mjs";

test("declaredCallables includes functions/classes/methods/arrow-consts", () => {
  const got = (s) => new Set(declaredCallables(s));
  assert.ok(got("function foo(){}").has("foo"));
  assert.ok(got("export class Bar {}").has("Bar"));
  assert.ok(got("const baz = () => {}").has("baz"));
  assert.ok(got("const qux = async (a) => a").has("qux"));
  assert.ok(got("const h = function(){}").has("h"));
  assert.ok(got("const o = { m(x){ return x; } };").has("m")); // method shorthand
});

test("declaredCallables excludes types, enums, and plain value bindings", () => {
  const got = (s) => new Set(declaredCallables(s));
  assert.ok(!got("type T = string").has("T"));
  assert.ok(!got("interface I { x: number }").has("I"));
  assert.ok(!got("enum E { A, B }").has("E"));
  assert.ok(!got("const n = 5").has("n"));
  assert.ok(!got("let result = compute()").has("result"));
  assert.ok(!got("const arr = items.map(f => f.id)").has("arr")); // nested => is not the RHS arrow
});
