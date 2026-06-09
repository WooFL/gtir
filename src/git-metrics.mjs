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

// Sorted, order-independent pair key.
function pairKey(a, b) { return a < b ? `${a}\x00${b}` : `${b}\x00${a}`; }

// Co-change coupling. `edgePairs` is a Set of `pairKey(a,b)` for file pairs that DO have a call edge
// (or null when no edge index). Returns ranked pairs; pairs with no call edge (hidden coupling) sort
// first, then by confidence desc, then count desc. Pure.
export function coChange(commits, edgePairs, { minSupport = 3, maxCommitFiles = 25 } = {}) {
  const freq = new Map();
  const co = new Map();
  let skippedLargeCommits = 0;
  let commitsScanned = 0;
  for (const c of commits) {
    const files = [...new Set(c.files)];
    if (files.length > maxCommitFiles) { skippedLargeCommits++; continue; }
    commitsScanned++;
    for (const f of files) freq.set(f, (freq.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++)
      for (let j = i + 1; j < files.length; j++) {
        const k = pairKey(files[i], files[j]);
        co.set(k, (co.get(k) ?? 0) + 1);
      }
  }
  const pairs = [];
  for (const [k, count] of co) {
    if (count < minSupport) continue;
    const [a, b] = k.split("\x00");
    const confidence = Math.round((count / Math.min(freq.get(a), freq.get(b))) * 100) / 100;
    const callEdge = edgePairs ? edgePairs.has(k) : null;
    pairs.push({ a, b, count, confidence, callEdge });
  }
  const rank = (p) => (p.callEdge === false ? 0 : 1);
  pairs.sort((x, y) => rank(x) - rank(y) || y.confidence - x.confidence || y.count - x.count);
  return { pairs, commitsScanned, skippedLargeCommits };
}
