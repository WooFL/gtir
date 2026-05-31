import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runIndex, runSearch } from "../bin/gtir.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Deterministic fake embedder shared by index + search so cosine is meaningful:
// vector is a 3-dim bag-of-keyword count over a tiny vocabulary.
const VOCAB = ["session", "token", "authentication", "revoke"];
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const low = t.toLowerCase();
    const v = VOCAB.slice(0, 3).map((w) => (low.split(w).length - 1) + 0.01);
    const len = Math.hypot(...v) || 1;
    return v.map((x) => x / len);
  }));
}

function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-cli-"));
  cpSync(join(here, "fixtures", "sample-repo"), repo, { recursive: true });
  return repo;
}

test("index then search finds the session manager; gitignored file excluded", async () => {
  const repo = freshRepo();
  const res = await runIndex({ repo, rebuild: true, embedImpl: fakeEmbed });
  assert.ok(res.chunks >= 2);

  const hits = await runSearch({ repo, query: "create a session token", k: 5, embedImpl: fakeEmbed });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.path === "auth.py"));
  assert.equal(hits.some((h) => h.path === "secret.py"), false); // gitignored
});
