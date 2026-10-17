// pptx.js 的 C++ 翻译：.pptx / .ppsx 抽取。
//
// 解包换成 miniz（纲领 §3.4 的选型）；**XML 解析保持原样**：
// oracle 的 pptx.js 刻意不引 XML 解析器，而是用一个"切标签 + 状态机"，
// 因为它只关心 <a:t>/<a:p>/<a:br>/<a:tbl> 这几种标签，而且不担心中文、实体与命名空间前缀。
// 这里把那段状态机逐条翻译，不换成 pugixml —— 换解析器会改变空白/实体/表格的处理口径，
// 而 Phase 2 的验收恰恰是"与 JS 版一致"。
//
// 两个已实测的坑（原注释）：
//   · 幻灯片顺序由 ppt/presentation.xml 的 <p:sldIdLst> 决定，**不是**文件名顺序；
//   · <mc:AlternateContent> 里 Choice 与 Fallback 是同一段内容的两份，不跳过 Fallback 会抽两遍。
#include "extract.h"

#include "internal.h"

#include "../util/str_util.h"
#include "../util/win_util.h"

#include "miniz.h"

#include <algorithm>
#include <cstdio>
#include <map>
#include <string_view>
#include <vector>

namespace isg {

namespace {

// ───────────────────────── XML 实体 ─────────────────────────

bool is_name_start(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}
bool is_name_char(char c) {
    return is_name_start(c) || (c >= '0' && c <= '9') || c == '.' || c == '-';
}

std::string decode_xml_entities(const std::string& s) {
    if (s.find('&') == std::string::npos && s.find("_x") == std::string::npos) return s;

    std::string out;
    size_t i = 0;
    while (i < s.size()) {
        if (s[i] != '&') { out.push_back(s[i++]); continue; }
        // &(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);
        const size_t semi = s.find(';', i + 1);
        if (semi == std::string::npos) { out.push_back(s[i++]); continue; }
        const std::string body = s.substr(i + 1, semi - i - 1);
        bool handled = false;
        if (!body.empty() && body[0] == '#') {
            const bool hex = body.size() > 1 && (body[1] == 'x' || body[1] == 'X');
            const std::string digits = body.substr(hex ? 2 : 1);
            if (!digits.empty()) {
                bool ok = true;
                uint32_t cp = 0;
                for (char c : digits) {
                    int v = -1;
                    if (c >= '0' && c <= '9') v = c - '0';
                    else if (hex && c >= 'a' && c <= 'f') v = c - 'a' + 10;
                    else if (hex && c >= 'A' && c <= 'F') v = c - 'A' + 10;
                    else { ok = false; break; }
                    cp = cp * (hex ? 16u : 10u) + static_cast<uint32_t>(v);
                }
                if (ok && cp <= 0x10FFFF) {
                    if (cp >= 0xD800 && cp <= 0xDFFF) {
                        // XML 里本就不允许的孤立代理项：丢弃
                        i = semi + 1;
                        handled = true;
                    } else {
                        extract_detail::utf8_append(out, cp);
                        i = semi + 1;
                        handled = true;
                    }
                }
            }
        } else if (!body.empty() && is_name_start(body[0])) {
            bool nameOk = true;
            for (char c : body) if (!is_name_char(c)) { nameOk = false; break; }
            if (nameOk) {
                if (body == "amp") out.push_back('&');
                else if (body == "lt") out.push_back('<');
                else if (body == "gt") out.push_back('>');
                else if (body == "quot") out.push_back('"');
                else if (body == "apos") out.push_back('\'');
                else { out.append(s, i, semi + 1 - i); }
                i = semi + 1;
                handled = true;
            }
        }
        if (!handled) out.push_back(s[i++]);
    }

    // OOXML 私有的 _xHHHH_ 转义
    std::string out2;
    for (size_t k = 0; k < out.size();) {
        if (out[k] == '_' && k + 6 < out.size() && out[k + 1] == 'x' && out[k + 6] == '_') {
            bool hex = true;
            uint32_t cp = 0;
            for (size_t j = k + 2; j < k + 6; ++j) {
                const char c = out[j];
                int v = -1;
                if (c >= '0' && c <= '9') v = c - '0';
                else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
                else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
                else { hex = false; break; }
                cp = cp * 16 + static_cast<uint32_t>(v);
            }
            if (hex) {
                if (cp == 0x0B || cp == 0x0D || cp == 0x0C || cp == 0x07) out2.push_back(' ');
                else extract_detail::utf8_append(out2, cp);
                k += 7;
                continue;
            }
        }
        out2.push_back(out[k++]);
    }
    return out2;
}

// ───────────────────────── 标签扫描 ─────────────────────────

struct Tag {
    bool closing = false;
    bool selfClosing = false;
    std::string rawName;
    std::string ns;
    std::string local;
    std::string attrs;     // 只给 parseRels / ph 用
    size_t end = 0;        // 标签结束后的位置（'>>' 之后）
};

// 在 pos 处尝试解析一个标签。语义对齐 TAG_RE：
//   <(\/?)([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)(...)(\/?)>
// 不匹配 XML 声明（<?）、注释（<!）、以及 < 后面不是名字的文本。
bool parse_tag_at(const std::string& xml, size_t pos, Tag& tag) {
    if (pos >= xml.size() || xml[pos] != '<') return false;
    // ⚠️ 必须重置：调用方复用同一个 Tag，不重置的话 "selfClosing / closing" 会从上一次
    // 解析里继承下来 —— 症状是**第一个自闭合标签之后的所有 <a:t> 都被当成自闭合**，
    // 于是整页文字凭空消失（这正是这次实测踩到的）。
    tag = Tag{};
    size_t i = pos + 1;
    if (i < xml.size() && xml[i] == '/') { tag.closing = true; ++i; }
    if (i >= xml.size() || !is_name_start(xml[i])) return false;
    const size_t nameStart = i;
    while (i < xml.size() && is_name_char(xml[i])) ++i;
    if (i < xml.size() && xml[i] == ':') {
        ++i;
        if (i >= xml.size() || !is_name_start(xml[i])) return false;
        while (i < xml.size() && is_name_char(xml[i])) ++i;
    }
    tag.rawName = xml.substr(nameStart, i - nameStart);
    const size_t colon = tag.rawName.find(':');
    tag.ns = colon == std::string::npos ? std::string() : tag.rawName.substr(0, colon);
    tag.local = colon == std::string::npos ? tag.rawName : tag.rawName.substr(colon + 1);

    // 属性区：逐字符前进，引号里的 > 不算结束。
    const size_t attrStart = i;
    char quote = 0;
    while (i < xml.size()) {
        const char c = xml[i];
        if (quote) {
            if (c == quote) quote = 0;
            ++i;
            continue;
        }
        if (c == '"' || c == '\'') { quote = c; ++i; continue; }
        if (c == '>') break;
        ++i;
    }
    if (i >= xml.size()) return false;
    const size_t attrEnd = i;
    tag.attrs = xml.substr(attrStart, attrEnd - attrStart);
    // 自闭合：'>' 前紧邻的 '/'（且不在引号里 —— 上面的循环保证 attrEnd 处不在引号中）
    if (tag.attrs.size() && tag.attrs.back() == '/') {
        tag.selfClosing = true;
        tag.attrs.pop_back();
    }
    tag.end = i + 1;
    return true;
}

std::string trim_ooxml(const std::string& s) {
    using namespace extract_detail;
    auto ws = [](uint32_t cp) { return cp == ' ' || cp == '\t' || cp == 0xA0; };
    size_t b = 0;
    while (b < s.size()) {
        size_t i = b;
        if (!ws(utf8_next(s, i))) break;
        b = i;
    }
    size_t e = s.size();
    while (e > b) {
        size_t start = e - 1;
        while (start > b && (static_cast<unsigned char>(s[start]) & 0xC0) == 0x80) --start;
        size_t i = start;
        if (!ws(utf8_next(s, i))) break;
        e = start;
    }
    return s.substr(b, e - b);
}

// 按「文档顺序」把一段 slide/notes XML 抽成行的数组。
std::vector<std::string> extract_lines(const std::string& xml) {
    std::vector<std::string> lines;
    std::string line;
    std::string cell;
    int inCellDepth = 0;
    int inFallback = 0;
    bool inText = false;
    std::string buf;

    auto flush = [&]() {
        const std::string t = trim_ooxml(line);
        if (!t.empty()) lines.push_back(t);
        line.clear();
    };
    auto append_buf = [&]() {
        if (buf.empty()) return;
        if (inCellDepth > 0) cell += buf;
        else line += buf;
        buf.clear();
    };

    size_t pos = 0;
    size_t last = 0;
    Tag tag;
    while (pos < xml.size()) {
        const size_t lt = xml.find('<', pos);
        if (lt == std::string::npos) break;
        if (!parse_tag_at(xml, lt, tag)) { pos = lt + 1; continue; }

        const std::string raw = xml.substr(last, lt - last);
        last = tag.end;
        if (inText && !raw.empty()) buf += decode_xml_entities(raw);
        pos = tag.end;

        if (tag.ns == "mc" && tag.local == "Fallback") {
            // 自闭合的 <mc:Fallback/> 不改变深度；否则 inFallback 永远 >0，
            // 该页剩余文字会被整段跳过（oracle 也有这个问题，这里顺手修）。
            if (!tag.selfClosing) inFallback += tag.closing ? -1 : 1;
            continue;
        }
        if (inFallback > 0) {
            if (tag.ns == "a" && tag.local == "t") {
                inText = !tag.closing && !tag.selfClosing;
                buf.clear();
            }
            continue;
        }

        if (tag.ns == "a" && tag.local == "t") {
            if (tag.closing) {
                append_buf();
                inText = false;
            } else if (!tag.selfClosing) {
                inText = true;
                buf.clear();
            }
            continue;
        }
        if (inText) {   // 正常情况下 <a:t> 里不会再有标签，兜底
            inText = false;
            append_buf();
        }

        if (tag.local == "br") {
            if (inCellDepth > 0) cell.push_back(' ');
            else flush();
        } else if (tag.local == "tab") {
            if (inCellDepth > 0) cell.push_back(' ');
            else line.push_back('\t');
        } else if (tag.local == "p") {
            if (tag.selfClosing) {
                if (inCellDepth == 0) flush();
                else cell.push_back(' ');
            } else if (tag.closing) {
                if (inCellDepth > 0) {
                    if (!cell.empty() && !extract_detail::is_js_space(extract_detail::last_cp(cell))) {
                        cell.push_back(' ');
                    }
                } else {
                    flush();
                }
            }
        } else if (tag.local == "tc") {
            if (tag.closing) {
                inCellDepth = std::max(0, inCellDepth - 1);
                const bool skipSep = line.empty() || (line.size() >= 2 && line.compare(line.size() - 2, 2, "| ") == 0);
                line += (skipSep ? std::string() : std::string(" | ")) + extract_detail::js_trim(cell);
                cell.clear();
            } else if (!tag.selfClosing) {
                ++inCellDepth;
            }
        } else if (tag.local == "tr") {
            if (tag.closing) {
                line += cell;
                cell.clear();
                flush();
            }
        } else if (tag.local == "tbl") {
            if (tag.closing) {
                if (!cell.empty()) {
                    line += cell;
                    cell.clear();
                }
                flush();
            }
        }
    }
    if (inText && !buf.empty()) append_buf();
    flush();
    return lines;
}

// ───────────────────────── 包结构 ─────────────────────────

constexpr const char* kRelSlide = "/relationships/slide";
constexpr const char* kRelNotes = "/relationships/notesSlide";
constexpr const char* kRelImage = "/relationships/image";

class ZipReader {
public:
    /* 单个条目解压后 ≤ 64 MiB、所有条目累计 ≤ 256 MiB。
       压缩包本身有 64 MiB 上限（read_file_bytes），但一个几十 KB 的 zip 可以把
       slide1.xml 声明成 4 GB —— 不设上限就是"打开一个畸形 PPTX 把进程吃死"。
       超限时 read() 返回 false，上层按"部件缺失"走既有的 warning 路径。 */
    static constexpr size_t kMaxEntryBytes = 64ull * 1024 * 1024;
    static constexpr size_t kMaxTotalBytes = 256ull * 1024 * 1024;
    static constexpr mz_uint kMaxEntries = 100000;

