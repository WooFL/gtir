// Sink collects log lines and flushes them to the output stream.
class Sink {
public:
    int flush();
private:
    int lines;
};

int Sink::flush() {
    int n = lines;
    lines = 0;
    return n;
}
