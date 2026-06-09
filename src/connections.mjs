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
