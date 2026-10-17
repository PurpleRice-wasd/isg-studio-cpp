#include "jobs.h"

#include "../app/app.h"
#include "../book/book.h"
#include "cleanup.h"
#include "../settings/store.h"
#include "../shell/protocol.h"
#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <set>

namespace isg {

namespace {

constexpr int kMaxLog = 2000;
constexpr int kMaxJobs = 20;
constexpr int kMaxHistory = 50;

const char* const kStageKeys[8] = {
    "extract", "analyze", "plan", "content", "demo", "assemble", "verify", "repair"};
const char* const kStageLabels[8] = {
    "抽取材料文本", "逐来源分析", "规划单元结构", "生成讲解与题库",
    "生成可拖演示", "拼装单文件页面", "页内自动校验", "按报告修复"};

std::string lower_ascii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return s;
}

int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string base36(int64_t v) {
    static const char* d = "0123456789abcdefghijklmnopqrstuvwxyz";
    if (v <= 0) return "0";
    std::string out;
    while (v > 0) { out.push_back(d[v % 36]); v /= 36; }
    std::reverse(out.begin(), out.end());
    return out;
}

std::string str_of(const Json& o, const char* k) {
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

std::wstring history_path() { return user_data_dir() + L"\\history.json"; }

/* history.json 是**用户可手改的文件**。oracle 的 historySummary 用
   `Number()/String()` 做容错；这里用 `.value()` 取一个类型不对的字段会抛
   `type_error.306`，而这条路径在无 try/catch 的 UI 线程上 → 进程消失。
   所有读取一律先看类型。 */
std::string safe_str(const Json& o, const char* k, const std::string& dflt = std::string()) {
    if (!o.is_object()) return dflt;
    auto it = o.find(k);
    return (it != o.end() && it->is_string()) ? it->get<std::string>() : dflt;
}
int64_t safe_int(const Json& o, const char* k, int64_t dflt = 0) {
    if (!o.is_object()) return dflt;
    auto it = o.find(k);
    if (it == o.end()) return dflt;
    if (it->is_number_integer()) return it->get<int64_t>();
    if (it->is_number_unsigned()) return static_cast<int64_t>(it->get<uint64_t>());
    if (it->is_number_float()) {
        const double d = it->get<double>();
        return (d >= -9.0e15 && d <= 9.0e15) ? static_cast<int64_t>(d) : dflt;
    }
    return dflt;
}
Json safe_obj_or_null(const Json& o, const char* k) {
    if (!o.is_object()) return Json(nullptr);
    auto it = o.find(k);
    return (it != o.end() && it->is_object()) ? *it : Json(nullptr);
}

Json summary_of(const Json& j) {
    Json out = Json::object();
    out["id"] = safe_str(j, "id");
    out["workId"] = safe_str(j, "id");
    out["filePath"] = safe_str(j, "filePath");
    out["fileName"] = safe_str(j, "fileName");
    out["status"] = safe_str(j, "status");
    out["createdAt"] = safe_int(j, "createdAt");
    out["updatedAt"] = safe_int(j, "updatedAt");
    out["htmlPath"] = safe_str(j, "htmlPath");
    out["chapter"] = safe_obj_or_null(j, "chapter");
    if (j.contains("chapterNos") && j["chapterNos"].is_array()) out["chapterNos"] = j["chapterNos"];
    else out["chapterNos"] = Json::array();
    out["error"] = (j.contains("error") && j["error"].is_object() && j["error"].contains("message")
                    && j["error"]["message"].is_string())
                       ? j["error"]["message"] : Json(nullptr);
    out["chapterFile"] = safe_str(j, "chapterFile");
    out["bookKey"] = safe_str(j, "bookKey");
    out["bookFile"] = safe_str(j, "bookFile");
    return out;
}

Json history_summary(const Json& h) {
    Json out = Json::object();
    out["id"] = safe_str(h, "id");
    out["workId"] = safe_str(h, "workId", safe_str(h, "id"));
    out["filePath"] = safe_str(h, "filePath");
    out["fileName"] = safe_str(h, "fileName");
    out["status"] = safe_str(h, "status");
    out["createdAt"] = safe_int(h, "createdAt");
    out["updatedAt"] = safe_int(h, "updatedAt");
    out["htmlPath"] = safe_str(h, "htmlPath");
    out["chapter"] = safe_obj_or_null(h, "chapter");
    if (h.contains("chapterNos") && h["chapterNos"].is_array()) out["chapterNos"] = h["chapterNos"];
    else out["chapterNos"] = Json::array();
    out["error"] = h.contains("error") ? h["error"] : Json(nullptr);
    out["chapterFile"] = safe_str(h, "chapterFile");
    out["bookKey"] = safe_str(h, "bookKey");
    out["bookFile"] = safe_str(h, "bookFile");
    return out;
}

Json read_history() {
    const std::wstring path = history_path();
    if (!stat_path(path).exists) return Json::array();
    Json arr;
    std::string err;
    const bool ok = json_read_file(path, arr, err);
    if (!ok || !arr.is_array()) {
        /* oracle 的做法：坏文件**改名留证**，而不是让下一次保存把它整个覆盖掉。
           直接覆盖等于用户的历史凭空少一批，而且没有任何痕迹。 */
        const std::wstring bad = path + L".bad-" + std::to_wstring(now_ms());
        if (::MoveFileExW(path.c_str(), bad.c_str(), 0)) {
            log_warn("[jobs] history.json 读不出来（" + err + "），已改名留证：" + to_utf8(bad));
        } else {
            log_warn("[jobs] history.json 读不出来（" + err + "），而且改名也失败了");
        }
        return Json::array();
    }
    Json out = Json::array();
    for (const Json& h : arr) {
        if (h.is_object() && h.contains("id") && h["id"].is_string()) out.push_back(history_summary(h));
    }
    return out;
}

Json describe(Json entry) {
    /* Phase 6：旁挂数据在不在决定"能不能准确合并"。
       判据是**页面文件本身**（旁挂数据跟着页面走）：HTML 没了就是 missing。 */
    return book::describe_for_list(entry);
}

}  // namespace

JobStore::~JobStore() { Shutdown(); }

void JobStore::SetEmitter(EmitterFn e) {
    std::lock_guard<std::mutex> lk(mu_);
    emitter_ = std::move(e);
}

void JobStore::EmitPayload(const Json& payload) {
    EmitterFn fn;
    {
        std::lock_guard<std::mutex> lk(mu_);
        fn = emitter_;
    }
    if (fn) fn(payload);
}

Json& JobStore::job(const std::string& id) {
    static Json empty = Json::object();
    if (!jobs_.contains(id)) return empty;
    return jobs_[id];
}

void JobStore::Log(Json& j, const std::string& level, const std::string& message) {
    if (!j.is_object()) return;
    const int64_t at = now_ms();
    Json entry = Json::object();
    entry["at"] = at;
    entry["level"] = level;
    entry["message"] = message;
    if (!j.contains("logs") || !j["logs"].is_array()) j["logs"] = Json::array();
    j["logs"].push_back(entry);
    while (static_cast<int>(j["logs"].size()) > kMaxLog) j["logs"].erase(j["logs"].begin());
    j["updatedAt"] = at;
    Json ev = Json::object();
    ev["jobId"] = j.value("id", std::string());
    ev["at"] = at;
    ev["type"] = "log";
    ev["entry"] = entry;
    EmitUnlocked(ev);
}

bool JobStore::Create(const Json& input, Json& out, std::string& err) {
    if (!input.is_object()) { err = "gen:start 的参数不是一个对象"; return false; }

    Json sources = Json::array();
    if (input.contains("sources") && input["sources"].is_array() && !input["sources"].empty()) {
        static const std::set<std::string> roles = {"courseware", "textbook", "exercises", "exampaper"};
        int i = 0;
        for (const Json& s : input["sources"]) {
            if (!s.is_object()) { err = "来源列表里有一项不是对象"; return false; }
            const std::string role = str_of(s, "role");
            const std::string filePath = str_of(s, "filePath");
            if (i == 0 && role.empty()) { /* 老路径没给 role：按课件处理 */ }
            else if (!role.empty() && roles.find(role) == roles.end()) {
                err = "第 " + std::to_string(i + 1) + " 份来源的角色「" + role + "」不认识";
                return false;
            }
            if (filePath.empty()) {
                err = "第 " + std::to_string(i + 1) + " 份来源没有给出文件路径";
                return false;
            }
            Json item = Json::object();
            item["id"] = str_of(s, "id").empty() ? ("s" + std::to_string(i + 1)) : str_of(s, "id");
            item["role"] = role.empty() ? std::string("courseware") : role;
            item["filePath"] = filePath;
            const std::wstring wfile = to_wide(filePath);
            item["fileName"] = str_of(s, "fileName").empty() ? to_utf8(file_name(wfile)) : str_of(s, "fileName");
            item["label"] = str_of(s, "label");
            item["scope"] = s.contains("scope") ? s["scope"] : Json(nullptr);
            item["chapterNo"] = str_of(s, "chapterNo");
            item["chapterTitle"] = str_of(s, "chapterTitle");
            sources.push_back(std::move(item));
            ++i;
        }
    } else if (input.contains("filePath") && input["filePath"].is_string()
               && !input["filePath"].get<std::string>().empty()) {
        const std::string filePath = input["filePath"].get<std::string>();
        Json item = Json::object();
        item["id"] = "s1";
        item["role"] = "courseware";
        item["filePath"] = filePath;
        item["fileName"] = to_utf8(file_name(to_wide(filePath)));
        item["label"] = "";
        item["scope"] = Json(nullptr);
        item["chapterNo"] = "";
        item["chapterTitle"] = "";
        sources.push_back(std::move(item));
    } else {
        err = "没有给出任何来源文件";
        return false;
    }

    std::string mode = input.contains("mode") && input["mode"].is_string()
                           ? input["mode"].get<std::string>() : std::string("book");
    if (mode.empty()) mode = "book";
    if (mode != "book" && mode != "separate") {
        err = "产出方式只认 book / separate，收到「" + mode + "」";
        return false;
    }

    /* ---- 选项归一 + 设置兜底（oracle 的 ipc.js: OPTION_ALIASES / normalizePet） ----
       渲染层用的是它自己那套名字（quizTarget / chapterNo / chapterTitle / pet:'own'），
       流水线用的是另一套（points / number / title / pet:'image'）。不做这一处翻译，
       工作台的「作答点目标数」滑杆与「章标题」输入会**完全无效**，而且不报错。
       先把 settings.generation 铺底，再用页面显式给的值覆盖。 */
    const Json publicSettings = get_public_settings();
    Json options = Json::object();
    if (publicSettings.contains("generation") && publicSettings["generation"].is_object()) {
        for (auto it = publicSettings["generation"].begin(); it != publicSettings["generation"].end(); ++it) {
            options[it.key()] = it.value();
        }
    }
    const Json rawOptions = (input.contains("options") && input["options"].is_object())
                                ? input["options"] : Json::object();
    static const std::map<std::string, std::string> kAliases = {
        {"quizTarget", "points"}, {"points", "points"},
        {"chapterNo", "number"}, {"number", "number"},
        {"chapterTitle", "title"}, {"title", "title"},
        {"subject", "subject"}, {"units", "units"}, {"demos", "demos"},
        {"outputDir", "outputDir"}, {"editedPages", "editedPages"},
        {"concurrency", "concurrency"}, {"repairRounds", "repairRounds"},
        {"temperature", "temperature"}, {"petImagePath", "petImagePath"},
        {"auditors", "auditors"}, {"language", "language"},
    };
    for (auto it = rawOptions.begin(); it != rawOptions.end(); ++it) {
        if (it.value().is_null()) continue;
        auto hit = kAliases.find(it.key());
        if (hit != kAliases.end()) options[hit->second] = it.value();
        else options[it.key()] = it.value();       // 认不出的原样带下去
    }
    if (rawOptions.contains("pet")) {
        const Json& pv = rawOptions["pet"];
        std::string pet;
        if (pv.is_string()) pet = pv.get<std::string>();
        if (pet == "own" || pet == "image" || pet == "self") pet = "image";
        else if (pet == "fish") pet = "fish";
        else if (pet == "none" || pet == "off") pet = "none";
        else if (pv.is_boolean() && !pv.get<bool>()) pet = "none";
        if (!pet.empty()) options["pet"] = pet;
    }
    const Json& mainSrc = sources[0];
    const std::string filePath = mainSrc.value("filePath", std::string());
    const std::string fileName = mainSrc.value("fileName", std::string());

    /* ---- 多章：先按章号分组，分组说不清就当场拒（等价 oracle chapters.groupSources）----
       ⚠️ 与 oracle 同一套规则：
         · 全都没填章号 ⇒ 唯一的一章（老路径）；
         · 一部分填了、一部分没填 ⇒ 当场拒，并点名是哪几份没填；
         · 章序按数值升序（数字像数字才按数字比，否则按字符串）。
       不在这里验的话，错误会晚到"模型对着一份混章材料硬编"，而用户看不出是哪一步错了。 */
    auto option_no = [&]() -> std::string {
        for (const char* k : {"chapterNo", "number"}) {
            auto it = options.find(k);
            if (it == options.end() || it->is_null()) continue;
            std::string s;
            if (it->is_string()) s = it->get<std::string>();
            else if (it->is_number()) s = it->dump();
            s = trim(s);
            if (!s.empty()) return s;
        }
        return std::string();
    }();
    const std::string globalNo = option_no;
    std::vector<std::string> effectiveNos;
    std::vector<std::string> missing;
    for (size_t i = 0; i < sources.size(); ++i) {
        std::string own = safe_str(sources[i], "chapterNo");
        own = trim(own);
        const std::string eff = !own.empty() ? own : globalNo;
        effectiveNos.push_back(eff);
        if (eff.empty()) missing.push_back(safe_str(sources[i], "label").empty()
                                               ? safe_str(sources[i], "fileName")
                                               : safe_str(sources[i], "label"));
    }
    if (!missing.empty() && missing.size() < sources.size()) {
        std::string names;
        for (const std::string& m : missing) names += (names.empty() ? "" : "、") + m;
        err = "有 " + std::to_string(missing.size()) + " 份材料没填章号：" + names
            + "。要么每份都填上它属于哪一章，要么全都留空（全都留空就是只生成一章）。";
        return false;
    }
    Json chapterList = Json::array();
    {
        std::map<std::string, Json> byNo;
        /* 与 chapters.js 的 `^\d+(?:\.\d+)?$` 同口径（`1.` / `.5` 不算章号）。 */
        auto numeric = [](const std::string& s, double& out) {
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
            try { out = std::stod(s); } catch (...) { return false; }
            return true;
        };
        for (size_t i = 0; i < sources.size(); ++i) {
            const std::string no = effectiveNos[i];
            if (!byNo.count(no)) {
                Json c = Json::object();
                c["no"] = no;
                c["title"] = "";
                c["subject"] = options.contains("subject") && options["subject"].is_string()
                                   ? options["subject"].get<std::string>() : "";
                byNo[no] = c;
            }
            Json& c = byNo[no];
            if (safe_str(c, "title").empty()) {
                const std::string t = trim(safe_str(sources[i], "chapterTitle"));
                if (!t.empty()) c["title"] = t;
            }
        }
        std::vector<Json> list;
        for (auto& kv : byNo) list.push_back(kv.second);
        std::sort(list.begin(), list.end(), [&](const Json& a, const Json& b) {
            const std::string x = safe_str(a, "no"), y = safe_str(b, "no");
            double nx = 0, ny = 0;
            const bool ax = numeric(x, nx), ay = numeric(y, ny);
            if (ax && ay && nx != ny) return nx < ny;
            return x < y;
        });
        for (const Json& c : list) chapterList.push_back(c);
    }

    Json carry = Json::array();
    std::string carryBookKey;
    std::vector<std::string> carryWarnings;
    if (input.contains("carry") && input["carry"].is_array()) carry = input["carry"];
    carryBookKey = str_of(input, "carryBookKey");
    if (input.contains("carryWarnings") && input["carryWarnings"].is_array()) {
        for (const Json& w : input["carryWarnings"]) {
            if (w.is_string()) carryWarnings.push_back(w.get<std::string>());
        }
    }

    std::wstring outDir = to_wide(str_of(options, "outputDir"));
    if (outDir.empty()) outDir = parent_dir(to_wide(filePath));
    outDir = normalized_abs(outDir);

    const int64_t now = now_ms();
    const std::string id = "job" + base36(now) + "-" + std::to_string(++seq_);

    Json j = Json::object();
    j["id"] = id;
    j["sources"] = sources;
    j["mode"] = mode;
    j["filePath"] = filePath;
    j["fileName"] = fileName;
    j["options"] = options;
    j["status"] = "pending";
    Json stages = Json::array();
    for (int k = 0; k < 8; ++k) {
        Json st = Json::object();
        st["key"] = kStageKeys[k];
        st["label"] = kStageLabels[k];
        st["status"] = "pending";
        st["detail"] = "";
        st["note"] = "";
        stages.push_back(std::move(st));
    }
    j["stages"] = stages;
    j["logs"] = Json::array();
    j["createdAt"] = now;
    j["updatedAt"] = now;
    j["startedAt"] = nullptr;
    j["htmlPath"] = "";
    j["htmlPaths"] = Json::array();
    j["report"] = nullptr;
    j["error"] = nullptr;
    j["chapter"] = nullptr;
    j["chapterNos"] = Json::array();
    j["ask"] = nullptr;
    j["usage"] = nullptr;
    j["outputs"] = Json::array();
    j["chapters"] = chapterList;
    if (carry.is_array() && !carry.empty()) j["carry"] = carry;
    if (!carryBookKey.empty()) j["carryBookKey"] = carryBookKey;
    j["carryWarnings"] = Json::array();

    {
        std::lock_guard<std::mutex> lk(mu_);
        /* 同时只允许一个任务。并发时页面侧的逻辑垫片用的是**全局** currentJobId，
           第二个任务会覆盖第一个：A 的日志/进度/finish 会记到 B 上（B 被标成 done、
           产物串成 A 的）。拒绝比"看起来能并发、其实串档"安全得多。 */
        for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
            const std::string st = safe_str(it.value(), "status");
            if (st == "running" || st == "pending") {
                err = "已经有一个任务在运行，等它结束（或取消它）再开始新的";
                return false;
            }
        }
        jobs_[id] = std::move(j);
        Private p;
        p.outDir = lower_w(outDir);
        priv_[id] = std::move(p);
        Json& jj = jobs_[id];
        Log(jj, "info", "任务已创建：" + fileName);
        if (sources.size() > 1) {
            std::string list;
            for (const Json& s : sources) {
                if (!list.empty()) list += "、";
                const std::string label = safe_str(s, "label").empty() ? safe_str(s, "fileName")
                                                                       : safe_str(s, "label");
                list += label + "（" + safe_str(s, "role") + "）";
            }
            Log(jj, "info", "本次是**多来源**生成：" + list);
        }
        /* 单章 + 没填章号 = 老路径：一个字都不多打（老日志有自测在比对）。 */
        if (!(chapterList.size() == 1 && safe_str(chapterList[0], "no").empty())) {
            std::string list;
            for (const Json& c : chapterList) {
                const std::string no = safe_str(c, "no");
                if (!list.empty()) list += "、";
                list += no.empty() ? "（无章号）" : ("第 " + no + " 章");
            }
            Log(jj, "info", "本次生成 " + std::to_string(chapterList.size()) + " 章（" + list
                                 + "），产出方式：" + (mode == "separate" ? "分开生成" : "合成一册"));
        }
        if (carry.is_array() && !carry.empty()) {
            std::string names;
            for (const Json& c : carry) {
                const Json ch = c.is_object() && c.contains("chapter") ? c["chapter"] : Json::object();
                const std::string no = safe_str(ch, "no");
                const std::string title = safe_str(ch, "title");
                if (!names.empty()) names += "、";
                names += (no.empty() ? "（无章号）" : ("第 " + no + " 章"))
                       + (title.empty() ? "" : (" " + title));
            }
            Log(jj, "info", "本次带上了 " + std::to_string(carry.size()) + " 章：" + names
                                 + "（排在新章之前）");
            for (const std::string& w : carryWarnings) Log(jj, "warn", "带上的章要注意：" + w);
        }
        EvictOld();
    }

