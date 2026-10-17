# guidance3 · Phase 2 工作记录与接手笔记

> **作者**：接手这次 C++ 重写、完成 Phase 2 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、当时怎么想的、怎么定位的、
> **我怎么发现自己是错的**。判断与路线仍以 [`guidance.md`](guidance.md) 为准；
> 设计、差异记账与最终数字在 [`phase2-report.md`](phase2-report.md)；
> 验证结果在 [`phase1-report.md`](phase1-report.md)（Phase 2 的判据也在里面）。
>
> 与 guidance1/2 的关系：那一份是 Phase 0，guidance2 是 Phase 1，这一份是 Phase 2。
> guidance1 §9 的三条——**最难的是不让自己被骗、我的默认倾向是相信自己的判据、
> 我倾向于把话说满**——在 Phase 2 又发生了一遍，而且换成了新的形态：
> 这次不是"查了意图没查结果"，而是**"判据全绿，但判据本身允许整页文字消失"**。

---

## 0. 一句话

Phase 2 把 PDF/PPTX/文本抽取、`extract:preview` 异步桥、抽取预览的可编辑界面做完了，
最终 **91 条判据全过**（`extract` 33 + `extract-pdf` 11 + UI 46 + 其余 Phase 1 判据），
干净构建、Release/Debug 零告警、泄漏自检会响。

**但 DoD 没有完全达到**：纲领要求"逐页正文相似度 >99%"，我们做到的是
**中位数 0.9971 / 1.0000、内容丢失 0、去空白后中位数两份都是 1.0**；
公式/表格/图上文字页的阅读顺序与 pdf.js 不同，逐页相似度仍有 12/33、10/25 页低于 99%。
这条差距没有被中位数盖住，也没有被"warning 种类一致"盖住——本文和 `phase2-report.md`
都如实写了，验证器也加了 `emptyMismatch` / `contentLossPages` 两条**内容丢失**判据。

最值钱的产出不是那 7 MB 的 pdfium.dll，而是三路互验审出来的**五类假绿**：
在我"以为已经完成"的时候，验证器还允许两页整页文字被清空而全绿。

---

## 1. 我接手时仓库长什么样

- `apps/isg-studio/`：完整的 Electron 版（oracle），**不删不冻**，继续当对拍基准。
- `apps/isg-studio-cpp/`：Phase 0/1 已完成。`src/` 下有 app/shell/bridge/settings/util/selftest，
  `web/` 是渲染层拷贝，`tools/phase1-verify.ps1` 已经在跑 31 条判据。
- **没有任何 `src/extract/`**。Phase 2 的 DoD 一句话：PDFium 抽文本 + 版面还原；
  PPTX（miniz+pugixml）；质量信号与 warnings 一一对应；抽取预览可用可编辑；
  真 PDF 逐页对拍 >99% 且栏序一致。
