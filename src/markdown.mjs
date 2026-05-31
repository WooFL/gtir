import { basename } from "node:path";
import { chunkRecursive } from "./chunker.mjs";

export const SEP = " › ";

function stripQuotes(s) { return s.replace(/^["']|["']$/g, "").trim(); }

function parseListValue(val, lines, keyLineIdx, close) {
  let v = val.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  if (v) return v.split(",").map((s) => stripQuotes(s)).filter(Boolean);
  // block list: subsequent "- item" lines until the next key or the closing ---
  const out = [];
  for (let i = keyLineIdx + 1; i < close; i++) {
    const m = lines[i].match(/^\s*-\s+(.*)$/);
    if (!m) break;
    out.push(stripQuotes(m[1]));
  }
  return out.filter(Boolean);
}

export function parseFrontmatter(lines) {
  const none = { title: null, tags: [], aliases: [], bodyStartLineIdx: 0 };
  if (lines[0] !== "---") return none;
  let close = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i] === "---") { close = i; break; } }
  if (close === -1) return none;
  const meta = { title: null, tags: [], aliases: [], bodyStartLineIdx: close + 1 };
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "title") meta.title = stripQuotes(m[2]) || null;
    else if (key === "tags" || key === "aliases") meta[key] = parseListValue(m[2], lines, i, close);
  }
  return meta;
}

export function scanHeadings(lines, bodyStartLineIdx) {
  const headings = [];
  let inFence = false;
  for (let i = bodyStartLineIdx; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ level: m[1].length, title: m[2].trim(), lineIdx: i });
  }
  return headings;
}
