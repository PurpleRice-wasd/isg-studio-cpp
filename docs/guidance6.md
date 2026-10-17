# guidance6 · Phase 4 工作记录与接手笔记

> **作者**：接手这次 C++ 重写、完成 Phase 4 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、当时怎么想的、怎么定位的、
> **我怎么发现自己是错的**。判断与路线仍以 [`guidance.md`](guidance.md) 为准；
> 结论与数字在 [`phase4-report.md`](phase4-report.md)。
>
> 与 guidance1/2/3/5 的关系：那四份分别是 Phase 0 / 1 / 2 / 3。这一份是
> **Phase 4（流水线与拼装）**。
> 前几份留下的三条自我提醒——**最难的是不让自己被骗、默认倾向是相信自己的判据、
> 倾向于把话说满**——这一轮又都出现了，而且换成了新的形态：
> **这次不是"没跑通"，而是"跑通了，但输入在到达之前就被削掉了"。**

---

## 0. 一句话

Phase 4 把 **流水线、提示词、校验器、审题、拼装**接起来了：
oracle 的 `pipeline` / `prompts` / `sources` / `chapters` / `revive` **逐字节复制**进
`web/logic/`，用一层浏览器垫片跑在 WebView2 里；C++ 只负责任务生命周期、文件、Key 与网络。
两条 DoD 都通过：**金标准逐字节相同**；**audit-pass 等价回归**（假模型先写 999 →
审题抓住 → 重出 200 → 最终页面有 200、没有 999）。

**最值钱的不是"能生成页面了"**，而是三路互验审出来的几类"判据全绿时功能已经坏了"：

- 给界面瘦身的 `Get()` 把 `options.editedPages` 也剥掉了 → 用户在抽取预览里改过的正文
  **在到达流水线之前**就被丢掉，而且 finish 还会把宿主那份一起抹掉；
- `gen:start` 没有做 oracle 的选项别名归一 → 工作台的「作答点目标数」滑杆和
  「章标题」输入**完全无效**，而且不报错；
- `logic-bundle.js` 过期 → 16K 分块修复没进交付，dist 里的页面仍用旧的 48K 版；
- 大回包（抽取结果、任务快照）不分块 → 大课件会让流水线**永久挂起**，
  页面 Promise 永远不 settle。

## 1. 我接手时仓库长什么样

- Phase 3 已完成：`src/net/`、`src/pipeline/jobs`、`_pipeline:*` 内部通道、
  `web/logic/llm-*` 与垫片、net-fault / pipeline-mock 的雏形。
- `web/logic/` 里只有 `bank.js` / `assemble.js`；`pipeline` / `prompts` / `sources` /
  `chapters` / `revive` 还没搬。
- 没有 Worker，也没有"页面里跑流水线"的形态；`gen:start` 只是建任务，没有 runGeneration。
- 金标准对拍已经在 Phase 1 搭好（`tools/golden/*`），这是这次最省事的一件事：
  **拼装层的回归不需要从零搭。**

**我的第一件事不是写 shims**。我先把纲领 §3.2/§6、guidance3 §8、guidance2 §11
和 oracle 的 `pipeline/index.js`、`prompts.js`、`sources.js`、`chapters.js`、`revive.js`
读了一遍。重点不是"有哪些函数"，而是：

- `pipeline/index.js` 里哪些是纯逻辑、哪些是 I/O；
- `prompts.js` 依赖哪些 Node API（`fs` / `path` / `electron` / `../skill`）；
- `runGeneration` 的 catch 分支如何区分 canceled / failed；
- `askJson` 的"空正文 / JSON 解析失败 / 校验不合格"三条重试路径；
- `auditBank` 的计票规则（同一位审题人按题 id 去重、多人要两人独立确认）。

## 2. 我按什么顺序做

1. **先定"哪一层跑在哪"**：纯逻辑（pipeline/prompts/bank/assemble/llm 分帧）继续是 JS，
   跑在页面里；C++ 只做文件、任务、Key、网络。**没有把流水线翻成 C++。**
2. **先搬、再改**：把 11 个 oracle 文件逐字节复制进 `web/logic/`，用
   `tools/sync-web.ps1` 的 `$logicSourceMap` 管起来，用 `bundle-logic.js` 生成浏览器 bundle。
   **没有为了"方便"改 oracle 任何一行。**