- 真实课件**不在仓库里**（版权 + 体积），本机的样本在
  `<samples>\`。这一点很关键：没有样本，
  "逐页对拍"就只能变成一句空话。

**我的第一件事不是写代码**，是把纲领 §4/§5/§7、guidance2 §11、oracle 的
`extract/{index,pdf,pptx,text}.js` 与 `test/extract-smoke.js` 读了一遍。
事后看，这一步直接避免了两类返工：

1. 我知道 oracle 的 `pdf.js` 里那些阈值（20% 重复页眉、median×0.5 行容差、
   median×0.28 空隙容差、80% 覆盖门槛）是拿真课件校准出来的，**不能凭感觉改**；
2. 我知道 `index.js` 的返回结构是渲染层的合同，`pages[].index` 从 1 开始、
   `quality` 必须同时有 `chars/cjkRatio/suspect`，`warnings` 是对象不是字符串。

---

## 2. 我按什么顺序做

1. **先立骨架**：`extract.h` + `internal.h`（UTF-8 码点、JS 空白、CJK 判定），
   再按 oracle 的文件边界分 `extract.cpp / text.cpp / pptx.cpp / pdf.cpp`。
2. **依赖与构建**：PDFium 用 `bblanchon/pdfium-binaries` 的 win-x64 预编译包
   （`chromium/8100`，sha256 钉死），miniz 用 2.2.0 源码（逐文件 sha256）。
   CMake 里 PDFium 只链导入库，DLL 由独立目标拷到 `dist/`；miniz 编成静态库、
   `/W4` 零告警。**不要把 DLL 的拷贝写成 `POST_BUILD`**——只改资产不会触发链接，
   Phase 1 已经踩过这个坑。
3. **先翻译简单的**：`index.cpp` 的类型识别、质量口径、扫描件诊断；
   `text.cpp` 的编码识别与标题切页；`pptx.cpp` 的切标签状态机。
4. **再啃 PDF**：先跑通"PDFium 能取出中文"，再逐条照抄 pdf.js 的分行/分栏/页眉页脚。
5. **最后接桥与界面**：`extract:preview` 在工作线程抽取，结果排进 UI 队列，
   由主线程 `DrainUiQueue` 回包；渲染层原样不动，它本来就会调 `previewExtract`。
6. **补自测与对拍**：`--selftest=extract`（合成夹具）、`--selftest=extract-pdf`（真 PDF）、
   UI 自测加抽取段；`tools/extract-oracle.js` + `tools/compare-extract.py` 做逐页对拍。

**顺序上我犯了一个错**：我先写了实现，后搭对拍。正确的顺序应该是
**先把"oracle vs C++"的逐页对拍搭起来**，再写 PDFium 抽取——这样每一次改动都有基准，
而不是等到最后才发现"整体相似度只有 0.75"。guidance2 §11 已经写过"Phase 2 的第一件事
不是写 PDFium，是把逐页文本对拍搭起来"，我读到了，但还是先写了代码。**下一任别重复。**

---

## 3. 翻译与重写：哪些是照搬，哪些必须重新推导

| oracle | 做法 | 说明 |
|---|---|---|
| `extract/index.js` | 逐条翻译 | 类型识别、CJK 占比、tidyTitle、diagnoseScanned、汇总警告 |
| `extract/text.js` | **重写** | 编码识别（BOM/UTF-8/UTF-16/GBK）本质是系统解码能力；切页逻辑逐条翻译但不是逐字节拷贝。**这条偏离已记在 `phase2-report.md` §2.2 #8**，Phase 4 应把纯切页逻辑搬回 Worker 并补同步检查 |
| `extract/pptx.js` | 逐条翻译 | 解包换成 miniz；**XML 解析保持原样**（切标签状态机），不换 pugixml——换解析器会改变空白/实体/表格口径 |
| `extract/pdf.js` | **算法照抄、取数重写** | 分行、分栏、页眉页脚、质量信号逐条照抄；原始信息从 pdf.js 的 item+transform 换成 PDFium 的逐字符 origin/box/size |
| `ipc.js` 的 `extract:preview` | 翻译 | 白名单 → 抽取 → 缓存（路径+mtime+size，最近 4 份）；错误码对齐 `BAD_ARG/NOT_ALLOWED/HANDLED_ERROR` |

**为什么 text.js 是重写而不是拷贝**：纲领 §4.1 说"只有 I/O、窗口、网络传输、解析、加密
这些宿主能力才重新实现"。"从字节流识别编码并解码"是解析/系统能力，放 C++ 是合理的；
但"按标题切页"是纯逻辑，Phase 2 暂时和解码放在一起。**这是一个工程取舍，不是"顺手重写"**，
所以必须记账，不能装作它还是逐字节拷贝。

---

## 4. 转折一：PDFium 给我的六个"看起来对、其实错"

### 4.1 `FPDFText_GetText` 会把输出压缩

第一版用 `FPDFText_GetText` 一次拿整页 UTF-16，再用同一套下标去问
`GetCharOrigin`/`GetFontSize`。结果坐标整体错位，行分得乱七八糟。
查文档才发现：**"This function ignores characters without UCS-2 representations."**
输出会被压缩，返回的字符串下标和 `CountChars` 的字符下标不再一一对应。
改成逐字符 `FPDFText_GetUnicode`，坐标和文字才同源。

**教训**：API 文档里"看起来无关"的一句话，往往就是 bug 的根因。不要只读函数签名。

### 4.2 增补平面字符是代理项对

数学公式里的 𝑎（U+1D44E）在 CambriaMath 里是 `0xD835 + 0xDC4E` 两个 UTF-16 码元。
第一版把它们当成两个独立字符，分别 `utf8_append`，编出 `ED A0 80` 这种非法 UTF-8；
随后在行拼接时被解码成 U+FFFD——**整页公式看起来像"字体映射坏了"**，
但 `FPDFText_GetUnicode` 本身是对的。合并 high/low surrogate 后解决。
后来把 `utf8_append` 本身改成"遇到代理区直接输出 U+FFFD"，作为最后一道防线。

### 4.3 UTF-8 续字节 0xA0 被当成 NBSP

这是最阴的一条。「章」= `E7 AB A0`、「几」= `E5 87 A0`、「标」= `E6 A0 87`。
oracle 的空格折叠正则是 `/[ \t\u00a0]+/g`，我照着写了一个**按字节**的
`collapse_spaces`，把任何 `0xA0` 都当 NBSP → 一个汉字被改成"非法字节 + 空格"。
表现是 03-1 第 2 页「第三章」变成「第三�」，第 3 页「坐标系」变成「坐� �系」，
而且 `reasons` 里多出 `bad_glyph_mapping`。

定位过程：我先怀疑字体、再怀疑 CMap，最后把输出 JSON 的**原始字节**打出来，
看到 `E7 AB 20` 才反应过来——**0xA0 是续字节，不是 NBSP**。
所有空白/trim/折叠改成按码点处理。这条也解释了为什么不能拿字节级正则处理中文。

### 4.4 字宽用包围盒 → 单词内部被插空格

`itemsToLines` 的规则是"x 之间有空隙才插空格"。第一版用
`FPDFText_GetCharBox` 的 `right-left` 当字宽，**包围盒比 advance 窄**，
两个相邻字母之间就被算出一个 0.x em 的空隙，于是 `g(x,y)` 变成 `g ( x , y )`，
整页字符数凭空多两成。

修法：用"下一个字符的 origin - 当前 origin"当 advance；同一个 PDF 文本对象内
放宽到 3em，跨对象时普通字符 0.9em、全角字符 1.3em；破折号（U+2010–2015）两侧
不插空格。修完后总字符数比值从 1.07 降到 1.0066（03-1）。

### 4.5 PUA 项目符号被误报成"字体映射损坏"

PowerPoint 的项目符号（●/▪）住在私用区（U+F06F 等）。pdf.js 里它是独立 item，
`countPuaInWords` 对"单个 PUA、没有别的字"判为无害。
我先按"矩形段"统计，矩形段会把项目符号和同一行的正文并在一起 → `rest>0` → 误报。
改成按 `FPDFText_GetTextObject` 分组，并把"token 开头的短 PUA 串"视为项目符号，
三份样本的 `reasons` 才和 oracle 完全一致（0 页不一致）。

### 4.6 分栏误判会把通栏文字丢掉

pdf.js 的 `findGutter` 只要求 `gapWidth > 0`。我们的 x1 来自逐字符 advance，
图上文字块会产生 1–2% 页宽的假栏缝；143 页样本第一版有 12 页被误判成多栏。
更糟的是 oracle 的 `readOrder` 只返回 `left+right`，**横跨栏缝的行会被静默丢掉**。
我把阈值收紧到 10% 页宽 + 每栏 ≥3 行，并把 `rest`（横跨栏缝的行）保留、按 y 接在后面。
代价是 143 页样本仍有 5 页与 oracle 的栏数不同——已记账，没有假装没有。

### 4.7 公式页的阅读顺序：为什么最后没有强行逐页 99%

为了把公式页拉上去，我试过三条路：

1. **矩形段**（`CountRects` + `GetBoundedText`）：以为更接近 item，结果矩形会重叠，
   文字重复，均值和页数都更差。
2. **把连续字符合成 run**（按 y/间距合并）：普通页有改善，但公式页会把上下标并错行，
   第 18/22 页反而更差。
3. **只合并上下标**：page 26 的开头不再出现孤立的两个 `2`，但其他页的合并条件又太宽。

最终保留的是**逐字符 + advance + 同行按 y 聚类**的方案：普通正文页最好，
公式页的顺序差异仍在。原因不是"调参不够"，而是**取数粒度不同**：
pdf.js 的 item 边界由内容流的 showText 决定，PDFium 的公开 API 不暴露等价的 item 变换。
要逐页 99%，需要另做 PDFium 的文本 run 重建，不应在 Phase 2 里靠阈值硬凑。

**我没有把中位数写成逐页。** 这是这一阶段最重要的一个决定。

---

## 5. 转折二：三路交叉验证——判据全绿时，功能仍可以是坏的

用户要求每个阶段交付时开三路互验。三路分别是：C++ 正确性/内存安全、
与纲领/规格书一致性、验证体系可信度。**顺序很重要：先自己跑完全绿、写好文档，
再开审查**——审查者要能看见"你声称的样子"，才能指出你在哪里把话说满了。

### 5.1 第一路：五个真 bug

1. **工作线程里的异常没有任何 catch**。`extract_file` 可能抛 `bad_alloc`、
   `length_error`、nlohmann 类型异常；异常逃出 `std::thread` 入口 = `std::terminate`，
   进程直接消失、收尾路径全跳过。修法：worker 外层 `try/catch`，回 `HANDLED_ERROR`。
2. **zip 解压炸弹**。`ZipReader` 按 zip 头里声明的 `m_uncomp_size` 直接分配；
   几十 KB 的 PPTX 可以把一个条目声明成 4 GB。修法：单条目 64 MiB、累计 256 MiB、
   条目数 10 万上限；超限按"部件缺失"走 warning。
3. **已完成的抽取线程从不回收**。每次预览都 `emplace_back` 一个 `std::thread`，
   只在 `Detach` 才 join——长会话里句柄/对象一直涨。修法：done 标志 + `reap_workers()`。
   `dialogs.cpp` 早就踩过同一个坑，我没抄。
4. **`normaliseForRepeat` 逐位替换数字**。oracle 是 `/\d+/g → '#'`，
   我写成了"每个数字一个 `#`"，于是「第 3 页」和「第 12 页」成了两个 key，
   位数不同的页码会被拆组，页眉页脚剔不干净。这条在真样本上表现为
   "C++ 3 种重复文字 / oracle 2 种"，被"warning 种类一致"的宽松口径放过去了。
