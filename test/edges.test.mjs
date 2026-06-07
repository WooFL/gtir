import { test } from "node:test";
import assert from "node:assert/strict";
import { getParser } from "../src/parser.mjs";
import { extractCodeEdges } from "../src/edges.mjs";

async function edgesFor(langId, src, path = "a.ts") {
  const parser = await getParser(langId);
  const tree = parser.parse(src);
  return extractCodeEdges(tree, langId, path);
}

test("extractCodeEdges captures a call by callee name", async () => {
  const edges = await edgesFor("typescript", `function a() { return verifyToken(x); }`);
  const call = edges.find((e) => e.kind === "calls" && e.refName === "verifyToken");
  assert.ok(call, "expected a call edge to verifyToken");
  assert.equal(call.fromPath, "a.ts");
  assert.ok(call.fromLine >= 1);
});

test("extractCodeEdges takes the property of a member call", async () => {
  const edges = await edgesFor("typescript", `jwt.verify(raw);`);
  assert.ok(edges.some((e) => e.kind === "calls" && e.refName === "verify"));
});

test("extractCodeEdges captures import source and named specifiers", async () => {
  const edges = await edgesFor("typescript", `import { verifyToken, Session } from "./token";`);
  const imp = edges.find((e) => e.kind === "imports");
  assert.equal(imp.source, "./token");
  assert.deepEqual([...imp.names].sort(), ["Session", "verifyToken"]);
});

test("extractCodeEdges returns [] for a grammarless/empty parse", async () => {
  const edges = await edgesFor("typescript", ``);
  assert.deepEqual(edges, []);
});

const SMOKE = [
  ["python", `def a():\n    verifyToken(x)\n`, "calls", "verifyToken"],
  ["rust",   `fn a() { verify_token(x); }`, "calls", "verify_token"],
  ["go",     `func a() { verifyToken(x) }`, "calls", "verifyToken"],
  ["c",      `void a() { verify_token(x); }`, "calls", "verify_token"],
  ["cpp",    `void a() { verifyToken(x); }`, "calls", "verifyToken"],
];
for (const [lang, src, kind, name] of SMOKE) {
  test(`extractCodeEdges smoke: ${lang}`, async () => {
    const edges = await edgesFor(lang, src, `a.${lang}`);
    assert.ok(edges.some((e) => e.kind === kind && e.refName === name),
      `${lang}: expected ${kind} ${name}, got ${JSON.stringify(edges)}`);
  });
}

test("extractCodeEdges smoke: python import_from", async () => {
  const edges = await edgesFor("python", `from token import verifyToken\n`, "a.py");
  const imp = edges.find((e) => e.kind === "imports");
  assert.equal(imp.source, "token");
});

// Fix 1: computed/subscript callee must NOT produce a calls edge
test("extractCodeEdges: computed subscript callee a[b]() yields no calls edge with refName b", async () => {
  const edges = await edgesFor("typescript", `a[b]();`);
  const bad = edges.find((e) => e.kind === "calls" && e.refName === "b");
  assert.equal(bad, undefined, "must not emit a calls edge for subscript index 'b'");
});

// Fix 2: multi-source imports emit one edge per source
test("extractCodeEdges: python 'import os, sys' yields two imports edges", async () => {
  const edges = await edgesFor("python", `import os, sys\n`, "a.py");
  const imps = edges.filter((e) => e.kind === "imports");
  const sources = imps.map((e) => e.source).sort();
  assert.deepEqual(sources, ["os", "sys"], `expected ['os','sys'], got ${JSON.stringify(sources)}`);
});

test("extractCodeEdges: go grouped import yields two imports edges", async () => {
  const edges = await edgesFor("go", `import (\n\t"fmt"\n\t"os"\n)\n`, "a.go");
  const imps = edges.filter((e) => e.kind === "imports");
  const sources = imps.map((e) => e.source).sort();
  assert.deepEqual(sources, ["fmt", "os"], `expected ['fmt','os'], got ${JSON.stringify(sources)}`);
});

// Fix 3: Rust use source must not be null
test("extractCodeEdges: rust 'use std::collections::HashMap' yields imports edge with source containing 'std'", async () => {
  const edges = await edgesFor("rust", `use std::collections::HashMap;\n`, "a.rs");
  const imp = edges.find((e) => e.kind === "imports");
  assert.ok(imp, `expected an imports edge, got ${JSON.stringify(edges)}`);
  assert.ok(
    imp.source && imp.source.startsWith("std"),
    `expected source starting with 'std', got ${JSON.stringify(imp.source)}`
  );
});

// Fix 4: Python from-import names should include imported names, not module name
test("extractCodeEdges: python 'from token import verifyToken, Session' yields names {verifyToken, Session}", async () => {
  const edges = await edgesFor("python", `from token import verifyToken, Session\n`, "a.py");
  const imp = edges.find((e) => e.kind === "imports" && e.source === "token");
  assert.ok(imp, `expected an imports edge with source 'token', got ${JSON.stringify(edges)}`);
  const names = [...imp.names].sort();
  assert.ok(names.includes("verifyToken"), `expected names to include 'verifyToken', got ${JSON.stringify(names)}`);
  assert.ok(names.includes("Session"), `expected names to include 'Session', got ${JSON.stringify(names)}`);
  assert.ok(!names.includes("token"), `names must NOT include the module 'token', got ${JSON.stringify(names)}`);
});

// Fix 2: existing single-import tests must still pass
test("extractCodeEdges: single TS import still works after Fix 2", async () => {
  const edges = await edgesFor("typescript", `import { verifyToken, Session } from "./token";`);
  const imp = edges.find((e) => e.kind === "imports");
  assert.ok(imp, "expected an imports edge");
  assert.equal(imp.source, "./token");
  assert.deepEqual([...imp.names].sort(), ["Session", "verifyToken"]);
});

test("extractCodeEdges: python from-import still works after Fix 2", async () => {
  const edges = await edgesFor("python", `from token import verifyToken\n`, "a.py");
  const imp = edges.find((e) => e.kind === "imports");
  assert.ok(imp, "expected an imports edge");
  assert.equal(imp.source, "token");
});