    Json payload = Json::object();
    payload["jobId"] = id;
    payload["id"] = id;
    out = payload;
    return true;
}

Json JobStore::Snapshot(const Json& j) const { return j; }

Json JobStore::Get(const std::string& id, bool forPipeline) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(id)) return Json(nullptr);
    Json snap = Snapshot(jobs_[id]);
    /* 给流水线的快照**不能瘦身**：`options.editedPages` 是输入契约的一部分。
       这一条以前漏了，用户逐页修订在到达流水线之前就被剥掉，而且完全静默。 */
    if (forPipeline) return snap;
    /* ⚠️ 快照要**瘦身**再发。WebView2 的单条消息有大小限制（Phase 1 实测 161 KB
       的字符串收不到），而一个跑了几十分钟的任务光日志就能到几百 KB。
       界面拿快照是为了重建"任务概况 + 最近几行日志"；完整日志它已经按
       `job:event` 逐条收过了。所以这里只留最近 120 条，且单条截到 1200 字。
       另外 `options.editedPages` 是用户在抽取预览里改过的整页正文，可能几百 KB，
       重建界面一个字节都用不上。 */
    if (snap.contains("logs") && snap["logs"].is_array()) {
        Json lean = Json::array();
        const size_t n = snap["logs"].size();
        const size_t from = n > 120 ? n - 120 : 0;
        for (size_t i = from; i < n; ++i) {
            Json entry = snap["logs"][i];
            if (entry.is_object() && entry.contains("message") && entry["message"].is_string()) {
                const std::string m = entry["message"].get<std::string>();
                if (m.size() > 1200) entry["message"] = m.substr(0, 1200) + "…";
            }
            lean.push_back(std::move(entry));
        }
        snap["logs"] = std::move(lean);
    }
    if (snap.contains("options") && snap["options"].is_object()) {
        snap["options"].erase("editedPages");
    }
    return snap;
}

