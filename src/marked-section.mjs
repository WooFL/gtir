// src/marked-section.mjs — generic managed-region helpers. Pure. A "marked section" is a block
// delimited by a start/end mark (HTML comments) that a tool owns: upsert replaces just the block
// (prose around it untouched), remove strips it. Shared by install wiring and wiki refs blocks.

// Escape a string for safe use as a literal inside a RegExp.
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Dominant line ending of a text, so a managed block matches its host file (CRLF wikis stay CRLF).
function detectEol(s) {
  return /\r\n/.test(s) ? "\r\n" : "\n";
}

// The full marked block (start mark, body, end mark), with every newline normalized to `eol`.
function markedBlock(startMark, endMark, body, eol) {
  return `${startMark}\n${body}\n${endMark}`.replace(/\r?\n/g, eol);
}

// Upsert the marked block into `text`. Absent → append (separating blank line); present → replace
// just the block. Idempotent for a fixed body. Always ends with exactly one trailing newline.
// EOL-aware: the block (and the trailing newline) match the host file's line ending.
export function upsertMarkedSection(text, startMark, endMark, body) {
  const src = text ?? "";
  const eol = detectEol(src);
  const block = markedBlock(startMark, endMark, body, eol);
  const re = new RegExp(`${reEscape(startMark)}[\\s\\S]*?${reEscape(endMark)}`);
  if (re.test(src)) {
    return src.replace(re, block).replace(/\s*$/, eol);
  }
  const base = src.replace(/\s*$/, "");
  const prefix = base.length ? `${base}${eol}${eol}` : "";
  return `${prefix}${block}${eol}`;
}

// Remove the marked block (and any blank line immediately preceding it). Absent → unchanged. Idempotent.
// EOL-aware: surrounding CRLF/LF runs collapse to the host file's line ending.
export function removeMarkedSection(text, startMark, endMark) {
  const src = text ?? "";
  const eol = detectEol(src);
  const re = new RegExp(`(?:\\r?\\n)*${reEscape(startMark)}[\\s\\S]*?${reEscape(endMark)}(?:\\r?\\n)*`);
  if (!re.test(src)) return src;
  const stripped = src.replace(re, eol);
  return stripped.replace(/\s*$/, src.replace(/\s*$/, "").length ? eol : "");
}
