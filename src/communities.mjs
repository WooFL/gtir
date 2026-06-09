// src/communities.mjs — pure, deterministic Leiden community detection on an undirected weighted graph.
// `adj`: Map<node, Map<neighbor, weight>>, symmetric, no self-loops, weights > 0. Leiden = Louvain
// local-moving + a refinement phase that guarantees each reported community is internally connected.

// Standard modularity for a partition `community` (Map<node, id>). 2m = sum of all (directed) adjacency
// weights; Σ_in_c counts edges with both ends in c (directed); Σ_tot_c is the summed weighted degree of c.
export function modularity(adj, community) {
  let m2 = 0;
  const k = new Map();
  for (const [n, nb] of adj) { let s = 0; for (const w of nb.values()) s += w; k.set(n, s); m2 += s; }
  if (m2 === 0) return 0;
  const inC = new Map(), totC = new Map();
  for (const [n, nb] of adj) {
    const c = community.get(n);
    totC.set(c, (totC.get(c) ?? 0) + k.get(n));
    for (const [nbr, w] of nb) if (community.get(nbr) === c) inC.set(c, (inC.get(c) ?? 0) + w);
  }
  let Q = 0;
  for (const c of totC.keys()) {
    const sin = inC.get(c) ?? 0, st = totC.get(c);
    Q += sin / m2 - (st / m2) * (st / m2);
  }
  return Q;
}

// ---- internal graph form: { nodes, edges:[a,b,w] (a<b), self:Map<node,weight> } ----
// `self` carries aggregation self-loops; weighted degree k(n) = 2*self(n) + Σ incident edge weights.

