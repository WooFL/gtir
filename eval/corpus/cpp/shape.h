#pragma once

// Shape is an abstract base: a pure-virtual area() that every concrete shape overrides.
// A call on a Shape* / Shape& dispatches to the implementer that the object actually is.
class Shape {
public:
  virtual ~Shape() {}
  virtual double area() const = 0;
  virtual const char *name() const = 0;
};