3. **先写垫片，再写新逻辑**：`fs` / `path` / `store` / `jobs` / `preview` / `extract` /
   `skill` / `version` / `electron` / `fetch`。垫片是唯一的新代码，也是唯一可能改变语义的地方。
4. **先搭对拍/测试，再补细节**：金标准已有；再加 `mock-provider-server.js` 与
   `pipeline-mock` 自测。**这次先搭了测试**（Phase 3 的教训）。
5. **最后接界面**：`gen:start` 建任务 → 页面取 skill/契约/任务快照 → `runGeneration` →
   `job:event` 回传；`verify` / `repair` 明确标成 Phase 5 缺口。

顺序上我还是犯了一个错：**先写了"页面取任务快照"的瘦身版**。
我当时想"界面只需要最近 120 条日志"，顺手把 `options.editedPages` 也剥了——
因为它是大字段。结果把**输入契约**和**界面展示**混成了一件事。
这是三路互验的第一路抓到的，也是这一轮最值得记的一课。

## 3. 关键设计：同步 `fs` 的死结与分块

oracle 的模块大量用 `readFileSync`（`readFileSync` 15 处、`existsSync` 14 处），
而 WebView2 的 host object 在 Worker 里不可用，跨线程不可能同步。
解法是**预热 + 分块**：

- 页面用 `_pipeline:env` 拿 `settings/providers/version/paths`，
  再用 `_pipeline:filePart` 分块取 `SKILL.md` / `page-skeleton.html` / `generation-contract.md`；
- `fs` 垫片只读这份内存快照；`fs.writeFileSync` 走 `op:writeFileBegin/Chunk/End`，
  16K 个 UTF-16 码元一块（≤ ~48KB JSON 文本），结束消息带 `size` 与 `chunks`；
- 任务快照也分块（`_pipeline:jobInfo/jobPart`），并且 **jobInfo 与 jobPart 用同一份缓存文本**，
  否则两次调用之间追加一条日志就会让偏移对不上。

为什么分块大小是 16K 码元而不是 48K：中文最多 3 字节/码元，48K 码元 ≈ 144KB UTF-8，
已经接近 Phase 1 实测的 161KB 单条消息上限。**按字符数切和按字节数切不是一回事。**

## 4. 那些"看起来对、其实错"的时刻

### 4.1 页面已经写出 HTML，任务却永远 pending

这是 Phase 3 的 `kind` 缺失在 Phase 4 的第一次显形。产物写成功了（写文件消息显式带了
`kind:'pipeline'`），但日志、阶段、finish 全部只有 `{op:...}`，被 C++ 当畸形消息丢掉。
`gen:get` 的 status 永远是 pending、logs 只有创建那一条。
修法：垫片的 `post()` 在入口处补 `kind='pipeline'`。
**这一条直接催生了 guidance5 的最后一句：私有协议必须在入口处补默认值。**

### 4.2 `options.editedPages` 被"给界面瘦身"的逻辑削掉

`JobStore::Get()` 为了控制 `gen:get` 的消息大小，去掉了 `options.editedPages`。
但 `_pipeline:jobInfo/jobPart` 用的是同一个 `Get()`——页面里的 `runGeneration`
拿到的 job 里根本没有 `editedPages`：
`(job.options.editedPages || [])` 永远是空表，用户逐页修订**完全无效**，而且没有日志。
更糟的是 `finish` 把页面回传的 stripped `options` 合并回宿主，**宿主内存里那份也被抹掉**。

修法：
- `Get(id, forPipeline)` 分开；`_pipeline:*` 走不瘦身的版本；
- `finish` 的 snapshot 改成**白名单 + 类型检查**合并，显式跳过
  `options/sources/ask/report/logs/stages`；
- pipeline-mock 增加 `editedPages` 用例，断言日志里有「采用了用户手工修订」。

**教训**：给"界面看"的裁剪和给"流水线用"的快照是两件事。
**界面需要什么**和**输入契约需要什么**不能共用同一个函数。

### 4.3 工作台的滑杆和章标题输入完全无效

