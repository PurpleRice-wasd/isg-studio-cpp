# 安全政策

## 支持的版本

| 版本 | 支持 |
|---|---|
| 2.0.x | 是 |
| 1.x（Electron 版） | 否，仅保留为对照 |

## 报告漏洞

请不要在公开 Issue 里报告安全漏洞，也不要在报告里粘贴 API Key、`%APPDATA%\isg-studio` 的内容或课件原文。

优先使用 GitHub 的私密漏洞报告：

https://github.com/PurpleRice-wasd/isg-studio-cpp/security/advisories/new

如果这个页面不可用，请通过 GitHub 联系维护者 [@PurpleRice-wasd](https://github.com/PurpleRice-wasd)。

报告里请尽量写清：

- 受影响的版本和 Windows 版本。
- 复现步骤和影响，例如能否读取本机文件、能否拿到 API Key 明文。
- 相关日志的**脱敏**片段；不要包含 Key、Cookie、个人路径或课件正文。

## 范围

- 宿主程序：窗口、单实例、`isg://` 协议白名单、CSP、导航守卫和退出清理。
- API Key：本机加密存储、只在宿主侧注入、渲染层拿不到明文。
- 生成页面：HTML/JS 是否有注入、外链或本地文件读取问题。
- 安装、卸载和便携版：文件写入范围、临时目录清理和权限。
- 第三方依赖：WebView2、PDFium、miniz 和 nlohmann/json。

## 我们的承诺

- 不会因为善意的安全研究追究责任。
- 收到报告后会尽快确认，并在修复后公开致谢（如果你愿意）。