5. **取消语义不一致**。PDF 取消返回 `CANCELLED`，PPTX 取消却返回"成功 + 截断结果"，
   文本路径完全不检查取消。Phase 4 用户取消生成时会踩到。

另有 5 条高可疑（`Attach` 不复位 cancel、孤立代理项、畸形 PPTX 的 O(n²) 标签扫描、
GBK 失败当成功、`reply` 捕获 `this`）和 12 条建议（缓存锁里做外部调用、浮点
格式化受 locale 影响、`atoi` 溢出、夹具用窄字符路径等），都修了或记账了。

### 5.2 第二路：文档把话说满了

- `text.js` 被重写却没记账（纲领明确说它是纯逻辑、原样搬）。
- "正文页逐页 >99%"说满了：03-2 第 5 页是普通项目列表，0.9726，差异全是空格。
- 143 页样本"多 7.5% 是抽到了隐藏/重复文字"归因不准：去掉空白后只多 1.1%，
  主因是空格插入。
- 低相似度页的举例写错了：0.25 是**第 22 页**，不是第 26 页。
- UI 新增抽取检查实际是 11 条，我写成了 9 条。

第二路的总结一句话：**代码的问题多是局部的，文档的问题是把"中位数"说成了"每一页"。**
这个项目的读者会把文档当验收标准，所以后者更危险。

