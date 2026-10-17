# guidance4 · Phase 3 + Phase 4 工作记录（合并版）

> **📌 按用户要求，正式交接记录已拆成两份、与 guidance1/2 同形**：
> Phase 3 见 [`guidance5.md`](guidance5.md)，Phase 4 见 [`guidance6.md`](guidance6.md)。
> 本文保留为**跨阶段的合并摘要**（尤其是"三路互验后的修复"与"仍未修的边界"），
> 细节与心路以 guidance5/6 为准。

> **作者**：接手这次 C++ 重写、完成 Phase 3/4 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、当时怎么想的、怎么定位的、
> **我怎么发现自己是错的**。判断与路线仍以 [`guidance.md`](guidance.md) 为准；
> 结论与数字在 [`phase3-report.md`](phase3-report.md) 与 [`phase4-report.md`](phase4-report.md)。
>
> 与前几份的关系：guidance1 是 Phase 0，guidance2 是 Phase 1，guidance3 是 Phase 2，
> 这一份是 Phase 3 + 4。前几份留下的三条自我提醒——**最难的是不让自己被骗、
> 默认倾向是相信自己的判据、倾向于把话说满**——这一轮又都出现了，只是换了形态。

---

## 0. 一句话

Phase 3/4 把网络、任务生命周期、流水线和拼装接起来了。**最值钱的不是"跑通了"**，
而是过程中抓到的几类"看起来在跑、其实消息全丢了"的失效：

- 页面侧的 `jobs.log()` 只发了 `{op:'log'}`，没写 `kind:'pipeline'`。C++ 按 `kind` 路由，
  于是**日志与状态事件全部被丢掉**，只有显式写了 `kind` 的写文件消息到达。
  现象是"产物已经写出来了，任务却永远停在 pending"。
- `jobs.finish` 里一句 `j["htmlPath"].value("", std::string())`：`htmlPath` 是字符串，
  nlohmann 的 `.value()` 只能用在对象上 → 抛 `type_error.306` → 宿主没有顶层 catch →
  0xC0000409。**判据全绿之前，进程先死了。**
- `preview.allow(outDir)` 放行的是输出目录**本身**，而路径校验要求"严格在 outDir 之下"，
  于是目录本身被拒。产物照常写（写文件走的是父目录前缀），但预览打不开。
- `run-mock-selftest.py` 把 `--net-requests` 只传给了 exe，忘了传给服务进程 →
  服务把请求记录写到别处，宿主读到 0 条。判据当场红，但红得很有教育意义：
  **同一份路径参数，两个进程都要给。**

## 1. 我按什么顺序做

1. **先定架构**：再读一遍纲领 §6 的模块映射表。`llm/index.js` 与 `pipeline/index.js`
   都写着"拆"——状态机/策略搬进 JS，传输/生命周期留 C++。于是先写
   `web/logic/shims/runtime.inc.js`（浏览器垫片）与 `pipeline-host.js`，
   再写 C++ 的 `net/` 与 `pipeline/jobs`。
2. **先搬、再改**：把 pipeline/prompts/sources/chapters/revive/llm-* 原样复制进
   `web/logic/`，用 `sync-web.ps1` 的 `$logicSourceMap` 管起来，用
   `bundle-logic.js` 生成浏览器 bundle。**没有为了"方便"改 oracle 任何一行。**
3. **先搭对拍/测试，再补细节**：Phase 2 的教训是"先写实现后搭对拍"。
   这次先写 `net-fault-server.js` 与 `mock-provider-server.js`，让每一次改动都有
   一个会红的判据。
4. **最后接界面**：`gen:*` 接进桥，`settings:test` 交给页面里的 llm 层，
   取消同时关 WinHTTP。

## 2. 那些"看起来对、其实错"的时刻

### 2.1 消息没有 `kind`

`jobs.log()` 写的是 `post({ op:'log', entry })`；runtime 的 `post()` 只在
`msg.kind === 'pipeline'` 时才补 `jobId`，**并没有补 `kind`**。
C++ 的 `OnWebMessage` 按 `kind` 分发，`kind` 为空 → 既不是 `invoke` 也不是
`pipeline` → 被当成畸形消息丢掉。写文件消息因为显式写了 `kind:'pipeline'`，反而是好的。

