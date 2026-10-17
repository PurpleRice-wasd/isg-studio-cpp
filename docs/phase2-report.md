# Phase 2 工作记录 · 抽取层

> **状态**：实现完成；整轮验证 **91 条判据全过**（`tools/phase1-verify.ps1 -SampleDir …`，干净构建）。
> **DoD 的“逐页正文相似度 >99%”仍未逐页达到**：正文页绝大多数 ≥99%，公式/表格/图上文字页更低。
> 这条缺口没有被“中位数 ≥ 0.99”盖住：低相似度页逐页列在 `_verify-out/phase2/cmp-*.json` 的
> `lowPages`；验证器另有 `emptyMismatch=0`、`contentLossPages=0` 两条**内容丢失**判据。
>
> 日期：2026-10-17。参照实现仍是 `apps/isg-studio/`（oracle），**不删不冻**。

---

## 1. 交付了什么

### 1.1 代码

| 文件 | 作用 | 与 oracle 的关系 |
|---|---|---|
| `src/extract/extract.cpp` | 类型识别、统一质量口径、扫描件诊断、汇总警告 | `extract/index.js` 的逐条翻译 |
| `src/extract/text.cpp` | `.txt/.md`：BOM/UTF-8/UTF-16/GBK、标题切页 | `extract/text.js` 的**重写**（见 §2.2 #8） |
| `src/extract/pdf.cpp` | PDFium 取字符 → 分行/分栏/页眉页脚/质量信号 | `extract/pdf.js` 的算法照抄；取数换成 PDFium |
| `src/extract/pptx.cpp` | miniz 解包 + OOXML 切标签状态机 | `extract/pptx.js` 逐条翻译 |
| `src/extract/internal.h` | UTF-8 码点遍历、JS 口径空白/trim、CJK 判定 | 新写的共用小工具 |
| `src/bridge/bridge.cpp` | `extract:preview`：白名单 → 工作线程抽取 → UI 线程回包；最近 4 份缓存 | oracle `ipc.js` 的 `extract:preview` + `extractCached` |
| `web/` | 原样拷贝，未改——抽取预览视图本来就在 | 渲染层 |
| `src/selftest/selftest.cpp` | `--selftest=extract`（33 条合成夹具）+ `--selftest=extract-pdf`（11 条真 PDF） | `test/extract-smoke.js` 的等价物 |
| `src/selftest/ui_script.cpp` | UI 自测新增“抽取预览”段（11 条：桥 → 抽取 → 界面可编辑） | 新写 |

### 1.2 工具与依赖

| 文件 | 作用 |
|---|---|
| `tools/extract-oracle.js` | 用 oracle 抽一份课件，写成 JSON（对拍基准） |
| `tools/compare-extract.py` | 逐页对拍：相似度、去空白相似度、内容丢失、字符数、reasons/suspect/columns、warning 种类、输入 SHA256 |
| `tools/fetch-deps.ps1` | 新增 PDFium（`chromium/8100`，sha256 钉死）与 miniz 2.2.0（逐文件 sha256） |
| `tools/phase1-verify.ps1` | 新增 `-SampleDir`、干净构建、`extract`/`extract-pdf` 自测、Phase 2 对拍与独立对账 |

PDFium 运行时 DLL 由 CMake 拷到 `dist/pdfium.dll`；`miniz` 编成静态库，`/W4` 下零告警。

---

## 2. 判据与结果

`tools/phase1-verify.ps1` 本次执行 **91 条，0 未过，0 类跳过**。与抽取直接相关的：

