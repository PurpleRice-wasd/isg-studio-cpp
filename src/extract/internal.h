// 抽取层内部共用的小工具：UTF-8 码点遍历、JS 口径的空白/裁剪、CJK 判定。
//
// 为什么不复用 util/str_util.h：那一层的注释明确写了"只处理 ASCII 语义"，
// 而抽取要面对的是中文正文 + 全角标点 + Unicode 空白。把这两套东西混在一起，
// 迟早会出现"某个函数到底按字节还是按码点"的歧义 —— 而这个项目的质量信号
// （chars / cjkRatio / 页眉页脚归一化）全是按**码点**算的。
#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace isg {
namespace extract_detail {

// 解码一个 UTF-8 码点。非法序列返回 U+FFFD 并让 i 前进 1 字节（与 TextDecoder 的
// 容错解码一致：坏字节各自变成替换字符，而不是把后面整段吞掉）。
inline uint32_t utf8_next(std::string_view s, size_t& i) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    if (c < 0x80) { ++i; return c; }
    auto cont = [&](size_t k) -> bool {
        return i + k < s.size() && (static_cast<unsigned char>(s[i + k]) & 0xC0) == 0x80;
    };
    if ((c & 0xE0) == 0xC0 && cont(1)) {
        const uint32_t cp = ((c & 0x1Fu) << 6) | (static_cast<unsigned char>(s[i + 1]) & 0x3Fu);
        i += 2;
        return cp < 0x80 ? 0xFFFD : cp;
    }
    if ((c & 0xF0) == 0xE0 && cont(1) && cont(2)) {
        const uint32_t cp = ((c & 0x0Fu) << 12) | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 6)
                            | (static_cast<unsigned char>(s[i + 2]) & 0x3Fu);
        i += 3;
        return (cp < 0x800 || (cp >= 0xD800 && cp <= 0xDFFF)) ? 0xFFFD : cp;
    }
    if ((c & 0xF8) == 0xF0 && cont(1) && cont(2) && cont(3)) {
        const uint32_t cp = ((c & 0x07u) << 18) | ((static_cast<unsigned char>(s[i + 1]) & 0x3Fu) << 12)
                            | ((static_cast<unsigned char>(s[i + 2]) & 0x3Fu) << 6)
                            | (static_cast<unsigned char>(s[i + 3]) & 0x3Fu);
        i += 4;
        return (cp < 0x10000 || cp > 0x10FFFF) ? 0xFFFD : cp;
    }
    ++i;
    return 0xFFFD;
}

