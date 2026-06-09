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

// Unique lowercase tokens of length >= 4 (drops stopword-ish short words).
export function queryTermsOf(text) {
  const seen = new Set();
  for (const t of String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (t.length >= 4) seen.add(t);
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
      lex.set(r.path, { lineStart: Number(r.line_start), lineEnd: Number(r.line_end), text: r.text, term: bestTerm(r.text, qTerms) });
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
