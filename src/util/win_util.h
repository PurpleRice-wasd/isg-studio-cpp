// 宿主侧的通用小工具：RAII、编码转换、计时、最小 JSON 输出。
//
// 归属策略（guidance §3.6 的 util/，Phase 0 先放在 spike 里）：
//   这一层**不允许依赖 WebView2**，也不允许做业务判断。它只解决"资源什么时候释放"
//   与"字符串怎么不坏"这两类问题。
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <wrl.h>

#include <cstdint>
#include <memory>
#include <string>
#include <utility>

namespace isg {

using Microsoft::WRL::ComPtr;

// ---------------------------------------------------------------------------
// RAII
// ---------------------------------------------------------------------------

/* 把"收尾动作"绑在作用域上：提前 return、异常、多出口分支都不会漏掉释放。
 *
 * 这是本项目对"关得干净"的最低要求——宿主里每一个句柄、每一份 COM 引用都必须有
 * 明确的主人，不靠散落各处的手工 CloseHandle。手写释放最典型的翻车是：
 * 中途 return 走了另一条分支，于是那个事件/映射/线程句柄就永远留在进程里。 */
template <class F>
class ScopeGuard {
public:
    explicit ScopeGuard(F f) noexcept : f_(std::move(f)) {}
    ~ScopeGuard() { if (armed_) f_(); }

    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard& operator=(const ScopeGuard&) = delete;
    ScopeGuard(ScopeGuard&& other) noexcept
        : f_(std::move(other.f_)), armed_(other.armed_) {
        other.armed_ = false;
    }

