// src/communities-run.mjs — impure orchestration for `gtir communities`: edge graph -> undirected weighted
// adjacency -> leiden -> assembled report (communities, god-nodes, bridges).
import { openStore } from "./store.mjs";
import { buildGraph } from "./edge-graph.mjs";
import { leiden } from "./communities.mjs";

// node key -> file-level node (strip "#symbol") or keep full key for symbol level.
const fileOf = (key) => { const h = key.indexOf("#"); return h >= 0 ? key.slice(0, h) : key; };

// Build an undirected weighted adjacency from the edge graph's link list. level: "file" | "symbol".
// CALL edges only — imports/links/embeds are excluded so a community means "files whose functions call
// each other densely" (a crisp call-graph clustering, not a mixed dependency graph). Weight(a,b) = number
// of call links between a and b (both directions collapse onto the unordered pair). Self-links (both
// endpoints collapse to the same node) are dropped. Pure given `edgeGraph`.
export function buildUndirected(edgeGraph, { level = "file" } = {}) {
  const collapse = level === "symbol" ? ((k) => k) : fileOf;
  const adj = new Map();
  const bump = (a, b, w) => { if (!adj.has(a)) adj.set(a, new Map()); adj.get(a).set(b, (adj.get(a).get(b) ?? 0) + w); };
  for (const lk of edgeGraph.edgeList) {
    if (lk.kind !== "calls") continue;
    const a = collapse(lk.src), b = collapse(lk.dst);
    if (a === b) continue;
    bump(a, b, 1); bump(b, a, 1);
  }
  return { adj };
}

// Most-common top-2-segment directory among a community's members (a readable label) — but a test
// directory (test/ tests/ spec/ __tests__/) only wins when EVERY member is under one, since gtir's tests
// co-cluster with the src they exercise and would otherwise drown out the real module name.
function dirLabel(members) {
  const isTest = (d) => /^(tests?|spec|__tests__)(\/|$)/i.test(d);
  const counts = new Map();
  for (const m of members) {
    const parts = String(m).split(/[\\/]/).filter(Boolean);
    parts.pop(); // drop filename
    const d = parts.slice(0, 2).join("/") || "(root)";
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  // Rank non-test dirs above test dirs; within a tier, higher count wins; ties broken alphabetically.
  let best = "(root)", n = -1, bestTest = true;
  for (const [d, c] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const t = isTest(d);
    if ((bestTest && !t) || (bestTest === t && c > n)) { best = d; n = c; bestTest = t; }
  }
  return best;
}

// Assemble the report from a weighted adjacency: run leiden, then derive communities (sorted by size),
// cross-community bridge edges, and god-nodes (nodes touching the most distinct other communities). Pure.
export function assembleReport(adj, { minSize = 1, godLimit = 15, bridgeLimit = 25 } = {}) {
  const { community, modularity } = leiden(adj);
  const byComm = new Map();
  for (const [n, c] of community) { if (!byComm.has(c)) byComm.set(c, []); byComm.get(c).push(n); }
  const communities = [...byComm.entries()]
    .map(([id, members]) => ({ id, size: members.length, label: dirLabel(members), members: members.slice().sort() }))
    .filter((c) => c.size >= minSize)
    .sort((a, b) => b.size - a.size || a.id - b.id);

  const seen = new Set();
  const bridges = [];
  const otherComms = new Map();
  for (const [a, nb] of adj) for (const [b, w] of nb) {
    const ca = community.get(a), cb = community.get(b);
    if (ca === cb) continue;
    if (!otherComms.has(a)) otherComms.set(a, new Set());
    otherComms.get(a).add(cb);
    const key = a < b ? `${a}\x01${b}` : `${b}\x01${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bridges.push({ a, b, weight: w, ca, cb });
  }
  bridges.sort((x, y) => y.weight - x.weight || (x.a < y.a ? -1 : 1));

  const godNodes = [...otherComms.entries()]
    .map(([node, set]) => ({ node, communities: set.size, community: community.get(node) }))
    .sort((x, y) => y.communities - x.communities || (x.node < y.node ? -1 : 1))
    .slice(0, godLimit);

  return {
    communities, godNodes, bridges: bridges.slice(0, bridgeLimit),
    modularity: Math.round(modularity * 1000) / 1000,
    nodeCount: adj.size, communityCount: byComm.size,
  };
}

export async function communitiesQuery(cfg, { level = "file", includeAmbiguous = false, minSize = 1 } = {}) {
  const store = await openStore(cfg);
  if (!(await store.hasEdges())) return { error: "no edge index — run: gtir index" };
  const graph = buildGraph(await store.loadEdges(), { includeAmbiguous });
  const { adj } = buildUndirected(graph, { level });
  if (adj.size === 0) return { communities: [], godNodes: [], bridges: [], modularity: 0, nodeCount: 0, communityCount: 0 };
  return assembleReport(adj, { minSize });
}