**定位过程**：先看到"HTML 已经产出、`gen:get` 里 status 永远是 pending、logs 只有创建那一条"。
这组事实说明"产物写成功了，但事件没到"。把 `post()` 的字段打印出来，才看到 `kind` 缺失。

**修法**：`post()` 里 `if (!msg.kind) msg.kind = 'pipeline'`。
**教训**：一条私有协议有两个入口（显式写 kind / 不写），就一定有一条会漏。
    要么强制一个入口，要么在入口处补默认值。

### 2.2 `.value()` 用在字符串上

`jobs.finish` 里有一句我本来想"顺手判一下 htmlPath 在不在"的代码：

```cpp
if (!j.contains("htmlPath") || j["htmlPath"].value("", std::string()).empty()) { }
```

`htmlPath` 是字符串，`ordered_json::value()` 只能用于对象 → `type_error.306`。
宿主侧没有顶层 try/catch → `std::terminate` → 退出码 **0xC0000409**。
更讽刺的是：异常发生在 `op:'finish'`，而**前面 15 条日志、产物、审题都成功了**；
如果只看"文件写出来了"就收工，交付的会是一个"一跑完就崩"的程序。

**修法**：删掉那句（它本来什么也没做）。**同时**在 `WirePipeline` 的 `pipeline` /
`http-fetch` 两个入口加了 `try/catch`：页面消息是不可信输入，宿主不能因为一个类型异常
把整个收尾路径跳过。这条也是用户"关得干净"要求的直接落点。

### 2.3 放行目录本身被拒

`ValidateOutputPathLocked` 的比较是"以 `outDir\` 为前缀"。`preview.allow(outDir)` 传的
正是 `outDir` 本身（没有尾斜杠），于是 `a.size() < root.size()` 为真 → 拒绝。
写文件不受影响（写的是 `outDir\文件名`），所以**产物正常、预览打不开**。
修法：先判 `a == outDir`，再判前缀。

### 2.4 取消的最终状态是 failed

在途取消时，llm 层抛出 `LlmError{code:'EABORTED'}`，没有 `canceled` 标志；
`pipeline` 的 `askJson` 只在 `e.canceled` 时走取消分支，否则按"模型调用失败"处理。
结果是任务在约 0.26 秒内结束，但状态是 **failed**。

**修法**（**不改 oracle 文件**）：在 `pipeline-host.js` 里给 llm 模块包一层，
把 `EABORTED` / `signal.aborted` 补成 `canceled=true`。
这是宿主适配层，不是对纯逻辑的修改；差异写进了 Phase 3 报告 §5.3。

### 2.5 大快照会被静默丢弃

Phase 1 的实测结论是：WebView2 单条消息有大小限制（161 KB 的字符串收不到）。
流水线在运行中会给 `job.sources[i].pages` 挂上**整页正文**（26 MB 的 PDF 可以到几 MB），
`options.editedPages` 也可能很大。如果 `jobs.finish` 把这些原样回传，
任务会"跑完了但界面永远停在 running"——而且没有任何报错。

**修法**：`summary()` 剥掉 `sources[].pages` / `scopedPages` / `note`、
`options.editedPages`、`outputs[].report`；`gen:get` 只带最近 120 条日志。
**教训**：消息边界上的"大对象"不是性能问题，是正确性问题。

### 2.6 测试脚手架自己的三个坑

1. **`--net-requests` 只传给了 exe**：服务进程也需要它（`argv[2]`），否则请求写到别处，
   宿主读到 0 条（判据红）。
2. **`slow` 模式的位置**：服务端约定 `argv[2]=请求记录文件`、`argv[3]=模式`。
   只传 `slow` 会让它把 `slow` 当成文件名，而且根本不进慢模式。
3. **陈旧报告**：`-SkipBuild` 下如果 exe 没跑起来，盘上会留着上一份报告。
   验证脚本在每项之前删报告；手工跑时也要先删。

## 2.7 三路交叉审查（交付前）与修复

按用户要求开了三路只读审查：C++ 正确性/并发、JS 流水线/垫片保真度、
验证体系可信度。审出来的问题**比自测多得多**，其中几条是"判据全绿时功能已经坏了"：

