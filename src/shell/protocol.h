// `isg://local/<路径分段>` —— 用自定义标准协议把磁盘上的 HTML 喂给窗口 / iframe，替代 file://。
// 对应 oracle 的 src/main/preview.js。
//
// 为什么不用 file://（oracle 的结论，照抄）：
//   · Chromium 里 file:// 是 opaque origin（origin = "null"）→ localStorage / IndexedDB 不可靠，
//     而生成的学习页**正是靠 localStorage 存进度的**；
//   · 同源判断不可预期 → 预览 iframe、相对路径图片（陪练图 / 背景图）行为不稳定。
//
// 安全：只服务**显式放行过的目录**下的文件；其余一律 403。
//
// 【Phase 1 的一次显式决策 —— 纲领 §5 遗留 1 要求"Phase 1 前决策一次"】
//   oracle 用自定义标准协议（`isg://`）→ 处理器没挂上时请求**根本没地方去**，是 **fail-closed**；
//   Phase 0 的 spike 用的是 `https://isg.local/`（真实 scheme + 可解析域名）→ 处理器一旦没挂上，
//   请求会真的走网络，是 **fail-open**。
//   这里选**自定义协议**，两个理由：
//     ① fail-closed 与本项目"宁可明确失败，不要静默走错分支"的信条一致；
//     ② 渲染层的 `previewUrl` / iframe / `<img src>` 本来就按 `isg://` 写的，
//        换 scheme 等于为了 spike 的临时形态去改渲染层（§4.3 要求那种改动逐条记账，不值得）。
//   ⚠️ Phase 0 的教训**仍然成立且必须复用**：`SetVirtualHostNameToFolderMapping` 服务出来的
//   文档请求不会触发 WebResourceRequested（那次 CSP 从来没挂上去，而页面照样渲染、探针照样跑绿）。
//   自定义 scheme 的请求**必须**由我们服务（没有别的出路），但"必须"是推理，不是实测 ——
//   所以判据看的是**结果**：`docResponseServed > 0`（文档真的由我们送出）。
#pragma once

#include "../util/win_util.h"

#include <WebView2.h>

#include <string>
#include <vector>

namespace isg {

/* 在创建环境**之前**把自定义 scheme 登记到环境选项上（只能做一次）。 */
bool protocol_register_scheme(ICoreWebView2EnvironmentOptions* options);

/* 控制器就绪之后挂请求处理器。**必须在导航之前调**。 */
bool protocol_install(ICoreWebView2* webview);

/* 把某个目录（或某个文件所在的目录）加入允许清单。
   ⚠️ **只应该发生在"用户真的选了这个位置"的那几个入口**
   （文件对话框 / registerPath / 输出目录），不要在 urlFor 里顺手放行 ——
   oracle 踩过：那样一次 `urlFor` 就能把整个目录变成可读区，
   而模型产出的页面与这些文件同源，它 fetch 得到的东西跟着一起扩大。 */
void protocol_allow(const std::wstring& target);

/* 这个绝对路径允许被 isg:// 服务吗？（词法一遍 + 真实路径一遍，见 .cpp 里的说明） */
bool protocol_is_allowed(const std::wstring& absPath);

/* URL → 磁盘路径，**并且做形态检查**。失败返回 false 并把原因写进 why。
 *
 * 单独把它拎成公开函数，是为了让**安全边界可以脱离浏览器被撞一遍**：
 * 越界形态（编码穿越、NTFS 数据流、UNC、设备路径、根相对）全都能在自测里
 * 拿字符串直接打，不需要真的起一个 webview。
 * 这个项目对安全边界的原话是"不自己撞一遍，就等于没验过"——而"只能通过
 * 一次真实的页面请求去撞"会让这条判据昂贵到没人跑。 */
bool protocol_disk_path_from_url(const std::string& url, std::wstring& disk, std::string& why);

/* 磁盘绝对路径 → isg:// URL。**纯格式化，不放行任何东西。** */
std::string protocol_url_for(const std::wstring& absPath);

void protocol_reset();

/* ---------- 判据要的数字（报告里写它们，而不是写"我认为它生效了"） ---------- */
struct ProtocolStats {
    int schemesRegistered = 0;      // 登记了几个自定义 scheme
    int wrcAll = 0;                 // WebResourceRequested 一共被调了多少次（不限类型）
    int docRequestSeen = 0;         // 命中"我们这一页"的文档请求次数
    int docResponseServed = 0;      // 成功 put_Response 的次数
    int docBytesServed = 0;         // 喂进去的字节数
    bool cspHeaderSent = false;     // CSP 响应头**真的挂上过**
    int deniedCount = 0;            // 被白名单挡下的请求数（安全边界的直接证据）
    std::string deniedSample;       // 被挡下的路径样本
    std::string lastDocUrl;         // 最后一次服务的文档 URL
    HRESULT filterHr = E_FAIL;      // AddWebResourceRequestedFilter 的返回码
};
const ProtocolStats& protocol_stats();

}  // namespace isg
