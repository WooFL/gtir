package p

// Shaper is an interface; a call on a Shaper-typed receiver dispatches to its implementers.
type Shaper interface {
	Area() float64
}
