import { test } from "node:test";
import assert from "node:assert/strict";
import { getParser } from "../src/parser.mjs";
import { extractCodeEdges, extractNotesEdges, resolveEdges } from "../src/edges.mjs";

const symIndex = new Map([
  ["verifyToken", [{ path: "src/auth/token.ts", line_start: 48, line_end: 79 }]],
  ["log", [
    { path: "src/a.ts", line_start: 1, line_end: 3 },
    { path: "src/b.ts", line_start: 1, line_end: 3 },
  ]],
]);

test("resolveEdges: unique call name resolves", () => {
  const raw = [{ kind: "calls", refName: "verifyToken", fromPath: "src/x.ts", fromLine: 10 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "resolved");
  assert.equal(e.to_path, "src/auth/token.ts");
  assert.equal(e.from_path, "src/x.ts");
  assert.equal(e.kind, "calls");
});

test("resolveEdges: import scoping disambiguates a duplicate name", () => {
  const raw = [
    { kind: "imports", source: "./b", names: new Set(["log"]), fromPath: "src/x.ts", fromLine: 1 },
    { kind: "calls", refName: "log", fromPath: "src/x.ts", fromLine: 5 },
  ];
  const resolved = resolveEdges(raw, symIndex, new Map());
  const call = resolved.find((e) => e.kind === "calls");
  assert.equal(call.conf, "resolved");
  assert.equal(call.to_path, "src/b.ts");
});

test("resolveEdges: duplicate name with no import is ambiguous", () => {
  const raw = [{ kind: "calls", refName: "log", fromPath: "src/x.ts", fromLine: 5 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "ambiguous");
  assert.deepEqual([...e.candidates].sort(), ["src/a.ts", "src/b.ts"]);
});

test("resolveEdges: unknown call name is external", () => {
  const raw = [{ kind: "calls", refName: "lodashMap", fromPath: "src/x.ts", fromLine: 5 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "external");
  assert.equal(e.to_path, null);
});

test("resolveEdges: note link resolves via noteIndex", () => {
  const notes = new Map([["token auth", [{ path: "wiki/Token Auth.md" }]]]);
  const raw = [{ kind: "links", target: "Token Auth", fromPath: "wiki/a.md", fromLine: 2 }];
  const [e] = resolveEdges(raw, new Map(), notes);
  assert.equal(e.conf, "resolved");
  assert.equal(e.to_path, "wiki/Token Auth.md");
});

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

// Part 1 — fromSymbol: enclosing scope capture
test("extractCodeEdges records the enclosing function as fromSymbol", async () => {
  const edges = await edgesFor("typescript",
    `function outer(x){ return helper(x); }`);
  const call = edges.find((e) => e.kind === "calls" && e.refName === "helper");
  assert.equal(call.fromSymbol, "outer");
});

test("extractCodeEdges fromSymbol is null for a top-level call", async () => {
  const edges = await edgesFor("typescript", `helper(x);`);
  const call = edges.find((e) => e.kind === "calls" && e.refName === "helper");
  assert.equal(call.fromSymbol, null);
});

// Part 2 — resolveEdges uses fromSymbol
test("resolveEdges populates from_symbol for calls (enables calleesOf)", () => {
  const sym = new Map([["helper", [{ path: "h.ts", line_start: 1, line_end: 2 }]]]);
  const raw = [{ kind: "calls", refName: "helper", fromPath: "a.ts", fromLine: 3, fromSymbol: "outer" }];
  const [e] = resolveEdges(raw, sym, new Map());
  assert.equal(e.from_symbol, "outer");
});

test("extractNotesEdges captures wikilinks and embeds", () => {
  const md = `See [[Token Auth]] and [[Sessions#expiry|here]].\n![[diagram.png]]\n`;
  const edges = extractNotesEdges("notes/a.md", md);
  assert.ok(edges.some((e) => e.kind === "links" && e.target === "Token Auth"));
  assert.ok(edges.some((e) => e.kind === "links" && e.target === "Sessions"));
  assert.ok(edges.some((e) => e.kind === "embeds" && e.target === "diagram.png"));
  assert.equal(edges[0].fromPath, "notes/a.md");
});

test("extractNotesEdges ignores wikilinks inside code fences", () => {
  const md = "```\n[[NotALink]]\n```\n[[RealLink]]\n";
  const edges = extractNotesEdges("a.md", md);
  assert.ok(edges.some((e) => e.target === "RealLink"));
  assert.ok(!edges.some((e) => e.target === "NotALink"));
});

import { buildAdjacency, callersOf, calleesOf, neighborsOf } from "../src/edges.mjs";

const rows = [
  { kind: "calls", conf: "resolved", from_path: "mw.ts", from_lines: "12", from_symbol: null,
    to_path: "token.ts", to_lines: "48-79", to_symbol: "verifyToken", candidates: [] },
  { kind: "calls", conf: "resolved", from_path: "login.ts", from_lines: "40", from_symbol: null,
    to_path: "token.ts", to_lines: "48-79", to_symbol: "verifyToken", candidates: [] },
  { kind: "calls", conf: "resolved", from_path: "token.ts", from_lines: "50", from_symbol: "verifyToken",
    to_path: "jwt.ts", to_lines: "5-9", to_symbol: "decode", candidates: [] },
];

test("callersOf returns spans that call the symbol", () => {
  const adj = buildAdjacency(rows);
  const callers = callersOf(adj, "verifyToken");
  assert.equal(callers.length, 2);
  assert.ok(callers.some((c) => c.path === "mw.ts" && c.lines === "12"));
  assert.equal(callers[0].conf, "resolved");
});

test("calleesOf returns what the symbol calls", () => {
  const adj = buildAdjacency(rows);
  const callees = calleesOf(adj, "verifyToken");
  assert.ok(callees.some((c) => c.symbol === "decode" && c.path === "jwt.ts"));
});

test("neighborsOf folds in derived siblings from the chunk list", () => {
  const adj = buildAdjacency(rows);
  const siblings = [
    { line_start: 48, line_end: 79, signature: "verifyToken()" },
    { line_start: 80, line_end: 92, signature: "refreshToken()" },
  ];
  const out = neighborsOf(adj, { symbol: "verifyToken", path: "token.ts", lines: "48-79", siblings });
  assert.ok(out.callers.length === 2);
  assert.ok(out.callees.some((c) => c.symbol === "decode"));
  assert.ok(out.siblings.some((s) => s.signature === "refreshToken()"));
  assert.ok(!out.siblings.some((s) => s.signature === "verifyToken()")); // self excluded
});
