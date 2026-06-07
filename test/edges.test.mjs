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
