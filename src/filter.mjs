import ignore from "ignore";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { isIndexable } from "./languages.mjs";

// Single source of truth for "which directories to descend" and "which files count as
// indexable". walkRepo uses it to enumerate the corpus; the file-watcher uses it to decide
// which chokidar events matter and which directories to prune. Size is intentionally NOT
// checked here (it needs a stat the walker already does, and the watcher defers the size
// decision to the authoritative re-walk that runs on each batch) — so the two stay in sync.
export function makeFilter(cfg) {
  const ig = ignore();
  const gi = join(cfg.repo, ".gitignore");
  if (existsSync(gi)) ig.add(readFileSync(gi, "utf8"));
  ig.add(cfg.skipDirs.map((d) => `${d}/`));
  const skip = new Set(cfg.skipDirs);

  const rel = (abs) => relative(cfg.repo, abs).split(/[\\/]/).join("/");

  return {
    rel,
    // Descend into this directory? false => prune (build dirs, vendored deps, .git, .gtir, gitignored).
    skipDir(abs, name) {
      if (skip.has(name)) return true;
      const r = rel(abs);
      return r !== "" && ig.ignores(r + "/");
    },
    // Is this a file gtir would index? extension gate + skipSuffixes + gitignore (size excluded).
    indexableFile(abs, name = abs.split(/[\\/]/).pop()) {
      // Emacs lock files are named `.#<file>` (a symlink mirroring the real name), so their
      // extension passes the gate (`.#a.mjs` → ".mjs"). Reject them — an editor opening a file
      // would otherwise trigger a spurious index refresh. (vim `.swp`/`~`, emacs `#a#`, JetBrains
      // `___jb_tmp___` already fail the extension gate; this is the one that slips through.)
      if (name.startsWith(".#")) return false;
      if (cfg.skipSuffixes.some((s) => name.endsWith(s))) return false;
      if (!isIndexable(extname(name))) return false;
      return !ig.ignores(rel(abs));
    },
  };
}
