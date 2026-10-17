# Phase 1–6 验证报告（立壳 + 抽取 + 网络/任务 + 流水线/拼装 + 校验/修复 + 收尾）

> 由 `tools/phase1-verify.ps1` 生成。**每次运行都会覆盖这份文件**；
> 机器可读的原始件在 `_verify-out/` 下（自测报告、金标准产物、对角产物）。

**结论：全部通过。**

运行时间：2026-10-17 16:16:38 → 16:18:20

**本次跳过的判据**（结论只覆盖跑了的那些）：
（无）

| 结果 | 判据 | 证据 |
|---|---|---|
| ✅ | 所有 .ps1 都带 UTF-8 BOM（否则 PowerShell 5.1 会按 GBK 解、中文注释把解析器带崩） | python tools/check-ps1-encoding.py |
| ✅ | web/ 与「oracle + 补丁」逐字节一致 | tools/sync-web.ps1 |
| ✅ | 提供商预设表与 providers.js 一致 | tools/gen-providers.py |
| ✅ | logic-bundle.js 与 web/logic 下的文件一致 | tools/golden/bundle-logic.js |
| ✅ | logic-bundle.js 是合法 JS（用 node 真的解析一遍） | node -e "new Function(bundle)" |
| ✅ | 版本号单一真源（VERSION）且 oracle 仍停在 1.4.2 | VERSION 2.0.0；rc=True manifest=True package=True；oracle 1.4.2 |
| ✅ | 构建成功 | exit=0；日志 <repo>\apps\isg-studio-cpp\_verify-out\build.log |
| ✅ | 构建零告警 | warning 行数=0 |
| ✅ | 被测 exe 不旧于源码/工具，且版本与 VERSION 一致 | exe 16:16:57 / 最新源 16:15:59（expected.json）；版本 2.0.0 |
| ✅ | 自测 settings | 判据=19 未过=0 |
| ✅ | 自测 background | 判据=30 未过=0 |
| ✅ | 自测 env | 判据=27 未过=0 |
| ✅ | 自测 key-leak | 判据=10 未过=0 |
| ✅ | 自测 bridge | 判据=38 未过=0 |
| ✅ | 自测 protocol | 判据=14 未过=0 |
| ✅ | 自测 protocol-live | 判据=5 未过=0 |
| ✅ | 自测 probe | 判据=3 未过=0 |
| ✅ | 自测 ui | 判据=46 未过=0 |
| ✅ | 自测 net-fault | 判据=26 未过=0 |
| ✅ | 自测 pipeline-cancel | 判据=9 未过=0 |
| ✅ | 自测 pipeline-mock | 判据=28 未过=0 |
| ✅ | 自测 verify | 判据=20 未过=0 |
| ✅ | 自测 pipeline-repair | 判据=31 未过=0 |
| ✅ | 自测 book | 判据=20 未过=0 |
| ✅ | 自测 book-e2e | 判据=28 未过=0 |
| ✅ | 自测 book-data | 判据=20 未过=0 |
| ✅ | 自测 cleanup | 判据=26 未过=0 |
| ✅ | 自测 multi-source | 判据=8 未过=0 |
| ✅ | 自测 extract | 判据=33 未过=0 |
| ✅ | 自测 extract-pdf | 判据=11 未过=0 |
| ✅ | 自测 e2e-mock | 判据=31 未过=0 |
| ✅ | oracle 抽取 03 地球椭球-1.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\oracle-03-1.json |
| ✅ | C++ 抽取 03 地球椭球-1.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cpp-03-1.json |
| ✅ | 对拍 03 地球椭球-1.pdf：对拍字段齐全 |  |
| ✅ | 对拍 03 地球椭球-1.pdf：报告绑定本次输入（SHA256 对得上） | oracle=True cpp=True |
| ✅ | 对拍 03 地球椭球-1.pdf：oracle 与 C++ 不是同一份产物 | sha=eea607a6e069… |
| ✅ | 对拍 03 地球椭球-1.pdf：对拍器判定通过（ok=true 且 exit=0） | exit=0 ok=True |
| ✅ | 对拍 03 地球椭球-1.pdf：页数一致 | 33 vs 33 |
| ✅ | 对拍 03 地球椭球-1.pdf：每页 reasons 一致 | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-1.pdf：每页 suspect 一致 | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-1.pdf：每页 columns 一致（栏序判据） | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-1.pdf：总字符数比值在 0.98–1.03 | 7571 / 7521 = 1.006648；去空白后 1.012088 |
| ✅ | 对拍 03 地球椭球-1.pdf：没有整页内容丢失（oracle 有字、C++ 为空） | emptyMismatch=0 |
| ✅ | 对拍 03 地球椭球-1.pdf：没有逐页内容丢失（<50%） | contentLossPages=0 |
| ✅ | 对拍 03 地球椭球-1.pdf：≥0.99 的页 + 低相似度页 = 总页数 | 21 + 12 = 33 |
| ✅ | 对拍 03 地球椭球-1.pdf：warning 种类一一对应 | 逐字相同=False |
| ✅ | 对拍 03 地球椭球-1.pdf：逐页相似度中位数 ≥ 0.99 | median=0.997118，≥0.99 的页 21/33 |
| ✅ | 对拍 03 地球椭球-1.pdf：去空白后中位数 ≥ 0.99（排除空格噪声） | medianNoWs=1.0 |
| ✅ | 对拍 03 地球椭球-1.pdf：最低页相似度 ≥ 0.20 | min=0.264798 |
| ✅ | 对拍 03 地球椭球-1.pdf：低相似度页数不超过 14 | 低相似度页 12/33；其中仅空白不同 6 页；逐页明细见 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cmp-03-1.json |
| ✅ | oracle 抽取 03 地球椭球-2.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\oracle-03-2.json |
| ✅ | C++ 抽取 03 地球椭球-2.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cpp-03-2.json |
| ✅ | 对拍 03 地球椭球-2.pdf：对拍字段齐全 |  |
| ✅ | 对拍 03 地球椭球-2.pdf：报告绑定本次输入（SHA256 对得上） | oracle=True cpp=True |
| ✅ | 对拍 03 地球椭球-2.pdf：oracle 与 C++ 不是同一份产物 | sha=d0efd79f56ea… |
| ✅ | 对拍 03 地球椭球-2.pdf：对拍器判定通过（ok=true 且 exit=0） | exit=0 ok=True |
| ✅ | 对拍 03 地球椭球-2.pdf：页数一致 | 25 vs 25 |
| ✅ | 对拍 03 地球椭球-2.pdf：每页 reasons 一致 | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-2.pdf：每页 suspect 一致 | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-2.pdf：每页 columns 一致（栏序判据） | 不一致 0 页 |
| ✅ | 对拍 03 地球椭球-2.pdf：总字符数比值在 0.98–1.03 | 4800 / 4849 = 0.989895；去空白后 1.0 |
| ✅ | 对拍 03 地球椭球-2.pdf：没有整页内容丢失（oracle 有字、C++ 为空） | emptyMismatch=0 |
| ✅ | 对拍 03 地球椭球-2.pdf：没有逐页内容丢失（<50%） | contentLossPages=0 |
| ✅ | 对拍 03 地球椭球-2.pdf：≥0.99 的页 + 低相似度页 = 总页数 | 15 + 10 = 25 |
| ✅ | 对拍 03 地球椭球-2.pdf：warning 种类一一对应 | 逐字相同=True |
| ✅ | 对拍 03 地球椭球-2.pdf：逐页相似度中位数 ≥ 0.99 | median=1.0，≥0.99 的页 15/25 |
| ✅ | 对拍 03 地球椭球-2.pdf：去空白后中位数 ≥ 0.99（排除空格噪声） | medianNoWs=1.0 |
| ✅ | 对拍 03 地球椭球-2.pdf：最低页相似度 ≥ 0.20 | min=0.882175 |
| ✅ | 对拍 03 地球椭球-2.pdf：低相似度页数不超过 12 | 低相似度页 10/25；其中仅空白不同 3 页；逐页明细见 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cmp-03-2.json |
| ✅ | oracle 抽取 数字图像处理——图像增强-xh.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\oracle-big.json |
| ✅ | C++ 抽取 数字图像处理——图像增强-xh.pdf | exit=0；报告 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cpp-big.json |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：对拍字段齐全 |  |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：报告绑定本次输入（SHA256 对得上） | oracle=True cpp=True |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：oracle 与 C++ 不是同一份产物 | sha=0b6845def943… |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：页数一致 | 143 vs 143 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：每页 reasons 一致 | 不一致 0 页 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：每页 suspect 一致 | 不一致 0 页 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：columns 不一致 ≤ 5（压力样本，非 DoD 样本） | 不一致 5 页 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：总字符数比值在 0.95–1.10（压力样本） | 23544 / 22132 = 1.063799；去空白后 1.010618 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：没有整页内容丢失（oracle 有字、C++ 为空） | emptyMismatch=0 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：没有逐页内容丢失（<50%） | contentLossPages=0 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：≥0.99 的页 + 低相似度页 = 总页数 | 60 + 83 = 143 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：warning 种类一一对应 | 逐字相同=False |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：逐页相似度中位数 ≥ 0.94（压力样本，非 DoD 样本） | median=0.98152，≥0.99 的页 60/143 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：去空白后中位数 ≥ 0.98（压力样本） | medianNoWs=1.0 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：最低页相似度 ≥ 0.15（压力样本） | min=0.369838 |
| ✅ | 对拍 数字图像处理——图像增强-xh.pdf：低相似度页数不超过 90 | 低相似度页 83/143；其中仅空白不同 41 页；逐页明细见 <repo>\apps\isg-studio-cpp\_verify-out\phase2\cmp-big.json |
| ✅ | Debug 构建零告警 | warning 行数=0；日志 <repo>\apps\isg-studio-cpp\_verify-out\build-debug.log |
| ✅ | 泄漏检测器**会响**（故意漏 4 KB，报告里出现了它） | 报告 <repo>\apps\isg-studio-cpp\_verify-out\leak-selftest-leaks.txt，非空 |
| ✅ | 泄漏自检那一轮的自测真的跑了（settings 19 条、exit=0） | exit=0 checked=19 |
| ✅ | 正常路径没有内存泄漏（Debug + CRT 泄漏检查） | 报告 <repo>\apps\isg-studio-cpp\_verify-out\leak-clean-leaks.txt，空（无泄漏）；自测 exit=0 checked=30 |
| ✅ | Electron 写出了带 Key 的配置（取到了期望值） | sk-from-electron-DPA |
| ✅ | C++ 能解开 Electron 写的 Key（老配置可直接读） | exit=0 |
| ✅ | Electron 能解开 C++ 写的 Key（写的也兼容） | OK sk-from-cpp-5f0ed0b57c3b |
| ✅ | 金标准基准由 oracle 现场重新生成（退出码 0） | exit=0；日志 <repo>\apps\isg-studio-cpp\_verify-out\golden\make-golden.log |
| ✅ | 基准的指纹由 oracle 现场生成（expected.json：字节数 + sha256 + 作答点） | bytes=157557/157557 sha256=c05a28cf96b04e92… points=8 units=3 |
| ✅ | 金标准对拍：C++ 侧与 oracle 的产物逐字节相同 | expected 157557 字节 C05A28CF96B04E92… / actual 157557 字节 C05A28CF96B04E92…；本次新产出=True |
| ✅ | 交付目录的 web/ 与仓库 web/ 逐文件一致 | 缺 0 / 多 0 / 内容不同 0 |
| ✅ | 页面侧的桥与通道表一一对应（31 个名字） | host=31 page=31 |
| ✅ | 交付目录 ≤ 15 MB（exe + web；skill/docs 尚未拷入，Phase 6 计入） | 10.18 MB（exe 1,736,192 字节 + web 8,935,991 字节） |
| ✅ | 控制器就绪 ≤ 1000 ms | 391 ms |
| ✅ | 页面就绪 ≤ 6000 ms | 543 ms |
| ✅ | 收尾完成（teardown 有数） | 3534 ms |

本次执行外层判据 103 条，跳过 0 类；参数：BuildDir=build3 SkipBuild=False SkipKeyCompat=False。
被测 exe：`<repo>\apps\isg-studio-cpp\build3\dist\isg-studio.exe`，SHA256 `34a69352c9550bb9c07e27270880a602921803ba1239ceeae8df391087da122f`。源码/工具的 mtime 已用判据核过（见上表）。

原始件：`_verify-out/`（自测报告、金标准 actual、构建日志）；基准 `expected.html` 在 `tools/golden/out/`。