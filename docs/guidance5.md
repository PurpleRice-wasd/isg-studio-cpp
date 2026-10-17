# guidance5 · Phase 3 工作记录与接手笔记

> **作者**：接手这次 C++ 重写、完成 Phase 3 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、当时怎么想的、怎么定位的、
> **我怎么发现自己是错的**。判断与路线仍以 [`guidance.md`](guidance.md) 为准；
> 结论与数字在 [`phase3-report.md`](phase3-report.md)。
>
> 与 guidance1/2/3 的关系：那三份分别是 Phase 0 / 1 / 2。这一份是 **Phase 3（网络与任务）**，
> 配套的 Phase 4 记录是 [`guidance6.md`](guidance6.md)。
> guidance1 §9 的三条自我提醒——**最难的是不让自己被骗、默认倾向是相信自己的判据、
> 倾向于把话说满**——这一轮又全部出现了，而且换了新的形态。

---

## 0. 一句话

Phase 3 把 **LLM 网络层、SSE、重试/降级、任务生命周期、事件广播、取消**接起来了。
**最值钱的不是"能调模型了"**，而是过程中抓到的几个"看起来在跑、其实消息全丢了"的失效：

- 页面侧的 `jobs.log()` 只发了 `{op:'log'}`，没写 `kind:'pipeline'`。C++ 按 `kind` 路由，
  于是**日志与状态事件全部被丢掉**，只有显式写了 `kind` 的写文件消息到达 ——
  现象是"产物已经写出来了，任务却永远停在 pending"。
- `jobs.finish` 里一句 `j["htmlPath"].value("", std::string())`：`htmlPath` 是字符串，
  nlohmann 的 `.value()` 只能用在对象上 → 抛 `type_error.306` → 宿主没有顶层 catch →
  **0xC0000409**。判据全绿之前，进程先死了。
- 取消时 llm 层抛 `LlmError{code:'EABORTED'}`，没有 `canceled` 标志；pipeline 只在
  `e.canceled` 时走取消分支，于是用户点了取消，任务最终显示 **failed**。

这一阶段真正学到的东西，可以压缩成一句：

> **一条私有消息协议，必须在入口处补默认值；一个跨消息边界的大对象，必须先问它会不会超限。**

## 1. 我接手时仓库长什么样

- `apps/isg-studio/`：完整的 Electron 版（oracle），**不删不冻**。
- `apps/isg-studio-cpp/`：Phase 0/1/2 已完成。`src/` 下有 app/shell/bridge/settings/util/extract/selftest，
  `web/logic/` 里只有 `bank.js` / `assemble.js`（金标准对拍用）。
- 没有任何 `src/net/`，没有任务生命周期，`settings:test` / `gen:*` 全是 `NOT_IMPLEMENTED`。
- `tools/phase1-verify.ps1` 已经是很成熟的验证器：91 条判据、报告先写"运行中"、
  每项先删旧报告、独立数 `[ok]/[BAD]`、金标准逐字节、泄漏先自证会响。
- 真实课件在 `<samples>\`（后来用它跑了 PDF 对拍）。

**我的第一件事不是写 C++**。我先把纲领 §4/§6、guidance2 §11、guidance3 §8 和 oracle 的
`llm/index.js`、`jobs.js`、`preload.js` 读了一遍。理由很实际：
`llm/index.js` 的注释里记着三个真实回归 bug，`jobs.js` 里记着"历史只写不读"的坑；
自己重新设计一遍只会把它们再踩一遍。

## 2. 我按什么顺序做

1. **先定架构**：纲领 §6 写得很清楚——
   `llm/index.js` 是**拆**：SSE 状态机/重试/降级 → 原样搬进 Worker；`fetch` 传输 → C++。
   于是先写 `web/logic/shims/runtime.inc.js`（浏览器垫片）与 `pipeline-host.js`，
   再写 C++ 的 `net/` 与 `pipeline/jobs`。**没有在 C++ 里重写 SSE。**
2. **先立骨架，再填肉**：`channels`/`bridge` 已有的纪律不动；新增 `_pipeline:*` 内部通道，
   与 31 个公开通道分开（否则"通道数是 31"这条判据就没意义了）。
3. **先用 oracle 的假模型搭测试，再补细节**：`test/mock-provider.js` 本来就是独立 HTTP 服务，
   C++ 照样连；再写一个 `tools/net-fault-server.js` 注入 400/429/切包。
4. **最后接界面**：`gen:*` 接进桥，`settings:test` 交给页面里的 llm 层，取消同时关 WinHTTP。

顺序上我犯了一个错：**先写实现，后写 net-fault**。Phase 2 的 guidance3 已经写过
"先把对拍搭起来"，我还是先写了传输层。结果是前两轮调试全靠"看日志猜"，
直到故障服务能按顺序回 400/400/429/200，才第一次有"改一下就知道对不对"的闭环。
**下一任别重复。**

## 3. 架构：为什么 SSE 留在 JS，C++ 只搬字节

```
web/logic/llm-index.js     ← oracle 的 llm/index.js，逐字节复制
web/logic/llm-openai.js    ← oracle 的 llm/openai.js
web/logic/llm-anthropic.js ← oracle 的 llm/anthropic.js
web/logic/providers.js     ← oracle 的 providers.js

