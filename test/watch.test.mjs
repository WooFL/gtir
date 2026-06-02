import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBatcher, watchRepo } from "../src/watch.mjs";
import { loadConfig } from "../src/config.mjs";

// A controllable timer: capture the scheduled callback so the test fires it on demand,
// making the debounce/deferral logic deterministic (no sleeping on real wall-clock).
function fakeTimer() {
  let cb = null;
  return {
    setTimer: (fn) => { cb = fn; return 1; },
    clearTimer: () => { cb = null; },
    async tick() { const fn = cb; cb = null; if (fn) await fn(); },
    armed: () => cb !== null,
  };
}

test("createBatcher coalesces a burst of changes into one deduped batch", async () => {
  const t = fakeTimer();
  const batches = [];
  const b = createBatcher({ onBatch: (x) => batches.push(x), setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.notify("a.ts"); b.notify("b.ts"); b.notify("a.ts");
  assert.equal(b.pendingCount(), 2, "a.ts deduped within the window");
  await t.tick();
  assert.equal(batches.length, 1, "one batch for the whole burst");
  assert.deepEqual(new Set(batches[0]), new Set(["a.ts", "b.ts"]));
});

test("createBatcher defers while git is busy, then runs once it clears", async () => {
  const t = fakeTimer();
  let busy = true;
  const batches = [];
  const b = createBatcher({ isBusy: () => busy, onBatch: (x) => batches.push(x), setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.notify("a.ts");
  await t.tick();                       // busy → defers and re-arms (no refresh during a git op)
  assert.equal(batches.length, 0, "no refresh while a rebase/merge is mid-flight");
  assert.ok(t.armed(), "re-armed to retry after the op");
  busy = false;
  await t.tick();                       // op finished → runs the coalesced batch
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ["a.ts"]);
});

test("watchRepo fires a batch when an indexable file is created", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-watch-"));
  const cfg = loadConfig(repo);
  const got = [];
  let resolve; const fired = new Promise((r) => (resolve = r));
  const w = watchRepo(cfg, {
    debounceMs: 40,
    isBusy: () => false,
    onBatch: async (paths) => { got.push(...paths); resolve(); },
  });
  await new Promise((r) => w.watcher.on("ready", r));
  writeFileSync(join(repo, "fresh.ts"), "export const fresh = 1\n");
  await Promise.race([fired, new Promise((_, rej) => setTimeout(() => rej(new Error("watch timeout")), 5000))]);
  await w.close();
  assert.ok(got.includes("fresh.ts"), `expected fresh.ts in batch, got ${JSON.stringify(got)}`);
});

test("watchRepo ignores non-indexable files and skip-listed dirs", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-watch2-"));
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  const cfg = loadConfig(repo);
  const got = [];
  const w = watchRepo(cfg, { debounceMs: 30, isBusy: () => false, onBatch: async (paths) => got.push(...paths) });
  await new Promise((r) => w.watcher.on("ready", r));
  writeFileSync(join(repo, "pic.png"), "x");                                  // non-indexable extension
  writeFileSync(join(repo, "node_modules", "dep.ts"), "export const d = 1");  // inside a skip-listed dir
  await new Promise((r) => setTimeout(r, 400));                               // give chokidar time to (not) react
  await w.close();
  assert.deepEqual(got, [], `expected no batch for ignored paths, got ${JSON.stringify(got)}`);
});
