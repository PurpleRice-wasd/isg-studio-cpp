#include "oscrypt.h"

#include "dpapi.h"

#include "../app/app.h"
#include "../util/file_ops.h"
#include "../util/base64.h"
#include "../util/json_util.h"
#include "../util/log.h"
#include "../util/win_util.h"

#include <windows.h>
#include <bcrypt.h>

#include <string>
#include <vector>

namespace isg {

namespace {

constexpr char kVersionPrefix[] = "v10";
constexpr size_t kNonceLen = 12;
constexpr size_t kTagLen = 16;
constexpr size_t kKeyLen = 32;
constexpr char kDpapiTag[] = "DPAPI";      // Local State 里那 5 个字节的明文标记

std::string g_key;                          // 32 字节；空 = 还没读
std::string g_keyStatus = "未初始化";

std::wstring local_state_path() { return user_data_dir() + L"\\Local State"; }

/* BCrypt 的算法句柄拥有者（所有出口都要关）。 */
struct AlgHandle {
    BCRYPT_ALG_HANDLE h = nullptr;
    ~AlgHandle() { if (h != nullptr) ::BCryptCloseAlgorithmProvider(h, 0); }
};

/* **密钥句柄**的拥有者。
   ⚠️ 算法句柄不是密钥句柄：`BCryptEncrypt/Decrypt` 要的是
   `BCryptGenerateSymmetricKey()` 产出的那个，直接传算法句柄会得到
   STATUS_INVALID_HANDLE（0xC0000008）—— 而报错信息只会说"解密失败"，
   看起来像"密钥不对/换了机器"，与真因（传错了句柄）隔得很远。 */
struct KeyHandle {
    BCRYPT_KEY_HANDLE h = nullptr;
    ~KeyHandle() { if (h != nullptr) ::BCryptDestroyKey(h); }
};

bool make_key(BCRYPT_ALG_HANDLE alg, const std::string& key, KeyHandle& out, std::string& err) {
    if (!BCRYPT_SUCCESS(::BCryptGenerateSymmetricKey(
            alg, &out.h, nullptr, 0,
            reinterpret_cast<PUCHAR>(const_cast<char*>(key.data())),
            static_cast<ULONG>(key.size()), 0))) {
        err = "从 32 字节密钥建密钥句柄失败";
        return false;
    }
    return true;
}

/* 32 字节随机数（CNG 的 BCryptGenRandom，系统 CSPRNG）。 */
bool random_bytes(std::string& out, size_t n, std::string& err) {
    out.assign(n, '\0');
    if (!BCRYPT_SUCCESS(::BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(out.data()),
                                          static_cast<ULONG>(n), BCRYPT_USE_SYSTEM_PREFERRED_RNG))) {
        err = "生成随机数失败";
        return false;
    }
    return true;
}

/* 打开 AES-GCM 算法。**GCM 是"认证加密"**：解密时会校验 tag，
   密文被改过一个字节就会失败 —— 这是它与"解出来是乱码"那类老式加密的区别。 */
bool open_aes_gcm(AlgHandle& alg, std::string& err) {
    if (!BCRYPT_SUCCESS(::BCryptOpenAlgorithmProvider(&alg.h, BCRYPT_AES_ALGORITHM, nullptr, 0))) {
        err = "打开 AES 算法失败";
        return false;
    }
    const wchar_t* mode = BCRYPT_CHAIN_MODE_GCM;
    if (!BCRYPT_SUCCESS(::BCryptSetProperty(alg.h, BCRYPT_CHAINING_MODE,
                                            reinterpret_cast<PUCHAR>(const_cast<wchar_t*>(mode)),
                                            static_cast<ULONG>(sizeof(BCRYPT_CHAIN_MODE_GCM)),
                                            0))) {
        err = "设置 AES-GCM 模式失败";
        return false;
    }
    return true;
}

/* 从 `<userData>/Local State` 读出并解开密钥。找不到就**新建一个并落盘** ——
   与 Chromium 自己的行为一致（第一次用 safeStorage 时它就建）。 */
bool load_or_create_key(std::string& key, std::string& err) {
    const std::wstring path = local_state_path();
    Json state;
    if (stat_path(path).isFile) {
        std::string readErr;
        if (!json_read_file(path, state, readErr)) {
            /* 文件在但读不动：**不要覆盖它**（那可能是老 Electron 的整份 Local State，
               里面有它自己的东西）。明确报错，让用户决定。 */
            err = "Local State 读不动（" + readErr + "），不敢覆盖：" + to_utf8(path);
            return false;
        }
    }
    std::string encKeyB64;
    if (state.is_object() && state.contains("os_crypt") && state["os_crypt"].is_object()
        && state["os_crypt"].contains("encrypted_key") && state["os_crypt"]["encrypted_key"].is_string()) {
        encKeyB64 = state["os_crypt"]["encrypted_key"].get<std::string>();
    }

    if (!encKeyB64.empty()) {
        std::string raw;
        if (!base64_decode(encKeyB64, raw)) {
            err = "os_crypt.encrypted_key 不是合法 base64";
            return false;
        }
        if (raw.size() < sizeof(kDpapiTag) - 1 || raw.compare(0, sizeof(kDpapiTag) - 1, kDpapiTag) != 0) {
            err = "os_crypt.encrypted_key 没有 DPAPI 前缀（换过存储后端？）";
            return false;
        }
        std::string plain;
        std::string dpapiErr;
        if (!dpapi_decrypt_bytes(raw.substr(sizeof(kDpapiTag) - 1), plain, dpapiErr)) {
            err = "解不开 os_crypt.encrypted_key：" + dpapiErr;
            return false;
        }
        if (plain.size() != kKeyLen) {
            err = "os_crypt 密钥长度不对（" + std::to_string(plain.size()) + " 字节，期望 32）";
            return false;
        }
        key = plain;
        g_keyStatus = "已有密钥（Local State）";
        return true;
    }

    /* 没有密钥 → 生成一个并写回去。 */
    std::string fresh;
    if (!random_bytes(fresh, kKeyLen, err)) return false;
    std::string wrapped;
    std::string dpapiErr;
    if (!dpapi_encrypt_bytes(fresh, wrapped, dpapiErr)) {
        err = "保护新密钥失败：" + dpapiErr;
        return false;
    }
    const std::string stored = base64_encode(std::string(kDpapiTag) + wrapped);

    if (!state.is_object()) state = Json::object();
    if (!state.contains("os_crypt") || !state["os_crypt"].is_object()) state["os_crypt"] = Json::object();
    state["os_crypt"]["encrypted_key"] = stored;
    std::string writeErr;
    if (!json_write_file_atomic(path, state, 2, writeErr)) {
        err = "写不了 Local State：" + writeErr;
        return false;
    }
    key = fresh;
    g_keyStatus = "新建密钥（已写入 Local State）";
    return true;
}

bool ensure_key(std::string& key, std::string& err) {
    if (!g_key.empty()) {
        key = g_key;
        return true;
    }
    std::string fresh;
    if (!load_or_create_key(fresh, err)) return false;
    g_key = fresh;
    key = g_key;
    return true;
}

}  // namespace

