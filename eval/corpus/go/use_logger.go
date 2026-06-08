package proxy

// runLog drives a Logger through a typed parameter; l.Flush must resolve to Logger.Flush.
func runLog(l *Logger) int {
	l.Write("start")
	return l.Flush()
}
