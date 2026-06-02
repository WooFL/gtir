import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installHook, removeHook, MARKER, gitBusy, resolveGitDir } from "../src/hook.mjs";

function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-hook-"));
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  return repo;
}

function hasGit() {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}
const noGit = hasGit() ? false : "git not installed";

test("installHook writes a post-commit hook with the gtir marker", () => {
  const repo = gitRepo();
  installHook(repo);
  const hook = join(repo, ".git", "hooks", "post-commit");
  assert.ok(existsSync(hook));
  assert.match(readFileSync(hook, "utf8"), new RegExp(MARKER));
});

test("installHook embeds an ABSOLUTE repo path in the refresh command (not a relative arg)", () => {
  const repo = gitRepo();   // absolute temp dir
  installHook(repo);
  const body = readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf8");
  // The hook runs from the repo root, so a relative "--repo vault" would miss; require the abs path.
  assert.ok(body.includes(`--repo "${repo.split("\\").join("/")}"`), `hook should embed the absolute repo path; got:\n${body}`);
});

test("installHook is idempotent (no duplicate gtir block)", () => {
  const repo = gitRepo();
  installHook(repo); installHook(repo);
  const body = readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf8");
  assert.equal(body.split(MARKER).length - 1, 1);
});

test("installHook preserves a pre-existing hook body", () => {
  const repo = gitRepo();
  const hook = join(repo, ".git", "hooks", "post-commit");
  writeFileSync(hook, "#!/bin/sh\necho existing\n");
  installHook(repo);
  const body = readFileSync(hook, "utf8");
  assert.match(body, /echo existing/);
  assert.match(body, new RegExp(MARKER));
});

test("removeHook strips the gtir block but keeps existing content", () => {
  const repo = gitRepo();
  const hook = join(repo, ".git", "hooks", "post-commit");
  writeFileSync(hook, "#!/bin/sh\necho existing\n");
  installHook(repo); removeHook(repo);
  const body = readFileSync(hook, "utf8");
  assert.match(body, /echo existing/);
  assert.equal(body.includes(MARKER), false);
});

// --- Option A: rebase-aware refresh ---

test("post-commit hook calls the git-busy-aware --hook refresh", () => {
  const repo = gitRepo();
  installHook(repo);
  const body = readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf8");
  assert.match(body, /gtir refresh --hook --repo/);
});

test("installHook also writes a post-rewrite hook that skips the amend case", () => {
  const repo = gitRepo();
  installHook(repo);
  const pr = join(repo, ".git", "hooks", "post-rewrite");
  assert.ok(existsSync(pr), "post-rewrite hook written");
  const body = readFileSync(pr, "utf8");
  assert.match(body, new RegExp(MARKER));
  assert.match(body, /--hook/, "post-rewrite uses the git-busy-aware refresh");
  // post-commit already refreshed an amend; only rebase needs the post-rewrite catch-up.
  assert.match(body, /amend/, "post-rewrite guards the amend case");
});

test("removeHook strips the gtir block from BOTH hooks", () => {
  const repo = gitRepo();
  installHook(repo); removeHook(repo);
  for (const name of ["post-commit", "post-rewrite"]) {
    const p = join(repo, ".git", "hooks", name);
    if (existsSync(p)) assert.equal(readFileSync(p, "utf8").includes(MARKER), false, `${name} still has the block`);
  }
});

test("gitBusy: clean git dir is not busy; each in-flight-operation marker flips it", () => {
  const gitDir = mkdtempSync(join(tmpdir(), "gtir-gd-"));
  assert.equal(gitBusy("/any/repo", gitDir), false, "clean git dir is not busy");
  // Directory markers: rebase + cherry-pick/revert sequences.
  for (const marker of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const p = join(gitDir, marker);
    mkdirSync(p);
    assert.equal(gitBusy("/any/repo", gitDir), true, `${marker}/ → busy`);
    rmSync(p, { recursive: true });
    assert.equal(gitBusy("/any/repo", gitDir), false, `${marker}/ cleared → not busy`);
  }
  // File markers: single cherry-pick/revert/merge/bisect.
  for (const marker of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "BISECT_LOG"]) {
    const p = join(gitDir, marker);
    writeFileSync(p, "x");
    assert.equal(gitBusy("/any/repo", gitDir), true, `${marker} → busy`);
    rmSync(p);
    assert.equal(gitBusy("/any/repo", gitDir), false, `${marker} cleared → not busy`);
  }
});

test("gitBusy: a null git dir (not a repo) is never busy", () => {
  assert.equal(gitBusy("/not/a/repo", null), false);
});

test("resolveGitDir + gitBusy detect a live rebase via the real git dir", { skip: noGit }, () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-gitbusy-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const gitDir = resolveGitDir(repo);
  assert.ok(gitDir && existsSync(gitDir), "resolves the real .git dir");
  assert.equal(gitBusy(repo), false, "fresh repo is not busy");
  mkdirSync(join(gitDir, "rebase-merge"));
  assert.equal(gitBusy(repo), true, "rebase-merge/ → busy");
});

test("refresh --hook defers (no index build) while a git op is in progress", { skip: noGit }, () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-deferral-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(resolveGitDir(repo), "rebase-merge"));
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "gtir.mjs");
  // Must exit 0 and never touch buildIndex (which would need Ollama) — so no index dir appears.
  execFileSync("node", [bin, "refresh", "--hook", "--repo", repo], { encoding: "utf8" });
  assert.equal(existsSync(join(repo, ".gtir", "index.lance")), false, "no index built during a git op");
});
