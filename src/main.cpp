// isg-studio —— 讲练一体工作台的 C++ 宿主。
//
// 这个文件的职责只有三件：**解析命令行、决定跑哪条路径、把出口收拾干净**。
// 真正的活儿在 shell / bridge / settings 里。
//
// 出口这件事在本工程里是硬要求（用户原话："C++ 一定要写好关闭程序，
// 同时尽力避免野指针和内存泄漏"）：
//   · 所有需要 COM 的东西都在同一个 STA 公寓里（WebView2 要求 STA）；
//   · 公寓用自己的析构去 CoUninitialize，不靠手写的收尾分支；
//   · Debug 下开 CRT 泄漏检查，并且**先证明检测器会响**（--leak-selftest）再说"没有泄漏"。
#include "app/app.h"
#include "app/pending.h"
#include "shell/protocol.h"
#include "app/single_instance.h"
#include "selftest/selftest.h"
#include "extract/extract.h"
#include "util/json_util.h"
#include "shell/app_window.h"
#include "util/file_ops.h"
#include "util/log.h"
#include "util/str_util.h"
#include "util/win_util.h"

#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <string>
#include <vector>

namespace {

/* COM 公寓的拥有者。放在 main 的栈上，析构时自动 CoUninitialize ——
   这样"提前 return"、"自测失败退出"、"正常收尾"三条路径都不会漏掉反初始化。 */
class Apartment {
public:
    Apartment() { hr_ = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED); }
    ~Apartment() {
        if (SUCCEEDED(hr_)) ::CoUninitialize();
    }
    Apartment(const Apartment&) = delete;
    Apartment& operator=(const Apartment&) = delete;
    bool ok() const { return SUCCEEDED(hr_); }
    HRESULT hr() const { return hr_; }

private:
    HRESULT hr_ = E_FAIL;
};

void usage() {
    isg::console_write(
        "isg-studio —— 讲练一体工作台（C++ 宿主）\n"
        "\n"
        "用法：\n"
        "  isg-studio                          正常启动（单实例）\n"
        "  isg-studio <文件…>                   启动并把文件交给已开的实例\n"
        "  isg-studio --selftest=<名字>         跑一项自测\n"
        "  isg-studio --help                    这份说明\n"
        "\n"
        "自测名字：\n"
        "  settings     设置：显示名修复、外链白名单、信封形状（等价 oracle 的 settings-safety）\n"
        "  background   背景图：导入/替换/移除、失败不丢旧图、设置钳制（等价 background）\n"
        "  env          .env 解析/优先级/叠加/绝不落盘（等价 env-config）\n"
        "  key-leak     Key 不外漏：各种形态的 Key 材料都不许出去（等价 key-leak）\n"
        "  keycompat    用真 Electron 写的 settings.json，本程序要能解开（跨实现兼容）\n"
        "  bridge       31 个通道的登记与「未实现必须明确报错」\n"
        "  protocol     isg:// 的路径形态与白名单（拿越界形态撞自己）\n"
        "  ui           在**真页面**里跑桥的端到端检查（需要起窗口）\n"
        "  verify       真探针 + demo 读数核对（含改坏一页必须报错的反例）\n"
        "  pipeline-repair  演示 checks 被持续写坏时的修复闭环\n"
        "  e2e-mock     真 PDF → 真拼装 → 真探针 → 假模型（需要 --pipeline-fixture 指向 PDF）\n"
        "  book         book:* 通道 + carry 失败路径（真窗口）\n"
        "  book-e2e     两次生成：第二次把第一次的章带进一册\n"
        "  book-data    旁挂数据/章号/连续性的无窗口检查\n"
        "  cleanup      收尾清单与删除护栏\n"
        "\n"
        "常用开关：\n"
        "  --report=<路径>      把结果（JSON）写到这里；同时写一份同名的 .txt 给人看\n"
        "  --user-data=<路径>   顶掉配置目录（自测默认用临时目录，**不碰用户真正的配置**）\n"
        "  --offscreen          把窗口摆到屏幕外（自测用，不抢焦点）\n"
        "  --devtools           允许开发者工具\n"
        "  --leak-selftest      故意漏 4 KB —— 先证明泄漏检测器会响\n");
}

