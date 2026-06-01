import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checksum, GRAMMAR_ASSETS, fetchGrammars } from "../src/fetch-grammars.mjs";

test("checksum matches node:crypto sha256", () => {
  const buf = Buffer.from("hello gtir");
  assert.equal(checksum(buf), createHash("sha256").update(buf).digest("hex"));
});

test("GRAMMAR_ASSETS pins glsl + hlsl with 64-hex sha256", () => {
  assert.deepEqual(GRAMMAR_ASSETS.map((a) => a.lang).sort(), ["glsl", "hlsl"]);
  for (const a of GRAMMAR_ASSETS) {
    assert.match(a.file, /^tree-sitter-(glsl|hlsl)\.wasm$/);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
});

test("fetchGrammars throws on HTTP error", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(fetchGrammars({ log: () => {}, fetchImpl }), /HTTP 404/);
});

test("fetchGrammars rejects a checksum mismatch before installing", async () => {
  // Bytes that won't match either pinned sha → the integrity gate must fire (and nothing is written).
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  await assert.rejects(fetchGrammars({ log: () => {}, fetchImpl }), /checksum mismatch/);
});
