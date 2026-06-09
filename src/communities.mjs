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