    ZipReader(const std::vector<unsigned char>& bytes) {
        ok_ = mz_zip_reader_init_mem(&zip_, bytes.data(), bytes.size(), 0) != 0;
        if (!ok_) return;
        const mz_uint n = mz_zip_reader_get_num_files(&zip_);
        if (n > kMaxEntries) { ok_ = false; return; }
        for (mz_uint i = 0; i < n; ++i) {
            mz_zip_archive_file_stat st{};
            if (!mz_zip_reader_file_stat(&zip_, i, &st)) continue;
            names_[st.m_filename] = i;
        }
    }
    ~ZipReader() {
        if (ok_) mz_zip_reader_end(&zip_);
    }
    ZipReader(const ZipReader&) = delete;
    ZipReader& operator=(const ZipReader&) = delete;

    bool ok() const { return ok_; }
    bool has(const std::string& name) const { return names_.find(name) != names_.end(); }

    bool read(const std::string& name, std::string& out) const {
        auto it = names_.find(name);
        if (it == names_.end()) return false;
        const mz_uint idx = it->second;
        mz_zip_archive_file_stat st{};
        if (!mz_zip_reader_file_stat(&zip_, idx, &st)) return false;
        if (st.m_uncomp_size > kMaxEntryBytes) return false;
        if (extractedBytes_ + st.m_uncomp_size > kMaxTotalBytes) return false;
        std::string data(st.m_uncomp_size, '\0');
        if (!mz_zip_reader_extract_to_mem(&zip_, idx, data.data(), data.size(), 0)) return false;
        extractedBytes_ += st.m_uncomp_size;
        out = std::move(data);
        return true;
    }

