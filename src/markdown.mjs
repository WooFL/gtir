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

export function buildSections(lines, headings, bodyStartLineIdx, root) {
  const sections = [];
  const firstHeadingLine = headings.length ? headings[0].lineIdx : lines.length;
  if (firstHeadingLine > bodyStartLineIdx) {
    sections.push({ breadcrumb: [root], startLineIdx: bodyStartLineIdx, endLineIdx: firstHeadingLine, headingOnly: false });
  }
  const stack = []; // [{level, title}]
  for (let h = 0; h < headings.length; h++) {
    const { level, title, lineIdx } = headings[h];
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const breadcrumb = [root, ...stack.map((s) => s.title), title];
    stack.push({ level, title });
    const endLineIdx = h + 1 < headings.length ? headings[h + 1].lineIdx : lines.length;
    let hasContent = false;
    for (let i = lineIdx + 1; i < endLineIdx; i++) { if (lines[i].trim()) { hasContent = true; break; } }
    sections.push({ breadcrumb, startLineIdx: lineIdx, endLineIdx, headingOnly: !hasContent });
  }
  return sections;
}

export function sectionPrefix(relPath, breadcrumb, tags) {
  const tagStr = tags && tags.length ? `  [tags: ${tags.join(", ")}]` : "";
  return `${relPath}${SEP}${breadcrumb.join(SEP)}${tagStr}`;
}
