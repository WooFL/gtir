import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { openStore } from "../src/store.mjs";

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
    "user.py": [
      "class User:",
      "    def login(self, username, password):",
      "        # Authenticate the user and return a freshly minted session token on success.",
      "        if not username or not password:",
      "            return None",
      "        return create_session(username, password)",
    ].join("\n"),
    "note.md": [
      "# Authentication",
      "",
      "This document explains how the session manager creates and revokes tokens during",
      "the authentication flow, including the credential checks performed on each login.",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed, contextTier: "synthetic" };
  const res = await buildIndex(cfg, { rebuild: true });
  assert.ok(res.chunks >= 2);
  assert.equal(res.dim, 3);
});

test("incremental: unchanged files are skipped on second run", async () => {
  const repo = repoWith({
    "a.py": [
      "def alpha(items):",
      "    # Sum every value in the provided collection and return the running total here.",
      "    total = 0",
      "    for item in items:",
      "        total += item",
      "    return total",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  const second = await buildIndex(cfg, { rebuild: false });
  assert.equal(second.skipped >= 1, true);
});

test("no-op incremental refresh preserves meta dim (does not clobber to 0)", async () => {
  const repo = repoWith({
    "a.py": [
      "def alpha(items):",
      "    # Sum every value in the provided collection and return the running total here.",
      "    total = 0",
      "    for item in items:",
      "        total += item",
      "    return total",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });            // writes dim=3
  const store = await openStore(cfg);
  assert.equal((await store.readMeta()).dim, "3");      // sanity
  await buildIndex(cfg, { rebuild: false });            // no-op refresh, nothing changed
  assert.equal((await store.readMeta()).dim, "3");      // dim preserved, NOT clobbered to 0
});
