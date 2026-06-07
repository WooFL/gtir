import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF, isSymbolQuery, search } from "../src/search.mjs";

test("isSymbolQuery: a single bare identifier is symbol-like; multi-word/NL queries are not", () => {
  assert.equal(isSymbolQuery("fetchWithRetry"), true);
  assert.equal(isSymbolQuery("LRUCache"), true);
  assert.equal(isSymbolQuery("grid_shortest_path"), true);
  assert.equal(isSymbolQuery("  slugify  "), true);                 // trimmed
  assert.equal(isSymbolQuery("how do I verify a JWT"), false);
  assert.equal(isSymbolQuery("verify token"), false);                // two tokens
  assert.equal(isSymbolQuery(""), false);
});

import { hasIdentifierToken, queryIdentifiers } from "../src/search.mjs";

test("hasIdentifierToken: identifier-shaped tokens yes; plain words and bare acronyms no", () => {
  assert.equal(hasIdentifierToken("how does fetchWithRetry back off"), true);      // camelCase
  assert.equal(hasIdentifierToken("how does grid_shortest_path route"), true);     // snake_case
  assert.equal(hasIdentifierToken("how does LRUCache evict"), true);               // acronym+word
  assert.equal(hasIdentifierToken("evict the least recently used entry"), false);  // plain English
  assert.equal(hasIdentifierToken("how do I verify a JWT"), false);                // bare acronym is not an identifier
  assert.equal(hasIdentifierToken("split text into word tokens"), false);
});

test("queryIdentifiers returns the identifier-shaped tokens only", () => {
  assert.deepEqual(queryIdentifiers("how does PeerThrottleStrategy admit a request"), ["PeerThrottleStrategy"]);
  assert.deepEqual(queryIdentifiers("compare LRUCache and LFUCache"), ["LRUCache", "LFUCache"]);
  assert.deepEqual(queryIdentifiers("a plain english query"), []);
});

test("fuseRRF ranks a doc appearing in both branches above single-branch docs", () => {
  const vec = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "y", path: "y.py", line_start: 1, line_end: 2, language: "python", text: "y" }];
  const fts = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "z", path: "z.py", line_start: 1, line_end: 2, language: "python", text: "z" }];
  const ranked = fuseRRF(vec, fts, 5);
  assert.equal(ranked[0].path, "x.py");          // in both branches → top
  assert.equal(typeof ranked[0].score, "number");
  assert.ok(ranked[0].vec_rank === 1 && ranked[0].fts_rank === 1);
});

test("fuseRRF ftsWeight scales the BM25 branch (1 = classic RRF, 0 = vector-only order)", () => {
  const vec = [{ id: "a", path: "a.ts", line_start: 1, line_end: 2, language: "ts", text: "a" },
               { id: "b", path: "b.ts", line_start: 1, line_end: 2, language: "ts", text: "b" }];
  const fts = [{ id: "b", path: "b.ts", line_start: 1, line_end: 2, language: "ts", text: "b" }]; // b also ranks #1 in BM25
  assert.equal(fuseRRF(vec, fts, 5, 1)[0].path, "b.ts");   // BM25 lifts b above the vector-#1 a
  assert.equal(fuseRRF(vec, fts, 5, 0)[0].path, "a.ts");   // BM25 ignored → vector order (a first)
});

import { applyRerank, pathPrior, isNotesMode } from "../src/search.mjs";

const F = (p) => ({ path: p, snippet: p, score: 0 });

test("pathPrior demotes test files in code mode, leaves source untouched", () => {
  const cfg = { model: "jina-code", testPenalty: 0.5 };
  assert.equal(pathPrior("src/config.mjs", "default config values", cfg), 1);          // source
  assert.equal(pathPrior("test/config.test.mjs", "default config values", cfg), 0.5);  // *.test.mjs
  assert.equal(pathPrior("tests/foo_test.py", "load the manifest", cfg), 0.5);         // test dir + _test.py
  assert.equal(pathPrior("pkg/retry_test.go", "retry with backoff", cfg), 0.5);        // go _test.go
  assert.equal(pathPrior("spec/parser.spec.ts", "parse the tree", cfg), 0.5);          // spec dir + .spec.
});

test("pathPrior leaves tests alone when the query is itself test-seeking", () => {
  const cfg = { model: "jina-code", testPenalty: 0.5 };
  assert.equal(pathPrior("http/retry.test.ts", "test that a retry succeeds after a 503", cfg), 1);
  assert.equal(pathPrior("test/x.spec.ts", "the spec for the parser", cfg), 1);
  assert.equal(pathPrior("test/x.test.ts", "where are the mocks", cfg), 1);
});

