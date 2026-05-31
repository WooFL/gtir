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

// A counting embedder: records how many texts it was asked to embed.
function counter() {
  const state = { calls: 0 };
  const fn = (texts) => {
    state.calls += texts.length;
    return Promise.resolve(texts.map((t) => { const n = (t.length % 5) + 1; const v = [n, n + 1, n + 2]; const L = Math.hypot(...v); return v.map((x) => x / L); }));
  };
  return { fn, state };
}
const CODE = "export function foo(input) {\n  // a body long enough to comfortably clear the 100-char minimum chunk size threshold here\n  return String(input).trim();\n}";

test("rebuild reuses cached embeddings: second build embeds 0", async () => {
  const repo = repoWith({ "a.ts": CODE, "b.ts": CODE.replace("foo", "bar") });
  const c1 = counter();
  const r1 = await buildIndex({ ...loadConfig(repo), embedImpl: c1.fn }, { rebuild: true });
  assert.ok(r1.embedded >= 2 && c1.state.calls === r1.embedded);
  const c2 = counter();
  const r2 = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: true });
  assert.equal(c2.state.calls, 0, "unchanged rebuild should embed nothing");
  assert.equal(r2.reused, r2.chunks);
  assert.equal(r2.embedded, 0);
});

test("model change ignores the cache (re-embeds all)", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), model: "different-model", embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "model change must re-embed");
});

test("--no-cache (cfg.noCache) forces re-embed", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), noCache: true, embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "noCache must re-embed");
});

test("refresh reuses unchanged sections within a changed file", async () => {
  const md = "# Page\n\n## A\nSection A body that is stable and long enough to be its own chunk here.\n\n## B\nSection B body original and also long enough to be a real chunk on its own.\n";
  const repo = repoWith({ "p.md": md });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true }); // initial
  writeFileSync(join(repo, "p.md"), md.replace("Section B body original", "Section B body EDITED"));
  const c2 = counter();
  const r = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: false });
  assert.ok(r.reused >= 1, "section A should be reused");
  assert.ok(r.embedded >= 1, "section B should be re-embedded");
  assert.equal(c2.state.calls, r.embedded);
});