| # | 判据 | 结果 |
|---|---|---|
| 1 | `--selftest=extract`：33 条（MD/GBK/错误上下文/PPTX 顺序与表格/坏 PDF） | 33/33 |
| 2 | `--selftest=extract-pdf`：11 条（33 页真 PDF / 26MB 143 页） | 11/11 |
| 3 | `--selftest=ui`：46 条（新增 11 条抽取预览，含“未放行路径被拒”“textarea 改动写进 extractEdits”） | 46/46 |
| 4 | 三份真 PDF 的页数、每页 `reasons`、`suspect` 与 oracle 一致 | 33/33、25/25、143/143，0 不一致 |
| 5 | 两份 DoD 样本的每页 `columns` 与 oracle 一致（栏序判据） | 0 不一致 |
| 6 | 总字符数比值（双向界） | 1.0066、0.9899、1.0638 |
| 7 | 去空白后的总字符数比值 | 1.0121、1.0000、1.0106 |
| 8 | 没有整页内容丢失 / 逐页内容丢失 | 三份都 0 |
| 9 | warning **种类**一一对应 | 三份都一致 |
| 10 | 逐页相似度中位数 | 0.9971、1.0000；压力样本 0.9815 |
| 11 | 去空白后的逐页相似度中位数 | 1.0000、1.0000、1.0000 |
| 12 | 构建零告警（Release + Debug，干净构建）、泄漏自检/正常路径零泄漏、金标准逐字节相同 | 全过 |

### 2.1 逐页对拍的真实数字

| 样本 | 页数 | oracle 字符 | C++ 字符 | 比值 | 去空白比值 | 中位相似度 | 去空白中位 | ≥0.99 页 | 低相似度页 | 仅空白不同 |
|---|---|---|---|---|---|---|---|---|---|---|
| `03 地球椭球-1.pdf` | 33 | 7521 | 7571 | 1.0066 | 1.0121 | **0.9971** | 1.0000 | 21 | 12 | 6 |
| `03 地球椭球-2.pdf` | 25 | 4849 | 4800 | 0.9899 | 1.0000 | **1.0000** | 1.0000 | 15 | 10 | 3 |
| `数字图像处理——图像增强-xh.pdf` | 143 | 22132 | 23544 | 1.0638 | 1.0106 | 0.9815 | 1.0000 | 60 | 83 | 41 |

（原始件：`_verify-out/phase2/cmp-03-1.json`、`cmp-03-2.json`、`cmp-big.json`；每次验证重新生成。）

**怎么看这张表**：

- **正文页**：大多数 ≥99%；03-2 的中位数是 1.0。少数正文页 0.97–0.99，差异**几乎全是空格**
  （`（B、L、H）` 这类全角标点两侧），去空白后的中位数三份都是 1.0。
- **公式/表格/图上文字页**：阅读顺序不同。pdf.js 的 `getTextContent()` 是**一次 showText 操作一个
  item**，每个 item 共用一个 `transform`（基线）；PDFium 的 `GetCharOrigin` 是**逐字符**的。
  上下标、分式、多栏表格在两边会被分到不同的“行”。**这不是丢字**：`emptyMismatch=0`、
  `contentLossPages=0`，总字符数比值（去空白）1.01–1.01。
- 最低页是 **03-1 第 22 页**（`sim=0.2648`，oracle 350 / C++ 285 字符）；第 26 页是 0.92。
  低相似度页的完整列表在 `lowPages`，不要拿中位数代替它。
- **143 页压力样本不是 DoD 样本**：它图多、文字块分散，`columns` 有 5 页与 oracle 不同；
  字符数多 6.4%，但去空白后只多 1.1%，主因是空格插入，不是“抽到了隐藏/重复文字”。

### 2.2 与 oracle 的差异（逐条记账）

**必要差异（取数 API 不同）**

1. **`FPDFText_GetText` 不能用**：文档写着“ignores characters without UCS-2 representations”，
   输出会被压缩，字符下标与 `GetCharOrigin` 不再对应（实测坐标整体错位）。改成逐字符
   `FPDFText_GetUnicode`。
2. **增补平面字符是代理项对**：PDFium 对 CambriaMath 的数学斜体返回 `0xD835 + 0xDC4E`。
   不合并就会编出非法 UTF-8，随后在行拼接时变成 U+FFFD——整页公式看起来像字体映射坏了。