    /* 显式解除：事情已经成功交接给别人时用，避免"释放两次"。 */
    void dismiss() noexcept { armed_ = false; }

private:
    F f_;
    bool armed_ = true;
};

template <class F>
[[nodiscard]] ScopeGuard<std::decay_t<F>> on_scope_exit(F&& f) {
    return ScopeGuard<std::decay_t<F>>(std::forward<F>(f));
}

/* HANDLE 家族的拥有者：事件、文件、映射、线程一律用它接。 */
struct HandleDeleter {
    void operator()(HANDLE h) const noexcept {
        if (h != nullptr && h != INVALID_HANDLE_VALUE) ::CloseHandle(h);
    }
};
using UniqueHandle = std::unique_ptr<void, HandleDeleter>;

/* ⚠️ 失败时 CreateFileW 家族返回的是 **INVALID_HANDLE_VALUE(-1)，不是 nullptr**。
   unique_ptr 的 operator bool 只看 `!= nullptr`，于是 -1 会被判成"真"——
   `if (!h) return false;` 这种最常见的失败检查根本拦不住，代码会带着一个假句柄往下走，
   全靠后续调用也失败才碰巧返回 false。在这里归一化一次，所有调用点都受益。 */
[[nodiscard]] inline UniqueHandle adopt_handle(HANDLE h) noexcept {
    if (h == INVALID_HANDLE_VALUE) return UniqueHandle(nullptr, HandleDeleter{});
    return UniqueHandle(h, HandleDeleter{});
}

/* 单个文件读入内存的上限。没有它的话，一个超大文件会让 out.resize() 抛 std::bad_alloc，
   而本工程没有 try/catch → std::terminate，**收尾路径全部跳过**（正是"关得干净"要防的）。
   64 MiB 对"一页 HTML 加它的同目录图片"绰绰有余。 */
inline constexpr int64_t kMaxFileBytes = 64LL * 1024 * 1024;

/* HKEY 的拥有者（读 WebView2 运行时版本要用）。 */
struct RegKeyDeleter {
    void operator()(HKEY k) const noexcept {
        if (k != nullptr) ::RegCloseKey(k);
    }
};
using UniqueRegKey = std::unique_ptr<std::remove_pointer_t<HKEY>, RegKeyDeleter>;

// ---------------------------------------------------------------------------
// 字符串
// ---------------------------------------------------------------------------

/* 宽字符 → UTF-8。失败返回空串（不抛：宿主里宁可产出空值也不要在收尾路径上抛）。 */
std::string to_utf8(const std::wstring& w);
std::string to_utf8(const wchar_t* w);
std::wstring to_wide(const std::string& s);

/* JSON 字符串字面量（含首尾引号）：路径里的反斜杠、引号、控制字符都要能扛住。
   报告是要被机器读的，一处没转义整份报告就废了。 */
std::string json_quote(const std::string& s);

/* 把一段 JSON 字符串字面量解回原文。
   WebView2 的 ExecuteScript 返回的是"结果的 JSON 编码"，字符串结果就带一层引号与转义；
   不解开它，读到的 document.title 会是一串 \" 而不是中文。 */
std::string json_unescape_string(const std::string& quoted);

/* JSON 值的缩进片段：报告里嵌 WebView2 原样返回的对象（如几何信息）时直接塞进去。 */
std::string json_raw(const std::string& rawJson);

/* 整条路径是不是纯 ASCII？**WebView2 的 user data folder 必须过这一关**
   （纲领 §7.1 坑 1：含中文的路径会让 Chromium 静默退出、退出码 0）。 */
bool is_ascii(const std::wstring& s);

/* 宽字符版的全量替换。 */
std::wstring replace_wstr(const std::wstring& s, const std::wstring& from, const std::wstring& to);

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

/* 以**本进程创建时刻**为零点，但用**单调时钟**推进。冷/热启动指标（guidance §3.5）
   要的就是"从进程被创建到窗口真的可见过了多少毫秒"；用 GetTickCount64 当零点会漏掉
   加载器把 exe 读进来的时间，而那个差值在 426 MB → 11 MB 的变化里恰恰是大头。

   为什么不能直接用 `GetSystemTimeAsFileTime` 的差值：那是**墙钟**，
   NTP 校时（或虚拟机快照恢复）会把它往前/往后跳。往回跳时所有 deadline 都被推远，
   超时形同失效；往前跳则全部阶段瞬间集体超时。基准必须单调。
   做法：进程创建 → 本对象构造这一段用墙钟量一次（不可重复，但窗口极小），
   之后一律走 QPC（单调、亚微秒）。 */
class ProcessClock {
public:
    ProcessClock() noexcept;
    [[nodiscard]] int64_t elapsed_ms() const noexcept;
    [[nodiscard]] int64_t now_ms() const noexcept { return elapsed_ms(); }
    /* 报告里写上它，免得后来的人以为这些数是墙钟量的。 */
    [[nodiscard]] static const char* kind() noexcept;

private:
    int64_t baseMs_ = 0;      // 进程创建 → 构造，墙钟量一次
    int64_t qpcStart_ = 0;    // 构造时的 QPC 计数
    int64_t qpcFreq_ = 1;     // QPC 频率
};

// ---------------------------------------------------------------------------
// 路径与文件
// ---------------------------------------------------------------------------

/* 取父目录，**不含尾随分隔符**（`C:\a\b.html` → `C:\a`；`C:\a\` → `C:\a`；`C:\` → `C:\`）。
   给本地资源协议算"放行根"用。 */
std::wstring parent_dir(const std::wstring& path);
std::wstring file_name(const std::wstring& path);
bool file_exists(const std::wstring& path);

/* 读整个文件（二进制、原样字节）。失败返回 false。 */
bool read_file_bytes(const std::wstring& path, std::string& out);

/* 写整个文件（二进制）。失败返回 false。 */
bool write_file_bytes(const std::wstring& path, const std::string& bytes);

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/* 给 WIN32 子系统程序接上父进程控制台，让 printf 能被看到。
   为什么不是直接编成控制台程序：那会多弹一个黑框，且不是交付形态。
   AttachConsole 失败（双击运行、没有父控制台）时静默跳过，输出去报告文件。 */
void attach_parent_console();
void console_write(const std::string& utf8);

/* WebView2 运行时版本（注册表 pv）。读不到返回空串——那是"没装运行时"的信号。 */
std::wstring webview2_runtime_version();

/* UTC 时刻的 ISO-8601 文本，形如 `2026-10-17T09:30:00.123Z`。
   与 JS 的 `new Date().toISOString()` 同形（导出文件里的 `__exportedAt` 用它）。 */
std::string iso_timestamp_utc();

/* Debug 构建下打开 CRT 泄漏检查，并在退出时打一份报告。
   用户对本次重写的硬要求之一（见 memory: cpp-shutdown-and-memory-safety）。

   leakReportPath 非空时，把报告**落盘到那个文件**；文件为空 = 没检测到泄漏。
   报告由 CRT 在**进程退出时**写出（那时所有静态与局部对象都已析构）。
   ⚠️ 千万别改成"在 wWinMain 末尾直接 _CrtDumpMemoryLeaks()"：那时 app / apartment
   这些局部对象还活着，它们持有的缓冲会被当成泄漏报出来 —— 一条假警报比没有检查更糟，
   因为它会训练人忽略这份报告（踩过）。

   返回一段**人可读的状态说明**（有没有 _DEBUG、标志位是多少、报告落哪）。
   为什么要返回它：泄漏检查"没报"和"根本没装上"在输出上一模一样。不把状态说出来，
   "跑完没有泄漏报告"就是一句没有内容的结论 —— 这个坑本项目踩过（故意漏 4 KB 也一声不响）。 */
std::string enable_leak_check_on_exit(const std::wstring& leakReportPath);

}  // namespace isg
