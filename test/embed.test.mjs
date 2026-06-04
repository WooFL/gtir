import { test } from "node:test";
import assert from "node:assert/strict";
import { embedTexts, l2normalize } from "../src/embed.mjs";

function fakeFetch(vectorsByText) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const embeddings = body.input.map((t) => vectorsByText[t] ?? [0, 0, 0]);
    return { ok: true, json: async () => ({ embeddings }) };
  };
}

test("l2normalize yields unit length", () => {
  const v = l2normalize([3, 4]);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("embedTexts batches and normalizes via injected fetch", async () => {
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 2,
    fetchImpl: fakeFetch({ a: [3, 4], b: [0, 5], c: [1, 0] }),
  };
  const vecs = await embedTexts(["a", "b", "c"], cfg);
  assert.equal(vecs.length, 3);
  for (const v of vecs) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
});

test("embedTexts truncates inputs to maxEmbedChars before sending", async () => {
  let seen = null;
  const captureFetch = async (_url, opts) => {
    seen = JSON.parse(opts.body).input;
    return { ok: true, json: async () => ({ embeddings: seen.map(() => [1, 0, 0]) }) };
  };
  const cfg = { model: "m", ollamaUrl: "http://x", embedBatch: 32, maxEmbedChars: 50, fetchImpl: captureFetch };
  const long = "x".repeat(5000);
  await embedTexts([long], cfg);
  assert.equal(seen[0].length, 50, "input must be truncated to maxEmbedChars");
});

import { contentHash } from "../src/embed.mjs";

test("contentHash: stable sha256 hex; differs by input", () => {
  const a = contentHash("hello world");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contentHash("hello world"), a);      // deterministic
  assert.notEqual(contentHash("hello world!"), a);  // input-sensitive
});

// fetch that hangs until the AbortController fires, then rejects like the platform does.
function hangingFetch(onCall = () => {}) {
  return (_url, opts) => new Promise((_resolve, reject) => {
    onCall();
    opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted"); e.name = "AbortError"; reject(e);
    });
  });
}

test("embedBatch retries on timeout then throws after exhausting retries", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 20, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: hangingFetch(() => { calls++; }),
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /abort/i);
  assert.equal(calls, 3, "1 initial attempt + 2 retries");
});

test("embedBatch recovers after retryable 503s", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls <= 2) return { ok: false, status: 503, text: async () => "loading model" };
      return { ok: true, json: async () => ({ embeddings: [[1, 0, 0]] }) };
    },
  };
  const vecs = await embedTexts(["a"], cfg);
  assert.equal(calls, 3, "succeeds on the 3rd call");
  assert.equal(vecs.length, 1);
});

test("embedBatch does NOT retry a fatal 4xx", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => "does not support embeddings" }; },
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /embed failed/);
  assert.equal(calls, 1, "4xx is fatal — no retry");
});

test("embedBatch does NOT retry a malformed response", async () => {
  let calls = 0;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedTimeoutMs: 1000, embedRetries: 2, embedRetryBackoffMs: 0,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; },
  };
  await assert.rejects(() => embedTexts(["a"], cfg), /no embeddings array/);
  assert.equal(calls, 1, "bad shape is fatal — no retry");
});

import { warmup } from "../src/embed.mjs";

test("warmup returns true when the embed succeeds", async () => {
  let seen = null;
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    fetchImpl: async (_u, opts) => { seen = JSON.parse(opts.body).input; return { ok: true, json: async () => ({ embeddings: [[1, 0, 0]] }) }; },
  };
  assert.equal(await warmup(cfg), true);
  assert.deepEqual(seen, ["warmup"], "warmup embeds the single token 'warmup'");
});

test("warmup swallows failure and returns false", async () => {
  const cfg = {
    model: "m", ollamaUrl: "http://x", embedBatch: 32,
    embedRetries: 0, embedRetryBackoffMs: 0,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => "nope" }),
  };
  assert.equal(await warmup(cfg), false);
});
