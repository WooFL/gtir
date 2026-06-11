// src/connections.mjs — note-to-note "connections" ranking for `gtir serve /connections`.
// Pure scoring core (linkProximity / proximityScore / fuseConnections) + an async orchestrator
// (computeConnections) that reuses the existing store, edge graph, and embedder seam.
import { basename } from "node:path";
import { openStore } from "./store.mjs";
import { buildGraph } from "./edge-graph.mjs";

const RRF_K = 60; // same canonical constant the search fusion uses

// Wikilink proximity from note `fromPath` to each candidate. Links are treated as undirected
// for relatedness. Returns hop distance (<= hops, else null) and co-citation (shared out- and
// in-neighbors). Graph note-nodes are bare paths (nodeKey(path, null) === path).
export function linkProximity(graph, fromPath, candidatePaths, { hops = 2 } = {}) {
  const neigh = (key) => new Set([...(graph.fwd.get(key) || []), ...(graph.rev.get(key) || [])]);
  const dist = new Map([[fromPath, 0]]);
  let frontier = [fromPath];
  for (let d = 1; d <= hops && frontier.length; d++) {
    const next = [];
    for (const k of frontier) for (const nb of neigh(k)) {
      if (dist.has(nb)) continue;
      dist.set(nb, d); next.push(nb);
    }
    frontier = next;
  }
  const fromOut = graph.fwd.get(fromPath) || new Set();
  const fromIn = graph.rev.get(fromPath) || new Set();
  const out = new Map();
  for (const cand of candidatePaths) {
    if (cand === fromPath) continue;
    let coCite = 0;
    for (const x of (graph.fwd.get(cand) || [])) if (fromOut.has(x)) coCite++;
    for (const x of (graph.rev.get(cand) || [])) if (fromIn.has(x)) coCite++;
    out.set(cand, { hop: dist.has(cand) ? dist.get(cand) : null, coCite });
  }
  return out;
}

// Map graph facts -> a [0,1] proximity weight. A direct link is the strongest signal (1);
// a 2-hop link is half; co-citation contributes up to 0.5 (saturating at 3 shared neighbors).
export function proximityScore({ hop, coCite } = {}) {
  const hopPart = hop === 1 ? 1 : hop === 2 ? 0.5 : 0;
  const citePart = 0.5 * (Math.min(coCite || 0, 3) / 3);
  return Math.min(1, Math.max(hopPart, citePart));
}

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*#*$/;

// First markdown heading's text, anywhere in the chunk; "" if none.
export function sectionOf(text) {
  for (const line of String(text || "").split("\n")) {
    const m = HEADING_LINE.exec(line.trim());
    if (m) return m[1];
  }
  return "";
}

// First ~200 chars of body, with heading lines and blank lines removed, whitespace collapsed.
export function snippetOf(text) {
  const body = String(text || "").split("\n")
    .filter((l) => l.trim() && !HEADING_LINE.test(l.trim()))
    .join(" ").replace(/\s+/g, " ").trim();
  return body.length > 200 ? body.slice(0, 200).trimEnd() : body;
}

// Lexical query for note N: its de-slugified title plus every heading it contains.
export function lexicalQuery(path, ownChunks) {
  const title = basename(String(path)).replace(/\.(md|mdx)$/i, "").replace(/[-_]+/g, " ");
  const headings = [];
  for (const c of ownChunks || []) {
    for (const line of String(c.text || "").split("\n")) {
      const m = HEADING_LINE.exec(line.trim());
      if (m) headings.push(m[1]);
    }
  }
  return [title, ...headings].join("\n");
}

