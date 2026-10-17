#include "log.h"

#include "win_util.h"

#include <deque>
#include <mutex>
#include <string>

namespace isg {

namespace {

std::mutex g_mutex;
std::wstring g_file;
std::deque<std::string> g_lines;      // 最近的若干行
constexpr size_t kTailMax = 400;
constexpr size_t kTailBytesMax = 64 * 1024;

/* 时间戳用本地时间，方便用户对着"我什么时候点的"看。格式固定，别用 locale 相关写法。 */
std::string stamp() {
    SYSTEMTIME st{};
    ::GetLocalTime(&st);
    char buf[64];
    ::snprintf(buf, sizeof(buf), "%02u:%02u:%02u.%03u",
               st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return std::string(buf);
}

void emit(const char* level, const std::string& msg) {
    const std::string line = "[" + stamp() + "][" + level + "] " + msg;
    std::lock_guard<std::mutex> lock(g_mutex);

    console_write(line + "\n");

    if (!g_file.empty()) {
        /* 每行单独开/关文件：日志量很小（几十行一次会话），
           换来的是"崩溃时已经落盘"—— 缓冲住的日志在崩溃那一刻正好丢掉，
           而崩溃恰恰是最需要日志的时候。 */
        std::string bytes = line + "\r\n";
        HANDLE h = ::CreateFileW(g_file.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                                 OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            DWORD wrote = 0;
            ::WriteFile(h, bytes.data(), static_cast<DWORD>(bytes.size()), &wrote, nullptr);
            ::CloseHandle(h);
        }
    }

    g_lines.push_back(line);
    size_t bytes = 0;
    for (const std::string& s : g_lines) bytes += s.size();
    while (g_lines.size() > kTailMax || (bytes > kTailBytesMax && g_lines.size() > 1)) {
        bytes -= g_lines.front().size();
        g_lines.pop_front();
    }
}

}  // namespace

void log_set_file(const std::wstring& path) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_file = path;
}

void log_info(const std::string& msg) { emit("info", msg); }
void log_warn(const std::string& msg) { emit("warn", msg); }
void log_error(const std::string& msg) { emit("error", msg); }

const std::string& log_tail() {
    static std::string joined;
    std::lock_guard<std::mutex> lock(g_mutex);
    joined.clear();
    for (const std::string& s : g_lines) {
        joined += s;
        joined += "\n";
    }
    return joined;
}

}  // namespace isg
