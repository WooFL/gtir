import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeFilter } from "./filter.mjs";

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