**已修（高优先级）**：
1. `_pipeline:jobInfo/jobPart` 复用了给界面瘦身的 `Get()` → `options.editedPages`
   在进入流水线前就被剥掉，而且 finish 还会把宿主那份一起抹掉。现在 `Get(id, forPipeline)`
   分开，`finish` 的 snapshot 改成**白名单 + 类型检查**合并，并显式跳过
   `options/sources/ask/report`。
2. `settings:test` 首次使用必失败：`onHostRequest` 没有把 env 交给 bundle，fetch 垫片
   反推不到 providerId。已在 `onHostRequest` / `__isgTestChat` 里 `setEnv`。
3. `logic-bundle.js` 过期（16K 分块修复没进 bundle）。最终构建前重新生成；
   验证脚本的 bundle 新鲜度判据会盯住它。
4. `authField:'query'` 时把**真 Key** 放在 `http-head.url` 回给页面。现在回的是
   注入前的 URL。
5. 抽取结果 / `gen:get` 这类大回包不分块 → 页面 Promise 永远不 settle。桥的回包层
   现在对 >48 KB 的 `data` 自动分块（`reply` / `reply-chunk` / `reply-end`），
   页面侧拼装后再 JSON.parse。
6. `gen:start` 没有 oracle 的选项别名与 `settings.generation` 合并 → 工作台的
   「作答点目标数」滑杆和「章标题」输入完全无效。已在 `JobStore::Create` 里实现
   `quizTarget→points` / `chapterNo→number` / `chapterTitle→title` / `pet:'own'→'image'`。
7. `fs.copyFileSync` 发 `{from,to}`、C++ 读 `path` → 复制永远失败并把任务判 failed。
   现在 C++ 读 `to`，并对 `from` 做 `protocol_is_allowed`。
8. ask 语义：取消用 `undefined` 而不是默认值、`settleAsk` 不清 `job.ask`、
   finish 快照把旧 ask 写回。已对齐 oracle（`_askDefault`、清 `job.ask`、
   不重复发 `askSet`）。
9. 取消的最终状态是 failed：EABORTED 被 `buildNetworkError` 改写成 ETIMEOUT。
   现在 shim 用 `name:'IsgAborted' + code:'EABORTED'`，包装层据此补 `canceled=true`。
10. 并发任务串档：C++ 现在拒绝第二个 running/pending 任务；页面全局 `currentJobId`
    不再被覆盖。
11. `history.json` 是用户可手改文件：所有读取改成类型安全；坏文件改名留证，
    不再被下一次保存静默覆盖。
12. `gen:start` 前补 `NO_MODEL` / `NOT_FOUND` 检查；`RequestPage` 加 15 秒超时；
    内部消息入口加 `try/catch`；`get_Source` 失败改为 fail-closed；
    分块偏移先夹到剩余量；UNC 路径保留双反斜杠；WinHTTP 超时对齐 180s；
    写文件 end 带块数/字节数供宿主对账；取消/失败时 `htmlPath` 在写盘时就记下。
13. 验证体系：net-fault 与 cancel 的请求记录分开；泄漏报告与自测人类报告不同名，
    并断言 `checked`/`exit`；pipeline 产物检查 mtime 新鲜度；cancel 断言服务端看到
    连接提前断开；runner 隔离用户的 `*_API_KEY` 与 `.env`；外层等待 180s > 内层 100s；
    删除请求记录前断言路径在 `_verify-out`/TEMP 内。

**仍然记账、没修**：
- 两个提供商共用同一个 `baseUrl` 时，fetch 垫片按 URL 反推 provider 可能选错 Key
  （同域，宿主 origin 校验拦不住）。真实用户很少这样配；要做需要给请求带唯一 provider 标识。
- `store.providerConfig` 垫片没有 preset 兜底（baseUrl/name），错误文案与 oracle 略不同。
- `keycompat`/`keywrite` 报告没有预删与 `checked` 核对；`ReadToEnd` 仍有理论上的
  管道死锁（本次未改，风险低）。
- 多审计人 / split 模式的端到端测试仍未做（oracle 的 mock 已支持 `auditMode:'split'`）。
- `signature` 以外的 Anthropic 请求形状、`numeric-cases` 页面级仍属 Phase 5 探针范围。

## 3. 判据之外的缺口（如实记账）

