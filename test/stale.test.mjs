import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForHash, extractSignature, hashText, snapshotRow, gradeDrift, diffBaseline,
} from "../src/stale.mjs";

test("normalizeForHash ignores whitespace and comments", () => {
  const a = "function f(x) {\n  // adds one\n  return x + 1;\n}";
  const b = "function f(x){ return x+1; } /* reformatted */";
  assert.equal(normalizeForHash(a), normalizeForHash(b));
});

test("normalizeForHash differs on a real token change", () => {
  const a = "function f(x) { return x + 1; }";
  const b = "function f(x) { return x + 2; }";
  assert.notEqual(normalizeForHash(a), normalizeForHash(b));
});

test("extractSignature takes the header up to the body for brace langs", () => {
  assert.equal(extractSignature("foo(a: number): string { return a + ''; }"), "foo(a: number): string");
});

test("extractSignature handles arrow functions", () => {
  assert.equal(extractSignature("const f = (a) => { return a; }"), "const f = (a) =>");
});

test("extractSignature handles python def", () => {
  assert.equal(extractSignature("def f(a):\n    return a"), "def f(a):");
});

test("extractSignature falls back to first non-empty line", () => {
  assert.equal(extractSignature("xyz no markers here\nsecond"), "xyz no markers here");
});

test("hashText is stable and differs on change", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("snapshotRow produces row with hashes, sig and snippet for a symbol", () => {
  const row = snapshotRow({ kind: "symbol", symbol: "f", path: "a.ts", lines: "1-3",
    text: "f(a: number): void {\n  do(a);\n  more();\n}" });
  assert.equal(row.symbol, "f");
  assert.equal(row.kind, "symbol");
  assert.equal(row.sig, "f(a: number): void");
  assert.ok(row.bodyHash && row.sigHash);
  assert.ok(row.snippet.split("\n").length <= 3);
});

test("snapshotRow for a file link omits sigHash", () => {
  const row = snapshotRow({ kind: "file", path: "a.ts", text: "line1\nline2\nline3\nline4" });
  assert.equal(row.kind, "file");
  assert.equal(row.sigHash, undefined);
  assert.ok(row.bodyHash);
});

test("gradeDrift: signature change", () => {
  const oldRow = { sigHash: "s1", bodyHash: "b1" };
  const cur = { sigHash: "s2", bodyHash: "b2" };
  assert.equal(gradeDrift(oldRow, cur), "signature");
});

test("gradeDrift: body-only change", () => {
  assert.equal(gradeDrift({ sigHash: "s1", bodyHash: "b1" }, { sigHash: "s1", bodyHash: "b2" }), "body");
});

test("gradeDrift: removed when current is null", () => {
  assert.equal(gradeDrift({ sigHash: "s1", bodyHash: "b1" }, null), "removed");
});

test("gradeDrift: no drift when identical", () => {
  assert.equal(gradeDrift({ sigHash: "s1", bodyHash: "b1" }, { sigHash: "s1", bodyHash: "b1" }), null);
});

test("diffBaseline reports only the changed note, with before/after", () => {
  const baseline = {
    "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f(): void", snippet: "f() {" }],
    "b.md": [{ symbol: "g", path: "b.ts", lines: "1-2", kind: "symbol", sigHash: "s9", bodyHash: "b9", sig: "g(): void", snippet: "g() {" }],
  };
  const current = {
    "a.md": [{ symbol: "f", path: "a.ts", lines: "5-8", kind: "symbol", sigHash: "s2", bodyHash: "b2", sig: "f(x): void", snippet: "f(x) {" }],
    "b.md": [{ symbol: "g", path: "b.ts", lines: "1-2", kind: "symbol", sigHash: "s9", bodyHash: "b9", sig: "g(): void", snippet: "g() {" }],
  };
  const out = diffBaseline(baseline, current, {});
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].note, "a.md");
  assert.equal(out.stale[0].rows[0].severity, "signature");
  assert.equal(out.stale[0].rows[0].before.sig, "f(): void");
  assert.equal(out.stale[0].rows[0].after.sig, "f(x): void");
});

test("diffBaseline skips muted notes and symbols", () => {
  const baseline = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1" }] };
  const current = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s2", bodyHash: "b2" }] };
  assert.equal(diffBaseline(baseline, current, { "a.md": ["f"] }).stale.length, 0);
  assert.equal(diffBaseline(baseline, current, { "a.md": ["*"] }).stale.length, 0);
});

test("diffBaseline ignores a brand-new (un-baselined) current link", () => {
  const baseline = { "a.md": [] };
  const current = { "a.md": [{ symbol: "new", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s2", bodyHash: "b2" }] };
  assert.equal(diffBaseline(baseline, current, {}).stale.length, 0);
});

test("diffBaseline treats a moved symbol (same bodyHash, new path) as not drift", () => {
  const baseline = { "a.md": [{ symbol: "f", path: "old.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1" }] };
  const current = { "a.md": [{ symbol: "f", path: "new.ts", lines: "9-11", kind: "symbol", sigHash: "s1", bodyHash: "b1" }] };
  assert.equal(diffBaseline(baseline, current, {}).stale.length, 0);
});

test("diffBaseline marks removed when symbol absent from current", () => {
  const baseline = { "a.md": [{ symbol: "f", path: "a.ts", lines: "1-3", kind: "symbol", sigHash: "s1", bodyHash: "b1", sig: "f()", snippet: "f() {" }] };
  const current = { "a.md": [] };
  const out = diffBaseline(baseline, current, {});
  assert.equal(out.stale[0].rows[0].severity, "removed");
  assert.equal(out.stale[0].rows[0].after, null);
});

test("extractSignature does not truncate on => inside a return type", () => {
  assert.equal(
    extractSignature("fetchUser(id: string): Promise<(e: Error) => void> { return null; }"),
    "fetchUser(id: string): Promise<(e: Error) => void>",
  );
});

test("snapshotRow + gradeDrift integrate: body change graded body, identical graded null", () => {
  const a = snapshotRow({ kind: "symbol", symbol: "f", path: "a.ts", lines: "1-3", text: "f() {\n  return 1;\n}" });
  const b = snapshotRow({ kind: "symbol", symbol: "f", path: "a.ts", lines: "1-3", text: "f() {\n  return 2;\n}" });
  assert.equal(gradeDrift(a, b), "body");
  assert.equal(gradeDrift(a, a), null);
});
