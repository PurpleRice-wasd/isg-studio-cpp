#include "single_instance.h"

#include "../util/log.h"
#include "../util/win_util.h"

#include <windows.h>

namespace isg {

namespace {

/* 隐藏的"信箱"窗口。用窗口而不是别的 IPC，是为了：
   · 能被第二个实例按**类名**找到（`FindWindowExW(HWND_MESSAGE, …)`，不能用 EnumWindows）；
   · 能收 WM_COPYDATA 把命令行原样带过来。 */
constexpr wchar_t kMailboxClass[] = L"ISG_STUDIO_SINGLE_INSTANCE_MAILBOX";
constexpr wchar_t kMutexName[] = L"Local\\isg-studio-single-instance-v1";

HANDLE g_mutex = nullptr;          // 拥有者：本进程；**故意不在 release 里关**（见下）
HWND g_mailbox = nullptr;
std::function<void(const std::wstring&)> g_onIncoming;
bool g_registered = false;         // 窗口类注册过没有（收尾时才知道要不要 UnregisterClass）

LRESULT CALLBACK MailboxProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_COPYDATA) {
        auto* cds = reinterpret_cast<COPYDATASTRUCT*>(lp);
        if (cds != nullptr && cds->lpData != nullptr && cds->cbData > 0) {
            // 发过来的就是 UTF-16 文本（第二个实例自己保证），原样还原
            const wchar_t* text = static_cast<const wchar_t*>(cds->lpData);
            const size_t chars = cds->cbData / sizeof(wchar_t);
            std::wstring payload(text, chars);
            // 去掉结尾的 NUL（发送方带上了）
            while (!payload.empty() && payload.back() == L'\0') payload.pop_back();
            if (g_onIncoming) g_onIncoming(payload);
        }
        return TRUE;
    }
    if (msg == WM_CLOSE) {          // 只有我们自己会让它关；收尾靠 release_single_instance
        return 0;
    }
    return ::DefWindowProcW(hwnd, msg, wp, lp);
}

bool send_to_existing(const std::wstring& payload) {
    /* ⚠️ **不能用 `EnumWindows`** 找信箱窗口：它只枚举"屏幕上的顶层窗口"，
       而我们的信箱是 `HWND_MESSAGE` 创建的**消息窗口** —— 两者是不同的东西。
       第一版就是这么写的，结果是：第二个实例永远找不到第一个，
       于是"单实例"等于没做（第二路交叉审查用两进程实验抓到的）。
       正确做法是 `FindWindowExW(HWND_MESSAGE, ...)`：直接在消息窗口那一层找。 */
    HWND target = ::FindWindowExW(HWND_MESSAGE, nullptr, kMailboxClass, nullptr);
    if (target == nullptr) return false;

    COPYDATASTRUCT cds{};
    cds.dwData = 1;                  // 我们自己约定的"这是一条要打开的文件路径"
    cds.cbData = static_cast<DWORD>((payload.size() + 1) * sizeof(wchar_t));
    cds.lpData = const_cast<wchar_t*>(payload.c_str());
    /* SendMessageTimeout 而不是 SendMessage：对方要是卡在一个模态对话框里，
       我们不想陪着它一起卡死。超时了也算"递到了"——第二个实例照样退出，
       否则会出现"两个实例都开着、谁也点不动"。 */
    DWORD_PTR result = 0;
    ::SendMessageTimeoutW(target, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&cds),
                          SMTO_ABORTIFHUNG | SMTO_NORMAL, 3000, &result);
    return true;
}

}  // namespace

bool claim_single_instance(const std::wstring& commandLine) {
    /* Local\ 前缀 = 每个登录会话一把锁。两个用户同时登录、各自跑一份，
       这是允许的（他们各有各的配置目录）；同一个用户连开两次才算重复。 */
    ::SetLastError(ERROR_SUCCESS);
    g_mutex = ::CreateMutexW(nullptr, FALSE, kMutexName);
    if (g_mutex == nullptr) {
        // 建不出互斥体（极端环境）：宁可不做单实例，也不要拒绝启动
        log_warn("建不出单实例互斥体，本次不做单实例检查");
        return false;
    }
    if (::GetLastError() == ERROR_ALREADY_EXISTS) {
        /* 已经有一个实例。把命令行递过去，然后返回 true 让调用方退出。
           ⚠️ 互斥体句柄**故意不关**：我们马上要退出了，关不关都一样，
           而且提前关掉会让"对方刚好也在退出"的窗口里出现第三个实例。 */
        const bool sent = send_to_existing(commandLine);
        if (sent) return true;
        /* 找不到信箱窗口但互斥体在 —— 上一个实例正在退出（或者崩了没退干净）。
           这时候**不能**报错不启动：用户双击图标却什么都没发生是最糟的体验。
           ⚠️ 但也不能"直接 return false 就走"：那样本进程**持有互斥体却不建信箱**，
           后面每一个实例都会命中"有实例 → 找不到信箱 → 照常启动但不建信箱"，
           链条会一直持续到这些进程全部退出（第三路审查在机器上就撞到过这种状态）。
           做法：照常启动，**并且继续往下把自己的信箱建出来**。 */
        log_warn("检测到已有实例，但没找到它的信箱窗口（可能正在退出）；本次照常启动并建自己的信箱");
    }

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &MailboxProc;
    wc.hInstance = ::GetModuleHandleW(nullptr);
    wc.lpszClassName = kMailboxClass;
    if (::RegisterClassExW(&wc) == 0) {
        log_warn("注册单实例信箱窗口类失败（错误码 " + std::to_string(::GetLastError()) + "）");
        return false;
    }
    g_registered = true;
    // HWND_MESSAGE 的窗口不进任务栏、不参与 Alt-Tab，也不会被用户看到
    g_mailbox = ::CreateWindowExW(0, kMailboxClass, L"", 0, 0, 0, 0, 0,
                                  HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    if (g_mailbox == nullptr) {
        log_warn("创建单实例信箱窗口失败（错误码 " + std::to_string(::GetLastError()) + "）");
    }
    return false;
}

void set_incoming_handler(std::function<void(const std::wstring&)> handler) {
    g_onIncoming = std::move(handler);
}

void release_single_instance() {
    if (g_mailbox != nullptr) {
        ::DestroyWindow(g_mailbox);
        g_mailbox = nullptr;
    }
    if (g_registered) {
        ::UnregisterClassW(kMailboxClass, ::GetModuleHandleW(nullptr));
        g_registered = false;
    }
    // 互斥体留给操作系统在进程结束时回收（见 claim_single_instance 里的说明）。
    // 这里只把指针清掉，避免 release 之后还有人去用。
    g_mutex = nullptr;
    g_onIncoming = nullptr;
}

}  // namespace isg
