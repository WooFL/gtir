#include <sdk.h>

// Registered with the host SDK as the render entry point: invoked by the host, never by in-repo code.
// All of its calls resolve external -> it is external-facing, not dead.
void EffectRender() {
    SDK_BeginRender();
    SDK_DrawQuad();
    SDK_EndRender();
}

// Genuinely dead: defined, no in-repo caller, and makes no external calls either.
int unusedHelper() {
    return 42;
}
