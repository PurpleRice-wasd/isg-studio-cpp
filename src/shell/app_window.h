// 主窗口与 WebView2 宿主。
//
// 这个文件承担的是"关得干净"那一条硬要求的主战场：窗口、控制器、webview、环境、
// 事件处理器、对话框线程，每一样都有明确的主人，释放顺序**写死在一处**（Teardown）。
// 用户提的要求原文是"C++ 一定要写好关闭程序，同时尽力避免野指针和内存泄漏"，
// 而这类宿主最典型的事故就是"点了叉，进程还在后台跑"。
//
// 另外两条 Phase 0 换来的实测结论，这里必须继承：
//   · 关闭/遮挡相关的 Chromium 开关（`--disable-features=CalculateNativeWinOcclusion`、
//     `--disable-background-timer-throttling`）**不是可选项**：少了它们，离屏/后台窗口里
//     定时器会被降频甚至冻结，探针轮询直接不落地；
//   · 窗口必须是**可见**的（屏幕外 -32000,-32000），`show:false` 那类折中拿不到真几何信息。
#pragma once

#include "../bridge/bridge.h"
#include "../net/net.h"
#include "../pipeline/jobs.h"
#include "../util/win_util.h"
#include "../verify/probe_runner.h"

#include <memory>

#include <WebView2.h>

#include <functional>
#include <string>

namespace isg {

struct AppWindowOptions {
    /* 自测模式（空 = 正常交互）。
       自测会在页面加载完成后跑一段脚本化的检查，并把结果写进报告。 */
    std::string selftest;
    std::string reportPath;          // 报告落盘（空 = 只打控制台）
    bool offscreen = false;          // 摆到屏幕外（自测用，避免抢焦点）
    int width = 1180;
    int height = 820;
    bool devtools = false;

    /* 金标准对拍（纲领 §4.2）。空路径 = 不跑。
       这三样都是**文件路径**，因为对拍的判据是"盘上两份 HTML 逐字节相同" ——
       把基准与产物都落成文件，比在内存里比更可信：两边都能事后打开看。 */
    std::wstring goldenFixture;
    std::wstring goldenExpected;
    std::wstring goldenActual;

    /* --selftest=pipeline-mock：用哪份材料、往哪个目录产出。
       （模型地址走环境变量 ISG_BASE_URL，因此不需要在这里再传一套。） */
    std::wstring pipelineFixture;
    std::wstring pipelineOut;
    /* --selftest=net-fault：故障服务把收到的每个请求写在这里。 */
    std::wstring netRequests;
    /* Phase 5/6 的 UI 自测：基准页（缺省从 spike/_fixtures 找）。 */
    std::wstring verifyFixture;
    std::wstring bookFixture;
};

class AppWindow {
public:
    AppWindow() = default;
    ~AppWindow();
    AppWindow(const AppWindow&) = delete;
    AppWindow& operator=(const AppWindow&) = delete;

    /* 跑完整条生命周期并返回进程退出码。返回前窗口/webview/COM 全部按序释放。 */
    int Run(HINSTANCE hInst, const AppWindowOptions& opt);

    /* 把"外部要求打开的文件"交给页面（第二个实例 / "用…打开"）。
       ⚠️ 调用方**要自己先存 pending**：光推事件会丢掉"首启时监听器还没挂上"那一路。 */
    void DeliverIncomingFile(const std::wstring& path) { bridge_.DeliverIncomingFile(path); }

    /* 把窗口叫到前台（第二个实例递东西过来时用）。oracle 的 second-instance 也会 restore+focus。 */
    void BringToFront();

private:
    static LRESULT CALLBACK WndProcThunk(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);
    LRESULT WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp);

