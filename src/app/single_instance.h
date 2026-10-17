// 单实例。
//
// 与 oracle 的 `app.requestSingleInstanceLock()` + `second-instance` 事件等价，但要多做一件事：
// **第二个实例要把命令行里的文件交给已开的那个**（双击关联文件 / "用…打开" / 拖到图标上）。
//
// oracle 的坑（main.js + pending.js）在这里同样成立，而且必须**两条路一起走**：
//   · 存进 pending（解决"首启时事件比监听器先到"）；
//   · 再推一次事件（覆盖"已经在跑、又拖进来一个"）。
// 只走一条，整条链路就是死的 —— 这是纲领 §7.1 坑 2 的原话。
#pragma once

#include <functional>
#include <string>

namespace isg {

/* 已经有一个实例在跑吗？是的话把 commandLine 交给它，然后本进程**应该立刻退出**。
   返回 true = 我们是被抢跑的那个，调用方直接 return 0。
   必须在创建任何窗口之前调。 */
bool claim_single_instance(const std::wstring& commandLine);

/* 注册"别人递了命令行过来"的回调。由主窗口的消息循环驱动（不需要额外的线程）。 */
void set_incoming_handler(std::function<void(const std::wstring&)> handler);

/* 收尾：销毁那个隐藏窗口。**必须在消息循环结束之后、进程退出之前调**，
   否则窗口过程还挂在已卸载的类上（关得干净这一条不是可选的）。 */
void release_single_instance();

}  // namespace isg
