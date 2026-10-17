# Electron 1.4.2 vs C++ 2.0.0：架构对比实测

> 目的：回答“把宿主从 Electron 换成 C++/WebView2，到底带来了什么提升”。
>
> **结论先说**：最大收益是**分发体积**（约 32–39 倍）和 **PDF 抽取速度**（约 3 倍）；
> 启动到 UI 就绪、内存与 Electron **基本持平**，不要拿“窗口更早出现”当成启动更快——
> C++ 先显示的是空壳，Electron 是渲染好才显示。

## 环境与口径

- 机器：Intel i7-14650HX / 15.7 GB / Windows 11 家庭中文版 / **192 DPI（200%）** /
  WebView2 运行时 155.0.4283.60。
- Electron：`apps/isg-studio/dist/win-unpacked/ISG-Studio.exe`（1.4.2，打包态，非开发态）。
- C++：`build3/dist/isg-studio.exe`（2.0.0，与安装包同源）。
- **启动主指标**：进程创建 → UIA（UI Automation）在页面里找到「工作台」文字。
  另报“主窗口可见”作为参考。C++ 的窗口先于页面出现（白壳），只看窗口可见会高估 C++。
- **冷/热**：C++ 冷启动用 `ISG_USER_DATA` 指向全新临时 profile；热启动两边都用真实的
  `%APPDATA%\isg-studio`（日常打开状态）。Electron 的 userData 被应用钉死在该目录，
  `APPDATA` 环境变量覆盖不了，所以 Electron **只测热启动**，不伪造冷启动。
- **内存**：UIA 就绪后再等 2 秒，递归汇总根进程整棵进程树的 Private Working Set /
  Working Set；第三方浏览器进程也计入。
- **抽取**：同一份 143 页 PDF（`数字图像处理——图像增强-xh.pdf`）；C++ 走 PDFium，
  Electron 走 pdfjs（node 调 oracle 的抽取模块）。各 3 次取中位数。
- **体积**：单文件便携版 exe；安装目录 = 递归文件字节和。
- 脚本：原 monorepo 的 `tools/bench-compare.ps1`（本独立仓库不含 Electron oracle，故未收录）；
  原始数据：[`evidence/arch-bench.json`](evidence/arch-bench.json)（归档副本；
  脚本运行时写到 `_verify-out/arch-bench.json`，该目录不提交）。
- 机器不是独占的；数字用于**同机同轮的相对比较**，不是绝对性能承诺。

## 结果（中位数）

| 指标 | Electron 1.4.2 | C++ 2.0.0 | 变化 |
|---|---:|---:|---|
| 热启动：窗口可见 | 485 ms | 76 ms | C++ 早 6.4×（但只是空壳） |
| 热启动：UI 就绪（UIA） | **567 ms** | **654 ms** | C++ 慢 87 ms（+15%） |
| 冷启动：UI 就绪（全新 profile） | 未测（见口径） | 716 ms | — |
| 热启动：进程树私有内存 | 91.3 MB | 96.0 MB | C++ +5% |
| 热启动：进程树工作集 | 334.6 MB | 371.3 MB | C++ +11% |
| 进程数 | 4 | 7 | C++ 多 3 个（WebView2 拆分） |
| 关闭：根进程退出 | 119 ms | 78 ms | C++ 快 34% |
| 关闭：整棵进程树消失 | 121 ms | 322 ms | C++ 慢 201 ms（WebView2 子进程晚退） |
| 143 页 PDF 抽取 | 624 ms | **205 ms** | **C++ 快 3.0×** |
| 单文件便携版 | 127.05 MB | **3.97 MB** | **小 96.9%（约 32×）** |
| 安装目录 | 444.12 MB | **11.32 MB** | **小 97.5%（约 39×）** |

体积按 10⁶ 字节换算；安装脚本与验收报告里的 `3.83 / 3.79 / 10.79 / 5.08 MB` 是
MiB 口径，指的是同一批文件。抽取 3 次原始值：C++ `205 / 206 / 205 ms`，
Electron `642 / 622 / 624 ms`。

## 怎么读这组数

1. **体积是压倒性收益。** Electron 把整份 Chromium 打进安装包；C++ 宿主只有
   1.7 MB，界面资产约 9 MB，PDFium 7.5 MB，运行期用系统 WebView2。下载、拷贝、
   装到多台机器上的成本差一个数量级。
2. **原生抽取明显更快。** PDFium（C++）对 pdfjs（JS）在 143 页样本上约 3 倍。
   `isg-studio.exe --extract=… --out=…` 还能无窗口地当命令行抽取器用。
3. **启动没有“快一个数量级”。** C++ 的窗口 76 ms 就出来了，但那是空壳；
   UIA 找到页面文字要 654 ms，反而比 Electron 的 567 ms 慢约 87 ms。
   C++ 冷启动 716 ms 也说明 WebView2 首次初始化并不便宜。**不要拿窗口可见时间宣传启动速度。**
4. **内存没有优势。** 私有内存 +5%、工作集 +11%，WebView2 还多拆了 3 个进程。
   如果目标是省内存，这次重写没有带来收益；它的目标是省**分发体积**与**原生能力**。
5. **关闭都干净，但形态不同。** C++ 根进程 78 ms 就退了，WebView2 浏览器子进程
   约 0.32 秒后才全部消失（本脚本等到整棵树消失才继续）；Electron 整棵树 0.12 秒。
   两者都在 0.4 秒内，没有进程残留。
6. **功能等价不是本对比的变量。** 两边跑同一份 `web/` 资产、同一份配置/Key/历史；
   功能等价由 103 条外层判据、金标准逐字节对拍与交付验收保证（见
   [`acceptance-report.md`](acceptance-report.md)）。

## 复现

本独立仓库只保留 C++ 侧自测与交付验收：

```powershell
powershell -File tools\build.ps1 -BuildDir build3
powershell -File tools\run-selftests.ps1 -Exe build3\dist\isg-studio.exe
```

架构对比需要 Electron 1.4.2 oracle 与 `bench-compare.ps1`，在原 monorepo 中运行；
本文件的数字来自 2026-10-17 的那一轮，归档原始件是
[`evidence/arch-bench.json`](evidence/arch-bench.json)。
