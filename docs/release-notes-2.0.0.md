# cpp版 2.0.0

把桌面宿主从 Electron 换成 C++ + 系统 WebView2。界面、生成逻辑和 skill 内核仍是同一份，用起来和 1.4.2 一样。

## 下载

- [单文件便携版](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/download/v2.0.0/ISG-Studio-Portable-2.0.0-x64.exe)：双击即用，退出后自动清理临时文件。
- [安装版](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/download/v2.0.0/ISG-Studio-Setup-2.0.0-x64.exe)：安装到当前用户，带桌面和开始菜单快捷方式。
- [SHA256 校验值](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/download/v2.0.0/SHA256SUMS-2.0.0.txt)：下载后可以核对文件是否完整。

需要 Windows 10/11 和 WebView2 运行时（Windows 11 自带；Windows 10 若缺少请先安装）。

## 这次更新

- 安装包小了很多：单文件 3.97 MB（原来约 127 MB），安装后约 11 MB（原来约 444 MB）。
- PDF 抽取快约 3 倍：同一份 143 页 PDF，205 ms（原来 624 ms）。
- 启动和内存基本持平：页面就绪 654 ms（原来 567 ms），私有内存 96 MB（原来 91 MB）。
- 高分屏更清晰：修复了 200% 缩放下界面发虚的问题。
- 启动更稳：安装后立刻启动偶发的 WebView2 初始化失败会自动重试。
- 卸载更干净：不会留下空目录，用户配置和历史会保留。
- 原来的数据可以直接用：设置、加密的 API Key、历史和学习进度都与 1.4.2 共用，不需要迁移。

## 验证

- 103 项自动检查全部通过，0 跳过。
- 安装、启动、抽取、卸载和便携版共 31 项交付检查全部通过。
- 与 1.4.2 的页面拼装结果逐字节一致。
- 架构对比的方法和原始数据见 [arch-bench.md](https://github.com/PurpleRice-wasd/isg-studio-cpp/blob/main/docs/arch-bench.md) 和 [arch-bench.json](https://github.com/PurpleRice-wasd/isg-studio-cpp/blob/main/docs/evidence/arch-bench.json)。

## 已知限制

- 真实生成需要自备 API Key 和额度；仓库里的测试使用本地假模型。
- 没有在真实手机上验收生成结果的移动端形态。
- 内存、安装包体积、冷/热启动的完整对照还没有复测。
- PDF 逐页相似度没有达到 99%，原因是公式和表格的阅读顺序不同，不是丢字。

完整更新记录见 [CHANGELOG.md](https://github.com/PurpleRice-wasd/isg-studio-cpp/blob/main/CHANGELOG.md)。
