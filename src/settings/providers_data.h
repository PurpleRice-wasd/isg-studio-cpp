// 预设表的 JSON 快照（生成物，见 tools/gen-providers.py）。
// 单独一个头是为了让 CMake 只把 providers_data.generated.cpp 编一次，
// 而不是把 20 KB 的字符串塞进每个包含 providers.h 的翻译单元。
#pragma once

namespace isg {

// 预设表的 JSON 数组（内容与 oracle 的 providers.js 的 PRESETS 逐字节同源）。
extern const char kProvidersJson[];

}  // namespace isg
