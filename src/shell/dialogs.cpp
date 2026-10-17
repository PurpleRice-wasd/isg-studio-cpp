#include "dialogs.h"

#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>
#include <shobjidl.h>
#include <objbase.h>

#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <thread>

namespace isg {

namespace {

/* 主线程收"对话框完事了"的自定义消息。WM_APP 之上随便挑一个，
   与其它 WM_APP 用法（目前没有）错开。 */
constexpr UINT kMsgDialogDone = WM_APP + 17;

struct Pending {
    DialogOutcome outcome;
    DialogCallback cb;
    std::shared_ptr<std::atomic<bool>> finished;   // 线程与收尾共享的"别再等了"
};

std::mutex g_mutex;
std::map<int, std::shared_ptr<Pending>> g_pending;
int g_nextToken = 1;

/* 还活着的对话框线程。收尾时要逐个 join —— 不 join 的话
   "进程退出时还有一个线程在跑"，正是"关得干净"要防的。 */
/* 线程 + 它的"干完了没有"标志。
   ⚠️ 第一版只存 `std::thread`，于是每弹一次对话框就留下一个 joinable 的线程对象 ——
   线程早就跑完了，但**线程句柄不关**，只增不减（第三路审查点出来的）。
   现在每次 `dialog_show` 进来先把已完成的 join 掉。 */
struct Worker { std::thread t; std::shared_ptr<std::atomic<bool>> done; };
std::vector<Worker> g_threads;

/* 回收已完成的 worker。**锁只用来搬运，join 放在锁外** ——
   持锁 join 会和 worker 里偶尔要拿 `g_mutex` 的路径形成死锁。 */
void reap_workers() {
    std::vector<Worker> finished;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        for (auto it = g_threads.begin(); it != g_threads.end();) {
            if (it->done && it->done->load()) {
                finished.push_back(std::move(*it));
                it = g_threads.erase(it);
            } else {
                ++it;
            }
        }
    }
    for (Worker& w : finished) if (w.t.joinable()) w.t.join();
}

bool g_stubActive = false;
std::vector<std::wstring> g_stubAnswer;

/* 打开对话框时用的过滤器。全部与 oracle 的 ipc.js 逐条对应 ——
   用户看到的"文件类型"下拉框内容变了，是这个应用最容易被察觉的界面变化之一。 */
void apply_filters(IFileDialog* dlg, DialogKind kind) {
    const COMDLG_FILTERSPEC materials[] = {
        {L"材料", L"*.pptx;*.ppsx;*.pdf;*.txt;*.md;*.markdown"},
        {L"PowerPoint", L"*.pptx;*.ppsx"},
        {L"PDF", L"*.pdf"},
        {L"文本", L"*.txt;*.md;*.markdown"},
        {L"全部文件", L"*.*"},
    };
    const COMDLG_FILTERSPEC images[] = {
        {L"图片", L"*.png;*.jpg;*.jpeg;*.webp"},
        {L"全部文件", L"*.*"},
    };
    const COMDLG_FILTERSPEC jsons[] = {
        {L"JSON", L"*.json"},
        {L"全部文件", L"*.*"},
    };
    /* 「带上一章」的出口就是一份学习页：只留 html，放开别的类型只会让用户选错文件。 */
    const COMDLG_FILTERSPEC htmls[] = {
        {L"学习页 HTML", L"*.html;*.htm"},
        {L"全部文件", L"*.*"},
    };
    switch (kind) {
        case DialogKind::kOpenMaterials:
            dlg->SetFileTypes(static_cast<UINT>(std::size(materials)), materials);
            break;
        case DialogKind::kOpenImage:
            dlg->SetFileTypes(static_cast<UINT>(std::size(images)), images);
            break;
        case DialogKind::kOpenJson:
        case DialogKind::kSaveJson:
            dlg->SetFileTypes(static_cast<UINT>(std::size(jsons)), jsons);
            break;
        case DialogKind::kOpenHtml:
            dlg->SetFileTypes(static_cast<UINT>(std::size(htmls)), htmls);
            break;
        case DialogKind::kOpenDirectory:
            break;
    }
}

/* **真正的对话框调用，跑在 worker 的 STA 线程上。** */
DialogOutcome run_dialog(HWND owner, DialogKind kind, const std::string& defaultName) {
    DialogOutcome out;
    out.defaultName = defaultName;

    /* 线程自己的 COM 公寓。IFileDialog 是 **STA** 组件，MTA 上创建会直接失败；
       而 worker 线程默认是未初始化的（不是继承主线程的 STA）。 */
    const HRESULT hrInit = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool needUninit = SUCCEEDED(hrInit);

    IFileDialog* dlg = nullptr;
    HRESULT hr = E_FAIL;
    const CLSID clsid = (kind == DialogKind::kSaveJson) ? CLSID_FileSaveDialog : CLSID_FileOpenDialog;
    hr = ::CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dlg));
    if (FAILED(hr) || dlg == nullptr) {
        out.error = "创建系统文件对话框失败（错误码 " + std::to_string(hr) + "）";
        if (needUninit) ::CoUninitialize();
        return out;
    }

    DWORD flags = 0;
    dlg->GetOptions(&flags);
    flags |= FOS_FORCEFILESYSTEM;      // 只要文件系统里的东西（不要"库/网络位置"的虚拟项）
    flags |= FOS_NOCHANGEDIR;          // 别把进程的当前目录改掉（宿主里到处是相对路径回退）
    switch (kind) {
        case DialogKind::kOpenMaterials:
            // 一次能选多份：真题通常好几份，一份份点太折磨人
            flags |= FOS_ALLOWMULTISELECT;
            break;
        case DialogKind::kOpenDirectory:
            flags |= FOS_PICKFOLDERS;
            break;
        case DialogKind::kSaveJson:
            flags |= FOS_OVERWRITEPROMPT;
            break;
        default:
            break;
    }
    dlg->SetOptions(flags);
    apply_filters(dlg, kind);

    switch (kind) {
        case DialogKind::kOpenMaterials: dlg->SetTitle(L"选择材料"); break;
        case DialogKind::kOpenDirectory: dlg->SetTitle(L"选择输出目录"); break;
        case DialogKind::kOpenImage:     dlg->SetTitle(L"选一张背景图（会复制一份到工作台的配置目录）"); break;
        case DialogKind::kOpenJson:      dlg->SetTitle(L"导入设置"); break;
        case DialogKind::kSaveJson:      dlg->SetTitle(L"导出设置"); break;
        case DialogKind::kOpenHtml:      dlg->SetTitle(L"选择以前生成的学习页"); break;
    }
    if (!defaultName.empty()) dlg->SetFileName(to_wide(defaultName).c_str());

    /* 挂 owner：主窗口会被系统禁用（应用模态），但**主线程照样在跑消息循环**，
       所以界面不会被冻住 —— 这正是"对话框另起一个线程"要换来的东西。 */
    hr = dlg->Show(owner);
    if (hr == HRESULT_FROM_WIN32(ERROR_CANCELLED)) {
        out.canceled = true;
        dlg->Release();
        if (needUninit) ::CoUninitialize();
        return out;
    }
    if (FAILED(hr)) {
        out.error = "系统文件对话框出错（错误码 " + std::to_string(hr) + "）";
        dlg->Release();
        if (needUninit) ::CoUninitialize();
        return out;
    }

    if (kind == DialogKind::kSaveJson) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(dlg->GetResult(&item)) && item != nullptr) {
            PWSTR p = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p != nullptr) {
                out.savePath.assign(p);
                ::CoTaskMemFree(p);
                out.canceled = false;
            }
            item->Release();
        }
    } else {
        /* `GetResults` 挂在 **IFileOpenDialog** 上，不在 IFileDialog 上 ——
           基础接口只有单选的 GetResult。多选是打开对话框特有的能力。 */
        IFileOpenDialog* open = nullptr;
        if (FAILED(dlg->QueryInterface(IID_PPV_ARGS(&open))) || open == nullptr) {
            out.error = "拿不到多选界面（IFileOpenDialog 查询失败）";
            dlg->Release();
            if (needUninit) ::CoUninitialize();
            return out;
        }
        IShellItemArray* items = nullptr;
        if (SUCCEEDED(open->GetResults(&items)) && items != nullptr) {
            DWORD count = 0;
            items->GetCount(&count);
            for (DWORD i = 0; i < count; ++i) {
                IShellItem* item = nullptr;
                if (FAILED(items->GetItemAt(i, &item)) || item == nullptr) continue;
                PWSTR p = nullptr;
                if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &p)) && p != nullptr) {
                    out.paths.emplace_back(p);
                    ::CoTaskMemFree(p);
                }
                item->Release();
            }
            items->Release();
            out.canceled = out.paths.empty();
        }
        open->Release();
    }

    dlg->Release();
    if (needUninit) ::CoUninitialize();
    return out;
}

}  // namespace

