// src/graph-queries.mjs
import { basename } from "node:path";
import { declaredSymbols } from "./symbols.mjs";

const noteName = (p) => basename(String(p)).replace(/\.(md|mdx)$/i, "");

function indexByName(flat) {
  const m = new Map();
  for (const d of flat) { let a = m.get(d.name); if (!a) { a = []; m.set(d.name, a); } a.push(d); }
  return m;
}

// Full defined-symbol inventory, rebuilt at query time from chunk text (the same declaredSymbols
// heuristic the indexer uses). Returns { flat, byName }. Notes mode: one entry per note file.
export async function buildSymbolInventory(store, mode) {
  const rows = await store.allChunkRows(["path", "line_start", "line_end", "text"]);
  const flat = [];
  if (mode === "notes") {
    const seen = new Set();
    for (const r of rows) { if (seen.has(r.path)) continue; seen.add(r.path); flat.push({ name: noteName(r.path), path: r.path }); }
  } else {
    const seen = new Set();
    for (const r of rows) {
      for (const name of declaredSymbols(r.text)) {
        const k = `${r.path}#${name}`;
        if (seen.has(k)) continue; seen.add(k);
        flat.push({ name, path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end), text: r.text });
      }
    }
  }
  return { flat, byName: indexByName(flat) };
}
