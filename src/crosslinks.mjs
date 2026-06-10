// src/crosslinks.mjs — cross-corpus note->code mention bridge. Resolves code-shaped identifiers and
// file paths a note mentions against a LINKED code index's symbol inventory + file set. No embedding —
// pure symbol/path matching, so the wiki(nomic)/code(qwen3) model mismatch is irrelevant.
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { openStore } from "./store.mjs";
import { buildSymbolInventory, graphForSearch } from "./graph-queries.mjs";
import { queryIdentifiers } from "./search.mjs";
import { nodeKey } from "./edge-graph.mjs";

const CODE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|hpp|cs|java|kt|rb|swift)";
const PATH_RE = new RegExp(`(?:packages|apps|src|lib|tools|scripts)/[\\w\\-./]+\\.${CODE_EXT}`, "g");
const STOP = new Set(["this", "true", "false", "null", "function", "return", "const", "async", "await", "import", "export", "class", "interface", "type", "value", "string", "number", "object"]);

function headLines(text, n) {
  return String(text || "").split("\n").slice(0, n).join("\n");
}

// Suffix-match a mentioned path against the code index's file set (paths are repo-relative).
function matchFile(mention, files) {
  if (files.has(mention)) return mention;
  for (const f of files) { if (f.endsWith("/" + mention) || mention.endsWith("/" + f)) return f; }
  return null;
}

