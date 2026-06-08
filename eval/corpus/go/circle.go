package p

import "math"

// Circle is a Shaper implementer: a round shape parameterized by its radius.
type Circle struct {
	radius float64
}

// Area returns the area of the circle, pi*r^2. This satisfies the Shaper interface,
// so a call on a Shaper-typed receiver can dispatch here.
func (c Circle) Area() float64 {
	return math.Pi * c.radius * c.radius
}

// Perimeter returns the circumference of the circle.
func (c Circle) Perimeter() float64 {
	return 2 * math.Pi * c.radius
}
