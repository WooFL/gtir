import { createHash } from "node:crypto";
import { getParser } from "./parser.mjs";
import { langFor, targetTypes } from "./languages.mjs";
import { chunkMarkdown } from "./markdown.mjs";

const CONTAINER_TYPES = new Set([
  "class_declaration", "abstract_class_declaration", "class_definition",
  "interface_declaration", "enum_declaration", "module_declaration",
  "internal_module", "namespace_declaration",
  "impl_item", "trait_item", "mod_item",
]);

// The declared name of a node: prefer the `name` field, else the first
// identifier-like named child. null when none (anonymous).
function nodeName(n) {
  const f = n.childForFieldName ? n.childForFieldName("name") : null;
  if (f && f.text) return f.text;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;
  }
  return null;
}

// Names of the container ancestors enclosing `node`, outermost first.
function scopeBreadcrumb(node) {
  const parts = [];
  for (let p = node.parent; p; p = p.parent) {
    if (CONTAINER_TYPES.has(p.type)) {
      const nm = nodeName(p);
      if (nm) parts.unshift(nm);
    }
  }
  return parts;
}


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
    // Carry trailing overlapChars-worth of lines into the next bucket. Never
    // carry the whole bucket — that would re-emit it as a duplicate chunk on the
    // next flush (e.g. a single line ≥ maxChars). Carry at most a proper suffix.
    const carry = [];
    let carryChars = 0;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (carryChars >= overlapChars) break;
      if (carry.length >= bucket.length - 1) break; // keep carry a proper suffix
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

// A collected node is a leaf iff no OTHER collected node is nested inside its
// span. Oversize leaves get re-split; oversize containers (which have nested
// target nodes) are dropped so their members surface as their own chunks.
function isLeaf(n, nodes) {
  return !nodes.some((m) => m !== n && m.startIndex >= n.startIndex && m.endIndex <= n.endIndex);
}

// cAST refinement: greedily merge adjacent nodes (source order) whose combined
// span stays within maxChars. Replaces the "drop everything < minChars" rule
// for small declarations so consecutive helpers index as one coherent unit.
function mergeSiblings(nodes, text, langId, relPath, cfg) {
  const out = [];
  let group = null; // { startIndex, endIndex, startRow, endRow }
  const flush = () => {
    if (!group) return;
    const body = text.slice(group.startIndex, group.endIndex).trim();
    if (body.length >= cfg.minChars) {
      const scope = scopeBreadcrumb(group.node);
      out.push({
        path: relPath, language: langId,
        chunkStart: group.startIndex, chunkEnd: group.endIndex,
        lineStart: group.startRow + 1, lineEnd: group.endRow + 1, text: body,
        ...(scope.length ? { scope } : {}),
      });
    }
    group = null;
  };
  for (const n of nodes) {
    const span = n.endIndex - n.startIndex;
    // Oversize node: flush the current group, then handle it specially (below). An oversize
    // *leaf* (a >maxChars function with no nested target nodes) is re-split into line-aware
    // windows; an oversize *container* (class/impl/mod) is skipped — its members were collected
    // as their own nodes and surface separately.
    if (span > cfg.maxChars) {
      flush();
      // Oversize *leaf* (no nested target node): re-split into line-aware windows
      // via chunkRecursive and offset its positions back to the file, instead of
      // dropping it. Oversize *containers* are still dropped here — their members
      // were collected separately and surface as their own chunks.
      if (isLeaf(n, nodes)) {
        const slice = text.slice(n.startIndex, n.endIndex);
        for (const s of chunkRecursive(relPath, langId, slice, cfg)) {
          // chunkRecursive stores chunkStart at the line-start in the slice, but
          // the stored text is trimmed. Adjust chunkStart forward by the number
          // of leading whitespace characters that trim() removed so that
          // text.slice(chunkStart, chunkStart + text.length) === text holds.
          const absLineStart = s.chunkStart + n.startIndex;
          const leadTrim = text.slice(absLineStart).search(/\S/);
          const trimmedStart = absLineStart + (leadTrim >= 0 ? leadTrim : 0);
          // Windows of an oversize leaf: include the leaf's own name in the scope,
          // since each window's first line is an interior line, not the declaration.
          const own = nodeName(n);
          const leafScope = [...scopeBreadcrumb(n), ...(own ? [own] : [])];
          out.push({
            ...s,
            chunkStart: trimmedStart,
            chunkEnd: trimmedStart + s.text.length,
            lineStart: s.lineStart + n.startPosition.row,
            lineEnd: s.lineEnd + n.startPosition.row,
            ...(leafScope.length ? { scope: leafScope } : {}),
          });
        }
      }
      continue;
    }
    if (group && (n.endIndex - group.startIndex) <= cfg.maxChars) {
      group.endIndex = n.endIndex; group.endRow = n.endPosition.row; group.node = n;
    } else {
      flush();
      group = { startIndex: n.startIndex, endIndex: n.endIndex,
        startRow: n.startPosition.row, endRow: n.endPosition.row, node: n };
    }
  }
  flush();
  return out;
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

  const chunks = mergeSiblings(nodes, text, langId, relPath, cfg);
  return chunks.length ? chunks : chunkRecursive(relPath, langId, text, cfg);
}

export async function chunkFile(relPath, ext, text, cfg) {
  const langId = langFor(ext);
  if (langId === "markdown") return chunkMarkdown(relPath, text, cfg);
  if (langId === null) return chunkRecursive(relPath, ext.replace(/^\./, ""), text, cfg);
  return chunkWithTreesitter(relPath, langId, text, cfg);
}
