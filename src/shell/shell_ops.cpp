#include "shell_ops.h"

#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <winhttp.h>      // URL_COMPONENTS / WinHttpCrackUrl（网址规范化）

#include <string>

namespace isg {

namespace {

ShellStub g_stub;

void note(const std::string& what) {
    if (g_stub.active && g_stub.record != nullptr) g_stub.record(what);
}

/* 把 UTF-8 的 URL 规范化。用 WinHTTP 的 URL 解析而不是手写 ——
   手写"补不补尾斜杠、什么时候转义"很容易与浏览器的行为分叉，
   而这条路径上的期望值是被自测钉住的。 */
bool normalize_url_impl(const std::string& raw, std::string& out, std::string& err) {
    const std::string trimmed = trim(raw);
    if (trimmed.empty()) {
        err = "没有给出要打开的网址";
        return false;
    }
    std::wstring w = to_wide(trimmed);
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    // 只要它愿意把整段拆开，就说明是个绝对 URL（scheme 必须存在）
    wchar_t scheme[64] = {};
    uc.lpszScheme = scheme;
    uc.dwSchemeLength = static_cast<DWORD>(std::size(scheme));
    wchar_t host[256] = {};
    uc.lpszHostName = host;
    uc.dwHostNameLength = static_cast<DWORD>(std::size(host));
    wchar_t urlpath[4096] = {};
    uc.lpszUrlPath = urlpath;
    uc.dwUrlPathLength = static_cast<DWORD>(std::size(urlpath));
    wchar_t extra[4096] = {};
    uc.lpszExtraInfo = extra;
    uc.dwExtraInfoLength = static_cast<DWORD>(std::size(extra));

    if (!::WinHttpCrackUrl(w.c_str(), static_cast<DWORD>(w.size()), 0, &uc)) {
        err = "这不是一个合法的网址：" + raw;
        return false;
    }
    const std::string s = ascii_lower(to_utf8(std::wstring(scheme, uc.dwSchemeLength)));
    const std::string h = to_utf8(std::wstring(host, uc.dwHostNameLength));
    std::string p = to_utf8(std::wstring(urlpath, uc.dwUrlPathLength));
    const std::string x = to_utf8(std::wstring(extra, uc.dwExtraInfoLength));
    if (p.empty()) p = "/";                 // 根路径补尾斜杠（URL 规范）
    /* ⚠️ 端口**不在 host 字符串里**，它单独放在 uc.nPort 里（WinHttpCrackUrl 的行为，
       第一版想当然地以为 host 会带上 ":9"，结果 `http://localhost:9/x` 被输出成
       `http://localhost/x` —— 而这条恰好是自测钉住的期望值之一，所以当场就被抓到了）。
       只在"非 scheme 默认端口"时才补回去：默认端口显式写出来没有意义，浏览器也会去掉它。 */
    std::string portPart;
    const unsigned short defPort = (s == "https") ? 443 : ((s == "http") ? 80 : 0);
    if (uc.nPort != 0 && uc.nPort != defPort) portPart = ":" + std::to_string(uc.nPort);
    out = s + "://" + h + portPart + p + x;
    return true;
}

}  // namespace

bool normalize_url(const std::string& raw, std::string& out, std::string& err) {
    return normalize_url_impl(raw, out, err);
}

void shell_set_stub(const ShellStub& stub) { g_stub = stub; }

bool shell_open_path(const std::wstring& path, std::string& err) {
    note("openPath:" + to_utf8(path));
    if (g_stub.active) return true;         // 桩：只记账，不真的去执行

    const HINSTANCE r = ::ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    // ShellExecuteW 的返回值 >32 才算成功（<=32 是老式错误码，这套约定是 Win32 的历史包袱）
    if (reinterpret_cast<INT_PTR>(r) <= 32) {
        err = "系统没能打开这个文件（错误码 " + std::to_string(reinterpret_cast<INT_PTR>(r)) + "）";
        return false;
    }
    return true;
}

bool shell_reveal_path(const std::wstring& path, std::string& err) {
    note("revealPath:" + to_utf8(path));
    if (g_stub.active) return true;

    /* 用 Shell API 而不是 `explorer /select,<path>`：后者要拼命令行，
       路径里的空格与逗号会让它选中错的东西（而且对 UNC 路径更麻烦）。 */
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (FAILED(::SHParseDisplayName(path.c_str(), nullptr, &pidl, 0, nullptr)) || pidl == nullptr) {
        err = "定位不到这个位置";
        return false;
    }
    const HRESULT hr = ::SHOpenFolderAndSelectItems(pidl, 0, nullptr, 0);
    ::CoTaskMemFree(pidl);
    if (FAILED(hr)) {
        err = "在文件管理器中定位失败";
        return false;
    }
    return true;
}

bool shell_open_external(const std::string& url, std::string& err) {
    note("openExternal:" + url);
    if (g_stub.active) return true;

    const std::wstring w = to_wide(url);
    const HINSTANCE r = ::ShellExecuteW(nullptr, L"open", w.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    if (reinterpret_cast<INT_PTR>(r) <= 32) {
        err = "系统没能打开这个网址（错误码 " + std::to_string(reinterpret_cast<INT_PTR>(r)) + "）";
        return false;
    }
    return true;
}

}  // namespace isg