struct Args {
    std::string selftest;
    std::string report;
    std::wstring userData;
    std::wstring goldenFixture;
    std::wstring goldenExpected;
    std::wstring goldenActual;
    std::wstring pipelineFixture;
    std::wstring pipelineOut;
    std::wstring netRequests;
    std::wstring verifyFixture;           // --selftest=verify 的基准页
    std::wstring bookFixture;             // --selftest=book 的基准页
    std::wstring extractPath;             // --extract=<课件>：只跑抽取（无窗口）
    std::wstring extractOut;              // --out=<json>：抽取结果写到哪
    std::vector<std::wstring> files;      // 命令行给的文件（交给已开的实例）
    bool offscreen = false;
    bool devtools = false;
    bool leakSelftest = false;
    bool help = false;
    bool leakReport = false;              // 内部用：本次运行要不要落泄漏报告
    std::wstring leakReportPath;
};

Args parse_args() {
    Args a;
    int argc = 0;
    LPWSTR* argv = ::CommandLineToArgvW(::GetCommandLineW(), &argc);
    if (argv == nullptr) return a;
    for (int i = 1; i < argc; ++i) {
        const std::wstring w(argv[i]);
        const std::string s = isg::to_utf8(w);
        if (s == "--help" || s == "-h" || s == "/?") { a.help = true; }
        else if (s == "--offscreen") { a.offscreen = true; }
        else if (s == "--devtools") { a.devtools = true; }
        else if (s == "--leak-selftest") { a.leakSelftest = true; }
        else if (isg::starts_with(s, "--selftest=")) { a.selftest = s.substr(11); }
        else if (isg::starts_with(s, "--report=")) { a.report = s.substr(9); }
        else if (isg::starts_with(s, "--user-data=")) { a.userData = w.substr(12); }
        else if (isg::starts_with(s, "--golden-fixture=")) { a.goldenFixture = w.substr(17); }
        else if (isg::starts_with(s, "--golden-expected=")) { a.goldenExpected = w.substr(18); }
        else if (isg::starts_with(s, "--golden-actual=")) { a.goldenActual = w.substr(16); }
        else if (isg::starts_with(s, "--pipeline-fixture=")) { a.pipelineFixture = w.substr(19); }
        else if (isg::starts_with(s, "--pipeline-out=")) { a.pipelineOut = w.substr(15); }
        else if (isg::starts_with(s, "--net-requests=")) { a.netRequests = w.substr(15); }
        else if (isg::starts_with(s, "--verify-fixture=")) { a.verifyFixture = w.substr(17); }
        else if (isg::starts_with(s, "--book-fixture=")) { a.bookFixture = w.substr(15); }
        else if (isg::starts_with(s, "--extract=")) { a.extractPath = w.substr(10); }
        else if (isg::starts_with(s, "--out=")) { a.extractOut = w.substr(6); }
        else if (isg::starts_with(s, "--leak-report=")) {
            a.leakReport = true;
            a.leakReportPath = w.substr(14);
        } else if (isg::starts_with(s, "--")) {
            isg::console_write("[用法错误] 不认识的开关：" + s + "\n");
        } else if (!w.empty()) {
            a.files.push_back(w);
        }
    }
    ::LocalFree(argv);
    return a;
}

