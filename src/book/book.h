// 「带上以前的章」的宿主侧（Phase 6）。
//
// 对应 oracle 的 `src/main/book.js` 的**读半身**与 `jobs.js` 的 `describe()`。
// 写半身仍在页面里（oracle 的 `book.js` 逐字节复制进 `web/logic/`，由 fs 垫片落盘），
// 宿主这边只负责：
//   · 列出历史条目并判断"这一份还能不能准确合并"；
//   · 生成之前读旁挂数据 / 把"读不了"的原因说清楚；
//   · 判断新旧章接不接得上（`chapters.js` 的规则在这里有一份 C++ 等价物）。
//
// 为什么读要放在 C++：`book:list` / `book:inspect` 是 IPC 通道，读盘是宿主能力；
// 页面里的 `book.js` 只被流水线用来**写**旁挂数据。
//
// 三条纪律（照抄 oracle book.js 的注释）：
//   1. 读写都不抛给调用方 —— 文件不在 / JSON 坏了 / schema 不认识，都得到一个说得清楚的"不可用"；
//   2. 写入是原子的（页面侧 tmp → rename，见 jobs.cpp 的 renameFile）；
//   3. 题库原样搬，**绝不重算题 id**（id 就是进度存盘键）。
#pragma once

#include "../util/json_util.h"

#include <string>

namespace isg {
namespace book {

constexpr const char* kSchema = "isg-book/1";
constexpr const char* kSidecarSuffix = ".isg.json";

std::wstring sidecar_path_for(const std::wstring& htmlPath);

enum class ReadStatus {
    ok,
    missing,
    corrupt,
    unsupported,
    io,
};

struct ReadResult {
    ReadStatus status = ReadStatus::missing;
    Json book;                  // status == ok 时有效
    std::wstring path;
    std::string schema;
    std::string detail;         // 人话（写进日志）
    bool ok() const { return status == ReadStatus::ok; }
};

ReadResult read_book(const std::wstring& htmlPath);

/** 旁挂数据 → 可以交给拼装器的章列表（每一条都带 frozen:true）。 */
struct SidecarLoad {
    bool ok = false;
    std::string from = "sidecar";
    Json entries = Json::array();
    Json problems = Json::array();
    std::string book_key;
    std::string book_kind;
    std::string detail;
};

/** 只看旁挂数据；不可用时 ok=false，调用方再走 revive。 */
SidecarLoad load_from_sidecar(const std::wstring& htmlPath);

/** 章头归一：`no`（旁挂数据/revive）与 `number`（拼装器）两种写法都认。 */
Json chapter_info(const Json& c);

/**
 * 一条结构数据 → 要带过去的章。
 * `from` 取值 `sidecar` / `revive`，会原样写进条目的 `from`（日志与测试都读它）。
 * 单元/演示里除了列出的必填字段外**原样保留**（shortTitle / quizLead 等拼装器要用）。
 */
Json shape_carry(const Json& entry, const std::string& from);

/** `book:inspect` 的公开形状（**不含** data —— 结构数据可能有几百 KB）。 */
Json inspect_public(const SidecarLoad& loaded);

/** 判断新章能不能接在旧章后面（等价 `pipeline/chapters.js:judgeContinuity`）。 */
Json judge_continuity(const Json& newNos, const Json& knownNos);

/** 给列表条目补 hasChapter / htmlExists / mergeStatus / canMerge / exactMerge / mergeHint。 */
Json describe_for_list(Json entry);

/** `book:inspect` 失败时的一人话（等价 ipc.js:carryFailText）。 */
std::string carry_fail_text(const std::string& label, const Json& problems);

}  // namespace book
}  // namespace isg
