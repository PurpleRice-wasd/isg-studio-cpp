# 更新记录

## 2.0.0 · cpp版（2026-10-17）

首个 **C++ 宿主**版本：把 Electron 换成 **C++ / Win32 + 系统 WebView2**，界面与生成逻辑
继续复用同一份 `web/` 资产与 skill 内核。Electron 版停在 1.4.2，保留为迁移与逐字节对拍的
oracle，不随本版本升级。

### 架构与交付

- **宿主**：C++20 + Win32 + WebView2；单实例、主窗口 + 离屏探针窗口、`isg://` 协议与 CSP
  白名单；关闭顺序与 COM/句柄所有权按 RAII 收口。
- **交付形态**（与 Electron 原档同名）：
  - `ISG-Studio-Setup-2.0.0-x64.exe`：按当前用户安装到
    `%LOCALAPPDATA%\Programs\isg-studio`，建桌面/开始菜单快捷方式与卸载项；
  - `ISG-Studio-Portable-2.0.0-x64.exe`：单文件，解到 `%TEMP%` 运行，退出后连空目录一起清掉。
- **体积**（同机实测）：单文件便携版 **3.97 MB**（Electron 1.4.2：127.05 MB，约 1/32）；
  安装目录 **11.32 MB**（Electron：444.12 MB，约 1/39）。
- **PDF 抽取**：同一份 143 页 PDF，PDFium **205 ms**（pdfjs 624 ms，约 3.0 倍）。
- **启动/内存**：热启动 UI 就绪 654 ms（Electron 567 ms）、进程树私有内存 96.0 MB
  （Electron 91.3 MB）——**基本持平**，不要拿“窗口更早出现”当启动优势
  （C++ 先显示的是空壳，Electron 是渲染好才显示）。

### 本次验收修掉的问题

- **高 DPI 发虚**：本机 200% 缩放，原 exe 没有 DPI 感知声明，Windows 会位图拉伸整个窗口。
  已补 `PerMonitorV2` 清单、`VERSIONINFO`、`WM_DPICHANGED`，并按 `GetDpiForSystem()`
  把 DIP 尺寸换算成物理像素。
- **安装后立刻启动的控制器竞态**：`CreateCoreWebView2Controller` 偶发 `E_ABORT`
  （0x80004004）。现在失败后由 100 ms 计时器在下一拍重试，最多 3 次（0.4/0.8/1.2 秒）；
  重试分支用临时强制失败钩子验证过，钩子已删除。
- **便携版静默不启动**：NSIS `SilentInstall silent` 下没有显式 `InitPluginsDir`，
  启动器曾返回 0 却什么都不做；已修。
- **卸载残留空目录**：卸载器从安装目录启动时 CWD 就是安装目录，Windows 不允许删当前目录；
  卸载段先 `SetOutPath "$TEMP"`，并保留 `%APPDATA%\isg-studio` 里的用户数据。

### 兼容性

- 与 Electron 1.4.2 共用 `%APPDATA%\isg-studio`：设置格式、Chromium OSCrypt 加密的 Key、
  历史、背景图与旁挂 `.isg.json` 双向可读（Electron 写 → C++ 读、C++ 写 → Electron 读）。
- 渲染层 `web/` 与 Electron 版逐字节一致；金标准拼装 157557 字节逐字节相同。
- 运行期仍从磁盘读取 `skill/` 与 `docs/generation-contract.md`，不内联。

### 验证

- 外层判据 **103/103，0 跳过，0 `[BAD]`**（含真 PDF 抽取对拍、金标准、跨实现 Key、
  Debug CRT 泄漏检查、真 WebView2 探针、书册/清理/多来源）。
- 交付验收 **31/31**：静默安装 → 启动 → DPI → 抽取真 PDF → 卸载 → 便携版 → 临时目录清理。
- 架构对比口径与原始数据：[`docs/arch-bench.md`](docs/arch-bench.md) /
  [`docs/evidence/arch-bench.json`](docs/evidence/arch-bench.json)。

### 已知限制

- 真实模型 API 生成需要自备 Key 与额度；仓库内的 `e2e-mock` 走假模型验证全链路。
- 没有在真实手机/平板上验收生成结果的移动端形态；无头探针只覆盖静态与 DOM 口径。
- 纲领 §3.5 的六项硬指标未完整复测（内存/安装包体积/冷热启动的完整对照）。
- PDF 逐页相似度 >99% 未达到（Phase 2 已记账）：不是丢字，公式/表格阅读顺序与 pdfjs 不同。

### 升级说明

- 直接运行便携版即可；安装版与 Electron 版共用同一份用户配置，不需要迁移设置或 Key。
- 需要 **WebView2 运行时**（Windows 11 自带；Windows 10 若缺请先安装）。
- 安装版与 Electron 1.4.2 若都装在 `%LOCALAPPDATA%\Programs\isg-studio`，建议先卸载旧版
  或选择不同目录，避免文件互相覆盖。
