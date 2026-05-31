import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";
import ignore from "ignore";
import { isIndexable } from "./languages.mjs";

function loadIgnore(cfg) {
  const ig = ignore();
  const gi = join(cfg.repo, ".gitignore");
  if (existsSync(gi)) ig.add(readFileSync(gi, "utf8"));
  ig.add(cfg.skipDirs.map((d) => `${d}/`));
  return ig;
}

export function walkRepo(cfg) {
  const ig = loadIgnore(cfg);
  const skip = new Set(cfg.skipDirs);
  const out = [];

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(cfg.repo, abs).split(sep).join("/");
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        if (ig.ignores(rel + "/")) continue;
        walk(abs);
      } else if (e.isFile()) {
        if (cfg.skipSuffixes.some((s) => e.name.endsWith(s))) continue;
        if (!isIndexable(extname(e.name))) continue;
        if (ig.ignores(rel)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.size > cfg.maxFileBytes) continue;
        out.push({ absPath: abs, relPath: rel, mtimeMs: Math.floor(st.mtimeMs) });
      }
    }
  }
  walk(cfg.repo);
  return out;
}
