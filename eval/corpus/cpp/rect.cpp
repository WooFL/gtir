#include "shape.h"

// Rect is a second concrete Shape implementer overriding the same virtuals as Circle.
class Rect : public Shape {
public:
  Rect(double w, double h) : width(w), height(h) {}
  double area() const override;
  const char *name() const override { return "rect"; }
private:
  double width;
  double height;
};

double Rect::area() const {
  return width * height;
}
