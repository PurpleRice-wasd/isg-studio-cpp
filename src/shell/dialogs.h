// 系统文件对话框（打开 / 多选 / 选目录 / 另存为）。
//
// **为什么要单开一个线程**：IFileOpenDialog 是模态的，在主线程上 Show() 会把
// WebView2 的消息泵一起挡在门外（页面在整个选文件期间完全冻结，连画都不画）。
// Electron 那边 `dialog.showOpenDialog` 天生是异步的，渲染层的代码是按"对话框期间
// 界面还活着"写的。所以这里在自己的 STA 线程上 Show，owner 仍挂主窗口，
// 结果 PostMessage 回主线程 —— 主线程全程继续跑消息循环。
//
// ⚠️ 这个模块**是泄漏与悬垂指针的高发点**（纲领 §3.3 把"探针窗口"列为同类风险）：
//   · 对话框线程可能比窗口活得久（用户没点就关窗）→ 结果必须由 shared_ptr 持有，
//     绝不能让回调捕获裸 this 或裸 HWND；
//   · 回主线程用的消息里带的是**句柄编号**，不是指针 —— 指针在"窗口已销毁"的竞态里
//     会变成野指针。收尾时 dialogs_shutdown() 会把还在飞行中的结果全部释放。
#pragma once

// 自己带上 windows.h：这个头用了 HWND / UINT / WPARAM。
// 靠"包含方一定先包了 windows.h"是那种"今天能编、明天换个包含顺序就炸"的写法。
#include <windows.h>

#include <functional>
#include <string>
#include <vector>

namespace isg {

enum class DialogKind {
    kOpenMaterials,    // 材料：pptx / ppsx / pdf / txt / md / markdown，**可多选**
    kOpenDirectory,    // 选输出目录
    kOpenImage,        // 图片：png / jpg / jpeg / webp
    kOpenJson,         // 导入设置
    kSaveJson,         // 导出设置
    kOpenHtml,         // 选一份以前生成的学习页（「带上一章」）
};

struct DialogOutcome {
    bool canceled = true;
    std::vector<std::wstring> paths;   // 取消时为空
    std::wstring savePath;             // kSaveJson 用
    std::string error;                 // 非空 = 对话框本身出错（不是"用户取消"）
    std::string defaultName;           // kSaveJson 的默认文件名
};

using DialogCallback = std::function<void(const DialogOutcome&)>;

/* 异步弹一个对话框。回调在**主线程**（消息循环里）被调，恰好一次。
   owner 为 nullptr 时对话框不挂任何窗口（自测环境）。 */
void dialog_show(HWND owner, DialogKind kind, const std::string& defaultName, DialogCallback cb);

/* 主窗口的消息过程要把它转进来。返回 true = 这条消息被吃掉了。 */
bool dialogs_handle_message(UINT msg, WPARAM wp, LPARAM lp);

/* 收尾：释放所有还在飞行中的结果，并**等**对话框线程退出。
   必须在消息循环结束之后、DestroyWindow 之前调（否则线程会往一个正在销毁的窗口投消息）。 */
void dialogs_shutdown();

/* 自测用：把对话框换成脚本化的"用户选择"。 */
void dialogs_set_stub(bool active, std::vector<std::wstring> answer);

}  // namespace isg
