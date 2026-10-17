## 改了什么

<!-- 一句话说明这个 PR 做了什么 -->

## 类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档
- [ ] 构建 / 测试

## 验证

- [ ] `powershell -File tools\build.ps1 -BuildDir build3`
- [ ] `powershell -File tools\run-selftests.ps1 -Exe build3\dist\isg-studio.exe`
- [ ] 涉及打包、安装或卸载时跑过 `tools\package-acceptance.ps1`
- [ ] 用户可见变化已更新 `CHANGELOG.md`

## 检查

- [ ] 没有提交 API Key、`%APPDATA%\isg-studio`、课件原件或构建产物
- [ ] 新增第三方素材带有许可原文和出处
- [ ] 没有把 `build*`、`third_party`、`node_modules` 带进提交