    std::vector<std::string> names() const {
        std::vector<std::string> v;
        for (const auto& kv : names_) v.push_back(kv.first);
        return v;
    }

private:
    mutable mz_zip_archive zip_{};
    bool ok_ = false;
    mutable size_t extractedBytes_ = 0;
    std::map<std::string, mz_uint> names_;
};

// UTF-8 解码（pptx 的 part 都是 UTF-8；BOM 要去掉，否则第一行行首会多一个不可见字符）。
std::string part_text(const std::string& raw) {
    if (raw.size() >= 3 && static_cast<unsigned char>(raw[0]) == 0xEF
        && static_cast<unsigned char>(raw[1]) == 0xBB
        && static_cast<unsigned char>(raw[2]) == 0xBF) {
        return raw.substr(3);
    }
    return raw;
}

std::map<std::string, std::string> parse_attrs(const std::string& attrs) {
    std::map<std::string, std::string> out;
    size_t i = 0;
    while (i < attrs.size()) {
        while (i < attrs.size() && (attrs[i] == ' ' || attrs[i] == '\t' || attrs[i] == '\r' || attrs[i] == '\n')) ++i;
        if (i >= attrs.size()) break;
        const size_t nameStart = i;
        while (i < attrs.size() && attrs[i] != '=' && attrs[i] != ' ' && attrs[i] != '\t'
               && attrs[i] != '\r' && attrs[i] != '\n') {
            ++i;
        }
        const std::string name = attrs.substr(nameStart, i - nameStart);
        while (i < attrs.size() && (attrs[i] == ' ' || attrs[i] == '\t')) ++i;
        if (i < attrs.size() && attrs[i] == '=') ++i;
        while (i < attrs.size() && (attrs[i] == ' ' || attrs[i] == '\t')) ++i;
        std::string value;
        if (i < attrs.size() && (attrs[i] == '"' || attrs[i] == '\'')) {
            const char q = attrs[i++];
            const size_t vStart = i;
            while (i < attrs.size() && attrs[i] != q) ++i;
            value = attrs.substr(vStart, i - vStart);
            if (i < attrs.size()) ++i;
        } else {
            const size_t vStart = i;
            while (i < attrs.size() && attrs[i] != ' ' && attrs[i] != '\t') ++i;
            value = attrs.substr(vStart, i - vStart);
        }
        if (!name.empty()) out[name] = value;
    }
    return out;
}

std::string read_part(const ZipReader& zip, const std::string& name) {
    std::string raw;
    if (!zip.read(name, raw)) return std::string();
    return part_text(raw);
}

struct Rel {
    std::string type;
    std::string target;
};

std::map<std::string, Rel> parse_rels(const std::string& xml) {
    std::map<std::string, Rel> rels;
    if (xml.empty()) return rels;
    size_t pos = 0;
    while (true) {
        const size_t lt = xml.find("<Relationship", pos);
        if (lt == std::string::npos) break;
        const size_t nameEnd = lt + std::string("<Relationship").size();
        if (nameEnd < xml.size() && is_name_char(xml[nameEnd])) { pos = nameEnd; continue; }
        Tag tag;
        if (!parse_tag_at(xml, lt, tag)) { pos = lt + 1; continue; }
        pos = tag.end;
        if (tag.closing) continue;
        const auto attrs = parse_attrs(tag.attrs);
        auto id = attrs.find("Id");
        auto target = attrs.find("Target");
        if (id == attrs.end() || target == attrs.end()) continue;
        auto type = attrs.find("Type");
        rels[id->second] = Rel{type == attrs.end() ? std::string() : type->second, target->second};
    }
    return rels;
}

// POSIX 风格拼接 + 归一化，让 "../slides/slide1.xml" 在 Windows 上也能对。
bool resolve_part(const std::string& baseDir, const std::string& target, std::string& out) {
    // 外部链接：^[a-zA-Z][\w+.\-]*:
    if (!target.empty() && ((target[0] >= 'A' && target[0] <= 'Z') || (target[0] >= 'a' && target[0] <= 'z'))) {
        size_t i = 1;
        while (i < target.size() && (is_name_char(target[i]) || target[i] == '+')) ++i;
        if (i < target.size() && target[i] == ':') return false;
    }
    std::vector<std::string> parts;
    auto pushSplit = [&](const std::string& s) {
        size_t b = 0;
        while (b <= s.size()) {
            const size_t slash = s.find('/', b);
            const std::string part = s.substr(b, (slash == std::string::npos ? s.size() : slash) - b);
            if (!part.empty() && part != ".") {
                if (part == "..") {
                    if (!parts.empty()) parts.pop_back();
                } else {
                    parts.push_back(part);
                }
            }
            if (slash == std::string::npos) break;
            b = slash + 1;
        }
    };
    if (!baseDir.empty()) pushSplit(baseDir);
    pushSplit(target);
    out.clear();
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i) out.push_back('/');
        out += parts[i];
    }
    return true;
}