std::string JobStore::SnapshotText(const std::string& id) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(id)) return std::string();
    Private& p = priv_[id];
    if (!p.snapshotValid) {
        /* 直接序列化 jobs_[id]（快照就是它本身；**不能**调 Get() —— 它会再拿一次 mu_，自锁） */
        p.snapshotText = json_dump(jobs_[id], -1);
        p.snapshotValid = true;
    }
    return p.snapshotText;
}

Json JobStore::List() {
    std::lock_guard<std::mutex> lk(mu_);
    Json byId = Json::object();
    for (const Json& h : read_history()) byId[safe_str(h, "id")] = h;
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) byId[it.key()] = summary_of(it.value());
    std::vector<Json> items;
    for (auto it = byId.begin(); it != byId.end(); ++it) {
        if (it.value().is_object() && !safe_str(it.value(), "id").empty()) {
            items.push_back(describe(it.value()));
        }
    }
    std::sort(items.begin(), items.end(), [](const Json& a, const Json& b) {
        return safe_int(a, "createdAt") > safe_int(b, "createdAt");
    });
    Json out = Json::array();
    for (size_t i = 0; i < items.size() && i < static_cast<size_t>(kMaxHistory); ++i) out.push_back(items[i]);
    return out;
}

void JobStore::EvictOld() {
    if (static_cast<int>(jobs_.size()) <= kMaxJobs) return;
    std::vector<std::pair<int64_t, std::string>> finished;
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
        const std::string st = safe_str(it.value(), "status");
        if (st == "running" || st == "pending") continue;
        finished.push_back({safe_int(it.value(), "createdAt"), it.key()});
    }
    std::sort(finished.begin(), finished.end());
    for (const auto& f : finished) {
        if (static_cast<int>(jobs_.size()) <= kMaxJobs) break;
        jobs_.erase(f.second);
        priv_.erase(f.second);
    }
}

