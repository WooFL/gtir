// src/git-metrics-run.mjs — impure orchestration for the git-metrics commands. Runs `git log`, reads LOC
// from disk, builds the call-edge pair set from the store, and calls the pure core in git-metrics.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./store.mjs";
import { parseGitLog, coChange, hotspots } from "./git-metrics.mjs";

// Sorted, order-independent pair key — must match git-metrics.mjs pairKey.
const pk = (a, b) => (a < b ? `${a}\x00${b}` : `${b}\x00${a}`);

// File pairs that have an in-repo call edge between two DIFFERENT files. Only resolved/dispatch/inferred
// calls with a real target count (ambiguous/external are too weak to claim a relationship). Returns a Set.
export function edgePairsFromEdges(edges) {
  const set = new Set();
  for (const e of edges) {
    if (e.kind !== "calls") continue;
    if (!(e.conf === "resolved" || e.conf === "dispatch" || e.conf === "inferred")) continue;
    if (!e.from_path || !e.to_path || e.from_path === e.to_path) continue;
    set.add(pk(e.from_path, e.to_path));
  }
  return set;
}

// Line count of file text (counts a final non-empty line without a trailing newline).
export function locLinesOf(text) {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

// Run `git log --name-only` for the last `window` commits. Throws if not a git repo / git missing.
function runGitLog(repo, window) {
  return execFileSync("git", ["-C", repo, "log", `-n${window}`, "--name-only", "--pretty=format:%x01%H"],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
}

// Build a Map<file, loc> for the given files that still exist on disk and are under the size cap.
function buildLocMap(repo, files, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const loc = new Map();
  for (const f of files) {
    if (f.includes("..") || f.startsWith("/") || /^[A-Za-z]:/.test(f)) continue; // never read outside the repo
    try {
      const p = join(repo, f);
      if (statSync(p).size > maxBytes) continue;
      loc.set(f, locLinesOf(readFileSync(p, "utf8")));
    } catch { /* deleted / unreadable -> skip */ }
  }
  return loc;
}

export async function cochangeQuery(cfg, { window, minSupport, maxCommitFiles } = {}) {
  let text;
  try { text = runGitLog(cfg.repo, window ?? cfg.metricsWindow ?? 1000); }
  catch { return { error: "not a git repository (or git unavailable)" }; }
  const commits = parseGitLog(text);
  let edgePairs = null;
  try {
    const store = await openStore(cfg);
    if (await store.hasEdges()) edgePairs = edgePairsFromEdges(await store.loadEdges());
  } catch { /* no index -> callEdge stays null */ }
  return coChange(commits, edgePairs, {
    minSupport: minSupport ?? cfg.cochangeMinSupport ?? 3,
    maxCommitFiles: maxCommitFiles ?? cfg.metricsMaxCommitFiles ?? 25,
  });
}

export async function hotspotsQuery(cfg, { window, top, maxCommitFiles } = {}) {
  let text;
  try { text = runGitLog(cfg.repo, window ?? cfg.metricsWindow ?? 1000); }
  catch { return { error: "not a git repository (or git unavailable)" }; }
  const commits = parseGitLog(text);
  const allFiles = new Set();
  for (const c of commits) for (const f of c.files) allFiles.add(f);
  const locMap = buildLocMap(cfg.repo, allFiles);
  return hotspots(commits, locMap, {
    top: top ?? 20,
    maxCommitFiles: maxCommitFiles ?? cfg.metricsMaxCommitFiles ?? 25,
  });
}
