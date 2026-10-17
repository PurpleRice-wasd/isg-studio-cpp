// text.js 的 C++ 翻译：纯文本 / Markdown 抽取。
//
// 三件必须逐字对齐的事：
//   1) 编码识别的顺序（BOM → fatal UTF-8 → GBK）；
//   2) "一页 = 一个标题到下一个标题"的切法，以及没有标题时整体一页的降级；
//   3) 警告文案。
#include "extract.h"

#include "internal.h"

#include "../util/win_util.h"

#include <algorithm>
#include <regex>
#include <string_view>

namespace isg {

namespace {

constexpr size_t kBigFileBytes = 20ull * 1024 * 1024;

struct Encoding {
    std::string name;   // 'utf-8' / 'utf-16le' / 'utf-16be' / 'gbk'
    size_t bomBytes = 0;
};

bool utf8_is_valid(std::string_view s) {
    size_t i = 0;
    while (i < s.size()) {
        const unsigned char c = static_cast<unsigned char>(s[i]);
        if (c < 0x80) { ++i; continue; }
        auto at = [&](size_t k) -> unsigned char {
            return (i + k < s.size()) ? static_cast<unsigned char>(s[i + k]) : 0;
        };
        auto cont = [&](size_t k) { return i + k < s.size() && (at(k) & 0xC0) == 0x80; };
        if (c >= 0xC2 && c <= 0xDF) {
            if (!cont(1)) return false;
            i += 2;
        } else if (c == 0xE0) {
            if (!cont(1) || at(1) < 0xA0 || !cont(2)) return false;
            i += 3;
        } else if (c >= 0xE1 && c <= 0xEC) {
            if (!cont(1) || !cont(2)) return false;
            i += 3;
        } else if (c == 0xED) {
            if (!cont(1) || at(1) > 0x9F || !cont(2)) return false;
            i += 3;
        } else if (c >= 0xEE && c <= 0xEF) {
            if (!cont(1) || !cont(2)) return false;
            i += 3;
        } else if (c == 0xF0) {
            if (!cont(1) || at(1) < 0x90 || !cont(2) || !cont(3)) return false;
            i += 4;
        } else if (c >= 0xF1 && c <= 0xF3) {
            if (!cont(1) || !cont(2) || !cont(3)) return false;
            i += 4;
        } else if (c == 0xF4) {
            if (!cont(1) || at(1) > 0x8F || !cont(2) || !cont(3)) return false;
            i += 4;
        } else {
            return false;
        }
    }
    return true;
}

std::string utf16_to_utf8(const std::vector<unsigned char>& b, size_t start, bool bigEndian) {
    std::string out;
    auto unit = [&](size_t i) -> uint32_t {
        return bigEndian ? (static_cast<uint32_t>(b[i]) << 8) | b[i + 1]
                         : (static_cast<uint32_t>(b[i + 1]) << 8) | b[i];
    };
    for (size_t i = start; i + 1 < b.size(); i += 2) {
        uint32_t cp = unit(i);
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 3 < b.size()) {
            const uint32_t lo = unit(i + 2);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                i += 2;
            } else {
                cp = 0xFFFD;
            }
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            cp = 0xFFFD;
        }
        extract_detail::utf8_append(out, cp);
    }
    return out;
}

bool decode_gbk(const std::vector<unsigned char>& b, size_t start, std::string& out) {
    out.clear();
    if (start >= b.size()) return true;
    const char* p = reinterpret_cast<const char*>(b.data() + start);
    const int n = static_cast<int>(b.size() - start);
    int wlen = ::MultiByteToWideChar(936, 0, p, n, nullptr, 0);
    if (wlen <= 0) return false;
    std::wstring w(static_cast<size_t>(wlen), L'\0');
    if (::MultiByteToWideChar(936, 0, p, n, w.data(), wlen) <= 0) return false;
    out = to_utf8(w);
    return true;
}

