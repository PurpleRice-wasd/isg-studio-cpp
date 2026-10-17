// 系统外壳动作：用默认程序打开 / 在资源管理器里定位 / 在浏览器里打开网址。
//
// 安全边界在 bridge 那一层（扩展名白名单、只放 http/https、路径必须在放行目录里），
// 这里只负责"真的去调系统"。**分成两层是刻意的**：边界判断是可测的纯逻辑，
// 而这几个函数会真的弹窗口/开浏览器 —— 自测要能把它们换成记账版（oracle 的
// settings-safety.js 就是这么做桩的，那次不桩的代价是"跑一趟自测在用户机器上
// 真的弹了两个浏览器标签页"）。
#pragma once

#include <string>

namespace isg {

/* 用系统默认程序**执行**一个文件。失败时 err 里是可读原因。 */
bool shell_open_path(const std::wstring& path, std::string& err);

/* 在资源管理器里选中这个文件。 */
bool shell_reveal_path(const std::wstring& path, std::string& err);

/* 在系统浏览器里打开一个 **http / https** 网址（调用方必须已经判过 scheme）。 */
bool shell_open_external(const std::string& url, std::string& err);

/* 把网址规范化成 `new URL(u).toString()` 的结果（补尾斜杠、转义路径……）。
   失败返回 false 并把原因写进 err。
   ⚠️ 为什么非要它：oracle 的 settings-safety.js 有一条判据钉住
   "被放行的那两条确实调了 openExternal，**而且参数就是那个网址**"，
   期望值是 `https://www.deepseek.com/`（带尾斜杠）—— 规范化是 URL 规范的要求，
   不是我们加的花样；自测的期望值就建立在这上面。 */
bool normalize_url(const std::string& raw, std::string& out, std::string& err);

/* 自测用的替换点：把这三个动作换成记账版（**默认是真的去调系统**）。 */
struct ShellStub {
    bool active = false;
    // 每次被调用时记一条（"openExternal:<url>" / "openPath:<path>" / "revealPath:<path>"）
    void (*record)(const std::string& what);
};
void shell_set_stub(const ShellStub& stub);

}  // namespace isg
