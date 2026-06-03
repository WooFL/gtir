import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeFilter } from "./filter.mjs";

// Targeted counterpart to walkRepo: stat a known set of changed relPaths (from the file-watcher)
// instead of walking the whole tree. Returns { files, missing } — `files` are the indexable ones
// still on disk (same shape walkRepo yields), `missing` are paths gone from disk (deletions to
// evict). Non-indexable / oversized / skip-dir paths are dropped from both.
export function statPaths(cfg, relPaths) {
  const f = makeFilter(cfg);
  const skip = new Set(cfg.skipDirs);
  const files = [];
  const missing = [];
  for (const rel of [...new Set(relPaths)]) {
    const segs = rel.split("/");
    if (segs.slice(0, -1).some((s) => skip.has(s))) continue; // inside a pruned directory
    const abs = join(cfg.repo, rel);
    let st = null;
    try { st = statSync(abs); } catch { /* not on disk */ }
    if (!st) { missing.push(rel); continue; }                 // gone → a deletion to evict
    if (!st.isFile()) continue;
    if (!f.indexableFile(abs, segs[segs.length - 1])) continue; // exists but not something we index
    if (st.size > cfg.maxFileBytes) continue;
    files.push({ absPath: abs, relPath: rel, mtimeMs: Math.floor(st.mtimeMs) });
  }
  return { files, missing };
}

export function walkRepo(cfg) {
  const f = makeFilter(cfg);
  const out = [];

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!f.skipDir(abs, e.name)) walk(abs);
      } else if (e.isFile()) {
        if (!f.indexableFile(abs, e.name)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size > cfg.maxFileBytes) continue;
        out.push({ absPath: abs, relPath: f.rel(abs), mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  }
  walk(cfg.repo);
  return out;
}
