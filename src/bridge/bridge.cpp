#include "bridge.h"

#include "channels.h"

#include "../app/app.h"
#include "../app/pending.h"
#include "../book/book.h"
#include "../pipeline/cleanup.h"
#include "../settings/bg.h"
#include "../settings/store.h"
#include "../shell/dialogs.h"
#include "../shell/protocol.h"
#include "../shell/shell_ops.h"
#include "../util/base64.h"
#include "../util/file_ops.h"
#include "../extract/extract.h"
#include "../net/net.h"
#include "../pipeline/jobs.h"
#include "../util/hash.h"
#include "../util/log.h"
#include "../util/str_util.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

namespace isg {

namespace {

/* 页面 → 宿主 的消息形态：
     { "__isg": 1, "kind": "invoke", "id": 7, "channel": "settings:get", "args": [ ... ] }
   宿主 → 页面：
     应答 { "__isg": 1, "kind": "reply", "id": 7, "ok": true, "data": ... }
     事件 { "__isg": 1, "kind": "event", "name": "job:event", "payload": { ... } }
   `id` 由页面生成，唯一；宿主原样回填 —— 请求/响应编号表**只有这一处实现**。 */
constexpr int kBridgeMagic = 1;

BridgeResult malformed(const std::string& why) {
    return BridgeResult::Fail("BAD_REQUEST", "桥收到了看不懂的消息：" + why);
}

/* 只取 URL 里"这是哪个文档"的那一段：scheme + 主机 + 路径，**去掉 ?query 与 #fragment**。
   ⚠️ 这一条是真 bug 改出来的：第一版拿"首条消息的完整来源"做等值比较，
   而渲染层一切换 hash 路由（`#settings` / `#about`），来源字符串就变了 ——
   于是**所有 window.isg 调用被静默丢弃**（连失败回包都没有，Promise 永远悬着）。
   症状是"进了设置页之后，保存/导入/换背景全都点了没反应"，而 UI 自测却是全绿
   （那 32 项恰好都发生在 hash 还是 `#workbench` 的时候）。
   oracle 的判据也是比 pathname（ipc.js 的 isOurUiUrl），这里对齐。 */
std::string url_pathname(const std::string& url) {
    std::string s = url;
    const size_t hash = s.find('#');
    if (hash != std::string::npos) s = s.substr(0, hash);
    const size_t q = s.find('?');
    if (q != std::string::npos) s = s.substr(0, q);
    return ascii_lower(s);   // Windows 上路径大小写不敏感
}

std::string json_str(const Json& o, const char* k) {
    auto it = o.find(k);
    return (it != o.end() && it->is_string()) ? it->get<std::string>() : std::string();
}

/* 缓存键里的路径要归一化：渲染层可能一次传 C:/a.pdf、一次传 C:\a.pdf。
   oracle 用的是 path.resolve()，这里用 Win32 的 GetFullPathNameW。 */
std::wstring normalized_path(const std::wstring& p) {
    wchar_t buf[32768] = {};
    const DWORD n = ::GetFullPathNameW(p.c_str(), static_cast<DWORD>(std::size(buf)), buf, nullptr);
    return (n > 0 && n < std::size(buf)) ? std::wstring(buf, n) : p;
}

/* ---------------- 「带上一章」的共用件（Phase 6） ---------------- */

Json problem_obj(const std::string& code, const std::string& level,
                 const std::string& message, const std::string& hint) {
    Json p = Json::object();
    p["code"] = code;
    p["level"] = level;
    p["message"] = message;
    p["hint"] = hint;
    return p;
}

std::string sidecar_trouble(const book::ReadResult& r) {
    if (r.status == book::ReadStatus::missing) return std::string();
    if (r.status == book::ReadStatus::unsupported) {
        return "页面旁边的结构数据是别的版本写的（" + r.schema + "），本程序读不了，已改用「从页面反推」。";
    }
    if (r.status == book::ReadStatus::corrupt) {
        return "页面旁边的结构数据坏了（可能被改过或写坏了），已改用「从页面反推」。";
    }
    if (r.status == book::ReadStatus::io) {
        return "页面旁边的结构数据读不动，已改用「从页面反推」。";
    }
    return std::string();
}

struct ResolvedCarry {
    bool ok = false;
    std::wstring htmlPath;
    bool trusted = false;
    std::string label;
    std::string code;
    std::string message;
};

ResolvedCarry resolve_carry_desc(JobStore* jobs, const Json& desc) {
    ResolvedCarry r;
    if (!desc.is_object() || desc.is_array()) {
        r.code = "BAD_ARG";
        r.message = "没有说要带上哪一份";
        return r;
    }
    const std::string kind = json_str(desc, "kind");
    if (kind == "history") {
        const std::string id = json_str(desc, "id");
        if (id.empty()) { r.code = "BAD_ARG"; r.message = "没有给出章节编号"; return r; }
        const Json e = jobs ? jobs->FindEntry(id) : Json(nullptr);
        if (!e.is_object()) {
            r.code = "NOT_FOUND";
            r.message = "历史里没有编号「" + id + "」的记录";
            return r;
        }
        const std::string html = json_str(e, "htmlPath");
        if (html.empty()) {
            const std::string name = json_str(e, "fileName");
            r.code = "NOT_FOUND";
            r.message = "「" + (name.empty() ? id : name) + "」还没有产出页面";
            return r;
        }
        r.ok = true;
        r.trusted = true;
        r.htmlPath = to_wide(html);
        r.label = json_str(e, "fileName").empty() ? id : json_str(e, "fileName");
        return r;
    }
    if (kind == "file") {
        const std::string p = trim(json_str(desc, "path"));
        if (p.empty()) { r.code = "BAD_ARG"; r.message = "没有给出文件路径"; return r; }
        r.ok = true;
        r.trusted = false;
        r.htmlPath = to_wide(p);
        r.label = to_utf8(file_name(r.htmlPath));
        return r;
    }
    r.code = "BAD_ARG";
    r.message = "不认识的来源「" + kind + "」（只认 history / file 两种）";
    return r;
}

/* `gen:start` 的 carry 载入是**异步**的（没有旁挂数据时要请页面跑 revive）。
   这个上下文挂在 shared_ptr 上，回调拿强引用就能继续推进；它自己**不持有回调**
   （回调存在 Bridge 的 hostReplies 里），所以不会形成循环引用。 */
struct CarryCtx : std::enable_shared_from_this<CarryCtx> {
    JobStore* jobs = nullptr;
    Json descs = Json::array();
    size_t idx = 0;
    Json carry = Json::array();
    Json warns = Json::array();
    std::string bookKey;
    std::function<void(const std::string&, const Json&,
                       std::function<void(bool, const Json&, const std::string&)>)> request;
    std::function<void(Json, std::string, Json)> done;
    std::function<void(const std::string&, const std::string&)> fail;

    void Begin(std::shared_ptr<CarryCtx> self) {
        while (idx < descs.size()) {
            const Json desc = descs[idx++];
            const ResolvedCarry r = resolve_carry_desc(jobs, desc);
            if (!r.ok) { fail(r.code, r.message); return; }
            if (r.trusted) protocol_allow(r.htmlPath);
            if (!protocol_is_allowed(r.htmlPath)) {
                fail("CARRY_UNUSABLE",
                     r.label + "不能合并：这个位置不在本次工作放行的目录里，请先用「选一个文件」把它选进来");
                return;
            }
            const FileInfo info = stat_path(r.htmlPath);
            if (!info.exists || !info.isFile) {
                fail("NOT_FOUND", "这份页面不在了（被挪走或删掉了）：" + to_utf8(r.htmlPath));
                return;
            }

            const book::ReadResult side = book::read_book(r.htmlPath);
            if (side.ok()) {
                book::SidecarLoad loaded = book::load_from_sidecar(r.htmlPath);
                for (const Json& e : loaded.entries) carry.push_back(e);
                if (bookKey.empty() && loaded.book_kind == "book" && !loaded.book_key.empty()) {
                    bookKey = loaded.book_key;
                }
                continue;
            }

            std::string html;
            if (!read_file_bytes(r.htmlPath, html)) {
                fail("CARRY_UNUSABLE", r.label + "不能合并：这份页面读不出来");
                return;
            }
            const std::string trouble = sidecar_trouble(side);
            auto cb = [self, r, trouble](bool ok, const Json& data, const std::string& why) {
                if (!ok) {
                    self->fail("CARRY_UNUSABLE", r.label + "不能合并：从页面反推时宿主没有得到回应（" + why + "）");
                    return;
                }
                const bool revok = data.is_object() && data.value("ok", false);
                const Json problems = (data.is_object() && data.contains("problems") && data["problems"].is_array())
                                          ? data["problems"] : Json::array();
                if (!revok) {
                    self->fail("CARRY_UNUSABLE", book::carry_fail_text("第 " + std::to_string(self->idx) + " 份（" + r.label + "）", problems));
                    return;
                }
                if (!trouble.empty()) {
                    self->warns.push_back(problem_obj("sidecar-unusable", "warn", trouble,
                        "照原样合并即可；但下面每一条「注意」都要当真 —— 它们正是\"从页面反推\"对不上的地方。"));
                }
                Json entry = book::shape_carry(data.contains("data") ? data["data"] : Json(), "revive");
                self->carry.push_back(entry);
                for (const Json& p : problems) {
                    if (p.is_object() && p.contains("level") && p["level"].is_string()
                        && p["level"].get<std::string>() == "warn") self->warns.push_back(p);
                }
                self->Begin(self);
            };
            request("revive", Json::array({html}), cb);
            return;
        }
        done(std::move(carry), std::move(bookKey), std::move(warns));
    }
};

}  // namespace

struct Bridge::State {
    HWND hwnd = nullptr;
    ComPtr<ICoreWebView2> webview;
    std::atomic<bool> alive{false};
    /* 页面自己报上来的 UI 地址。**只接受主帧且来源就是我们那一页**的调用 ——
       与 oracle 的 `isOurUiUrl` 同一条判据（"整条路径相等"，不是子串包含）：
       否则任何加载 isg:// 的页面（也就是**模型产出的页面**）都能摸到 window.isg。 */
    std::string uiUrl;
    int registeredCount = 0;
    std::function<void(const std::string&)> trace;
    std::function<void(const Json&)> result;
    std::function<void(const Json&)> internal;   // pipeline / http-* 的唯一去处
    JobStore* jobs = nullptr;
    NetManager* net = nullptr;
    std::function<void(const Json&, Bridge::ReplyFn)> verifyProbes;
    std::function<void(const Json&, Bridge::ReplyFn)> verifyDemos;
    int hostSeq = 0;
    std::map<int, std::function<void(bool, const Json&, const std::string&)>> hostReplies;
    /* 页面 → 宿主的大回包（revive 结果可能几百 KB）：分块拼接。
       单条 WebView2 消息超过 ~161KB 会静默丢；revive 一条整章结构很容易超。 */
    std::map<int, std::string> hostReplyChunks;