### 5.3 第三路：它真的去骗验证器

这是投资回报最高的一路。它不是"再跑一遍看绿不绿"，而是构造 mutation：

| 它做的事 | 第一版结果 | 修复后 |
|---|---|---|
| 改 `cmp-*.json` 的 `medianSim/totalRatio/lowPages` | **8 条全绿** | 验证器核对输入 SHA256、字段齐全、`ok/exit` |
| 清空两页整页文字（156 字） | **全绿**（totalRatio 0.987 ≥ 0.98） | `emptyMismatch=0`、`contentLossPages=0`、双向比值界 |
| 只数 `[ok]/[BAD]` 行，`checked=0` 或伪造标签 | **全绿** | 同时核对自报 `checked` 与 `test` 名 |
| 增量构建（`ninja: no work to do`） | **"零告警"全绿** | 验证时强制 `-Clean`，Release+Debug 两份日志 |
| 删掉 `cmp` 的几个字段 | **全绿**（`[int]$null=0`、`@($null).Count=1`） | 先断言字段存在，再读数字 |
| 把 oracle JSON 复制成 cpp | **全绿**（median 1.0） | 断言两份 SHA256 不同 |
| 缺大样本时自测 40 条 | 自测说"全部通过"，验证器说"40≠44"红 | 拆成 `extract`（33，永远跑）与 `extract-pdf`（11，缺样本整条跳过） |

第三路给的一句话，我把整段抄进了 `phase2-report.md`：

> **任何一条判据，只要它的输入是被测程序写的 JSON，就必须有一个验证器自己算出来的数字来对账。**

