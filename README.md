# 讲练一体工作台 · cpp版（C++ 宿主）

> **2.0.0 · cpp版**（2026-10-17）。宿主是 **C++ / Win32 + 系统 WebView2**；界面、讲义生成
> 逻辑和 skill 内核复用同一份资产。单文件便携版 **3.97 MB**（Electron 1.4.2：127.05 MB），
> 143 页 PDF 抽取 **205 ms**（624 ms，约 3.0 倍）；启动/内存基本持平。
> 配置目录、OSCrypt Key、历史与旁挂 `.isg.json` 与 Electron 1.4.2 双向兼容。

本仓库**只含 C++ 宿主**。Electron 1.4.2 的 oracle 与“金标准/跨实现 Key/PDF 双实现对拍”
这套 monorepo 验证不在本仓库；运行期需要的 `skills/interactive-study-guide` 与
`docs/generation-contract.md` 已随仓库带上。历史验收数字见
[`docs/acceptance-report.md`](docs/acceptance-report.md)（报告开头有独立仓库说明）。

## 这个程序做什么

把一章课件（PPT / PDF）/ 教材交给大模型，生成一个**单文件 HTML** 学习材料：讲解与练习
紧挨着、点选项立刻判分、关键概念配可拖演示、进度自动保存在本地。生成过程是八阶段流水线
（分析 → 切单元 → 出题 → 审题 → 拼装 → 探针校验 → 修复），产物由代码拼装而不是模型直接
吐整页，保证吸顶条、判分引擎与结算区来自同一份骨架。

## 快速开始

环境：Windows 10/11、Visual Studio 2022/2026（C++ 工具链）、WebView2 运行时（Win11 自带）、
Python 3（辅助脚本）。`cmake` / `ninja` 不在全局 PATH 也没关系，`tools/build.ps1` 会
`call vcvars64.bat`。

```powershell
# 1. 取依赖（WebView2 SDK / nlohmann / PDFium / miniz；已存在会跳过）
powershell -File tools\fetch-deps.ps1

# 2. 构建（默认 build；建议用 build3，与文档里的命令一致）
powershell -File tools\build.ps1 -BuildDir build3

# 3. 运行（exe 从自己旁边读 web/、pdfium.dll、docs/generation-contract.md）
.\build3\dist\isg-studio.exe
```

生成契约与 skill 是**运行期从磁盘读**的：开发态 `docs/generation-contract.md` 由构建拷到
`dist/docs/`；skill 在 `skills/interactive-study-guide/`（`skill_dir()` 的开发态回退）。
打包态则读 `<exe>\skill` 与 `<exe>\docs\generation-contract.md`。

## 打包与交付验收

```powershell
# 便携目录 + zip + NSIS 安装版 + 单文件便携版（需要 makensis；没装会明确跳过）
powershell -File tools\package.ps1 -BuildDir build3

# 安装 → 启动 → DPI → 抽取真 PDF → 卸载 → 便携版 → 临时目录清理（31 项）
powershell -File tools\package-acceptance.ps1 `
    -SamplePdf "C:\path\to\某章.pdf" -ExpectedPages 33
```

产物在 `build-package\`：`ISG-Studio-Setup-2.0.0-x64.exe`（安装版）与
`ISG-Studio-Portable-2.0.0-x64.exe`（单文件便携版）。`build-package/` 被 `.gitignore`
排除，**发布时作为 GitHub Release 资产上传**，不要提交进仓库。校验值见
[`docs/SHA256SUMS-2.0.0.txt`](docs/SHA256SUMS-2.0.0.txt)。

## 自测

```powershell
# 基础自测（settings/background/env/key-leak/bridge/protocol/protocol-live/probe/ui）
powershell -File tools\run-selftests.ps1 -Exe build3\dist\isg-studio.exe
```

完整 103 条外层判据还需要 Electron oracle 与真 PDF 样本（原 monorepo 的
`tools/phase1-verify.ps1`），**不在本仓库**；本仓库保留的是 C++ 侧可独立运行的自测与交付验收。
`docs/acceptance-report.md` 记录了 2.0.0 在原 monorepo 上的完整结果。

## 目录

```
src/                     # 宿主：app / shell / bridge / settings / extract / net / pipeline / verify / selftest
web/                     # 渲染层（与 Electron 1.4.2 同一份资产）
skills/interactive-study-guide/   # 运行期 skill 内核（含第三方素材与许可）
docs/
  generation-contract.md # 模型契约（运行期读取）
  architecture.md        # 接口规格（参考）
  acceptance-report.md/.html      # 2.0.0 验收报告（原 monorepo 完成）
  arch-bench.md / evidence/arch-bench.json   # 架构对比口径与数据
  release-notes-2.0.0.md # GitHub Release 文案
  SHA256SUMS-2.0.0.txt   # 发布资产校验值
tools/                   # build / fetch-deps / package / package-acceptance / selftests / 假模型
CMakeLists.txt
VERSION                  # 版本唯一真源（2.0.0）
CHANGELOG.md
LICENSE                  # MIT
```

## 兼容性与数据

- 用户数据在 `%APPDATA%\isg-studio`：设置、Chromium OSCrypt 加密的 Key、历史、背景图、
  旁挂 `.isg.json`。与 Electron 1.4.2 **共用同一份**，不需要迁移；两边可以互相读写。
- 需要 WebView2 运行时；Windows 11 自带，Windows 10 若缺请先安装。
- 页面除使用者自备图片外不请求外部资源；生成结果可以离线打开。

## 已知限制

- 真实模型生成需要自备 API Key 与额度；仓库内自测用假模型/本地服务。
- 未在真实手机/平板上验收生成结果的移动端形态。
- 纲领 §3.5 的六项硬指标未完整复测。
- PDF 逐页相似度 >99% 未达到（不是丢字，公式/表格阅读顺序与 pdfjs 不同）。

## 许可

MIT，见 [`LICENSE`](LICENSE)。`skills/interactive-study-guide/third-party/dafeiyu-pet/`
是内置陪练形象（MIT，原作者许可与出处见该目录）；再分发时保留许可原文。
