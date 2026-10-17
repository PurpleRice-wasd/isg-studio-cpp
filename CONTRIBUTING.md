# 贡献指南

感谢愿意改进 cpp版。开始之前，请先看 [README](README.md)、[docs/README.md](docs/README.md) 和 [docs/guidance.md](docs/guidance.md)。

## 提 Issue

- 使用仓库里的 Issue 模板：Bug 报告或功能建议。
- Bug 报告请写清版本、Windows 版本、复现步骤、期望结果和实际结果；有日志就贴脱敏后的片段。
- 不要粘贴 API Key、`%APPDATA%\isg-studio` 的内容、课件正文或他人的私人信息。
- 安全漏洞请不要公开提 Issue，按 [SECURITY.md](SECURITY.md) 私密报告。

## 提 PR

1. 先 fork，再 clone 自己的 fork，在独立分支上改动；不要直接向本仓库推送。
2. 一个 PR 只做一件事：修一个 bug、加一个功能或补一段文档。
3. 提交前至少跑一遍：

   ```powershell
   powershell -File tools\build.ps1 -BuildDir build3
   powershell -File tools\run-selftests.ps1 -Exe build3\dist\isg-studio.exe
   ```

   改动涉及安装、卸载或便携版时，再跑：

   ```powershell
   powershell -File tools\package.ps1 -BuildDir build3
   powershell -File tools\package-acceptance.ps1 -SamplePdf "C:\path\to\某章.pdf"
   ```

4. C++ 代码沿用现有风格：C++20、RAII，用 `ComPtr` 或 `unique_ptr` 管理资源，不写裸 `new`，不散落 `CloseHandle`；注释用中文，说明“为什么”而不是复述代码。
5. 用户可见的变化请更新 [CHANGELOG.md](CHANGELOG.md)；发布文案在 `docs/release-notes-2.0.0.md`。
6. 改动 `web/` 或 skill 时，请说明是否与 Electron 1.4.2 的资产保持一致；本仓库没有 oracle，无法跑完整的跨实现对拍。

## 不要提交

- API Key、`.env`、`%APPDATA%\isg-studio` 的配置或 WebView2 profile。
- 课件、教材、PDF、PPT 和来源不明的图片。
- `build*`、`third_party`、`node_modules`、打包产物和测试日志。
- 第三方代码或素材请同时带上许可原文、出处和改动说明。

## 许可

向本仓库提交代码即表示同意以 [MIT](LICENSE) 许可发布你的贡献。第三方素材的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