// Structural/boilerplate heading words shared by templated notes (module pages etc). Overlap on these
// is noise — they label sections, they aren't distinctive concepts — so they're dropped from the term
// annotations (`why` tags + `terms[]` highlights). This does NOT affect lexical ranking: the FTS query
// is built from the raw title+headings string (lexicalQuery), not from queryTermsOf.
const STRUCTURAL_TERMS = new Set([
  "purpose", "responsibilities", "responsibility", "overview", "summary", "threading", "related",
  "decisions", "decision", "public", "shipped", "used", "status", "definition", "section", "sections",
  "coupling", "runtime", "model", "data", "state", "dependencies", "context", "references", "notes",
  "body", "shape", "canonical", "milestone", "callout", "frontmatter", "example", "examples", "usage",
  "background", "motivation", "scope", "responsibility", "consumer", "consumers", "module", "modules",
]);

// Unique lowercase tokens of length >= 4 (drops stopword-ish short words and structural heading boilerplate).
export function queryTermsOf(text) {
  const seen = new Set();
  for (const t of String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (t.length >= 4 && !STRUCTURAL_TERMS.has(t)) seen.add(t);
  }
  return [...seen];
}

// The longest query term that appears in `text` (case-insensitive); null if none.
export function bestTerm(text, terms) {
  const hay = String(text || "").toLowerCase();
  let best = null;
  for (const t of terms || []) {
    if (hay.includes(t) && (best === null || t.length > best.length)) best = t;
  }
  return best;
}

// Every query term that appears in `text` (case-insensitive), longest first — the full shared vocabulary
// that links the two notes. Powers per-node word highlighting in the editor/graph.
export function allTerms(text, terms) {
  const hay = String(text || "").toLowerCase();
  return (terms || []).filter((t) => hay.includes(t)).sort((a, b) => b.length - a.length);
}

