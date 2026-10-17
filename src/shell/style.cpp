#include "style.h"

#include "../util/log.h"

#include <dwmapi.h>

namespace isg {

namespace {
// Win10 1809 之前的属性号；SDK 里没有对应的常量，只能写字面量。
constexpr DWORD kDwmUseImmersiveDarkModeOld = 19;
}  // namespace

bool system_prefers_dark() {
    DWORD value = 1;
    DWORD size = sizeof(value);
    DWORD type = 0;
    HKEY key = nullptr;
    if (::RegOpenKeyExW(HKEY_CURRENT_USER,
                        L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                        0, KEY_READ, &key) != ERROR_SUCCESS) {
        return false;
    }
    const LSTATUS st = ::RegQueryValueExW(key, L"AppsUseLightTheme", nullptr, &type,
                                          reinterpret_cast<LPBYTE>(&value), &size);
    ::RegCloseKey(key);
    if (st != ERROR_SUCCESS || type != REG_DWORD) return false;   // 读不到 → 按浅色
    return value == 0;
}

bool style_apply_dark_title_bar(HWND hwnd, bool dark) {
    if (hwnd == nullptr) return false;
    BOOL value = dark ? TRUE : FALSE;
    HRESULT hr = ::DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &value, sizeof(value));
    if (FAILED(hr)) {
        hr = ::DwmSetWindowAttribute(hwnd, kDwmUseImmersiveDarkModeOld, &value, sizeof(value));
    }
    if (FAILED(hr)) {
        // 不致命：老系统上就是设不上，标题栏跟系统走。**但要说出来**，
        // 而不是让后来的人以为"我们设过了"。
        log_info("标题栏深浅色设置不被支持（错误码 " + std::to_string(static_cast<long>(hr)) + "），跟随系统");
        return false;
    }
    return true;
}

void style_init_for_window(HWND hwnd) {
    style_apply_dark_title_bar(hwnd, system_prefers_dark());
}

}  // namespace isg
