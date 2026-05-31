import { createHash } from "node:crypto";
import { getParser } from "./parser.mjs";
import { langFor, targetTypes } from "./languages.mjs";

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

// Walk the tree collecting every node whose .type is in `typeSet`. Dedupe by
// byte span. Port of flow.py's find_nodes_by_type + the seen-span dedupe.
function collectNodes(root, typeSet) {
  const found = new Map(); // `${start}:${end}` -> node
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (typeSet.has(n.type)) found.set(`${n.startIndex}:${n.endIndex}`, n);
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return [...found.values()].sort((a, b) => a.startIndex - b.startIndex);
}

export async function chunkWithTreesitter(relPath, langId, text, cfg) {
  const types = targetTypes(langId);
  if (types.length === 0) return chunkRecursive(relPath, langId, text, cfg);
  const parser = await getParser(langId);
  if (!parser) return chunkRecursive(relPath, langId, text, cfg);

  let tree;
  try { tree = parser.parse(text); } catch { return chunkRecursive(relPath, langId, text, cfg); }
  const nodes = collectNodes(tree.rootNode, new Set(types));
  if (nodes.length === 0) return chunkRecursive(relPath, langId, text, cfg);

  const chunks = [];
  for (const n of nodes) {
    const body = text.slice(n.startIndex, n.endIndex).trim();
    if (body.length < cfg.minChars || body.length > cfg.maxChars) continue;
    chunks.push({
      path: relPath, language: langId,
      chunkStart: n.startIndex, chunkEnd: n.endIndex,
      lineStart: n.startPosition.row + 1, lineEnd: n.endPosition.row + 1,
      text: body,
    });
  }
  return chunks.length ? chunks : chunkRecursive(relPath, langId, text, cfg);
}

export async function chunkFile(relPath, ext, text, cfg) {
  const langId = langFor(ext);
  if (langId === null) return chunkRecursive(relPath, ext.replace(/^\./, ""), text, cfg);
  return chunkWithTreesitter(relPath, langId, text, cfg);
}
