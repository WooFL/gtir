#include "shape.h"

// totalArea calls the virtual area() on a Shape-typed pointer — an abstract dispatch that resolves
// to every concrete implementer (Circle, Rect), since the runtime type is not known statically.
double totalArea(const Shape *s) {
  return s->area();
}
