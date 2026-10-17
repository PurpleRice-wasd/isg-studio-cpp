// "外部要求打开的文件"（拖到图标上 / 双击关联文件 / 命令行带上 / 第二个实例递过来的）。
// 对应 oracle 的 src/main/pending.js。
//
// 为什么要"存一份 + 取一次"这个看似多余的机制（oracle 的注释说得很清楚）：
// 首启那一路，事件**比渲染层的监听器更早**发出 —— 光推事件会丢掉它。
// 所以两条路一起走：
//   · 存进 pending（渲染层就绪后主动调 `app:takePendingFile` 取走）；
//   · 再推一次事件（覆盖"已经在跑、又拖进来一个"）。
// **只走一条，整条链路就是死的。**
#pragma once

#include <string>

namespace isg {

void pending_set(const std::wstring& path);

/* 取走并清空。没有则返回空串。 */
std::wstring pending_take();

/* 从一条命令行里挑出"第一个真实存在的文件"。
   第二个实例递过来的是**原样的命令行文本**（可能带引号、可能有好几个参数），
   而我们要的是那个文件。挑不到返回空串（调用方就当没收到，别硬发一个不存在的路径）。 */
std::wstring first_existing_file(const std::wstring& commandLine);

}  // namespace isg