void JobStore::SaveHistory() {
    std::lock_guard<std::mutex> lk(mu_);
    Json byId = Json::object();
    for (const Json& h : read_history()) byId[safe_str(h, "id")] = h;
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) byId[it.key()] = summary_of(it.value());
    std::vector<Json> items;
    for (auto it = byId.begin(); it != byId.end(); ++it) items.push_back(it.value());
    std::sort(items.begin(), items.end(), [](const Json& a, const Json& b) {
        return safe_int(a, "createdAt") > safe_int(b, "createdAt");
    });
    Json arr = Json::array();
    for (size_t i = 0; i < items.size() && i < static_cast<size_t>(kMaxHistory); ++i) arr.push_back(items[i]);
    std::string err;
    if (!json_write_file_atomic(history_path(), arr, 2, err)) {
        log_warn("[jobs] history.json 写不进去：" + err);
    }
}

void JobStore::HandleWrite(const Json& msg, const std::string& op) {
    const std::string jobId = str_of(msg, "jobId");
    const std::string path = str_of(msg, "path");
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(jobId)) return;
    Json& j = jobs_[jobId];
    Private& p = priv_[jobId];

    auto lower = [](std::string s) {
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        return s;
    };
    /* 旁挂数据的临时文件：写失败**不能拖垮整单**（页面已经交付了）。
       oracle book.js 的约定也是"失败只记 warn"。 */
    auto is_sidecar_tmp = [&](const std::string& s) {
        const std::string low = lower(s);
        return low.size() > 13 && low.compare(low.size() - 13, 13, ".isg.json.tmp") == 0;
    };
    auto is_sidecar = [&](const std::string& s) {
        const std::string low = lower(s);
        return low.size() > 9 && low.compare(low.size() - 9, 9, ".isg.json") == 0;
    };

    if (op == "writeFileBegin") {
        std::wstring abs;
        if (!ValidateOutputPathLocked(jobId, path, abs)) {
            if (is_sidecar_tmp(path)) {
                Log(j, "warn", "章节数据结构没写下去（路径不在任务目录里）：" + path);
            } else {
                p.writeError = "输出路径不在任务目录里，已拒绝写入：" + path;
                Log(j, "error", p.writeError);
            }
            return;
        }
        p.writeBuffers[path] = std::string();
        p.writeChunksSeen[path] = 0;
        p.writeChunks[path] = 0;
        return;
    }
    if (op == "writeFileChunk") {
        auto it = p.writeBuffers.find(path);
        if (it == p.writeBuffers.end()) return;      // 没有 begin / 已被拒
        const std::string text = str_of(msg, "text");
        if (it->second.size() + text.size() > static_cast<size_t>(kMaxFileBytes)) {
            if (is_sidecar_tmp(path)) {
                Log(j, "warn", "章节数据结构超过 64 MiB，已放弃写入：" + path);
            } else {
                p.writeError = "单份产出超过 64 MiB，已中止写入：" + path;
                Log(j, "error", p.writeError);
            }
            p.writeBuffers.erase(it);
            return;
        }
        it->second += text;
        p.writeChunksSeen[path]++;
        return;
    }
    if (op == "writeFileEnd") {
        auto it = p.writeBuffers.find(path);
        if (it == p.writeBuffers.end()) return;
        std::string text = std::move(it->second);
        p.writeBuffers.erase(it);
        /* 消息层没有 ack，一条 chunk 丢了是发不出去也看不出来的。页面在 end 里带了
           期望的字节数与块数，这里对账；对不上就让任务失败，绝不静默交付截断的页面。 */
        const int64_t wantBytes = msg.contains("size") && msg["size"].is_number()
                                      ? msg["size"].get<int64_t>() : -1;
        const int64_t wantChunks = msg.contains("chunks") && msg["chunks"].is_number()
                                       ? msg["chunks"].get<int64_t>() : -1;
        const int64_t seenChunks = p.writeChunksSeen[path];
        p.writeChunksSeen.erase(path);
        p.writeChunks.erase(path);
        if ((wantBytes >= 0 && wantBytes != static_cast<int64_t>(text.size()))
            || (wantChunks >= 0 && wantChunks != seenChunks)) {
            const std::string msgText = "写文件的消息丢了块（" + path + "：期望 "
                                      + std::to_string(wantChunks) + " 块/" + std::to_string(wantBytes)
                                      + " 字节，收到 " + std::to_string(seenChunks) + " 块/"
                                      + std::to_string(text.size()) + " 字节）";
            if (is_sidecar_tmp(path)) Log(j, "warn", "章节数据结构没写完整：" + msgText);
            else {
                p.writeError = msgText;
                Log(j, "error", p.writeError);
            }
            return;
        }
        std::wstring abs;
        if (!ValidateOutputPathLocked(jobId, path, abs)) {
            if (is_sidecar_tmp(path)) {
                Log(j, "warn", "章节数据结构没写下去（路径不在任务目录里）：" + path);
            } else {
                p.writeError = "输出路径不在任务目录里，已拒绝写入：" + path;
                Log(j, "error", p.writeError);
            }
            return;
        }
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(parent_dir(abs)), ec);
        if (!write_file_bytes(abs, text)) {
            if (is_sidecar_tmp(path)) {
                Log(j, "warn", "章节数据结构没写下去（写不了这个文件）：" + path);
            } else {
                p.writeError = "写不了这个文件：" + path;
                Log(j, "error", p.writeError);
            }
            return;
        }
        /* 取消/失败路径不会走 finish 快照；在这里就把 htmlPath 记下来，
           历史/结果页才能说出"已经写出过哪些页面"。 */
        const std::wstring low = lower_w(to_wide(path));
        const bool isHtml = (low.size() >= 5 && low.compare(low.size() - 5, 5, L".html") == 0)
                         || (low.size() >= 4 && low.compare(low.size() - 4, 4, L".htm") == 0);
        if (isHtml && (!j.contains("htmlPath") || !j["htmlPath"].is_string()
                       || j["htmlPath"].get<std::string>().empty())) {
            j["htmlPath"] = path;
        }
        return;
    }
    if (op == "copyFile") {
        const std::string from = str_of(msg, "from");
        /* 页面发的是 `{from,to}`；兼容旧的 `path`。字段名对不上时目标会是空串，
           整个任务会被误判成 failed（以前就是）。 */
        std::string to = str_of(msg, "to");
        if (to.empty()) to = path;
        if (!protocol_is_allowed(to_wide(from))) {
            p.writeError = "复制源不在本次放行的目录里，已拒绝：" + from;
            Log(j, "error", p.writeError);
            return;
        }
        std::wstring abs;
        if (!ValidateOutputPathLocked(jobId, to, abs)) {
            p.writeError = "输出路径不在任务目录里，已拒绝复制：" + to;
            Log(j, "error", p.writeError);
            return;
        }
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(parent_dir(abs)), ec);
        if (!copy_file(to_wide(from), abs)) {
            p.writeError = "复制失败：" + from + " → " + to;
            Log(j, "error", p.writeError);
        }
        return;
    }

    /* 旁挂数据的原子写：页面先写 `<...>.isg.json.tmp`，再 rename 成正式文件。
       ⚠️ 只允许"`to` + .tmp → `to`"这一种形状，且两端都必须在任务输出目录内 ——
       页面（哪怕被改坏）不能借这条通道做任意改名。 */
    if (op == "renameFile") {
        const std::string from = str_of(msg, "from");
        const std::string to = str_of(msg, "to");
        if (!is_sidecar(to) || lower(from) != lower(to) + ".tmp") {
            Log(j, "warn", "拒绝了一次形状不对的改名：" + from + " → " + to);
            return;
        }
        std::wstring absFrom, absTo;
        if (!ValidateOutputPathLocked(jobId, from, absFrom)
            || !ValidateOutputPathLocked(jobId, to, absTo)) {
            Log(j, "warn", "章节数据结构没能落盘（路径不在任务目录里）：" + to);
            return;
        }
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(parent_dir(absTo)), ec);
        if (!rename_over(absFrom, absTo)) {
            Log(j, "warn", "章节数据结构没能落盘（改名失败）：" + to);
            return;
        }
        j["chapterFile"] = to;
        return;
    }
    if (op == "deleteFile") {
        /* 只允许删旁挂数据的临时文件（book.js 的 catch 分支）。 */
        if (!is_sidecar_tmp(path)) {
            Log(j, "warn", "拒绝删除一个不是旁挂 tmp 的文件：" + path);
            return;
        }
        std::wstring abs;
        if (!ValidateOutputPathLocked(jobId, path, abs)) return;
        if (stat_path(abs).isFile && !remove_file(abs)) {
            Log(j, "warn", "旁挂临时文件没能删掉：" + path);
        }
        return;
    }
}

