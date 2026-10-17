# 第三方素材与许可

本仓库的 [LICENSE](LICENSE) 是 MIT。以下第三方素材另有许可与署名要求，分发时请一并保留。

## 大肥鱼陪练形象

- 来源：https://github.com/1190fasheqi/dafeiyu-pet ，取用提交 `5b0e018`。
- 许可：MIT，原文见 [`skills/interactive-study-guide/third-party/dafeiyu-pet/LICENSE.txt`](skills/interactive-study-guide/third-party/dafeiyu-pet/LICENSE.txt)。
- 出现位置：`skills/interactive-study-guide/assets/quiz-engine.js` 的 `FISH` 常量（base64 内嵌）；生成页面启用内置形象时会用到。
- 本仓库做过的改动：调色板量化后内嵌为 data URI；取用文件、校验值和改动记录见该目录的 [`README.md`](skills/interactive-study-guide/third-party/dafeiyu-pet/README.md)。

## 运行期依赖

程序运行期还会使用系统 WebView2 运行时。PDF 抽取使用 PDFium，PPTX 解包使用 miniz，JSON 使用 nlohmann/json。它们由 `tools/fetch-deps.ps1` 取用，许可与版权分别属于各自项目。
