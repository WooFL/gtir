import { createHash } from "node:crypto";

export function stableId(c) {
  const body = createHash("sha1").update(c.text, "utf8").digest("hex").slice(0, 8);
  return `${c.path}::${c.chunkStart}-${c.chunkEnd}::${body}`;
}

// Port of flow.py chunk_recursive: line-aware fixed-size windows with
// overlapChars of tail-overlap carried between adjacent windows.
export function chunkRecursive(relPath, langId, text, cfg) {
  const { maxChars, minChars, overlapChars } = cfg;
  const lines = text.split("\n");
  const chunks = [];
  let bucket = [];
  let bucketChars = 0;
  let startLine = 1;
  let lineNo = 0;

  // Precompute cumulative char offset at the start of each line (1-indexed).
  const lineCharStart = [0];
  for (let i = 0; i < lines.length; i++) lineCharStart.push(lineCharStart[i] + lines[i].length + 1);

  function flush(endLine) {
    if (bucket.length === 0) return;
    const body = bucket.join("\n").trim();
    if (body.length >= minChars) {
      const charStart = lineCharStart[startLine - 1];
      chunks.push({
        path: relPath, language: langId || "text",
        chunkStart: charStart, chunkEnd: charStart + body.length,
        lineStart: startLine, lineEnd: endLine, text: body,
      });
    }
    // Carry trailing overlapChars-worth of lines into the next bucket.
    const carry = [];
    let carryChars = 0;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (carryChars >= overlapChars) break;
      carry.unshift(bucket[i]);
      carryChars += bucket[i].length + 1;
    }
    bucket = carry;
    bucketChars = carryChars;
    startLine = endLine - carry.length + 1;
  }

  for (const line of lines) {
    lineNo++;
    bucket.push(line);
    bucketChars += line.length + 1;
    if (bucketChars >= maxChars) flush(lineNo);
  }
  flush(lineNo);
  return chunks;
}