oracle 的 `ipc.js` 有一个 `OPTION_ALIASES`：
`quizTarget→points`、`chapterNo→number`、`chapterTitle→title`、`pet:'own'→'image'`，
并且会把 `settings.generation` 铺底、页面显式值覆盖。C++ 的 `Create` 只是把
`input.options` 原样存下来。于是：

- 工作台的「作答点目标数」发的是 `quizTarget`，流水线只认 `points` → **永远按默认 65 出题**；
- 「章标题」发的是 `chapterTitle`，流水线读 `options.title` → 用户填的标题被丢掉；
- `settings.generation` 里的用户偏好不会进入 `job.options`。

自测为什么假绿：`pipeline-mock` 直接发 `points:40`、`pet:'none'`，
**绕过了界面真实字段名**。修法：
- `JobStore::Create` 实现别名归一 + `settings.generation` 兜底；
- 自测改成发 `quizTarget` / `chapterTitle`，宿主断言 `job.options.points==40`、
  `title=='测试章'`。

**教训**：测试如果直接用"内部字段名"，就永远测不到"界面字段名 → 内部字段名"这一层。
**测试的输入要尽量贴近真实调用方。**

### 4.4 `copyFile` 的字段名对不上

页面发 `{op:'copyFile', from, to}`，C++ 读 `str_of(msg,"path")`。目标路径是空串 →
`ValidateOutputPathLocked` 必然失败 → `writeError` → `finish` 把任务标成 failed。
目前 `petImagePath` 没有写入者，所以是潜伏的；但协议本身是错的。
修法：C++ 读 `to`（兼容 `path`），并对 `from` 做 `protocol_is_allowed`。
**教训**：跨语言的消息字段名，必须在两边各写一遍并**互相看**；只在一侧读代码不够。

### 4.5 大回包不分块 → 永久挂起

`extract:preview` 返回整份 `pages[].text`；`gen:get` 返回最多 120 条日志。
这些都可能超过 WebView2 的单条消息上限。超过时消息**静默丢失**，
`isg-bridge` 的 pending 表里那条 Promise **永不 settle**：流水线卡在 `getExtract()`，
既不 fail 也不 finish，UI 一直转圈。

修法：在 bridge 的回包层做**通用分块**——`data` 序列化后 >48KB 时，
发 `reply`（`chunked:true`）+ 若干 `reply-chunk`（base64）+ `reply-end`；
页面侧拼装后再 `JSON.parse`。这样 `extract:preview`、`gen:get` 以及将来任何大结果
都自动受益，不需要每个通道各写一套。
**教训**：分块应该做在**边界层**，而不是每个业务通道里。

### 4.6 `verify` / `repair` 没实现，但不能静默

`verify/runner` 与 `demo-checks` 是 Phase 5 的探针驱动。垫片里它们明确抛
"Phase 5 才实现"；`runGeneration` 的 `try/catch` 把它记成一条 warn：
"页面已生成，但**这一页没有被自动验证过**"，然后 `repair` 标成 skipped。
这不是静默跳过：日志与阶段状态都写得很清楚。
**这一条很重要**：未实现可以，但必须让用户看见"哪一步没做"。

## 5. 三路交叉审查（交付前）

按用户要求开了三路只读审查：C++ 正确性/并发、JS 流水线/垫片保真度、
验证体系可信度。**先自己跑完全绿、写好文档，再开审查。**

### 5.1 第一路（C++）与第二路（JS）交叉确认的问题

1. **`editedPages` 输入被削**（§4.2）——两路都抓到了。
2. **选项别名缺失**（§4.3）——第一路抓到的，第二路确认界面字段。
3. **`copyFile` 字段错位**（§4.4）——两路都抓到。
4. **首次「测试连接」失败**——第二路抓到；原因是 `onHostRequest` 没 `setEnv`。
5. **`logic-bundle.js` 过期**——第二路和第三路都抓到；16K 修复没进 bundle。
6. **query-auth 的 Key 回显**——两路都抓到；`http-head.url` 必须是注入前的 URL。
7. **大回包不分块**——第二路抓到；已在边界层做通用分块。
8. **ask 生命周期**——`_askDefault` 没设、`settleAsk` 不清 `job.ask`、finish 把旧 ask 写回。
9. **并发任务串档**——全局 `currentJobId`；C++ 现在拒绝第二个 running/pending 任务。
10. **取消竞态**——C++ 先关连接、页面后收到 cancel；EABORTED 被改写成 ETIMEDOUT。
    修法：shim 用 `name:'IsgAborted' + code:'EABORTED'`，包装层据此补 `canceled=true`。

