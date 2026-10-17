// pdf.js 的 C++ 重写（PDFium）：抽文本 + 版面还原 + 质量信号。
//
// 纲领把这一块列为"唯一必须重新推导的算法"（§7.2）。重新推导的是**取原始信息的那一步**：
//   pdf.js: getTextContent() 的 items + transform[4]/[5]/[3]/width
//   PDFium: FPDFText_GetCharOrigin / GetCharBox / GetFontSize（逐字符，比 item 更细）
// 之后的分行、分栏、页眉页脚、质量信号**逐条照抄** pdf.js —— 那些阈值是拿真课件校准出来的
// （20% 的重复页眉阈值、median*0.5 的行容差、median*0.28 的空隙容差、80% 的覆盖门槛）。
//
// 为什么按**字符**而不是 CountRects 的矩形：
//   · pdf.js 的 transform[5] 是基线，矩形只有包围盒；用矩形会让不同字号的行的"y"分叉；
//   · 基线也是页眉/页脚边带判断的分母（MARGIN_BAND 的实测值就来自基线坐标）。
//   逐字符的代价是 PUA 统计不再天然按 item 分组 —— 那里改成按 **PDF 文本对象**
//   （FPDFText_GetTextObject）分组，项目符号与正文的边界比"矩形段"更接近 pdf.js 的 item。
#include "extract.h"

#include "internal.h"

#include "../util/str_util.h"
#include "../util/win_util.h"
#include "fpdf_text.h"
#include "fpdfview.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string_view>
#include <vector>