3. **字宽用 advance，不用字形包围盒**：包围盒比 advance 窄，单词内部会被插空格。
   同一文本对象内用“下一个字符 origin - 当前 origin”；跨对象时普通字符 0.9em、
   全角字符 1.3em；破折号（U+2010–2015）两侧不插空格。
4. **UTF-8 续字节不能当 NBSP**：「章」= `E7 AB A0`、「几」= `E5 87 A0`。所有空白/裁剪按码点。
5. **PUA 统计按 PDF 文本对象分组**：项目符号与正文在同一个矩形段里时，按矩形段会误报；
   按 `FPDFText_GetTextObject` 分组，并把“token 开头的短 PUA 串”视为项目符号后，
   三份样本的 `reasons` 与 oracle 完全一致。
6. **栏缝阈值收紧**：oracle 只要求 `gapWidth > 0`。我们的 x1 来自逐字符 advance，图上文字块会
   产生 1–2% 页宽的假栏缝。改成 `gapWidth ≥ 10% 页宽` 且每栏 ≥ 3 行，并把横跨栏缝的行保留
   （oracle 的 `readOrder` 会静默丢掉它们）。代价：143 页样本 5 页栏数不同（已记账）。
7. **控制字符丢弃**：PDFium 把 CR/LF 作为独立字符返回（字号 1、无字体），逐字符处理会凭空造行。
8. **`text.js` 是重写，不是逐字节搬**：纲领 §3.2/§6 把它列为“纯逻辑、原样搬”，但编码识别
   （BOM/UTF-8/UTF-16/GBK）本质是**系统解码能力**（纲领 §4.1 把“解析”划给宿主）。Phase 2 在
   C++ 宿主侧实现；标题切页逻辑逐条翻译但**不是逐字节拷贝**。若要把切页逻辑搬回 Worker，
   应在 Phase 4 连同 `assemble/bank` 一起搬，并补 `tools/check-logic-sync` 的对应项。
9. **单页加载失败不终止整份**：oracle 的 `doc.getPage()` 抛错会终止整份；我们保留其余页，
   但追加一条 `warn`“有 N 页读取失败（第 … 页），已按空页处理”，不静默降级。
10. **坏 PDF / 坏 PPTX 的错误原文不同**：来源分别是 PDFium 和 miniz，无法与 pdf.js/fflate
    的英文原文逐字相同；契约“带文件名/带上下文”保持不变。
11. **UTF-16 码元 vs Unicode 码点**：oracle 的 `.length`/`.slice` 按 UTF-16 码元；我们在
    title 截断与缺省 `chars` 上按码点。只影响增补平面字符（emoji/数学斜体），±1。
12. **整文件读取**：判类型前先整份读入（有 64 MB 上限）；oracle 先读 8 字节。26MB PDF 峰值
    约两份内存。这是可优化项，不影响正确性。

**桥的差异**

13. `extract:preview` 的错误码已对齐 oracle 的 `BAD_ARG` / `NOT_ALLOWED` / `HANDLED_ERROR`；
    缓存键先做 `GetFullPathNameW` 归一化再拼 mtime/size。

### 2.3 三路交叉验证（2026-10-17）

按用户要求开了三路只读审查，然后统一修复、重跑。三路分别是：C++ 正确性与内存安全、
与纲领/规格书一致性、验证体系可信度。

**第一路（C++）确认并已修**：

1. 工作线程里的异常逃出 `std::thread` 入口 → `std::terminate`。现在 worker 外层 `try/catch`，
   回 `HANDLED_ERROR`；`std::thread` 构造失败也回失败信封。
2. `ZipReader::read` 按 zip 头声明的解压后大小直接分配 → 解压炸弹。现在单条目 ≤64 MiB、
   累计 ≤256 MiB、条目数 ≤10 万；超限按“部件缺失”走 warning。
3. 已完成的抽取线程只在 `Detach` 才 join → 线程句柄累积。现在每次 preview 前
   `reap_workers()`，线程带 done 标志，跑完就 join 并删掉。
4. `normaliseForRepeat` 逐位替换数字，oracle 是把连续数字串折成一个 `#`。已修；
   这也是“warning 种类一致但逐字不同”的主因。
