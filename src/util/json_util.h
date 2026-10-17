// JSON 这一层：把 nlohmann/json 收在一个头里，并补上"从文件读 / 往文件写"的惯用法。
//
// 归属：util/ —— 只做技术动作，不做业务判断。
//
// 为什么用 nlohmann/json（而不是自己写一个解析器、也不用 Windows.Data.Json）：
//   · settings.json / 桥消息 / 报告 / 模型输出全是 JSON，解析器是基础设施，
//     手写一个等于把"能不能读对"变成运气；
//   · WinRT 的 JsonObject 要拉一整套 WinRT 初始化，而且在非 UWP 宿主里很别扭。
// 版本固定在 v3.11.3（tools/fetch-deps.ps1 会校验 sha256），头文件只有 900 KB，只进构建不进交付物。
#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace isg {

/* ⚠️ 用 **ordered_json**，不是 json。
 *
 * 默认的 `nlohmann::json` 底层是 std::map —— 键按字典序排。那会让落盘的 settings.json
 * 与 oracle 生成的那份**字段顺序不同**（`active` 排到 `providers` 前面之类）。
 * 语义上无所谓，但这是"翻译而不是重写"的工程：文件是给用户看、给用户手改的
 * （设置页把路径显示给他了），顺序变了会让对拍、diff、以及老用户的心理预期全部错位。
 * `ordered_json` 保持插入顺序，与 JS 对象的属性顺序语义一致。代价可以忽略。 */
using Json = nlohmann::ordered_json;

/* 解析 JSON 文本。**失败不抛**（返回 false 并把原因写进 err）。
 *
 * 为什么默认不抛：本工程的宿主侧没有 try/catch（见 win_util.h 关于 kMaxFileBytes 的说明），
 * 一个手改坏的 settings.json 就能让 std::terminate 把整个收尾路径跳过。
 * 凡是"输入来自磁盘/来自网页"的地方，一律用这个不抛的版本。
 * 调用方**必须**检查返回值 —— 静默把失败读成"空对象"正是本项目最恨的一类失效。 */
bool json_parse(const std::string& text, Json& out, std::string& err);

/* 序列化。indent < 0 = 紧凑（桥消息用）；>=0 = 缩进（落盘的 settings.json 用，方便用户手看手改）。 */
std::string json_dump(const Json& v, int indent = -1);

/* 读一个 JSON 文件。文件不存在 / 读不动 / 不是合法 JSON 都返回 false 并给出可读原因。 */
bool json_read_file(const std::wstring& path, Json& out, std::string& err);

/* 原子写一个 JSON 文件：先写 <path>.tmp 再改名（中途断电不会留下半个坏 JSON）。
   目录不存在会自动创建。 */
bool json_write_file_atomic(const std::wstring& path, const Json& v, int indent, std::string& err);

}  // namespace isg
