// src/frontmatter.mjs — minimal, line-based upsert of gtir-owned SCALAR frontmatter keys (stale,
// last_synced_sha). NOT a YAML parser: it only replaces/inserts the named scalar lines and never
// reflows or reorders other keys. Safe against arbitrary existing frontmatter.

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const serialize = (v) => String(v);

// Set each scalar field in `fields` ({key: value}) on the note text. Existing fence (LF or CRLF) →
// replace/insert the lines, preserving the file's EOL style; no fence → prepend a new block. Idempotent.
export function setFrontmatterFields(text, fields) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const entries = Object.entries(fields);
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)/);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (const [k, v] of entries) {
      const line = `${k}: ${serialize(v)}`;
      const re = new RegExp(`^${reEscape(k)}:`);
      const idx = lines.findIndex((l) => re.test(l));
      if (idx >= 0) lines[idx] = line; else lines.push(line);
    }
    return `---${eol}${lines.join(eol)}${eol}---${m[2] || eol}` + src.slice(m[0].length);
  }
  const lines = entries.map(([k, v]) => `${k}: ${serialize(v)}`).join(eol);
  return `---${eol}${lines}${eol}---${eol}${eol}${src}`;
}
