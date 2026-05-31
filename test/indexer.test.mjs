import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";

// Deterministic fake embedder: dim-3 vector seeded by text length.
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const n = t.length % 7 + 1;
    const v = [n, n + 1, n + 2];
    const len = Math.hypot(...v);
    return v.map((x) => x / len);
  }));
}

function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "gtir-idx-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  return repo;
}

test("buildIndex indexes files and reports counts", async () => {
  const repo = repoWith({
    "user.py": "class User:\n    def login(self):\n        return 'authenticated successfully here'",
    "note.md": "# Title\n\nSome documentation text that is long enough to pass minChars easily.",
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed, contextTier: "synthetic" };
  const res = await buildIndex(cfg, { rebuild: true });
  assert.ok(res.chunks >= 2);
  assert.equal(res.dim, 3);
});

test("incremental: unchanged files are skipped on second run", async () => {
  const repo = repoWith({
    "a.py": "def alpha():\n    return 'a body long enough to clear the minimum chars'",
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  const second = await buildIndex(cfg, { rebuild: false });
  assert.equal(second.skipped >= 1, true);
});