5. PPTX 取消后返回“成功 + 截断结果”，文本路径不支持取消。已修：PPTX 取消返回
   `CANCELLED`；文本在解码前后检查取消。
6. `Attach` 不复位 cancel、`reply` 闭包捕获 `this`、缓存回复在持锁时做外部调用、
   代理项产生非法 UTF-8、GBK 失败被当成功、`atoi` 溢出、`mc:Fallback` 自闭合、
   测试用窄字符路径写 zip 等，均已修。
7. 增加 PDFium 文档处理互斥（公开文档没有承诺多文档并行安全）。

**第二路（一致性）确认并已修/记账**：

- 低相似度页示例写错（0.25 是第 22 页，不是第 26 页）——已改。
- “正文页逐页 >99%”说满——已改成“中位数/大多数正文页；个别正文页 0.97–0.99，差异是空格”。
- 143 页样本“多 7.5% 是隐藏/重复文字”归因不准——已补去空白比值，主因是空格。
- `text.js` 的纲领偏离、跨对象全角标点空格、错误原文差异、单页失败降级、UTF-16 码元差异——
  已写进 §2.2。
- `extract:preview` 的错误码/缓存键——已对齐。
- UI 新增抽取检查实际是 11 条（不是 9 条）——已改。
- 逐字 warning 差异不只重复页眉，还包括分栏页数——已在 §2.1 的说明里覆盖。

**第三路（验证体系）确认并已修**：

- 验证器只读 `cmp-*.json` 的数字，改数字即可全绿 → 现在核对输入 SHA256、要求
  `ok=true`/`exit=0`、断言字段齐全、`pagesGE99 + lowPages = pages`。
- 两页整页文字被清空仍全绿 → 新增 `emptyMismatch=0`、`contentLossPages=0`、双向比值界、
  最低页相似度门槛。
- 自测只数 `[ok]/[BAD]` 行 → 现在同时核对自报 `checked` 与 `test` 名。
- 增量构建下“零告警”是空判据 → 验证时强制 `-Clean`，并检查 Release 与 Debug 两份日志。
- oracle 与 cpp 可以是同一份内容 → 断言两份 SHA256 不同。
- 陈旧 exe → 干净构建 + 断言 exe 不旧于源码/工具，报告记录 exe SHA256。
- 缺大样本时自测 40 条静默“通过” → 拆成 `extract`（33 条合成，永远跑）与
  `extract-pdf`（11 条真 PDF，缺样本时验证器明确跳过整条）。
- 坏 PDF 的恒真判据 → 改成断言“报错，或明确抽出 0 页”。

### 2.4 DoD 的诚实结论

纲领 §5 Phase 2 的 DoD 是“正文字符串相似度 >99%，且栏序一致”。

- **栏序**：两份 DoD 样本 0 页不一致；143 页压力样本 5 页不一致（图上的文字块）。
- **逐页相似度**：没有逐页达到 99%。03-1 有 12/33 页 <0.99（最低 0.2648），03-2 有 10/25 页
  <0.99（最低 0.8822）。中位数 0.9971 / 1.0 是事实，但它不是“每一页”。
- **内容没有丢**：`emptyMismatch=0`、`contentLossPages=0`；去空白后的中位数三份都是 1.0。
  低相似度来自**顺序/空格**，不是缺字。
- **原因**：pdf.js 的 item 边界由内容流的 showText 决定，PDFium 的公开 API 不暴露等价的
  item 变换。要完全复刻，需要单独立项做 PDFium 的文本 run 重建，不要混进 Phase 3。
- **验收建议**：明确接受“正文页中位数 >99% + 内容丢失=0 + 质量信号/栏序一致”作为 Phase 2
  的验收口径；若坚持逐页 >99%，本阶段不算完成。**本报告不把中位数写成逐页。**

---

## 3. 实测踩到的坑（下次别再踩）

