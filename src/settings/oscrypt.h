// **Chromium OSCrypt（Windows）格式**的加解密 —— 与 oracle 的 `safeStorage` 逐字节兼容。
//
// 为什么要做到这一层（而不是"我们自己 DPAPI 一下就行"）：
//   oracle 落盘的是 `'enc:' + base64(OSCrypt 密文)`。Electron 44 的 OSCrypt 在 Windows 上
//   **不是**直接 DPAPI 明文，而是：
//
//     · 密钥：32 字节随机密钥，用 DPAPI 保护后存在 `<userData>/Local State` 的
//       `os_crypt.encrypted_key` 里，形如 base64("DPAPI" + CryptProtectData(密钥))；
//     · 密文：`"v10"` + 12 字节 nonce + AES-256-GCM(明文) + 16 字节 tag。
//
//   一开始按"裸 DPAPI"实现，跨实现测试当场证伪：那串 64 字节里 `v10` 之后的 61 字节
//   = 12(nonce) + 33(明文) + 16(tag)，正好对上我们的 Key 长度 —— 而 CryptUnprotectData
//   对它返回 ERROR_INVALID_DATA（13）。**这条只有让 oracle 真的写一份才能发现**，
//   自己加密自己解密的测试永远发现不了。
//
// 兼容是双向的：本模块写出的东西，Electron 的 `safeStorage.decryptString` 也能读
// （tools/phase1-verify.ps1 有一条判据专门验这个方向）。
#pragma once

#include <string>

namespace isg {

/* 明文的密文形态（`"v10" + nonce + ct + tag` 的原始字节，不含 base64 与 `enc:` 前缀）。 */
bool oscrypt_encrypt(const std::string& plain, std::string& out, std::string& err);

/* 密文 → 明文。失败返回 false 并把可读原因写进 err（**不抛**）。 */
bool oscrypt_decrypt(const std::string& blob, std::string& out, std::string& err);

/* 这一次进程里密钥用的是什么形态（诊断用）。 */
const char* oscrypt_key_status();

/* 自测用：忘掉已缓存的密钥（换了 userData 之后要重读）。 */
void oscrypt_reset();

}  // namespace isg