// Pure: note text -> code links, filtered by the inventory/file-set (only real symbols/files link).
export function crossLinks(codeInv, codeFiles, noteText, { cap = 15 } = {}) {
  const text = String(noteText || "");
  const links = [];
  const seen = new Set();

  // symbols: code-shaped identifiers that are DEFINED in the code index
  const freq = new Map();
  for (const t of queryIdentifiers(text)) {
    if (t.length < 4 || STOP.has(t) || STOP.has(t.toLowerCase())) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  for (const [t, count] of freq) {
    const sites = codeInv.byName.get(t);
    if (!sites) continue;
    for (const s of sites) {
      const key = `${s.path}#${t}`;
      if (seen.has(key)) continue; seen.add(key);
      links.push({
        kind: "symbol", symbol: t, path: s.path,
        lines: s.line_start != null ? `${s.line_start}-${s.line_end}` : undefined,
        snippet: headLines(s.text, 5), _rank: count + (t.length / 100),
      });
    }
  }

  // file paths that EXIST in the code index
  for (const m of text.match(PATH_RE) || []) {
    const hit = matchFile(m, codeFiles);
    if (!hit) continue;
    const key = `${hit}#file`;
    if (seen.has(key)) continue; seen.add(key);
    links.push({ kind: "file", path: hit, snippet: "", _rank: 0.5 });
  }

  links.sort((a, b) => b._rank - a._rank);
  return links.slice(0, Math.max(0, cap)).map(({ _rank, ...l }) => l);
}

// Invert per-note code links into code-keyed maps. Pure. NoteRef = { note, lines?, snippet? }.
// linksByNote: { [notePath]: Array<{ kind?, symbol?, path, lines?, snippet? }> }
export function invertLinks(linksByNote) {
  const bySymbol = new Map();
  const byPath = new Map();
  const push = (map, key, ref) => {
    if (!key) return;
    let a = map.get(key);
    if (!a) { a = []; map.set(key, a); }
    if (!a.some((r) => r.note === ref.note)) a.push(ref);
  };
  for (const [note, rows] of Object.entries(linksByNote || {})) {
    for (const row of rows || []) {
      const ref = {
        note,
        ...(row.lines ? { lines: row.lines } : {}),
        ...(row.snippet ? { snippet: row.snippet } : {}),
      };
      if ((row.kind === undefined || row.kind === "symbol") && row.symbol) push(bySymbol, row.symbol, ref);
      if (row.path) push(byPath, row.path, ref);
    }
  }
  return { bySymbol, byPath };
}

// Notes that document a code site: union of name + path matches, deduped per note, capped. Pure.
export function notesFor(rev, { symbol = null, path = null } = {}, cap = 8) {
  const out = [];
  const seen = new Set();
  const add = (refs) => {
    for (const r of refs || []) {
      if (seen.has(r.note)) continue;
      seen.add(r.note);
      out.push(r);
    }
  };
  if (symbol) add(rev.bySymbol.get(symbol));   // symbol matches first (carry the symbol's lines)
  if (path) add(rev.byPath.get(path));
  return out.slice(0, Math.max(0, cap));
}

const _codeCache = new Map(); // indexDir -> { inv, files }

// Build (once per code index) the symbol inventory + file set the resolver needs. Heavy on a big
// repo, so cached for the process lifetime (mirrors graphForSearch's cache).
export async function codeIndexFor(codeCfg) {
  const key = codeCfg.indexDir;
  if (_codeCache.has(key)) return _codeCache.get(key);
  const store = await openStore(codeCfg);
  const inv = await buildSymbolInventory(store, "code");
  const man = await store.loadManifest();
  const entry = { inv, files: new Set(Object.keys(man)) };
  _codeCache.set(key, entry);
  return entry;
}
export function clearCodeCache(indexDir) { indexDir ? _codeCache.delete(indexDir) : _codeCache.clear(); }

const _revCache = new Map(); // `${wikiIndexDir}=>${codeIndexDir}` -> { bySymbol, byPath }
const revKey = (wikiCfg, codeCfg) => `${wikiCfg.indexDir}=>${codeCfg.indexDir}`;
export function clearReverseCache(key) { key ? _revCache.delete(key) : _revCache.clear(); }

// Read the stale baseline JSON directly. Returns the parsed doc or null. NOTE: deliberately NOT
// imported from stale-run.mjs — that module imports this one (codeIndexFor/crossLinks), so the
// reverse import would be circular.
function readBaselineFile(wikiCfg) {
  try {
    const p = join(wikiCfg.gtirDir, "stale-baselines.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

// code key -> notes that cite it, cached per (wiki,code) index pair for the process lifetime.
// Source: the precise stale baseline when present; else live crossLinks over every note (slower).
export async function reverseLinks(wikiCfg, codeCfg, { deps = {}, baselineOnly = false } = {}) {
  const key = revKey(wikiCfg, codeCfg);
  if (_revCache.has(key)) return _revCache.get(key);

  const base = (deps.readBaseline || readBaselineFile)(wikiCfg);
  let linksByNote;
  if (base && base.links && Object.keys(base.links).length) {
    linksByNote = base.links;
  } else if (baselineOnly) {
    return invertLinks({}); // hook fast-path: no baseline -> empty, never the live scan; not cached
  } else {
    const wikiStore = await openStore(wikiCfg);
    const rows = await wikiStore.allChunkRows(["path"]);
    const notePaths = [...new Set(rows.map((r) => r.path))];
    linksByNote = {};
    for (const note of notePaths) {
      try { linksByNote[note] = await codeLinksFor(wikiCfg, codeCfg, note); }
      catch { linksByNote[note] = []; }  // one unresolvable note must not sink the whole reverse index
    }
  }
  const rev = invertLinks(linksByNote);
  _revCache.set(key, rev);
  return rev;
}

// Read a note's chunk text from the wiki index, resolve its code references against the code index.
export async function codeLinksFor(wikiCfg, codeCfg, notePath, { cap } = {}) {
  if (!notePath) return [];
  const wikiStore = await openStore(wikiCfg);
  const rows = await wikiStore.chunksByPath(notePath);
  if (!rows.length) return [];
  const noteText = rows.map((r) => r.text).join("\n");
  const { inv, files } = await codeIndexFor(codeCfg);
  return crossLinks(inv, files, noteText, { cap: cap ?? wikiCfg.crossLinkCap ?? 15 });
}

// Caller->callee edges AMONG the shown symbols only (set intersection over the resolved call
// graph). Never introduces a new symbol node. Returns { callEdges:[{fromPath,fromSymbol,toPath,
// toSymbol}] }. Needs >=2 shown symbols to have any edge between them.
export async function codeStructure(codeCfg, codeLinks) {
  const symbols = (codeLinks || []).filter((c) => (c.kind === undefined || c.kind === "symbol") && c.symbol);
  if (symbols.length < 2) return { callEdges: [] };
  // graphForSearch caches by indexDir; a config missing it would silently share one cache slot
  // across repos. Fail fast instead.
  if (!codeCfg?.indexDir) throw new Error("codeStructure: codeCfg.indexDir required");
  const { graph } = await graphForSearch(codeCfg);
  const keyMeta = new Map(); // nodeKey -> { path, symbol }
  for (const s of symbols) keyMeta.set(nodeKey(s.path, s.symbol), { path: s.path, symbol: s.symbol });
  const callEdges = [];
  const seen = new Set();
  for (const [key, from] of keyMeta) {
    const callees = graph.fwd.get(key);
    if (!callees) continue;
    for (const dst of callees) {
      const to = keyMeta.get(dst);
      if (!to) continue;                    // callee not among shown symbols -> skip
      const ek = `${key}->${dst}`;
      if (seen.has(ek)) continue; seen.add(ek);
      callEdges.push({ fromPath: from.path, fromSymbol: from.symbol, toPath: to.path, toSymbol: to.symbol });
    }
  }
  return { callEdges };
}

// Append code structure to a graphNeighborhood() result. Emits, per the note's resolved codeLinks:
//   - symbol nodes (kind:"code", label `symbol · file`), id `code:<path>#<symbol>`
//   - file nodes  (kind:"file"), id `codefile:<path>`
//   - note->symbol  edges (kind:"code"), note->file edges for directly-cited files (kind:"code")
//   - symbol->file  containment edges (kind:"code-file")
//   - symbol<->symbol call edges (kind:"code-call") from struct.callEdges (both ends must be shown)
// Pure. File nodes are derived here from codeLinks paths; struct only carries the call edges (which
// need the async call graph). 2-arg calls (no struct) still work — they just emit no call edges.
export function augmentGraphWithCode(graph, codeLinks, { callEdges = [] } = {}) {
  if (!Array.isArray(codeLinks) || codeLinks.length === 0) return graph;
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  const seen = new Set(nodes.map((n) => n.path));
  const fileId = (p) => `codefile:${p}`;
  const addFile = (p, noteEdge) => {
    const id = fileId(p);
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ path: id, label: basename(p), group: "code", weight: 0.5, center: false, kind: "file", codePath: p });
    }
    if (noteEdge && !edges.some((e) => e.from === graph.center && e.to === id && e.kind === "code"))
      edges.push({ from: graph.center, to: id, kind: "code" });
    return id;
  };
  for (const c of codeLinks) {
    if ((c.kind === "file" || !c.symbol)) { addFile(c.path, true); continue; }   // directly-cited file
    const id = `code:${c.path}#${c.symbol}`;
    if (seen.has(id)) continue; seen.add(id);
    nodes.push({
      path: id, label: `${c.symbol} · ${basename(c.path)}`, group: "code", weight: 0.6, center: false,
      kind: "code", codePath: c.path, lines: c.lines, snippet: c.snippet,
    });
    edges.push({ from: graph.center, to: id, kind: "code" });   // note -> symbol
    const fid = addFile(c.path, false);                          // file node (no note edge from the symbol's file)
    edges.push({ from: id, to: fid, kind: "code-file" });        // containment
  }
  for (const ce of callEdges) {
    const from = `code:${ce.fromPath}#${ce.fromSymbol}`;
    const to = `code:${ce.toPath}#${ce.toSymbol}`;
    if (seen.has(from) && seen.has(to)) edges.push({ from, to, kind: "code-call" });
  }
  return { ...graph, nodes, edges };
}
