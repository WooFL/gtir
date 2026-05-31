import { test } from "node:test";
import assert from "node:assert/strict";
import { rerankDocs } from "../src/rerank.mjs";

const cfgWith = (fetchImpl, extra = {}) => ({
  rerankUrl: "http://127.0.0.1:8088", rerankModel: "m", rerankMaxChars: 2000, fetchImpl, ...extra,
});

test("rerankDocs parses {results} and sorts by score desc", async () => {
  const cfg = cfgWith(async () => ({
    ok: true, status: 200,
    json: async () => ({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }] }),
  }));
  const out = await rerankDocs("q", ["a", "b"], cfg);
  assert.deepEqual(out, [{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
});

test("rerankDocs returns null on HTTP error (graceful fallback)", async () => {
  const cfg = cfgWith(async () => ({ ok: false, status: 503, text: async () => "down" }));
  assert.equal(await rerankDocs("q", ["a"], cfg), null);
});

test("rerankDocs returns null when fetch throws", async () => {
  const cfg = cfgWith(async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(await rerankDocs("q", ["a"], cfg), null);
});

test("rerankDocs caps each document to rerankMaxChars", async () => {
  let sent;
  const cfg = cfgWith(async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  }, { rerankMaxChars: 10 });
  await rerankDocs("q", ["abcdefghijklmnopqrstuvwxyz"], cfg);
  assert.equal(sent.documents[0].length, 10);
  assert.equal(sent.query, "q");
});