    /* ---- 异步抽取（extract:preview） ----
       抽取可能跑几秒（26MB PDF），**不能占着 UI 线程**；但 WebView2 的回包只能在
       主线程发。所以工作线程只把结果排进 uiQueue，由 UI 线程的 DrainUiQueue 发。 */
    std::atomic<bool> cancel{false};
    std::mutex uiMutex;
    std::vector<std::function<void()>> uiQueue;
    std::function<void()> uiWaker;
    std::mutex workerMutex;
    /* 每个抽取线程带一个 done 标志：线程跑完后必须能被**回收**（join + 从表里删掉）。
       只 push 不回收的写法就是句柄泄漏 —— dialogs.cpp 已经踩过同一个坑。 */
    struct Worker {
        std::thread thread;
        std::shared_ptr<std::atomic<bool>> done;
    };
    std::vector<Worker> workers;

    /* 调用方必须持有 workerMutex。join 已完成的线程并从表里删掉。 */
    void reap_workers() {
        for (auto it = workers.begin(); it != workers.end();) {
            if (it->done && it->done->load()) {
                if (it->thread.joinable()) it->thread.join();
                it = workers.erase(it);
            } else {
                ++it;
            }
        }
    }

    // 抽取结果缓存：同一路径 + mtime + size 不重复抽（oracle 的 extractCached 同款）。
    std::mutex cacheMutex;
    std::deque<std::pair<std::string, Json>> cache;
};

Bridge::Bridge() : state_(std::make_shared<State>()) {}
Bridge::~Bridge() { Detach(); }

void Bridge::Attach(HWND hwnd, ICoreWebView2* webview, const std::string& uiUrl) {
    /* Attach 之后 Bridge 应当是"可再用"的：上一次 Detach 留下的 cancel=true
       会让所有抽取立刻以 CANCELLED 返回（而且还会白开线程）。 */
    state_->cancel.store(false);
    state_->hwnd = hwnd;
    state_->webview = webview;
    state_->uiUrl = url_pathname(uiUrl);
    state_->alive = true;
}

void Bridge::Detach() {
    if (!state_) return;
    /* 先让工作线程收到取消信号，再等它们退出。
       **必须在放掉 webview 之前 join**：回复闭包里攥着 webview 的 weak_ptr，
       虽然弱引用检查能兜住，但"让线程活过对象"本身就是这个工程明令禁止的。 */
    state_->cancel.store(true);
    {
        std::vector<State::Worker> workers;
        {
            std::lock_guard<std::mutex> lk(state_->workerMutex);
            workers.swap(state_->workers);
        }
        for (auto& w : workers) {
            if (w.thread.joinable()) w.thread.join();
        }
    }
    {
        std::lock_guard<std::mutex> lk(state_->uiMutex);
        state_->uiQueue.clear();
        state_->uiWaker = nullptr;
    }
    /* 先关掉"还活着"的闸，再放掉 COM 引用。
       在途的对话框回调可能比窗口活得久（用户没点就关窗），它们回来时会先看这个标志 ——
       不看就会对已经 Release 的 webview 调 PostWebMessageAsJson（野指针）。 */
    state_->alive = false;
    state_->webview.Reset();
    state_->hwnd = nullptr;
    {
        std::lock_guard<std::mutex> lk(state_->uiMutex);
        state_->hostReplies.clear();
        state_->hostReplyChunks.clear();
        state_->internal = nullptr;
        state_->verifyProbes = nullptr;
        state_->verifyDemos = nullptr;
    }
}

void Bridge::SetUiWaker(std::function<void()> waker) {
    if (!state_) return;
    std::lock_guard<std::mutex> lk(state_->uiMutex);
    state_->uiWaker = std::move(waker);
}

void Bridge::DrainUiQueue() {
    if (!state_) return;
    std::vector<std::function<void()>> queue;
    {
        std::lock_guard<std::mutex> lk(state_->uiMutex);
        queue.swap(state_->uiQueue);
    }
    for (auto& fn : queue) {
        if (fn) fn();
    }
}

/* 从**任意线程**调用：把 fn 排到主线程执行。
   用模板是为了不写出 Bridge::State 这个名字（它是 private 嵌套类型）。 */
namespace {
template <class StateT>
void post_to_page(const std::shared_ptr<StateT>& st, const Json& message) {
    if (!st->alive || !st->webview) return;
    const std::string text = json_dump(message, -1);
    st->webview->PostWebMessageAsString(to_wide(text).c_str());
}

template <class StateT>
void post_to_ui(const std::shared_ptr<StateT>& st, std::function<void()> fn) {
    std::function<void()> waker;
    {
        std::lock_guard<std::mutex> lk(st->uiMutex);
        st->uiQueue.push_back(std::move(fn));
        waker = st->uiWaker;
    }
    if (waker) waker();
}
}  // namespace

void Bridge::PostToPage(const Json& message) {
    if (!state_->alive || !state_->webview) return;
    const std::string text = json_dump(message, -1);
    /* ⚠️ 用 `PostWebMessageAsString`，不是 `PostWebMessageAsJson`。
       后者会让消息经过 Chromium 的 `base::Value`，而那一层的字典**按键名排序** ——
       回包里对象的键序会被重排。这一条在金标准对拍上已经实证过（产出的题库 JSON 键序变了，
       逐字节对拍当场失败）；回包这边同样受影响：设置页的提供商列表是按 `Object.keys(raw)`
       的顺序渲染的（settings.js 的 normalize），键序一变，列表顺序就跟 oracle 不一样了。
       页面侧的桥本来就同时支持字符串消息（`typeof msg === 'string'` 时自己 JSON.parse）。 */
    state_->webview->PostWebMessageAsString(to_wide(text).c_str());
}

void Bridge::EmitEvent(const std::string& name, const Json& payload) {
    Json msg = Json::object();
    msg["__isg"] = kBridgeMagic;
    msg["kind"] = "event";
    msg["name"] = name;
    msg["payload"] = payload;
    PostToPage(msg);
}

void Bridge::DeliverIncomingFile(const std::wstring& path) {
    /* 两条路一起走（纲领 §7.1 坑 2）：存进 pending 解决"首启时事件比监听器先到"，
       推一次事件覆盖"已经在跑、又拖进来一个"。只走一条，整条链路就是死的。
       ⚠️ 事件名与形状必须与 oracle 一致：`job:event` + `{type:'file-dropped', filePath}`。
       第一版发的是 `app:incoming` + `{type:'incoming', path}` —— 而**逐字节搬过来的渲染层
       只认前者**（app.js 的 handleJobEvent 第一件事就是找 `file-dropped`），
       于是事件发出去也没人听，链路是死的（第二路交叉审查抓到的）。 */
    pending_set(path);
    Json payload = Json::object();
    payload["type"] = "file-dropped";
    payload["filePath"] = to_utf8(path);
    EmitEvent(kEventJobEvent, payload);
}

void Bridge::PostMessageFromAnyThread(const Json& message) {
    std::shared_ptr<State> st = state_;
    post_to_ui(st, [st, message]() {
        if (st->alive) post_to_page(st, message);
    });
}

void Bridge::QueueToPage(const Json& message) {
    std::shared_ptr<State> st = state_;
    post_to_ui(st, [st, message]() {
        if (st->alive) post_to_page(st, message);
    });
}

void Bridge::SetInternalHandler(std::function<void(const Json&)> handler) {
    state_->internal = std::move(handler);
}

void Bridge::SetJobs(JobStore* jobs) { state_->jobs = jobs; }
void Bridge::SetNet(NetManager* net) { state_->net = net; }
void Bridge::SetVerifyHandlers(VerifyFn probes, VerifyFn demos) {
    state_->verifyProbes = std::move(probes);
    state_->verifyDemos = std::move(demos);
}

void Bridge::RequestPage(const std::string& name, const Json& args, HostReplyFn reply) {
    if (!state_->alive) {
        if (reply) reply(false, Json(), "页面还没就绪");
        return;
    }
    const int id = ++state_->hostSeq;
    /* 页面没有回应时不能永远挂着：设置页的「测试连接」会一直转圈，
       而用户唯一的补救是重启。15 秒后回一条明确失败。 */
    auto done = std::make_shared<std::atomic<bool>>(false);
    HostReplyFn wrapped = [reply = std::move(reply), done](bool ok, const Json& data, const std::string& err) {
        done->store(true);
        if (reply) reply(ok, data, err);
    };
    state_->hostReplies[id] = wrapped;
    /* 参数可能很大（revive 要整份 HTML）。超过 48KB 就分块：
       单条消息超限会**静默丢失**，页面永远收不到请求，最后只看到 15 秒超时。 */
    const std::string argsText = json_dump(args, -1);
    Json head = Json::object();
    head["__isg"] = kBridgeMagic;
    head["kind"] = "host-request";
    head["id"] = id;
    head["name"] = name;
    if (argsText.size() > 48 * 1024) {
        head["chunked"] = true;
        head["bytes"] = static_cast<int64_t>(argsText.size());
        PostToPage(head);
        constexpr size_t kChunk = 36 * 1024;
        for (size_t off = 0; off < argsText.size(); off += kChunk) {
            Json c = Json::object();
            c["__isg"] = kBridgeMagic;
            c["kind"] = "host-request-chunk";
            c["id"] = id;
            c["data"] = base64_encode(argsText.substr(off, kChunk));
            PostToPage(c);
        }
        Json end = Json::object();
        end["__isg"] = kBridgeMagic;
        end["kind"] = "host-request-end";
        end["id"] = id;
        PostToPage(end);
    } else {
        head["args"] = args;
        PostToPage(head);
    }

    std::weak_ptr<State> weak = state_;
    std::thread([weak, id, done]() {
        for (int i = 0; i < 150; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (done->load()) return;
        }
        if (done->load()) return;
        auto st = weak.lock();
        if (!st) return;
        post_to_ui(st, [weak, id]() {
            auto s = weak.lock();
            if (!s) return;
            auto it = s->hostReplies.find(id);
            if (it == s->hostReplies.end()) return;
            auto fn = std::move(it->second);
            s->hostReplies.erase(it);
            fn(false, Json(), "页面 15 秒没有回应（pipeline-host.js 没加载或版本不匹配？）");
        });
    }).detach();
}

void Bridge::OnWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args) {
    if (args == nullptr || !state_->alive) return;
    LPWSTR raw = nullptr;
    if (FAILED(args->TryGetWebMessageAsString(&raw)) || raw == nullptr) {
        // 不是字符串消息（比如页面 postMessage 了一个对象）：我们只认字符串形态。
        log_warn("桥忽略了一条非字符串消息");
        return;
    }
    const std::string text = to_utf8(raw);
    ::CoTaskMemFree(raw);

    /* 来源检查。WebView2 的 WebMessageReceived 只对**主帧**触发（子帧要走
       FrameWebMessageReceived，我们没有挂），但仍然要核对来源 URI：
       模型产出的页面同样跑在 isg:// 上，只是不在我们的 UI 目录里。 */
    LPWSTR sourceRaw = nullptr;
    std::string sourcePath;
    if (SUCCEEDED(args->get_Source(&sourceRaw)) && sourceRaw != nullptr) {
        const std::string source = to_utf8(sourceRaw);
        ::CoTaskMemFree(sourceRaw);
        sourcePath = url_pathname(source);
        if (!state_->uiUrl.empty() && sourcePath != state_->uiUrl) {
            /* **不要静默丢弃**：丢弃的话页面那边的 Promise 永远不 settle，
               用户看到的是"点了没反应"，而日志里只有一行 warn。
               解析出 id 之后回一条明确的失败信封，让界面能说出来。 */
            log_warn("桥拒绝了一个来源不明的调用：" + source);
            Json msg2;
            std::string perr;
            if (json_parse(text, msg2, perr) && msg2.is_object()) {
                const int badId = msg2.contains("id") && msg2["id"].is_number() ? msg2["id"].get<int>() : 0;
                Json reply = Json::object();
                reply["__isg"] = kBridgeMagic;
                reply["kind"] = "reply";
                reply["id"] = badId;
                reply["ok"] = false;
                Json e = Json::object();
                e["code"] = "BAD_ORIGIN";
                e["message"] = "这个请求不是从工作台主界面发出来的";
                reply["error"] = e;
                PostToPage(reply);
            }
            return;
        }
    } else {
        /* **fail-closed**：取不到来源就无法证明这是主界面发来的。以前这里直接放行，
           等于把"取来源失败"变成了一条绕过来源检查的路。 */
        log_warn("桥无法确认这条消息的来源，已丢弃");
        return;
    }

    Json msg;
    std::string err;
    if (!json_parse(text, msg, err) || !msg.is_object()) {
        log_warn("桥收到了非 JSON 消息：" + err);
        return;
    }
    const int id = msg.contains("id") && msg["id"].is_number() ? msg["id"].get<int>() : 0;
    const std::string kind = json_str(msg, "kind");
    const std::string channel = json_str(msg, "channel");

    /* ---- 宿主请求的回包（settings:test / revive —— 页面里的逻辑真的跑了一遍） ---- */
    auto deliverHostReply = [this](const Json& reply) {
        const int hid = reply.contains("id") && reply["id"].is_number() ? reply["id"].get<int>() : 0;
        auto it = state_->hostReplies.find(hid);
        if (it == state_->hostReplies.end()) return;
        auto fn = std::move(it->second);
        state_->hostReplies.erase(it);
        const bool ok = reply.contains("ok") && reply["ok"].is_boolean() && reply["ok"].get<bool>();
        /* 回包处理里会读页面给的数据（revive 结果等）。页面是不可信输入：
           一个类型异常不能让宿主 terminate。 */
        try {
            if (ok) {
                fn(true, reply.contains("data") ? reply["data"] : Json(), std::string());
            } else {
                std::string why = "页面没有说明原因";
                if (reply.contains("error") && reply["error"].is_object()) {
                    why = json_str(reply["error"], "message");
                }
                fn(false, Json(), why);
            }
        } catch (const std::exception& e) {
            log_warn(std::string("[bridge] 处理页面回包时抛异常：") + e.what());
        }
    };
    if (kind == "host-reply") {
        const int hid = msg.contains("id") && msg["id"].is_number() ? msg["id"].get<int>() : 0;
        if (msg.contains("chunked") && msg["chunked"].is_boolean() && msg["chunked"].get<bool>()) {
            state_->hostReplyChunks[hid].clear();
            return;
        }
        deliverHostReply(msg);
        return;
    }
    if (kind == "host-reply-chunk") {
        const int hid = msg.contains("id") && msg["id"].is_number() ? msg["id"].get<int>() : 0;
        auto it = state_->hostReplyChunks.find(hid);
        if (it == state_->hostReplyChunks.end()) return;
        if (it->second.size() < 32u * 1024 * 1024) {
            it->second += json_str(msg, "data");
        }
        return;
    }
    if (kind == "host-reply-end") {
        const int hid = msg.contains("id") && msg["id"].is_number() ? msg["id"].get<int>() : 0;
        auto it = state_->hostReplyChunks.find(hid);
        if (it == state_->hostReplyChunks.end()) return;
        std::string replyText;
        const bool decoded = base64_decode(it->second, replyText);
        state_->hostReplyChunks.erase(it);
        if (!decoded) {
            auto r = state_->hostReplies.find(hid);
            if (r != state_->hostReplies.end()) {
                auto fn = std::move(r->second);
                state_->hostReplies.erase(r);
                if (fn) fn(false, Json(), "页面回包分块解码失败");
            }
            return;
        }
        Json reply;
        std::string replyErr;
        if (!json_parse(replyText, reply, replyErr)) {
            auto r = state_->hostReplies.find(hid);
            if (r != state_->hostReplies.end()) {
                auto fn = std::move(r->second);
                state_->hostReplies.erase(r);
                if (fn) fn(false, Json(), "页面回包不是合法 JSON：" + replyErr);
            }
            return;
        }
        deliverHostReply(reply);
        return;
    }

    /* ---- 流水线与传输层的内部消息 ----
       它们不是 31 个 invoke 通道之一，只是宿主 ↔ 同目录页面脚本之间的私有协议。
       来源检查已经在上面做过（只接受我们这一页）。 */
    if (kind == "pipeline" || kind == "http-fetch" || kind == "http-abort") {
        if (state_->internal) state_->internal(msg);
        return;
    }

    /* 页面里的自测脚本报的进度。**只记不做事**：它是一条诊断通道，
       出了事之后靠它定位"卡在哪一步"，而不是靠猜。 */
    if (kind == "trace") {
        const std::string traceText = json_str(msg, "text");
        if (state_->trace && !traceText.empty()) state_->trace(traceText);
        return;
    }

    /* 页面里的自测脚本回传的最终结果。见 bridge.h 里那段说明：
       WebView2 的 ExecuteScript 不等 Promise，所以结果必须自己送回来。 */
    if (kind == "selftestResult") {
        const Json payload = msg.contains("payload") ? msg["payload"] : Json::object();
        if (state_->result) state_->result(payload);
        return;
    }

    if (kind == "hello") {
        Json reply = Json::object();
        reply["__isg"] = kBridgeMagic;
        reply["kind"] = "hello-ack";
        reply["id"] = id;
        reply["channels"] = Json::array();
        for (int i = 0; i < kChannelCount; ++i) reply["channels"].push_back(kChannels[i]);
        PostToPage(reply);
        return;
    }

    /* 桥自己的方法（**不是** 31 个 IPC 通道之一）：`pathForFile`。
       它必须走这条路，因为它的输入是"这次拖拽事件带的文件"，而那个信息只挂在
       **当前这条消息**的 AdditionalObjects 上 —— 只能在这儿读，不能事后补。 */
    if (kind == "api") {
        const std::string name = json_str(msg, "name");
        Json reply = Json::object();
        reply["__isg"] = kBridgeMagic;
        reply["kind"] = "reply";
        reply["id"] = id;
        if (name == "pathForFile") {
            Json paths = Json::array();
            /* `get_AdditionalObjects` 挂在 **ICoreWebView2WebMessageReceivedEventArgs2** 上
               （基础接口只有消息体本身）。拖拽进来的文件路径就在这里。 */
            ComPtr<ICoreWebView2WebMessageReceivedEventArgs2> args2;
            ComPtr<ICoreWebView2ObjectCollectionView> objects;
            if (SUCCEEDED(args->QueryInterface(IID_PPV_ARGS(&args2))) && args2
                && SUCCEEDED(args2->get_AdditionalObjects(&objects)) && objects) {
                UINT32 count = 0;
                objects->get_Count(&count);
                for (UINT32 i = 0; i < count; ++i) {
                    ComPtr<IUnknown> item;
                    if (FAILED(objects->GetValueAtIndex(i, &item)) || !item) continue;
                    ComPtr<ICoreWebView2File> file;
                    if (FAILED(item.As(&file)) || !file) continue;
                    LPWSTR p = nullptr;
                    if (SUCCEEDED(file->get_Path(&p)) && p != nullptr) {
                        paths.push_back(to_utf8(p));
                        ::CoTaskMemFree(p);
                    }
                }
            }
            reply["ok"] = true;
            reply["data"] = std::move(paths);
        } else {
            reply["ok"] = false;
            Json e = Json::object();
            e["code"] = "UNKNOWN_API";
            e["message"] = "桥不认识这个方法：" + name;
            reply["error"] = e;
        }
        PostToPage(reply);
        return;
    }

    if (kind != "invoke") {
        Json reply = Json::object();
        reply["__isg"] = kBridgeMagic;
        reply["kind"] = "reply";
        reply["id"] = id;
        const BridgeResult r = malformed("kind='" + kind + "'");
        reply["ok"] = false;
        Json e = Json::object();
        e["code"] = r.code;
        e["message"] = r.message;
        reply["error"] = e;
        PostToPage(reply);
        return;
    }

    const Json callArgs = msg.contains("args") && msg["args"].is_array() ? msg["args"] : Json::array();

    /* 回复器可能被异步调用（对话框）；用一个 shared_ptr<bool> 保证"只回一次"，
       并且回来时先看桥还活着没有。 */
    auto replied = std::make_shared<bool>(false);
    std::weak_ptr<State> weak = state_;
    ReplyFn reply = [weak, replied, id](BridgeResult r) {
        if (*replied) {
            log_warn("同一个请求被回复了两次（id=" + std::to_string(id) + "），第二次忽略");
            return;
        }
        *replied = true;
        auto st = weak.lock();
        if (!st || !st->alive) return;      // 桥已经摘了：静默丢弃，绝不碰 webview
        if (r.ok) {
            /* 大结果必须分块：WebView2 的单条消息有大小限制（Phase 1 实测 161 KB
               的字符串收不到），而 `extract:preview` 的整份正文、`gen:get` 的日志
               都可能超过。超过限制时消息**静默丢失**，页面的 Promise 永远不 settle。
               这里把 `data` 序列化成文本，按 36 KB 一块发；页面侧拼起来再 JSON.parse。 */
            const std::string dataText = r.data.is_null() ? std::string("null")
                                                            : json_dump(r.data, -1);
            constexpr size_t kChunkRaw = 36 * 1024;
            if (dataText.size() > 48 * 1024) {
                Json head = Json::object();
                head["__isg"] = kBridgeMagic;
                head["kind"] = "reply";
                head["id"] = id;
                head["ok"] = true;
                head["chunked"] = true;
                post_to_page(st, head);
                for (size_t off = 0; off < dataText.size(); off += kChunkRaw) {
                    Json chunk = Json::object();
                    chunk["__isg"] = kBridgeMagic;
                    chunk["kind"] = "reply-chunk";
                    chunk["id"] = id;
                    chunk["data"] = base64_encode(dataText.substr(off, kChunkRaw));
                    post_to_page(st, chunk);
                }
                Json end = Json::object();
                end["__isg"] = kBridgeMagic;
                end["kind"] = "reply-end";
                end["id"] = id;
                post_to_page(st, end);
                return;
            }
            Json msg2 = Json::object();
            msg2["__isg"] = kBridgeMagic;
            msg2["kind"] = "reply";
            msg2["id"] = id;
            msg2["ok"] = true;
            msg2["data"] = r.data.is_null() ? Json(nullptr) : r.data;
            post_to_page(st, msg2);
        } else {
            Json msg2 = Json::object();
            msg2["__isg"] = kBridgeMagic;
            msg2["kind"] = "reply";
            msg2["id"] = id;
            msg2["ok"] = false;
            Json e = Json::object();
            e["code"] = r.code;
            e["message"] = r.message;
            if (!r.detail.empty()) e["detail"] = r.detail;
            msg2["error"] = e;
            post_to_page(st, msg2);
        }
    };

    try {
        Dispatch(channel, callArgs, reply);
    } catch (const std::exception& e) {
        /* 页面消息是不可信输入：一个类型不对的参数（`gen:answer` 传字符串等）会让
           nlohmann 抛异常。宿主没有顶层 try/catch，异常逃出去就是 std::terminate、
           收尾路径全跳过。这里兜住并回一条明确失败。 */
        log_error(std::string("[bridge] 处理通道「") + channel + "」时抛异常：" + e.what());
        reply(BridgeResult::Fail("BAD_REQUEST", std::string("请求参数不合法：") + e.what()));
    } catch (...) {
        log_error(std::string("[bridge] 处理通道「") + channel + "」时抛未知异常");
        reply(BridgeResult::Fail("BAD_REQUEST", "请求参数不合法（未知异常）"));
    }
}

