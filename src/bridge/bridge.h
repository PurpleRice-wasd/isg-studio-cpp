// `window.isg` 的宿主侧实现 —— **渲染层与特权层之间唯一的入口**。
//
// 对应 oracle 的 `src/main/preload.js`（页面侧）+ `src/main/ipc.js`（宿主侧）。
//
// 架构（纲领 §4.3 要求"这一跳要一次做对，别散在各处"）：
//
//     web/isg-bridge.js                       bridge.cpp
//     ─────────────────                       ──────────
//     window.isg.xxx(args)                    OnWebMessage(raw)
//        └─ postMessage({__isg,id,channel})  ─▶  Dispatch(channel, args)
//                                              └─ Handler(args, reply)
//     pending[id].resolve(data)  ◀──────────  reply({ok,data} | {ok:false,error})
//
// 两条纪律：
//   1. **信封格式与 ipc.js 逐字一致**（`{ok,data}` / `{ok:false,error:{code,message,detail}}`）。
//      理由也是 oracle 的：异常跨进程/跨消息边界之后只剩 message，`code` 与 `detail` 全丢，
//      渲染层就没法做分支处理。所以**错误一律走正常返回**，不靠 reject。
//   2. **未实现的通道明确报错**（code='NOT_IMPLEMENTED'），绝不静默返回 null/undefined。
//      静默返回会让渲染层走错分支（"没有任务"、"没有设置"），而那正是本项目最恨的
//      "静默失效"；明确报错至少让界面能说出"这个功能还没实现"。
//
// 线程：**全部在主线程（UI 线程）上**。WebView2 的回调在主线程，对话框结果也 PostMessage
// 回主线程（见 dialogs.h）。所以这里没有锁 —— 加锁反而会掩盖"某处在别的线程调它"的错误。
#pragma once

#include "../util/json_util.h"
#include "../util/win_util.h"

#include <WebView2.h>

#include <functional>
#include <memory>
#include <string>

namespace isg {

class JobStore;
class NetManager;

/* 异步活儿（抽取）干完之后，工作线程用它通知主线程来 DrainUiQueue()。
   PostMessage 是**跨线程安全**的；WebView2 的 PostWebMessageAsJson 不是 ——
   它必须在主线程上调，而且不能从 WebView2 的回调栈上发（Phase 1 的实测结论）。 */
constexpr UINT kBridgeWakeMessage = WM_APP + 41;

struct BridgeResult {
    bool ok = true;
    Json data;
    std::string code;
    std::string message;
    std::string detail;

    static BridgeResult Ok(Json d) {
        BridgeResult r;
        r.ok = true;
        r.data = std::move(d);
        return r;
    }
    static BridgeResult Fail(std::string c, std::string m, std::string d = std::string()) {
        BridgeResult r;
        r.ok = false;
        r.code = std::move(c);
        r.message = std::move(m);
        r.detail = std::move(d);
        return r;
    }
};

class Bridge {
public:
    /* 每个 handler 都拿到一个"回复器"。**可以晚一点再调**（对话框就是异步的），
       但只应该调一次；超时/重复调用会被忽略并记日志。 */
    using ReplyFn = std::function<void(BridgeResult)>;
    using Handler = std::function<void(const Json& args, ReplyFn reply)>;

    Bridge();
    ~Bridge();
    Bridge(const Bridge&) = delete;
    Bridge& operator=(const Bridge&) = delete;

    /* 挂上主窗口与 webview。**必须在导航之前**。
       uiUrl 是"我们这一页"的完整 URL；来源检查**只比 pathname**（见 bridge.cpp 里的说明）。 */
    void Attach(HWND hwnd, ICoreWebView2* webview, const std::string& uiUrl);
    /* 摘掉。此后任何在途回调都不会再碰 webview（关得干净的关键一步）。 */
    void Detach();

    /* WebView2 的 WebMessageReceived 直接转进来。 */
    void OnWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args);

    /* Host → Page 的事件广播（job:event）。 */
    void EmitEvent(const std::string& name, const Json& payload);

    /* 任意线程 → 页面的一条原始消息（HTTP chunk / head / end 用）。
       内部会排到 UI 线程；桥已摘掉时静默丢弃（绝不碰已释放的 webview）。 */
    void PostMessageFromAnyThread(const Json& message);

