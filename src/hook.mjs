import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export const MARKER = "# >>> gtir refresh >>>";
const END = "# <<< gtir refresh <<<";

// gtir manages two hooks. post-commit catches ordinary commits. post-rewrite fires
// ONCE after a rebase or amend finishes, so the index still converges to the final
// tree even when the merge backend ran no per-commit hook during the rebase.
const HOOKS = ["post-commit", "post-rewrite"];

// Sentinels git drops while a multi-commit operation is mid-flight. While any exists the
// working tree is a transient, soon-to-be-discarded state: refreshing against it re-embeds
// throwaway content once per replayed commit (the rebase "10-minute GPU" storm). We defer;
// the post-rewrite hook runs the single real refresh once the operation completes.
// Directory markers cover rebases and cherry-pick/revert *sequences* (which clear
// CHERRY_PICK_HEAD per pick but keep sequencer/ for the whole run).
const BUSY_MARKERS = [
  "rebase-merge", "rebase-apply", "sequencer",          // dirs
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD", "BISECT_LOG", // files
];

function hookPath(repo, name) { return join(repo, ".git", "hooks", name); }

// Resolve the per-worktree git dir. rebase/sequencer state lives here, NOT the common
// dir, so this stays correct in linked worktrees where .git is a file pointer. Returns
// null when `repo` isn't a git work tree (git absent or rev-parse fails).
export function resolveGitDir(repo) {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return isAbsolute(out) ? out : resolve(repo, out);
  } catch { return null; }
}

// True while a rebase / cherry-pick / revert / merge / bisect is in progress. gitDir is
// injectable for tests; defaults to resolving it from `repo`. A null git dir is never busy.
export function gitBusy(repo, gitDir = resolveGitDir(repo)) {
  if (!gitDir) return false;
  return BUSY_MARKERS.some((m) => existsSync(join(gitDir, m)));
}

// Embed an ABSOLUTE repo path (forward slashes for /bin/sh). A hook runs from the repo
// root, so a relative arg like "vault" would resolve to vault/vault and silently miss.
// --hook makes refresh self-skip while git is mid-operation (see gitBusy).
function refreshCmd(repoArg) {
  return `gtir refresh --hook --repo "${repoArg}" >/dev/null 2>&1 || true`;
}

function block(repoArg, hookName) {
  const lines = [MARKER];
  if (hookName === "post-rewrite") {
    // git passes "amend" or "rebase" as $1. post-commit already refreshed an amend; only
    // rebase needs the catch-up (the merge backend skips post-commit during the replay).
    lines.push(`case "$1" in amend) : ;; *) ${refreshCmd(repoArg)} ;; esac`);
  } else {
    lines.push(refreshCmd(repoArg));
  }
  lines.push(END, "");
  return lines.join("\n");
}

function stripBlock(body) {
  const start = body.indexOf(MARKER);
  if (start === -1) return body;
  const end = body.indexOf(END, start);
  if (end === -1) return body.slice(0, start);
  return (body.slice(0, start) + body.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

export function installHook(repo) {
  const abs = resolve(repo);
  const repoArg = abs.split("\\").join("/");
  for (const name of HOOKS) {
    const path = hookPath(abs, name);
    let body = existsSync(path) ? readFileSync(path, "utf8") : "#!/bin/sh\n";
    body = stripBlock(body); // ensure idempotency
    if (!body.endsWith("\n")) body += "\n";
    body += block(repoArg, name);
    writeFileSync(path, body);
    try { chmodSync(path, 0o755); } catch { /* windows: no-op */ }
  }
}

export function removeHook(repo) {
  const abs = resolve(repo);
  for (const name of HOOKS) {
    const path = hookPath(abs, name);
    if (!existsSync(path)) continue;
    writeFileSync(path, stripBlock(readFileSync(path, "utf8")));
  }
}
