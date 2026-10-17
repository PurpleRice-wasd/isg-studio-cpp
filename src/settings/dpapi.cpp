#include "dpapi.h"

#include "../util/base64.h"
#include "../util/win_util.h"

#include <windows.h>
#include <wincrypt.h>

namespace isg {

namespace {

/* CryptProtectData 的**出口**缓冲要用 LocalFree 释放，且失败路径上也要释放。
   ⚠️ 这个 RAII **只能**用来接出口缓冲。
   第一版把入口缓冲也塞进它 —— 而入口指向的是调用方 `std::string` 的内存，
   析构时对着一块不是 LocalAlloc 来的内存调 LocalFree，当场 heap corruption
   （0xC0000374，而且是**在进程退出时**才炸，看起来像"跑完了没输出就死了"）。
   输入用下面的 `make_in_blob()`，它明确声明"不拥有"。 */
struct OutBlob {
    DATA_BLOB blob{};
    ~OutBlob() {
        if (blob.pbData != nullptr) {
            ::SecureZeroMemory(blob.pbData, blob.cbData);   // 密文/明文都不留在堆上
            ::LocalFree(blob.pbData);
        }
    }
    OutBlob() = default;
    OutBlob(const OutBlob&) = delete;
    OutBlob& operator=(const OutBlob&) = delete;
};

/* 入口缓冲：**不拥有任何东西**，只是把调用方的字节借给 Win32 看一眼。 */
DATA_BLOB make_in_blob(const std::string& in) {
    DATA_BLOB b{};
    b.cbData = static_cast<DWORD>(in.size());
    b.pbData = reinterpret_cast<BYTE*>(const_cast<char*>(in.data()));
    return b;
}

bool protect(const std::string& in, std::string& out, std::string& err) {
    DATA_BLOB inBlob = make_in_blob(in);
    OutBlob outBlob;
    /* 描述传 L""、熵传 nullptr、标志传 CRYPTPROTECT_UI_FORBIDDEN ——
       前两项决定了密文与 Electron 的一致（描述不进密文，但保持一致没有坏处）；
       第三项只影响"要不要弹 UI"，不会改变输出，这里显式禁掉弹窗：
       一个配置文件里的 Key 不该让任何对话框冒出来。 */
    if (!::CryptProtectData(&inBlob, L"", nullptr, nullptr, nullptr,
                            CRYPTPROTECT_UI_FORBIDDEN, &outBlob.blob)) {
        err = "DPAPI 加密失败（错误码 " + std::to_string(::GetLastError()) + "）";
        return false;
    }
    out.assign(reinterpret_cast<const char*>(outBlob.blob.pbData), outBlob.blob.cbData);
    return true;
}

bool unprotect(const std::string& in, std::string& out, std::string& err) {
    DATA_BLOB inBlob = make_in_blob(in);
    OutBlob outBlob;
    if (!::CryptUnprotectData(&inBlob, nullptr, nullptr, nullptr, nullptr,
                              CRYPTPROTECT_UI_FORBIDDEN, &outBlob.blob)) {
        err = "DPAPI 解密失败（错误码 " + std::to_string(::GetLastError())
            + "）—— 多半是换了机器或换了 Windows 账户";
        return false;
    }
    out.assign(reinterpret_cast<const char*>(outBlob.blob.pbData), outBlob.blob.cbData);
    return true;
}

}  // namespace

bool encryption_available() {
    /* 缓存：结果在一次进程生命周期内不会变，而它每次都要跑一次 DPAPI 往返（含一次
       CryptProtectData 的随机数生成），在"设置页每次刷新都问一遍"的路径上不值得重复。 */
    static const bool cached = [] {
        std::string err;
        const std::string probe = "isg-probe";
        std::string enc;
        if (!protect(probe, enc, err)) return false;
        std::string dec;
        if (!unprotect(enc, dec, err)) return false;
        return dec == probe;   // 往返回来了才算"可用"
    }();
    return cached;
}

bool dpapi_encrypt_bytes(const std::string& plain, std::string& out, std::string& err) {
    err.clear();
    return protect(plain, out, err);
}

bool dpapi_decrypt_bytes(const std::string& blob, std::string& out, std::string& err) {
    err.clear();
    return unprotect(blob, out, err);
}

std::string dpapi_encrypt_b64(const std::string& plain, std::string& err) {
    err.clear();
    if (plain.empty()) return std::string();
    std::string blob;
    if (!protect(plain, blob, err)) return std::string();
    return base64_encode(blob);
}

std::string dpapi_decrypt_b64(const std::string& b64, std::string& err) {
    err.clear();
    if (b64.empty()) return std::string();
    std::string blob;
    if (!base64_decode(b64, blob)) {
        err = "密文不是合法的 base64";
        return std::string();
    }
    std::string plain;
    if (!unprotect(blob, plain, err)) return std::string();
    return plain;
}

}  // namespace isg
