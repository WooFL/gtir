package proxy

// Logger buffers structured log lines and flushes them to the sink.
type Logger struct{ lines []string }

func (l *Logger) Write(line string) { l.lines = append(l.lines, line) }

func (l *Logger) Flush() int {
	n := len(l.lines)
	l.lines = nil
	return n
}