test("pathPrior is disabled in notes mode (.md is the target there)", () => {
  const notes = { model: "nomic-embed-text", testPenalty: 0.5 };
  assert.equal(pathPrior("test/whatever.test.mjs", "anything", notes), 1);
  assert.equal(isNotesMode(notes), true);
  assert.equal(isNotesMode({ model: "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16" }), false);
});

test("fuseRRF applies the path prior, sinking a penalized test below a same-rank source", () => {
  const vec = [{ id: "t", path: "x.test.ts", line_start: 1, line_end: 2, language: "ts", text: "t" },
               { id: "s", path: "x.ts", line_start: 1, line_end: 2, language: "ts", text: "s" }];
  const priorOf = (p) => (/\.test\./.test(p) ? 0.5 : 1);
  const ranked = fuseRRF(vec, [], 5, 0, priorOf);
  assert.equal(ranked[0].path, "x.ts");          // source (vec #2) lifted above the penalized test (vec #1)
  assert.equal(ranked.find((r) => r.path === "x.test.ts").prior, 0.5);
});

test("applyRerank reorders fused by reranker indices and slices to k", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
  const out = applyRerank(fused, ranked, 2);
  assert.deepEqual(out.map((r) => r.path), ["c", "a"]);
  assert.equal(out[0].rerank_score, 0.9);
});

test("applyRerank falls back to RRF order when ranked is null or empty", () => {
  const fused = [F("a"), F("b")];
  assert.deepEqual(applyRerank(fused, null, 5).map((r) => r.path), ["a", "b"]);
  assert.deepEqual(applyRerank(fused, [], 5).map((r) => r.path), ["a", "b"]);
});

test("applyRerank appends fused rows the reranker omitted, preserving RRF order", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 1, score: 0.9 }];          // only b came back
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["b", "a", "c"]);
});

test("applyRerank ignores out-of-range indices from the server", () => {
  const fused = [F("a"), F("b")];
  const ranked = [{ index: 9, score: 0.9 }, { index: 0, score: 0.5 }];
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["a", "b"]);  // index 9 dropped; b appended
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { graphForSearch } from "../src/graph-queries.mjs";

// Deterministic fake embedder: both chunks embed identically to the query so vector ranks tie,
// letting the centrality multiplier decide order.
const fakeEmbed = (texts) => Promise.resolve(texts.map(() => [1, 0, 0]));

function seedCfg() {
  const dir = mkdtempSync(join(tmpdir(), "gtir-search-gq-"));
  return { indexDir: join(dir, ".gtir"), model: "qwen3", embedImpl: fakeEmbed,
    ftsWeight: 0, ftsWeightSymbol: 0, ftsWeightMixed: 0, testPenalty: 1,
    centralityWeight: 0.15, centralityK: 8, contextCap: 5, _root: dir };
}

test("search: --edges attaches callers/callees; --centrality annotates high-degree hits", async () => {
  const cfg = seedCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      { id: "1", path: "hub.mjs", line_start: 1, line_end: 3, language: "js", text: "function hub(){}", embedding: [1, 0, 0], mtime_ms: 1, content_hash: "h1" },
      { id: "2", path: "leaf.mjs", line_start: 1, line_end: 3, language: "js", text: "function leaf(){}", embedding: [1, 0, 0], mtime_ms: 1, content_hash: "h2" },
    ]);
    // Many callers of hub() -> high degree; leaf has none.
    const callHub = (i) => ({ kind: "calls", conf: "resolved", from_path: `c${i}.mjs`, from_lines: "1", from_symbol: `f${i}`, to_path: "hub.mjs", to_lines: "1", to_symbol: "hub", candidates: [], content_hash: "h" });
    await store.upsertEdges([0, 1, 2, 3, 4].map(callHub));
    const graphData = await graphForSearch(cfg);

    const ctx = await search("hub leaf", cfg, { k: 5, edges: true, graphData });
    const hubHit = ctx.find((h) => h.path === "hub.mjs");
    assert.ok(hubHit.callers.length >= 1);
    assert.ok(Array.isArray(hubHit.callees));

    const cen = await search("hub leaf", cfg, { k: 5, centrality: true, graphData });
    const hubCen = cen.find((h) => h.path === "hub.mjs");
    assert.ok(hubCen.centrality > 1);                  // high-degree hub annotated
    assert.equal(cen[0].path, "hub.mjs");              // boosted to the top

    const plain = await search("hub leaf", cfg, { k: 5 });
    assert.ok(plain.every((h) => h.centrality === undefined && h.callers === undefined));
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});
