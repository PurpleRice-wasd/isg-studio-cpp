// 字符串小工具。**只处理 UTF-8 的字节层面**，不做 Unicode 归一化
// （本项目要的 trim / 大小写 / 切分，全部只需要 ASCII 语义）。
#pragma once

#include <string>
#include <vector>

namespace isg {

/* 去掉首尾的空白（空格、\t、\n、\r）。对应 JS 的 String.prototype.trim()
   —— 注意 JS 的 trim 还会去掉 \v\f 与一堆 Unicode 空白；这里按 ASCII 处理，
   对本项目手上的输入（路径、模型 id、.env 的值）足够，而且行为可预期。 */
std::string trim(const std::string& s);

/* ASCII 小写。别拿它处理中文（本来也没有大小写）。 */
std::string ascii_lower(const std::string& s);

bool starts_with(const std::string& s, const std::string& prefix);
bool ends_with(const std::string& s, const std::string& suffix);

/* 按单个字符切分。s 为空时返回空表（**不是**含一个空串的表）——
   与 `''.split(x)` 在 JS 里得到 `['']` 的区别是刻意的：调用点都是"有没有内容"。 */
std::vector<std::string> split(const std::string& s, char sep);

std::string join(const std::vector<std::string>& parts, const std::string& sep);

/* 全部替换。 */
std::string replace_all(const std::string& s, const std::string& from, const std::string& to);

/* 按 UTF-8 **码点**截断到至多 n 个字符（不是字节）。
   为什么需要：oracle 里那些 `v.slice(0, TEXT_MAX)` 是字符语义，
   直接按字节切会把一个汉字切成两半，产出非法 UTF-8。 */
std::string utf8_truncate(const std::string& s, size_t maxCodepoints);

/* 码点个数（粗略：按 UTF-8 前导字节数）。 */
size_t utf8_length(const std::string& s);

}  // namespace isg