void oscrypt_reset() {
    g_key.clear();
    g_keyStatus = "未初始化";
}

const char* oscrypt_key_status() { return g_keyStatus.c_str(); }

bool oscrypt_encrypt(const std::string& plain, std::string& out, std::string& err) {
    err.clear();
    std::string key;
    if (!ensure_key(key, err)) return false;

    AlgHandle alg;
    if (!open_aes_gcm(alg, err)) return false;

    KeyHandle keyHandle;
    if (!make_key(alg.h, key, keyHandle, err)) return false;

    std::string nonce;
    if (!random_bytes(nonce, kNonceLen, err)) return false;

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info{};
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = reinterpret_cast<PUCHAR>(nonce.data());
    info.cbNonce = static_cast<ULONG>(nonce.size());
    std::string tag(kTagLen, '\0');
    info.pbTag = reinterpret_cast<PUCHAR>(tag.data());
    info.cbTag = static_cast<ULONG>(tag.size());

    std::string cipher(plain.size(), '\0');
    ULONG written = 0;
    if (!BCRYPT_SUCCESS(::BCryptEncrypt(keyHandle.h, reinterpret_cast<PUCHAR>(const_cast<char*>(plain.data())),
                                        static_cast<ULONG>(plain.size()), &info, nullptr, 0,
                                        reinterpret_cast<PUCHAR>(cipher.data()),
                                        static_cast<ULONG>(cipher.size()), &written, 0))) {
        err = "AES-GCM 加密失败";
        return false;
    }
    cipher.resize(written);
    out = std::string(kVersionPrefix) + nonce + cipher + tag;
    g_keyStatus = "加密成功";
    return true;
}

bool oscrypt_decrypt(const std::string& blob, std::string& out, std::string& err) {
    err.clear();
    if (blob.size() < sizeof(kVersionPrefix) - 1 + kNonceLen + kTagLen) {
        err = "密文太短";
        return false;
    }
    if (blob.compare(0, sizeof(kVersionPrefix) - 1, kVersionPrefix) != 0) {
        err = "密文不是 v10 格式";
        return false;
    }
    std::string key;
    if (!ensure_key(key, err)) return false;

    AlgHandle alg;
    if (!open_aes_gcm(alg, err)) return false;

    KeyHandle keyHandle;
    if (!make_key(alg.h, key, keyHandle, err)) return false;

    const size_t nonceAt = sizeof(kVersionPrefix) - 1;
    const size_t ctLen = blob.size() - nonceAt - kNonceLen - kTagLen;
    const std::string nonce = blob.substr(nonceAt, kNonceLen);
    const std::string cipher = blob.substr(nonceAt + kNonceLen, ctLen);
    const std::string tag = blob.substr(blob.size() - kTagLen);

    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info{};
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = reinterpret_cast<PUCHAR>(const_cast<char*>(nonce.data()));
    info.cbNonce = static_cast<ULONG>(nonce.size());
    info.pbTag = reinterpret_cast<PUCHAR>(const_cast<char*>(tag.data()));
    info.cbTag = static_cast<ULONG>(tag.size());

    std::string plain(cipher.size(), '\0');
    ULONG written = 0;
    const NTSTATUS st = ::BCryptDecrypt(keyHandle.h, reinterpret_cast<PUCHAR>(const_cast<char*>(cipher.data())),
                                        static_cast<ULONG>(cipher.size()), &info, nullptr, 0,
                                        reinterpret_cast<PUCHAR>(plain.data()),
                                        static_cast<ULONG>(plain.size()), &written, 0);
    if (!BCRYPT_SUCCESS(st)) {
        // 最常见的原因是换了机器/换了 Windows 账户 → 密钥解不出来 → GCM 校验失败。
        err = "AES-GCM 解密失败（0x" + std::to_string(static_cast<unsigned long>(st))
            + "）—— 多半是换了机器或换了 Windows 账户";
        return false;
    }
    plain.resize(written);
    out = plain;
    return true;
}

}  // namespace isg
