#include <memory>

// runShared drives an Encoder through a std::shared_ptr; e->flush unwraps to Encoder::flush.
int runShared(std::shared_ptr<Encoder> e) {
    return e->flush();
}

// runGet calls the smart pointer's OWN method via `.`; get must stay external (not unwrapped to Encoder).
Encoder* runGet(std::shared_ptr<Encoder> e) {
    return e.get();
}
