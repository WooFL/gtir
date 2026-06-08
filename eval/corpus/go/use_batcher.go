package proxy

// runBatch drives a Batcher through a typed parameter; b.Flush must resolve to Batcher.Flush.
func runBatch(b *Batcher) int {
	b.Add(1)
	b.Add(2)
	return b.Flush()
}

// viaVar exercises a var-declared receiver; b.Add must resolve to Batcher.Add.
func viaVar() {
	var b Batcher
	b.Add(3)
}
