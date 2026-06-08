#include "pipeline.h"

// Out-of-class definition: enc_ is a member field declared in pipeline.h, not a local or
// parameter here. Resolving enc_->flush() to Encoder::flush (and away from the equally-named
// Sink::flush) requires the cross-file field index — Pipeline's body holds no type for enc_.
int Pipeline::run() {
    return enc_->flush();
}