struct OrderedSlides {
    std::vector<std::string> ordered;
    Json warnings = Json::array();
};

OrderedSlides ordered_slide_parts(const ZipReader& zip) {
    OrderedSlides r;
    const std::string pres = read_part(zip, "ppt/presentation.xml");
    const auto rels = parse_rels(read_part(zip, "ppt/_rels/presentation.xml.rels"));

    if (!pres.empty()) {
        const size_t open = pres.find("<p:sldIdLst");
        if (open != std::string::npos) {
            const size_t openEnd = pres.find('>', open);
            const size_t close = (openEnd == std::string::npos)
                                     ? std::string::npos
                                     : pres.find("</p:sldIdLst>", openEnd + 1);
            if (openEnd != std::string::npos && close != std::string::npos) {
                const std::string body = pres.substr(openEnd + 1, close - openEnd - 1);
                size_t pos = 0;
                while (true) {
                    const size_t lt = body.find("<p:sldId", pos);
                    if (lt == std::string::npos) break;
                    // 必须是非名字字符（\b）
                    const size_t nameEnd = lt + std::string("<p:sldId").size();
                    if (nameEnd < body.size() && is_name_char(body[nameEnd])) { pos = nameEnd; continue; }
                    Tag tag;
                    if (!parse_tag_at(body, lt, tag)) { pos = lt + 1; continue; }
                    pos = tag.end;
                    if (tag.closing) continue;
                    const auto attrs = parse_attrs(tag.attrs);
                    auto id = attrs.find("r:id");
                    if (id == attrs.end()) continue;
                    auto rel = rels.find(id->second);
                    if (rel == rels.end()) {
                        Json w = Json::object();
                        w["level"] = "warn";
                        w["message"] = "presentation.xml 引用了不存在的关系 " + id->second + "，该页被跳过";
                        r.warnings.push_back(w);
                        continue;
                    }
                    std::string part;
                    if (resolve_part("ppt", rel->second.target, part) && zip.has(part)) {
                        r.ordered.push_back(part);
                    } else {
                        Json w = Json::object();
                        w["level"] = "warn";
                        w["message"] = "关系 " + id->second + " 指向的 " + rel->second.target
                                       + " 不在包里，该页被跳过";
                        r.warnings.push_back(w);
                    }
                }
            } else {
                Json w = Json::object();
                w["level"] = "warn";
                w["message"] = "presentation.xml 里没有 <p:sldIdLst>，只能退回按文件名排序";
                r.warnings.push_back(w);
            }
        } else {
            Json w = Json::object();
            w["level"] = "warn";
            w["message"] = "presentation.xml 里没有 <p:sldIdLst>，只能退回按文件名排序";
            r.warnings.push_back(w);
        }
    } else {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "包里没有 ppt/presentation.xml，只能退回按文件名排序";
        r.warnings.push_back(w);
    }

    if (r.ordered.empty()) {
        std::vector<std::pair<int, std::string>> slides;
        for (const std::string& n : zip.names()) {
            // ^ppt/slides/slide\d+\.xml$
            const std::string prefix = "ppt/slides/slide";
            const std::string suffix = ".xml";
            if (n.size() <= prefix.size() + suffix.size()) continue;
            if (n.compare(0, prefix.size(), prefix) != 0) continue;
            if (n.compare(n.size() - suffix.size(), suffix.size(), suffix) != 0) continue;
            const std::string num = n.substr(prefix.size(), n.size() - prefix.size() - suffix.size());
            if (num.empty()) continue;
            bool ok = true;
            for (char c : num) if (c < '0' || c > '9') { ok = false; break; }
            if (!ok) continue;
            long long slideNo = 0;
            for (char c : num) {
                slideNo = slideNo * 10 + (c - '0');
                if (slideNo > 2147483647LL) { slideNo = 2147483647LL; break; }
            }
            slides.push_back({static_cast<int>(slideNo), n});
        }
        std::sort(slides.begin(), slides.end(),
                  [](const auto& a, const auto& b) { return a.first < b.first; });
        for (const auto& s : slides) r.ordered.push_back(s.second);
    }
    return r;
}