### 5.4 修完之后，我又打了一次自己

修完不是就完事：重新跑一遍干净验证，确认 91 条全过；再检查
`emptyMismatch/contentLossPages`、输入 SHA256、`checked` 对账、exe 新鲜度。
最后把 `docs/phase1-report.md` 重新生成，确保报告里的 exe SHA256 和最新源码对得上。

---

## 6. 我自己犯的错（比审出来的更值得记）

1. **工具生成的 C++/PowerShell 字符串里 `\n` 变成了真换行**。
   我用 Python 脚本批量改代码，`"\\n"` 在某些层被解成了实际换行，C++ 报
   "字符串常量中有换行"、PowerShell 的 SampleDir 路径里混进制表符。
   后来改成用 `Write` 直接写补丁脚本、用 `chr(92)` 生成反斜杠。
   **教训**：涉及转义的批量编辑，不要用一层套一层的 heredoc。
2. **`const bool near = ...`**：`near`/`far` 是 windef.h 的遗留宏，MSVC 报
   C2513/C2059，报错位置还指在别处。变量名别叫 `near`。
3. **`Tag` 结构体复用没重置**：第一个自闭合标签之后，所有 `<a:t>` 都被当成自闭合，
   整页文字凭空消失。`parse_tag_at` 入口必须 `tag = Tag{}`。
4. **按字节处理中文**：0xA0 续字节那条，本质上是我把"UTF-8 字符串"当成了
   "一堆单字节字符"。这个项目里所有涉及中文的空白、trim、截断都必须按码点。
5. **`FPDFText_GetText` 的压缩输出**：只读了函数名，没读文档那句
   "ignores characters without UCS-2 representations"。
6. **PowerShell 的 `&` 不等 WIN32 子系统程序**：`isg-studio.exe --extract` 返回后
   文件还没写完，判据以"不新鲜"的形态假红。Phase 0 的 guidance1 已经写过这条，
   我还是踩了一次。用 `.NET Process` + `WaitForExit`。
7. **先写实现后搭对拍**：导致大量"改一点、看一眼"的低效循环。
   正确顺序是先搭 oracle 对拍，再改实现。
8. **文档数字从旧一轮复制**：低相似度页举例、UI 判据条数、143 页样本的归因，
   都是"上一轮的结论"写进了"这一轮的文档"。**每个数字都要能从本轮原始件复现。**
9. **把估计说成事实**：我在中间一度写"正文页逐页 >99%"，实际 03-2 第 5 页 0.9726。
   第二路审查指出了这一点。现在文档里写的是"中位数 / 大多数正文页"。
10. **长期记忆**：任务中途我按之前的习惯更新了长期记忆，用户随后明确说
    "本次任务不留存长期记忆"，我回滚了。**这是对的：过程记录应该写进 `docs/`，
    跟着仓库走；memory 是给跨会话的个人上下文用的，不是项目文档的替代品。**

---

## 7. 心路

**① 最想收工的时候，是验证器最绿的时候。**
62 条判据全过、三份 PDF 都跑通、UI 自测全绿——那一刻很像"Phase 2 完成了"。
但第三路审查用两个 mutation 就证明了：**两页整页文字消失，8 条对拍判据仍然全绿。**
如果我当时收工，用户会在某一天发现"有一页内容怎么没了"，而所有测试都是绿的。

**② 这一阶段最难的不是 PDFium API，是"承认 DoD 没达到"。**
我可以把 `medianSim >= 0.99` 写成验收标准，然后说自己完成了；
但纲领写的是"逐页 >99%"。我最终选择把差距写清楚：
正文页中位数 >99%、内容丢失 0、去空白后中位数 1.0，但公式/表格页的顺序差异仍在。
**接受一条可复现的缺口，比伪造一个漂亮的数字更接近"完成"。**

**③ 三路互验的价值不在"再检查一遍"，在"去骗它"。**
第一路找的是代码 bug，第二路找的是"话说满了"，第三路找的是**判据本身的结构性假绿**。
第三路最狠：它不看实现，只看"如果我是一个想蒙混过关的开发者，能不能让这些判据绿"。
答案是能，而且很容易。**判据的强度不等于判据的数量。**

**④ 用户的两次提醒仍然是设计约束。**
"关得干净、不野指针、不漏"直接催生了 worker try/catch、线程回收、zip 上限、RAII 顺序；
"删除要三思"让所有临时清理都走 `_guard.ps1`。这些不是附注。

