// Pipeline owns an Encoder and drives it through a member field rather than a parameter.
// The flush() call lives in an out-of-class definition (pipeline.cpp), so the receiver's
// type is only knowable from this header's field declaration — the cross-file field case
// that same-AST member inference cannot reach.
class Encoder;

class Pipeline {
public:
    int run();
private:
    Encoder* enc_;
};
