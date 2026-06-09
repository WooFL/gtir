// src/crosslinks.mjs — cross-corpus note->code mention bridge. Resolves code-shaped identifiers and
// file paths a note mentions against a LINKED code index's symbol inventory + file set. No embedding —
// pure symbol/path matching, so the wiki(nomic)/code(qwen3) model mismatch is irrelevant.
import { basename } from "node:path";
import { openStore } from "./store.mjs";
import { buildSymbolInventory } from "./graph-queries.mjs";
import { queryIdentifiers } from "./search.mjs";

const CODE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|hpp|cs|java|kt|rb|swift)";
const PATH_RE = new RegExp(`(?:packages|apps|src|lib|tools|scripts)/[\\w\\-./]+\\.${CODE_EXT}`, "g");
const STOP = new Set(["this", "true", "false", "null", "function", "return", "const", "async", "await", "import", "export", "class", "interface", "type", "value", "string", "number", "object"]);

function headLines(text, n) {
  return String(text || "").split("\n").slice(0, n).join("\n");
}

// Suffix-match a mentioned path against the code index's file set (paths are repo-relative).
function matchFile(mention, files) {
  if (files.has(mention)) return mention;
  for (const f of files) { if (f.endsWith("/" + mention) || mention.endsWith("/" + f)) return f; }
  return null;
}

// Pure: note text -> code links, filtered by the inventory/file-set (only real symbols/files link).
export function crossLinks(codeInv, codeFiles, noteText, { cap = 15 } = {}) {
  const text = String(noteText || "");
  const links = [];
  const seen = new Set();

  // symbols: code-shaped identifiers that are DEFINED in the code index
  const freq = new Map();
  for (const t of queryIdentifiers(text)) {
    if (t.length < 4 || STOP.has(t) || STOP.has(t.toLowerCase())) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  for (const [t, count] of freq) {
    const sites = codeInv.byName.get(t);
    if (!sites) continue;
    for (const s of sites) {
      const key = `${s.path}#${t}`;
      if (seen.has(key)) continue; seen.add(key);
      links.push({
        kind: "symbol", symbol: t, path: s.path,
        lines: s.line_start != null ? `${s.line_start}-${s.line_end}` : undefined,
        snippet: headLines(s.text, 5), _rank: count + (t.length / 100),
      });
    }
  }

  // file paths that EXIST in the code index
  for (const m of text.match(PATH_RE) || []) {
    const hit = matchFile(m, codeFiles);
    if (!hit) continue;
    const key = `${hit}#file`;
    if (seen.has(key)) continue; seen.add(key);
    links.push({ kind: "file", path: hit, snippet: "", _rank: 0.5 });
  }

  links.sort((a, b) => b._rank - a._rank);
  return links.slice(0, Math.max(0, cap)).map(({ _rank, ...l }) => l);
}
