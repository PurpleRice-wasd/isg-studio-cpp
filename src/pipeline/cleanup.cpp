#include "cleanup.h"

#include "../util/file_ops.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <algorithm>
#include <map>
#include <regex>
#include <set>

namespace isg {

namespace {

std::wstring trim_w(const std::wstring& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == L' ' || s[a] == L'\t' || s[a] == L'\r' || s[a] == L'\n')) ++a;
    while (b > a && (s[b - 1] == L' ' || s[b - 1] == L'\t' || s[b - 1] == L'\r' || s[b - 1] == L'\n')) --b;
    return s.substr(a, b - a);
}

std::string str_of(const Json& o, const char* k) {
    if (!o.is_object()) return std::string();
    auto it = o.find(k);
    return (it != o.end() && it->is_string()) ? it->get<std::string>() : std::string();
}

std::wstring normalized_abs(const std::wstring& p) {
    wchar_t buf[32768] = {};
    const DWORD n = ::GetFullPathNameW(p.c_str(), static_cast<DWORD>(std::size(buf)), buf, nullptr);
    return (n > 0 && n < std::size(buf)) ? std::wstring(buf, n) : p;
}

std::wstring lower_w(std::wstring s) {
    std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) {
        return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
    });
    return s;
}

bool inside_dir(const std::wstring& rootIn, const std::wstring& pathIn) {
    if (rootIn.empty() || pathIn.empty()) return false;
    std::wstring root = lower_w(normalized_abs(rootIn));
    const std::wstring path = lower_w(normalized_abs(pathIn));
    if (root.empty() || path.empty()) return false;
    if (path == root) return false;               // 目录本身不算"里面的文件"
    if (root.back() != L'\\') root.push_back(L'\\');
    if (path.size() < root.size()) return false;
    return path.compare(0, root.size(), root) == 0;
}

bool ends_with_ci(const std::wstring& s, const std::wstring& suffix) {
    if (s.size() < suffix.size()) return false;
    return lower_w(s.substr(s.size() - suffix.size())) == lower_w(suffix);
}

/* 探针副本的形状：`_probe_<pid>_<per-run 序号>_<原名>.html`。两段数字是硬特征。 */
bool is_probe_copy(const std::wstring& name) {
    static const std::wstring prefix = L"_probe_";
    if (name.size() <= prefix.size()) return false;
    if (lower_w(name.substr(0, prefix.size())) != prefix) return false;
    size_t i = prefix.size();
    size_t digits1 = 0;
    while (i < name.size() && name[i] >= L'0' && name[i] <= L'9') { ++i; ++digits1; }
    if (digits1 == 0 || i >= name.size() || name[i] != L'_') return false;
    ++i;
    size_t digits2 = 0;
    while (i < name.size() && name[i] >= L'0' && name[i] <= L'9') { ++i; ++digits2; }
    if (digits2 == 0 || i >= name.size() || name[i] != L'_') return false;
    return ends_with_ci(name, L".html") || ends_with_ci(name, L".htm");
}

bool is_pet_name(const std::wstring& name) {
    const std::wstring low = lower_w(name);
    return low == L"pet.png" || low == L"pet.jpg" || low == L"pet.jpeg" || low == L"pet.webp";
}

std::string pet_copy_name_from_log(const Json& job) {
    if (!job.is_object() || !job.contains("logs") || !job["logs"].is_array()) return std::string();
    for (const Json& e : job["logs"]) {
        if (!e.is_object()) continue;
        const std::string msg = str_of(e, "message");
        const std::string needle = "陪练图片已放到页面同目录";
        const size_t at = msg.find(needle);
        if (at == std::string::npos) continue;
        size_t i = at + needle.size();
        auto byte = [&](size_t k) { return static_cast<unsigned char>(msg[k]); };
        while (i < msg.size() && (msg[i] == ':' || byte(i) == 0xEF || byte(i) == 0xBC)) {
            // 兼容全角冒号（UTF-8 EF BC 9A）。⚠️ 必须按 unsigned char 比：
            // char 在这台机器上是 signed，0xBC/0x9A 会被读成负数。
            if (byte(i) == 0xEF && i + 2 < msg.size() && byte(i + 1) == 0xBC && byte(i + 2) == 0x9A) {
                i += 3;
            } else if (msg[i] == ':') {
                ++i;
            } else {
                break;
            }
        }
        while (i < msg.size() && (msg[i] == ' ' || msg[i] == '\t')) ++i;
        size_t j = i;
        while (j < msg.size() && msg[j] != ' ' && msg[j] != '\t' && msg[j] != '\r' && msg[j] != '\n') ++j;
        const std::string name = msg.substr(i, j - i);
        if (!name.empty() && is_pet_name(to_wide(name))) return name;
    }
    return std::string();
}

}  // namespace

std::wstring cleanup_out_dir_of(const Json& job) {
    if (!job.is_object()) return std::wstring();
    if (job.contains("options") && job["options"].is_object()) {
        const std::wstring explicitDir = to_wide(str_of(job["options"], "outputDir"));
        if (!explicitDir.empty()) return normalized_abs(explicitDir);
    }
    const std::wstring fp = to_wide(str_of(job, "filePath"));
    return fp.empty() ? std::wstring() : parent_dir(normalized_abs(fp));
}