### 5.2 第三路（验证体系）抓到的问题

1. **绿报告不是最终树**：`-SkipBuild` 跑在旧 exe/旧 bundle 上；bundle 已过期。
   修法：最终重新生成 bundle、干净构建、重跑全量；报告绑定 exe SHA。
2. **请求证据被覆盖**：net-fault 与 pipeline-cancel 共用一个请求文件。
   修法：分开，并在宿主断言各自的内容。
3. **产物新鲜度**：pipeline-mock 直接读 `htmlPath`，旧文件可以冒充本次产物。
   修法：宿主断言 mtime 晚于测试开始。
4. **取消证据太弱**：只测"<8 秒"，页面自己的 AbortController 也能满足。
   修法：服务端记录 `aborted`，宿主断言连接提前断开。
5. **泄漏检查假绿**：只查报告为空，不查 exit/checked；泄漏报告与自测报告同名。
   修法：不同名、查 `checked=19/30`、查 exit code。
6. **文档说满**：退避、切包、页面自报、261ms、91+48 的相加。
   修法：逐条改。

### 5.3 修完，重新跑一次全量

- 重新生成 `logic-bundle.js`；
- 干净构建 Release + Debug；
- 带真实样本与跨实现 Key 重跑；
- 最终 **95 条外层判据全过、0 跳过**；`pipeline-mock` 23、`net-fault` 26、
  `pipeline-cancel` 9；金标准 157557 字节逐字节相同。

## 6. 我自己犯的错（比审出来的更值得记）

1. **把"界面瘦身"和"流水线输入"共用一个 `Get()`**。这是这一轮最严重的错误：
   一个为了省消息大小的优化，悄悄改掉了用户输入。
2. **测试直接用内部字段名**（`points` / `title`），绕过了界面真实字段名，
   于是选项别名 bug 一直没被发现。
3. **先写实现后搭故障注入**（Phase 3 的旧毛病又犯了一次）。
4. **48K 字符 vs 16K 码元**：中文页面单条消息会到 ~150KB，接近上限。
5. **`SnapshotText` 里调 `Get()` 自锁**：`Get` 会再拿一次 `mu_`。
6. **`copyFile` 只看了一侧代码**：页面发 `to`，C++ 读 `path`。
7. **Python 批量改文件时 `\n` 被解成真换行**，把 runner 弄成语法错误两次。
8. **请求证据只传给 exe，忘了传给服务进程**，宿主读到 0 条。
9. **陈旧证据**：旧 HTML、旧请求记录、旧报告都可能冒充这一轮。
   现在：产物看 mtime、请求文件分开、报告绑定 exe SHA。
10. **文档把话说满**：
    - "不是页面自报"——其实 audit/usage 是页面在 finish 时写入快照、宿主再读回；
    - "mock 服务端的调用计数"——16 是页面回传的 `usage.calls`，不是服务端计数；
    - "并发限 3"——代码是 `mapLimit(3)`，测试没有独立测量并发度；
    - "261ms"——实际 264ms；
    - "91+48=139"——91 是顶层口径、48 是子判据，不能相加。
    第三路逐条指出；现在文档写的是准确的口径。

## 7. 心路

**① 最能骗人的不是"没跑通"，是"跑通了，但输入被削掉了"。**
页面生成了、内容看起来正常、审题也跑了；但用户改过的页面正文根本没进流水线。
这类失效没有异常、没有日志，只有"怎么感觉模型没用我改的内容"。
**它逼我把"输入"也当成判据的一部分。**

**② 测试如果绕过真实调用方，就会替 bug 作证。**
`pipeline-mock` 直接发 `points:40`，全绿；界面发的是 `quizTarget`，永远无效。
**测试的输入要尽量贴近真实界面**，否则测的是"内部函数能不能跑"，不是"用户能不能用"。

