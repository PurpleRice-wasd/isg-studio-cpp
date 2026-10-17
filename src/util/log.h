// 宿主侧日志。
//
// 为什么要有它（而不是到处 console_write）：这个项目最怕"失败了不吭声"。
// 日志是唯一一条"事后能看出发生了什么"的通道，所以要满足两条：
//   1. 任何时候写一行都不会因为另一半不在（控制台没接上、文件没打开）而消失；
//   2. **永远不会把 API Key 写进去** —— 这一条靠"只记事件与路径，不记配置对象"的纪律，
//      而不是靠事后过滤（事后过滤总是会漏掉新的字段）。
#pragma once

#include <string>

namespace isg {

/* 把日志同时追加到这个文件（空 = 只打控制台/调试器）。进程存活期间一直有效。 */
void log_set_file(const std::wstring& path);

void log_info(const std::string& msg);
void log_warn(const std::string& msg);
void log_error(const std::string& msg);

/* 最近的若干行（给"运行"视图与崩溃后的自述用）。 */
const std::string& log_tail();

}  // namespace isg
