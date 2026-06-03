#include "field.h"

// Semi-Lagrangian advection: for each cell, trace the velocity backward in time to find where the
// quantity came from, then bilinearly sample the previous field there. It's unconditionally stable,
// which is why it's the workhorse transport step in real-time grid fluid solvers.
void advectVelocity(VelocityField& dst, const VelocityField& src, float dt) {
  for (int y = 0; y < src.height; ++y) {
    for (int x = 0; x < src.width; ++x) {
      Vec2 pos = {float(x), float(y)};
      Vec2 vel = src.sample(pos);
      Vec2 back = pos - vel * dt;            // trace this parcel backward through the field
      dst.at(x, y) = src.sampleBilinear(back);
    }
  }
}