bool JobStore::ValidateOutputPath(const std::string& jobId, const std::string& path, std::wstring& abs) {
    std::lock_guard<std::mutex> lk(mu_);
    return ValidateOutputPathLocked(jobId, path, abs);
}

bool JobStore::ValidateOutputPathLocked(const std::string& jobId, const std::string& path,
                                        std::wstring& abs) {
    auto it = priv_.find(jobId);
    if (it == priv_.end()) return false;
    if (path.empty() || it->second.outDir.empty()) return false;
    abs = normalized_abs(to_wide(path));
    const std::wstring a = lower_w(abs);
    std::wstring root = it->second.outDir;
    if (root.empty()) return false;
    if (a == root) return true;              // 目录本身（preview.allow(outDir)）
    if (root.back() != L'\\') root.push_back(L'\\');
    if (a.size() < root.size()) return false;
    return a.compare(0, root.size(), root) == 0;
}

void JobStore::SettleAsk(const std::string& jobId, Json& j, Private& p, const Json& value,
                         const std::string& why) {
    if (!p.ask.is_object()) return;
    const std::string title = safe_str(p.ask, "title");
    /* value 可能**就是** p.askDefault 的引用（取消/结束路径），而下面会把它清空。
       先拷一份，避免"清空之后再读那个引用"。 */
    const Json target = value;
    const Json def = p.askDefault;
    AskReply reply = std::move(p.askReply);
    p.askReply = nullptr;
    p.askId.clear();
    p.ask = Json(nullptr);
    p.askDefault = Json(nullptr);
    j["ask"] = nullptr;
    if (why == "timeout") Log(j, "warn", "等你回答超时，没等到回答，按默认继续（" + title + "）");
    else if (why == "cancel") Log(j, "warn", "任务取消了，那个还没回答的问题按默认继续（" + title + "）");
    else if (why == "end") Log(j, "warn", "任务结束时那个问题还没回答，按默认继续（" + title + "）");
    if (reply) {
        Json r = Json::object();
        r["ok"] = true;
        r["data"] = target.is_null() ? def : target;
        reply(r);
    }
    Json ev = Json::object();
    ev["jobId"] = jobId;
    ev["at"] = now_ms();
    ev["type"] = "ask";
    ev["ask"] = nullptr;
    EmitUnlocked(ev);
}

