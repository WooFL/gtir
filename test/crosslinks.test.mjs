import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";

test("crossLinkCap default exists", () => {
  assert.equal(DEFAULTS.crossLinkCap, 15);
});

import { crossLinks } from "../src/crosslinks.mjs";

// A fake code inventory: byName maps a defined symbol to its def site(s).
const inv = {
  byName: new Map([
    ["NodeTypeRegistry", [{ name: "NodeTypeRegistry", path: "packages/engine-core/src/node/registry.ts", line_start: 10, line_end: 40, text: "export class NodeTypeRegistry {\n  register() {}\n}" }]],
    ["fuseRRF", [{ name: "fuseRRF", path: "src/search.mjs", line_start: 58, line_end: 78, text: "export function fuseRRF(...) {}" }]],
  ]),
};
const files = new Set(["packages/engine-core/src/node/registry.ts", "src/search.mjs", "apps/web/main.ts"]);

test("crossLinks resolves real symbols + paths, ignores prose decoys", () => {
  const note = `This note discusses NodeTypeRegistry and the fuseRRF helper.
It references packages/engine-core/src/node/registry.ts directly.
It also mentions React, ADR-0004, Three.js, and Something — none of which are defined symbols.`;
  const links = crossLinks(inv, files, note, { cap: 15 });
  const syms = links.filter((l) => l.kind === "symbol").map((l) => l.symbol).sort();
  assert.deepEqual(syms, ["NodeTypeRegistry", "fuseRRF"]);
  assert.ok(links.some((l) => l.kind === "file" && l.path === "packages/engine-core/src/node/registry.ts"));
  assert.ok(!links.some((l) => l.symbol === "React" || l.symbol === "Something"));
  const reg = links.find((l) => l.symbol === "NodeTypeRegistry");
  assert.match(reg.snippet, /NodeTypeRegistry/);
  assert.equal(reg.lines, "10-40");
});

test("crossLinks respects the cap and dedups", () => {
  const note = "fuseRRF fuseRRF fuseRRF NodeTypeRegistry";
  const links = crossLinks(inv, files, note, { cap: 1 });
  assert.equal(links.length, 1);
});

import { before as _before, after as _after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex, indexEdges } from "../src/indexer.mjs";
import { codeLinksFor } from "../src/crosslinks.mjs";

const DIM = 16;
const evec = (t) => { const v = Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 5; return v; };
let _realFetch;
_before(() => {
  _realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/embed") {
      const input = JSON.parse(opts.body || "{}").input;
      const arr = Array.isArray(input) ? input : [input];
      return { ok: true, status: 200, json: async () => ({ embeddings: arr.map(evec) }), text: async () => "" };
    }
    if (u.pathname === "/api/version") return { ok: true, status: 200, json: async () => ({ version: "stub" }), text: async () => "" };
    if (u.pathname === "/api/tags") return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
});
_after(() => { globalThis.fetch = _realFetch; });

function codeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-xcode-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "registry.ts"),
    "export class WidgetRegistry {\n" +
    "  // Registers widgets for the demo runtime described in the wiki notes here.\n" +
    "  register(): void {}\n}\n");
  return repo;
}
function wikiRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-xwiki-"));
  writeFileSync(join(repo, "design.md"),
    "# Design\n\nThis note explains how WidgetRegistry works and references src/registry.ts.\n" +
    "It also name-drops React and ADR-0001, which are not code symbols.\n");
  return repo;
}

test("codeLinksFor resolves a note's code references against the code index", async () => {
  const code = codeRepo(), wiki = wikiRepo();
  const codeCfg = { ...loadConfig(code), model: "qwen3-embedding:0.6b", ollamaUrl: "http://localhost:11434" };
  const wikiCfg = { ...loadConfig(wiki), model: "nomic-embed-text", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(codeCfg, { rebuild: true }); await indexEdges(codeCfg, { rebuild: true, collect: false });
    await buildIndex(wikiCfg, { rebuild: true });
    const links = await codeLinksFor(wikiCfg, codeCfg, "design.md");
    assert.ok(links.some((l) => l.kind === "symbol" && l.symbol === "WidgetRegistry" && /registry\.ts$/.test(l.path)), "WidgetRegistry linked");
    assert.ok(links.some((l) => l.kind === "file" && /registry\.ts$/.test(l.path)), "src/registry.ts path linked");
    assert.ok(!links.some((l) => l.symbol === "React"), "prose 'React' not linked");
  } finally {
    rmSync(code, { recursive: true, force: true }); rmSync(wiki, { recursive: true, force: true });
  }
});

import { augmentGraphWithCode } from "../src/crosslinks.mjs";

