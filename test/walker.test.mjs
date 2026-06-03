import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkRepo, statPaths } from "../src/walker.mjs";
import { loadConfig } from "../src/config.mjs";

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-walk-"));
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\nbuilt/\n");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;");
  writeFileSync(join(repo, "ignored.ts"), "export const x = 1;");
  writeFileSync(join(repo, "note.md"), "# hi");
  writeFileSync(join(repo, "pic.png"), "binary");
  mkdirSync(join(repo, "built"), { recursive: true });
  writeFileSync(join(repo, "built", "b.ts"), "export const b = 2;");
  mkdirSync(join(repo, "node_modules", "p"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "p", "c.ts"), "export const c = 3;");
  return repo;
}

test("walkRepo includes indexable files, applies gitignore + skipDirs + ext gate", () => {
  const repo = makeRepo();
  const cfg = loadConfig(repo);
  const rels = walkRepo(cfg).map((f) => f.relPath).sort();
  assert.deepEqual(rels, ["a.ts", "note.md"]);
});

test("walkRepo returns mtimeMs as integer", () => {
  const repo = makeRepo();
  const cfg = loadConfig(repo);
  const a = walkRepo(cfg).find((f) => f.relPath === "a.ts");
  assert.equal(Number.isInteger(a.mtimeMs), true);
});

test("statPaths: splits a changed-path set into indexable files vs deletions, dropping noise", () => {
  const repo = makeRepo(); // a.ts, note.md, ignored.ts (gitignored), pic.png, built/, node_modules/
  const cfg = loadConfig(repo);
  const { files, missing } = statPaths(cfg, [
    "a.ts",                    // indexable, on disk → file
    "pic.png",                 // non-indexable extension → dropped
    "ignored.ts",              // gitignored → dropped
    "node_modules/p/c.ts",     // skip-listed dir → dropped (before stat)
    "gone.ts",                 // not on disk → deletion
  ]);
  assert.deepEqual(files.map((f) => f.relPath), ["a.ts"]);
  assert.deepEqual(missing, ["gone.ts"]);
  assert.equal(Number.isInteger(files[0].mtimeMs), true);
});
