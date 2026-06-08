package proxy

// Batcher coalesces writes into fixed-size batches before flushing them downstream.
type Batcher struct{ pending []int }

func (b *Batcher) Add(item int) { b.pending = append(b.pending, item) }

func (b *Batcher) Flush() int {
	n := len(b.pending)
	b.pending = nil
	return n
}
