// extract/index.js 的 C++ 翻译：类型识别、统一质量口径、扫描件诊断、汇总警告。
//
// **这一层的错误文案是契约的一部分**：views/extract.js 会把 message 原样显示给用户，
// extract-smoke 也逐条断言"带上了路径/文件名"。所以这里不做"更友好"的改写，
// 逐字对照 oracle。
#include "extract.h"

#include "internal.h"

#include "../util/file_ops.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <string_view>

namespace isg {

namespace {

// 文件头的魔术字节（index.js 顶部那两个常量）。
constexpr unsigned char kZipMagic[4] = {0x50, 0x4B, 0x03, 0x04};   // "PK\x03\x04"
constexpr unsigned char kOleMagic[4] = {0xD0, 0xCF, 0x11, 0xE0};   // 旧版 .doc/.ppt/.xls

std::wstring lower_wide(std::wstring s) {
    for (wchar_t& c : s) {
        if (c >= L'A' && c <= L'Z') c = static_cast<wchar_t>(c - L'A' + L'a');
    }
    return s;
}

std::string path_ext_raw(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    const std::wstring base = (slash == std::wstring::npos) ? path : path.substr(slash + 1);
    const size_t dot = base.find_last_of(L'.');
    if (dot == std::wstring::npos || dot == 0) return std::string();
    return to_utf8(base.substr(dot));
}

std::string path_ext_lower(const std::wstring& path) {
    return ascii_lower(path_ext_raw(path));
}

std::string path_basename(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    return to_utf8((slash == std::wstring::npos) ? path : path.substr(slash + 1));
}

std::string path_stem(const std::wstring& path) {
    std::string base = path_basename(path);
    const size_t dot = base.find_last_of('.');
    if (dot == std::string::npos || dot == 0) return base;
    return base.substr(0, dot);
}

bool is_ext(const std::string& ext, std::initializer_list<const char*> list) {
    for (const char* e : list) if (ext == e) return true;
    return false;
}

std::string join_indexes(const std::vector<int>& v, size_t maxN) {
    std::string out;
    for (size_t i = 0; i < v.size() && i < maxN; ++i) {
        if (i) out += "、";
        out += std::to_string(v[i]);
    }
    return out;
}

Json reasons_of(const Json& page) {
    if (!page.is_object()) return Json::array();
    auto q = page.find("quality");
    if (q == page.end() || !q->is_object()) return Json::array();
    auto r = q->find("reasons");
    return (r != q->end() && r->is_array()) ? *r : Json::array();
}

bool has_reason(const Json& page, const char* reason) {
    const Json r = reasons_of(page);
    for (const auto& x : r) {
        if (x.is_string() && x.get<std::string>() == reason) return true;
    }
    return false;
}

}  // namespace

double extract_cjk_ratio(const std::string& text) {
    using namespace extract_detail;
    size_t nonSpace = 0;
    size_t cjk = 0;
    size_t i = 0;
    while (i < text.size()) {
        const uint32_t cp = utf8_next(text, i);
        if (is_js_space(cp)) continue;
        ++nonSpace;
        if (is_cjk_for_ratio(cp)) ++cjk;
    }
    return nonSpace ? static_cast<double>(cjk) / static_cast<double>(nonSpace) : 0.0;
}

std::string extract_tidy_title(const std::string& t) {
    using namespace extract_detail;
    const std::string s = js_trim(t);
    if (s.empty()) return std::string();
    // /^(?:[一-鿿]\s){2,}[一-鿿]$/ ：整串都是"单个汉字 + 空白"重复，最后再一个汉字。
    size_t i = 0;
    int pairs = 0;
    while (i < s.size()) {
        size_t p = i;
        const uint32_t cp = utf8_next(s, p);
        if (!(cp >= 0x4E00 && cp <= 0x9FFF)) return s;
        i = p;
        if (i >= s.size()) break;          // 最后一个汉字
        size_t w = i;
        const uint32_t ws = utf8_next(s, w);
        if (!is_js_space(ws)) return s;
        i = w;
        ++pairs;
        if (i >= s.size()) return s;       // 末尾是空白：不匹配
    }
    if (pairs < 2) return s;
    std::string out;
    i = 0;
    while (i < s.size()) {
        const uint32_t cp = utf8_next(s, i);
        if (!is_js_space(cp)) utf8_append(out, cp);
    }
    return out;
}

namespace {

Json diagnose_scanned(const std::string& kind, const Json& pages) {
    size_t total = pages.size();
    std::vector<int> noText;
    std::vector<int> imgOnly;
    size_t suspectCount = 0;
    for (const auto& p : pages) {
        if (has_reason(p, "no_text_extracted")) {
            noText.push_back(p.value("index", 0));
        }
        if (has_reason(p, "image_only_slide")) {
            imgOnly.push_back(p.value("index", 0));
        }
        auto q = p.find("quality");
        if (q != p.end() && q->is_object() && q->value("suspect", false)) ++suspectCount;
    }
    const size_t blind = noText.size() + imgOnly.size();
    const bool likely = total > 0 && blind >= static_cast<size_t>(std::ceil(static_cast<double>(total) * 0.6));

    Json d = Json::object();
    d["likely"] = likely;
    d["ocred"] = false;
    d["kind"] = kind;
    Json counts = Json::object();
    counts["total"] = total;
    counts["noText"] = noText.size();
    counts["imageOnly"] = imgOnly.size();
    counts["suspect"] = suspectCount;
    d["pages"] = counts;
    d["reason"] = likely ? (kind == "pdf" ? "整页没有文字层，多半是扫描件" : "整页只有图片，文字都在图里")
                         : std::string();
    Json suggestions = Json::array();
    if (likely) {
        suggestions.push_back("用 OCR 工具把它转成\"可以选中文字的 PDF\"，或找到带文字层的原版");
        suggestions.push_back("导出成 .md / .txt 再导入（最省事，也不会有识别错误）");
        suggestions.push_back("只把你要复习的那一节手打成 .md —— 课本按一节给就够了");
    }
    d["suggestions"] = suggestions;
    return d;
}

}  // namespace

bool extract_file(const std::wstring& path, const ExtractOptions& opts, Json& out, ExtractError& err) {
    err = ExtractError{};
    if (path.empty()) {
        err.message = "没有给出要抽取的文件路径";
        return false;
    }
    const FileInfo info = stat_path(path);
    if (!info.exists) {
        err.message = "读不到这个文件：" + to_utf8(path);
        return false;
    }
    if (info.isDir) {
        err.message = "这是一个文件夹，不是课件文件：" + to_utf8(path);
        return false;
    }
    if (info.size > kMaxFileBytes) {
        err.message = "这个文件太大了（超过 64 MB），暂不支持抽取：" + to_utf8(path);
        return false;
    }

    std::string bytes;
    if (!read_file_bytes(path, bytes)) {
        err.message = "读不到这个文件：" + to_utf8(path);
        return false;
    }
    const size_t headLen = std::min<size_t>(8, bytes.size());
    unsigned char head[8] = {};
    for (size_t i = 0; i < headLen; ++i) head[i] = static_cast<unsigned char>(bytes[i]);

    const std::string ext = path_ext_lower(path);
    std::string kind;
    if (headLen >= 4 && std::equal(std::begin(kOleMagic), std::end(kOleMagic), head)) {
        kind = "ole";
    } else if (ext == ".pdf") {
        kind = "pdf";
    } else if (is_ext(ext, {".pptx", ".ppsx"})) {
        kind = (head[0] == 0x50) ? "pptx" : "unknown";
    } else if (is_ext(ext, {".txt", ".md", ".markdown"})) {
        kind = "text";
    } else if (headLen >= 4 && std::equal(std::begin(kZipMagic), std::end(kZipMagic), head)) {
        kind = "pptx";   // 没扩展名的 OOXML
    } else {
        kind = "unknown";
    }

    if (kind == "ole") {
        err.code = "LEGACY_BINARY_FORMAT";
        err.message =
            "这是旧版的二进制 Office 格式（.ppt / .doc），解析不了。"
            "请在 PowerPoint 里「另存为」.pptx，或者导出成 PDF 再试。";
        return false;
    }

    const std::vector<unsigned char> buf(bytes.begin(), bytes.end());
    Json result;
    if (kind == "pdf") {
        if (!extract_pdf_file(path, buf, opts, result, err)) return false;
    } else if (kind == "pptx") {
        if (!extract_pptx_file(path, buf, opts, result, err)) return false;
    } else if (kind == "text") {
        if (!extract_text_file(path, buf, opts, result, err)) return false;
    } else {
        const std::string rawExt = path_ext_raw(path);
        err.message = "不认识这个文件类型：" + (rawExt.empty() ? std::string("(没有扩展名)") : rawExt)
                      + "，目前支持 .pptx / .ppsx / .pdf / .txt / .md";
        return false;
    }

    Json pages = Json::array();
    if (result.contains("pages") && result["pages"].is_array()) {
        for (const auto& pIn : result["pages"]) {
            Json p = pIn.is_object() ? pIn : Json::object();
            std::string text;
            if (p.contains("text") && p["text"].is_string()) text = p["text"].get<std::string>();
            p["text"] = text;
            if (!p.contains("title") || !p["title"].is_string()) p["title"] = std::string();
            Json q = (p.contains("quality") && p["quality"].is_object()) ? p["quality"] : Json::object();
            if (!q.contains("chars") || !q["chars"].is_number()) {
                q["chars"] = static_cast<int64_t>(extract_detail::utf8_count_cp(text));
            }
            q["cjkRatio"] = extract_cjk_ratio(text);
            q["suspect"] = (q.contains("suspect") && q["suspect"].is_boolean())
                               ? q["suspect"].get<bool>() : false;
            p["quality"] = q;
            pages.push_back(p);
        }
    }

    Json warnings = Json::array();
    if (result.contains("warnings") && result["warnings"].is_array()) {
        warnings = result["warnings"];
    }

    // 统一补一条"总体可疑"的汇总。
    std::vector<int> suspect;
    for (const auto& p : pages) {
        auto q = p.find("quality");
        if (q != p.end() && q->is_object() && q->value("suspect", false)) {
            suspect.push_back(p.value("index", 0));
        }
    }
    if (!suspect.empty()) {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "有 " + std::to_string(suspect.size()) + " / " + std::to_string(pages.size())
                       + " 页抽取结果不可靠（第 " + join_indexes(suspect, 12)
                       + (suspect.size() > 12 ? " 等" : "") + " 页），生成前建议在「抽取预览」里核对";
        warnings.push_back(w);
    }
    bool anyText = false;
    for (const auto& p : pages) {
        const std::string t = p.value("text", std::string());
        if (!extract_detail::js_trim(t).empty()) { anyText = true; break; }
    }
    if (!anyText) {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "整份文件一个字都没抽出来，可能是扫描版 PDF 或整页图片的 PPT，需要先做 OCR";
        warnings.push_back(w);
    }

    // meta.title：result.title → 第一个有标题的页 → 文件名（去扩展名）
    std::string title;
    if (result.contains("title") && result["title"].is_string()) {
        title = result["title"].get<std::string>();
    }
    title = extract_tidy_title(extract_detail::js_trim(title));
    if (title.empty()) {
        for (const auto& p : pages) {
            const std::string t = p.value("title", std::string());
            if (!t.empty()) { title = extract_tidy_title(t); break; }
        }
    }
    if (title.empty()) title = path_stem(path);

    Json meta = Json::object();
    meta["title"] = title;
    meta["fileName"] = path_basename(path);
    meta["sizeBytes"] = info.size;
    meta["bytes"] = info.size;
    meta["pageCount"] = pages.size();

    out = Json::object();
    out["kind"] = kind;
    out["pages"] = pages;
    out["warnings"] = warnings;
    out["diagnosis"] = diagnose_scanned(kind, pages);
    out["meta"] = meta;
    return true;
}

}  // namespace isg
