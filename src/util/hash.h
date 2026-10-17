// 哈希（Windows CNG / BCrypt，系统自带，不引第三方）。
//
// 现在的用处：金标准对拍的报告里写"两份产物各是什么指纹"—— 比"逐字节相同"这句结论
// 更有用的是**两个具体数字**，因为将来谁想复核，拿同一份夹具重跑一遍就能对上，
// 不用相信这段话。
#pragma once

#include <string>

namespace isg {

/* 小写十六进制的 SHA-256。失败返回空串（不抛：宿主侧没有 try/catch）。 */
std::string sha256_hex(const std::string& bytes);
std::string sha256_hex(const void* data, size_t len);

}  // namespace isg