void dialogs_set_stub(bool active, std::vector<std::wstring> answer) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_stubActive = active;
    g_stubAnswer = std::move(answer);
}

void dialog_show(HWND owner, DialogKind kind, const std::string& defaultName, DialogCallback cb) {
    reap_workers();
    bool stubActive = false;
    std::vector<std::wstring> stubAnswer;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        stubActive = g_stubActive;
        stubAnswer = g_stubAnswer;
    }

    if (stubActive) {
        DialogOutcome out;
        out.canceled = stubAnswer.empty();
        out.paths = stubAnswer;
        if (kind == DialogKind::kSaveJson && !out.paths.empty()) out.savePath = out.paths[0];
        out.defaultName = defaultName;
        /* 没有窗口时**直接回调**：这里没有"界面要保活"这回事，
           而绕一圈 PostMessage 到 null 窗口只会让回答永远到不了（自测就白测了）。
           有窗口时仍然走真回程（令牌 + 消息），因为渲染层是按"对话框期间界面还活着"写的，
           同步回调会让那些"先禁用按钮再恢复"的代码路径在自测里走不到。 */
        if (owner == nullptr) {
            if (cb) cb(out);
            return;
        }
        {
            const DialogCallback cb2 = cb;
            const HWND h = owner;
            auto doneFlag = std::make_shared<std::atomic<bool>>(false);
            g_threads.push_back(Worker{std::thread([cb2, out, h, doneFlag]() {
                /* 走和真对话框同一条回程（令牌 + 消息），而不是直接调 cb2 ——
                   那样自测验证的就不是真实的那条路径了。 */
                auto p = std::make_shared<Pending>();
                p->outcome = out;
                p->cb = cb2;
                p->finished = std::make_shared<std::atomic<bool>>(true);
                int token = 0;
                {
                    std::lock_guard<std::mutex> lock2(g_mutex);
                    token = g_nextToken++;
                    g_pending[token] = p;
                }
                if (h == nullptr || !::PostMessageW(h, kMsgDialogDone, static_cast<WPARAM>(token), 0)) {
                    std::lock_guard<std::mutex> lock2(g_mutex);
                    g_pending.erase(token);
                }
                doneFlag->store(true);
            }), doneFlag});
            return;
        }
    }

    /* 没有桩、也没有窗口：**明确失败，绝不弹一个没人能点的模态框**。
       IFileDialog::Show(nullptr) 在无人值守的场景（自测、CI）里就是永久挂住 ——
       进程不退、也没人知道为什么。理由写进 error，不是静默返回"用户取消"。 */
    if (owner == nullptr) {
        DialogOutcome out;
        out.canceled = true;
        out.error = "没有窗口可挂，弹不了系统对话框（自测里请用 dialogs_set_stub）";
        if (cb) cb(out);
        return;
    }

    auto pending = std::make_shared<Pending>();
    pending->cb = std::move(cb);
    pending->finished = std::make_shared<std::atomic<bool>>(false);

    int token = 0;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        token = g_nextToken++;
        g_pending[token] = pending;
    }

    /* 线程把结果填进 pending，再把**令牌**投回主线程。
       ⚠️ 投的是令牌不是指针：窗口可能在投出去之后就被销毁，
       那条消息会被丢弃 —— 而如果投的是指针，主线程就再也拿不到它，
       那块内存永远漏着（正是"关得干净"要防的）。 */
    /* ⚠️ 投递目标是**调用时那个 owner**，不是 `GetActiveWindow()`：
       GetActiveWindow 给的是"调用线程的活动窗口"，而这是另一个线程 ——
       它要么是空的，要么是刚关掉的那个对话框自己，消息会投到不存在的地方去。 */
    g_threads.push_back(Worker{std::thread([owner, kind, defaultName, pending, token]() {
        DialogOutcome out = run_dialog(owner, kind, defaultName);
        pending->outcome = std::move(out);
        pending->finished->store(true);
        if (owner == nullptr || !::PostMessageW(owner, kMsgDialogDone, static_cast<WPARAM>(token), 0)) {
            /* 主窗口没了 → 没人来收。直接了结：shared_ptr 走完最后一个引用就释放，不留悬垂。 */
            log_warn("对话框结果没人接收（主窗口已销毁），已直接释放");
            std::lock_guard<std::mutex> lock(g_mutex);
            g_pending.erase(token);
        }
        pending->finished->store(true);   // 让下一次 dialog_show 能把它回收掉
    }), pending->finished});
}

bool dialogs_handle_message(UINT msg, WPARAM wp, LPARAM lp) {
    (void)lp;
    if (msg != kMsgDialogDone) return false;
    std::shared_ptr<Pending> pending;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_pending.find(static_cast<int>(wp));
        if (it == g_pending.end()) return true;      // 已经被收尾清掉了
        pending = it->second;
        g_pending.erase(it);
    }
    if (pending->cb) pending->cb(pending->outcome);
    return true;
}

void dialogs_shutdown() {
    /* 顺序：先等所有对话框线程退出（它们在等用户点按钮，窗口一关它们自己会回来），
       再清掉飞行中的结果。反过来做会让主线程删掉线程还在写的那份内存。 */
    std::vector<Worker> workers;
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        workers.swap(g_threads);
    }
    for (Worker& w : workers) {
        if (w.t.joinable()) w.t.join();
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    g_pending.clear();
}

}  // namespace isg
