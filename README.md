# 讲练一体工作台 · cpp版

把一章课件（PPT / PDF）或教材交给大模型，生成一份**单文件 HTML** 学习材料：讲解和练习挨在一起，点选项立刻判分，关键概念配可拖动的演示，进度自动保存在本地。

![工作台](docs/portable-run.png)

## 下载

| 版本 | 说明 |
|---|---|
| [单文件便携版](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/latest/download/ISG-Studio-Portable-2.0.0-x64.exe) | 双击即用，不写注册表 |
| [安装版](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/latest/download/ISG-Studio-Setup-2.0.0-x64.exe) | 安装到当前用户，带桌面和开始菜单快捷方式 |
| [SHA256 校验值](https://github.com/PurpleRice-wasd/isg-studio-cpp/releases/latest/download/SHA256SUMS-2.0.0.txt) | 核对下载文件是否完整 |

需要 Windows 10/11 和 WebView2 运行时（Windows 11 自带；Windows 10 若缺少请先安装）。

## 2.0.0 有什么变化

2.0.0 把桌面宿主从 Electron 换成了 C++ + 系统 WebView2。界面、生成逻辑和 skill 内核仍是同一份，所以用起来和 1.4.2 一样。

- **安装包小了很多**：单文件 3.97 MB（原来 127 MB），安装后约 11 MB（原来 444 MB）。
- **PDF 抽取更快**：同一份 143 页 PDF，205 ms（原来 624 ms），约 3 倍。
- **启动和内存基本持平**：页面就绪 654 ms（原来 567 ms），私有内存 96 MB（原来 91 MB）。窗口出现得早，但页面还没画完，不能算启动更快。
- **高分屏更清晰**：修复了 200% 缩放下界面发虚的问题。
- **启动和卸载更稳**：安装后立刻启动偶发的 WebView2 初始化失败会自动重试；卸载不会留下空目录。
- **原来的数据可以直接用**：设置、加密的 API Key、历史和学习进度都与 1.4.2 共用，不需要迁移。

完整变化见 [CHANGELOG.md](CHANGELOG.md)。

## 怎么用

1. 双击 `ISG-Studio-Portable-2.0.0-x64.exe`，或者运行安装版。
2. 打开「设置」，选一个模型服务，填入 API Key，点「测试连接」。
3. 把课件拖进工作台，设置章节、题量和演示数量。
4. 点「开始生成」。完成后打开生成的 HTML；之后可以在结果页点「重新校验」。

## 从源码构建

需要 Visual Studio 2022/2026（C++ 工具链）、Python 3 和 WebView2 运行时。

```powershell
powershell -File tools\fetch-deps.ps1
powershell -File tools\build.ps1 -BuildDir build3
.\build3\dist\isg-studio.exe
```

`cmake` 和 `ninja` 不在 PATH 也可以，`tools\build.ps1` 会调用 `vcvars64.bat`。

### 打包与自测

```powershell
powershell -File tools\package.ps1 -BuildDir build3
powershell -File tools\run-selftests.ps1 -Exe build3\dist\isg-studio.exe
```

`build-package\` 里会生成安装版和便携版。这个目录不提交进仓库，发布时作为 Release 附件上传。

## 技术文档

- [架构对比：Electron 1.4.2 与 C++ 2.0.0](docs/arch-bench.md)：体积、内存、启动和 PDF 抽取的实测数据。
- [验收报告](docs/acceptance-report.md)：2.0.0 的完整验收结果。报告是在原来的 monorepo 里完成的，开头有独立仓库说明。
- [更新记录](CHANGELOG.md) · [Release 文案](docs/release-notes-2.0.0.md)
- `docs/guidance*.md` 和 `docs/phase*-report.md` 是开发过程笔记，不读也能正常使用。

## 目录

```
src/                             宿主：窗口、桥、设置、抽取、网络、流水线、校验
web/                             界面（和 Electron 1.4.2 同一份）
skills/interactive-study-guide/  运行期 skill 内核（含第三方素材与许可）
docs/                            契约、规格、验收报告、架构对比、发布文案
tools/                           构建、取依赖、打包、自测、假模型服务
CMakeLists.txt
VERSION                          版本号（2.0.0）
CHANGELOG.md
LICENSE                          MIT
```

## 已知限制

- 真实生成需要自备 API Key 和额度；仓库里的自测使用本地假模型。
- 没有在真实手机上验收生成结果的移动端形态。
- PDF 逐页相似度没有达到 99%，原因是公式和表格的阅读顺序与 pdfjs 不同，不是丢字。
- 安装包没有代码签名，首次运行时 Windows 可能弹出 SmartScreen 提示。

## 许可

MIT，见 [LICENSE](LICENSE)。`skills/interactive-study-guide/third-party/dafeiyu-pet/` 是内置陪练形象（MIT，原作者许可和出处见该目录）；再分发时请保留许可原文。