std::string slide_title(const std::string& xml) {
    size_t pos = 0;
    while (true) {
        const size_t open = xml.find("<p:sp", pos);
        if (open == std::string::npos) return std::string();
        const size_t nameEnd = open + std::string("<p:sp").size();
        if (nameEnd < xml.size() && is_name_char(xml[nameEnd])) { pos = nameEnd; continue; }
        Tag tag;
        if (!parse_tag_at(xml, open, tag)) { pos = open + 1; continue; }
        const size_t close = xml.find("</p:sp>", tag.end);
        if (close == std::string::npos) return std::string();
        const size_t end = close + std::string("</p:sp>").size();
        const std::string sp = xml.substr(open, end - open);
        pos = end;

        // /<p:ph\b[^>]*\btype\s*=\s*"(?:title|ctrTitle)"/
        bool isTitle = false;
        size_t p = 0;
        while (true) {
            const size_t ph = sp.find("<p:ph", p);
            if (ph == std::string::npos) break;
            const size_t phNameEnd = ph + std::string("<p:ph").size();
            if (phNameEnd < sp.size() && is_name_char(sp[phNameEnd])) { p = phNameEnd; continue; }
            Tag pht;
            if (!parse_tag_at(sp, ph, pht)) { p = ph + 1; continue; }
            p = pht.end;
            if (pht.closing) continue;
            const auto attrs = parse_attrs(pht.attrs);
            auto t = attrs.find("type");
            if (t != attrs.end() && (t->second == "title" || t->second == "ctrTitle")) {
                isTitle = true;
                break;
            }
        }
        if (!isTitle) continue;

        const std::vector<std::string> tl = extract_lines(sp);
        std::string joined;
        for (size_t i = 0; i < tl.size(); ++i) {
            if (i) joined.push_back(' ');
            joined += tl[i];
        }
        const std::string t = extract_detail::js_trim(joined);
        if (!t.empty()) return t;
    }
}

