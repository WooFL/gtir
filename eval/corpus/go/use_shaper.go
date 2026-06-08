package p

// totalArea calls Area on a Shaper-typed parameter — an interface dispatch to Circle/Square.
func totalArea(s Shaper) float64 {
	return s.Area()
}