bool JobStore::OpenAsk(const std::string& jobId, const Json& ask, AskReply reply) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(jobId) || !ask.is_object()) return false;
    Json& j = jobs_[jobId];
    Private& p = priv_[jobId];
    if (p.ask.is_object()) {
        // 已有未决问题：新来的用默认值直接回，不去动摇正在进行的那一个
        Json r = Json::object();
        r["ok"] = true;
        r["data"] = ask.contains("default") ? ask["default"] : Json(nullptr);
        if (reply) reply(r);
        return true;
    }
    p.ask = ask;
    p.askId = safe_str(ask, "id");
    p.askDefault = ask.contains("default") ? ask["default"] : Json(nullptr);
    p.askReply = std::move(reply);
    j["ask"] = ask;
    Json ev = Json::object();
    ev["jobId"] = jobId;
    ev["at"] = now_ms();
    ev["type"] = "ask";
    ev["ask"] = ask;
    EmitUnlocked(ev);
    return true;
}

bool JobStore::Answer(const Json& arg) {
    if (!arg.is_object()) return false;      // 页面递来的可能是任意 JSON
    std::lock_guard<std::mutex> lk(mu_);
    const std::string jobId = safe_str(arg, "jobId");
    const std::string askId = safe_str(arg, "askId");
    if (!jobs_.contains(jobId)) return false;
    Json& j = jobs_[jobId];
    Private& p = priv_[jobId];
    if (!p.ask.is_object()) return false;
    if (askId != p.askId) return false;
    const Json value = arg.contains("value") ? arg["value"] : Json(nullptr);
    bool hit = false;
    std::string label;
    if (p.ask.contains("options") && p.ask["options"].is_array()) {
        for (const Json& o : p.ask["options"]) {
            if (o.is_object() && o.contains("value") && o["value"] == value) {
                hit = true;
                label = safe_str(o, "label");
                break;
            }
        }
    }
    if (!hit) {
        Log(j, "warn", "收到一个不在选项里的回答，已忽略");
        return false;
    }
    Log(j, "info", "收到你的选择：" + label);
    SettleAsk(jobId, j, p, value, "answer");
    return true;
}