test("augmentGraphWithCode adds code nodes + center->code edges", () => {
  const graph = { center: "a.md", nodes: [{ path: "a.md", label: "a", group: "", weight: 1, center: true }], edges: [] };
  const codeLinks = [
    { kind: "symbol", symbol: "WidgetRegistry", path: "src/registry.ts", lines: "10-40", snippet: "class WidgetRegistry" },
    { kind: "file", path: "src/util.ts", snippet: "" },
  ];
  const g = augmentGraphWithCode(graph, codeLinks);
  const codeNodes = g.nodes.filter((n) => n.kind === "code");
  assert.equal(codeNodes.length, 2);
  assert.ok(codeNodes.some((n) => n.label === "WidgetRegistry" && n.codePath === "src/registry.ts"));
  assert.ok(g.edges.some((e) => e.from === "a.md" && e.kind === "code"));
  assert.ok(g.nodes.some((n) => n.path === "a.md" && n.center));
});

test("augmentGraphWithCode with no links returns the graph unchanged", () => {
  const graph = { center: "a.md", nodes: [{ path: "a.md", label: "a", group: "", weight: 1, center: true }], edges: [] };
  assert.equal(augmentGraphWithCode(graph, []).nodes.length, 1);
});

import { invertLinks, notesFor } from "../src/crosslinks.mjs";

test("invertLinks: symbol rows fill bySymbol+byPath; file rows byPath only; dedup per note", () => {
  const { bySymbol, byPath } = invertLinks({
    "n1.md": [{ kind: "symbol", symbol: "foo", path: "a.ts", lines: "1-3", snippet: "fn foo" }],
    "n2.md": [{ kind: "symbol", symbol: "foo", path: "a.ts", lines: "1-3" },
              { kind: "file", path: "a.ts" }],
  });
  assert.deepEqual(bySymbol.get("foo").map((r) => r.note).sort(), ["n1.md", "n2.md"]);
  assert.equal(byPath.get("a.ts").length, 2);     // n1 (via symbol's path) + n2 (file row)
  assert.equal(bySymbol.has("a.ts"), false);       // a file row never lands in bySymbol
  assert.equal(bySymbol.get("foo")[0].lines, "1-3");
});

test("notesFor: union of symbol + path matches, deduped per note, capped", () => {
  const rev = invertLinks({
    "n1.md": [{ kind: "symbol", symbol: "foo", path: "a.ts", lines: "1-3" }],
    "n2.md": [{ kind: "file", path: "a.ts" }],
  });
  assert.deepEqual(notesFor(rev, { symbol: "foo", path: "a.ts" }).map((n) => n.note).sort(), ["n1.md", "n2.md"]);
  assert.equal(notesFor(rev, { symbol: "foo", path: "a.ts" }, 1).length, 1);                 // cap
  assert.equal(notesFor(rev, { symbol: "foo", path: "a.ts" }).filter((n) => n.note === "n1.md").length, 1); // n1 once, not twice
  assert.deepEqual(notesFor(rev, {}), []);          // no keys -> empty
});

import { reverseLinks, clearReverseCache } from "../src/crosslinks.mjs";

test("reverseLinks inverts an existing stale baseline without opening a store", async () => {
  const wiki = mkdtempSync(join(tmpdir(), "gtir-rev-"));
  mkdirSync(join(wiki, ".gtir"), { recursive: true });
  writeFileSync(join(wiki, ".gtir", "stale-baselines.json"), JSON.stringify({
    links: {
      "design.md": [{ kind: "symbol", symbol: "WidgetRegistry", path: "src/registry.ts", lines: "1-4", snippet: "class WidgetRegistry" }],
    },
  }));
  const wikiCfg = { ...loadConfig(wiki), model: "nomic-embed-text" };
  const codeCfg = { ...loadConfig(wiki), indexDir: "/nonexistent/code.lance" }; // distinct cache key; never opened
  try {
    clearReverseCache();
    const rev = await reverseLinks(wikiCfg, codeCfg);
    assert.deepEqual(rev.bySymbol.get("WidgetRegistry").map((r) => r.note), ["design.md"]);
    assert.ok(rev.byPath.get("src/registry.ts"), "path indexed too");
  } finally { rmSync(wiki, { recursive: true, force: true }); }
});

test("reverseLinks falls back to live crossLinks when no baseline; caches; clears", async () => {
  const code = codeRepo(), wiki = wikiRepo();
  const codeCfg = { ...loadConfig(code), model: "qwen3-embedding:0.6b", ollamaUrl: "http://localhost:11434" };
  const wikiCfg = { ...loadConfig(wiki), model: "nomic-embed-text", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(codeCfg, { rebuild: true }); await indexEdges(codeCfg, { rebuild: true, collect: false });
    await buildIndex(wikiCfg, { rebuild: true });
    clearReverseCache();
    const rev = await reverseLinks(wikiCfg, codeCfg);
    assert.ok(rev.bySymbol.get("WidgetRegistry"), "WidgetRegistry inverted from live note->code links");
    assert.equal(await reverseLinks(wikiCfg, codeCfg), rev, "cached: same object");
    clearReverseCache();
    assert.notEqual(await reverseLinks(wikiCfg, codeCfg), rev, "rebuilt after clear");
  } finally { rmSync(code, { recursive: true, force: true }); rmSync(wiki, { recursive: true, force: true }); }
});