**③ 分块应该做在边界层，不是每个通道。**
一开始只给 skill/契约/任务快照分块；抽取结果和 `gen:get` 没分。
后来在 bridge 的回包层做通用分块，所有大结果自动受益。
**重复的适配会走散；边界层的一次适配不会。**

**④ 三路互验的价值不在"再检查一遍"，在"去骗它"。**
第三路没有跑一遍看绿不绿，而是问："如果我想蒙混过关，能不能让这些判据绿？"
答案能：旧产物、旧请求记录、只查报告为空、不看 exit code。
**判据的强度不等于判据的数量。**

**⑤ 用户的两次硬要求又一次直接变成了设计约束。**
"关得干净"让 `NetManager::Shutdown()` 排在 `bridge_.Detach()` 之前，
让写文件 end 带块数/字节数、宿主对账；
"删除要三思"让 runner 在删请求记录前先断言路径在 `_verify-out`/TEMP 内。

**⑥ 接受一条可复现的缺口，比伪造一个漂亮的数字更接近"完成"。**
`verify`/`repair` 没做、`book` 没做、`text.js` 没搬、多审计人 split 没测——
这些都写在报告与这一份里，没有用"中位数"或"大部分"盖过去。

## 8. 如果换我接手，我会先做这几件事

1. 读 `phase4-report.md`、`guidance5.md`，再读这一份。
2. 跑一次全量验证（含样本与 Key 兼容）：
   ```powershell
   powershell -File tools\phase1-verify.ps1 -BuildDir build2 `
       -SampleDir "<samples>"
   ```
   确认 95 条外层判据全过、0 跳过；然后**挑一条试着让它失败**：
   - 把 `runtime.inc.js` 的 `if (!msg.kind)` 删掉 → pipeline-mock 应该红；
   - 把 pipeline-mock 的 `quizTarget` 改回 `points` → 选项别名判据应该红；
   - 把 `editedPages` 从测试输入里删掉 → 「用户手工修订」判据应该红；
   - 把 pipeline-mock 的产物 mtime 改成昨天 → 新鲜度判据应该红；
   - 把 `logic-bundle.js` 改回旧内容 → bundle 新鲜度判据应该红。
3. **Phase 5 的第一件事不是写探针驱动**，而是把 `verify/runner` / `demo-checks`
   的垫片换成真实现，让 `repairRound` 真的跑起来；否则 Phase 4 的 `repair`
   永远是 skipped。
4. 不要把 `summary()` / `finish` 的"大字段裁剪"再放回去。消息边界不是无界的。
5. 多章/带上以前的章（`book.js`、`.isg.json`）是 Phase 6；在它实现之前，
   `gen:start` **不要**静默忽略 `input.carry`，至少要返回明确错误。
6. `text.js` 的切页逻辑仍在 C++（Phase 2 已记账）；如果要搬回 Worker，
   单独立项并补 `check-logic-sync`，不要混进 Phase 5。

## 9. 附：这次留下的东西与寿命

| 东西 | 寿命 |
|---|---|
| `web/logic/*.js`（11 个 oracle 复制） | **长期**；由 `sync-web.ps1` 维护，逐字节一致 |
| `web/logic/shims/runtime.inc.js` / `pipeline-host.js` | **长期**；浏览器垫片与流水线宿主 |
| `web/logic/logic-bundle.js` | 生成物；改了 `web/logic/` 必须重新 `bundle-logic.js --write` |
| `src/pipeline/jobs.{h,cpp}` | **长期**；任务生命周期、历史、ask、写文件分块 |
| `tools/mock-provider-server.js` / `mock-fixture.md` | **长期**；Phase 4 端到端 |
| `tools/run-mock-selftest.py` | **长期**；Phase 5 可以复用 |
| `tools/phase1-verify.ps1` | **长期**；新判据继续往这里加 |
| `_verify-out/` | 运行期产物，每次验证重新生成 |

**最后一句**：这一阶段真正值钱的不是"能生成页面了"，是
**"页面生成了、输入却被削掉了"这件事被记下来了**，以及两句可以继续往下传的规矩：

> 给界面看的裁剪，不要和给流水线用的快照共用一个函数。
> 测试的输入要贴近真实调用方，否则它只会替 bug 作证。
