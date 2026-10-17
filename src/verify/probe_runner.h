// Phase 5：探针窗口驱动 + demo 读数核对（WebView2 版）。
//
// 对应 oracle 的 `src/main/verify/{runner,inject,guard,demo-checks}.js`。
// 拆法（纲领 §6 的模块映射表）：**驱动**重写（Electron BrowserWindow → WebView2），
// **解析/title 口径/0.5% 容差**留在页面侧的 JS（`web/logic/probe-parse.js`，
// 从 oracle 的 runner/demo-checks 逐函数搬过来）。宿主只负责：
//   · 把探针注入被测页、写到**同目录**（不可写才退化到临时目录）；
//   · 用独立的 WebView2 环境/窗口加载它（自己的 user data、自己的协议处理器）；
//   · 装导航守卫（模型产出的页面能自己导航走外带正文，CSP 管不了导航）；
//   · 轮询 `document.title`、读 DOM 快照与探针错误；
//   · 跑 demo checks 的 `set → 读读数` 脚本；
//   · 收尾：清浏览数据、删探针副本。
//
// ⚠️ 这一层最重要的纪律来自 Phase 0/1 的实测：
//   · 一切主动动作（ExecuteScript / Navigate）都从**计时器那一拍**发，
//     绝不在 WebView2 的回调栈上做同步的宿主→渲染调用（会重入死锁）；
//   · 窗口必须**可见**（屏幕外 -32000,-32000），否则布局/几何会被停；
//   · 每个 WebView2 environment 要自己的 user data folder（不能与主窗口共用）。
#pragma once

#include "../util/json_util.h"
#include "../util/win_util.h"

#include <WebView2.h>

#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace isg {

struct VerifyRequest {
    enum class Kind { kProbe, kDemo };
    Kind kind = Kind::kProbe;
    std::string htmlPath;
    std::vector<std::string> probes;   // verify / demo / pet
    Json demos = Json::array();        // kDemo：`[{id, checks}]`
    int timeoutMs = 45000;
};

using VerifyCallback = std::function<void(bool ok, const Json& data, const std::string& error)>;

class ProbeRunner {
public:
    ProbeRunner(HWND notifyHwnd, HINSTANCE hInst);
    ~ProbeRunner();
    ProbeRunner(const ProbeRunner&) = delete;
    ProbeRunner& operator=(const ProbeRunner&) = delete;

    /* 从任意地方排一个请求（通常是在 WebView2 的回调栈上）。真正启动在 Tick()。 */
    void Submit(VerifyRequest req, VerifyCallback cb);

    /* 主窗口计时器每 100ms 调一次：启动下一个请求、推进状态机、判超时。 */
    void Tick(int64_t nowMs);

    /* 关窗：取消在途请求、按序释放 controller/webview/env/窗口/类。 */
    void Shutdown();

    bool busy() const { return active_ != nullptr; }

private:
    struct Core;
    struct Active {
        VerifyRequest req;
        VerifyCallback cb;
        bool done = false;
    };

    void StartNext(int64_t now);
    bool EnsureWindow(int64_t now);
    void BeginRun(Active& a, int64_t now);
    void FailRun(Active& a, const std::string& message);
    void FinishRun(Active& a, bool ok, Json data, const std::string& error);
    void DriveFinalize(int64_t now);
    void DeleteProbeCopy();
    void DestroyWindowAndEnv();

    HWND notifyHwnd_ = nullptr;
    HINSTANCE hInst_ = nullptr;
    std::shared_ptr<Core> core_;
    std::deque<std::pair<VerifyRequest, VerifyCallback>> queue_;
    std::shared_ptr<Active> active_;
    int64_t lastTickMs_ = 0;
};

}  // namespace isg
