// mpv_node <-> JS conversion. mpv's event data is only valid until the next
// mpv_wait_event(), so the event thread deep-copies it into a Value, which
// the JS thread later turns into JS values. NodeBuilder goes the other way and
// owns every string and list the resulting mpv_node points into.
#pragma once

#include <mpv/client.h>
#include <napi.h>

#include <cstdint>
#include <deque>
#include <string>
#include <utility>
#include <vector>

namespace wicaby {

struct Value {
  enum class Kind { kNone, kString, kFlag, kInt, kDouble, kArray, kMap };
  Kind kind = Kind::kNone;
  std::string str;
  bool flag = false;
  int64_t i = 0;
  double d = 0;
  std::vector<Value> items;       // array items, or map values
  std::vector<std::string> keys;  // map keys, parallel to items

  static Value String(std::string s);
  static Value Int(int64_t v);
  // An empty map; fill with Set().
  static Value Map();
  void Set(std::string key, Value v);
};

// Deep copy (any thread). Byte arrays become kNone.
Value FromNode(const mpv_node& node);
// JS thread only. int64 becomes a Number (exact up to 2^53).
Napi::Value ToJs(Napi::Env env, const Value& v);

class NodeBuilder {
 public:
  // JS thread only. string, boolean, number (integral -> INT64, else DOUBLE),
  // bigint, null/undefined, arrays and plain objects. Returns false with
  // *error set for anything else.
  bool Build(Napi::Value v, mpv_node* out, std::string* error) { return Build(v, out, error, 0); }

 private:
  bool Build(Napi::Value v, mpv_node* out, std::string* error, int depth);
  char* Keep(std::string s);

  // deques keep element addresses stable while the tree grows.
  std::deque<std::string> strings_;
  std::deque<std::vector<mpv_node>> nodes_;
  std::deque<std::vector<char*>> keys_;
  std::deque<mpv_node_list> lists_;
};

}  // namespace wicaby
