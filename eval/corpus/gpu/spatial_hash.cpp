#include "particles.h"

// Spatial hashing for neighbour queries: bucket each particle into a grid cell by hashing its
// quantized position, so finding nearby particles becomes a scan of the adjacent cells instead of an
// O(n^2) all-pairs check. This is what makes SPH and position-based fluids run at interactive rates.
uint32_t cellHash(Vec3 p, float cellSize) {
  int3 c = int3(floor(p.x / cellSize), floor(p.y / cellSize), floor(p.z / cellSize));
  return (uint32_t(c.x) * 73856093u) ^ (uint32_t(c.y) * 19349663u) ^ (uint32_t(c.z) * 83492791u);
}

void buildNeighborGrid(const Particle* ps, int n, float cellSize, Grid& grid) {
  grid.clear();
  for (int i = 0; i < n; ++i)
    grid.insert(cellHash(ps[i].pos, cellSize), i);
}
