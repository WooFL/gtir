// Encoder batches values and flushes them as one frame.
class Encoder {
public:
    int flush();
    int drive();
private:
    int count;
};

int Encoder::flush() {
    int n = count;
    count = 0;
    return n;
}

int Encoder::drive() {
    return this->flush();
}