std::string rel_path_for(const std::string& part) {
    const size_t slash = part.find_last_of('/');
    if (slash == std::string::npos) return "_rels/" + part + ".rels";
    return part.substr(0, slash + 1) + "_rels/" + part.substr(slash + 1) + ".rels";
}

}  // namespace

bool extract_pptx_file(const std::wstring& path, const std::vector<unsigned char>& bytes,
                       const ExtractOptions& opts, Json& out, ExtractError& err) {
    (void)path;
    ZipReader zip(bytes);
    if (!zip.ok()) {
        err.message = "这个 PPTX 打不开（不是有效的 zip 包），文件可能已损坏";
        return false;
    }

    const OrderedSlides ordered = ordered_slide_parts(zip);
    if (ordered.ordered.empty()) {
        err.message = "这个 PPTX 里没有找到任何幻灯片，文件可能已损坏";
        return false;
    }

    Json warnings = ordered.warnings;
    Json pages = Json::array();
    const bool includeNotes = opts.includeNotes;
    for (size_t i = 0; i < ordered.ordered.size(); ++i) {
        if (opts.cancel && opts.cancel->load(std::memory_order_relaxed)) break;
        const std::string& part = ordered.ordered[i];
        const std::string xml = read_part(zip, part);
        const std::vector<std::string> lines = extract_lines(xml);

        std::string notes;
        int images = 0;
        const auto rels = parse_rels(read_part(zip, rel_path_for(part)));
        for (const auto& kv : rels) {
            const Rel& r = kv.second;
            if (includeNotes && ends_with(r.type, kRelNotes)) {
                std::string nPart;
                const size_t slash = part.find_last_of('/');
                const std::string base = (slash == std::string::npos) ? std::string() : part.substr(0, slash);
                if (resolve_part(base, r.target, nPart)) {
                    const std::string nXml = read_part(zip, nPart);
                    if (!nXml.empty()) {
                        const auto nLines = extract_lines(nXml);
                        notes.clear();
                        for (size_t k = 0; k < nLines.size(); ++k) {
                            if (k) notes.push_back('\n');
                            notes += nLines[k];
                        }
                    }
                }
            } else if (ends_with(r.type, kRelImage)) {
                ++images;
            }
        }

        std::string title = slide_title(xml);
        if (title.empty()) {
            for (const auto& l : lines) {
                if (!extract_detail::js_trim(l).empty()) { title = l; break; }
            }
        }
        std::string text;
        for (size_t k = 0; k < lines.size(); ++k) {
            if (k) text.push_back('\n');
            text += lines[k];
        }

        Json reasons = Json::array();
        if (extract_detail::js_trim(text).empty()) {
            reasons.push_back(images > 0 ? "image_only_slide" : "no_text_extracted");
        }

        Json q = Json::object();
        q["chars"] = static_cast<int64_t>(extract_detail::utf8_count_cp(text));
        q["ratio"] = nullptr;
        q["suspect"] = !reasons.empty();
        q["reasons"] = reasons;

        Json p = Json::object();
        p["index"] = static_cast<int64_t>(i + 1);
        p["title"] = title;
        p["text"] = text;
        p["notes"] = notes;
        p["images"] = images;
        p["quality"] = q;
        pages.push_back(p);

        if (opts.onProgress) opts.onProgress(static_cast<int>(i + 1), static_cast<int>(ordered.ordered.size()));
    }

    if (opts.cancel && opts.cancel->load(std::memory_order_relaxed)) {
        err.code = "CANCELLED";
        err.message = "抽取已取消";
        return false;
    }

    bool anyNotes = false;
    for (const auto& p : pages) if (!p.value("notes", std::string()).empty()) { anyNotes = true; break; }
    if (includeNotes && anyNotes) {
        Json w = Json::object();
        w["level"] = "info";
        w["message"] = "备注页（讲课稿）里的文字已单独抽到 notes 字段，未混进正文";
        warnings.push_back(w);
    }
    std::vector<int> imageOnly;
    for (const auto& p : pages) {
        const Json reasons = p["quality"].value("reasons", Json::array());
        for (const auto& r : reasons) {
            if (r.is_string() && r.get<std::string>() == "image_only_slide") {
                imageOnly.push_back(p.value("index", 0));
                break;
            }
        }
    }
    if (!imageOnly.empty()) {
        std::string list;
        for (size_t i = 0; i < imageOnly.size() && i < 12; ++i) {
            if (i) list += "、";
            list += std::to_string(imageOnly[i]);
        }
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "有 " + std::to_string(imageOnly.size())
                       + " 页只有图片没有文字（第 " + list + " 页），"
                       "这些页的内容抽不出来，生成前请人工核对或改用导出的 PDF";
        warnings.push_back(w);
    }

    out = Json::object();
    out["pages"] = pages;
    out["warnings"] = warnings;
    return true;
}

}  // namespace isg
