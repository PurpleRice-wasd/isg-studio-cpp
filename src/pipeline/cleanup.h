// 跑砸 / 取消之后的收尾清单（Phase 6）。对应 oracle 的 `src/main/cleanup.js`。
//
// 三条纪律（照抄 oracle）：
//   1. **宁可漏，不可误删**：陪练图只有拿到"这次真拷过"的日志证据才算；
//      探针副本按形状认（`_probe_<pid>_<序号>_`，两段数字是硬特征），用户手写的名字不会命中；
//   2. 扫与删分开：渲染层先拿清单、用户确认，再回来删；`run:doCleanup` 收到的路径要**再扫一遍**
//      核对，不让渲染层递任意路径来删；
//   3. 返回前再断言一次所有路径都在输出目录内 —— 这是"删到别处去"的最后一道闸。
//
// 用户对本工程的原话是"删除指令要三思"，所以这里所有删除都是：
// 非空 → 绝对化 → 在输出目录内 → 确认是文件 → 才删。
#pragma once

#include "../util/json_util.h"

#include <cstdint>
#include <string>
#include <vector>

namespace isg {

struct CleanupFile {
    std::wstring path;
    int64_t bytes = 0;
    std::string kind;      // artifact / probe / log / pet
    std::string what;      // 给人看的一句话
};

struct CleanupPlan {
    std::wstring outDir;
    std::vector<CleanupFile> files;
    int64_t totalBytes = 0;
};

/** 与 pipeline 落盘同一条算法：`options.outputDir || dirname(filePath)`。 */
std::wstring cleanup_out_dir_of(const Json& job);

/** 只读扫描。目录外的路径一律不进清单。 */
CleanupPlan cleanup_scan_run(const Json& job);

Json cleanup_plan_to_json(const CleanupPlan& plan);

/** 按清单删。`within` 给定时，路径必须落在它里面。单个失败不中断，如实回报。 */
Json cleanup_remove(const Json& list, const std::wstring& within);

/** 给通道层用：重新扫一遍，只保留"确实还在本次清单里"的路径，然后删。 */
Json cleanup_do(const Json& job, const Json& wanted);

}  // namespace isg
