package p

// Square is a Shaper implementer: a four-sided shape parameterized by its side length.
type Square struct {
	side float64
}

// Area returns the area of the square, side*side. This satisfies the Shaper interface,
// so a call on a Shaper-typed receiver can dispatch here as well as to Circle.
func (q Square) Area() float64 {
	return q.side * q.side
}

// Perimeter returns the total length of the square's four sides.
func (q Square) Perimeter() float64 {
	return 4 * q.side
}
