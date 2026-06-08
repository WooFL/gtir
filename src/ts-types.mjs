// src/ts-types.mjs — TS/JS receiver-type resolution (pure). Three pieces:
//  - extractTsClassNames: class names declared in a chunk's text (for the class→file index)
//  - inferTsReceiverType: walk a call's enclosing scope for the receiver's type (added in a later task)
//  - resolveTsMethods: upgrade ambiguous member-call rows by intersecting class→file with method→file

// Class names declared in chunk text. `interface` is excluded (no method bodies → not a resolve target).
const TS_CLASS = /\bclass\s+([A-Za-z_$][\w$]*)/g;
export function extractTsClassNames(text) {
  const out = [];
  const s = String(text || "");
  TS_CLASS.lastIndex = 0;
  let m;
  while ((m = TS_CLASS.exec(s))) out.push(m[1]);
  return out;
}

// Upgrade an ambiguous TS/JS member-call row to resolved when the receiver type pins a unique file.
// Chunk-robust: TS/JS methods are in-class only, so instead of a `class#method` key (which breaks when
// the chunker splits a method out of its class), intersect the file(s) declaring class T with the
// file(s) defining a callable m — both live in the same file regardless of chunk boundaries.
export function resolveTsMethods(rows, tsClassFiles, tsCallableFiles) {
  return rows.map((r) => {
    if (r.kind !== "calls" || r.conf !== "ambiguous" || !r.isMethod || !r.receiverType) return r;
    const classFiles = tsClassFiles.get(r.receiverType);
    const defs = tsCallableFiles.get(r.ref_name);
    if (!classFiles || !defs) return r;
    const inClass = defs.filter((d) => classFiles.has(d.path));
    const paths = [...new Set(inClass.map((d) => d.path))];
    if (paths.length !== 1) return r;
    const d = inClass.find((x) => x.path === paths[0]);
    return { ...r, conf: "resolved", to_path: paths[0], to_symbol: r.ref_name,
      to_lines: `${d.line_start}-${d.line_end}`, candidates: [] };
  });
}