**⑤ 文档和记忆是两件事。**
这次用户明确说"不留长期记忆"。我回滚了 memory，但把过程写进了 `docs/guidance3.md`。
**项目知识应该跟着仓库走，而不是跟着某个 agent 的会话走。**

---

## 8. 如果换我接手，我会先做这几件事

1. **按顺序读**：`docs/guidance3.md`（本文）→ `docs/phase2-report.md`（结论与数字）→
   `docs/guidance2.md`（Phase 1 的心路）→ `docs/guidance.md` §5。
2. **跑一次完整验证**（含干净构建）：
   ```powershell
   powershell -File tools\fetch-deps.ps1
   powershell -File tools\phase1-verify.ps1 -BuildDir build2 `
       -SampleDir "<samples>"
   ```
   期望 91 条全过、0 跳过。然后**挑一条判据，试着让它失败**：
   - 删掉 `_verify-out/phase2/cpp-03-1.json` 后让程序不写它 → 应该红；
   - 把 `cmp-03-1.json` 的 `medianSim` 改成 0.999999 → 应该红（输入 SHA256 对不上）；
   - 把 `extract.json` 的 `checked` 改成 0、保留 43 条 `[ok]` → 应该红；
   - 在 `views/extract.js` 的副本里把 textarea 改成 div → UI 自测应该红。
   做不到就说明那条判据是散文。
3. **不要急着进 Phase 3**。先接受或裁决 DoD 缺口：
   - 若接受"正文页中位数 >99% + 内容丢失 0 + 栏序一致"，把这句话写进纲领的 Phase 2 验收，
     再进 Phase 3；
   - 若不接受，单独立项做 **PDFium 文本 run 重建**（目标：复刻 pdf.js 的 item 边界），
     不要靠调阈值假装达到。
4. **读 `src/extract/pdf.cpp` 的文件头与 §2.2 的 12 条差异记账**，再动 PDF 代码。
   那里每一条都对应一次实测，尤其是"0xA0 续字节""advance 不是包围盒""PUA 按文本对象"。
5. **`text.js` 的偏离要在 Phase 4 处理**：把切页逻辑搬回 Worker、补
   `tools/check-logic-sync` 的对应项；不要继续在 C++ 里悄悄重写更多"纯逻辑"。
6. **Phase 6 打包前**：确认 `pdfium.dll` 进交付目录、`skill/` 与
   `generation-contract.md` 按 `docs/README.md` 的安排拷入、`dist/` 里没有把
   `third_party` 的调试文件带进去。

---

## 9. 附：这次留下的东西与寿命

| 东西 | 寿命 |
|---|---|
| `src/extract/{extract,pdf,pptx,text}.cpp` + `internal.h` | **长期**。PDF 的取数口径与差异记账在 pdf.cpp 文件头 |
| `src/bridge/bridge.cpp` 的异步队列 + worker 回收 | **长期**。Phase 4 的任务生命周期会复用这个形态 |
| `src/selftest/selftest.cpp` 的 `extract` / `extract-pdf` | **长期**。加了判据就同时改 `phase1-verify.ps1` 的 `expectedCounts` |
| `src/selftest/ui_script.cpp` 的抽取段 | **长期**（11 条：白名单、契约、textarea 编辑） |
| `tools/extract-oracle.js` / `compare-extract.py` | **长期**。Phase 4 的金标准对拍可以复用同一套"输入 SHA256 + 逐页指标"结构 |
| `tools/fetch-deps.ps1`（PDFium/miniz） | **长期**。版本与 sha256 都在里面 |
| `tools/phase1-verify.ps1` | **长期**。Phase 2+ 的判据都往这里加，别另起 |
| `docs/phase2-report.md` | **长期**（结论、数字、差异记账） |
| `docs/guidance3.md`（本文） | **长期**（过程与心路） |
| `_verify-out/`、`_selftest-out/` | 运行期产物，已 `.gitignore`；每次验证重新生成 |
| `third_party/pdfium/`、`third_party/miniz/` | 依赖，已 `.gitignore`；`fetch-deps.ps1` 可重建 |

**最后一句**：这一阶段真正值钱的不是"PDF 能抽出字了"，是
**"判据全绿的时候，两页整页文字仍然可以消失"这件事被记下来了**，
以及那句可以继续往下传的规矩：

> 不要去数判据有几条，要去想：**一个想蒙混过关的人，能不能让它全绿？**
