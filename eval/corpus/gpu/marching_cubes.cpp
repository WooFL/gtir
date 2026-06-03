#include "grid.h"

// Marching cubes: turn a scalar field (a signed-distance or density volume) into a triangle mesh by
// classifying each cube of eight samples against an isovalue, then emitting triangles from a lookup
// table. Edge interpolation places each vertex exactly where the field crosses the isosurface.
int polygonize(const GridCell& cell, float iso, Triangle* out) {
  int cubeIndex = 0;
  for (int i = 0; i < 8; ++i)
    if (cell.value[i] < iso) cubeIndex |= (1 << i);
  if (edgeTable[cubeIndex] == 0) return 0;          // cube lies entirely inside or outside the surface
  Vec3 verts[12];
  for (int e = 0; e < 12; ++e)
    if (edgeTable[cubeIndex] & (1 << e))
      verts[e] = interpEdge(iso, cell, e);
  return emitTriangles(cubeIndex, verts, out);
}