bool JobStore::Cancel(const std::string& id, const Json& opts) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(id)) return false;
    Json& j = jobs_[id];
    Private& p = priv_[id];
    const std::string st = j.value("status", std::string());
    if (st != "running" && st != "pending") return false;
    p.abortRequested = true;
    p.cancelPolicy = (opts.is_object() && opts.value("policy", std::string()) == "clear") ? "clear" : "keep";
    SettleAsk(id, j, p, p.askDefault, "cancel");
    Log(j, "warn", std::string("用户取消了任务")
                       + (p.cancelPolicy == "clear"
                              ? "（收尾后会清除本次产生的临时文件与半成品）"
                              : "（保留已产生的文件）"));
    return true;
}

void JobStore::HandlePageMessage(const Json& msg) {
    const std::string op = str_of(msg, "op");
    const std::string jobId = str_of(msg, "jobId");

    if (op == "writeFileBegin" || op == "writeFileChunk" || op == "writeFileEnd"
        || op == "copyFile" || op == "renameFile" || op == "deleteFile") {
        HandleWrite(msg, op);
        return;
    }

    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(jobId)) return;
    Json& j = jobs_[jobId];
    Private& p = priv_[jobId];
    const int64_t at = now_ms();
    j["updatedAt"] = at;

    if (op == "log") {
        if (!msg.contains("entry") || !msg["entry"].is_object()) return;
        Json entry = msg["entry"];
        if (!entry.contains("at")) entry["at"] = at;
        if (!entry.contains("level")) entry["level"] = "info";
        if (!entry.contains("message")) entry["message"] = "";
        j["logs"].push_back(entry);
        while (static_cast<int>(j["logs"].size()) > kMaxLog) j["logs"].erase(j["logs"].begin());
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "log";
        ev["entry"] = entry;
        EmitUnlocked(ev);
        return;
    }
    if (op == "progress") {
        const std::string key = str_of(msg, "key");
        const std::string status = str_of(msg, "status");
        if (j.contains("stages") && j["stages"].is_array()) {
            for (Json& st : j["stages"]) {
                if (st.value("key", std::string()) != key) continue;
                st["status"] = status;
                const std::string detail = str_of(msg, "detail");
                if (!detail.empty()) st["detail"] = detail;
                if (status == "running" && !st.contains("startedAt")) st["startedAt"] = at;
                if (status == "done" || status == "failed" || status == "skipped") st["endedAt"] = at;
                break;
            }
        }
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "stage";
        for (auto it = msg.begin(); it != msg.end(); ++it) {
            if (it.key() == "op" || it.key() == "jobId" || it.key() == "__isg"
                || it.key() == "kind") continue;
            ev[it.key()] = it.value();
        }
        EmitUnlocked(ev);
        return;
    }
    if (op == "emit") {
        if (!msg.contains("ev") || !msg["ev"].is_object()) return;
        Json ev = msg["ev"];
        ev["jobId"] = jobId;
        ev["at"] = at;
        const std::string type = str_of(ev, "type");
        if (type == "started") {
            j["status"] = "running";
            if (!j.contains("startedAt") || j["startedAt"].is_null()) j["startedAt"] = at;
        }
        if (type == "done") {
            const std::string end = lower_ascii(str_of(ev, "status"));
            if (end == "canceled" || end == "cancelled") {
                j["status"] = "canceled";
                /* 用户在取消弹窗里选了「清除」：**这时**才动文件（流水线已经收尾，
                   探针窗口也不再需要副本）。扫一遍、按清单删，失败如实写进日志。 */
                if (p.cancelPolicy == "clear") {
                    const CleanupPlan plan = cleanup_scan_run(j);
                    Json want = Json::array();
                    for (const CleanupFile& f : plan.files) want.push_back(to_utf8(f.path));
                    const Json removed = cleanup_remove(want, plan.outDir);
                    const int nRemoved = removed["removed"].is_array()
                                             ? static_cast<int>(removed["removed"].size()) : 0;
                    const int nFailed = removed["failed"].is_array()
                                            ? static_cast<int>(removed["failed"].size()) : 0;
                    Log(j, nFailed ? "warn" : "info",
                        "已清除本次产生的 " + std::to_string(nRemoved) + " 个文件"
                        + (nFailed ? ("，" + std::to_string(nFailed) + " 个没删掉（可能被占用）") : ""));
                }
                EmitUnlocked(ev);
                SaveHistoryLocked();
                return;
            }
        }
        EmitUnlocked(ev);
        return;
    }
    if (op == "askSet") {
        if (!msg.contains("ask")) return;
        j["ask"] = msg["ask"];
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "ask";
        ev["ask"] = msg["ask"];
        EmitUnlocked(ev);
        return;
    }
    if (op == "askClear") {
        /* 页面侧已经按默认值/用户回答收掉了问题。C++ 这边要把**挂着的 invoke 回包**
           也收掉，否则那个 Promise 永远悬着（页面虽然已经 race 出结果，但回包对象还占着）。
           不再重复记日志：answer/cancel/timeout 的原因页面已经记过。 */
        if (p.ask.is_object()) {
            const std::string title = safe_str(p.ask, "title");
            const std::string why = str_of(msg, "why");
            if (why == "timeout") {
                Log(j, "warn", "等你回答超时，没等到回答，按默认继续（" + title + "）");
            } else if (why == "cancel") {
                Log(j, "warn", "任务取消了，那个还没回答的问题按默认继续（" + title + "）");
            }
            AskReply reply = std::move(p.askReply);
            p.askReply = nullptr;
            p.askId.clear();
            const Json def = p.askDefault;
            p.ask = Json(nullptr);
            p.askDefault = Json(nullptr);
            if (reply) {
                Json r = Json::object();
                r["ok"] = true;
                r["data"] = def;
                reply(r);
            }
        }
        j["ask"] = nullptr;
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "ask";
        ev["ask"] = nullptr;
        EmitUnlocked(ev);
        return;
    }
    if (op == "finish") {
        // 保险：任务结束时还挂着一个没人回答的问题 → 立刻按默认值收掉
        SettleAsk(jobId, j, p, p.askDefault, "end");
        if (msg.contains("snapshot") && msg["snapshot"].is_object()) {
            /* **白名单合并**：只接受任务层认识的字段，并做类型检查。
               以前是"除 status/id 外全部塞进来"，于是：
                 · 页面那份被瘦身过的 `options`（没有 editedPages）会覆盖宿主原件；
                 · 旧的 `ask` 会把刚收掉的提问又写回去；
                 · 一个类型不对的 `createdAt` 就能让后续 history 读取抛异常。
               注意：**不要**合并 options / sources / ask / report / logs / stages。 */
            const Json& s = msg["snapshot"];
            auto copyStr = [&](const char* k) {
                auto it = s.find(k);
                if (it != s.end() && it->is_string()) j[k] = *it;
            };
            /* ⚠️ `htmlPath` 会被历史当成"可信路径"再次放行（book:inspect/carry），
               而 finish 快照是页面给的。必须先过输出目录校验再落账 —— 否则一条畸形
               finish 消息就能让 `C:\Windows\...` 被标记为可信来源。 */
            for (const char* k : {"htmlPath", "chapterFile"}) {
                auto it = s.find(k);
                if (it == s.end() || !it->is_string()) continue;
                const std::string snapPath = it->get<std::string>();
                std::wstring abs;
                if (!snapPath.empty() && !ValidateOutputPathLocked(jobId, snapPath, abs)) {
                    Log(j, "warn", std::string("忽略快照里一个不在输出目录内的路径（") + k + "）：" + snapPath);
                } else if (!snapPath.empty() && !stat_path(abs).isFile) {
                    /* 页面侧写盘是"只发消息、不等 ack"：rename 失败时 writeBook 仍然返回 ok。
                       这里以**磁盘事实**为准，别把不存在的旁挂文件写成"以后能合并"。 */
                    Log(j, "warn", std::string("快照声称的路径在磁盘上不存在，已忽略（") + k + "）：" + snapPath);
                } else {
                    j[k] = snapPath;
                }
            }
            for (const char* k : {"bookKey", "bookFile", "title", "model"}) {
                copyStr(k);
            }
            if (s.contains("htmlPaths") && s["htmlPaths"].is_array()) j["htmlPaths"] = s["htmlPaths"];
            if (s.contains("chapterNos") && s["chapterNos"].is_array()) j["chapterNos"] = s["chapterNos"];
            if (s.contains("chapterList") && s["chapterList"].is_array()) j["chapterList"] = s["chapterList"];
            if (s.contains("outputs") && s["outputs"].is_array()) j["outputs"] = s["outputs"];
            if (s.contains("report") && s["report"].is_object()) j["report"] = s["report"];
            for (const char* k : {"chapter", "chapterList", "usage", "audit", "extract"}) {
                auto it = s.find(k);
                if (it != s.end() && it->is_object()) j[k] = *it;
            }
            if (s.contains("durationMs") && s["durationMs"].is_number()) j["durationMs"] = s["durationMs"];
            if (s.contains("startedAt") && (s["startedAt"].is_number() || s["startedAt"].is_null())) {
                j["startedAt"] = s["startedAt"];
            }
            if (s.contains("error") && s["error"].is_object()) j["error"] = s["error"];
        }
        j["ask"] = nullptr;
        if (!p.writeError.empty()) {
            j["status"] = "failed";
            Json err = Json::object();
            err["message"] = p.writeError;
            err["stack"] = "";
            j["error"] = err;
            Log(j, "error", "任务失败：" + p.writeError);
            Json ev = Json::object();
            ev["jobId"] = jobId;
            ev["at"] = at;
            ev["type"] = "done";
            ev["status"] = "failed";
            ev["error"] = err;
            EmitUnlocked(ev);
            SaveHistoryLocked();
            return;
        }
        j["status"] = "done";
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "done";
        ev["status"] = "done";
        ev["htmlPath"] = j.value("htmlPath", std::string());
        if (j.contains("report") && !j["report"].is_null()) ev["report"] = j["report"];
        EmitUnlocked(ev);
        SaveHistoryLocked();
        return;
    }
    if (op == "fail") {
        SettleAsk(jobId, j, p, p.askDefault, "end");
        j["status"] = "failed";
        Json err = msg.contains("error") && msg["error"].is_object() ? msg["error"] : Json::object();
        if (!err.contains("message")) err["message"] = "任务失败";
        j["error"] = err;
        if (j.contains("stages") && j["stages"].is_array()) {
            for (Json& st : j["stages"]) {
                if (st.value("status", std::string()) == "running") {
                    st["status"] = "failed";
                    st["endedAt"] = at;
                    break;
                }
            }
        }
        Log(j, "error", "任务失败：" + safe_str(err, "message"));
        Json ev = Json::object();
        ev["jobId"] = jobId;
        ev["at"] = at;
        ev["type"] = "done";
        ev["status"] = "failed";
        ev["error"] = err;
        EmitUnlocked(ev);
        SaveHistoryLocked();
        return;
    }
    if (op == "saveHistory") {
        SaveHistoryLocked();
        return;
    }
}

