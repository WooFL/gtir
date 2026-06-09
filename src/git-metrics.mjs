// src/git-metrics.mjs — pure, zero-dependency git-history metrics. No git, no I/O: callers pass the
// raw `git log --name-only --pretty=format:%x01%H` text and any side-data (call-edge pairs, LOC map).

// Parse `git log --name-only --pretty=format:%x01%H`. Each commit is a \x01<hash> line followed by its
// changed-file lines (no blank line between), commits separated by a blank line. Returns [{hash, files}].
export function parseGitLog(text) {
  const out = [];
  for (const chunk of String(text || "").split("\x01")) {
    if (!chunk) continue;
    const lines = chunk.split("\n");
    const hash = lines[0].trim();
    if (!hash) continue;
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    out.push({ hash, files });
  }
  return out;
}
