// Electron's executable links Chromium's own libffmpeg.so (DT_NEEDED), which
// exports unversioned av_*/sw* symbols into the process's global scope. ELF
// lookup searches the global scope first, so when libmpv is dlopen()ed the
// system libavcodec/libavformat/... and libmpv itself bind their calls into
// each other to Chromium's FFmpeg build instead (seen with LD_DEBUG=bindings:
// ~1100 such bindings, and "Failed to initialize a decoder for codec
// 'wrapped_avframe'"). RTLD_DEEPBIND would fix the lookup order but also
// binds malloc/free in every newly loaded library to glibc while the rest of
// the process uses Chromium's allocator shim, which crashed in vaInitialize.
//
// So after dlopen(RTLD_NOW) this rewrites, in the objects that dlopen just
// loaded, every symbol relocation that resolved into Chromium's libffmpeg.so
// to the definition libmpv's own dependency tree provides (dlsym on the libmpv
// handle searches only that tree). Without Chromium's FFmpeg in the process
// (plain Node) it does nothing.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace wicaby {

// Base addresses of the objects loaded right now; take it before dlopen.
std::vector<uintptr_t> LoadedObjects();

// Returns false with *error set if some binding could not be redirected, in
// which case libmpv must not be used. *patched counts rewritten relocations.
bool RebindChromiumFfmpeg(void* mpv_handle, const std::vector<uintptr_t>& before, int* patched,
                          std::string* error);

}  // namespace wicaby
