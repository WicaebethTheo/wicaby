#include "ffmpeg_rebind.h"

#include <dlfcn.h>
#include <elf.h>
#include <link.h>
#include <sys/mman.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>

namespace wicaby {
namespace {

#if defined(__x86_64__)
constexpr uint32_t kGlobDat = R_X86_64_GLOB_DAT;
constexpr uint32_t kJumpSlot = R_X86_64_JUMP_SLOT;
constexpr uint32_t kAbs64 = R_X86_64_64;
#define WICABY_REBIND 1
#elif defined(__aarch64__)
constexpr uint32_t kGlobDat = R_AARCH64_GLOB_DAT;
constexpr uint32_t kJumpSlot = R_AARCH64_JUMP_SLOT;
constexpr uint32_t kAbs64 = R_AARCH64_ABS64;
#define WICABY_REBIND 1
#endif

struct Object {
  uintptr_t base;
  std::string name;
  const ElfW(Phdr) * phdr;
  int phnum;
};

int Collect(dl_phdr_info* info, size_t, void* data) {
  static_cast<std::vector<Object>*>(data)->push_back(
      {static_cast<uintptr_t>(info->dlpi_addr), info->dlpi_name ? info->dlpi_name : "", info->dlpi_phdr,
       info->dlpi_phnum});
  return 0;
}

std::vector<Object> Objects() {
  std::vector<Object> objects;
  dl_iterate_phdr(Collect, &objects);
  return objects;
}

bool EndsWith(const std::string& s, const char* suffix) {
  const size_t n = std::strlen(suffix);
  return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

struct Range {
  uintptr_t lo = UINTPTR_MAX;
  uintptr_t hi = 0;
  bool Contains(uintptr_t a) const { return a >= lo && a < hi; }
};

#ifdef WICABY_REBIND
// Rewrites one object's relocations. RELRO pages are made writable for the
// duration and read-only again afterwards.
bool Patch(const Object& obj, const Range& chromium, void* handle, int* patched, std::string* error) {
  const ElfW(Dyn)* dyn = nullptr;
  uintptr_t relro_lo = 0, relro_hi = 0;
  for (int i = 0; i < obj.phnum; i++) {
    if (obj.phdr[i].p_type == PT_DYNAMIC) dyn = reinterpret_cast<const ElfW(Dyn)*>(obj.base + obj.phdr[i].p_vaddr);
    if (obj.phdr[i].p_type == PT_GNU_RELRO) {
      relro_lo = obj.base + obj.phdr[i].p_vaddr;
      relro_hi = relro_lo + obj.phdr[i].p_memsz;
    }
  }
  if (!dyn) return true;
  // glibc relocates d_ptr in place on these architectures; be tolerant of
  // loaders that do not.
  auto ptr = [&](ElfW(Addr) p) { return p < obj.base ? p + obj.base : p; };
  const ElfW(Sym)* symtab = nullptr;
  const char* strtab = nullptr;
  const ElfW(Rela)* rela = nullptr;
  size_t rela_size = 0;
  const ElfW(Rela)* jmprel = nullptr;
  size_t jmprel_size = 0;
  bool plt_is_rela = true;
  for (const ElfW(Dyn)* d = dyn; d->d_tag != DT_NULL; d++) {
    switch (d->d_tag) {
      case DT_SYMTAB:
        symtab = reinterpret_cast<const ElfW(Sym)*>(ptr(d->d_un.d_ptr));
        break;
      case DT_STRTAB:
        strtab = reinterpret_cast<const char*>(ptr(d->d_un.d_ptr));
        break;
      case DT_RELA:
        rela = reinterpret_cast<const ElfW(Rela)*>(ptr(d->d_un.d_ptr));
        break;
      case DT_RELASZ:
        rela_size = d->d_un.d_val;
        break;
      case DT_JMPREL:
        jmprel = reinterpret_cast<const ElfW(Rela)*>(ptr(d->d_un.d_ptr));
        break;
      case DT_PLTRELSZ:
        jmprel_size = d->d_un.d_val;
        break;
      case DT_PLTREL:
        plt_is_rela = d->d_un.d_val == DT_RELA;
        break;
    }
  }
  if (!symtab || !strtab) return true;
  if (!plt_is_rela) jmprel = nullptr;  // not used on x86_64/aarch64

  // Like glibc's _dl_protect_relro: the start rounds down and the end rounds
  // DOWN too. A partial last page is shared with .data/.got.plt, stays
  // writable, and must not be made read-only on 16K/64K-page kernels, where
  // linkers pad RELRO only to the 4K common page size.
  const long page = sysconf(_SC_PAGESIZE);
  const uintptr_t prot_lo = relro_lo & ~static_cast<uintptr_t>(page - 1);
  const uintptr_t prot_hi = relro_hi & ~static_cast<uintptr_t>(page - 1);
  bool unprotected = false;
  bool ok = true;
  auto fix = [&](const ElfW(Rela)* rel, size_t bytes) {
    for (size_t i = 0; rel && i < bytes / sizeof(ElfW(Rela)); i++) {
      const uint32_t type = ELF64_R_TYPE(rel[i].r_info);
      const uint32_t index = ELF64_R_SYM(rel[i].r_info);
      if (!index || (type != kGlobDat && type != kJumpSlot && type != kAbs64)) continue;
      auto* where = reinterpret_cast<uintptr_t*>(obj.base + rel[i].r_offset);
      const uintptr_t addend = type == kAbs64 ? static_cast<uintptr_t>(rel[i].r_addend) : 0;
      if (!chromium.Contains(*where - addend)) continue;
      const char* name = strtab + symtab[index].st_name;
      void* real = dlsym(handle, name);
      if (!real || chromium.Contains(reinterpret_cast<uintptr_t>(real))) {
        *error = std::string("cannot rebind ") + name + " in " + obj.name;
        ok = false;
        continue;
      }
      // A slot outside [prot_lo, prot_hi) (no RELRO, or the tail page) is
      // already writable.
      const uintptr_t at = reinterpret_cast<uintptr_t>(where);
      if (!unprotected && prot_hi > prot_lo && at >= prot_lo && at < prot_hi) {
        if (mprotect(reinterpret_cast<void*>(prot_lo), prot_hi - prot_lo, PROT_READ | PROT_WRITE) != 0) {
          *error = "mprotect RELRO of " + obj.name + " failed";
          ok = false;
          return;
        }
        unprotected = true;
      }
      *where = reinterpret_cast<uintptr_t>(real) + addend;
      (*patched)++;
    }
  };
  fix(rela, rela_size);
  fix(jmprel, jmprel_size);
  if (unprotected && mprotect(reinterpret_cast<void*>(prot_lo), prot_hi - prot_lo, PROT_READ) != 0) {
    *error = "re-protect RELRO of " + obj.name + " failed";
    ok = false;
  }
  return ok;
}
#endif

}  // namespace

std::vector<uintptr_t> LoadedObjects() {
  std::vector<uintptr_t> bases;
  for (const Object& o : Objects()) bases.push_back(o.base);
  return bases;
}

bool RebindChromiumFfmpeg(void* handle, const std::vector<uintptr_t>& before, int* patched, std::string* error) {
  *patched = 0;
  const std::vector<Object> objects = Objects();
  Range chromium;
  for (const Object& o : objects) {
    if (!EndsWith(o.name, "/libffmpeg.so")) continue;
    for (int i = 0; i < o.phnum; i++) {
      if (o.phdr[i].p_type != PT_LOAD) continue;
      chromium.lo = std::min<uintptr_t>(chromium.lo, o.base + o.phdr[i].p_vaddr);
      chromium.hi = std::max<uintptr_t>(chromium.hi, o.base + o.phdr[i].p_vaddr + o.phdr[i].p_memsz);
    }
  }
  if (chromium.hi == 0) return true;  // not inside Electron
#ifdef WICABY_REBIND
  bool ok = true;
  for (const Object& o : objects) {
    if (std::find(before.begin(), before.end(), o.base) != before.end()) continue;
    if (chromium.Contains(o.base)) continue;
    ok = Patch(o, chromium, handle, patched, error) && ok;
  }
  return ok;
#else
  *error = "Chromium's libffmpeg.so is loaded and rebinding is not implemented for this architecture";
  return false;
#endif
}

}  // namespace wicaby