| 缺口 | 现状 | 什么时候补 |
|---|---|---|
| `verify` / `repair` | 垫片明确抛 "Phase 5 才实现"，流水线记 warn，阶段跳过 | Phase 5 |
| 多章 / 带上以前的章 / 旁挂 `.isg.json` | `book` 垫片返回 `ok:false`；`runGeneration` 记 warn | Phase 6 |
| `text.js` 的切页逻辑 | 仍在 C++（Phase 2 已记账） | 单独立项 |
| `numeric-cases` / `hostile-input` 页面级 | 需要 Phase 5 探针窗口；引擎本身逐字节未改 | Phase 5 |
| `emitted>0` 后不重试 | 沿用 oracle 代码，未单独造故障验 | 可补 |
| Anthropic 请求形状 | 适配器逐字节复制，宿主只按 `anthropic-version` 注 Key | 可补 |
| `run:scanCleanup` / `doCleanup` | 仍 `NOT_IMPLEMENTED`（取消选"清除"会走到它） | Phase 6 |

## 4. 心路

**① "产物写出来了"不等于"流水线跑对了"。**
前半段的 HTML 一直好好地产出，而任务状态永远是 pending、日志永远只有一条。
如果我当时按"能打开、看着正常"收工，用户会在运行页看到一个永远转圈的任务。
**判据要覆盖"状态"和"产物"两条线，不能只看其中一条。**

**② 最危险的不是没实现的阶段，是"实现了但静默丢消息"的阶段。**
`verify` 未实现会明确记 warn；而 `kind` 缺失、快照超限这两种失效**一声不响**。
这正是 Phase 0 就写下的那条：静默失效比报错可怕。

**③ 用户的两条硬要求又一次直接变成了设计约束。**
"关得干净"催生了 `NetManager::Shutdown()`（取消 + join 全部工作线程，
排在 `bridge_.Detach()` 之前）、入口 try/catch、以及"页面消息是不可信输入"的兜底；
"删除要三思"让验证脚本继续只删 `_verify-out/` 下自己刚产生的东西，
Python runner 清请求记录前也只动传进来的那份路径。

**④ 逐字节搬 + 垫片，比"翻译成 C++"省心得多。**
prompts、计票、校验器都没有重写；C++ 只做传输、生命周期与安全边界。
代价是引入了一层垫片，但垫片的问题都能用"页面上跑一遍"当场暴露
（`kind` 缺失、`.value`、快照超限都是这样暴露的）。

## 5. 如果换我接手，我会先做这几件事

1. 读 `phase3-report.md` / `phase4-report.md`，再读这一份。
2. 跑 `tools/phase1-verify.ps1 -SkipBuild -SkipKeyCompat`，确认外层判据全绿、
   且三项新自测的**子判据条数**与 `expectedCounts` 一致（net-fault 26 /
   pipeline-mock 23 / pipeline-cancel 9）；然后**挑一条试着让它失败**：
   - 把 `web/logic/shims/runtime.inc.js` 的 `if (!msg.kind)` 那行删掉 → pipeline-mock 应该红；
   - 把 `run-mock-selftest.py` 里给服务的 `--net-requests` 删掉 → net-fault 应该红；
   - 把 `net-fault-server.js` 的 `data: 0` 保活行去掉 → **不应该红**（它是在防回归，
     去掉不会让当前 LLM 状态机失败；想验它，得把 llm 层换回旧版本）。
3. Phase 5 的第一件事不是写探针驱动，而是**把 `verify/runner` 的垫片换成真实现**，
   让 `repairRound` 真的跑起来；否则 Phase 4 的 `repair` 永远是 skipped。
4. 不要把 `pipeline.js` 的"大字段裁剪"再放回去。消息边界不是无界的。
5. 所有新的 `.ps1` 仍然必须带 UTF-8 BOM；`python tools/check-ps1-encoding.py` 已经挂在验证里。

**最后一句**：这一阶段最值钱的产出不是"流水线能生成页面了"，
是**"产物写出来了、任务却永远 pending"这件事被记下来了**，以及下一条可以继续传的规矩：

> 每一条私有消息协议，都要有一个**入口处补默认值**的地方；
> 每一个跨消息边界的大对象，都要先问一句"它会不会超过单条消息的上限"。