void JobStore::EmitUnlocked(const Json& payload) {
    EmitterFn fn = emitter_;
    if (fn) fn(payload);
}

void JobStore::SaveHistoryLocked() {
    // 与 SaveHistory 同一段逻辑，但调用方已经持有 mu_
    Json byId = Json::object();
    for (const Json& h : read_history()) byId[safe_str(h, "id")] = h;
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) byId[it.key()] = summary_of(it.value());
    std::vector<Json> items;
    for (auto it = byId.begin(); it != byId.end(); ++it) items.push_back(it.value());
    std::sort(items.begin(), items.end(), [](const Json& a, const Json& b) {
        return safe_int(a, "createdAt") > safe_int(b, "createdAt");
    });
    Json arr = Json::array();
    for (size_t i = 0; i < items.size() && i < static_cast<size_t>(kMaxHistory); ++i) arr.push_back(items[i]);
    std::string err;
    if (!json_write_file_atomic(history_path(), arr, 2, err)) {
        log_warn("[jobs] history.json 写不进去：" + err);
    }
}

Json JobStore::FindEntry(const std::string& id) {
    std::lock_guard<std::mutex> lk(mu_);
    if (jobs_.contains(id)) return jobs_[id];
    for (const Json& h : read_history()) {
        if (safe_str(h, "id") == id) return h;
    }
    return Json(nullptr);
}

void JobStore::AddLog(const std::string& id, const std::string& level, const std::string& message) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!jobs_.contains(id)) return;
    Log(jobs_[id], level, message);
}

void JobStore::Shutdown() {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
        Private& p = priv_[it.key()];
        if (p.ask.is_object()) {
            Json& j = it.value();
            SettleAsk(it.key(), j, p, p.askDefault, "end");
        }
    }
}

}  // namespace isg
