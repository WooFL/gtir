// src/marked-section.mjs — generic managed-region helpers. Pure. A "marked section" is a block
// delimited by a start/end mark (HTML comments) that a tool owns: upsert replaces just the block
// (prose around it untouched), remove strips it. Shared by install wiring and wiki refs blocks.

// Escape a string for safe use as a literal inside a RegExp.
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The full marked block (start mark, body, end mark).
function markedBlock(startMark, endMark, body) {
  return `${startMark}\n${body}\n${endMark}`;
}

// Upsert the marked block into `text`. Absent → append (separating blank line); present → replace
// just the block. Idempotent for a fixed body. Always ends with exactly one trailing newline.
export function upsertMarkedSection(text, startMark, endMark, body) {
  const src = text ?? "";
  const block = markedBlock(startMark, endMark, body);
  const re = new RegExp(`${reEscape(startMark)}[\\s\\S]*?${reEscape(endMark)}`);
  if (re.test(src)) {
    return src.replace(re, block).replace(/\s*$/, "\n");
  }
  const base = src.replace(/\s*$/, "");
  const prefix = base.length ? `${base}\n\n` : "";
  return `${prefix}${block}\n`;
}

// Remove the marked block (and any blank line immediately preceding it). Absent → unchanged. Idempotent.
export function removeMarkedSection(text, startMark, endMark) {
  const src = text ?? "";
  const re = new RegExp(`\\n*${reEscape(startMark)}[\\s\\S]*?${reEscape(endMark)}\\n*`);
  if (!re.test(src)) return src;
  const stripped = src.replace(re, "\n");
  return stripped.replace(/\s*$/, src.replace(/\s*$/, "").length ? "\n" : "");
}
