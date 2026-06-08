package proxy

import "strings"

// useExternal calls a method on an imported stdlib value; b.WriteString must stay external
// (no in-corpus definition) — guards against over-resolution.
func useExternal() string {
	var b strings.Builder
	b.WriteString("hello")
	return b.String()
}
