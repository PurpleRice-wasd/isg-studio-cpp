#include "base64.h"

namespace isg {

namespace {
constexpr char kAlphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* 反查表：-1 = 非法字符。构造一次，之后是纯查表。
   注意把 `=` 与空白都判成"结束/忽略"由调用方处理，这里只认 64 个字母。 */
struct Reverse {
    signed char v[256];
    constexpr Reverse() : v{} {
        for (int i = 0; i < 256; ++i) v[i] = -1;
        for (int i = 0; i < 64; ++i) v[static_cast<unsigned char>(kAlphabet[i])] = static_cast<signed char>(i);
    }
};
constexpr Reverse kRev{};
}  // namespace

std::string base64_encode(const std::string& bytes) {
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);
    size_t i = 0;
    const size_t n = bytes.size();
    while (i + 2 < n) {
        const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16)
                         | (static_cast<unsigned char>(bytes[i + 1]) << 8)
                         | static_cast<unsigned char>(bytes[i + 2]);
        out.push_back(kAlphabet[(v >> 18) & 63]);
        out.push_back(kAlphabet[(v >> 12) & 63]);
        out.push_back(kAlphabet[(v >> 6) & 63]);
        out.push_back(kAlphabet[v & 63]);
        i += 3;
    }
    if (i + 1 == n) {
        const unsigned v = static_cast<unsigned char>(bytes[i]) << 16;
        out.push_back(kAlphabet[(v >> 18) & 63]);
        out.push_back(kAlphabet[(v >> 12) & 63]);
        out.push_back('=');
        out.push_back('=');
    } else if (i + 2 == n) {
        const unsigned v = (static_cast<unsigned char>(bytes[i]) << 16)
                         | (static_cast<unsigned char>(bytes[i + 1]) << 8);
        out.push_back(kAlphabet[(v >> 18) & 63]);
        out.push_back(kAlphabet[(v >> 12) & 63]);
        out.push_back(kAlphabet[(v >> 6) & 63]);
        out.push_back('=');
    }
    return out;
}

bool base64_decode(const std::string& text, std::string& out) {
    out.clear();
    out.reserve((text.size() / 4) * 3);
    unsigned acc = 0;
    int bits = 0;
    for (const char c : text) {
        const unsigned char uc = static_cast<unsigned char>(c);
        if (c == '=' || c == '\n' || c == '\r') continue;   // 补齐符与换行跳过
        const signed char d = kRev.v[uc];
        if (d < 0) return false;                            // 非法字符：明确失败
        acc = (acc << 6) | static_cast<unsigned>(d);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<char>((acc >> bits) & 0xFF));
        }
    }
    return true;
}

}  // namespace isg
