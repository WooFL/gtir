import chokidar from "chokidar";
import { writeFileSync, existsSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeFilter } from "./filter.mjs";
import { gitBusy } from "./hook.mjs";
import { buildIndex } from "./indexer.mjs";

// --- watcher liveness lock --------------------------------------------------
// A running watcher keeps `.gtir/watch.lock` fresh on a heartbeat. The commit hooks read it via
// watcherLive() and stand down while a watcher is handling refresh — otherwise every commit pays a
// redundant index pass on top of the save-time one. Clean exit removes the lock (hooks resume at
// once); a crash leaves it to go stale within STALE_MS (hooks resume on their own). Self-healing,
// no PID liveness checks (which are awkward cross-platform) — just a file mtime.
const LOCK_FILE = "watch.lock";
const HEARTBEAT_MS = 60_000;
const STALE_MS = 150_000;

const lockPath = (cfg) => join(cfg.gtirDir, LOCK_FILE);

export function watcherLive(cfg, { staleMs = STALE_MS, now = Date.now } = {}) {
  try {
    const p = lockPath(cfg);
    return existsSync(p) && now() - statSync(p).mtimeMs < staleMs;
  } catch { return false; }
}

function touchLock(cfg) {
  try { mkdirSync(cfg.gtirDir, { recursive: true }); writeFileSync(lockPath(cfg), `${process.pid}\n`); }
  catch { /* best-effort: a missing lock just means the hooks won't skip */ }
}
function removeLock(cfg) { try { rmSync(lockPath(cfg), { force: true }); } catch { /* ignore */ } }

// --- debounce + coalesce + git-busy gate ------------------------------------
// Pure and timer-injected so the batching/deferral logic is deterministically testable. notify()
// accumulates paths; after `debounceMs` of quiet it fires onBatch ONCE with the coalesced set —
// unless a git op is in progress (isBusy), in which case it re-arms and retries. kick() forces a
// single gated refresh with nothing pending (the startup catch-up). cancel() drops a pending fire.
export function createBatcher({ debounceMs = 1500, isBusy = () => false, onBatch,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = new Set();
  let timer = null;
  let forced = false;
  function arm() { if (timer !== null) clearTimer(timer); timer = setTimer(fire, debounceMs); }
  async function fire() {
    timer = null;
    if (isBusy()) { arm(); return; }            // a git op is mid-flight — defer and retry
    if (pending.size === 0 && !forced) return;
    forced = false;
    const batch = [...pending]; pending = new Set();
    await onBatch(batch);
  }
  return {
    notify(relPath) { pending.add(relPath); arm(); },
    kick() { forced = true; arm(); },           // startup catch-up: refresh once with no pending changes
    cancel() { if (timer !== null) { clearTimer(timer); timer = null; } },
    pendingCount() { return pending.size; },
    armed() { return timer !== null; },
  };
}

// --- chokidar wiring --------------------------------------------------------
// Returns { watcher, batcher, close }. onBatch defaults to an incremental refresh; tests inject
// their own to avoid Ollama. `.git` and `.gtir` are in skipDirs, so we never watch git's internals
// nor our own index/lock writes (the latter would otherwise feed back into the watcher and loop).
export function watchRepo(cfg, { debounceMs = 1500, log = () => {}, isBusy, onBatch, onReady,
  initialRefresh = true, heartbeatMs = HEARTBEAT_MS } = {}) {
  const f = makeFilter(cfg);
  const busy = isBusy ?? (() => gitBusy(cfg.repo));
  const refresh = onBatch ?? (async (paths) => {
    try {
      // Hand the changed paths to buildIndex for a targeted refresh (no full repo walk). The
      // startup catch-up fires with an empty batch → buildIndex falls back to a full walk.
      const r = await buildIndex(cfg, { rebuild: false, paths });
      log(`refreshed — ${r.chunks} chunks (${r.embedded} embedded, ${r.reused} reused, ${r.skipped} skipped) after ${paths.length} change(s)`);
      return r;
    } catch (e) {
      log(`refresh failed — ${e.message} (will retry on next change)`);
    }
  });
  const batcher = createBatcher({ debounceMs, isBusy: busy, onBatch: refresh });

  // Announce liveness so the commit hooks stand down (see watcherLive); keep it fresh on a heartbeat.
  touchLock(cfg);
  const heartbeat = setInterval(() => touchLock(cfg), heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

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
  watcher.on("ready", () => {
    log(`watching ${cfg.repo} (debounce ${debounceMs}ms)`);
    if (initialRefresh) batcher.kick();   // catch up on edits made while the watcher was off
    onReady?.();
  });

  return {
    watcher, batcher,
    close: async () => { batcher.cancel(); clearInterval(heartbeat); removeLock(cfg); return watcher.close(); },
  };
}
