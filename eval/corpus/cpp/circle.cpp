#include "shape.h"

// Circle is a concrete Shape implementer: it overrides the abstract area()/name().
class Circle : public Shape {
public:
  explicit Circle(double r) : radius(r) {}
  double area() const override;
  const char *name() const override { return "circle"; }
private:
  double radius;
};

double Circle::area() const {
  return 3.14159 * radius * radius;
}