BridgeResult Bridge::DispatchForTest(const std::string& channel, const Json& args) {
    BridgeResult captured;
    bool done = false;
    auto replied = std::make_shared<bool>(false);
    ReplyFn reply = [&captured, &done, replied](BridgeResult r) {
        if (*replied) return;
        *replied = true;
        captured = std::move(r);
        done = true;
    };
    Json list = args.is_array() ? args : Json::array();
    try {
        Dispatch(channel, list, reply);
    } catch (const std::exception& e) {
        return BridgeResult::Fail("BAD_REQUEST", std::string("自测参数不合法：") + e.what());
    }
    if (!done) {
        // 异步通道（对话框）在自测里没有真窗口可弹：明确说出来，别假装成功
        return BridgeResult::Fail("ASYNC", "这个通道是异步的（要弹系统对话框），自测里请走桩");
    }
    return captured;
}

void Bridge::Dispatch(const std::string& channel, const Json& args, ReplyFn reply) {
    auto arg = [&](size_t i) -> Json {
        return (args.is_array() && i < args.size()) ? args[i] : Json();
    };
    auto arg_str = [&](size_t i) -> std::string {
        const Json v = arg(i);
        return v.is_string() ? v.get<std::string>() : std::string();
    };

    /* ---------- 内部通道（不是 31 个公开通道） ---------- */
    /* Phase 5：demo 读数核对。页面把 `{htmlPath, demos:[{id,checks}]}` 递进来，
       宿主在探针窗口里执行 set→读读数，再把 groups 交回页面比较（0.5% 容差在页面侧，
       probe-parse.js 从 oracle demo-checks.js 逐函数搬来）。 */
    if (channel == "_verify:demo") {
        if (!state_->verifyDemos) {
            reply(BridgeResult::Fail("NOT_IMPLEMENTED", "校验服务没挂上（Phase 5 的探针窗口不可用）"));
            return;
        }
        const Json a = arg(0);
        if (!a.is_object()) { reply(BridgeResult::Fail("BAD_ARG", "参数不是一个对象")); return; }
        state_->verifyDemos(a, reply);
        return;
    }

    /* 这些名字以 `_pipeline:` 开头，页面侧只由同目录的 pipeline-host.js 调用。
       目的：把 skill/契约与任务快照分块取回页面（单条消息有大小限制），
       以及把"测试连接"交给页面里原样搬过来的 llm 层。 */
    if (starts_with(channel, "_pipeline:")) {
        const std::string mainSrc = to_utf8(skill_dir());
        auto named_path = [&](const std::string& name) -> std::wstring {
            if (name == "skillMd") return skill_dir() + L"\\SKILL.md";
            if (name == "skeleton") return skill_dir() + L"\\assets\\page-skeleton.html";
            if (name == "contract") return contract_path();
            return std::wstring();
        };
        auto read_named = [&](const std::string& name, std::string& out) -> bool {
            const std::wstring p = named_path(name);
            return !p.empty() && read_file_bytes(p, out);
        };

        if (channel == "_pipeline:env") {
            if (mainSrc.empty()) {
                reply(BridgeResult::Fail("SKILL_NOT_FOUND",
                    "找不到内核 skill 目录：" + skill_dir_error()));
                return;
            }
            Json env = Json::object();
            const Json pub = get_public_settings();
            env["settings"] = pub;
            Json providers = Json::object();
            if (pub.contains("providers") && pub["providers"].is_object()) {
                for (auto it = pub["providers"].begin(); it != pub["providers"].end(); ++it) {
                    Json cfg = it.value();
                    cfg["id"] = it.key();
                    /* **真 Key 进页面是明令禁止的**（纲领 §4.6 第 7 条）。
                       这里给一个哨兵；net.cpp 在发出前替换成真 Key。 */
                    const bool hasKey = cfg.contains("hasKey") && cfg["hasKey"].is_boolean()
                                        && cfg["hasKey"].get<bool>();
                    cfg["apiKey"] = hasKey ? Json(std::string("__ISG_HOST_KEY__")) : Json(std::string());
                    providers[it.key()] = std::move(cfg);
                }
            }
            env["providers"] = std::move(providers);
            env["version"] = app_version();
            env["userData"] = to_utf8(user_data_dir());
            env["skillDir"] = mainSrc;
            const char* names[3] = {"skillMd", "skeleton", "contract"};
            for (const char* n : names) {
                std::string bytes;
                if (!read_named(n, bytes)) {
                    reply(BridgeResult::Fail("SKILL_FILE_UNREADABLE",
                        std::string("读不到生成所需的文件：") + n));
                    return;
                }
                Json info = Json::object();
                info["bytes"] = static_cast<int64_t>(bytes.size());
                info["sha256"] = sha256_hex(bytes);
                env[std::string(n) + "Info"] = std::move(info);
            }
            reply(BridgeResult::Ok(env));
            return;
        }
        if (channel == "_pipeline:fileInfo") {
            std::string bytes;
            if (!read_named(arg_str(0), bytes)) {
                reply(BridgeResult::Fail("SKILL_FILE_UNREADABLE", "读不到这个文件：" + arg_str(0)));
                return;
            }
            Json info = Json::object();
            info["bytes"] = static_cast<int64_t>(bytes.size());
            info["sha256"] = sha256_hex(bytes);
            reply(BridgeResult::Ok(info));
            return;
        }
        if (channel == "_pipeline:filePart") {
            std::string bytes;
            if (!read_named(arg_str(0), bytes)) {
                reply(BridgeResult::Fail("SKILL_FILE_UNREADABLE", "读不到这个文件：" + arg_str(0)));
                return;
            }
            const Json o = arg(1);
            const Json l = arg(2);
            const int64_t off = o.is_number() ? o.get<int64_t>() : 0;
            int64_t len = l.is_number() ? l.get<int64_t>() : 36 * 1024;
            if (off < 0 || off > static_cast<int64_t>(bytes.size())) {
                reply(BridgeResult::Fail("BAD_ARG", "分块偏移越界"));
                return;
            }
            if (len <= 0) len = 36 * 1024;
            /* 页面可控的 off/len：先按"剩余量"夹住，避免 off+len 溢出成负数。 */
            const int64_t remain = static_cast<int64_t>(bytes.size()) - off;
            if (len > remain) len = remain;
            const int64_t end = off + len;
            Json out = Json::object();
            out["data"] = base64_encode(bytes.substr(static_cast<size_t>(off),
                                                     static_cast<size_t>(end - off)));
            out["next"] = end;
            out["eof"] = end >= static_cast<int64_t>(bytes.size());
            reply(BridgeResult::Ok(out));
            return;
        }
        if (channel == "_pipeline:jobInfo") {
            if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
            /* SnapshotText 会缓存同一份文本：jobInfo 与随后的 jobPart 必须来自
               同一份快照。以前两处各自 Get()+dump，任务在这两次调用之间只要追加了
               一条日志，分块偏移就对不上，拼出来的 JSON 会被截断。 */
            const std::string text = state_->jobs->SnapshotText(arg_str(0));
            if (text.empty()) { reply(BridgeResult::Fail("NOT_FOUND", "没有这个任务")); return; }
            Json info = Json::object();
            info["bytes"] = static_cast<int64_t>(text.size());
            info["sha256"] = sha256_hex(text);
            reply(BridgeResult::Ok(info));
            return;
        }
        if (channel == "_pipeline:jobPart") {
            if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
            const std::string text = state_->jobs->SnapshotText(arg_str(0));
            if (text.empty()) { reply(BridgeResult::Fail("NOT_FOUND", "没有这个任务")); return; }
            const Json o = arg(1);
            const Json l = arg(2);
            const int64_t off = o.is_number() ? o.get<int64_t>() : 0;
            int64_t len = l.is_number() ? l.get<int64_t>() : 36 * 1024;
            if (off < 0 || off > static_cast<int64_t>(text.size())) {
                reply(BridgeResult::Fail("BAD_ARG", "分块偏移越界"));
                return;
            }
            if (len <= 0) len = 36 * 1024;
            const int64_t remain = static_cast<int64_t>(text.size()) - off;
            if (len > remain) len = remain;
            const int64_t end = off + len;
            Json out = Json::object();
            out["data"] = base64_encode(text.substr(static_cast<size_t>(off),
                                                    static_cast<size_t>(end - off)));
            out["next"] = end;
            out["eof"] = end >= static_cast<int64_t>(text.size());
            reply(BridgeResult::Ok(out));
            return;
        }
        if (channel == "_pipeline:ask") {
            if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
            const Json a = arg(0);
            if (!a.is_object()) { reply(BridgeResult::Fail("BAD_ARG", "问题参数不是对象")); return; }
            const std::string jid = json_str(a, "jobId");
            const Json ask = a.contains("ask") ? a["ask"] : Json::object();
            const bool ok = state_->jobs->OpenAsk(jid, ask, [reply](const Json& r) {
                reply(BridgeResult::Ok(r.contains("data") ? r["data"] : Json(nullptr)));
            });
            if (!ok) reply(BridgeResult::Fail("NOT_FOUND", "没有这个任务，问题没有挂上"));
            return;
        }
        reply(BridgeResult::Fail("UNKNOWN_CHANNEL", "未登记的内部通道：" + channel));
        return;
    }

    /* ---------- 未登记 / 未实现 ---------- */
    if (!is_known_channel(channel)) {
        // 理论上到不了这里（页面侧只可能发登记过的名字）。留着是为了"将来有人加方法时立刻炸"
        reply(BridgeResult::Fail("UNKNOWN_CHANNEL", "未登记的 IPC 通道：" + channel));
        return;
    }

    /* Phase 1–6 的 31 个公开通道现在都有实现。仍然保留"明确报错"的原则：
       任何走到下面并且没有命中的通道，会在函数末尾得到 UNKNOWN_CHANNEL。 */

    /* ---------- 设置：测试连接 ---------- */
    /* 真正跑请求的是页面里原样搬过来的 `llm/index.js`（协议差异、重试、打码都在那一份里）。
       宿主只负责：把 providerId 送过去 → 页面用哨兵 Key 发请求 → net.cpp 换成真 Key。
       这样「测试连接」与「真生成」走的是**同一条** llm 代码路径。 */
    if (channel == "settings:test") {
        const std::string id = arg_str(0);
        if (id.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出提供商 id")); return; }
        RequestPage("testConnection", Json::array({id}),
                    [reply](bool ok, const Json& data, const std::string& why) {
            if (!ok) { reply(BridgeResult::Fail("TEST_FAILED", why)); return; }
            reply(BridgeResult::Ok(data));
        });
        return;
    }

    /* ---------- 生成任务的生命周期 ---------- */
    if (channel == "gen:start") {
        if (state_->jobs == nullptr) {
            reply(BridgeResult::Fail("INTERNAL", "任务层没挂上（宿主初始化失败）"));
            return;
        }
        const Json input = arg(0);
        if (!input.is_object()) {
            reply(BridgeResult::Fail("BAD_ARG", "gen:start 的参数不是一个对象"));
            return;
        }
        /* oracle 在 createJob **之前**就检查模型与文件存在。放在这里而不是等流水线
           才失败：否则界面不会显示"开始生成失败"的横幅，而是进运行页看到一个
           failed 任务，ghost 引导也永远不出现。 */
        const Json pub = get_public_settings();
        const bool hasModel = pub.contains("active") && pub["active"].is_object()
                              && pub["active"].contains("model") && pub["active"]["model"].is_string()
                              && !pub["active"]["model"].get<std::string>().empty();
        if (!hasModel) {
            reply(BridgeResult::Fail("NO_MODEL",
                "还没选模型：请到「设置」里启用一个提供商并选定模型"));
            return;
        }
        if (input.contains("sources") && input["sources"].is_array()) {
            for (const Json& s : input["sources"]) {
                const std::string fp = (s.is_object() && s.contains("filePath") && s["filePath"].is_string())
                                           ? s["filePath"].get<std::string>() : std::string();
                if (!fp.empty() && !stat_path(to_wide(fp)).exists) {
                    const std::string label = s.contains("label") && s["label"].is_string()
                                                  ? s["label"].get<std::string>() : fp;
                    reply(BridgeResult::Fail("NOT_FOUND", "材料不存在：" + label));
                    return;
                }
            }
        } else if (input.contains("filePath") && input["filePath"].is_string()) {
            const std::string fp = input["filePath"].get<std::string>();
            if (!fp.empty() && !stat_path(to_wide(fp)).exists) {
                reply(BridgeResult::Fail("NOT_FOUND", "材料不存在：" + fp));
                return;
            }
        }
        /* 产出方式与 carry 的互斥（oracle ipc.js 同一条）：分开生成时"一册"不存在，
           带过来的老章挂到哪一份上说不清，所以当场拒。 */
        const std::string mode = input.contains("mode") && input["mode"].is_string()
                                     ? trim(input["mode"].get<std::string>()) : std::string("book");
        const bool hasCarry = input.contains("carry") && input["carry"].is_array()
                              && !input["carry"].empty();
        if (mode == "separate" && hasCarry) {
            reply(BridgeResult::Fail("BAD_ARG", "分开生成时不能带以前的章节——分开生成就是每章各自独立"));
            return;
        }

        auto do_create = [this, input, reply](Json carry, std::string bookKey, Json carryWarns) {
            Json in = input;
            Json warns = Json::array();
            if (carry.is_array() && !carry.empty()) in["carry"] = carry;
            if (!bookKey.empty()) in["carryBookKey"] = bookKey;
            if (carryWarns.is_array()) {
                for (const Json& w : carryWarns) {
                    if (w.is_string()) warns.push_back(w.get<std::string>());
                    else if (w.is_object()) {
                        const std::string msg = json_str(w, "message");
                        if (!msg.empty()) {
                            const std::string hint = json_str(w, "hint");
                            warns.push_back(msg + (hint.empty() ? "" : (" 建议：" + hint)));
                        }
                    }
                }
            }
            if (!warns.empty()) in["carryWarnings"] = warns;
            Json out;
            std::string err;
            if (!state_->jobs->Create(in, out, err)) {
                reply(BridgeResult::Fail("BAD_ARG", err));
                return;
            }
            reply(BridgeResult::Ok(out));
            /* ⚠️ `pipeline-run` **不能**在这条 WebView2 回调栈上直接发（Phase 1 实测会重入）。
               排到计时器/消息队列那一拍再发。 */
            Json run = Json::object();
            run["__isg"] = kBridgeMagic;
            run["kind"] = "pipeline-run";
            run["jobId"] = out.value("jobId", std::string());
            QueueToPage(run);
        };

        if (!hasCarry) {
            do_create(Json::array(), std::string(), Json::array());
            return;
        }

        auto ctx = std::make_shared<CarryCtx>();
        ctx->jobs = state_->jobs;
        ctx->descs = input["carry"];
        ctx->request = [this](const std::string& name, const Json& a,
                              std::function<void(bool, const Json&, const std::string&)> cb) {
            RequestPage(name, a, std::move(cb));
        };
        ctx->done = [do_create](Json carry, std::string bookKey, Json warns) {
            do_create(std::move(carry), std::move(bookKey), std::move(warns));
        };
        ctx->fail = [reply](const std::string& code, const std::string& message) {
            reply(BridgeResult::Fail(code, message));
        };
        ctx->Begin(ctx);
        return;
    }
    if (channel == "gen:cancel") {
        if (state_->jobs == nullptr) {
            reply(BridgeResult::Fail("INTERNAL", "任务层没挂上"));
            return;
        }
        const std::string id = arg_str(0);
        const bool ok = state_->jobs->Cancel(id, arg(1));
        if (ok && state_->net) state_->net->AbortJob(id);
        if (ok) {
            Json m = Json::object();
            m["__isg"] = kBridgeMagic;
            m["kind"] = "pipeline-cancel";
            m["jobId"] = id;
            QueueToPage(m);
        }
        reply(BridgeResult::Ok(ok));
        return;
    }
    if (channel == "gen:answer") {
        if (state_->jobs == nullptr) {
            reply(BridgeResult::Fail("INTERNAL", "任务层没挂上"));
            return;
        }
        reply(BridgeResult::Ok(state_->jobs->Answer(arg(0))));
        return;
    }
    if (channel == "gen:get") {
        if (state_->jobs == nullptr) {
            reply(BridgeResult::Fail("INTERNAL", "任务层没挂上"));
            return;
        }
        reply(BridgeResult::Ok(state_->jobs->Get(arg_str(0))));
        return;
    }
    if (channel == "gen:list") {
        if (state_->jobs == nullptr) {
            reply(BridgeResult::Fail("INTERNAL", "任务层没挂上"));
            return;
        }
        reply(BridgeResult::Ok(state_->jobs->List()));
        return;
    }

    /* ---------- 校验（Phase 5） ---------- */
    if (channel == "verify:run") {
        const Json a = arg(0);
        const std::string htmlPath = json_str(a, "htmlPath");
        if (htmlPath.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出要校验的 HTML")); return; }
        if (!stat_path(to_wide(htmlPath)).isFile) {
            reply(BridgeResult::Fail("NOT_FOUND", "文件不存在：" + htmlPath));
            return;
        }
        /* 结果页的「重新校验」要能校验历史里的产物：路径出自渲染层的任务快照，
           与 oracle 的 `preview.allow(htmlPath)` 同一处置。 */
        protocol_allow(to_wide(htmlPath));
        const Json asked = (a.is_object() && a.contains("probes") && a["probes"].is_array())
                               ? a["probes"] : Json::array();
        Json use = Json::array();
        for (const Json& n : asked) {
            if (!n.is_string()) continue;
            const std::string s = n.get<std::string>();
            if (s == "verify" || s == "demo" || s == "pet") use.push_back(s);
        }
        if (!asked.empty() && use.empty()) {
            reply(BridgeResult::Fail("BAD_ARG", "探针名不认识（只认 verify / demo / pet）"));
            return;
        }
        if (use.empty()) { use.push_back("verify"); use.push_back("demo"); use.push_back("pet"); }
        if (!state_->verifyProbes) {
            reply(BridgeResult::Fail("NOT_IMPLEMENTED", "校验服务没挂上（Phase 5 的探针窗口不可用）"));
            return;
        }
        Json req = Json::object();
        req["htmlPath"] = htmlPath;
        req["probes"] = use;
        req["timeoutMs"] = 45000;
        state_->verifyProbes(req, reply);
        return;
    }

    /* ---------- 收尾清单（Phase 6） ---------- */
    if (channel == "run:scanCleanup") {
        if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
        const std::string id = arg_str(0);
        if (id.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出任务号")); return; }
        const Json job = state_->jobs->Get(id, true);
        if (!job.is_object()) {
            reply(BridgeResult::Fail("NOT_FOUND",
                "这个任务已经不在内存里了（应用重启过），没法自动定位它的输出目录；请手动去输出目录清理"));
            return;
        }
        reply(BridgeResult::Ok(cleanup_plan_to_json(cleanup_scan_run(job))));
        return;
    }
    if (channel == "run:doCleanup") {
        if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
        const Json a = arg(0);
        const std::string id = json_str(a, "jobId");
        if (id.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出任务号")); return; }
        const Json job = state_->jobs->Get(id, true);
        if (!job.is_object()) {
            reply(BridgeResult::Fail("NOT_FOUND", "这个任务已经不在内存里了（应用重启过），没法核对要删的文件"));
            return;
        }
        reply(BridgeResult::Ok(cleanup_do(job, (a.is_object() && a.contains("paths")) ? a["paths"] : Json::array())));
        return;
    }

    /* ---------- 「带上一章」（Phase 6） ---------- */
    if (channel == "book:list") {
        if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
        Json out = Json::array();
        for (const Json& e : state_->jobs->List()) {
            Json o = Json::object();
            o["id"] = json_str(e, "id");
            o["fileName"] = json_str(e, "fileName");
            o["htmlPath"] = json_str(e, "htmlPath");
            o["chapter"] = book::chapter_info(e.contains("chapter") ? e["chapter"] : Json());
            o["createdAt"] = e.contains("createdAt") ? e["createdAt"] : Json(0);
            o["status"] = json_str(e, "status");
            o["chapterFile"] = json_str(e, "chapterFile");
            o["bookKey"] = json_str(e, "bookKey");
            o["mergeStatus"] = json_str(e, "mergeStatus");
            o["canMerge"] = e.contains("canMerge") && e["canMerge"].is_boolean() && e["canMerge"].get<bool>();
            o["exactMerge"] = e.contains("exactMerge") && e["exactMerge"].is_boolean() && e["exactMerge"].get<bool>();
            o["mergeHint"] = json_str(e, "mergeHint");
            out.push_back(std::move(o));
        }
        reply(BridgeResult::Ok(std::move(out)));
        return;
    }
    if (channel == "book:pickFile") {
        dialog_show(state_->hwnd, DialogKind::kOpenHtml, "", [reply](const DialogOutcome& out) {
            if (!out.error.empty()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.paths.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            /* 用户**当场选过**的位置才放行。渲染层递一个路径进来不放行 ——
               那等于"报一个路径就能读任意文件"。 */
            protocol_allow(out.paths[0]);
            reply(BridgeResult::Ok(to_utf8(out.paths[0])));
        });
        return;
    }
    if (channel == "book:continuity") {
        if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
        const Json a = arg(0);
        Json pending = Json::array();
        if (a.is_object() && a.contains("chapterNos") && a["chapterNos"].is_array()) {
            for (const Json& v : a["chapterNos"]) {
                if (v.is_null()) continue;
                const std::string s = v.is_string() ? v.get<std::string>() : v.dump();
                if (!trim(s).empty()) pending.push_back(s);
            }
        }
        Json known = Json::array();
        for (const Json& e : state_->jobs->List()) {
            if (json_str(e, "status") != "done") continue;
            bool any = false;
            if (e.contains("chapterNos") && e["chapterNos"].is_array()) {
                for (const Json& v : e["chapterNos"]) {
                    if (v.is_null()) continue;
                    known.push_back(v.is_string() ? v : Json(v.dump()));
                    any = true;
                }
            }
            if (!any) {
                const std::string no = e.contains("chapter") && e["chapter"].is_object()
                                           ? json_str(e["chapter"], "no") : std::string();
                if (!trim(no).empty()) known.push_back(no);
            }
        }
        Json verdict = book::judge_continuity(pending, known);
        std::set<std::string> uniq;
        Json knownOut = Json::array();
        for (const Json& v : known) {
            const std::string s = v.is_string() ? v.get<std::string>() : v.dump();
            if (uniq.insert(s).second) knownOut.push_back(s);
        }
        verdict["knownNos"] = knownOut;
        verdict["pendingNos"] = pending;
        reply(BridgeResult::Ok(std::move(verdict)));
        return;
    }
    if (channel == "book:inspect") {
        if (!state_->jobs) { reply(BridgeResult::Fail("INTERNAL", "任务层没挂上")); return; }
        const Json desc = arg(0);
        const ResolvedCarry r0 = resolve_carry_desc(state_->jobs, desc);
        if (!r0.ok) { reply(BridgeResult::Fail(r0.code, r0.message)); return; }
        if (r0.trusted) protocol_allow(r0.htmlPath);
        if (!protocol_is_allowed(r0.htmlPath)) {
            reply(BridgeResult::Fail("NOT_ALLOWED",
                "这个位置不在本次工作放行的目录里，请先用「选一个文件」把它选进来"));
            return;
        }
        const FileInfo info = stat_path(r0.htmlPath);
        if (!info.exists || !info.isFile) {
            reply(BridgeResult::Fail("NOT_FOUND", "这份页面不在了（被挪走或删掉了）：" + to_utf8(r0.htmlPath)));
            return;
        }
        const book::ReadResult side = book::read_book(r0.htmlPath);
        if (side.ok()) {
            const book::SidecarLoad loaded = book::load_from_sidecar(r0.htmlPath);
            reply(BridgeResult::Ok(book::inspect_public(loaded)));
            return;
        }
        std::string html;
        if (!read_file_bytes(r0.htmlPath, html)) {
            Json problems = Json::array();
            problems.push_back(problem_obj("html-unreadable", "blocker", "这份页面读不出来",
                "确认文件还在、也没被别的程序锁住；不行就用「选一个文件」重新选一次。"));
            Json out = Json::object();
            out["ok"] = false;
            out["from"] = "revive";
            out["chapter"] = book::chapter_info(Json());
            out["problems"] = std::move(problems);
            out["canCarry"] = false;
            reply(BridgeResult::Ok(std::move(out)));
            return;
        }
        const std::string trouble = sidecar_trouble(side);
        RequestPage("revive", Json::array({html}),
                    [reply, trouble, r0](bool ok, const Json& data, const std::string& why) {
            Json problems = Json::array();
            if (!ok) {
                problems.push_back(problem_obj("revive-failed", "blocker",
                    "从页面反推结构时宿主没有得到回应：" + why,
                    "重试一次；不行就用「选一个文件」重新选。"));
                Json out = Json::object();
                out["ok"] = false;
                out["from"] = "revive";
                out["chapter"] = book::chapter_info(Json());
                out["problems"] = std::move(problems);
                out["canCarry"] = false;
                reply(BridgeResult::Ok(std::move(out)));
                return;
            }
            const bool revok = data.is_object() && data.value("ok", false);
            if (data.is_object() && data.contains("problems") && data["problems"].is_array()) {
                problems = data["problems"];
            }
            if (!trouble.empty()) {
                Json head = problem_obj("sidecar-unusable", "warn", trouble,
                    "照原样合并即可；但下面每一条「注意」都要当真 —— 它们正是\"从页面反推\"对不上的地方。");
                Json merged = Json::array();
                merged.push_back(std::move(head));
                for (const Json& p : problems) merged.push_back(p);
                problems = std::move(merged);
            }
            Json out = Json::object();
            out["ok"] = revok;
            out["from"] = "revive";
            Json chapter = Json();
            if (revok && data.is_object() && data.contains("data") && data["data"].is_object()
                && data["data"].contains("chapter")) {
                chapter = data["data"]["chapter"];
            }
            out["chapter"] = book::chapter_info(chapter);
            out["problems"] = std::move(problems);
            out["canCarry"] = revok;
            reply(BridgeResult::Ok(std::move(out)));
        });
        return;
    }

    /* ---------- 抽取预览 ---------- */
    /* 与 oracle 的 extract:preview 同形：**只读用户选过的位置**（白名单在
       protocol_is_allowed 里），结果按 (路径, mtime, 大小) 缓存最近 4 份。 */
    if (channel == "extract:preview") {
        const std::string p = arg_str(0);
        if (p.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出文件路径")); return; }
        const std::wstring w = to_wide(p);
        if (!protocol_is_allowed(w)) {
            reply(BridgeResult::Fail("NOT_ALLOWED",
                "这个文件不在本次工作放行的目录里，请先在界面里选择它"));
            return;
        }
        const FileInfo info = stat_path(w);
        // oracle 的 handle 包装器把这些都归为 HANDLED_ERROR（文案才是界面读的）。
        if (!info.exists) { reply(BridgeResult::Fail("HANDLED_ERROR", "读不到这个文件：" + p)); return; }
        if (info.isDir) {
            reply(BridgeResult::Fail("HANDLED_ERROR", "这是一个文件夹，不是课件文件：" + p));
            return;
        }
        const std::string key = to_utf8(normalized_path(w)) + "|" + std::to_string(info.mtimeMs)
                                + "|" + std::to_string(info.size);
        {
            bool hit = false;
            Json cached;
            {
                std::lock_guard<std::mutex> lk(state_->cacheMutex);
                for (const auto& kv : state_->cache) {
                    if (kv.first == key) { hit = true; cached = kv.second; break; }
                }
            }
            // 不要在持锁时 reply：reply 会同步走到 PostWebMessageAsString。
            if (hit) { reply(BridgeResult::Ok(std::move(cached))); return; }
        }

        /* 真正抽取在工作线程里跑；UI 线程只负责在 DrainUiQueue 那一拍发回包。 */
        const std::shared_ptr<State> st = state_;
        auto done = std::make_shared<std::atomic<bool>>(false);
        try {
            std::lock_guard<std::mutex> lk(st->workerMutex);
            st->reap_workers();
            st->workers.push_back(State::Worker{
                std::thread([st, w, key, reply, done]() {
                    Json out;
                    ExtractError err;
                    bool ok = false;
                    /* 线程入口必须自己兜住所有异常：异常逃出线程函数 = std::terminate，
                       收尾路径全部跳过、报告一个字节都没有。这里 catch 之后回一条明确失败，
                       比"进程直接消失"强一万倍。 */
                    try {
                        ExtractOptions eopt;
                        eopt.cancel = &st->cancel;
                        ok = extract_file(w, eopt, out, err);
                    } catch (const std::exception& e) {
                        err.code = "EXTRACT_FAILED";
                        err.message = std::string("抽取时发生异常：") + e.what();
                    } catch (...) {
                        err.code = "EXTRACT_FAILED";
                        err.message = "抽取时发生未知异常";
                    }
                    done->store(true);
                    if (!st->alive.load()) return;   // 桥已经摘了：不用回，也不碰 webview
                    post_to_ui(st, [st, key, ok, out, err, reply]() mutable {
                        if (!st->alive.load()) return;
                        if (!ok) {
                            reply(BridgeResult::Fail(err.code.empty() ? "HANDLED_ERROR" : err.code,
                                                     err.message));
                            return;
                        }
                        {
                            std::lock_guard<std::mutex> lk(st->cacheMutex);
                            st->cache.emplace_back(key, out);
                            while (st->cache.size() > 4) st->cache.pop_front();
                        }
                        reply(BridgeResult::Ok(out));
                    });
                }),
                done});
        } catch (const std::exception& e) {
            reply(BridgeResult::Fail("HANDLED_ERROR",
                std::string("启动抽取线程失败：") + e.what()));
        }
        return;
    }

    /* ---------- 应用信息 ---------- */
    if (channel == "app:info") {
        const std::wstring skill = skill_dir();
        const std::wstring contract = contract_path();
        Json d = Json::object();
        d["version"] = app_version();
        d["name"] = app_display_name();
        /* platform / arch：oracle 报的是 process.platform（'win32'）。
           界面拿它显示"平台"，保持一样的取值，免得界面文案要改。 */
        d["platform"] = "win32";
#if defined(_M_X64)
        d["arch"] = "x64";
#elif defined(_M_ARM64)
        d["arch"] = "arm64";
#else
        d["arch"] = "ia32";
#endif
        /* electron / node 在 C++ 版里没有对应物。**留成空串而不是删掉**：
           界面若读了它，空串会显示成"—"，而"字段不存在"会显示成 undefined 并可能抛。
           真正的替代品是 WebView2 运行时版本（chrome 那一栏）。 */
        d["electron"] = "";
        d["node"] = "";
        const std::wstring runtime = webview2_runtime_version();
        d["chrome"] = to_utf8(runtime);
        d["skillDir"] = to_utf8(skill);
        d["skillError"] = skill.empty() ? skill_dir_error() : "";
        d["hasSkill"] = !skill.empty();
        d["contractPath"] = to_utf8(contract);
        d["settingsPath"] = to_utf8(settings_path());
        d["userData"] = to_utf8(user_data_dir());
        d["keyStorage"] = store_key_storage();
        d["isPackaged"] = false;
        reply(BridgeResult::Ok(d));
        return;
    }

    /* ---------- 「用系统默认程序打开」= **执行** ---------- */
    /* 所以必须限死：只允许打开我们放行过的目录里、且扩展名是我们自己产出的那几种文件。
       否则渲染进程一旦被拿下（它同时承载着模型产出的 HTML 预览），
       就能让宿主去启动任意 .exe / .bat / .lnk。安全审计点过名的一条。 */
    if (channel == "app:openPath") {
        const std::string p = arg_str(0);
        if (p.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出要打开的文件")); return; }
        const std::wstring w = to_wide(p);
        if (!stat_path(w).exists) { reply(BridgeResult::Fail("NOT_FOUND", "文件不存在了：" + p)); return; }
        static const std::set<std::string> kOpenable = {
            ".html", ".htm", ".pdf", ".txt", ".md", ".markdown", ".png", ".jpg", ".jpeg", ".webp"};
        const std::wstring ext = [&] {
            const size_t dot = w.find_last_of(L'.');
            if (dot == std::wstring::npos) return std::wstring();
            std::wstring e = w.substr(dot);
            std::transform(e.begin(), e.end(), e.begin(), [](wchar_t c) {
                return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c; });
            return e;
        }();
        const std::string extU8 = to_utf8(ext);
        if (kOpenable.find(extU8) == kOpenable.end()) {
            reply(BridgeResult::Fail("NOT_OPENABLE",
                "出于安全考虑，工作台只用系统程序打开 .html / .htm / .pdf / .txt / .md / .markdown / "
                ".png / .jpg / .jpeg / .webp 这几种文件；「" + (extU8.empty() ? "无扩展名" : extU8)
                + "」请自己在文件管理器里打开"));
            return;
        }
        if (!protocol_is_allowed(w)) {
            reply(BridgeResult::Fail("NOT_ALLOWED", "这个位置不在本次工作放行的目录里，请先在界面里选择它"));
            return;
        }
        std::string err;
        if (!shell_open_path(w, err)) { reply(BridgeResult::Fail("OPEN_FAILED", err)); return; }
        reply(BridgeResult::Ok(Json(nullptr)));
        return;
    }

    /* ---------- 「在系统浏览器里打开这个网址」 ---------- */
    /* ⚠️ 必须与 openPath **分开**：那个是"用系统默认程序**执行**一个文件"，
       把网址喂给它只会得到「文件不存在了：https://…」—— 用户看到的是"链接坏了"。
       危险面是"用任意 scheme 拉起本机程序"，所以**白名单只放 http / https**。 */
    if (channel == "app:openExternal") {
        const std::string raw = arg_str(0);
        if (trim(raw).empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出要打开的网址")); return; }
        std::string url;
        std::string err;
        if (!normalize_url(raw, url, err)) { reply(BridgeResult::Fail("BAD_ARG", err)); return; }
        const std::string lower = ascii_lower(url);
        if (!starts_with(lower, "http://") && !starts_with(lower, "https://")) {
            const size_t colon = lower.find(':');
            const std::string scheme = colon == std::string::npos ? lower : lower.substr(0, colon + 1);
            reply(BridgeResult::Fail("NOT_ALLOWED",
                "出于安全考虑，只在浏览器里打开 http / https 的网址（收到的是 " + scheme + "）"));
            return;
        }
        if (!shell_open_external(url, err)) { reply(BridgeResult::Fail("OPEN_FAILED", err)); return; }
        reply(BridgeResult::Ok(Json(nullptr)));
        return;
    }

    if (channel == "app:revealPath") {
        const std::string p = arg_str(0);
        if (p.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出要定位的文件")); return; }
        const std::wstring w = to_wide(p);
        if (!stat_path(w).exists) { reply(BridgeResult::Fail("NOT_FOUND", "文件不存在了：" + p)); return; }
        // 与 openPath 同标准：只让渲染进程定位我们放行过的位置
        // （以前只判存在，于是渲染进程能让资源管理器打开**任意**存在的路径，
        //  还能拿 NOT_FOUND/ok 当"这个路径存在吗"的预言机）
        if (!protocol_is_allowed(w)) {
            reply(BridgeResult::Fail("NOT_ALLOWED", "这个位置不在本次工作放行的目录里"));
            return;
        }
        std::string err;
        if (!shell_reveal_path(w, err)) { reply(BridgeResult::Fail("REVEAL_FAILED", err)); return; }
        reply(BridgeResult::Ok(Json(nullptr)));
        return;
    }

    if (channel == "app:previewUrl") {
        const std::string p = arg_str(0);
        if (p.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出路径")); return; }
        const std::wstring w = to_wide(p);
        if (!stat_path(w).exists) { reply(BridgeResult::Fail("NOT_FOUND", "文件不存在了：" + p)); return; }
        // **不再隐式放行**：以前 urlFor() 里顺手 allow()，于是渲染进程只要报一个路径，
        // 就能把它的整个目录变成可读区。放行只应该发生在"用户真的选了这个位置"时。
        if (!protocol_is_allowed(w)) {
            reply(BridgeResult::Fail("NOT_ALLOWED", "这个位置不在本次工作放行的目录里，请先在界面里选择它"));
            return;
        }
        Json d = Json::object();
        d["url"] = protocol_url_for(w);
        reply(BridgeResult::Ok(d));
        return;
    }

    if (channel == "app:takePendingFile") {
        const std::wstring f = pending_take();
        if (!f.empty()) protocol_allow(f);
        reply(BridgeResult::Ok(to_utf8(f)));
        return;
    }

    /* ---------- 文件对话框 ---------- */
    if (channel == "dialog:pickFile") {
        const std::shared_ptr<State> st = state_;
        dialog_show(state_->hwnd, DialogKind::kOpenMaterials, "", [this, st, reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            /* 取消时回**空数组**而不是 null：这个通道现在恒定回数组，
               调用方只要判长度就够了，不必再分"null 还是数组"两种情况。
               ⚠️ 每一份都要**各自**放行：漏掉哪一份，那一份的抽取预览与内嵌图片就会被
               isg:// 挡掉，而症状是"加进来了、但读不出内容"，看起来像文件坏了。 */
            Json arr = Json::array();
            for (const std::wstring& p : out.paths) {
                protocol_allow(p);
                arr.push_back(to_utf8(p));
            }
            reply(BridgeResult::Ok(arr));
        });
        return;
    }

    if (channel == "dialog:pickOutputDir") {
        dialog_show(state_->hwnd, DialogKind::kOpenDirectory, "", [this, reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.paths.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            protocol_allow(out.paths[0]);
            reply(BridgeResult::Ok(to_utf8(out.paths[0])));
        });
        return;
    }

    if (channel == "dialog:pickImage") {
        dialog_show(state_->hwnd, DialogKind::kOpenImage, "", [reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.paths.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            reply(BridgeResult::Ok(to_utf8(out.paths[0])));
        });
        return;
    }

    /* 拖拽进来的文件也需要放行 —— 但**不能**让"读一下这个路径"顺手把整个目录开成可读区。
       所以单独开一条**显式登记**通道，并加三重约束：
         · 必须是一个**真实存在的文件**（不能是目录，不能是通配）；
         · 扩展名必须是课件/文本（不接受 .exe/.lnk 之类）；
         · 本次运行最多登记 20 个，且每一个都写日志。 */
    if (channel == "app:registerPath") {
        const std::string p = arg_str(0);
        if (p.empty()) { reply(BridgeResult::Fail("BAD_ARG", "没有给出路径")); return; }
        if (state_->registeredCount >= 20) {
            reply(BridgeResult::Fail("TOO_MANY", "本次运行登记的文件太多了，请重新启动工作台"));
            return;
        }
        const std::wstring w = to_wide(p);
        const FileInfo info = stat_path(w);
        if (!info.exists) { reply(BridgeResult::Fail("NOT_FOUND", "读不到这个文件：" + p)); return; }
        if (!info.isFile) { reply(BridgeResult::Fail("NOT_FILE", "只能登记文件，不能登记目录")); return; }
        const std::wstring ext = [&] {
            const size_t dot = w.find_last_of(L'.');
            if (dot == std::wstring::npos) return std::wstring();
            std::wstring e = w.substr(dot);
            std::transform(e.begin(), e.end(), e.begin(), [](wchar_t c) {
                return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c; });
            return e;
        }();
        static const std::set<std::string> kRegistrable = {".pptx", ".ppsx", ".pdf", ".txt", ".md", ".markdown"};
        const std::string extU8 = to_utf8(ext);
        if (kRegistrable.find(extU8) == kRegistrable.end()) {
            reply(BridgeResult::Fail("BAD_EXT",
                "不支持的文件类型「" + (extU8.empty() ? "无扩展名" : extU8)
                + "」——只认 .pptx / .ppsx / .pdf / .txt / .md / .markdown"));
            return;
        }
        protocol_allow(w);
        state_->registeredCount++;
        log_info("[bridge] 已登记一个用户提供的文件：" + to_utf8(file_name(w)));
        reply(BridgeResult::Ok(true));
        return;
    }

    /* ---------- 工作台界面的背景图 ---------- */
    if (channel == "bg:info") {
        const std::wstring f = bg_current_file();
        Json d = Json::object();
        if (f.empty()) {
            d["file"] = "";
            d["url"] = "";
            d["bytes"] = 0;
            reply(BridgeResult::Ok(d));
            return;
        }
        protocol_allow(f);      // 只放行 background/ 这一层
        d["file"] = to_utf8(file_name(f));
        d["url"] = protocol_url_for(f);
        d["bytes"] = stat_path(f).size;
        reply(BridgeResult::Ok(d));
        return;
    }

    if (channel == "bg:import") {
        dialog_show(state_->hwnd, DialogKind::kOpenImage,
                    "", [this, reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.paths.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            BgImportResult imported;
            std::string err;
            if (!bg_import_from(out.paths[0], imported, err)) {
                reply(BridgeResult::Fail("IMPORT_FAILED", err));
                return;
            }
            protocol_allow(imported.abs);
            // 顺手把设置里的记录一起写掉，省得界面还要再存一次、中途失败就两边不一致
            Json patch = Json::object();
            patch["ui"] = Json::object();
            patch["ui"]["bgImage"] = imported.file;
            save_settings(patch);
            Json d = Json::object();
            d["file"] = imported.file;
            d["url"] = protocol_url_for(imported.abs);
            d["bytes"] = imported.bytes;
            reply(BridgeResult::Ok(d));
        });
        return;
    }

    if (channel == "bg:clear") {
        const std::vector<std::string> removed = bg_clear();
        Json patch = Json::object();
        patch["ui"] = Json::object();
        patch["ui"]["bgImage"] = "";
        save_settings(patch);
        Json d = Json::object();
        d["removed"] = Json::array();
        for (const std::string& r : removed) d["removed"].push_back(r);
        reply(BridgeResult::Ok(d));
        return;
    }

    /* ---------- 设置 ---------- */
    if (channel == "settings:get") {
        reply(BridgeResult::Ok(get_public_settings()));
        return;
    }
    if (channel == "settings:save") {
        reply(BridgeResult::Ok(save_settings(arg(0))));
        return;
    }
    if (channel == "settings:export") {
        dialog_show(state_->hwnd, DialogKind::kSaveJson, "isg-studio-settings.json",
                    [this, reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.savePath.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            // 导出会剥掉所有 API Key —— 这个文件经常被丢进云盘或发给同事
            const Json payload = export_settings();
            std::string err;
            if (!json_write_file_atomic(out.savePath, payload, 2, err)) {
                reply(BridgeResult::Fail("WRITE_FAILED", "写不了这个文件：" + err));
                return;
            }
            reply(BridgeResult::Ok(to_utf8(out.savePath)));
        });
        return;
    }
    if (channel == "settings:import") {
        dialog_show(state_->hwnd, DialogKind::kOpenJson, "", [this, reply](const DialogOutcome& out) {
            if (out.error.size()) { reply(BridgeResult::Fail("DIALOG_FAILED", out.error)); return; }
            if (out.canceled || out.paths.empty()) { reply(BridgeResult::Ok(Json(nullptr))); return; }
            Json obj;
            std::string err;
            if (!json_read_file(out.paths[0], obj, err)) {
                reply(BridgeResult::Fail("BAD_JSON", "这个文件不是合法的 JSON：" + err));
                return;
            }
            Json pub;
            if (!import_settings(obj, pub, err)) {
                reply(BridgeResult::Fail("BAD_SETTINGS", err));
                return;
            }
            reply(BridgeResult::Ok(pub));
        });
        return;
    }

    // 到这里还没被处理，说明通道表里有它、但 Dispatch 里漏了分支。
    // **不许静默成功**：这是"加了通道忘了实现"的直接症状。
    reply(BridgeResult::Fail("NO_HANDLER",
        "通道「" + channel + "」已登记但没有实现分支（这是宿主侧的漏项，请报一个 bug）"));
}

void Bridge::SetTraceSink(std::function<void(const std::string&)> sink) {
    state_->trace = std::move(sink);
}

void Bridge::SetResultSink(std::function<void(const Json&)> sink) {
    state_->result = std::move(sink);
}

void Bridge::UseShellStub(bool active, void (*record)(const std::string&)) {
    ShellStub stub;
    stub.active = active;
    stub.record = record;
    shell_set_stub(stub);
}

}  // namespace isg
