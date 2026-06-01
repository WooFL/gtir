import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens, pickGrepTerm, countMatches, declaredSymbol, meaningGap, formatDemo,
} from "../src/demo.mjs";

test("estimateTokens ~ chars/4, from a string or a raw length", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);   // ceil
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(""), 0);
});

test("pickGrepTerm picks the longest distinctive word, or honors the override", () => {
  assert.equal(pickGrepTerm("where do we verify a JWT and reject expired tokens"), "expired");
  assert.equal(pickGrepTerm("evict the least recently used entry"), "recently");
  assert.equal(pickGrepTerm("anything here", "verify"), "verify");
});

test("countMatches: case-insensitive, non-overlapping", () => {
  assert.equal(countMatches("Verify verify VERIFY", "verify"), 3);
  assert.equal(countMatches("nothing relevant", "verify"), 0);
  assert.equal(countMatches("aaa", "aa"), 1);     // non-overlapping
  assert.equal(countMatches("x", ""), 0);
});

test("declaredSymbol pulls the first declared identifier across languages", () => {
  assert.equal(declaredSymbol("export function verifyToken(raw) {"), "verifyToken");
  assert.equal(declaredSymbol("def evict_lru(self):"), "evict_lru");
  assert.equal(declaredSymbol("pub fn rotate(v: Vec3) {"), "rotate");
  assert.equal(declaredSymbol("// just a comment"), null);
});

test("meaningGap flags a result symbol absent from the query", () => {
  assert.deepEqual(meaningGap("verify a jwt", "function verifyToken(x){"), { kind: "symbol", symbol: "verifyToken" });
  assert.deepEqual(meaningGap("call verifyToken now", "function verifyToken(x){"), { kind: "vocab" });
  assert.deepEqual(meaningGap("anything", "no declaration here"), { kind: "vocab" });
});

test("formatDemo renders the contrast and emits no ANSI when color is off", () => {
  const r = {
    query: "verify a jwt", term: "verify",
    grep: { matches: 23, hitFiles: [{ relPath: "auth/jwt.ts", bytes: 400 }, { relPath: "auth/jwt.test.ts", bytes: 300 }] },
    gtirTokens: 600, grepTokens: 3600, ratio: 6,
    top: { path: "auth/jwt.ts", lines: "9-15", snippet: "export function verifyToken(raw) {\n  return jwt.verify(raw)\n}" },
    gap: { kind: "symbol", symbol: "verifyToken" },
    hits: [], bundled: true, corpus: "x",
  };
  const s = formatDemo(r, { color: false });
  assert.match(s, /verify a jwt/);
  assert.match(s, /grep -rin verify/);
  assert.match(s, /23 matches in 2 files/);
  assert.match(s, /auth\/jwt\.ts:9-15/);
  assert.match(s, /never said "verifyToken"/);
  assert.match(s, /6× less/);
  assert.doesNotMatch(s, /\x1b\[/);   // color:false → plain text
});

test("formatDemo handles the no-results case without throwing", () => {
  const r = { query: "q", term: "t", grep: { matches: 0, hitFiles: [] }, gtirTokens: 0, grepTokens: 0, ratio: null, top: null, gap: null, hits: [] };
  const s = formatDemo(r, { color: false });
  assert.match(s, /\(no results\)/);
});
