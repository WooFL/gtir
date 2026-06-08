#include <string>

// runEncoder drives an Encoder through a typed pointer parameter; e->flush resolves to Encoder::flush.
int runEncoder(Encoder* e) {
    return e->flush();
}

// useStdString calls a stdlib method; str.size must stay external (no in-corpus definition).
unsigned long useStdString() {
    std::string str;
    return str.size();
}
