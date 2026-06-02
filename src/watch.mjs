import chokidar from "chokidar";
import { makeFilter } from "./filter.mjs";
import { gitBusy } from "./hook.mjs";
import { buildIndex } from "./indexer.mjs";

// Debounce + coalesce + git-busy gate. Pure and timer-injected so the batching/deferral logic
// is deterministically testable without real filesystem events. notify() accumulates changed
// paths; after `debounceMs` of quiet it fires onBatch ONCE with the coalesced set — unless a git
// operation is in progress (isBusy), in which case it re-arms and retries. Same reasoning as the
// commit hooks: don't index a tree a rebase is mid-rewrite (a rebase churns the whole worktree,
// which would otherwise make the watcher storm — the exact thing the hook fix avoids).
export function createBatcher({ debounceMs = 1500, isBusy = () => false, onBatch,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = new Set();
  let timer = null;
  function arm() { if (timer !== null) clearTimer(timer); timer = setTimer(fire, debounceMs); }
  async function fire() {
    timer = null;
    if (isBusy()) { arm(); return; }            // a git op is mid-flight — defer and retry
    if (pending.size === 0) return;
    const batch = [...pending]; pending = new Set();
    await onBatch(batch);
  }
  return {
    notify(relPath) { pending.add(relPath); arm(); },
    pendingCount() { return pending.size; },
    armed() { return timer !== null; },
  };
}

// Wire chokidar to the batcher. Returns { watcher, batcher, close }. onBatch defaults to an
// incremental refresh; tests inject their own to avoid Ollama. `.git` and `.gtir` are in
// skipDirs, so we never watch git's internals nor our own index writes — the latter would
// otherwise feed back into the watcher and loop forever.
export function watchRepo(cfg, { debounceMs = 1500, log = () => {}, isBusy, onBatch, onReady } = {}) {
  const f = makeFilter(cfg);
  const busy = isBusy ?? (() => gitBusy(cfg.repo));
  const refresh = onBatch ?? (async (paths) => {
    try {
      const r = await buildIndex(cfg, { rebuild: false });
      log(`refreshed — ${r.chunks} chunks (${r.embedded} embedded, ${r.reused} reused, ${r.skipped} skipped) after ${paths.length} change(s)`);
      return r;
    } catch (e) {
      log(`refresh failed — ${e.message} (will retry on next change)`);
    }
  });
  const batcher = createBatcher({ debounceMs, isBusy: busy, onBatch: refresh });

  const watcher = chokidar.watch(cfg.repo, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p, stats) => {
      if (p === cfg.repo) return false;
      const name = p.split(/[\\/]/).pop();
      if (cfg.skipDirs.includes(name)) return true;        // prune node_modules/.git/.gtir/dist/... by name
      if (stats?.isFile()) return !f.indexableFile(p, name); // only watch files we'd index
      return false;                                         // dirs (not skip-listed) + pre-stat: descend
    },
  });
  for (const ev of ["add", "change", "unlink"]) {
    watcher.on(ev, (p) => batcher.notify(f.rel(p)));
  }
  watcher.on("error", (e) => log(`error — ${e.message}`));
  watcher.on("ready", () => { log(`watching ${cfg.repo} (debounce ${debounceMs}ms)`); onReady?.(); });

  return { watcher, batcher, close: () => watcher.close() };
}
