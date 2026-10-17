// DPAPI（等价于 Electron 的 safeStorage）。
//
// **格式必须与 oracle 逐字节兼容**（纲领 §3.5「老用户配置可直接读」）：
//   settings.json 里存的是 `'enc:' + base64(DPAPI 密文)`，密文是
//   `CryptProtectData(明文, 描述=L"", 熵=无, 标志=0)` 的原始返回 —— 不加任何自己的包头。
//   Electron 的 safeStorage 就是这么做的（描述字段只是元数据，解密时不用它）。
//   明文兜底那条是 `'raw:' + base64(UTF-8 明文)`（对齐 Node 的 Buffer.toString('base64')）。
//
// 交叉证据不是"我读了源码"：tools/phase1-verify.ps1 会**用真的 Electron** 写一份带 Key 的
// settings.json，再让本模块把它读出来 —— 两边对得上才算兼容（见 selftest 的 keycompat）。
#pragma once

#include <string>

namespace isg {

/* 这台机器的系统加密可用吗？
   与 safeStorage.isEncryptionAvailable() 的口径一致：**真的跑一次往返**再回答，
   而不是"看 API 在不在"—— 后者在域策略禁掉 DPAPI 时照样返回 true。结果缓存。 */
bool encryption_available();

/* 加密 → base64（不含 `enc:` 前缀，前缀由 store 那一层拼）。
   失败返回空串并把原因写进 err。**失败绝不静默降级成明文**：
   降级由调用方显式决定（store 会退回 'raw:' 并置 keyStorage='plaintext'，界面要显式警告）。 */
std::string dpapi_encrypt_b64(const std::string& plain, std::string& err);

/* base64 → 解密。解不开（换了机器/换了账户）返回空串并置 err —— **不抛**，
   让用户重填就行，而不是让应用打不开。 */
std::string dpapi_decrypt_b64(const std::string& b64, std::string& err);

/* 裸字节版本（不给 base64）。
   用途：Chromium OSCrypt 的**密钥**是 `DPAPI(32 字节)` 直接拼在 `Local State` 里，
   没有 base64、也没有 `enc:` 前缀 —— 那一层由 oscrypt.cpp 自己管。 */
bool dpapi_encrypt_bytes(const std::string& plain, std::string& out, std::string& err);
bool dpapi_decrypt_bytes(const std::string& blob, std::string& out, std::string& err);

}  // namespace isg