CleanupPlan cleanup_scan_run(const Json& job) {
    CleanupPlan plan;
    plan.outDir = cleanup_out_dir_of(job);
    if (plan.outDir.empty()) return plan;

    std::set<std::wstring> seen;
    auto add = [&](const std::wstring& p, const std::string& kind, const std::string& what) {
        if (p.empty()) return;
        const std::wstring abs = normalized_abs(p);
        if (!inside_dir(plan.outDir, abs)) return;
        const std::wstring key = lower_w(abs);
        if (seen.count(key)) return;
        const FileInfo info = stat_path(abs);
        if (!info.exists || !info.isFile) return;
        seen.insert(key);
        CleanupFile f;
        f.path = abs;
        f.bytes = info.size;
        f.kind = kind;
        f.what = what;
        plan.files.push_back(std::move(f));
    };

    const std::wstring htmlPath = to_wide(str_of(job, "htmlPath"));
    if (!htmlPath.empty()) {
        add(htmlPath, "artifact", "本次生成的学习页（半成品或成品）");
        add(htmlPath + L".isg.json", "artifact", "页面旁边的结构化数据（以后并进一册时要用）");
    }

    for (const std::wstring& n : list_dir(plan.outDir)) {
        const std::wstring p = plan.outDir + L"\\" + n;
        if (is_probe_copy(n)) {
            add(p, "probe", "页内自动校验留下的探针副本（只有在进程被强杀、收尾被打断时才会残留）");
        } else if (ends_with_ci(n, L".run.log")) {
            add(p, "log", "这次任务的运行 / 失败日志");
        }
    }

    const std::string petName = pet_copy_name_from_log(job);
    if (!petName.empty()) {
        add(plan.outDir + L"\\" + to_wide(petName), "pet",
            "本次拷进输出目录的陪练图（和你自己放的同名文件可能互相覆盖过）");
    }

    for (const CleanupFile& f : plan.files) {
        if (!inside_dir(plan.outDir, f.path)) {
            /* 内部错误：绝不能放一条目录外的路径出去。清空并让调用方看到空清单，
               比"删到别处去"安全（这条分支理论上到不了）。 */
            plan.files.clear();
            plan.totalBytes = 0;
            return plan;
        }
        plan.totalBytes += f.bytes;
    }
    return plan;
}

Json cleanup_plan_to_json(const CleanupPlan& plan) {
    Json out = Json::object();
    out["outDir"] = to_utf8(plan.outDir);
    Json files = Json::array();
    for (const CleanupFile& f : plan.files) {
        Json o = Json::object();
        o["path"] = to_utf8(f.path);
        o["bytes"] = f.bytes;
        o["kind"] = f.kind;
        o["what"] = f.what;
        files.push_back(std::move(o));
    }
    out["files"] = std::move(files);
    out["totalBytes"] = plan.totalBytes;
    return out;
}

Json cleanup_remove(const Json& list, const std::wstring& within) {
    Json removed = Json::array();
    Json failed = Json::array();
    const Json arr = list.is_array() ? list : Json::array();
    for (const Json& item : arr) {
        std::wstring raw;
        if (item.is_string()) raw = to_wide(item.get<std::string>());
        else if (item.is_object() && item.contains("path") && item["path"].is_string()) {
            raw = to_wide(item["path"].get<std::string>());
        }
        const std::wstring p = trim_w(raw);
        auto fail = [&](const std::string& reason) {
            Json o = Json::object();
            o["path"] = to_utf8(raw);
            o["reason"] = reason;
            failed.push_back(std::move(o));
        };
        if (p.empty()) { fail("没有给出路径"); continue; }
        if (!within.empty() && !inside_dir(within, p)) {
            fail("不在本次的输出目录内，已跳过");
            continue;
        }
        const FileInfo info = stat_path(p);
        if (!info.exists || !info.isFile) {
            fail("不是文件或不存在");
            continue;
        }
        if (remove_file(p)) removed.push_back(to_utf8(p));
        else fail("删除失败（可能被占用或没有权限）");
    }
    Json out = Json::object();
    out["removed"] = std::move(removed);
    out["failed"] = std::move(failed);
    return out;
}

Json cleanup_do(const Json& job, const Json& wanted) {
    const CleanupPlan plan = cleanup_scan_run(job);
    std::set<std::wstring> allow;
    for (const CleanupFile& f : plan.files) allow.insert(lower_w(normalized_abs(f.path)));

    Json keep = Json::array();
    Json rejected = Json::array();
    const Json arr = wanted.is_array() ? wanted : Json::array();
    for (const Json& item : arr) {
        std::string s;
        if (item.is_string()) s = item.get<std::string>();
        else if (item.is_object() && item.contains("path") && item["path"].is_string()) {
            s = item["path"].get<std::string>();
        }
        if (s.empty()) continue;
        const std::wstring abs = normalized_abs(to_wide(s));
        if (allow.count(lower_w(abs))) {
            keep.push_back(s);
        } else {
            Json o = Json::object();
            o["path"] = s;
            o["reason"] = "不在本次任务的清单里，已跳过";
            rejected.push_back(std::move(o));
        }
    }

    Json result = cleanup_remove(keep, plan.outDir);
    Json failed = result["failed"].is_array() ? result["failed"] : Json::array();
    for (const Json& r : rejected) failed.push_back(r);
    Json out = Json::object();
    out["removed"] = result["removed"];
    out["failed"] = std::move(failed);
    return out;
}

}  // namespace isg