namespace isg {

namespace {

// ───────────────────────── PDFium 生命周期 ─────────────────────────

struct PdfiumLibrary {
    PdfiumLibrary() { FPDF_InitLibrary(); }
    ~PdfiumLibrary() { FPDF_DestroyLibrary(); }
    PdfiumLibrary(const PdfiumLibrary&) = delete;
    PdfiumLibrary& operator=(const PdfiumLibrary&) = delete;
};

void ensure_pdfium() {
    static PdfiumLibrary lib;
    (void)lib;
}

/* PDFium 的公开文档没有承诺“多个文档可以在不同线程同时处理”。宿主确实会从
   extract:preview 的工作线程调用它（可能同时有两份课件在预览），所以这里串行化
   **文档处理**这一段。初始化用 call_once 已经解决，但文档/页/文本页句柄的并行使用
   没有保证 —— 宁可让第二份预览等一会儿，也不要冒不确定的线程安全风险。 */
std::mutex g_pdfiumMutex;

struct DocumentGuard {
    FPDF_DOCUMENT doc = nullptr;
    ~DocumentGuard() { if (doc) FPDF_CloseDocument(doc); }
};
struct PageGuard {
    FPDF_PAGE page = nullptr;
    ~PageGuard() { if (page) FPDF_ClosePage(page); }
};
struct TextPageGuard {
    FPDF_TEXTPAGE text = nullptr;
    ~TextPageGuard() { if (text) FPDFText_ClosePage(text); }
};

std::string pdf_error_desc(unsigned long code) {
    switch (code) {
        case FPDF_ERR_SUCCESS: return "成功";
        case FPDF_ERR_FILE: return "文件读不了";
        case FPDF_ERR_FORMAT: return "格式错误（文件已损坏或不是 PDF）";
        case FPDF_ERR_PASSWORD: return "需要打开口令";
        case FPDF_ERR_SECURITY: return "不支持的安全方案";
        case FPDF_ERR_PAGE: return "页面内容损坏";
        case FPDF_ERR_UNKNOWN:
        default: return "未知错误";
    }
}

std::string path_basename_utf8(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    return to_utf8((slash == std::wstring::npos) ? path : path.substr(slash + 1));
}

// ───────────────────────── 字符分类（质量信号） ─────────────────────────

struct Stats {
    int64_t chars = 0;
    int64_t ascii = 0;
    int64_t cjk = 0;
    int64_t punct = 0;
    int64_t symbol = 0;
    int64_t pua = 0;
    int64_t replacement = 0;
    int64_t weird = 0;
};

bool in_ranges(uint32_t cp, std::initializer_list<std::pair<uint32_t, uint32_t>> ranges) {
    for (const auto& r : ranges) if (cp >= r.first && cp <= r.second) return true;
    return false;
}

bool is_cjk_range(uint32_t cp) {
    return in_ranges(cp, {{0x3400, 0x4DBF}, {0x4E00, 0x9FFF}, {0xF900, 0xFAFF},
                          {0x3040, 0x30FF}, {0xAC00, 0xD7AF}});
}
bool is_cjk_punct(uint32_t cp) {
    return in_ranges(cp, {{0x3000, 0x303F}, {0xFE30, 0xFE4F}, {0xFF00, 0xFFEF}});
}
bool is_ok_symbol(uint32_t cp) {
    return in_ranges(cp, {{0x2000, 0x206F}, {0x2070, 0x209F}, {0x2190, 0x21FF},
                          {0x2200, 0x22FF}, {0x2460, 0x24FF}, {0x25A0, 0x25FF},
                          {0x2600, 0x27BF}, {0x1D400, 0x1D7FF}});
}
bool is_ok_latin1(uint32_t cp) {
    switch (cp) {
        case 0xA0: case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB5: case 0xB7:
        case 0xB9: case 0xBA: case 0xBC: case 0xBD: case 0xBE: case 0xD7: case 0xF7:
            return true;
        default: return false;
    }
}

void classify(const std::string& str, Stats& stats) {
    using namespace extract_detail;
    size_t i = 0;
    while (i < str.size()) {
        const uint32_t cp = utf8_next(str, i);
        if (cp == 0xFFFD) { ++stats.replacement; }
        else if (cp < 0x80) { ++stats.ascii; }
        else if (is_pua(cp)) { ++stats.pua; }
        else if (is_cjk_range(cp)) { ++stats.cjk; }
        else if (is_cjk_punct(cp)) { ++stats.punct; }
        else if (is_ok_symbol(cp)) { ++stats.symbol; }
        else if (is_ok_latin1(cp)) { ++stats.symbol; }
        else if (cp >= 0x80 && cp <= 0x24F) { ++stats.symbol; }
        else if (cp >= 0x370 && cp <= 0x3FF) { ++stats.symbol; }
        else if (cp >= 0x400 && cp <= 0x4FF) { ++stats.symbol; }
        else { ++stats.weird; }
        ++stats.chars;
    }
}

// 破折号（标题里的「图像增强—概述」）两边不插空格。PDF 里它常是独立的一次
// 文本绘制，逐字符/advance 会把两侧算成空隙；pdf.js 的 item 里是连着的。
bool is_dash_for_space(uint32_t cp) {
    return cp >= 0x2010 && cp <= 0x2015;
}

// pdf.js 的 CJK_RE（决定"两个 CJK 字符之间不插空格"）
bool is_cjk_for_space(uint32_t cp) {
    return in_ranges(cp, {{0x3400, 0x4DBF}, {0x4E00, 0x9FFF}, {0xF900, 0xFAFF},
                          {0x3000, 0x303F}, {0xFF00, 0xFFEF}, {0x3040, 0x30FF}});
}

// ───────────────────────── 行还原 ─────────────────────────

struct Run {
    std::string str;
    double x = 0;
    double y = 0;
    double size = 12;
    double w = 0;
};

struct Line {
    std::string text;
    double x0 = 0;
    double x1 = 0;
    double y = 0;
    bool marginCandidate = false;
};

bool is_space_simple(uint32_t cp) { return cp == ' ' || cp == '\t' || cp == 0xA0; }

// ⚠️ 必须按**码点**折叠，不能按字节。UTF-8 的续字节里经常出现 0xA0
// （「章」= E7 AB A0、「几」= E5 87 A0），按字节把 0xA0 当 NBSP 会把一个汉字
// 改成 "非法字节 + 空格" —— 解码回来就成了 U+FFFD，整段正文看着像字体映射坏了。
std::string collapse_spaces(const std::string& s) {
    using namespace extract_detail;
    std::string out;
    bool inSpace = false;
    size_t i = 0;
    while (i < s.size()) {
        const size_t start = i;
        const uint32_t cp = utf8_next(s, i);
        if (is_space_simple(cp)) {
            if (!inSpace) { out.push_back(' '); inSpace = true; }
        } else {
            out.append(s, start, i - start);
            inSpace = false;
        }
    }
    return out;
}

// port of itemsToLines：用 transform[5]（这里是字符 origin 的 y）聚类成行，
// 用 x 排序；只有 x 之间**真的有**空隙才插空格，且中日韩之间一律不插。
std::vector<Line> items_to_lines(std::vector<Run> runs) {
    using namespace extract_detail;
    if (runs.empty()) return {};

    std::vector<double> sizes;
    sizes.reserve(runs.size());
    for (const auto& r : runs) sizes.push_back(r.size);
    std::sort(sizes.begin(), sizes.end());
    const double medianSize = sizes[sizes.size() >> 1] > 0 ? sizes[sizes.size() >> 1] : 12;
    const double yTol = std::max(medianSize * 0.5, 0.5);

    std::stable_sort(runs.begin(), runs.end(), [](const Run& a, const Run& b) {
        if (a.y != b.y) return a.y > b.y;
        return a.x < b.x;
    });

    struct Row {
        double y = 0;
        std::vector<Run> runs;
    };
    std::vector<Row> rows;
    for (const Run& r : runs) {
        if (rows.empty() || std::fabs(rows.back().y - r.y) > yTol) {
            rows.push_back(Row{r.y, {r}});
        } else {
            rows.back().runs.push_back(r);
            if (r.size > rows.back().runs[0].size) rows.back().y = r.y;
        }
    }

    const double spaceTol = medianSize * 0.28;
    std::vector<Line> out;
    for (auto& row : rows) {
        std::stable_sort(row.runs.begin(), row.runs.end(),
                         [](const Run& a, const Run& b) { return a.x < b.x; });
        std::string text;
        double prevRight = -std::numeric_limits<double>::infinity();
        uint32_t prevChar = 0;
        for (const Run& r : row.runs) {
            if (!text.empty()) {
                const double gap = r.x - prevRight;
                const bool alreadySpaced = is_js_space(last_cp(text)) || is_js_space(first_cp(r.str));
                const bool cjkPair = is_cjk_for_space(prevChar) && is_cjk_for_space(first_cp(r.str));
                const bool dashPair = is_dash_for_space(prevChar) || is_dash_for_space(first_cp(r.str));
                if (gap > spaceTol && !alreadySpaced && !cjkPair && !dashPair) text.push_back(' ');
            }
            text += r.str;
            prevRight = r.x + r.w;
            if (!r.str.empty()) prevChar = last_cp(r.str);
        }
        text = js_trim(collapse_spaces(text));
        if (!text.empty()) {
            double x0 = row.runs.front().x;
            double x1 = row.runs.front().x + row.runs.front().w;
            for (const Run& r : row.runs) {
                x0 = std::min(x0, r.x);
                x1 = std::max(x1, r.x + r.w);
            }
            out.push_back(Line{text, x0, x1, row.y, false});
        }
    }
    return out;
}

// ───────────────────────── 多栏识别 ─────────────────────────

struct Gutter {
    std::vector<Line> left;
    std::vector<Line> right;
    // 横跨"栏缝"的行（标题、通栏公式）。oracle 的 readOrder 只返回 left+right，
    // 这类行会被**静默丢掉**；它大多数时候没有可用的 gutter，所以没暴露。
    // 我们把它单独留着，最后按 y 顺序接上 —— 丢字比顺序不完美严重得多。
    std::vector<Line> rest;
    double gapWidth = 0;
};

std::optional<Gutter> find_gutter(const std::vector<Line>& lines, double pageWidth) {
    if (lines.size() < 6) return std::nullopt;
    std::optional<Gutter> best;
    for (const Line& candLine : lines) {
        const double cand = candLine.x0;
        if (cand < pageWidth * 0.15 || cand > pageWidth * 0.85) continue;
        std::vector<Line> left;
        std::vector<Line> right;
        std::vector<Line> rest;
        for (const Line& l : lines) {
            if (l.x1 <= cand) left.push_back(l);
            else if (l.x0 >= cand) right.push_back(l);
            else rest.push_back(l);
        }
        if (left.size() < 3 || right.size() < 3) continue;
        if (static_cast<double>(left.size() + right.size()) < static_cast<double>(lines.size()) * 0.8) continue;
        double lMin = left[0].y, lMax = left[0].y, rMin = right[0].y, rMax = right[0].y;
        double lMaxX1 = left[0].x1;
        double rMinX0 = right[0].x0;
        for (const Line& l : left) { lMin = std::min(lMin, l.y); lMax = std::max(lMax, l.y); lMaxX1 = std::max(lMaxX1, l.x1); }
        for (const Line& r : right) { rMin = std::min(rMin, r.y); rMax = std::max(rMax, r.y); rMinX0 = std::min(rMinX0, r.x0); }
        if (std::min(lMax, rMax) - std::max(lMin, rMin) <= 0) continue;
        const double gapWidth = rMinX0 - lMaxX1;
        if (gapWidth <= 0) continue;
        // 只在栏缝足够宽时才认。逐字符/advance 得到的 x1 与 pdf.js 的 item width
        // 不完全相同，1–2% 页宽的"空隙"会被误判成两栏（实测 143 页样本有 12 页
        // 误判，通栏文字被丢掉 200+ 字）。10% 页宽远小于真实栏缝；代价是 5 页
        // 与 oracle 的栏数不同（已记在 phase2-report.md §2.2）。
        if (gapWidth < pageWidth * 0.10) continue;
        if (!best || gapWidth > best->gapWidth) {
            best = Gutter{std::move(left), std::move(right), std::move(rest), gapWidth};
        }
    }
    return best;
}

void sort_by_position(std::vector<Line>& lines) {
    std::stable_sort(lines.begin(), lines.end(), [](const Line& a, const Line& b) {
        if (a.y != b.y) return a.y > b.y;
        return a.x0 < b.x0;
    });
}

std::vector<Line> read_order(const std::vector<Line>& lines, double pageWidth, int depth = 0) {
    if (depth > 2) {
        std::vector<Line> v = lines;
        sort_by_position(v);
        return v;
    }
    const auto g = find_gutter(lines, pageWidth);
    if (!g) {
        std::vector<Line> v = lines;
        sort_by_position(v);
        return v;
    }
    std::vector<Line> left = read_order(g->left, pageWidth, depth + 1);
    std::vector<Line> right = read_order(g->right, pageWidth, depth + 1);
    left.insert(left.end(), right.begin(), right.end());
    if (!g->rest.empty()) {
        std::vector<Line> rest = g->rest;
        sort_by_position(rest);
        left.insert(left.end(), rest.begin(), rest.end());
    }
    return left;
}

int count_columns(const std::vector<Line>& lines, double pageWidth) {
    const auto g = find_gutter(lines, pageWidth);
    if (!g) return 1;
    int n = 1;
    if (g->left.size() >= 2 && find_gutter(g->left, pageWidth)) ++n;
    if (g->right.size() >= 2 && find_gutter(g->right, pageWidth)) ++n;
    return n;
}

// ───────────────────────── 页眉页脚 ─────────────────────────

std::string normalise_for_repeat(const std::string& s) { return extract_detail::normalise_for_repeat(s); }

constexpr double kMarginBand = 0.1;

bool in_margin_band(const Line& ln, double pageHeight) {
    if (pageHeight <= 0) return false;
    const double fromTop = pageHeight - ln.y;
    const double fromBottom = ln.y;
    return fromTop <= pageHeight * kMarginBand || fromBottom <= pageHeight * kMarginBand;
}

void mark_margin_lines(std::vector<Line>& ordered, double pageHeight) {
    for (size_t i = 0; i < ordered.size(); ++i) {
        ordered[i].marginCandidate = (i == 0 || i + 1 == ordered.size() || in_margin_band(ordered[i], pageHeight));
    }
}

std::set<std::string> find_running_lines(const std::vector<std::vector<Line>>& pages, int minPages) {
    std::map<std::string, int> counts;
    for (const auto& lines : pages) {
        std::set<std::string> seen;
        for (const Line& ln : lines) {
            if (!ln.marginCandidate) continue;
            if (extract_detail::utf8_count_cp(ln.text) > 80) continue;
            const std::string k = normalise_for_repeat(ln.text);
            if (k.empty() || seen.count(k)) continue;
            seen.insert(k);
            ++counts[k];
        }
    }
    std::set<std::string> repeated;
    for (const auto& kv : counts) if (kv.second >= minPages) repeated.insert(kv.first);
    return repeated;
}

// ───────────────────────── PDFium 取字符 ─────────────────────────

std::string utf16_to_utf8_units(const std::vector<unsigned short>& units, size_t start, size_t count) {
    std::string out;
    for (size_t i = start; i < start + count && i < units.size(); ++i) {
        uint32_t cp = units[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < start + count) {
            const uint32_t lo = units[i + 1];
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                ++i;
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

// 把一页的字符变成 runs（对齐 pdf.js 的 item：一个 run 共用一个基线）。
//
// 为什么按字符取、而不是 FPDFText_CountRects 的矩形：
//   · pdf.js 的 transform[5] 是**基线**；矩形只有包围盒，拿矩形当 y 会让页眉/页脚
//     的边带判断与行聚类整体偏移（实测过：矩形方案把第 6/7/17 页的正文顺序打散）。
//   · 逐字符的 origin 与 pdf.js 的 transform[5] 是同一口径。
// 唯一的例外是**上下标**：它们的 origin 比基线高半行，若不并进前一个 run，
// 就会被 itemsToLines 当成单独的一行排到正文前面（实测：第 26 页开头的两个「2」）。
// 所以只做一件事：字号明显更小、位置紧贴前一个字符的 run，并进去并沿用前者的基线。
void page_runs(FPDF_TEXTPAGE textPage, double pageWidth, double pageHeight,
               std::vector<Run>& runs) {
    (void)pageWidth;
    (void)pageHeight;
    if (textPage == nullptr) return;
    const int count = FPDFText_CountChars(textPage);
    if (count <= 0) return;

    for (int i = 0; i < count; ++i) {
        uint32_t cp = FPDFText_GetUnicode(textPage, i);
        if (cp == 0) continue;
        // 控制字符（PDFium 会把换行/回车作为独立字符返回，字号 1、没有字体）。
        // pdf.js 里它们通常夹在 item 字符串里，跟着 item 的 transform 走；
        // 逐字符拿时它们会凭空造出一行，把阅读顺序带偏。正文不需要它们。
        if (cp < 0x20 || cp == 0x7F) continue;
        int advance = 1;
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < count) {
            const uint32_t lo = FPDFText_GetUnicode(textPage, i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                advance = 2;
            } else {
                cp = 0xFFFD;
            }
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            cp = 0xFFFD;
        }

        double x = 0, y = 0;
        if (!FPDFText_GetCharOrigin(textPage, i, &x, &y)) continue;
        double left = 0, right = 0, bottom = 0, top = 0;
        const bool boxOk = FPDFText_GetCharBox(textPage, i, &left, &right, &bottom, &top) != 0;
        double size = FPDFText_GetFontSize(textPage, i);
        if (!(size > 0)) size = 12;
        double w = boxOk ? std::fabs(right - left) : 0;
        if (!(w > 0.01)) w = size * (is_cjk_for_space(cp) ? 1.0 : 0.5);
        // ⚠️ 用"下一个字符的 origin - 当前 origin"当字宽（advance），不要用字形包围盒：
        // 包围盒通常比 advance 窄，两个字符之间就会被算出一个 0.x em 的"空隙"，
        // 于是 itemsToLines 在**单词内部**插空格 —— 实测把 g(x,y) 变成 g ( x , y )，
        // 整页字符数凭空多出 20%。只在"同一个文本 run"（间距 < 0.9em）时采用，
        // 跨文本块的大间距仍然保留给空格插入逻辑。
        {
            int j = i + advance;
            uint32_t nextCp = 0;
            while (j < count) {
                nextCp = FPDFText_GetUnicode(textPage, j);
                if (nextCp != 0 && nextCp >= 0x20 && nextCp != 0x7F) break;
                ++j;
            }
            if (j < count) {
                double nx = 0, ny = 0;
                if (FPDFText_GetCharOrigin(textPage, j, &nx, &ny)
                    && std::fabs(ny - y) <= size * 0.2 && nx > x) {
                    /* 同一个 PDF 文本对象里的字符，天然就是"一句话"——即使字距被
                       排版拉得很开（公式、字间距、两端对齐），也不该在中间插空格。
                       不同文本对象之间才用 0.9em 的保守阈值。 */
                    const FPDF_PAGEOBJECT curObj = FPDFText_GetTextObject(textPage, i);
                    const FPDF_PAGEOBJECT nextObj = FPDFText_GetTextObject(textPage, j);
                    const bool sameObj = (curObj != nullptr && curObj == nextObj);
                    /* 全角字符的 advance 约 1em；跨文本对象时 0.9em 的阈值会让
                       「（B、L、H）」里的全角括号回退到较窄的包围盒，算出一个假空隙
                       （实测 03-2 第 5 页整页被插成「（ B 、 L 、 H ）」）。 */
                    const bool wide = is_cjk_for_space(cp) || is_cjk_for_space(nextCp);
                    const double limit = std::max(size, 12.0)
                                         * (sameObj ? 3.0 : (wide ? 1.3 : 0.9));
                    if (nx - x <= limit) w = nx - x;
                }
            }
        }

        std::string str;
        extract_detail::utf8_append(str, cp);

        runs.push_back(Run{str, x, y, size, w});
        i += advance - 1;
    }
}

// pdf.js 的 countPuaInWords 是按 item 统计的。PDFium 没有直接的 item 边界，
// 但 CountRects 的矩形段是"同一行、同一字体设置"的连续文本，最接近 item。
// 先按矩形段统计；拿不到矩形时才退回按空白 token 统计。
int64_t pua_rule_for_text(const std::string& text) {
    using namespace extract_detail;
    // 按空白 token 扫。规则与 pdf.js 的 countPuaInWords 同义，但多一条：
    // **token 开头的短 PUA 串是项目符号**（PowerPoint 的 ●/▪ 就住在私用区），
    // 它后面紧跟正文时，pdf.js 里是独立 item（无害），而我们的文本对象/矩形段
    // 会把它们粘在一起（实测误报 5 次）。破字体映射的特征是"一长串 PUA"
    // 或"PUA 夹在词中间"，不是"行首一颗项目符号"。
    int64_t total = 0;
    size_t i = 0;
    while (i < text.size()) {
        // 跳空白
        while (i < text.size()) {
            size_t j = i;
            if (!is_js_space(utf8_next(text, j))) break;
            i = j;
        }
        if (i >= text.size()) break;
        const size_t tokenStart = i;
        size_t tokenEnd = i;
        while (tokenEnd < text.size()) {
            size_t j = tokenEnd;
            if (is_js_space(utf8_next(text, j))) break;
            tokenEnd = j;
        }
        // 扫 token 里的 PUA 串
        size_t p = tokenStart;
        while (p < tokenEnd) {
            const size_t runStart = p;
            uint32_t cp = utf8_next(text, p);
            if (!is_pua(cp)) continue;
            size_t runLen = 1;
            while (p < tokenEnd) {
                size_t q = p;
                const uint32_t c2 = utf8_next(text, q);
                if (!is_pua(c2)) break;
                p = q;
                ++runLen;
            }
            const bool atStart = (runStart == tokenStart);
            if (runLen > 3 || !atStart) total += static_cast<int64_t>(runLen);
        }
        i = tokenEnd;
    }
    return total;
}

// 按 PDF 文本对象（FPDFText_GetTextObject）分组统计。
// 这是比"矩形段"更贴近 pdf.js item 的一层：项目符号常是独立的一次文本绘制，
// 而矩形段会因为"同一行、同一字体"把它和后面的正文并在一起（实测误报 5 次）。
int64_t count_pua_in_objects(FPDF_TEXTPAGE textPage) {
    if (textPage == nullptr) return 0;
    const int count = FPDFText_CountChars(textPage);
    if (count <= 0) return 0;
    int64_t total = 0;
    std::string buf;
    FPDF_PAGEOBJECT cur = nullptr;
    bool started = false;
    auto flush = [&]() {
        if (!buf.empty()) total += pua_rule_for_text(buf);
        buf.clear();
    };
    for (int i = 0; i < count; ++i) {
        const FPDF_PAGEOBJECT obj = FPDFText_GetTextObject(textPage, i);
        if (!started || obj != cur) {
            flush();
            cur = obj;
            started = true;
        }
        uint32_t cp = FPDFText_GetUnicode(textPage, i);
        if (cp == 0) continue;
        if (cp < 0x20 || cp == 0x7F) continue;
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < count) {
            const uint32_t lo = FPDFText_GetUnicode(textPage, i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                ++i;
            } else {
                cp = 0xFFFD;
            }
        }
        extract_detail::utf8_append(buf, cp);
    }
    flush();
    return total;
}


}  // namespace

bool extract_pdf_file(const std::wstring& path, const std::vector<unsigned char>& bytes,
                      const ExtractOptions& opts, Json& out, ExtractError& err) {
    ensure_pdfium();
    std::lock_guard<std::mutex> pdfiumLock(g_pdfiumMutex);
    const std::string base = path_basename_utf8(path);

    DocumentGuard doc;
    doc.doc = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
    if (doc.doc == nullptr) {
        const unsigned long code = FPDF_GetLastError();
        if (code == FPDF_ERR_PASSWORD) {
            Json warnings = Json::array();
            Json w = Json::object();
            w["level"] = "warn";
            w["message"] = "这份 PDF 已加密（需要打开口令），无法抽取文字。请先用 PDF 阅读器另存为不加密的副本再试";
            warnings.push_back(w);
            out = Json::object();
            out["pages"] = Json::array();
            out["warnings"] = warnings;
            return true;
        }
        err.message = base + "：PDF 打不开 —— " + pdf_error_desc(code);
        return false;
    }

    const int numPages = FPDF_GetPageCount(doc.doc);
    const int total = (opts.maxPages > 0) ? std::min(numPages, opts.maxPages) : numPages;

    struct RawPage {
        double width = 0;
        double height = 0;
        std::vector<Line> lines;
        int64_t puaInWords = 0;
    };
    std::vector<RawPage> raw;
    raw.reserve(static_cast<size_t>(std::max(0, total)));
    std::vector<int> pageLoadFails;

    for (int pn = 1; pn <= total; ++pn) {
        if (opts.cancel && opts.cancel->load(std::memory_order_relaxed)) {
            err.code = "CANCELLED";
            err.message = "抽取已取消";
            return false;
        }
        PageGuard page;
        page.page = FPDF_LoadPage(doc.doc, pn - 1);
        if (page.page == nullptr) {
            // 不静默降级：oracle 会抛错终止整份抽取；我们保留其余页，
            // 但必须让用户知道"这一页读失败了"，而不是把它当成正常的空页。
            pageLoadFails.push_back(pn);
            RawPage rp;
            raw.push_back(std::move(rp));
            continue;
        }
        TextPageGuard tp;
        tp.text = FPDFText_LoadPage(page.page);
        const double width = FPDF_GetPageWidthF(page.page);
        const double height = FPDF_GetPageHeightF(page.page);

        std::vector<Run> runs;
        page_runs(tp.text, width, height, runs);

        std::vector<Line> lines = items_to_lines(runs);
        std::vector<Line> ordered = opts.detectColumns ? read_order(lines, width) : [&] {
            std::vector<Line> v = lines;
            sort_by_position(v);
            return v;
        }();
        mark_margin_lines(ordered, height);

        RawPage rp;
        rp.width = width;
        rp.height = height;
        rp.lines = std::move(ordered);
        rp.puaInWords = count_pua_in_objects(tp.text);
        raw.push_back(std::move(rp));

        if (opts.onProgress) opts.onProgress(pn, total);
    }

    // 第二遍：去掉页眉页脚
    const bool strip = opts.stripRunningHeads;
    const int minRepeat = strip
        ? std::max(2, static_cast<int>(std::ceil(static_cast<double>(total) * 0.2)))
        : std::numeric_limits<int>::max();
    std::vector<std::vector<Line>> allLines;
    allLines.reserve(raw.size());
    for (const auto& rp : raw) allLines.push_back(rp.lines);
    const std::set<std::string> repeated = strip ? find_running_lines(allLines, minRepeat)
                                                 : std::set<std::string>();

    struct Draft {
        RawPage* p = nullptr;
        std::vector<Line> kept;
        int dropped = 0;
        Stats stats;
        double density = 0;
    };
    std::vector<Draft> drafts;
    drafts.reserve(raw.size());
    for (auto& rp : raw) {
        Draft d;
        d.p = &rp;
        for (const Line& ln : rp.lines) {
            if (ln.marginCandidate && repeated.count(normalise_for_repeat(ln.text))) {
                ++d.dropped;
                continue;
            }
            d.kept.push_back(ln);
        }
        for (const Line& ln : d.kept) classify(ln.text, d.stats);
        const double area = rp.width * rp.height;
        d.density = area > 0 ? static_cast<double>(d.stats.chars) / area : 0;
        drafts.push_back(std::move(d));
    }

    std::vector<double> dense;
    for (const auto& d : drafts) if (d.density > 0) dense.push_back(d.density);
    std::sort(dense.begin(), dense.end());
    const double medianDensity = dense.empty() ? 0 : dense[dense.size() >> 1];
    int64_t totChars = 0, totCjk = 0;
    for (const auto& d : drafts) { totChars += d.stats.chars; totCjk += d.stats.cjk; }
    const double docCjkRatio = totChars > 0 ? static_cast<double>(totCjk) / static_cast<double>(totChars) : 0;

    Json pages = Json::array();
    for (size_t i = 0; i < drafts.size(); ++i) {
        const Draft& d = drafts[i];
        std::string text;
        for (size_t k = 0; k < d.kept.size(); ++k) {
            if (k) text.push_back('\n');
            text += d.kept[k].text;
        }
        const int64_t badChars = d.stats.replacement + d.p->puaInWords + d.stats.weird;
        const double badRatio = d.stats.chars > 0
            ? static_cast<double>(badChars) / static_cast<double>(d.stats.chars) : 0;

        Json reasons = Json::array();
        if (d.stats.chars == 0) reasons.push_back("no_text_extracted");
        if (badRatio > 0.02) reasons.push_back("bad_glyph_mapping");
        if (docCjkRatio > 0.3 && d.stats.chars > 40 && d.stats.cjk == 0) reasons.push_back("no_cjk_found");

        const bool sparse = d.stats.chars > 0 && medianDensity > 0 && d.density < medianDensity * 0.15;
        if (sparse) reasons.push_back("very_sparse_text");

        bool suspect = false;
        for (const auto& r : reasons) {
            const std::string s = r.get<std::string>();
            if (s == "no_text_extracted" || s == "bad_glyph_mapping") suspect = true;
        }

        Json counts = Json::object();
        counts["chars"] = d.stats.chars;
        counts["ascii"] = d.stats.ascii;
        counts["cjk"] = d.stats.cjk;
        counts["punct"] = d.stats.punct;
        counts["symbol"] = d.stats.symbol;
        counts["pua"] = d.stats.pua;
        counts["replacement"] = d.stats.replacement;
        counts["weird"] = d.stats.weird;
        counts["puaInWords"] = d.p->puaInWords;

        Json q = Json::object();
        q["chars"] = d.stats.chars;
        // Number(density.toExponential(3))：写成一个 JSON 数字，而不是字符串。
        // 不用 snprintf/strtod：它们受 C locale 影响（某些 locale 的小数点是逗号）。
        double ratioNum = d.density;
        if (std::isfinite(ratioNum) && ratioNum > 0) {
            const double mag = std::floor(std::log10(ratioNum));
            const double scale = std::pow(10.0, 3.0 - mag);
            ratioNum = std::round(ratioNum * scale) / scale;
        } else {
            ratioNum = 0;
        }
        q["ratio"] = ratioNum;
        q["suspect"] = suspect;
        q["sparse"] = sparse;
        q["reasons"] = reasons;
        q["counts"] = counts;
        q["droppedRepeatedLines"] = d.dropped;
        q["columns"] = count_columns(d.kept, d.p->width);

        Json p = Json::object();
        p["index"] = static_cast<int64_t>(i + 1);
        p["title"] = d.kept.empty() ? std::string() : extract_detail::utf8_prefix_cp(d.kept[0].text, 120);
        p["text"] = text;
        p["quality"] = q;
        pages.push_back(p);
    }

    Json warnings = Json::array();
    if (!pageLoadFails.empty()) {
        Json w = Json::object();
        w["level"] = "warn";
        std::string list;
        for (size_t i = 0; i < pageLoadFails.size() && i < 12; ++i) {
            if (i) list += "、";
            list += std::to_string(pageLoadFails[i]);
        }
        w["message"] = "有 " + std::to_string(pageLoadFails.size())
                       + " 页读取失败（第 " + list + " 页），已按空页处理；换一份 PDF 或人工补这几页";
        warnings.push_back(w);
    }
    if (!repeated.empty()) {
        int droppedTotal = 0;
        for (const auto& d : drafts) droppedTotal += d.dropped;
        Json w = Json::object();
        w["level"] = "info";
        w["message"] = "已去掉页眉/页脚/页码：" + std::to_string(repeated.size()) + " 种重复文字、共 "
                       + std::to_string(droppedTotal) + " 行（出现在 " + std::to_string(minRepeat)
                       + " 页以上的才剔），页数不变";
        warnings.push_back(w);
    }

    auto collect = [&](const char* reason) {
        std::vector<int> v;
        for (const auto& p : pages) {
            const Json rs = p["quality"].value("reasons", Json::array());
            for (const auto& r : rs) {
                if (r.is_string() && r.get<std::string>() == reason) {
                    v.push_back(p.value("index", 0));
                    break;
                }
            }
        }
        return v;
    };
    auto index_list = [](const std::vector<int>& v, size_t maxN) {
        std::string s;
        for (size_t i = 0; i < v.size() && i < maxN; ++i) {
            if (i) s += "、";
            s += std::to_string(v[i]);
        }
        return s;
    };

    const auto blank = collect("no_text_extracted");
    if (!blank.empty()) {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "有 " + std::to_string(blank.size())
                       + " 页一个字都没抽出来（第 " + index_list(blank, 12) + " 页），"
                       "多半是整页图片或扫描件，需要 OCR 或人工补";
        warnings.push_back(w);
    }
    const auto broken = collect("bad_glyph_mapping");
    if (!broken.empty()) {
        Json w = Json::object();
        w["level"] = "warn";
        w["message"] = "有 " + std::to_string(broken.size())
                       + " 页疑似字体映射损坏、抽出来是乱码（第 " + index_list(broken, 12) + " 页），生成前请核对";
        warnings.push_back(w);
    }
    std::vector<int> multi;
    for (const auto& p : pages) {
        if (p["quality"].value("columns", 1) > 1) multi.push_back(p.value("index", 0));
    }
    if (!multi.empty()) {
        Json w = Json::object();
        w["level"] = "info";
        w["message"] = "有 " + std::to_string(multi.size())
                       + " 页是分栏排版，已按「先左栏后右栏」重排；若顺序不对请人工核对";
        warnings.push_back(w);
    }
    std::vector<int> sparsePages;
    for (const auto& p : pages) {
        if (p["quality"].value("sparse", false)) sparsePages.push_back(p.value("index", 0));
    }
    if (!sparsePages.empty()) {
        Json w = Json::object();
        w["level"] = "info";
        w["message"] = "有 " + std::to_string(sparsePages.size())
                       + " 页几乎没有文字（第 " + index_list(sparsePages, 12)
                       + (sparsePages.size() > 12 ? " 等" : "") + " 页），多半是图表/示意图页 —— "
                       "这些页里的图讲不清楚的地方，生成时会缺内容";
        warnings.push_back(w);
    }

    out = Json::object();
    out["pages"] = pages;
    out["warnings"] = warnings;
    return true;
}

}  // namespace isg
