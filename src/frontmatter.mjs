// src/frontmatter.mjs — minimal, line-based upsert of gtir-owned SCALAR frontmatter keys (stale,
// last_synced_sha). NOT a YAML parser: it only replaces/inserts the named scalar lines and never
// reflows or reorders other keys. Safe against arbitrary existing frontmatter.

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const serialize = (v) => (typeof v === "boolean" || typeof v === "number") ? String(v) : String(v);

// Set each scalar field in `fields` ({key: value}) on the note text. Existing fence → replace/insert
// the lines; no fence → prepend a new `---` block. Idempotent. Other content untouched.
export function setFrontmatterFields(text, fields) {
  const src = String(text ?? "");
  const entries = Object.entries(fields);
  const m = src.match(/^---\n([\s\S]*?)\n---(\n?)/);
  if (m) {
    let fm = m[1];
    for (const [k, v] of entries) {
      const line = `${k}: ${serialize(v)}`;
      const re = new RegExp(`^${reEscape(k)}:.*$`, "m");
      fm = re.test(fm) ? fm.replace(re, line) : `${fm}\n${line}`;
    }
    return `---\n${fm}\n---${m[2] || "\n"}` + src.slice(m[0].length);
  }
  const lines = entries.map(([k, v]) => `${k}: ${serialize(v)}`).join("\n");
  return `---\n${lines}\n---\n\n${src}`;
}
