// 抽取层：课件（PDF / PPTX / 文本）→ 分页文本 + 质量信号。
//
// 对应 oracle 的 `src/main/extract/{index,pdf,pptx,text}.js`。纲领 §6 的映射表把它们
// 划成两类：
//   · index.js / text.js  —— **纯逻辑**，逐条翻译；
//   · pdf.js / pptx.js    —— 宿主能力重写（PDFium / miniz），**版面还原算法照抄**。
//
// 这一层不依赖 WebView2，也不调用桥。桥只在 extract:preview 那里拿到一个 JSON 走人。
//
// 对外契约（architecture.md §3.4，渲染层的 views/extract.js 与 workbench.js 真在读）：
//   {
//     kind: 'pdf'|'pptx'|'text',
//     pages: [{ index(1 起), title:string, text:string,
//               quality:{chars:number, cjkRatio:number, suspect:boolean, ...} }],
//     warnings: [{ level:'info'|'warn', message:string }],
//     meta: { fileName, sizeBytes, pageCount, title? }
//   }
//
// ⚠️ 这里刻意让抽取器**直接产 Json**，而不是先定义一套 C++ 结构再序列化：
//    · 字段名就是契约本身，多一层映射只会多一个"名字抄错"的机会；
//    · 质量字段里允许出现各抽取器自己的诊断字段（reasons / counts / columns …），
//      oracle 的 index.js 也是"只补字段、不抹掉"。
#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <vector>

#include "../util/json_util.h"

namespace isg {

struct ExtractOptions {
    bool stripRunningHeads = true;   // pdf.js: opts.stripRunningHeads !== false
    bool detectColumns = true;       // pdf.js: opts.detectColumns !== false
    bool includeNotes = true;        // pptx.js: opts.includeNotes !== false
    int maxPages = 0;                // 0 = 全部
    // 取消标志：26MB PDF 抽到一半用户关了窗口时，工作线程要在**一页之内**退出。
    // 这是"关得干净"在抽取层的要求 —— detach 掉的线程会在进程退出时被硬杀，
    // 而线程里正拿着 PDFium 的文档句柄。
    std::atomic<bool>* cancel = nullptr;
    // 进度回调（在工作线程上调用）。Phase 2 只用于日志/自测，界面进度仍在 Phase 4。
    std::function<void(int done, int total)> onProgress;
};

struct ExtractError {
    std::string code;      // 空 = 没有错误码（对应 oracle 的普通 Error）
    std::string message;
};

/* 统一入口。成功返回 true 并填 out；失败返回 false 并填 err。
 * `path` 是宽字符，因为桥/对话框拿到的就是宽字符，而且错误信息里要原样带上下文。 */
bool extract_file(const std::wstring& path, const ExtractOptions& opts, Json& out, ExtractError& err);

/* ---- 各格式入口（内部也导出，供自测直接打） ---- */
bool extract_text_file(const std::wstring& path, const std::vector<unsigned char>& bytes,
                       const ExtractOptions& opts, Json& out, ExtractError& err);

bool extract_pptx_file(const std::wstring& path, const std::vector<unsigned char>& bytes,
                       const ExtractOptions& opts, Json& out, ExtractError& err);

bool extract_pdf_file(const std::wstring& path, const std::vector<unsigned char>& bytes,
                      const ExtractOptions& opts, Json& out, ExtractError& err);

/* ---- 质量口径（index.js 里那两段） ---- */
// 中文占比 = CJK 字符 / 非空白字符。pdf/pptx/text 三条路必须用同一个口径。
double extract_cjk_ratio(const std::string& text);
// PPT 标题艺术字常带字间距，导成 PDF 后会变成「导 航 学」。
std::string extract_tidy_title(const std::string& t);

}  // namespace isg