web/logic/shims/runtime.inc.js ← 本工程新写：fetch → postMessage → C++ → 响应块
src/net/net.cpp                 ← WinHTTP：建连、发请求、把响应体按块送回页面
```

理由：

- SSE 状态机里有三个真实回归 bug 的对策（`data: 0` 保活行吞流、标量误清 pending、
  1MB 雪球）。逐行翻成 C++ 是最容易翻车、收益最低的活；
- 重试、退避、400 降级表都在 `llm/index.js` / `openai.js` 里，原样运行 = 一个字都没改；
- C++ 只做它必须做的事：**Key 不进页面**、WinHTTP、取消时真的关掉在途连接。

Key 的边界：页面拿到的 provider 配置里 `apiKey` 是哨兵 `__ISG_HOST_KEY__`。
`net.cpp` 发出前删掉带哨兵的头，再从 `store.provider_config()` 取真 Key 注入；
同时**核对 URL 的 origin 与 provider.baseUrl 一致**，否则 `EBADURL`。
没有这一步，页面（同时承载模型产出的 HTML）就能把"任意 URL + 自动附 Key"当 SSRF/外带用。

## 4. 那些"看起来对、其实错"的时刻

### 4.1 消息没有 `kind`

`jobs.log()` 写的是 `post({ op:'log', entry })`；runtime 的 `post()` 只在
`msg.kind === 'pipeline'` 时才补 `jobId`，**并没有补 `kind`**。
C++ 的 `OnWebMessage` 按 `kind` 分发，`kind` 为空 → 既不是 `invoke` 也不是 `pipeline`
→ 被当成畸形消息丢掉。写文件消息因为显式写了 `kind:'pipeline'`，反而是好的。

**定位过程**：先看到"HTML 已经产出、`gen:get` 里 status 永远是 pending、logs 只有创建那一条"。
这组事实说明"产物写成功了，但事件没到"。把 `post()` 的字段打印出来，才看到 `kind` 缺失。

**修法**：`post()` 里 `if (!msg.kind) msg.kind = 'pipeline'`。
**教训**：一条私有协议有两个入口（显式写 kind / 不写），就一定有一条会漏。

### 4.2 `.value()` 用在字符串上，直接 0xC0000409

`jobs.finish` 里有一句我本来想"顺手判一下 htmlPath 在不在"的代码：

```cpp
if (!j.contains("htmlPath") || j["htmlPath"].value("", std::string()).empty()) { }
```

`htmlPath` 是字符串，`ordered_json::value()` 只能用于对象 → `type_error.306`。
宿主侧没有顶层 try/catch → `std::terminate` → 退出码 **0xC0000409**。
更讽刺的是：异常发生在 `op:'finish'`，而**前面 15 条日志、产物、审题都成功了**；
如果只看"文件写出来了"就收工，交付的会是一个"一跑完就崩"的程序。

**修法**：删掉那句（它本来什么也没做）。**同时**在 `WirePipeline` 的 `pipeline` /
`http-fetch` 两个入口、以及 `Bridge::OnWebMessage` 的 `Dispatch` 外层加了 `try/catch`：
页面消息是不可信输入，宿主不能因为一个类型异常把整个收尾路径跳过。

### 4.3 放行目录本身被拒

`ValidateOutputPathLocked` 的比较是"以 `outDir\` 为前缀"。`preview.allow(outDir)` 传的
正是 `outDir` 本身（没有尾斜杠），于是 `a.size() < root.size()` 为真 → 拒绝。
写文件不受影响（写的是 `outDir\文件名`），所以**产物正常、预览打不开**。
修法：先判 `a == outDir`，再判前缀。

### 4.4 取消的最终状态是 failed

在途取消时，llm 层抛出 `LlmError{code:'EABORTED'}`，没有 `canceled` 标志；
`pipeline` 的 `askJson` 只在 `e.canceled` 时走取消分支，否则按"模型调用失败"处理。
结果是任务在约 0.26 秒内结束，但状态是 **failed**。

**修法**（**不改 oracle 文件**）：在 `pipeline-host.js` 里给 llm 模块包一层，
把 `EABORTED` / `signal.aborted` 补成 `canceled=true`。
这是宿主适配层，不是对纯逻辑的修改。

### 4.5 大快照会被静默丢弃

Phase 1 的实测结论是：WebView2 单条消息有大小限制（161 KB 的字符串收不到）。
流水线在运行中会给 `job.sources[i].pages` 挂上**整页正文**（26 MB 的 PDF 可以到几 MB），
`options.editedPages` 也可能很大。如果 `jobs.finish` 把这些原样回传，
任务会"跑完了但界面永远停在 running"——而且没有任何报错。

**修法**：`summary()` 剥掉 `sources[].pages` / `scopedPages` / `note`、
`options.editedPages`、`outputs[].report`；`gen:get` 只带最近 120 条日志。
**教训**：消息边界上的"大对象"不是性能问题，是正确性问题。

### 4.6 第一次点「测试连接」必失败

页面里的 `llm.testConnection` 要靠 bundle 的 `shims.getEnv()` 把 URL 映射到 providerId；
`pipeline-host.js` 的 `onHostRequest` 拿到 env 后**没有 `setEnv`**。
新启动应用、还没跑过生成，直接在设置页点「测试连接 / 拉取模型」→ providerId 是空串 →
宿主回 `ENO_PROVIDER`。用户看到的是"配置没问题但连不上"。
**这条自测没抓到**，因为 net-fault 先调了 `__isgTestChat`（它内部会 `setEnv`），
把环境提前设进去了。三路交叉审查的第二路抓到的。
修法：`onHostRequest` 里先 `setEnv`；并把这个测试改成**先测连接、再跑 chat**。

### 4.7 取消时把在途连接关掉，但证明它的判据太弱

第一版 `pipeline-cancel` 只断言"< 8 秒结束、最终 canceled"。问题是页面自己的
`AbortController` 也会让取消很快返回，**即使 C++ 的 `AbortJob` 完全没生效**。
第三路审查指出：注释里"如果取消没有真的中止在途请求，这里会等到 ≥10 秒"是错的。
修法：让 `net-fault-server.js` 在 slow 模式下监听 `req.on('aborted')` / `res.on('close')`，
写一条 `{type:'aborted'}`；宿主断言服务端确实收到了 chat 请求、且看到了连接提前断开。

### 4.8 `authField:'query'` 把真 Key 回显进了页面

`replace_query_key(url, apiKey)` 之后的 URL 被放进 `http-head.url` 回给页面。
页面里的 `Response.url` 因此带真 Key；llm 层的 scrubber 只认识哨兵，洗不掉真 Key。
一旦发生 ENOSTREAM / 流内错误 / 读流失败，真 Key 会进入错误消息与日志。
修法：保留 `pageUrl`（注入前），`head["url"]` 只回它。

## 5. 三路交叉审查（交付前）

按用户要求开了三路只读审查：C++ 正确性/并发、JS 流水线/垫片保真度、验证体系可信度。
**顺序很重要：先自己跑完全绿、写好文档，再开审查**——审查者要能看见"你声称的样子"，
才能指出你在哪里把话说满了。

### 5.1 第一路（C++）抓到的主要问题

1. **`options.editedPages` 被 `Get()` 瘦身剥掉**，流水线收不到；finish 还会把宿主那份抹掉。
2. **`gen:start` 没有做 oracle 的选项别名归一**：工作台的 `quizTarget` / `chapterTitle`
   永远进不了流水线，滑杆与章标题输入完全无效。
3. `copyFile` 的页面字段是 `{from,to}`，C++ 读 `path` → 必然校验失败 → 整单 failed。
4. `finish` 把 snapshot 里的旧 `ask` 又写回去；`settleAsk` 用 `undefined` 而不是默认值。
5. `EvictOld()` 在锁外改 `jobs_`；`history.json` 的类型错误会穿过 UI 线程。
6. `api_key_header` 在 OpenAI 格式下注错了头；`http-head.url` 回显 query Key。
7. 快照分块 `jobInfo`/`jobPart` 各建一次，任务中途变化会让分片对不上。

### 5.2 第二路（JS/保真度）抓到的主要问题

1. **首次「测试连接」失败**（§4.6）。
2. **`logic-bundle.js` 过期**：16K 分块修复没进 bundle，dist 里仍是 48K 版。
3. `authField:'query'` 的 Key 回显（§4.8）。
4. 抽取结果 / `gen:get` 不分块 → 大课件会让流水线永久挂起。
5. 并发任务共用全局 `currentJobId` → 日志/产物串档。
6. ask 生命周期（`_askDefault`、清 `job.ask`、重复 `askSet`）。
7. 取消竞态：C++ 先关连接、页面后收到 cancel，EABORTED 可能被当成 ETIMEDOUT。
8. UNC 路径被 `path` 垫片吃掉双反斜杠；`envPromise` 失败后被永久缓存。

### 5.3 第三路（验证体系）抓到的主要问题

1. **绿报告对应的 exe / bundle / 脚本不是最终树**：`-SkipBuild` 跑了旧报告，
   bundle 已过期，请求证据被后一个测试覆盖。
2. net-fault 与 pipeline-cancel 共用一个请求记录文件，后跑的把前一个覆盖。
3. 泄漏检查只看"报告为空"，不查 exit code / checked；泄漏报告还和自测人类报告同名。
4. pipeline-mock 的产物检查不看 mtime，旧文件可以冒充本次产物。
5. 取消测试没有证明"服务端看到连接断开"。
6. 文档把"退避后重试""SSE 切包用例全过""不是页面自报"说满了。
7. 261 ms 实际是 264 ms；91/48 两种口径被相加成 139。

### 5.4 修完，重新跑一次全量

修完不是就完事：重新生成 bundle、干净构建 Release/Debug、带真实样本与跨实现 Key 重跑。
最终 **95 条外层判据全过、0 跳过**；`net-fault` 26、`pipeline-mock` 23、
`pipeline-cancel` 9；金标准仍是 157557 字节逐字节相同。
这一步很重要：**报告必须与最终树的 exe SHA 对得上**，否则"绿"只是历史记录。

## 6. 我自己犯的错（比审出来的更值得记）

1. **一条消息协议漏了 `kind`**。两个入口，只补了一个。
2. **`.value()` 用在字符串上**，而且是在 finish 路径上——最容易"最后一步才炸"的位置。
3. **先写实现后搭故障注入**。前两轮全靠猜；guidance3 已经写过"先搭对拍"。
4. **48K 字符 vs 16K 码元**：一开始按"48K 个 UTF-16 码元"切，中文页面单条消息会到 ~150KB；
   后来改成 16K 码元（≤ ~48KB JSON）。
5. **`SnapshotText` 里调 `Get()` 自锁**：`Get` 会再拿一次 `mu_`。改成直接 `json_dump(jobs_[id])`。
6. **Python 批量改文件时 `\n` 被解成真换行**，把 `run-mock-selftest.py` 弄成语法错误两次。
   教训：涉及转义的批量编辑，不要用一层套一层的 heredoc；用 `Write` 或 `chr(92)`。
7. **请求文件只传给 exe，忘了传给服务进程**，宿主读到 0 条。
8. **`slow` 模式的位置**：服务端约定 `argv[2]=请求记录文件`、`argv[3]=模式`；
   只传 `slow` 会让它把 `slow` 当成文件名。
9. **陈旧证据**：`-SkipBuild` 下如果 exe 没跑起来，盘上会留着上一份报告；
   请求记录也会被后一个测试覆盖。现在每项先删、证据文件分开、报告绑定 exe SHA。
10. **把"产物写出来了"当成"流水线跑对了"**。前半段 HTML 一直好好产出，
    而任务状态永远是 pending。**判据要覆盖"状态"和"产物"两条线。**
11. **文档把话说满**：退避、切包、页面自报、261ms、91+48 的相加。
    第三路审查逐条指出；现在文档写的是"会重试，不是退避了多久""来自宿主保存的快照，
    值是页面写入的""外层 95 条 / 子判据 26/23/9，不能相加"。

## 7. 心路

**① 最想收工的时候，是验证器最绿的时候。**
HTML 能打开、探针全绿、日志看起来正常，那一刻很像"Phase 3 完成了"。
但"产物写出来了、任务永远 pending"这件事说明：**绿的是产物，不是任务**。
如果当时收工，用户会在运行页看到一个永远转圈的任务。

**② 最难的不是 WinHTTP，是"承认我的消息协议漏了一个字段"。**
这个 bug 没有异常、没有报错，只有一个永远不变的 status。
它逼我把"页面 → C++"的每一条消息都列出来，逐条看字段：
`kind`、`jobId`、`op`、`seq`、`size`、`chunks`。**清单比直觉可靠。**

**③ 三路互验的价值不在"再检查一遍"，在"去骗它"。**
第三路没有跑一遍看绿不绿，而是问："如果我想蒙混过关，能不能让这些判据绿？"
答案能：共用请求文件、旧产物、只查报告为空、不看 exit code。
**判据的强度不等于判据的数量。**

**④ 用户的两次硬要求又一次直接变成了设计约束。**
"关得干净"催生了 `NetManager::Shutdown()`（取消 + join 全部工作线程，
排在 `bridge_.Detach()` 之前）、入口 try/catch、以及"页面消息是不可信输入"的兜底；
"删除要三思"让验证脚本继续只删 `_verify-out/` 下自己刚产生的东西，
runner 清请求记录前先断言路径在允许根内。

**⑤ 逐字节搬 + 垫片，比"翻译成 C++"省心得多。**
prompts、计费、校验器都没有重写；C++ 只做传输、生命周期与安全边界。
代价是引入了一层垫片，但垫片的问题都能用"页面上跑一遍"当场暴露
（`kind` 缺失、`.value`、快照超限都是这样暴露的）。

## 8. 如果换我接手，我会先做这几件事

1. 读 `phase3-report.md`、`guidance6.md`，再读这一份。
2. 跑一次全量验证（含样本与 Key 兼容）：
   ```powershell
   powershell -File tools\phase1-verify.ps1 -BuildDir build2 `
       -SampleDir "<samples>"
   ```
   确认 95 条外层判据全过、0 跳过；然后**挑一条试着让它失败**：
   - 把 `runtime.inc.js` 的 `if (!msg.kind)` 删掉 → pipeline-mock 应该红；
   - 把 runner 里给服务的 `--net-requests` 删掉 → net-fault 应该红；
   - 把 `logic-bundle.js` 改回旧内容 → bundle 新鲜度判据应该红；
   - 把 pipeline-mock 的产物 mtime 改成昨天 → 新鲜度判据应该红。
