// src/stale.mjs — pure core for code->note drift detection. No I/O. A note depends on the code symbols
// it cites (resolved by the mention-bridge); we snapshot a normalized hash of each cited symbol's body +
// signature, then diff. Normalization kills whitespace/comment/line-move false positives.
import { createHash } from "node:crypto";

// Strip line + block comments (best-effort, language-agnostic), collapse whitespace, trim.
export function normalizeForHash(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")// // line (avoid eating http://)
    .replace(/(^|\s)#[^\n]*/g, "$1")     // # line (python/shell)
    .replace(/\s+/g, "")
    .trim();
}

// Header slice: up to the first body-open `{`, or an arrow `=>`, or a python-style `:` def line.
export function extractSignature(text) {
  const s = String(text || "");
  const brace = s.indexOf("{");
  const arrow = s.indexOf("=>");
  // arrow before brace -> include through the arrow
  if (arrow !== -1 && (brace === -1 || arrow < brace)) return s.slice(0, arrow + 2).replace(/\s+/g, " ").trim();
  if (brace !== -1) return s.slice(0, brace).replace(/\s+/g, " ").trim();
  // python/no-brace: first line, trimmed (keeps a trailing `:` if present)
  const firstLine = s.split("\n").map((l) => l.trim()).find((l) => l.length) || "";
  return firstLine;
}

export function hashText(text) {
  return createHash("sha1").update(String(text || ""), "utf8").digest("hex");
}

// link: { kind:"symbol"|"file", symbol?, path, lines?, text }
export function snapshotRow(link) {
  const text = link.text || "";
  const snippet = text.split("\n").slice(0, 3).join("\n");
  const row = {
    symbol: link.symbol, path: link.path, lines: link.lines, kind: link.kind,
    bodyHash: hashText(normalizeForHash(text)), snippet,
  };
  if (link.kind === "symbol") {
    const sig = extractSignature(text);
    row.sig = sig;
    row.sigHash = hashText(normalizeForHash(sig));
  }
  return row;
}

// oldRow: baseline row; cur: current row or null (symbol gone). Returns severity or null.
export function gradeDrift(oldRow, cur) {
  if (!cur) return "removed";
  if (oldRow.sigHash !== undefined && cur.sigHash !== undefined && oldRow.sigHash !== cur.sigHash) return "signature";
  if (oldRow.bodyHash !== cur.bodyHash) return "body";
  return null;
}

const PRIORITY = { signature: "high", removed: "high", body: "medium" };

// baselineLinks/currentLinks: { [notePath]: row[] }. muted: { [notePath]: symbol[] | ["*"] }.
// A current row matches a baseline row by symbol (any path); a body-hash match at a new path = move (no drift).
export function diffBaseline(baselineLinks, currentLinks, muted = {}) {
  const stale = [];
  for (const [note, baseRows] of Object.entries(baselineLinks)) {
    const muteList = muted[note] || [];
    if (muteList.includes("*")) continue;
    const cur = currentLinks[note] || [];
    const rows = [];
    for (const b of baseRows) {
      if (muteList.includes(b.symbol)) continue;
      // match current by symbol (prefer same path)
      const matches = cur.filter((c) => c.symbol === b.symbol && c.kind === b.kind);
      const sameName = matches.find((c) => c.path === b.path) || matches[0] || null;
      const severity = gradeDrift(b, sameName);
      if (!severity) continue;
      rows.push({
        symbol: b.symbol, codePath: b.path, lines: b.lines, severity, priority: PRIORITY[severity],
        before: { sig: b.sig, snippet: b.snippet, lines: b.lines },
        after: sameName ? { sig: sameName.sig, snippet: sameName.snippet, lines: sameName.lines } : null,
      });
    }
    if (rows.length) stale.push({ note, rows });
  }
  return { stale, staleNotes: stale.length, staleLinks: stale.reduce((n, s) => n + s.rows.length, 0) };
}