    bool CreateHostWindow(HINSTANCE hInst);
    void StartEnvironment();
    void OnEnvironmentReady(HRESULT hr, ICoreWebView2Environment* env);
    /* 控制器创建单独抽出来，供启动竞态重试用（重试只在计时器那一拍发，
       绝不在 WebView2 的回调栈上同步重入 —— Phase 1 实测会死锁）。 */
    void StartController();
    void OnControllerReady(HRESULT hr, ICoreWebView2Controller* controller);
    void ConfigureWebView();
    void Navigate();
    void OnNavigationCompleted(HRESULT hr, BOOL success);
    void OnWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args);
    void OnNewWindowRequested(ICoreWebView2NewWindowRequestedEventArgs* args);
    void OnProcessFailed(ICoreWebView2ProcessFailedEventArgs* args);

    void RunSelftest();              // 页面就绪后按 opt_.selftest 跑检查
    void RunUiScript();              // --selftest=ui：在真页面里跑桥的端到端检查
    void RunPipelineScript();        // --selftest=pipeline-mock：真页面 + 真流水线
    void HandlePipelineResult(const Json& payload);
    void RunNetScript();             // --selftest=net-fault：SSE / 降级 / 重试
    void HandleNetResult(const Json& payload);
    void RunCancelScript();          // --selftest=pipeline-cancel：在途取消
    void HandleCancelResult(const Json& payload);
    void RunVerifyScript();          // --selftest=verify：真探针 + demo 读数核对
    void HandleVerifyResult(const Json& payload);
    void RunBookScript();            // --selftest=book：book:* 通道 + carry 的失败路径
    void HandleBookResult(const Json& payload);
    void RunBookE2eScript();         // --selftest=book-e2e：真跑两次，第二次带上一章
    void HandleBookE2eResult(const Json& payload);
    void RunMultiSourceScript();     // --selftest=multi-source：多来源独立分析 + 融合
    void HandleMultiSourceResult(const Json& payload);
    /* 离屏探针窗口（纲领 §5 Phase 1 点名要求的那一个）。
       **独立的 environment + 独立的 user data 目录 + 可见但摆在屏幕外的窗口** ——
       与主窗口完全分开，Phase 5 的探针驱动会在这里跑。现在只做"能开、能加载、能读回 title"。 */
    void StartProbe();
    void OnProbeEnvReady(HRESULT hr, ICoreWebView2Environment* env);
    void OnProbeControllerReady(HRESULT hr, ICoreWebView2Controller* c);
    void OnProbeNavCompleted(BOOL success);
    void OnProbeTitle(HRESULT hr, LPCWSTR json);
    void TeardownProbe();

    /* 把 Bridge ↔ 任务层 ↔ 网络层接上。三处 Attach 之后都要调一次。 */
    void WirePipeline();

    void RunGoldenInject();          // --selftest=golden 第 1 步：注入逻辑 JS
    void RunGoldenSend();            // --selftest=golden 第 2 步：送夹具
    void OnScriptResult(const Json& payload);
    void CompareGolden(const std::string& actualHtml, const Json& extraLines);
    void EmitReport();               // 收尾之后才写报告（teardownMs 那时才是真数）
    void Finish(int exitCode, const char* why = "");
    void Teardown();

    void Report(const std::string& line);        // 往报告里追加一行
    std::string BuildReportJson() const;

    HWND hwnd_ = nullptr;
    HINSTANCE hInst_ = nullptr;
    AppWindowOptions opt_;
    ProcessClock clock_;

    ComPtr<ICoreWebView2Environment> env_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> webview_;
    EventRegistrationToken navStartToken_{};
    EventRegistrationToken navToken_{};
    EventRegistrationToken msgToken_{};
    EventRegistrationToken newWinToken_{};
    EventRegistrationToken procFailToken_{};
    bool navStartHooked_ = false;
    bool navHooked_ = false;
    bool msgHooked_ = false;
    bool newWinHooked_ = false;
    bool procFailHooked_ = false;

    Bridge bridge_;
    JobStore jobs_;
    NetManager net_;
    /* Phase 5：探针窗口。它有自己的 HWND/环境/控制器；桥只把请求转进来。 */
    std::unique_ptr<ProbeRunner> verify_;

    /* 启动竞态：安装完立刻启动时，CreateCoreWebView2Controller 偶发 E_ABORT
       （实测 0.14 秒内失败，隔一会儿重开就正常）。不重试的后果是窗口闪一下就没了。
       重试由 WM_TIMER 驱动，最多 3 次。 */
    bool controllerRetryPending_ = false;
    int controllerRetries_ = 0;
    int64_t controllerRetryAt_ = 0;

    bool teardownDone_ = false;
    bool tearingDown_ = false;
    bool completed_ = false;
    bool userClosed_ = false;      // 用户自己点了叉（与"验证流程异常结束"分开）
    int exitCode_ = 0;

    int64_t tWindow_ = -1;
    int64_t tEnvReady_ = -1;
    int64_t tControllerReady_ = -1;
    int64_t tNavDone_ = -1;
    int64_t tSelftestDone_ = -1;
    int64_t tTeardown_ = -1;

    std::string uiUrl_;              // 我们那一页的 file:// URL（桥的来源判据）
    std::string navError_;
    std::string envError_;
    std::string runtimeVersion_;
    std::vector<std::string> lines_; // 报告正文
    Json selftestResult_ = Json();
    bool selftestRan_ = false;
    bool selftestStarted_ = false;   // 脚本已经发出去过（超时判定只在它之后才有意义）
    int liveStep_ = 0;               // protocol-live 的推进步
    bool liveFirstOk_ = false;
    bool liveNavigated_ = false;
    std::string liveProbeUrl_;
    bool goldenPending_ = false;
    // 探针窗口
    HWND probeHwnd_ = nullptr;
    ComPtr<ICoreWebView2Environment> probeEnv_;
    ComPtr<ICoreWebView2Controller> probeController_;
    ComPtr<ICoreWebView2> probeWebview_;
    EventRegistrationToken probeNavToken_{};
    bool probeNavHooked_ = false;
    std::string probeUrl_;     // 导航完成，等计时器那一拍开始对拍
    int goldenStep_ = 0;             // 0 未开始 / 1 已注入待发夹具 / 2 已发待结果
    int64_t pipelineStartMs_ = 0;    // pipeline-mock 的产物新鲜度基准
};

/* 解析 UI 页面的 file:// URL（<exe 旁>\web\index.html）。找不到返回空串。 */
std::wstring ui_index_path();

}  // namespace isg