    /* 等这一轮 WebView2 回调栈退掉之后，再把消息发给页面。
       用于 gen:start 之后的 `pipeline-run`：在回调栈上启动长任务会重入。 */
    void QueueToPage(const Json& message);

    /* 内部消息（kind = pipeline / http-fetch / http-abort）的唯一去处。 */
    void SetInternalHandler(std::function<void(const Json&)> handler);

    /* Host → Page 的**请求**（settings:test 要页面里的 llm 层真的跑一遍）。
       页面用 `kind:'host-reply'` 回包。 */
    using HostReplyFn = std::function<void(bool ok, const Json& data, const std::string& error)>;
    void RequestPage(const std::string& name, const Json& args, HostReplyFn reply);

    /* 任务与网络层。由 AppWindow 在 Attach 之后设置（生命周期比 Bridge 长）。 */
    void SetJobs(JobStore* jobs);
    void SetNet(NetManager* net);

    /* Phase 5：探针窗口在 AppWindow 手里（它要自己的 HWND/环境）。桥只把请求转过去。 */
    using VerifyFn = std::function<void(const Json& args, ReplyFn reply)>;
    void SetVerifyHandlers(VerifyFn probes, VerifyFn demos);

    /* 外部要求打开的文件送进来（单实例 / 命令行）。 */
    void DeliverIncomingFile(const std::wstring& path);

    /* 工作线程 → 主线程的唤醒器。由 AppWindow 设为 PostMessage(kBridgeWakeMessage)。
       **必须在 Attach 之后设置**；Detach 时会清掉。 */
    void SetUiWaker(std::function<void()> waker);
    /* 主线程收到 kBridgeWakeMessage 后调用：把工作线程排进来的 lambda 跑掉。 */
    void DrainUiQueue();

    /* 自测用：直接跑一次通道（跳过页面），拿到信封。
       用于"未实现的通道必须明确报错"这条判据 —— 它不需要真的有个窗口。 */
    BridgeResult DispatchForTest(const std::string& channel, const Json& args);

    /* 自测用：Shell 桩（不真的去开浏览器/打开文件）。 */
    void UseShellStub(bool active, void (*record)(const std::string&));

    /* 页面里发来的 `kind:'trace'` 消息往哪儿走。
       为什么要这条通道：真页面里的自测脚本卡住时，宿主这一侧看到的只是
       "ExecuteScript 的 Promise 一直不 resolve"——**卡在哪一步完全看不见**。
       让页面自己把进度报出来，是唯一能把"卡住"定位到具体一步的办法
       （这与 Phase 0 那条"先让程序自己说出真相，别猜"是同一条经验）。 */
    void SetTraceSink(std::function<void(const std::string&)> sink);

    /* 页面里的自测脚本**回传结果**的去处。
       为什么不让脚本 return 出去：WebView2 的 `ExecuteScript` **不等 Promise** ——
       脚本返回一个 Promise 时，它拿到的是 `{}`（"Promise 没法序列化"）。
       Electron 的 `executeJavaScript` 会等，所以照搬那一套只会得到一句
       "自测脚本返回了（2 字节）：{}"，看上去像脚本什么都没干。
       结果走一条明确的消息回传，和这个应用其它所有通信是同一种形态。 */
    void SetResultSink(std::function<void(const Json&)> sink);

private:
    struct State;
    std::shared_ptr<State> state_;

    void Dispatch(const std::string& channel, const Json& args, ReplyFn reply);
    void PostToPage(const Json& message);
};

/* 页面侧的桥是 `web/isg-bridge.js`（一个**真实文件**，由 `web/index.html` 用
   `<script src="isg-bridge.js">` 加载）。
   为什么不把它内联成 C++ 字符串常量再用 AddScriptToExecuteOnDocumentCreated 注入：
     · index.html 自带 `script-src 'self'` 的 CSP，同目录脚本是它明确允许的形态，
       宿主注入的内联脚本则要看 CSP 的脸色 —— 一条路径能确定、就别选那条要看脸色的；
     · 出问题时能用浏览器直接打开那个 js 单步，而不是去 C++ 里找一段字符串。 */

}  // namespace isg
