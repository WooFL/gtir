import { test } from "node:test";
import assert from "node:assert/strict";
import { getParser } from "../src/parser.mjs";
import { extractCodeEdges, extractNotesEdges, resolveEdges, buildAdjacency, calleesOf } from "../src/edges.mjs";

const symIndex = new Map([
  ["verifyToken", [{ path: "src/auth/token.ts", line_start: 48, line_end: 79 }]],
  ["log", [
    { path: "src/a.ts", line_start: 1, line_end: 3 },
    { path: "src/b.ts", line_start: 1, line_end: 3 },
  ]],
]);

test("resolveEdges: unique same-file call resolves", () => {
  // Caller lives in the same file as the single candidate — a real intra-file call.
  const raw = [{ kind: "calls", refName: "verifyToken", fromPath: "src/auth/token.ts", fromLine: 90 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "resolved");
  assert.equal(e.to_path, "src/auth/token.ts");
  assert.equal(e.kind, "calls");
});

test("resolveEdges: cross-file unique name with no import is ambiguous, not resolved", () => {
  // The single candidate is in another file and no import vouches for it — a name coincidence
  // (e.g. a builtin `Error`, a method `.split`). Surface it as a guess, never a fact.
  const raw = [{ kind: "calls", refName: "verifyToken", fromPath: "src/x.ts", fromLine: 10 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "ambiguous");
  assert.deepEqual(e.candidates, ["src/auth/token.ts"]);
  assert.equal(e.to_path, null);
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
  assert.equal(e.ref_name, "Token Auth");
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

test("extractCodeEdges (cpp): a call in a free function is attributed to that function", async () => {
  // C++ function_definition keeps its name inside the `declarator` field, not as a direct child —
  // nodeName must reach it so the call is attributed to EffectRender, not the file (regression).
  const edges = await edgesFor("cpp", `void EffectRender() { SDK_Begin(); }`, "p.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "SDK_Begin");
  assert.ok(call, "expected a call edge to SDK_Begin");
  assert.equal(call.fromSymbol, "EffectRender");
});

test("extractCodeEdges (cpp): an out-of-class method call is attributed to the bare method name", async () => {
  // `Foo::m` lives in a qualified_identifier; from_symbol must be "m" (matching how the def is
  // keyed), not "Foo::m" — the BFS descends through the qualifier to the inner identifier.
  const edges = await edgesFor("cpp", `void Foo::m() { helper(); }`, "p.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "helper");
  assert.ok(call, "expected a call edge to helper");
  assert.equal(call.fromSymbol, "m");
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

test("resolveEdges: external call carries ref_name", () => {
  const raw = [{ kind: "calls", refName: "Error", fromPath: "src/x.ts", fromLine: 10, fromSymbol: "f" }];
  const [e] = resolveEdges(raw, new Map(), new Map());
  assert.equal(e.conf, "external");
  assert.equal(e.ref_name, "Error");
});

test("resolveEdges: ambiguous call carries ref_name", () => {
  const raw = [{ kind: "calls", refName: "verifyToken", fromPath: "src/x.ts", fromLine: 10 }];
  const [e] = resolveEdges(raw, symIndex, new Map());
  assert.equal(e.conf, "ambiguous");
  assert.equal(e.ref_name, "verifyToken");
});

test("resolveEdges: import carries ref_name = source", () => {
  const raw = [{ kind: "imports", source: "./util", fromPath: "src/x.ts", fromLine: 1, names: ["u"] }];
  const [e] = resolveEdges(raw, new Map(), new Map());
  assert.equal(e.ref_name, "./util");
});

test("extractNotesEdges ignores wikilinks inside code fences", () => {
  const md = "```\n[[NotALink]]\n```\n[[RealLink]]\n";
  const edges = extractNotesEdges("a.md", md);
  assert.ok(edges.some((e) => e.target === "RealLink"));
  assert.ok(!edges.some((e) => e.target === "NotALink"));
});

import { callersOf, neighborsOf } from "../src/edges.mjs";

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

test("resolveEdges rows carry a score field (null by default)", () => {
  const idx = new Map([["verifyToken", [{ path: "src/auth/token.ts", line_start: 48, line_end: 79 }]]]);
  const raw = [{ kind: "calls", refName: "verifyToken", fromPath: "src/mw.ts", fromLine: 12, fromSymbol: "mw" }];
  const [row] = resolveEdges(raw, idx, new Map());
  assert.ok("score" in row);
  assert.equal(row.score, null);
});

test("calleesOf surfaces score when an edge has one", () => {
  const adj = buildAdjacency([
    { kind: "calls", conf: "inferred", from_path: "a.ts", from_lines: "1", from_symbol: "f",
      to_path: "b.ts", to_lines: "10-20", to_symbol: "g", ref_name: "g", candidates: [], content_hash: "h", score: 0.71 },
  ]);
  const [callee] = calleesOf(adj, "f");
  assert.equal(callee.conf, "inferred");
  assert.equal(callee.score, 0.71);
});

test("extractCodeEdges marks isMethod for member calls, not bare calls", async () => {
  const edges = await edgesFor("typescript", `function a(){ obj.get(x); free(y); }`);
  const member = edges.find((e) => e.kind === "calls" && e.refName === "get");
  const bare = edges.find((e) => e.kind === "calls" && e.refName === "free");
  assert.equal(member.isMethod, true);
  assert.equal(bare.isMethod, false);
});

test("resolveEdges threads isMethod onto ambiguous calls rows", () => {
  const idx = new Map([["get", [
    { path: "a.ts", line_start: 1, line_end: 3 },
    { path: "b.ts", line_start: 1, line_end: 3 },
  ]]]);
  const raw = [{ kind: "calls", refName: "get", fromPath: "c.ts", fromLine: 5, fromSymbol: "f", isMethod: true }];
  const [r] = resolveEdges(raw, idx, new Map());
  assert.equal(r.conf, "ambiguous");
  assert.equal(r.isMethod, true);
});

test("extractCodeEdges (go): typed param → receiver + receiverType", async () => {
  const edges = await edgesFor("go", `package p\nfunc use(b *Batcher) { b.Flush() }`, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "Flush");
  assert.equal(call.isMethod, true);
  assert.equal(call.receiver, "b");
  assert.equal(call.receiverType, "Batcher");
});
test("extractCodeEdges (go): var decl → receiverType", async () => {
  const edges = await edgesFor("go", `package p\nfunc use() { var b Batcher; b.Flush() }`, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "Flush");
  assert.equal(call.receiverType, "Batcher");
});
test("extractCodeEdges (go): enclosing method receiver → receiverType", async () => {
  const edges = await edgesFor("go", `package p\nfunc (t *T) a() {}\nfunc (t *T) b() { t.a() }`, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "a");
  assert.equal(call.receiverType, "T");
});
test("extractCodeEdges (go): := binding → receiverType null (deferred)", async () => {
  const edges = await edgesFor("go", `package p\nfunc use() { b := make(); b.Flush() }`, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "Flush");
  assert.equal(call.receiverType, null);
});
test("extractCodeEdges (go): chained receiver a.b.M() → receiver null", async () => {
  const edges = await edgesFor("go", `package p\nfunc use(a *A) { a.b.M() }`, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "M");
  assert.equal(call.receiver, null);
  assert.equal(call.receiverType, null);
});
test("extractCodeEdges (non-go): receiverType stays null", async () => {
  const edges = await edgesFor("typescript", `function a(){ obj.get(x); }`);
  const call = edges.find((e) => e.kind === "calls" && e.refName === "get");
  assert.equal(call.receiverType, null);
});
test("resolveEdges threads receiverType onto ambiguous calls rows", () => {
  const idx = new Map([["Flush", [{ path: "a.go", line_start: 1, line_end: 3 }, { path: "b.go", line_start: 1, line_end: 3 }]]]);
  const raw = [{ kind: "calls", refName: "Flush", fromPath: "c.go", fromLine: 5, fromSymbol: "use", isMethod: true, receiver: "b", receiverType: "Batcher" }];
  const [r] = resolveEdges(raw, idx, new Map());
  assert.equal(r.conf, "ambiguous");
  assert.equal(r.receiverType, "Batcher");
});

test("extractCodeEdges (go): nested func-literal param does not shadow the outer receiver", async () => {
  const src = `package p\nfunc (c *Client) Do() { f := func(c *Counter) {}; _ = f; c.Send() }`;
  const edges = await edgesFor("go", src, "a.go");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "Send");
  assert.equal(call.receiverType, "Client"); // outer receiver, NOT the closure's *Counter
});

test("extractCodeEdges (cpp): typed pointer param → receiverType", async () => {
  const edges = await edgesFor("cpp", `void use(Foo* f) { f->bar(); }`, "a.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "bar");
  assert.equal(call.isMethod, true);
  assert.equal(call.receiver, "f");
  assert.equal(call.receiverType, "Foo");
});
test("extractCodeEdges (cpp): reference param → receiverType", async () => {
  const edges = await edgesFor("cpp", `void use(Foo& g) { g.bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): value local decl → receiverType", async () => {
  const edges = await edgesFor("cpp", `void use() { Foo h; h.bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): this-> → enclosing class (out-of-class def)", async () => {
  const edges = await edgesFor("cpp", `void Foo::m() { this->bar(); }`, "a.cpp");
  const call = edges.find((e) => e.refName === "bar");
  assert.equal(call.receiver, "this");
  assert.equal(call.receiverType, "Foo");
});
test("extractCodeEdges (cpp): auto receiver → receiverType null (deferred)", async () => {
  const edges = await edgesFor("cpp", `void use() { auto x = mk(); x->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});
test("extractCodeEdges (cpp): namespaced receiver type → null (deferred)", async () => {
  const edges = await edgesFor("cpp", `void use(std::string s) { s.size(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "size").receiverType, null);
});
test("extractCodeEdges (cpp): pointer-init local decl → receiverType", async () => {
  const edges = await edgesFor("cpp", `void use() { Foo* p = mk(); p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});

test("extractCodeEdges (cpp): namespaced out-of-class def this-> → null (deferred non-goal)", async () => {
  const edges = await edgesFor("cpp", `void Ns::Foo::m() { this->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});

test("extractCodeEdges (cpp): nested lambda param does not shadow the outer receiver", async () => {
  const src = `void use(Foo* f) { auto g = [](Bar* f) { f->inner(); }; (void)g; f->bar(); }`;
  const edges = await edgesFor("cpp", src, "a.cpp");
  const outer = edges.find((e) => e.kind === "calls" && e.refName === "bar");
  assert.equal(outer.receiverType, "Foo"); // outer f (Foo*), not shadowed by the lambda's Bar* f
});

test("extractCodeEdges (cpp): unique_ptr param → element type on ->", async () => {
  const edges = await edgesFor("cpp", `void use(std::unique_ptr<Foo> p) { p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): shared_ptr local → element type on ->", async () => {
  const edges = await edgesFor("cpp", `void use() { std::shared_ptr<Foo> p; p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): weak_ptr is in the default allowlist (third std smart pointer)", async () => {
  const edges = await edgesFor("cpp", `void use(std::weak_ptr<Foo> p) { p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): smart-ptr .method() is NOT unwrapped (wrapper's own)", async () => {
  const edges = await edgesFor("cpp", `void use(std::unique_ptr<Foo> p) { p.reset(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "reset").receiverType, null);
});
test("extractCodeEdges (cpp): non-allowlisted template (vector) → null", async () => {
  const edges = await edgesFor("cpp", `void use(std::vector<Foo> v) { v.push(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "push").receiverType, null);
});
test("extractCodeEdges (cpp): unique_ptr with namespaced element → null", async () => {
  const edges = await edgesFor("cpp", `void use(std::unique_ptr<ns::Foo> p) { p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});
test("extractCodeEdges (cpp): multi-arg unique_ptr<Foo,Del> → first arg Foo on ->", async () => {
  const edges = await edgesFor("cpp", `void use(std::unique_ptr<Foo, Del> p) { p->bar(); }`, "a.cpp");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});

test("extractCodeEdges (cpp): custom wrapper in cppSmartPointers unwraps on ->", async () => {
  const parser = await getParser("cpp");
  const tree = parser.parse(`void use(MyScoper<Foo> h) { h->bar(); }`);
  const edges = extractCodeEdges(tree, "cpp", "a.cpp", { cppSmartPointers: ["MyScoper"] });
  assert.equal(edges.find((e) => e.kind === "calls" && e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (cpp): a wrapper NOT in the allowlist → null", async () => {
  const parser = await getParser("cpp");
  const tree = parser.parse(`void use(MyScoper<Foo> h) { h->bar(); }`);
  const edges = extractCodeEdges(tree, "cpp", "a.cpp", {}); // default allowlist; MyScoper not in it
  assert.equal(edges.find((e) => e.kind === "calls" && e.refName === "bar").receiverType, null);
});

test("inferCppFactory: auto local from a free-function call sets receiverFactory", async () => {
  const edges = await edgesFor("cpp", `void use(){ auto w = makeWidget(); w.run(); }`, "a.cpp");
  const call = edges.find((e) => e.refName === "run");
  assert.equal(call.receiverFactory, "makeWidget");
  assert.equal(call.receiverType, null);
});
test("inferCppFactory: member-call factory is not captured", async () => {
  const edges = await edgesFor("cpp", `void use(){ auto x = obj.make(); x.run(); }`, "a.cpp");
  const call = edges.find((e) => e.refName === "run");
  assert.equal(call.receiverFactory, null);
});
test("inferCppFactory: qualified factory is not captured", async () => {
  const edges = await edgesFor("cpp", `void use(){ auto x = ns::make(); x.run(); }`, "a.cpp");
  const call = edges.find((e) => e.refName === "run");
  assert.equal(call.receiverFactory, null);
});
test("inferCppFactory: a typed local sets receiverType, not receiverFactory", async () => {
  const edges = await edgesFor("cpp", `void use(){ Foo x; x.run(); }`, "a.cpp");
  const call = edges.find((e) => e.refName === "run");
  assert.equal(call.receiverType, "Foo");
  assert.equal(call.receiverFactory, null);
});

test("extractCodeEdges (ts): typed param → receiverType", async () => {
  const edges = await edgesFor("typescript", `function run(e: Encoder) { e.flush(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, "Encoder");
});
test("extractCodeEdges (ts): typed local → receiverType", async () => {
  const edges = await edgesFor("typescript", `function run() { const x: Foo = mk(); x.bar(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, "Foo");
});
test("extractCodeEdges (ts): new-assigned local → constructor type", async () => {
  const edges = await edgesFor("typescript", `function run() { const s = new Sink(); s.flush(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, "Sink");
});
test("extractCodeEdges (js): new-assigned local works without types", async () => {
  const edges = await edgesFor("javascript", `function run() { const s = new Sink(); s.flush(); }`, "a.js");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, "Sink");
});
test("extractCodeEdges (ts): this.method() → enclosing class", async () => {
  const edges = await edgesFor("typescript", `class C { drive() { this.flush(); } flush(){} }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, "C");
});
test("extractCodeEdges (ts): generic-typed receiver → null", async () => {
  const edges = await edgesFor("typescript", `function run(x: Foo<T>) { x.bar(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});
test("extractCodeEdges (ts): union-typed receiver → null", async () => {
  const edges = await edgesFor("typescript", `function run(x: A | B) { x.m(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "m").receiverType, null);
});
test("extractCodeEdges (ts): predefined-typed receiver → null", async () => {
  const edges = await edgesFor("typescript", `function run(x: string) { x.trim(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "trim").receiverType, null);
});
test("extractCodeEdges (ts): new ns.X() member constructor → null", async () => {
  const edges = await edgesFor("typescript", `function run() { const x = new ns.Foo(); x.bar(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});
test("extractCodeEdges (ts): untyped non-new local → null", async () => {
  const edges = await edgesFor("typescript", `function run() { const x = mk(); x.bar(); }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "bar").receiverType, null);
});

test("extractCodeEdges (ts): this in a nested regular function → null (this is rebound)", async () => {
  const edges = await edgesFor("typescript", `class C { drive() { function inner() { this.flush(); } } }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, null);
});

test("extractCodeEdges (ts): this in a nested arrow still → enclosing class (lexical this)", async () => {
  const edges = await edgesFor("typescript", `class C { drive() { const f = () => { this.flush(); }; f(); } flush(){} }`, "a.ts");
  assert.equal(edges.find((e) => e.refName === "flush").receiverType, "C");
});

test("extractCodeEdges (cpp): a bare member field resolves its declared type (inline method)", async () => {
  const edges = await edgesFor("cpp", `class C { Widget* m_w; void run(){ m_w->go(); } };`, "c.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "go");
  assert.ok(call, "expected a go() call edge");
  assert.equal(call.receiverType, "Widget");
});
test("extractCodeEdges (cpp): a smart-pointer member field unwraps on -> (inline method)", async () => {
  const edges = await edgesFor("cpp", `class C { std::shared_ptr<Foo> m_f; void run(){ m_f->tick(); } };`, "c.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "tick");
  assert.equal(call.receiverType, "Foo");
});
test("extractCodeEdges (cpp): a local variable shadows a same-named field", async () => {
  const edges = await edgesFor("cpp", `class C { Widget* x; void run(){ Gadget* x; x->go(); } };`, "c.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "go");
  assert.equal(call.receiverType, "Gadget");   // local x (Gadget) wins over field x (Widget)
});
test("extractCodeEdges (cpp): a non-field bare receiver stays unresolved", async () => {
  const edges = await edgesFor("cpp", `class C { void run(){ unknownThing->go(); } };`, "c.cpp");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "go");
  assert.equal(call.receiverType, null);
});

test("extractCodeEdges (ts): this.field.method() resolves the field's declared type", async () => {
  const edges = await edgesFor("typescript", `class A { svc: Svc; m(){ this.svc.do(); } }`, "a.ts");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "do");
  assert.ok(call, "expected a do() call edge");
  assert.equal(call.receiverType, "Svc");
});
test("extractCodeEdges (ts): a new-initialized field infers its constructor type", async () => {
  const edges = await edgesFor("typescript", `class A { svc = new Svc(); m(){ this.svc.do(); } }`, "a.ts");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "do");
  assert.equal(call.receiverType, "Svc");
});
test("extractCodeEdges (ts): this.method() (not a field chain) is unaffected", async () => {
  const edges = await edgesFor("typescript", `class A { m(){ this.helper(); } helper(){} }`, "a.ts");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "helper");
  assert.equal(call.receiverType, "A");   // existing `this` path → enclosing class
});
test("extractCodeEdges (ts): this.field where field has no known type → null", async () => {
  const edges = await edgesFor("typescript", `class A { svc; m(){ this.svc.do(); } }`, "a.ts");
  const call = edges.find((e) => e.kind === "calls" && e.refName === "do");
  assert.equal(call.receiverType, null);
});
