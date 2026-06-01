import { test } from "node:test";
import assert from "node:assert/strict";
import { modelPresent, formatReport, runDoctor } from "../src/doctor.mjs";

const MODEL = "hf.co/jinaai/jina-code-embeddings-0.5b-GGUF:F16";

test("modelPresent matches exact and tolerates a :latest difference", () => {
  assert.equal(modelPresent({ models: [{ name: MODEL }] }, MODEL), true);
  assert.equal(modelPresent({ models: [{ name: "nomic-embed-text:latest" }] }, "nomic-embed-text"), true);
  assert.equal(modelPresent({ models: [{ name: "other" }] }, MODEL), false);
  assert.equal(modelPresent(null, MODEL), false);
});

test("formatReport marks ✓/✗ and is ready only when nothing failed", () => {
  const a = formatReport([{ name: "x", ok: true }, { name: "y", ok: true }]);
  assert.equal(a.ready, true);
  assert.match(a.text, /✓  x/);
  const b = formatReport([{ name: "x", ok: true }, { name: "y", ok: false, detail: "boom" }]);
  assert.equal(b.ready, false);
  assert.match(b.text, /✗  y — boom/);
});

const jsonRes = (obj) => ({ ok: true, json: async () => obj });
const errRes = (status) => ({ ok: false, status, text: async () => "" });
const streamRes = (lines) => ({
  ok: true,
  body: new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l + "\n")); c.close(); } }),
});

function mockOllama({ up = true, models = [], dim = 896, pull = ['{"status":"pulling"}', '{"status":"success"}'] } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.endsWith("/api/version")) return up ? jsonRes({ version: "0.0" }) : errRes(500);
    if (url.endsWith("/api/tags")) return jsonRes({ models });
    if (url.endsWith("/api/pull")) return streamRes(pull);
    if (url.endsWith("/api/embed")) return jsonRes({ embeddings: [Array(dim).fill(0.1)] });
    return errRes(404);
  };
  impl.calls = calls;
  return impl;
}

const cfgWith = (fetchImpl) => ({ ollamaUrl: "http://x", model: MODEL, fetchImpl, embedBatch: 32, maxEmbedChars: 6000 });

test("runDoctor: model already present → ready, dim probed, no pull", async () => {
  const impl = mockOllama({ models: [{ name: MODEL }] });
  const r = await runDoctor(cfgWith(impl), { pull: true });
  assert.equal(r.ready, true);
  assert.equal(r.dim, 896);
  assert.ok(!impl.calls.some((u) => u.endsWith("/api/pull")));   // present → no pull
});

test("runDoctor: model missing → pulls it, then ready", async () => {
  const impl = mockOllama({ models: [] });
  const r = await runDoctor(cfgWith(impl), { pull: true });
  assert.ok(impl.calls.some((u) => u.endsWith("/api/pull")));    // pulled
  assert.equal(r.ready, true);
  assert.equal(r.dim, 896);
});

test("runDoctor: model missing + pull disabled → not ready, points at `ollama pull`", async () => {
  const impl = mockOllama({ models: [] });
  const r = await runDoctor(cfgWith(impl), { pull: false });
  assert.equal(r.ready, false);
  assert.ok(!impl.calls.some((u) => u.endsWith("/api/pull")));
  assert.match(r.report, /ollama pull/);
});

test("runDoctor: Ollama down → not ready, never checks the model", async () => {
  const impl = mockOllama({ up: false });
  const r = await runDoctor(cfgWith(impl), { pull: true });
  assert.equal(r.ready, false);
  assert.ok(!impl.calls.some((u) => u.endsWith("/api/tags")));
});