function toGraph(adj) {
  const nodes = [...adj.keys()].sort();
  const edges = [];
  const seen = new Set();
  for (const [a, nb] of adj) for (const [b, w] of nb) {
    if (a === b) continue;
    const key = a < b ? `${a}\x01${b}` : `${b}\x01${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(a < b ? [a, b, w] : [b, a, w]);
  }
  return { nodes, edges, self: new Map() };
}

function buildNbr(g) {
  const nbr = new Map(g.nodes.map((n) => [n, new Map()]));
  for (const [a, b, w] of g.edges) {
    nbr.get(a).set(b, (nbr.get(a).get(b) ?? 0) + w);
    nbr.get(b).set(a, (nbr.get(b).get(a) ?? 0) + w);
  }
  return nbr;
}

function degrees(g) {
  const k = new Map(g.nodes.map((n) => [n, (g.self.get(n) ?? 0) * 2]));
  for (const [a, b, w] of g.edges) { k.set(a, k.get(a) + w); k.set(b, k.get(b) + w); }
  let m2 = 0;
  for (const v of k.values()) m2 += v;
  return { k, m2 };
}

// One Louvain local-move pass-to-convergence. initComm: Map<node, communityId> initial assignment.
// restrict (optional): Map<node, label> — a node may only join a neighbor whose restrict-label equals its
// own (used by refinement to keep moves inside one P-community). Returns { community, moved }.
function localMove(g, nbr, k, m2, initComm, restrict) {
  const community = new Map(initComm);
  const totC = new Map();
  for (const n of g.nodes) totC.set(community.get(n), (totC.get(community.get(n)) ?? 0) + k.get(n));
  let improved = false, moved = false;
  do {
    improved = false;
    for (const i of g.nodes) {
      const ci = community.get(i), ki = k.get(i);
      const kiIn = new Map();
      for (const [j, w] of nbr.get(i)) {
        if (restrict && restrict.get(j) !== restrict.get(i)) continue;
        const cj = community.get(j);
        kiIn.set(cj, (kiIn.get(cj) ?? 0) + w);
      }
      totC.set(ci, totC.get(ci) - ki);
      // Gain baseline (staying) uses totC[ci] AFTER removing ki — i.e. "i rejoins ci". For every other
      // candidate c, totC[c] still excludes ki (i was never in c). This asymmetry is the correct Louvain ΔQ.
      let best = ci, bestGain = (kiIn.get(ci) ?? 0) - (totC.get(ci) ?? 0) * ki / m2;
      for (const [c, kin] of kiIn) {
        const gain = kin - (totC.get(c) ?? 0) * ki / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) { best = c; bestGain = gain; }
      }
      totC.set(best, (totC.get(best) ?? 0) + ki);
      community.set(i, best);
      if (best !== ci) { improved = true; moved = true; }
    }
  } while (improved);
  return { community, moved };
}

// Leiden refinement: within each P-community, start singletons and constrained-local-move so a node only
// joins a sub-community in its OWN P-community. Singleton start + join-only-connected ⇒ every resulting
// sub-community is internally CONNECTED. Returns Map<node, refinedId>.
function refine(g, nbr, k, m2, P) {
  const singletons = new Map(g.nodes.map((n) => [n, `${n}`]));
  return localMove(g, nbr, k, m2, singletons, P).community;
}

// Aggregate by `refined`: super-nodes = refined sub-communities; carry each super-node's P-community as the
// next level's Pinit (Leiden's "aggregate by refinement, initialise by P"). Returns { g, Pinit }.
function aggregate(g, refined, Pof) {
  const newSelf = new Map(), Pinit = new Map();
  for (const n of g.nodes) {
    const c = refined.get(n);
    newSelf.set(c, (newSelf.get(c) ?? 0) + (g.self.get(n) ?? 0));
    Pinit.set(c, Pof.get(n));
  }
  const interW = new Map();
  for (const [a, b, w] of g.edges) {
    const ca = refined.get(a), cb = refined.get(b);
    if (ca === cb) { newSelf.set(ca, (newSelf.get(ca) ?? 0) + w); }
    else { const key = ca < cb ? `${ca}\x01${cb}` : `${cb}\x01${ca}`; interW.set(key, (interW.get(key) ?? 0) + w); }
  }
  const nodes = [...new Set(g.nodes.map((n) => refined.get(n)))].sort();
  const edges = [];
  for (const [key, w] of interW) { const [a, b] = key.split("\x01"); edges.push([a, b, w]); }
  const self = new Map();
  for (const c of nodes) self.set(c, newSelf.get(c) ?? 0);
  return { g: { nodes, edges, self }, Pinit };
}

export function leiden(adj, { maxLevels = 20 } = {}) {
  let g = toGraph(adj);
  let mapping = new Map(g.nodes.map((n) => [n, n]));
  let Pinit = new Map(g.nodes.map((n) => [n, n]));
  for (let lvl = 0; lvl < maxLevels; lvl++) {
    const nbr = buildNbr(g), { k, m2 } = degrees(g);
    if (m2 === 0) break;
    const { community: P, moved } = localMove(g, nbr, k, m2, Pinit);
    if (!moved && new Set(P.values()).size === g.nodes.length) break;
    const refined = refine(g, nbr, k, m2, P);
    for (const [orig, sn] of mapping) mapping.set(orig, refined.get(sn));
    const agg = aggregate(g, refined, P);
    if (agg.g.nodes.length === g.nodes.length) break;
    g = agg.g; Pinit = agg.Pinit;
  }
  const finalC = new Map();
  for (const [orig, sn] of mapping) finalC.set(orig, Pinit.get(sn) ?? sn);
  const sizes = new Map();
  for (const c of finalC.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const order = [...sizes.keys()].sort((a, b) => (sizes.get(b) - sizes.get(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const relabel = new Map(order.map((c, i) => [c, i]));
  const community = new Map();
  for (const [n, c] of finalC) community.set(n, relabel.get(c));
  return { community, modularity: modularity(adj, community) };
}

// Public seam over the Leiden refinement: split each community of `community` into internally-connected
// sub-communities (singleton-start constrained local move). Returns Map<node, refinedId> with dense
// relabelled ids. This is the guarantee Louvain lacks; also useful standalone.
export function refinePartition(adj, community) {
  const g = toGraph(adj);
  const nbr = buildNbr(g), { k, m2 } = degrees(g);
  if (m2 === 0) return new Map(community);
  const refined = refine(g, nbr, k, m2, community);
  const firstKey = new Map();
  for (const n of g.nodes) { const c = refined.get(n); if (!firstKey.has(c)) firstKey.set(c, n); }
  const order = [...firstKey.keys()].sort((a, b) => (firstKey.get(a) < firstKey.get(b) ? -1 : 1));
  const relabel = new Map(order.map((c, i) => [c, i]));
  const out = new Map();
  for (const n of g.nodes) out.set(n, relabel.get(refined.get(n)));
  return out;
}
