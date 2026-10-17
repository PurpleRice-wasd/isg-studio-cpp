#include "pending.h"

#include "../util/file_ops.h"

#include <windows.h>
#include <shellapi.h>      // CommandLineToArgvW

#include <mutex>
#include <vector>

namespace isg {

namespace {
std::mutex g_mutex;
std::wstring g_path;
}  // namespace

void pending_set(const std::wstring& path) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_path = path;
}

std::wstring pending_take() {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::wstring out = g_path;
    g_path.clear();
    return out;
}

std::wstring first_existing_file(const std::wstring& commandLine) {
    /* 不自己写一个"能处理引号与转义"的解析器 —— 那是 Win32 命令行解析，
       标准答案就是 CommandLineToArgvW（它和 CRT 用的是同一条规则）。 */
    int argc = 0;
    LPWSTR* argv = ::CommandLineToArgvW(commandLine.c_str(), &argc);
    if (argv == nullptr) return std::wstring();
    std::wstring found;
    for (int i = 0; i < argc; ++i) {
        const std::wstring w(argv[i]);
        // 跳过开关（`--xxx`），只看文件参数
        if (w.size() >= 2 && w[0] == L'-' && w[1] == L'-') continue;
        if (stat_path(w).isFile) { found = w; break; }
    }
    ::LocalFree(argv);
    return found;
}

}  // namespace isg