bool decode(const std::vector<unsigned char>& b, const Encoding& enc, std::string& text) {
    text.clear();
    if (b.empty()) return true;   // 空缓冲：别对 b.data() 做指针算术（null + 0 是 UB）
    if (enc.name == "utf-8") {
        if (enc.bomBytes >= b.size()) return true;
        text.assign(reinterpret_cast<const char*>(b.data()) + enc.bomBytes,
                    b.size() - enc.bomBytes);
        return true;
    }
    if (enc.name == "utf-16le") { text = utf16_to_utf8(b, enc.bomBytes, false); return true; }
    if (enc.name == "utf-16be") { text = utf16_to_utf8(b, enc.bomBytes, true); return true; }
    if (enc.name == "gbk") { return decode_gbk(b, enc.bomBytes, text); }
    return false;
}

// Markdown ATX 标题：# ~ ######
const std::regex& atx_re() {
    static const std::regex re(R"(^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$)",
                               std::regex::ECMAScript);
    return re;
}
// setext 标题的下一行：=== 或 ---（至少两个 -）
const std::regex& setext_re() {
    static const std::regex re(R"(^ {0,3}(=+|-{2,})[ \t]*$)", std::regex::ECMAScript);
    return re;
}

bool is_atx(const std::string& line) { return std::regex_match(line, atx_re()); }
bool is_setext(const std::string& line) { return std::regex_match(line, setext_re()); }

// 「第一章 …」「第 3 节 …」「第三讲 …」
//
// 不能直接用 std::regex：中文是多字节，`.` 与 `{0,60}` 在 std::string 上按**字节**数，
// 而 JS 的 `.{0,60}` 按 UTF-16 单元数。单独写一段按码点的判断，口径才与 oracle 一致。
bool is_cn_heading(const std::string& line) {
    using namespace extract_detail;
    size_t i = 0;
    // ^[ \t]*
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
    // 第
    if (i >= line.size()) return false;
    {
        size_t j = i;
        if (utf8_next(line, j) != 0x7B2C) return false;   // 第
        i = j;
    }
    // [〇零一二三四五六七八九十百千两0-9]{1,6}
    static const char* kNumChars[] = {"〇", "零", "一", "二", "三", "四", "五", "六",
                                      "七", "八", "九", "十", "百", "千", "两"};
    int digits = 0;
    while (i < line.size() && digits < 6) {
        if (line[i] >= '0' && line[i] <= '9') { ++i; ++digits; continue; }
        bool hit = false;
        for (const char* n : kNumChars) {
            const size_t len = std::char_traits<char>::length(n);
            if (line.compare(i, len, n) == 0) { i += len; ++digits; hit = true; break; }
        }
        if (!hit) break;
    }
    if (digits == 0) return false;
    // [章节讲篇课部]
    static const char* kUnitChars[] = {"章", "节", "讲", "篇", "课", "部"};
    bool unit = false;
    for (const char* u : kUnitChars) {
        const size_t len = std::char_traits<char>::length(u);
        if (line.compare(i, len, u) == 0) { i += len; unit = true; break; }
    }
    if (!unit) return false;
    // [ \t、.．:：]*
    while (i < line.size()) {
        if (line[i] == ' ' || line[i] == '\t' || line[i] == '.' || line[i] == ':') { ++i; continue; }
        bool punct = false;
        for (const char* p : {"、", "．", "："}) {            const size_t len = std::char_traits<char>::length(p);
            if (line.compare(i, len, p) == 0) { i += len; punct = true; break; }
        }
        if (!punct) break;
    }
    // \S.{0,60}$
    if (i >= line.size()) return false;
    {
        size_t j = i;
        const uint32_t cp = utf8_next(line, j);
        if (is_js_space(cp)) return false;
    }
    size_t remaining = 0;
    while (i < line.size()) { utf8_next(line, i); ++remaining; }
    return remaining >= 1 && remaining <= 61;
}

struct Chunk {
    std::string title;
    std::vector<std::string> lines;
};

