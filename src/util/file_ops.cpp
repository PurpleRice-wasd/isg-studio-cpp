#include "file_ops.h"

#include "win_util.h"

#include <windows.h>

namespace isg {

FileInfo stat_path(const std::wstring& path) {
    FileInfo info;
    const DWORD attrs = ::GetFileAttributesW(path.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES) return info;
    info.exists = true;
    info.isDir = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
    info.isFile = !info.isDir;
    WIN32_FILE_ATTRIBUTE_DATA d{};
    if (::GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &d)) {
        ULARGE_INTEGER sz{};
        sz.LowPart = d.nFileSizeLow;
        sz.HighPart = d.nFileSizeHigh;
        info.size = static_cast<int64_t>(sz.QuadPart);
        ULARGE_INTEGER t{};
        t.LowPart = d.ftLastWriteTime.dwLowDateTime;
        t.HighPart = d.ftLastWriteTime.dwHighDateTime;
        // FILETIME 的 100ns 计数 → Unix 毫秒（减掉 1601→1970 的偏移）
        info.mtimeMs = static_cast<int64_t>(t.QuadPart / 10000ULL) - 11644473600000LL;
    }
    return info;
}

std::vector<std::wstring> list_dir(const std::wstring& dir) {
    std::vector<std::wstring> out;
    WIN32_FIND_DATAW fd{};
    const std::wstring pattern = (dir.empty() ? std::wstring(L".") : dir) + L"\\*";
    HANDLE h = ::FindFirstFileW(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return out;
    do {
        const std::wstring name(fd.cFileName);
        if (name == L"." || name == L"..") continue;
        out.push_back(name);
    } while (::FindNextFileW(h, &fd));
    ::FindClose(h);
    return out;
}

bool copy_file(const std::wstring& from, const std::wstring& to) {
    // bFailIfExists = FALSE：目标已存在时覆盖。调用点（bg.cpp）是在临时名上先写，
    // 再 rename_over 就位，所以这里的覆盖语义不会伤到"还在用的那张图"。
    return ::CopyFileW(from.c_str(), to.c_str(), FALSE) != 0;
}

bool remove_file(const std::wstring& path) {
    if (::DeleteFileW(path.c_str())) return true;
    const DWORD err = ::GetLastError();
    return err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND;
}

bool rename_over(const std::wstring& from, const std::wstring& to) {
    return ::MoveFileExW(from.c_str(), to.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
}

bool is_reparse_point(const std::wstring& path) {
    const DWORD attrs = ::GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

namespace {
inline bool is_unreserved(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
        || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*'
        || c == '\'' || c == '(' || c == ')';
}
constexpr char kHex[] = "0123456789ABCDEF";
}  // namespace

std::string uri_component_encode(const std::string& utf8) {
    std::string out;
    out.reserve(utf8.size() * 3);
    for (const char ch : utf8) {
        const unsigned char c = static_cast<unsigned char>(ch);
        if (is_unreserved(c)) {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(kHex[c >> 4]);
            out.push_back(kHex[c & 15]);
        }
    }
    return out;
}

std::string uri_component_decode(const std::string& s) {
    auto hexval = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            const int hi = hexval(s[i + 1]);
            const int lo = hexval(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back(s[i]);
    }
    return out;
}

}  // namespace isg
