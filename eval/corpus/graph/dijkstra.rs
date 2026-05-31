use std::collections::BinaryHeap;
use std::cmp::Reverse;

/// Dijkstra's shortest-path algorithm on a weighted adjacency list.
/// Returns distances from `src`; unreachable nodes stay at `u64::MAX`.
pub fn dijkstra(adj: &[Vec<(usize, u64)>], src: usize) -> Vec<u64> {
    let n = adj.len();
    let mut dist = vec![u64::MAX; n];
    dist[src] = 0;
    // Min-heap of (distance, node).
    let mut heap = BinaryHeap::new();
    heap.push(Reverse((0u64, src)));
    while let Some(Reverse((d, u))) = heap.pop() {
        if d > dist[u] { continue; }
        for &(v, w) in &adj[u] {
            let nd = d.saturating_add(w);
            if nd < dist[v] {
                dist[v] = nd;
                heap.push(Reverse((nd, v)));
            }
        }
    }
    dist
}

/// Reconstruct the shortest path by following parent pointers.
pub fn reconstruct_path(parents: &[Option<usize>], dst: usize) -> Vec<usize> {
    let mut path = Vec::new();
    let mut cur = dst;
    loop {
        path.push(cur);
        match parents[cur] {
            Some(p) if p != cur => cur = p,
            _ => break,
        }
    }
    path.reverse();
    path
}