std::vector<std::string> split_lines(const std::string& text) {
    std::vector<std::string> out;
    std::string cur;
    for (size_t i = 0; i < text.size(); ++i) {
        const char c = text[i];
        if (c == '\r') {
            out.push_back(cur);
            cur.clear();
            if (i + 1 < text.size() && text[i + 1] == '\n') ++i;
        } else if (c == '\n') {
            out.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    out.push_back(cur);
    return out;
}

size_t count_setext_headings(const std::vector<std::string>& lines) {
    size_t n = 0;
    for (size_t i = 1; i < lines.size(); ++i) {
        if (is_setext(lines[i]) && !extract_detail::js_trim(lines[i - 1]).empty()) ++n;
    }
    return n;
}

std::vector<Chunk> split_by_setext(const std::vector<std::string>& lines) {
    std::vector<Chunk> chunks;
    Chunk cur;
    for (size_t i = 0; i < lines.size(); ++i) {
        const std::string& line = lines[i];
        if (i + 1 < lines.size() && is_setext(lines[i + 1])
            && !extract_detail::js_trim(line).empty()) {
            chunks.push_back(cur);
            cur = Chunk{extract_detail::js_trim(line), {}};
            ++i;   // 跳过下划线那一行
        } else {
            cur.lines.push_back(line);
        }
    }
    chunks.push_back(cur);
    if (chunks.size() > 1) {
        std::string joined;
        for (const auto& l : chunks[0].lines) joined += l;
        if (extract_detail::js_trim(joined).empty()) chunks.erase(chunks.begin());
    }
    return chunks;
}

std::vector<Chunk> split_by(const std::vector<std::string>& lines,
                            const std::function<bool(const std::string&, Chunk&, bool&)>& match) {
    std::vector<Chunk> chunks;
    Chunk cur;
    for (const std::string& line : lines) {
        Chunk hit;
        bool skip = false;
        if (match(line, hit, skip)) {
            chunks.push_back(cur);
            cur = hit;
            (void)skip;
        } else {
            cur.lines.push_back(line);
        }
    }
    chunks.push_back(cur);
    if (chunks.size() > 1) {
        std::string joined;
        for (const auto& l : chunks[0].lines) joined += l;
        if (extract_detail::js_trim(joined).empty()) chunks.erase(chunks.begin());
    }
    return chunks;
}

std::vector<Chunk> split_into_pages(const std::string& text) {
    const std::vector<std::string> lines = split_lines(text);

    size_t atxCount = 0;
    for (const auto& l : lines) if (is_atx(l)) ++atxCount;
    if (atxCount > 0) {
        return split_by(lines, [](const std::string& line, Chunk& out, bool&) {
            std::smatch m;
            if (!std::regex_match(line, m, atx_re())) return false;
            out.title = extract_detail::js_trim(m[2].str());
            return true;
        });
    }

    if (count_setext_headings(lines) > 0) return split_by_setext(lines);

    size_t cnCount = 0;
    for (const auto& l : lines) if (is_cn_heading(l)) ++cnCount;
    if (cnCount >= 2) {
        return split_by(lines, [](const std::string& line, Chunk& out, bool&) {
            if (!is_cn_heading(line)) return false;
            out.title = extract_detail::js_trim(line);
            return true;
        });
    }

    return {Chunk{"", lines}};
}

}  // namespace

bool extract_text_file(const std::wstring& path, const std::vector<unsigned char>& b,
                       const ExtractOptions& opts, Json& out, ExtractError& err) {
    (void)path;
    if (opts.cancel && opts.cancel->load(std::memory_order_relaxed)) {
        err.code = "CANCELLED";
        err.message = "抽取已取消";
        return false;
    }
    Json warnings = Json::array();

    if (b.size() >= kBigFileBytes) {
        const double mb = static_cast<double>(b.size()) / 1048576.0;
        char num[64] = {};
        std::snprintf(num, sizeof(num), "%.1f", mb);
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = std::string("这个文本文件有 ") + num
                       + " MB，远超课件应有的体量，抽取可能很慢；如果它是数据/日志文件，建议换一份讲稿";
        warnings.push_back(w);
    }

    Encoding enc;
    if (b.size() >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) {
        enc = {"utf-8", 3};
    } else if (b.size() >= 2 && b[0] == 0xFF && b[1] == 0xFE) {
        enc = {"utf-16le", 2};
    } else if (b.size() >= 2 && b[0] == 0xFE && b[1] == 0xFF) {
        enc = {"utf-16be", 2};
    } else {
        const std::string_view sv(reinterpret_cast<const char*>(b.data()), b.size());
        enc = utf8_is_valid(sv) ? Encoding{"utf-8", 0} : Encoding{"gbk", 0};
    }

    std::string text;
    if (opts.cancel && opts.cancel->load(std::memory_order_relaxed)) {
        err.code = "CANCELLED";
        err.message = "抽取已取消";
        return false;
    }
    if (!decode(b, enc, text)) {
        err.message = to_utf8(path) + "：用 " + enc.name
                      + " 解码失败（Windows 解码 API 返回失败），这个文本文件的编码可能是本工具不支持的";
        return false;
    }
    // decode() 已经按 BOM 切过起点；这里只兜底清掉"以 U+FEFF 字符开头"的情况
    // （UTF-8 BOM 被当成三个字节时会在解码后变成 U+FEFF）。
    if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF
        && static_cast<unsigned char>(text[1]) == 0xBB
        && static_cast<unsigned char>(text[2]) == 0xBF) {
        text.erase(0, 3);
    }

    if (enc.name != "utf-8") {
        std::string upper = enc.name;
        std::transform(upper.begin(), upper.end(), upper.begin(),
                       [](char c) { return (c >= 'a' && c <= 'z') ? static_cast<char>(c - 32) : c; });
        Json w = Json::object();
        w["level"] = "info";
        w["message"] = "按 " + upper
                       + " 解码（不是 UTF-8），如果正文有乱码请把它另存为 UTF-8 再试";
        warnings.push_back(w);
    }

    const std::vector<Chunk> chunks = split_into_pages(text);
    Json pages = Json::array();
    for (size_t idx = 0; idx < chunks.size(); ++idx) {
        const Chunk& c = chunks[idx];
        std::string joined;
        for (size_t i = 0; i < c.lines.size(); ++i) {
            if (i) joined += '\n';
            joined += c.lines[i];
        }
        std::string body = extract_detail::js_trim_end(joined);
        // .replace(/\n{3,}/g, '\n\n')
        std::string collapsed;
        size_t run = 0;
        for (char ch : body) {
            if (ch == '\n') {
                ++run;
            } else {
                if (run >= 3) collapsed += "\n\n";
                else collapsed.append(run, '\n');
                run = 0;
                collapsed.push_back(ch);
            }
        }
        if (run >= 3) collapsed += "\n\n";
        else collapsed.append(run, '\n');
        body = std::move(collapsed);

        std::string title = c.title;
        if (title.empty()) {
            std::string first;
            for (const auto& l : c.lines) {
                const std::string t = extract_detail::js_trim(l);
                if (!t.empty()) { first = t; break; }
            }
            title = extract_detail::utf8_prefix_cp(first, 80);
        }
        if (title.empty()) title = "第 " + std::to_string(idx + 1) + " 节";

        Json p = Json::object();
        p["index"] = static_cast<int64_t>(idx + 1);
        p["title"] = title;
        p["text"] = body;
        pages.push_back(p);
    }

    if (pages.size() <= 1) {
        Json w = Json::object();
        w["level"] = "info";
        w["message"] =
            "这个文件里没有找到 Markdown 标题（# / ## …），已整体当成一节；如果内容其实是分章的，加几个标题能切得更准";
        warnings.push_back(w);
    }

    size_t emptyPages = 0;
    for (const auto& p : pages) {
        if (extract_detail::js_trim(p.value("text", std::string())).empty()) ++emptyPages;
    }
    if (emptyPages) {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "有 " + std::to_string(emptyPages) + " 节没有正文（只有标题），请确认文件内容是否完整";
        warnings.push_back(w);
    }

    std::string title;
    if (!pages.empty()) {
        const std::string first = pages[0].value("title", std::string());
        const std::regex sectionRe(R"(^第 \d+ 节$)", std::regex::ECMAScript);
        if (!first.empty() && !std::regex_match(first, sectionRe)) title = first;
    }

    out = Json::object();
    out["pages"] = pages;
    out["warnings"] = warnings;
    out["pageCount"] = pages.size();
    out["title"] = title;
    out["encoding"] = enc.name;
    return true;
}

}  // namespace isg
