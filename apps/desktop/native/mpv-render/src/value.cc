#include "value.h"

#include <cmath>

namespace wicaby {

Value Value::String(std::string s) {
  Value v;
  v.kind = Kind::kString;
  v.str = std::move(s);
  return v;
}

Value Value::Int(int64_t i) {
  Value v;
  v.kind = Kind::kInt;
  v.i = i;
  return v;
}

Value Value::Map() {
  Value v;
  v.kind = Kind::kMap;
  return v;
}

void Value::Set(std::string key, Value v) {
  keys.push_back(std::move(key));
  items.push_back(std::move(v));
}

Value FromNode(const mpv_node& node) {
  Value v;
  switch (node.format) {
    case MPV_FORMAT_STRING:
    case MPV_FORMAT_OSD_STRING:
      v.kind = Value::Kind::kString;
      v.str = node.u.string ? node.u.string : "";
      break;
    case MPV_FORMAT_FLAG:
      v.kind = Value::Kind::kFlag;
      v.flag = node.u.flag != 0;
      break;
    case MPV_FORMAT_INT64:
      v.kind = Value::Kind::kInt;
      v.i = node.u.int64;
      break;
    case MPV_FORMAT_DOUBLE:
      v.kind = Value::Kind::kDouble;
      v.d = node.u.double_;
      break;
    case MPV_FORMAT_NODE_ARRAY:
    case MPV_FORMAT_NODE_MAP: {
      const bool map = node.format == MPV_FORMAT_NODE_MAP;
      v.kind = map ? Value::Kind::kMap : Value::Kind::kArray;
      const mpv_node_list* list = node.u.list;
      for (int i = 0; list && i < list->num; i++) {
        v.items.push_back(FromNode(list->values[i]));
        if (map) v.keys.emplace_back(list->keys[i] ? list->keys[i] : "");
      }
      break;
    }
    default:  // NONE, BYTE_ARRAY
      break;
  }
  return v;
}

Napi::Value ToJs(Napi::Env env, const Value& v) {
  switch (v.kind) {
    case Value::Kind::kString:
      return Napi::String::New(env, v.str);
    case Value::Kind::kFlag:
      return Napi::Boolean::New(env, v.flag);
    case Value::Kind::kInt:
      return Napi::Number::New(env, static_cast<double>(v.i));
    case Value::Kind::kDouble:
      return Napi::Number::New(env, v.d);
    case Value::Kind::kArray: {
      Napi::Array a = Napi::Array::New(env, v.items.size());
      for (size_t i = 0; i < v.items.size(); i++) a.Set(static_cast<uint32_t>(i), ToJs(env, v.items[i]));
      return a;
    }
    case Value::Kind::kMap: {
      Napi::Object o = Napi::Object::New(env);
      for (size_t i = 0; i < v.items.size(); i++) o.Set(v.keys[i], ToJs(env, v.items[i]));
      return o;
    }
    case Value::Kind::kNone:
      break;
  }
  return env.Null();
}

char* NodeBuilder::Keep(std::string s) {
  strings_.push_back(std::move(s));
  return &strings_.back()[0];
}

bool NodeBuilder::Build(Napi::Value v, mpv_node* out, std::string* error, int depth) {
  if (depth > 32) {
    *error = "value nested too deeply";
    return false;
  }
  if (v.IsNull() || v.IsUndefined()) {
    out->format = MPV_FORMAT_NONE;
  } else if (v.IsString()) {
    out->format = MPV_FORMAT_STRING;
    out->u.string = Keep(v.As<Napi::String>().Utf8Value());
  } else if (v.IsBoolean()) {
    out->format = MPV_FORMAT_FLAG;
    out->u.flag = v.As<Napi::Boolean>().Value() ? 1 : 0;
  } else if (v.IsNumber()) {
    const double d = v.As<Napi::Number>().DoubleValue();
    // Integral numbers go as INT64 so integer options and command arguments
    // (aid, playlist indices) accept them; mpv also accepts INT64 for doubles.
    if (std::isfinite(d) && d == std::trunc(d) && std::fabs(d) <= 9007199254740992.0) {
      out->format = MPV_FORMAT_INT64;
      out->u.int64 = static_cast<int64_t>(d);
    } else {
      out->format = MPV_FORMAT_DOUBLE;
      out->u.double_ = d;
    }
  } else if (v.IsBigInt()) {
    bool lossless = false;
    out->format = MPV_FORMAT_INT64;
    out->u.int64 = v.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless) {
      *error = "bigint out of int64 range";
      return false;
    }
  } else if (v.IsArray()) {
    Napi::Array a = v.As<Napi::Array>();
    const uint32_t n = a.Length();
    nodes_.emplace_back(n);
    std::vector<mpv_node>& items = nodes_.back();
    for (uint32_t i = 0; i < n; i++)
      if (!Build(a.Get(i), &items[i], error, depth + 1)) return false;
    lists_.push_back(mpv_node_list{static_cast<int>(n), items.data(), nullptr});
    out->format = MPV_FORMAT_NODE_ARRAY;
    out->u.list = &lists_.back();
  } else if (v.IsObject() && !v.IsFunction()) {
    Napi::Object o = v.As<Napi::Object>();
    Napi::Array names = o.GetPropertyNames();
    const uint32_t n = names.Length();
    nodes_.emplace_back(n);
    keys_.emplace_back(n);
    std::vector<mpv_node>& items = nodes_.back();
    std::vector<char*>& keys = keys_.back();
    for (uint32_t i = 0; i < n; i++) {
      Napi::Value key = names.Get(i);
      keys[i] = Keep(key.ToString().Utf8Value());
      if (!Build(o.Get(key), &items[i], error, depth + 1)) return false;
    }
    lists_.push_back(mpv_node_list{static_cast<int>(n), items.data(), keys.data()});
    out->format = MPV_FORMAT_NODE_MAP;
    out->u.list = &lists_.back();
  } else {
    *error = "unsupported value type";
    return false;
  }
  return true;
}

}  // namespace wicaby