/* 自测用的临时配置目录：**绝不碰用户真正的配置**。 */
std::wstring make_temp_user_data() {
    wchar_t base[MAX_PATH] = {};
    const DWORD n = ::GetTempPathW(static_cast<DWORD>(std::size(base)), base);
    std::wstring dir = (n > 0) ? std::wstring(base) : std::wstring(L".\\");
    if (!dir.empty() && dir.back() == L'\\') dir.pop_back();
    // 目录名里带 pid：两个自测同时跑也不会互相踩
    dir += L"\\isg-selftest-" + std::to_wstring(::GetCurrentProcessId());
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    return dir;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int) {
    /* Per-Monitor-V2：宿主声明之后，WebView2 才按真实 DPI 渲染；
       否则 200% 缩放下 Windows 会把整个窗口位图拉伸，文字发虚（Electron 原版不发虚）。
       manifest 里已经声明过一次 —— 这里是冗余兜底（清单被剥掉时仍然正确）。
       必须在创建任何窗口之前调用；返回值不用管（清单先生效时这里会返回 FALSE）。 */
    ::SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    isg::attach_parent_console();
    const Args args = parse_args();

    if (args.help) {
        usage();
        return 0;
    }

    // 泄漏检查要在**任何对象构造之前**装好（它靠 CRT 在进程退出时写报告）
    std::string leakStatus;
    if (args.leakReport) {
        leakStatus = isg::enable_leak_check_on_exit(args.leakReportPath);
    }

    Apartment apartment;
    if (!apartment.ok()) {
        isg::console_write("[失败] COM 初始化失败（错误码 "
                           + std::to_string(static_cast<long>(apartment.hr())) + "）\n");
        return 2;
    }

    /* 自测一律用临时配置目录：这些检查会写 settings.json、删背景图、改 .env，
       跑在用户真正的配置目录上就等于用一次自测毁掉他的配置。 */
    if (!args.selftest.empty() && args.userData.empty()) {
        isg::set_user_data_dir(make_temp_user_data());
    } else if (!args.userData.empty()) {
        isg::set_user_data_dir(args.userData);
    }

    if (args.leakSelftest) {
        /* **先证明检测器会响，再去说"没有泄漏"。**
           故意漏 4 KB：报告文件里必须出现这块内存，否则说明检测器根本没装上
           （Ninja 生成器不定义 _DEBUG 那次就是这么被骗过去的）。 */
        /* ⚠️ 必须用 **CRT 自己的分配**（new / malloc）。
           第一版用的是 `HeapAlloc(GetProcessHeap(), ...)` —— 那不属于 CRT 的调试堆，
           CRT 的泄漏检测**根本看不见它**，于是"故意漏了 4 KB"之后报告仍然是空的，
           看起来像"检测器没装上"（真因是"漏的对象不在它的管辖范围里"）。
           这一条恰恰是"先证明检测器会响"要防的那类误判。 */
        char* leak = new char[4096];
        for (int i = 0; i < 4096; ++i) leak[i] = static_cast<char>(i & 0xFF);
        (void)leak;   // 故意不 delete[]：就是要让它漏
        isg::console_write("--leak-selftest：故意漏了 4 KB，报告里应当出现它。\n");
    }

    /* --extract：Phase 2 的对拍入口。不建窗口、不碰 WebView2 ——
       这一条命令同时是自测和"让 C++ 版说出它抽到了什么"的取证工具。 */
    if (!args.extractPath.empty()) {
        isg::Json out;
        isg::ExtractError err;
        isg::ExtractOptions eopt;
        if (!isg::extract_file(args.extractPath, eopt, out, err)) {
            isg::console_write("[抽取失败]" + (err.code.empty() ? std::string() : " " + err.code) + " "
                               + err.message + "\n");
            return 1;
        }
        const std::string text = isg::json_dump(out, 2);
        if (args.extractOut.empty()) {
            isg::console_write(text + "\n");
        } else {
            if (!isg::write_file_bytes(args.extractOut, text)) {
                isg::console_write("[失败] 写不出抽取结果：" + isg::to_utf8(args.extractOut) + "\n");
                return 1;
            }
        }
        return 0;
    }

    /* ui 与 golden 都要**起窗口**（前者要真渲染层，后者要一个 WebView2 来跑搬过来的 JS）；
       其余自测是无窗口的，跑完就退。 */
    const bool needsWindow = (args.selftest == "ui" || args.selftest == "golden"
                              || args.selftest == "protocol-live" || args.selftest == "probe"
                              || args.selftest == "pipeline-mock" || args.selftest == "net-fault"
                              || args.selftest == "pipeline-cancel" || args.selftest == "all"
                              || args.selftest == "verify" || args.selftest == "book"
                              || args.selftest == "book-e2e" || args.selftest == "pipeline-repair"
                              || args.selftest == "e2e-mock" || args.selftest == "multi-source");
    if (!args.selftest.empty() && !needsWindow) {
        // 无窗口的自测：不开窗口、不建 webview
        const std::wstring report = args.report.empty() ? std::wstring() : isg::to_wide(args.report);
        const int code = isg::selftest_run_headless(args.selftest, report);
        if (!leakStatus.empty()) isg::console_write(leakStatus);
        return code;
    }

    // 正常启动（或 --selftest=ui）
    isg::AppWindow app;
    if (args.selftest.empty()) {
        /* 单实例只在**正常启动**时做。自测要并行跑，被单实例挡住就全废了。 */
        /* 递过去的**就是一条文件路径**（argv 已经拆好），不是拼起来的命令行 ——
           拼命令行再用 CommandLineToArgvW 解析会把带空格的路径拆坏
           （`C:\Users\me\My Documents\a.pdf` 会变成两段）。没有文件时递空串，
           对方收到之后只把窗口提到前台。 */
        const std::wstring firstFile = args.files.empty() ? std::wstring() : args.files[0];
        if (isg::claim_single_instance(firstFile)) {
            isg::console_write("已经有一个实例在跑，命令行已交给它。\n");
            return 0;
        }
        /* 首启那一路：命令行里的文件**先存 pending**。
           渲染层就绪后会主动来取（app:takePendingFile）—— 只推事件会丢掉它，
           因为事件比渲染层的监听器更早发出（纲领 §7.1 坑 2）。 */
        for (const std::wstring& f : args.files) {
            if (isg::stat_path(f).isFile) isg::pending_set(f);
        }
        /* 第二个实例递过来的命令行：这里**两条路一起走**（存 pending + 推事件）。 */
        isg::set_incoming_handler([&app](const std::wstring& incoming) {
            /* 收到的**就是一条路径**（见上）。两条路一起走（纲领 §7.1 坑 2）：
               存 pending 覆盖"首启"、推事件覆盖"已经在跑"。 */
            if (incoming.empty() || !isg::stat_path(incoming).isFile) {
                app.BringToFront();      // 没带文件也要把窗口叫出来
                return;
            }
            /* ⚠️ 必须**在这里**放行：拖拽/关联打开都不经文件对话框，
               不放行的话后面的预览与抽取会被 isg:// 白名单拒掉（oracle 的 openIncoming 同样先 allow）。 */
            isg::log_info("收到第二个实例递过来的文件：" + isg::to_utf8(isg::file_name(incoming)));
            isg::protocol_allow(incoming);
            isg::pending_set(incoming);
            app.DeliverIncomingFile(incoming);
            app.BringToFront();
        });
    }

    isg::AppWindowOptions opt;
    opt.selftest = args.selftest;
    opt.goldenFixture = args.goldenFixture;
    opt.goldenExpected = args.goldenExpected;
    opt.goldenActual = args.goldenActual;
    opt.pipelineFixture = args.pipelineFixture;
    opt.pipelineOut = args.pipelineOut;
    opt.netRequests = args.netRequests;
    opt.verifyFixture = args.verifyFixture;
    opt.bookFixture = args.bookFixture;
    opt.reportPath = args.report;
    opt.offscreen = args.offscreen || !args.selftest.empty();
    opt.devtools = args.devtools;

    const int code = app.Run(hInst, opt);

    if (args.selftest.empty()) isg::release_single_instance();
    if (!leakStatus.empty()) isg::console_write(leakStatus);
    return code;
}
