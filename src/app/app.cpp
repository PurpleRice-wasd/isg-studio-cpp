#include "app.h"

#include "../util/file_ops.h"
#include "../util/win_util.h"

#include <windows.h>
#include <shlobj.h>

#include <string>

namespace isg {

namespace {

std::wstring g_userDataOverride;   // 非空 = 被自测顶掉了
constexpr wchar_t kAppDirName[] = L"isg-studio";   // ⚠️ 纯 ASCII，别改（见 app.h 顶部）

std::wstring env_var(const wchar_t* name) {
    const DWORD need = ::GetEnvironmentVariableW(name, nullptr, 0);
    if (need == 0) return std::wstring();
    std::wstring buf(need, L'\0');
    const DWORD got = ::GetEnvironmentVariableW(name, buf.data(), need);
    if (got == 0 || got >= need) return std::wstring();
    buf.resize(got);
    return buf;
}

}  // namespace

void set_user_data_dir(const std::wstring& dir) { g_userDataOverride = dir; }

std::wstring user_data_dir() {
    if (!g_userDataOverride.empty()) return g_userDataOverride;

    // 环境变量优先：打包产物的验收脚本、以及"把配置搬到别处"的排查都用它。
    // 注意它只顶掉**目录**，不顶掉目录名规则 —— 拿到的值原样使用，调用方负责给绝对路径。
    const std::wstring fromEnv = env_var(L"ISG_USER_DATA");
    if (!fromEnv.empty()) return fromEnv;

    /* SHGetKnownFolderPath(FOLDERID_RoamingAppData)：
       不用 %APPDATA% 环境变量拼，因为环境变量可以被随便改，而 Known Folder
       才是"漫游配置到底在哪"的权威答案（也顺带处理了域账户/重定向的情况）。 */
    PWSTR raw = nullptr;
    std::wstring base;
    if (SUCCEEDED(::SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &raw)) && raw != nullptr) {
        base.assign(raw);
        ::CoTaskMemFree(raw);
    }
    if (base.empty()) {
        // 理论上到不了；真到了也要给出一个可用的目录，而不是空串（空串会让所有设置读写静默失败）
        const std::wstring profile = env_var(L"USERPROFILE");
        base = profile.empty() ? std::wstring(L".") : profile + L"\\AppData\\Roaming";
    }
    return base + L"\\" + kAppDirName;
}

std::wstring exe_dir() {
    wchar_t buf[MAX_PATH * 4] = {};
    const DWORD got = ::GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
    if (got == 0) return std::wstring(L".");
    return parent_dir(std::wstring(buf, got));
}

const char* app_version() { return ISG_APP_VERSION; }
const char* app_display_name() { return "讲练一体工作台"; }

std::string skill_dir_error_detail;

std::wstring skill_dir() {
    skill_dir_error_detail.clear();
    /* ① 环境变量（开发/排障时指到任意一份 skill）。
       ⚠️ **一旦设置就以它为准，绝不静默回退**（architecture.md §2 的原文）。
       第一版写的是"目录存在就用，否则往下找" —— 用户把 ISG_SKILL_DIR 写错时，
       应用会默默用另一份内核，界面上还显示"找到 skill"。那是把承诺（改 skill 就生效）
       变成了谎言，而且没有任何迹象。
       另外要校验它**像一份 skill**（有 SKILL.md 与 assets/），不只是"是个目录"。 */
    const std::wstring fromEnv = env_var(L"ISG_SKILL_DIR");
    if (!fromEnv.empty()) {
        if (stat_path(fromEnv).isDir
            && stat_path(fromEnv + L"\\SKILL.md").isFile
            && stat_path(fromEnv + L"\\assets").isDir) {
            return fromEnv;
        }
        skill_dir_error_detail = "ISG_SKILL_DIR 指向的位置不像一份 skill（缺 SKILL.md 或 assets/）："
                               + to_utf8(fromEnv) + "。按约定它一旦设置就以它为准，不会回退到别处。";
        return std::wstring();
    }

    const std::wstring exe = exe_dir();
    // ② 打包态：<exe 旁>\skill
    const std::wstring packed = exe + L"\\skill";
    if (stat_path(packed).isDir && stat_path(packed + L"\\SKILL.md").isFile) return packed;
    // ③ 开发态：<工程>\build\dist\isg-studio.exe → ../../.. 是 apps/，再往上到仓库根
    //    apps/isg-studio-cpp/build/dist → 仓库根\skills\interactive-study-guide
    const std::wstring dev = exe + L"\\..\\..\\..\\..\\skills\\interactive-study-guide";
    if (stat_path(dev).isDir && stat_path(dev + L"\\SKILL.md").isFile) {
        // 归一化：返回带 `..` 的路径会让后面的白名单前缀比较变成坑
        wchar_t full[MAX_PATH * 4] = {};
        if (::GetFullPathNameW(dev.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr) > 0) {
            return std::wstring(full);
        }
        return dev;
    }
    if (skill_dir_error_detail.empty()) {
        skill_dir_error_detail = "没找到 skill 目录（ISG_SKILL_DIR / <exe 旁>\\skill / 开发态相对路径 都不成立）";
    }
    return std::wstring();   // 空串 = 没找到，由调用方报错（绝不静默降级）
}

const std::string& skill_dir_error() { return skill_dir_error_detail; }

std::wstring contract_path() {
    const std::wstring exe = exe_dir();
    const std::wstring packed = exe + L"\\docs\\generation-contract.md";
    if (stat_path(packed).isFile) return packed;
    const std::wstring dev = exe + L"\\..\\..\\..\\isg-studio\\docs\\generation-contract.md";
    if (stat_path(dev).isFile) {
        wchar_t full[MAX_PATH * 4] = {};
        if (::GetFullPathNameW(dev.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr) > 0) {
            return std::wstring(full);
        }
        return dev;
    }
    return std::wstring();
}

}  // namespace isg
