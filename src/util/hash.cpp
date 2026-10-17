#include "hash.h"

#include "win_util.h"

#include <windows.h>
#include <bcrypt.h>

namespace isg {

std::string sha256_hex(const void* data, size_t len) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    if (!BCRYPT_SUCCESS(::BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
        return std::string();
    }
    // RAII：所有出口都要关掉这个句柄（含下面的失败分支）
    auto guard = on_scope_exit([&alg]() {
        if (alg != nullptr) ::BCryptCloseAlgorithmProvider(alg, 0);
    });

    DWORD hashLen = 0;
    DWORD got = 0;
    if (!BCRYPT_SUCCESS(::BCryptGetProperty(alg, BCRYPT_HASH_LENGTH,
                                            reinterpret_cast<PUCHAR>(&hashLen), sizeof(hashLen), &got, 0))) {
        return std::string();
    }
    std::string hash(hashLen, '\0');
    if (!BCRYPT_SUCCESS(::BCryptHash(alg, nullptr, 0,
                                     reinterpret_cast<PUCHAR>(const_cast<void*>(data)),
                                     static_cast<ULONG>(len),
                                     reinterpret_cast<PUCHAR>(hash.data()), hashLen))) {
        return std::string();
    }

    static const char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(hashLen * 2);
    for (const char c : hash) {
        const unsigned char b = static_cast<unsigned char>(c);
        out.push_back(kHex[b >> 4]);
        out.push_back(kHex[b & 15]);
    }
    return out;
}

std::string sha256_hex(const std::string& bytes) {
    return sha256_hex(bytes.data(), bytes.size());
}

}  // namespace isg