3. 先别急着进 Phase 5。Phase 5 的第一件事不是写探针驱动，而是把
   `verify/runner` / `demo-checks` 的垫片换成真实现，让 `repairRound` 真的跑起来。
4. 不要把 `summary()` / `finish` 的"大字段裁剪"再放回去。
   消息边界不是无界的。
5. 所有新的 `.ps1` 仍然必须带 UTF-8 BOM；`python tools/check-ps1-encoding.py` 已挂在验证里。

## 9. 附：这次留下的东西与寿命

| 东西 | 寿命 |
|---|---|
| `src/net/net.cpp` | **长期**。WinHTTP 传输、Key 注入、origin 校验、取消 |
| `src/pipeline/jobs.{h,cpp}` | **长期**。任务生命周期、历史、ask、写文件分块 |
| `web/logic/shims/runtime.inc.js` / `pipeline-host.js` | **长期**。浏览器垫片与流水线宿主 |
| `web/isg-bridge.js` 的 `__isgHost` / 分块回包 | **长期**。内部通道与 `reply-chunk` |
| `tools/net-fault-server.js` / `run-mock-selftest.py` | **长期**。Phase 5 的故障注入可以复用 |
| `tools/phase1-verify.ps1` | **长期**。新判据继续往这里加 |
| `_verify-out/` | 运行期产物，每次验证重新生成 |

**最后一句**：这一阶段真正值钱的不是"能调模型了"，是
**"产物写出来了、任务却永远 pending"这件事被记下来了**，以及那句可以继续往下传的规矩：

> 每一条私有消息协议，都要有一个**入口处补默认值**的地方；
> 每一个跨消息边界的大对象，都要先问一句"它会不会超过单条消息的上限"。
