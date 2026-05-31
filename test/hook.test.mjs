import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHook, removeHook, MARKER } from "../src/hook.mjs";

function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-hook-"));
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  return repo;
}

test("installHook writes a post-commit hook with the gtir marker", () => {
  const repo = gitRepo();
  installHook(repo);
  const hook = join(repo, ".git", "hooks", "post-commit");
  assert.ok(existsSync(hook));
  assert.match(readFileSync(hook, "utf8"), new RegExp(MARKER));
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
