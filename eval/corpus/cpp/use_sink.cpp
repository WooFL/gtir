// runSink drives a Sink through a value-typed local; s.flush resolves to Sink::flush.
int runSink() {
    Sink s;
    return s.flush();
}