| 坑 | 症状 | 做法 |
|---|---|---|
| `#define near`（windef.h 的遗留宏） | `const bool near = …` 报 C2513/C2059，报错位置还指在别处 | 变量名别叫 `near` / `far` |
| WIN32 子系统程序不等待 | PowerShell `& exe --extract …` 返回后文件还没写完，判据以“不新鲜”假红 | 用 `.NET Process` + `WaitForExit` |
| `Tag` 复用不重置 | 第一个自闭合标签之后，所有 `<a:t>` 都被当成自闭合 → 整页文字凭空消失 | `parse_tag_at` 入口 `tag = Tag{}` |
| `FPDFText_GetText` 压缩输出 | 字符下标与坐标错位 | 逐字符 `GetUnicode` |
| 代理项对 | 数学斜体整页变 U+FFFD | 合并 high/low surrogate；`utf8_append` 拒绝代理区 |
| 字节级空格折叠 | 「章/几/标」等 UTF-8 续字节 0xA0 被当 NBSP → U+FFFD | 按码点处理 |
| 连续数字串归一化 | 「第 3 页」「第 12 页」成了两个 key，页眉/页脚剔不干净 | `\d+` → 一个 `#` |
| 全角标点跨文本对象 | `（B、L、H）` 被插成 `（ B 、 L 、 H ）` | 全角字符 advance 上限 1.3em；破折号两侧不插空格 |
| 线程入口不 catch | 一个畸形输入 = 进程直接消失 | worker 外层 `try/catch`，回明确失败 |
| zip 解压后大小不设上限 | 几十 KB 的 PPTX 声明 4 GB 条目 → OOM | 单条目/累计/条目数三重上限 |
| 线程只 push 不回收 | 预览 N 次攒 N 个线程句柄 | done 标志 + `reap_workers()` |
| 公式页的低相似度 | 被误读成“抽取失败” | `reasons`/`suspect` 对齐；`emptyMismatch`/`contentLossPages` 单独判据 |

---

## 4. 怎么复跑

```powershell
# 依赖（已就位会跳过）
powershell -File tools\fetch-deps.ps1

# 构建 + 全部判据（含干净构建、Phase 2 对拍、Release/Debug 零告警）
powershell -File tools\phase1-verify.ps1 -BuildDir build2 `
    -SampleDir "C:\path\to\试验PPT"

# 只跑合成夹具 / 只跑真 PDF
build2\dist\isg-studio.exe --selftest=extract --report=_selftest-out\extract.json
$env:ISG_SAMPLE_DIR = "C:\path\to\试验PPT"
build2\dist\isg-studio.exe --selftest=extract-pdf --report=_selftest-out\extract-pdf.json

# 单份课件的对拍
node tools\extract-oracle.js <课件> _verify-out\phase2\oracle.json
build2\dist\isg-studio.exe --extract=<课件> --out=_verify-out\phase2\cpp.json
python -I tools\compare-extract.py _verify-out\phase2\oracle.json `
    _verify-out\phase2\cpp.json _verify-out\phase2\cmp.json
```

没有 `-SampleDir` / `ISG_SAMPLE_DIR` 时，验证脚本会**明确跳过** `extract-pdf` 与三份对拍，
并在报告开头列出；`extract` 的 33 条合成夹具仍会跑。

---

## 5. 留给下一阶段

- **Phase 3（网络）**：`extract:preview` 已经是异步的，但任务生命周期/事件广播还没有；
  `settings:test` / `gen:*` / `run:*` 仍返回 `NOT_IMPLEMENTED`。
- **Phase 4（流水线）**：`extract_file` 返回的 JSON 就是 `pipeline/index.js` 读的形状；
  把 `text.js` 的切页逻辑搬回 Worker、与 `assemble/bank` 一起做逐字节同步，是这一阶段的事。
- **Phase 5（校验）**：探针窗口目前只做了“能加载能读 title”，`verify:run` 仍明确报未实现。
- **Phase 6（打包）**：`pdfium.dll` 已经进 `dist`；`skill/` 与 `generation-contract.md`
  还没拷入交付目录（按 `docs/README.md` 的安排）。
