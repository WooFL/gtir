import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFilter } from "../src/filter.mjs";
import { loadConfig } from "../src/config.mjs";

test("makeFilter.indexableFile: indexes source, rejects editor temp/lock noise", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-filter-"));
  const f = makeFilter(loadConfig(repo));
  const idx = (n) => f.indexableFile(join(repo, n));

  // real source files: indexed
  assert.equal(idx("config.mjs"), true);
  assert.equal(idx("a.ts"), true);

  // editor junk that must NOT be indexed (else a live watcher refreshes on every editor open/save):
  assert.equal(idx(".#config.mjs"), false, "emacs lock file — .#name mirrors the real ext, so it slips the gate");
  assert.equal(idx("config.mjs~"), false, "vim/emacs backup");
  assert.equal(idx(".config.mjs.swp"), false, "vim swap");
  assert.equal(idx("#config.mjs#"), false, "emacs autosave");

  // non-indexable extensions: rejected
  assert.equal(idx("pic.png"), false);
});

test("makeFilter.skipDir: prunes build/vendored/dotted dirs, keeps source dirs", () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-filter2-"));
  const f = makeFilter(loadConfig(repo));
  assert.equal(f.skipDir(join(repo, "node_modules"), "node_modules"), true);
  assert.equal(f.skipDir(join(repo, ".git"), ".git"), true);
  assert.equal(f.skipDir(join(repo, ".gtir"), ".gtir"), true);
  assert.equal(f.skipDir(join(repo, "src"), "src"), false);
});
