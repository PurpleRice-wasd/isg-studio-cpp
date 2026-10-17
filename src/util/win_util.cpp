#include "win_util.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <type_traits>

#ifdef _DEBUG
#include <crtdbg.h>
#endif

namespace isg {

// ---------------------------------------------------------------------------
// 字符串
// ---------------------------------------------------------------------------

std::string to_utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    const int need = ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                           nullptr, 0, nullptr, nullptr);
    if (need <= 0) return std::string();
    std::string out(static_cast<size_t>(need), '\0');
    const int got = ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                          out.data(), need, nullptr, nullptr);
    if (got <= 0) return std::string();
    out.resize(static_cast<size_t>(got));
    return out;
}

std::string to_utf8(const wchar_t* w) {
    return w == nullptr ? std::string() : to_utf8(std::wstring(w));
}

std::wstring to_wide(const std::string& s) {
    if (s.empty()) return std::wstring();
    const int need = ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                           nullptr, 0);
    if (need <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(need), L'\0');
    const int got = ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                          out.data(), need);
    if (got <= 0) return std::wstring();
    out.resize(static_cast<size_t>(got));
    return out;
}

std::string json_quote(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (const unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    ::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    // UTF-8 的多字节序列原样透传：报告文件本身是 UTF-8。
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    out.push_back('"');
    return out;
}

namespace {

/* 读一个 \uXXXX 转义（代理对由调用方拼接）。非法返回 false 且不前进。 */
bool read_hex4(const std::string& s, size_t pos, unsigned& out) {
    if (pos + 4 > s.size()) return false;
    unsigned v = 0;
    for (size_t i = 0; i < 4; ++i) {
        const char c = s[pos + i];
        v <<= 4;
        if (c >= '0' && c <= '9')      v |= static_cast<unsigned>(c - '0');
        else if (c >= 'a' && c <= 'f') v |= static_cast<unsigned>(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= static_cast<unsigned>(c - 'A' + 10);
        else return false;
    }
    out = v;
    return true;
}

void append_utf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}

}  // namespace

std::string json_unescape_string(const std::string& quoted) {
    // 容错优先：拿到的可能不是带引号的字面量（null / 数字），那就原样返回，
    // 让上层从内容上判断，而不是在这里静默丢东西。
    if (quoted.size() < 2 || quoted.front() != '"' || quoted.back() != '"') return quoted;

    std::string out;
    out.reserve(quoted.size());
    const size_t end = quoted.size() - 1;
    for (size_t i = 1; i < end; ++i) {
        const char c = quoted[i];
        if (c != '\\') { out.push_back(c); continue; }

        if (i + 1 >= end) { out.push_back(c); break; }
        const char e = quoted[++i];
        switch (e) {
            case 'n':  out.push_back('\n'); break;
            case 'r':  out.push_back('\r'); break;
            case 't':  out.push_back('\t'); break;
            case 'b':  out.push_back('\b'); break;
            case 'f':  out.push_back('\f'); break;
            case '"':  out.push_back('"');  break;
            case '\\': out.push_back('\\'); break;
            case '/':  out.push_back('/');  break;
            case 'u': {
                unsigned cp = 0;
                if (!read_hex4(quoted, i + 1, cp)) { out.push_back('u'); break; }
                i += 4;
                // 代理对：高代理后面必须紧跟 \uDC00-\uDFFF 的低代理
                if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 < end
                    && quoted[i + 1] == '\\' && quoted[i + 2] == 'u') {
                    unsigned lo = 0;
                    if (read_hex4(quoted, i + 3, lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                        i += 6;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    }
                }
                // 孤立代理项（0xD800–0xDFFF 落单）不是合法码点：直接编码会写出
                // CESU-8 三字节，那是**非法 UTF-8**，会让整份报告在严格解析器里读不了。
                // 换成替换字符 U+FFFD，保住"报告永远是合法 UTF-8"这条底线。
                if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
                append_utf8(out, cp);
                break;
            }
            default:
                // 未知转义：原样保留两个字符，别丢信息
                out.push_back('\\');
                out.push_back(e);
                break;
        }
    }
    return out;
}

std::string json_raw(const std::string& rawJson) {
    return rawJson.empty() ? std::string("null") : rawJson;
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------

namespace {

/* FILETIME → 100 纳秒计数 */
inline uint64_t filetime_ticks(const FILETIME& ft) noexcept {
    ULARGE_INTEGER u{};
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return u.QuadPart;
}

}  // namespace

ProcessClock::ProcessClock() noexcept {
    // QPC 频率：进程生命周期内不变，取一次就够
    LARGE_INTEGER f{};
    qpcFreq_ = (::QueryPerformanceFrequency(&f) && f.QuadPart > 0) ? f.QuadPart : 1;
    LARGE_INTEGER q{};
    ::QueryPerformanceCounter(&q);
    qpcStart_ = q.QuadPart;

    // 进程创建 → 现在，这一段只能用墙钟量（没有别的时钟跨越了进程创建时刻）。
    // 窗口只有几毫秒，NTP 在这期间跳变的概率可以忽略。
    FILETIME created{}, exited{}, kernel{}, user{}, now{};
    ::GetSystemTimeAsFileTime(&now);
    if (::GetProcessTimes(::GetCurrentProcess(), &created, &exited, &kernel, &user)) {
        const uint64_t c = filetime_ticks(created);
        const uint64_t n = filetime_ticks(now);
        baseMs_ = (n > c) ? static_cast<int64_t>((n - c) / 10000ULL) : 0;
    } else {
        baseMs_ = 0;   // 退化成"从本对象构造算起"，至少不会给出负值
    }
}

int64_t ProcessClock::elapsed_ms() const noexcept {
    LARGE_INTEGER q{};
    if (!::QueryPerformanceCounter(&q)) return baseMs_;
    const int64_t delta = q.QuadPart - qpcStart_;
    if (delta <= 0) return baseMs_;        // QPC 单调，正常不会发生；防御一下
    return baseMs_ + (delta * 1000) / qpcFreq_;
}

const char* ProcessClock::kind() noexcept {
    return "QPC（单调）+ GetProcessTimes 定零点";
}

// ---------------------------------------------------------------------------
// 路径与文件
// ---------------------------------------------------------------------------

std::wstring parent_dir(const std::wstring& path) {
    // 先去尾随分隔符，再找最后一个分隔符 —— 否则 `C:\dir\` 会算出 `C:\dir` 之外的东西
    std::wstring p = path;
    while (p.size() > 3 && (p.back() == L'\\' || p.back() == L'/')) p.pop_back();

    const size_t pos = p.find_last_of(L"\\/");
    if (pos == std::wstring::npos) return L".";             // 没有分隔符：就是当前目录
    if (pos == 0) return p.substr(0, 1);                   // 根相对，如 L"\dir"
    if (pos == 2 && p[1] == L':') return p.substr(0, 3);   // 驱动器根，如 L"C:\"
    return p.substr(0, pos);                               // 不含尾随分隔符
}

std::wstring file_name(const std::wstring& path) {
    const size_t p = path.find_last_of(L"\\/");
    return p == std::wstring::npos ? path : path.substr(p + 1);
}

bool file_exists(const std::wstring& path) {
    const DWORD attrs = ::GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

bool read_file_bytes(const std::wstring& path, std::string& out) {
    UniqueHandle h(adopt_handle(::CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)));
    if (!h) return false;

    LARGE_INTEGER size{};
    if (!::GetFileSizeEx(h.get(), &size)) return false;
    // 上限检查放在 resize 之前：否则超大文件会 std::bad_alloc → terminate，
    // 收尾路径被跳过（见 kMaxFileBytes 的说明）。
    if (size.QuadPart < 0 || size.QuadPart > kMaxFileBytes) return false;

    out.resize(static_cast<size_t>(size.QuadPart));
    size_t done = 0;
    while (done < out.size()) {
        DWORD got = 0;
        const DWORD want = static_cast<DWORD>(
            (out.size() - done) > 0x10000000ULL ? 0x10000000ULL : (out.size() - done));
        if (!::ReadFile(h.get(), out.data() + done, want, &got, nullptr) || got == 0) return false;
        done += got;
    }
    return true;
}

bool write_file_bytes(const std::wstring& path, const std::string& bytes) {
    UniqueHandle h(adopt_handle(::CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr)));
    if (!h) return false;

    size_t done = 0;
    while (done < bytes.size()) {
        DWORD wrote = 0;
        const DWORD want = static_cast<DWORD>(
            (bytes.size() - done) > 0x10000000ULL ? 0x10000000ULL : (bytes.size() - done));
        if (!::WriteFile(h.get(), bytes.data() + done, want, &wrote, nullptr) || wrote == 0) {
            return false;
        }
        done += wrote;
    }
    return true;
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

void attach_parent_console() {
    /* ⚠️ 先看标准输出**是不是已经被重定向**（管道/文件）。
       第一版无条件 freopen：于是 `--report=x` 之外的每一种"把输出接走"的用法
       （Start-Process -RedirectStandardOutput、`| more`、CI 收集日志）都会被它掐断 ——
       子进程把那个管道句柄关掉，外面立刻收到 EOF，**从此一个字节都收不到**，
       而且看起来像"程序什么都没打印"。这正是"静默失效"，只是发生在最不起眼的角落。
       已经给了标准句柄就说明有人在收，什么都别动。 */
    const HANDLE existing = ::GetStdHandle(STD_OUTPUT_HANDLE);
    if (existing != nullptr && existing != INVALID_HANDLE_VALUE) {
        const DWORD type = ::GetFileType(existing);
        if (type == FILE_TYPE_PIPE || type == FILE_TYPE_DISK) return;   // 有人在收，别碰
    }
    if (::AttachConsole(ATTACH_PARENT_PROCESS)) {
        // 复用父进程的标准流；父进程没有控制台时 AttachConsole 直接失败，那就什么都不做。
        FILE* dummy = nullptr;
        (void)::freopen_s(&dummy, "CONOUT$", "w", stdout);
        (void)::freopen_s(&dummy, "CONOUT$", "w", stderr);
    }
}

void console_write(const std::string& utf8) {
    // 写控制台用宽字符路径：cmd 默认代码页是 936，直接写 UTF-8 字节会乱码，
    // 而这里输出的几乎全是中文（含 --help、用法错误、失败原因）。
    const HANDLE h = ::GetStdHandle(STD_OUTPUT_HANDLE);
    bool wrote = false;

    if (h != nullptr && h != INVALID_HANDLE_VALUE && !utf8.empty()) {
        const std::wstring w = to_wide(utf8);
        DWORD got = 0;
        if (!w.empty() &&
            ::WriteConsoleW(h, w.c_str(), static_cast<DWORD>(w.size()), &got, nullptr) && got > 0) {
            wrote = true;
        }
    }

    /* 降级路径：stdout 被重定向成管道/文件时 WriteConsoleW **一定失败**
       （它不是控制台句柄）。没有这条降级，"所有诊断信息静默消失"——
       `--help`、`[用法错误]`、`[失败] <原因>` 一个字节都留不下，
       而重定向、管道、CI、Start-Process -RedirectStandardOutput 全都会触发它。
       这类"失败不吭声"正是本项目最想消灭的东西。 */
    if (!wrote && h != nullptr && h != INVALID_HANDLE_VALUE) {
        DWORD got = 0;
        ::WriteFile(h, utf8.data(), static_cast<DWORD>(utf8.size()), &got, nullptr);
    }

    ::OutputDebugStringA(utf8.c_str());
}

std::wstring webview2_runtime_version() {
    // 三个位置都查：WebView2 运行时可能是按机器装（HKLM）或按用户装（HKCU），
    // 64 位系统上 32 位视图在 WOW6432Node 下。少查一个就会把"装了"误判成"没装"。
    struct Probe { HKEY root; const wchar_t* sub; };
    const Probe probes[] = {
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\"
                             L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"},
        {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\"
                             L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"},
        {HKEY_CURRENT_USER,  L"SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\"
                             L"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"},
    };
    for (const Probe& p : probes) {
        HKEY raw = nullptr;
        if (::RegOpenKeyExW(p.root, p.sub, 0, KEY_READ, &raw) != ERROR_SUCCESS) continue;
        UniqueRegKey key(raw);
        wchar_t buf[128] = {};
        DWORD cb = sizeof(buf) - sizeof(wchar_t);
        DWORD type = 0;
        if (::RegQueryValueExW(key.get(), L"pv", nullptr, &type,
                               reinterpret_cast<LPBYTE>(buf), &cb) == ERROR_SUCCESS
            && type == REG_SZ && buf[0] != L'\0') {
            return std::wstring(buf);
        }
    }
    return std::wstring();
}

bool is_ascii(const std::wstring& s) {
    for (const wchar_t c : s) {
        if (c < 0 || c > 0x7F) return false;
    }
    return true;
}

std::wstring replace_wstr(const std::wstring& s, const std::wstring& from, const std::wstring& to) {
    if (from.empty()) return s;
    std::wstring out;
    size_t pos = 0;
    while (true) {
        const size_t hit = s.find(from, pos);
        if (hit == std::wstring::npos) {
            out.append(s, pos, std::wstring::npos);
            break;
        }
        out.append(s, pos, hit - pos);
        out += to;
        pos = hit + from.size();
    }
    return out;
}

std::string iso_timestamp_utc() {
    SYSTEMTIME st{};
    ::GetSystemTime(&st);   // GetSystemTime 给的就是 UTC（GetLocalTime 才是本地时间）
    char buf[40];
    ::snprintf(buf, sizeof(buf), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
               st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    return std::string(buf);
}

std::string enable_leak_check_on_exit(const std::wstring& leakReportPath) {
#ifdef _DEBUG
    int flags = _CrtSetDbgFlag(_CRTDBG_REPORT_FLAG);
    flags |= _CRTDBG_ALLOC_MEM_DF | _CRTDBG_LEAK_CHECK_DF;
    _CrtSetDbgFlag(flags);

    // ⚠️ _CrtSetDbgFlag 返回的是**改之前**的值，不是改之后的。
    // 拿返回值当"现在的状态"打印，会得到"标志没设上"的假象（踩过）。
    // 要读现状就再问一次 _CRTDBG_REPORT_FLAG。
    const int now = _CrtSetDbgFlag(_CRTDBG_REPORT_FLAG);

    std::string sink = "未落盘（只能进调试器输出）";
    if (!leakReportPath.empty()) {
        /* ⚠️ 这个句柄**故意不关**：它是 CRT 退出时写报告的去处，关掉就写不进去了。
           它不是"漏"，是刻意的生命周期 —— 进程结束时由操作系统回收。 */
        HANDLE h = ::CreateFileW(leakReportPath.c_str(), GENERIC_WRITE, 0, nullptr,
                                 CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            _CrtSetReportMode(_CRT_WARN, _CRTDBG_MODE_FILE);
            _CrtSetReportFile(_CRT_WARN, h);
            sink = to_utf8(leakReportPath);
        } else {
            sink = "打不开 " + to_utf8(leakReportPath);
        }
    }

    char b[512];
    ::snprintf(b, sizeof(b),
               "_DEBUG=已定义 标志位=0x%X（ALLOC_MEM_DF=%s LEAK_CHECK_DF=%s）报告落盘=%s\n",
               now,
               (now & _CRTDBG_ALLOC_MEM_DF) ? "开" : "关",
               (now & _CRTDBG_LEAK_CHECK_DF) ? "开" : "关",
               sink.c_str());
    return std::string(b);
#else
    (void)leakReportPath;
    return "_DEBUG=未定义 —— CRT 泄漏检查被整段编译掉了，本次运行的\"没有泄漏报告\"不作数。\n";
#endif
}

}  // namespace isg
