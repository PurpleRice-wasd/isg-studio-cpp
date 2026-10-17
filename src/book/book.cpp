#include "book.h"

#include "../util/file_ops.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <vector>

namespace isg {
namespace book {

namespace {

std::string str_of(const Json& o, const char* k) {
    if (!o.is_object()) return std::string();
    auto it = o.find(k);
    if (it == o.end() || it->is_null()) return std::string();
    if (it->is_string()) return it->get<std::string>();
    if (it->is_number()) return it->dump();
    if (it->is_boolean()) return it->get<bool>() ? "true" : "false";
    return std::string();
}

/** JS 的 String(v)：数字按 JS 的写法（整数不带 .0），其余非字符串给空串。 */
std::string js_str(const Json& v) {
    if (v.is_string()) return v.get<std::string>();
    if (v.is_number_integer()) return std::to_string(v.get<int64_t>());
    if (v.is_number_unsigned()) return std::to_string(v.get<uint64_t>());
    if (v.is_number_float()) {
        const double d = v.get<double>();
        if (std::isfinite(d) && d == std::floor(d) && std::fabs(d) < 9.0e15) {
            return std::to_string(static_cast<long long>(d));
        }
        return v.dump();
    }
    if (v.is_boolean()) return v.get<bool>() ? "true" : "false";
    return std::string();
}

Json str_arr() { return Json::array(); }

std::string problem_text(const Json& problems, const std::string& field) {
    if (!problems.is_array()) return std::string();
    for (const Json& p : problems) {
        if (p.is_object()) {
            if (p.contains(field) && p[field].is_string()) return p[field].get<std::string>();
        }
    }
    return std::string();
}

}  // namespace

std::wstring sidecar_path_for(const std::wstring& htmlPath) {
    if (htmlPath.empty()) return std::wstring();
    return htmlPath + L".isg.json";
}

ReadResult read_book(const std::wstring& htmlPath) {
    ReadResult r;
    r.path = sidecar_path_for(htmlPath);
    if (r.path.empty()) {
        r.status = ReadStatus::missing;
        r.detail = "htmlPath 是空的";
        return r;
    }
    const FileInfo info = stat_path(r.path);
    if (!info.exists || !info.isFile) {
        r.status = ReadStatus::missing;
        r.detail = "页面旁边没有结构化数据";
        return r;
    }
    std::string raw;
    if (!read_file_bytes(r.path, raw)) {
        r.status = ReadStatus::io;
        r.detail = "结构化数据读不动";
        return r;
    }
    Json obj;
    std::string err;
    if (!json_parse(raw, obj, err)) {
        r.status = ReadStatus::corrupt;
        r.detail = "JSON 解析失败：" + err;
        return r;
    }
    if (!obj.is_object()) {
        r.status = ReadStatus::corrupt;
        r.detail = "文件内容不是一个对象";
        return r;
    }
    r.schema = str_of(obj, "schema");
    if (r.schema.empty()) {
        r.status = ReadStatus::corrupt;
        r.detail = "没有 schema 字段（可能不是本程序写的文件）";
        return r;
    }
    if (r.schema != kSchema) {
        r.status = ReadStatus::unsupported;
        r.detail = "这份数据的版本「" + r.schema + "」不认识（本程序支持到 " + kSchema + "）";
        return r;
    }
    if (!obj.contains("chapters") || !obj["chapters"].is_array() || obj["chapters"].empty()) {
        r.status = ReadStatus::corrupt;
        r.detail = "读取器拿不到 chapters 数组";
        return r;
    }
    r.status = ReadStatus::ok;
    r.book = std::move(obj);
    return r;
}

Json chapter_info(const Json& c) {
    Json x = c.is_object() ? c : Json::object();
    Json no = x.contains("no") && !x["no"].is_null() ? x["no"] : Json();
    if (js_str(no).empty() && x.contains("number") && !x["number"].is_null()) no = x["number"];
    Json out = Json::object();
    out["no"] = js_str(no);
    out["title"] = js_str(x.contains("title") ? x["title"] : Json());
    out["subject"] = js_str(x.contains("subject") ? x["subject"] : Json());
    out["intro"] = js_str(x.contains("intro") ? x["intro"] : Json());
    return out;
}

Json shape_carry(const Json& entry, const std::string& from) {
    Json x = entry.is_object() ? entry : Json::object();
    Json out = Json::object();
    out["chapter"] = chapter_info(x.contains("chapter") ? x["chapter"] : Json());

    const Json unitsIn = x.contains("units") && x["units"].is_array() ? x["units"] : Json::array();
    Json units = Json::array();
    std::map<std::string, std::string> titleById;
    int ui = 0;
    for (const Json& u : unitsIn) {
        Json y = u.is_object() ? u : Json::object();
        const std::string id = str_of(y, "id").empty()
                                   ? ("u" + std::to_string(++ui)) : str_of(y, "id");
        Json o = y;
        o["id"] = id;
        o["num"] = str_of(y, "num");
        o["title"] = str_of(y, "title");
        o["qsecTitle"] = str_of(y, "qsecTitle");
        o["lede"] = str_of(y, "lede");
        o["lectureHtml"] = str_of(y, "lectureHtml");
        /* ⚠️ 题库原样搬：不规范化、不改 id。改一个 id 就等于那一道题的进度凭空消失。 */
        o["bank"] = (y.contains("bank") && y["bank"].is_array()) ? y["bank"] : Json::array();
        titleById[id] = str_of(y, "title");
        units.push_back(std::move(o));
    }
    out["units"] = std::move(units);

    const Json demosIn = x.contains("demos") && x["demos"].is_array() ? x["demos"] : Json::array();
    Json demos = Json::array();
    int di = 0;
    for (const Json& d : demosIn) {
        Json y = d.is_object() ? d : Json::object();
        const std::string uid = str_of(y, "unitId");
        Json o = y;
        o["id"] = str_of(y, "id").empty() ? ("demo" + std::to_string(++di)) : str_of(y, "id");
        o["title"] = str_of(y, "title");
        o["markup"] = str_of(y, "markup");
        o["js"] = str_of(y, "js");
        o["unitId"] = uid;
        std::string unitTitle = str_of(y, "unitTitle");
        if (unitTitle.empty()) {
            auto hit = titleById.find(uid);
            if (hit != titleById.end()) unitTitle = hit->second;
        }
        o["unitTitle"] = unitTitle;
        demos.push_back(std::move(o));
    }
    out["demos"] = std::move(demos);
    out["key"] = str_of(x, "key");
    /* 这一章以前生成过、已经交付给用户了：id 一个字都不许改。 */
    out["frozen"] = true;
    out["from"] = from;
    return out;
}

SidecarLoad load_from_sidecar(const std::wstring& htmlPath) {
    SidecarLoad out;
    ReadResult r = read_book(htmlPath);
    if (!r.ok()) {
        out.detail = r.detail;
        return out;
    }
    const Json& b = r.book;
    if (!b.contains("chapters") || !b["chapters"].is_array()) {
        out.detail = "结构化数据里没有 chapters";
        return out;
    }
    for (const Json& c : b["chapters"]) out.entries.push_back(shape_carry(c, "sidecar"));
    out.book_key = str_of(b, "key");
    out.book_kind = str_of(b, "kind");
    if (out.book_kind.empty()) out.book_kind = "chapter";
    out.ok = true;
    return out;
}

Json inspect_public(const SidecarLoad& loaded) {
    Json out = Json::object();
    out["ok"] = loaded.ok;
    out["from"] = loaded.ok ? "sidecar" : "revive";
    Json chapter = Json();
    if (loaded.ok && loaded.entries.is_array() && !loaded.entries.empty()
        && loaded.entries[0].is_object() && loaded.entries[0].contains("chapter")
        && loaded.entries[0]["chapter"].is_object()) {
        chapter = loaded.entries[0]["chapter"];
    }
    out["chapter"] = chapter_info(chapter);
    out["problems"] = loaded.problems;
    out["canCarry"] = loaded.ok;
    return out;
}

namespace {

/** 章号"像不像数字"（与 oracle chapters.js 的 NUMERIC_NO 同一口径）。 */
/* 与 oracle chapters.js 的 `^\d+(?:\.\d+)?$` **同一口径**：
   `1.` 与 `.5` 都不算章号（它们是手滑，不是数字）。 */
bool numeric_no(const std::string& s, double& out) {
    if (s.empty()) return false;
    const size_t dot = s.find('.');
    if (dot == std::string::npos) {
        for (char c : s) if (c < '0' || c > '9') return false;
    } else {
        if (dot == 0 || dot + 1 >= s.size()) return false;
        if (s.find('.', dot + 1) != std::string::npos) return false;
        for (size_t i = 0; i < s.size(); ++i) {
            if (i == dot) continue;
            if (s[i] < '0' || s[i] > '9') return false;
        }
    }
    try {
        out = std::stod(s);
    } catch (...) {
        return false;
    }
    return true;
}

struct NumSet {
    std::vector<double> nums;
    bool allNumeric = false;
};

NumSet to_nums(const Json& arr) {
    NumSet out;
    if (!arr.is_array()) return out;
    bool all = true;
    for (const Json& v : arr) {
        const std::string s = isg::trim(js_str(v));
        double n = 0;
        if (!numeric_no(s, n)) { all = false; continue; }
        out.nums.push_back(n);
    }
    std::sort(out.nums.begin(), out.nums.end());
    out.nums.erase(std::unique(out.nums.begin(), out.nums.end()), out.nums.end());
    out.allNumeric = all && !arr.empty();
    return out;
}

bool is_int(double v) { return std::floor(v) == v; }

Json num_or_null(const std::vector<double>& v, bool front) {
    if (v.empty()) return Json(nullptr);
    return v[front ? 0 : v.size() - 1];
}

}  // namespace

Json judge_continuity(const Json& newNos, const Json& knownNos) {
    const NumSet know = to_nums(knownNos);
    const NumSet news = to_nums(newNos);
    const Json knownMin = num_or_null(know.nums, true);
    const Json knownMax = num_or_null(know.nums, false);
    const Json newMin = num_or_null(news.nums, true);
    const Json newMax = num_or_null(news.nums, false);

    bool knownRun = know.allNumeric && !know.nums.empty();
    for (size_t i = 1; knownRun && i < know.nums.size(); ++i) {
        if (!is_int(know.nums[i]) || know.nums[i] != know.nums[i - 1] + 1.0) knownRun = false;
    }

    bool newsAllInt = true;
    for (double n : news.nums) if (!is_int(n)) newsAllInt = false;

    const bool continuous = knownRun && news.allNumeric
                            && newMin.is_number() && knownMax.is_number()
                            && newsAllInt
                            && newMin.get<double>() == knownMax.get<double>() + 1.0;
    const bool gapBefore = knownMax.is_number() && newMin.is_number()
                           && newMin.get<double>() > knownMax.get<double>() + 1.0;

    Json out = Json::object();
    out["continuous"] = continuous;
    out["knownMin"] = knownMin;
    out["knownMax"] = knownMax;
    out["newMin"] = newMin;
    out["newMax"] = newMax;
    out["gapBefore"] = gapBefore;
    return out;
}

Json describe_for_list(Json entry) {
    if (!entry.is_object()) entry = Json::object();
    const std::wstring htmlPath = to_wide(str_of(entry, "htmlPath"));
    const bool htmlExists = !htmlPath.empty() && stat_path(htmlPath).isFile;
    bool hasChapter = false;
    if (htmlExists) {
        ReadResult r = read_book(htmlPath);
        hasChapter = r.ok();
    }
    const std::string st = str_of(entry, "status");
    const bool ended = st == "done" || st == "failed" || st == "canceled" || st == "cancelled";
    std::string mergeStatus;
    if (hasChapter) mergeStatus = "chapter";
    else if (htmlExists) mergeStatus = "html";
    else if (!ended) mergeStatus = "unfinished";
    else mergeStatus = "missing";

    std::string hint;
    if (mergeStatus == "chapter") hint = "有生成时的结构化数据，可以准确合并";
    else if (mergeStatus == "html") hint = "只剩成品页面，要合并只能从页面反推（结构信息会丢）";
    else if (mergeStatus == "missing") hint = "这一章的页面和结构数据都不在了（被删掉或挪走了），不能再合并";
    else hint = "任务还没产出页面，暂时谈不上合并";

    entry["hasChapter"] = hasChapter;
    entry["htmlExists"] = htmlExists;
    entry["mergeStatus"] = mergeStatus;
    entry["canMerge"] = mergeStatus == "chapter" || mergeStatus == "html";
    entry["exactMerge"] = mergeStatus == "chapter";
    entry["mergeHint"] = hint;
    return entry;
}

std::string carry_fail_text(const std::string& label, const Json& problems) {
    const Json list = problems.is_array() ? problems : Json::array();
    Json first;
    for (const Json& p : list) {
        if (p.is_object() && p.contains("level") && p["level"].is_string()
            && p["level"].get<std::string>() == "blocker") { first = p; break; }
    }
    if (!first.is_object() && !list.empty() && list[0].is_object()) first = list[0];
    const std::string msg = first.is_object() ? str_of(first, "message")
                                              : "这份文件的结构跟本工具的页面完全对不上";
    const std::string hint = first.is_object() ? str_of(first, "hint") : std::string();
    std::string out = label + "不能合并：" + msg;
    if (!hint.empty()) out += "；" + hint;
    if (list.size() > 1) out += "（这一份一共 " + std::to_string(list.size()) + " 处对不上）";
    return out;
}

}  // namespace book
}  // namespace isg