inline void utf8_append(std::string& out, uint32_t cp) {
    // 孤立代理项不是合法的 UTF-8 码点。这里直接替换掉，而不是把 ED A0 80 这种
    // 非法序列写进 std::string —— 后者会被下游（json/to_wide/日志）看到，只是
    // 现在恰好被 json_dump 的 replace 处理器兜住了。
    if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
    if (cp <= 0x7F) {
        out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | ((cp >> 18) & 0x07)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

// JS 的 /\s/：\t\n\v\f\r 空格 + NBSP + 一批 Unicode 空白（含全角空格 U+3000、BOM）。
inline bool is_js_space(uint32_t cp) {
    switch (cp) {
        case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20:
        case 0xA0: case 0x1680: case 0x2028: case 0x2029: case 0x202F: case 0x205F:
        case 0x3000: case 0xFEFF:
            return true;
        default:
            return cp >= 0x2000 && cp <= 0x200A;
    }
}

inline bool is_ascii_digit(uint32_t cp) { return cp >= '0' && cp <= '9'; }

inline bool is_cjk_for_ratio(uint32_t cp) {
    // index.js 的 CJK_CHAR_RE：CJK 部首扩展、CJK 标点、假名、CJK 统一表意、兼容表意、
    // 全角形式、谚文。对"这一页抽出来的是不是中文"来说，全角标点与汉字是同一类证据。
    return (cp >= 0x2E80 && cp <= 0x2EFF) || (cp >= 0x3000 && cp <= 0x303F)
           || (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x3400 && cp <= 0x4DBF)
           || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF)
           || (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0xAC00 && cp <= 0xD7AF);
}

inline bool is_pua(uint32_t cp) { return cp >= 0xE000 && cp <= 0xF8FF; }

// JS String.prototype.trim()
inline std::string js_trim(std::string_view s) {
    size_t b = 0;
    size_t e = s.size();
    while (b < e) {
        size_t i = b;
        const uint32_t cp = utf8_next(s, i);
        if (!is_js_space(cp)) break;
        b = i;
    }
    while (e > b) {
        // 从尾部向前找一个码点起点
        size_t start = e - 1;
        while (start > b && (static_cast<unsigned char>(s[start]) & 0xC0) == 0x80) --start;
        size_t i = start;
        const uint32_t cp = utf8_next(s, i);
        if (i != e || !is_js_space(cp)) break;
        e = start;
    }
    return std::string(s.substr(b, e - b));
}

// JS 的 `s.replace(/\s+$/, '')`：去掉末尾所有空白（含换行）。
inline std::string js_trim_end(std::string_view s) {
    size_t e = s.size();
    while (e > 0) {
        size_t start = e - 1;
        while (start > 0 && (static_cast<unsigned char>(s[start]) & 0xC0) == 0x80) --start;
        size_t i = start;
        const uint32_t cp = utf8_next(s, i);
        if (i != e || !is_js_space(cp)) break;
        e = start;
    }
    return std::string(s.substr(0, e));
}

// normaliseForRepeat：数字归一成 #、去掉所有空白、ASCII 小写。
inline std::string normalise_for_repeat(std::string_view s) {
    // JS 是 `s.replace(/\d+/g, '#')`：**连续**数字串折成一个 #。
    // 逐位替换会把「第 3 页」和「第 12 页」归一成 `第#页` / `第##页` 两个 key，
    // 于是位数不同的页码会被拆成两组、每组的页数都可能低于重复阈值，
    // 页眉/页脚整段剔不掉（实测：C++ 3 种 / oracle 2 种）。
    std::string out;
    size_t i = 0;
    bool inDigits = false;
    while (i < s.size()) {
        const uint32_t cp = utf8_next(s, i);
        if (cp >= '0' && cp <= '9') {
            if (!inDigits) out.push_back('#');
            inDigits = true;
            continue;
        }
        inDigits = false;
        if (is_js_space(cp)) continue;
        if (cp >= 'A' && cp <= 'Z') { out.push_back(static_cast<char>(cp - 'A' + 'a')); continue; }
        utf8_append(out, cp);
    }
    return out;
}

// 按码点数截断（等价于 JS 对 BMP 字符的 slice；对增补平面字符略宽一格，足够）。
inline std::string utf8_prefix_cp(std::string_view s, size_t maxCp) {
    size_t i = 0;
    size_t n = 0;
    while (i < s.size() && n < maxCp) {
        utf8_next(s, i);
        ++n;
    }
    return std::string(s.substr(0, i));
}

inline size_t utf8_count_cp(std::string_view s) {
    size_t i = 0;
    size_t n = 0;
    while (i < s.size()) { utf8_next(s, i); ++n; }
    return n;
}

// 取第一个码点（用于空格插入规则里的"前一个字符/后一个字符"）。
inline uint32_t first_cp(std::string_view s) {
    if (s.empty()) return 0;
    size_t i = 0;
    return utf8_next(s, i);
}
inline uint32_t last_cp(std::string_view s) {
    if (s.empty()) return 0;
    size_t end = s.size();
    size_t start = end - 1;
    while (start > 0 && (static_cast<unsigned char>(s[start]) & 0xC0) == 0x80) --start;
    size_t i = start;
    return utf8_next(s, i);
}

// 全角数字/印刷体负号等不在这里处理 —— 那是**答题判分**的容错（Phase 5），
// 抽取只负责把文本原样交出去。

}  // namespace extract_detail
}  // namespace isg