test("reverseLinks baselineOnly: no baseline => empty maps, never opens the wiki store", async () => {
  // Fake cfgs whose indexDir would make openStore throw if the live fallback were taken.
  const wikiCfg = { gtirDir: "/no/such/.gtir", indexDir: "/no/such/wiki.lance" };
  const codeCfg = { indexDir: "/no/such/code.lance" };
  clearReverseCache();
  const rev = await reverseLinks(wikiCfg, codeCfg, { baselineOnly: true, deps: { readBaseline: () => null } });
  assert.equal(rev.bySymbol.size, 0);
  assert.equal(rev.byPath.size, 0);
  // The empty result must NOT be cached: a subsequent call (without baselineOnly) should
  // get a different object, not the same cached empty one.
  const rev2 = await reverseLinks(wikiCfg, codeCfg, { deps: { readBaseline: () => null } });
  assert.notEqual(rev2, rev, "baselineOnly result must not be cached");
});

import { codeStructure } from "../src/crosslinks.mjs";
import { clearGraphCache } from "../src/graph-queries.mjs";

test("codeStructure keeps call edges only between two shown symbols", async () => {
  // foo() calls bar() and qux(); bar() calls baz(). Mirrors the codeRepo()/loadConfig harness
  // already used by the codeLinksFor test above (loadConfig takes a repo PATH; fetch is stubbed
  // in the _before block, so buildIndex/indexEdges run offline).
  const repo = mkdtempSync(join(tmpdir(), "gtir-cs-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "m.ts"),
    "export function bar(){ return baz(); }\n" +
    "export function baz(){ return 1; }\n" +
    "export function qux(){ return 2; }\n" +
    "export function foo(){ return bar() + qux(); }\n");
  const cfg = { ...loadConfig(repo), model: "qwen3-embedding:0.6b", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(cfg, { rebuild: true });
    await indexEdges(cfg, { rebuild: true, collect: false });
    clearGraphCache(cfg.indexDir);
    // Shown = foo, bar (NOT qux, NOT baz). foo->bar survives; foo->qux dropped (qux not shown);
    // bar->baz dropped (baz not shown).
    const shown = [
      { kind: "symbol", symbol: "foo", path: "src/m.ts" },
      { kind: "symbol", symbol: "bar", path: "src/m.ts" },
    ];
    const { callEdges } = await codeStructure(cfg, shown);
    assert.equal(callEdges.length, 1);
    assert.deepEqual(callEdges[0], { fromPath: "src/m.ts", fromSymbol: "foo", toPath: "src/m.ts", toSymbol: "bar" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("codeStructure returns no edges when fewer than 2 symbols are shown", async () => {
  const { callEdges } = await codeStructure({ indexDir: "unused" }, [{ kind: "symbol", symbol: "x", path: "a.ts" }]);
  assert.deepEqual(callEdges, []);
});

import { makeHandlers } from "../src/serve.mjs";

test("serve makeHandlers augments /connections + /graph with code when linkCfg is set", async () => {
  const code = codeRepo(), wiki = wikiRepo();
  const codeCfg = { ...loadConfig(code), model: "qwen3-embedding:0.6b", ollamaUrl: "http://localhost:11434" };
  const wikiCfg = { ...loadConfig(wiki), model: "nomic-embed-text", ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(codeCfg, { rebuild: true }); await indexEdges(codeCfg, { rebuild: true, collect: false });
    await buildIndex(wikiCfg, { rebuild: true }); await indexEdges(wikiCfg, { rebuild: true, collect: false });

    const handlers = makeHandlers(wikiCfg, { linkCfg: codeCfg });
    const conn = await handlers["/connections"]({ path: "design.md" });
    assert.ok(Array.isArray(conn.code), "/connections has a code array");
    assert.ok(conn.code.some((l) => l.symbol === "WidgetRegistry"), "WidgetRegistry in code links");

    const g = await handlers["/graph"]({ path: "design.md" });
    assert.ok(g.nodes.some((n) => n.kind === "code"), "/graph has a code node");

    // /health advertises whether a code index is linked (the plugin uses this to avoid adopting a non-linked daemon)
    assert.equal((await handlers["/health"]()).linked, true);

    const plain = makeHandlers(wikiCfg, {});
    const conn2 = await plain["/connections"]({ path: "design.md" });
    assert.equal(conn2.code, undefined);
    assert.equal((await plain["/health"]()).linked, false);
  } finally {
    rmSync(code, { recursive: true, force: true }); rmSync(wiki, { recursive: true, force: true });
  }
});
