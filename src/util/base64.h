// Base64（标准字母表，带 '=' 补齐）。
//
// 为什么需要它：API Key 的落盘格式是 `'enc:' + base64(DPAPI 密文)`，
// 这是 oracle（Electron 的 safeStorage + store.js）定下来的**兼容格式** ——
// 老用户的 settings.json 直接拿来就要能读（纲领 §3.5 的"老配置可直接读"）。
// 明文兜底那条也是 `'raw:' + base64(明文)`（对齐 Node 的 Buffer.toString('base64')）。
#pragma once

#include <string>

namespace isg {

/* 编码。**永不失败**，没有可失败的分支。 */
std::string base64_encode(const std::string& bytes);

/* 解码。遇到非法字符返回 false（不静默跳过、不猜）—— 解错的 Key 会表现为"401"，
   一路查下去很难想到是解码器把坏字符吃掉了。 */
bool base64_decode(const std::string& text, std::string& out);

}  // namespace isg