// Pure fusion. RRF over the semantic and lexical ranks (equal weight), then a bounded
// link-graph multiplier (<= 1 + connGraphWeight). A candidate with no graph proximity keeps
// multiplier 1 — the graph re-ranks, it never promotes a no-basis result. Emits why-tags.
// (exported first so computeConnections below can call it)
export function fuseConnections(entries, proximity, cfg = {}) {
  const gw = cfg.connGraphWeight ?? 0.25;
  const out = (entries || []).map((e) => {
    let rrf = 0;
    if (e.sem) rrf += 1 / (RRF_K + e.sem.rank);
    if (e.lex) rrf += 1 / (RRF_K + e.lex.rank);
    const prox = proximity.get(e.path) || null;
    const mult = 1 + gw * (prox ? proximityScore(prox) : 0);
    const repr = e.sem || e.lex;
    const why = [];
    if (e.sem) why.push("semantic");
    if (e.lex) why.push(e.lex.term ? `term:${e.lex.term}` : "lexical");
    if (prox) {
      if (prox.hop === 1) why.push("link:1hop");
      else if (prox.hop === 2) why.push("link:2hop");
      if (prox.coCite > 0) why.push(`link:co-cited×${prox.coCite}`);
    }
    return {
      path: e.path,
      score: Number((rrf * mult).toFixed(4)),
      section: sectionOf(repr.text),
      snippet: snippetOf(repr.text),
      lines: `${repr.lineStart}-${repr.lineEnd}`,
      why,
      terms: e.lex?.terms ?? [],   // shared vocabulary (open-note title/heading terms present in this note)
    };
  });
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out;
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Rank notes related to the note at `path`. Reuses stored chunk embeddings (no re-embed) for the
// semantic branch, an FTS query built from the note's title+headings for the lexical branch, and
// the wikilink graph for proximity. Returns { note, results } (or { error } / { note, results:[],
// status } for the empty cases).
export async function computeConnections(cfg, { path, k } = {}) {
  if (!path) return { error: "path is required" };
  const limit = Math.max(1, Math.min(50, (k ?? cfg.connK ?? 12) | 0 || 12));
  const store = await openStore(cfg);
  const tbl = await store.chunksTable();
  if (!tbl) return { error: "no index — run: gtir index" };

  const own = (await tbl.query().where(`path = ${sqlStr(path)}`).toArray())
    .sort((a, b) => Number(a.line_start) - Number(b.line_start));
  if (own.length === 0) return { note: path, results: [], status: "not-indexed" };

  const fanout = Math.max(limit * 3, 16);

  // 1. SEMANTIC — vector NN per own chunk; keep the best (highest-sim) chunk per candidate note.
  const sem = new Map(); // candPath -> { sim, lineStart, lineEnd, text }
  for (const c of own) {
    if (!c.embedding) continue;
    const rows = await tbl.search(Array.from(c.embedding)).distanceType("cosine").limit(fanout + 4).toArray();
    for (const r of rows) {
      if (r.path === path) continue;
      const sim = 1 - Number(r._distance ?? 0);
      const prev = sem.get(r.path);
      if (!prev || sim > prev.sim) sem.set(r.path, { sim, lineStart: Number(r.line_start), lineEnd: Number(r.line_end), text: r.text });
    }
  }

  // 2. LEXICAL — FTS over a query built from N's title + headings; first hit per candidate note.
  const queryText = lexicalQuery(path, own);
  const qTerms = queryTermsOf(queryText);
  const lex = new Map(); // candPath -> { lineStart, lineEnd, text, term }
  if (queryText.trim()) {
    let rows = [];
    try { rows = await tbl.query().nearestToText(queryText, ["fts_text"]).limit(fanout).toArray(); }
    catch { try { rows = await tbl.query().nearestToText(queryText).limit(fanout).toArray(); } catch { rows = []; } }
    for (const r of rows) {
      if (r.path === path || lex.has(r.path)) continue;
      lex.set(r.path, { lineStart: Number(r.line_start), lineEnd: Number(r.line_end), text: r.text, term: bestTerm(r.text, qTerms), terms: allTerms(r.text, qTerms) });
    }
  }

  // ranks (1-based; sorted best-first)
  const semRank = new Map([...sem.entries()].sort((a, b) => b[1].sim - a[1].sim).map(([p], i) => [p, i + 1]));
  const lexRank = new Map([...lex.keys()].map((p, i) => [p, i + 1]));

  // 3. GRAPH proximity (optional)
  let proximity = new Map();
  if (cfg.connFusion !== false && (await store.hasEdges())) {
    const graph = buildGraph(await store.loadEdges());
    const cands = [...new Set([...sem.keys(), ...lex.keys()])];
    proximity = linkProximity(graph, path, cands, { hops: cfg.connGraphHops ?? 2 });
  }

  // 4. FUSE
  const entries = [...new Set([...sem.keys(), ...lex.keys()])].map((p) => ({
    path: p,
    sem: sem.has(p) ? { rank: semRank.get(p), ...sem.get(p) } : null,
    lex: lex.has(p) ? { rank: lexRank.get(p), ...lex.get(p) } : null,
  }));
  return { note: path, results: fuseConnections(entries, proximity, cfg).slice(0, limit) };
}

const noteLabel = (p) => basename(String(p)).replace(/\.(md|mdx)$/i, "");
const topDir = (p) => { const s = String(p).replace(/\\/g, "/"); const i = s.indexOf("/"); return i >= 0 ? s.slice(0, i) : ""; };
const isMd = (p) => /\.(md|mdx)$/i.test(String(p));

// Neighborhood graph around `path` for the Connections graph view: the note's ranked related notes
// (computeConnections) plus their wikilink neighbors out to `hops`, with the link/embeds edges among
// them and center→related "semantic" edges where no link exists. Returns { center, nodes, edges }
// (or { error } / { center, nodes:[], edges:[], status:"not-indexed" }). Markdown-only.
export async function graphNeighborhood(cfg, { path, k, hops, max } = {}) {
  if (!path) return { error: "path is required" };
  const K = Math.max(1, Math.min(30, (k ?? cfg.connK ?? 12) | 0 || 12));
  const HOPS = Math.max(0, Math.min(2, hops ?? 1));
  const MAX = Math.max(4, Math.min(80, (max ?? 40) | 0 || 40));
  const store = await openStore(cfg);
  const tbl = await store.chunksTable();
  if (!tbl) return { error: "no index — run: gtir index" };
  const ownRows = await tbl.query().where(`path = ${sqlStr(path)}`).limit(1).toArray();
  if (ownRows.length === 0) return { center: path, nodes: [], edges: [], status: "not-indexed" };

  // 1. ranked related notes (semantic ⊕ lexical ⊕ link-graph). Keep the full result per path (not just
  // the score) so graph nodes can surface WHAT triggered the link — section, why[], rank — on hover.
  const conn = await computeConnections(cfg, { path, k: K });
  const related = new Map((conn.results || []).map((r, i) => [r.path, { score: r.score, section: r.section, why: r.why, snippet: r.snippet, rank: i + 1, terms: r.terms }]));

  // 2. wikilink graph (notes are bare-path nodes)
  const graph = (await store.hasEdges()) ? buildGraph(await store.loadEdges()) : { fwd: new Map(), rev: new Map() };
  const neigh = (key) => new Set([...(graph.fwd.get(key) || []), ...(graph.rev.get(key) || [])]);

  // 3. node set: center + related, expanded by HOPS through link-neighbors, md-only, capped at MAX
  const nodes = new Set([path, ...related.keys()].filter(isMd));
  let frontier = [...nodes];
  for (let d = 0; d < HOPS && nodes.size < MAX; d++) {
    const next = [];
    for (const n of frontier) {
      for (const nb of neigh(n)) {
        if (!isMd(nb) || nodes.has(nb)) continue;
        nodes.add(nb); next.push(nb);
        if (nodes.size >= MAX) break;
      }
      if (nodes.size >= MAX) break;
    }
    frontier = next;
  }

  // 4. link/embed edges + link-degree within the node set
  const degree = new Map();
  const linkEdges = [];
  const linked = new Set();
  for (const a of nodes) {
    for (const b of neigh(a)) {
      if (!nodes.has(b) || a === b) continue;
      degree.set(a, (degree.get(a) || 0) + 1);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (linked.has(key)) continue;
      linked.add(key);
      linkEdges.push({ from: a, to: b, kind: "link" });
    }
  }

  // 5. center→related "semantic" edges where no wikilink already connects them
  const semEdges = [];
  for (const r of related.keys()) {
    if (!nodes.has(r) || r === path) continue;
    const key = path < r ? `${path}|${r}` : `${r}|${path}`;
    if (!linked.has(key)) semEdges.push({ from: path, to: r, kind: "semantic" });
  }

  // 6. node objects (weight: related→score-scaled, pure-link→degree-scaled), center first, cap
  const maxScore = Math.max(0.0001, ...[...related.values()].map((v) => v?.score).filter((v) => v != null));
  const nodeList = [...nodes].map((p) => {
    const rel = related.get(p);
    const score = rel?.score;
    const weight = score != null
      ? 0.4 + 0.6 * (score / maxScore)
      : Math.min(1, 0.2 + 0.1 * (degree.get(p) || 0));
    const node = { path: p, label: noteLabel(p), group: topDir(p), weight: Number(weight.toFixed(3)), center: p === path };
    // Hover trigger info (only for ranked-related notes; pure-link/hop nodes have no "why").
    if (rel) { node.section = rel.section; node.why = rel.why; node.score = Number((rel.score ?? 0).toFixed(3)); node.rank = rel.rank; node.terms = rel.terms; }
    return node;
  }).sort((a, b) => Number(b.center) - Number(a.center) || b.weight - a.weight).slice(0, MAX);

  const kept = new Set(nodeList.map((n) => n.path));
  const edges = [...linkEdges, ...semEdges].filter((e) => kept.has(e.from) && kept.has(e.to));
  return { center: path, nodes: nodeList, edges };
}
