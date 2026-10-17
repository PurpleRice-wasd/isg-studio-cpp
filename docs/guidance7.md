# guidance7 · Phase 5 + 6 工作记录与接手笔记

> **作者**：接手 Phase 5/6 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、怎么发现自己是错的。
> 判断与路线仍以 [`guidance.md`](guidance.md) 为准；结论与数字在
> [`phase5-report.md`](phase5-report.md) / [`phase6-report.md`](phase6-report.md)。

---

## 0. 一句话

Phase 5 把**探针窗口、title 解析、DOM 快照、demo 读数核对、repair 回灌**接起来了；
Phase 6 把**旁挂 `.isg.json`、带上一章、多章、收尾清理、打包**接起来了。
两条 DoD 都通过：真 PDF → 真拼装 → 真探针 → 假模型（31 条）；修复轮在假模型持续写错
演示 checks 的情况下真的重出、重跑、并如实写「仍有 1 项没过」。

这一轮最值钱的不是"探针能跑了"，而是三个**画面全绿、功能已坏**的时刻：

- `probe-parse.js` 的原始字符串**少了最后一个 `)`** → DOM 快照与错误脚本根本没执行，
  报告里只是"少了一项顶栏总数"，页面其它项都正常。
- 演示核对把 **demo 对象**当成了 checks 数组 → 脚本正常跑、返回 0 组，看起来像
  "元素 id 写错了"，而真正的错误层在调用处。
- demo 核对加载**原页面**，收尾时却按"探针副本"把它删了 → 用户的成品页面凭空消失
  （这条直接撞上用户"删除之前先看目标"的硬要求）。

以及一处 oracle 自身的静默回归：多章改造时 `page.demos` 丢掉了 `checks`，
`checkDemos` 永远判"没有可核对的 checks" —— **演示核对整整失效了一轮而没有任何报错**。

## 1. 我按什么顺序做

1. **先读 oracle 的 runner/demo-checks/guard/inject，再写 C++**。重点不是 API，
   而是那几条硬约束：探针副本必须同目录、一个窗口一轮、分隔符口径、`markersOf` 不写死探针名。
2. **先定"谁解析"**：宿主只交原始读数（title/domFacts/errors），解析与 0.5% 容差留在 JS。
   这样"什么叫通过"只有一份实现，结果页与流水线共用。
3. **先搭反例**：`--selftest=verify` 从第一天就带一个"把题库脚本改坏必须报错"的页面。
   只验好页面的话，探针是不是真在跑根本不知道。
4. **先写状态机再写细节**：ProbeRunner 的每一项主动动作都从 `Tick`（计时器）发；
   WebView2 回调只记结果、不发起下一次调用。
5. **Phase 6 先做读半身**：`book:list/inspect/continuity` 与 sidecar 读取先在宿主跑通，
   再让页面里的 oracle `book.js` 负责写；`carry` 的异步链用 `CarryCtx` 挂在 shared_ptr 上。
6. **最后做清理与打包**：清理先写"只读扫描"、再写"按清单删"；打包先产出便携目录，
   NSIS 明确跳过并记账。

## 2. 那些"看起来对、其实错"的时刻

### 2.1 原始字符串吃掉了最后一个 `)`

```cpp
const char* kDomFactsJs = R"JS((function(){ ... }})()JS";
```

`R"JS(` 的结束符是 `)JS"`。上面这一行里，`})()` 的最后一个 `)` 被当成了结束符的一部分，
真正的脚本内容是 `...}})(` —— 少了收尾的 `)`。`ExecuteScript` 不执行、也不报错
（至少这台运行时上回调根本没来），于是 `domFacts` 永远是 `null`，报告里只是少一项
「顶栏总数」。**它不报错，只是少一项。**

修法：`...}})())JS"`。同样的错误在 `kErrorsJs` 上重复了一遍 —— 两个常量一起改。

**教训**：原始字符串的结束符会**吃掉**最后一个字符。凡 `R"XX(` 包裹 JS，
写完后把内容打印出来数一遍括号；更稳的是让脚本 `return` 一个明显的哨兵值。

### 2.2 把 demo 对象当成 checks 数组

`evalScript` 需要的是 `demo.checks`，我传进去的是 `demo` 本身：

```js
checks = [{ id:'demoA', checks:[...] }]   // 错
checks = [{ set:{...}, expect:{...} }]    // 对
```

脚本仍然正常执行，`g.set` / `g.expect` 都是 `undefined`，结果是 `groups:[{read:[]}]`，
报告显示"一条读数都没读到，元素 id 可能写错了"。**错的是层，不是 id。**

修法：`const checks = demo.checks`；同时给每个 group 挂 `demo` id，
这样"一个演示多组 checks"也不会配错演示。

### 2.3 demo 核对把用户的成品页面删了

`ProbeRunner` 用 `probeCopy` 记住"这一轮要加载的文件"，收尾统一删掉。
探针模式加载的是我们写的 `_probe_...html`，**demo 模式加载的是原页面**。
第一版没有区分，demo 核对跑完执行 `DeleteProbeCopy()`，把 `htmlPath` 本身删了。

现象：流水线任务 done、报告正常，但输出目录里只剩 `.isg.json`。

修法：`ownsProbeCopy` 标志；demo 模式只清指针、绝不删文件。
**这条直接对应"删除之前先看目标"**：删之前先问"这个文件是谁创建的？"

### 2.4 oracle 的演示核对在 Phase 4 之后静默失效

`pipeline/index.js` 的 `demos.map` 只返回 `{id,title,markup,js,unitId,unitTitle}`，
把 `checks` 丢了。`page.demos` 因此没有 checks，`checkDemos` 直接判"没有可核对的 checks"。
日志、页面、探针都正常，只是**演示读数核对这一项永远不工作**。

修法（**先改 oracle，再同步**）：
- `demos.map` 带上 `checks` / `sliderId` / `viewBox`；
- `repairRound` 写回 `target` 时也补上这三个字段。
- 顺带修了旁挂数据的章号：`book.js` 的 `no` 同时认 `no` / `number`；
  `pipeline` 的 carried 映射补 `number`，否则带过来的章会按数组序号显示"第 1 章"。

### 2.5 取消时的「清除」还是旧文案

`Jobs::Cancel` 里写着"清理功能到 Phase 6 才实现；本次不会删除任何文件"。
Phase 6 做完后这句话变成了假话。现在：取消收尾（`emit done canceled`）时若
`policy=clear`，按清单扫描并删除，日志写明删了几个、几个没删掉。

### 2.6 验证脚本的"条数"又走散了

新增判据后 `expectedCounts` 没跟着改，第一次全量直接报：
`pipeline-repair 判据条数 30 ≠ 期望 37`、`ui 46 ≠ 44`、`bridge 37 ≠ 44`。
这不是代码错，是**判据契约**没同步。修法：以实际报告里的 `[ok]+[BAD]` 行数为准，
逐套改 `expectedCounts`；并把 `book`（真窗口）与 `book-data`（无窗口）分开命名，
避免同一个 `--selftest=book` 被两条路径抢。

### 2.7 解析层丢了 `label`，修复轮整条失灵

`probe-parse.js` 的 `item()` 只返回 `{key,raw,ok,note}`，没有 `label`。
而 `pipeline.js` 的 `repairRound` 用 `/演示|滑块|SVG/` 和 `/脚本错误/` 匹配**label**
来决定要不要重出演示。`undefined` 永远不匹配 —— 探针报出的「SVG 越界元素」「滑块读数」
「脚本错误」都不会触发修复，日志还会写成「校验有 N 项没过：undefined、undefined」。
自测只比对 `key`，所以全绿。修法：`label: LABELS[key] || key`。

### 2.8 页面→宿主的大消息：finish 里的 carry 与 revive

WebView2 的单条消息上限对**两个方向**都成立。`summary()` 原来把 `carry`
（整章 units/bank/lectureHtml）原样塞进 finish 回包，多章时必然超限 ——
消息静默丢，任务永远停在 running。现在 `carry` 不再回传（宿主本来就有原件），
`report.consoleErrors` 截到 50 条。

`book:inspect` / `gen:start carry` 的 revive 路线更糟：整份 HTML 走 `host-request`，
反推结果走 `host-reply`，一条消息就有 150 KB 量级。现在**两个方向都分块**：
头（chunked）+ base64 分片 + end；页面侧拼 base64 再解码一次。
（注意分片切的是**整串 base64**，不是各片单独编码再拼。）

### 2.9 跨章演示 id：`page.demos` 是 plan id，页面里是 final id

拼装器会给撞名的演示改名（一册里两章都从 demoA 开始 → 后一个变 demoB）。
`page.demos` 里仍是 plan id，`checkDemos` 却去最终页面里找元素：
轻则"找不到读数"，重则**核对到另一章的同名演示**；修复轮按 plan id 找目标时，
`.find` 还可能命中**带过来的冻结章**，把新章修复写到老章上。
修法：`demosForChecks(built, page, newChapters.length)` 用 `finalChapters` 的最终 id，
按章序/演示序对齐；checks 仍取 `page.demos` 那一份。自测里第 2 册两章都有演示，
断言页面里出现 `id="demoB"` 且报告 42 项无 false。

## 3. 三路互验前我自己先做的检查

- 用**反例页面**证明探针会红：把全部 `<script data-bank` 改坏 → `题库条目=0`、`ok=false`。
  （第一版只改第一个 `data-bank`，而它命中的是引擎 JS 里的字符串；页面照样全绿。）
- 用**代理假服务**把演示 checks 改成 999999 → demo-checks 红 → repair 真的重出 →
  仍红。这样修复轮不是"跳过却写 removed"。第三步互验指出"失败可能是别的原因"之后：
  宿主断言失败项的 note 里**带着 999999**，假服务同时写一份
  `repair-events.jsonl`（独立于被测程序），验证器自己读它并核对新鲜度。
- `book-e2e` 用两份真实产物对比：冻结章的 id 在第二份里逐字保留（哨兵 `s131-u1-s1`），
  新章落在 `c2-…`；旁挂数据读回 2 章、frozen 在**条目层**（oracle 的归一形状）。
  互验后又补了：**两份产物各自新鲜、是不同文件**；`chapterFile` 必须等于
  `<页面>.isg.json` 且磁盘上真的存在；册的顶层 key **等于第一份产物的 key**。
- 清理自测同时验"该认的 5 类"与"不该认的 4 类"，并验目录外路径被拒；
  互验后补了**通道层**：用 `Bridge::DispatchForTest` 走 `run:scanCleanup/doCleanup`，
  证明"渲染层递任意 jobId / 任意路径"删不了东西。
- 打包：便携目录 10.79 MB、zip 5.08 MB；NSIS 没装 → 明确跳过。

## 4. 心路

**① 最危险的不是异常，是"少一项"。**
原始字符串少一个 `)`、`checks` 传错一层、`page.demos` 丢一个字段 ——
三件事都没有异常、没有日志，只有报告里少一项或提示词里少一段。
**如果只盯着"任务 done、页面能开"，这三次都会被放过去。**

**② 删除逻辑必须知道"这个文件是谁的"。**
`probeCopy` 这个字段名骗了我：它同时承担了"要加载的页面"和"我创建的临时文件"两个语义。
拆成 `probeCopy` + `ownsProbeCopy` 之后才安全。
用户那条"删除之前先看目标"不是流程要求，是**数据结构要求**。

**③ oracle 也会错，而且错得更安静。**
`checks` 丢失发生在多章改造里，所有测试都绿。迁移时把 oracle 当基准没错，
但"逐字节复制"只保证一致，**不保证正确**；Phase 5 的 DoD 逼着我把
"演示核对真的跑了吗"变成一条可失败的判据，才把它抓出来。

**④ 假模型要能"持续犯错"，修复轮才测得出来。**
一次错的假模型会被审题改对；持续错的假模型才能证明 repair 真的重出、重跑、
并如实报告"仍有 1 项没过"。**测试的价值在于它能失败。**

## 5. 如果换我接手，我会先做这几件事

1. 读 `phase5-report.md` / `phase6-report.md`，再读这份。
2. 跑一次全量（含真 PDF、Key 兼容）：
   ```powershell
   powershell -File tools\phase1-verify.ps1 -BuildDir build3 `
       -SampleDir "<samples>"
   ```
3. **挑一条判据试着让它失败**：
   - 把 `src/verify/probe_runner.cpp` 的 `kDomFactsJs` 结尾改回 `})()JS"` → 报告少「顶栏总数」；
   - 把 `evalScript` 的 `demo.checks` 改回 `demo` → demo 核对变 0 组；
   - 把 `ownsProbeCopy` 恒置 true → demo 核对跑完删掉成品页；
   - 把 `book.js` 的 `no` 改回只认 `no` → book-e2e 的"第 13/14 章"判据变红；
   - 把 `expectedCounts` 调 1 → 全量立刻红。
4. **别在探针/演示核对里"顺手裁剪大字段"**：`domFacts` / `groups` 正是判据的输入。
5. **关窗时先 `bridge_.Detach()` 再 `verify_->Shutdown()`**：在途回包被静默丢弃，
   不会往正在销毁的页面投消息。

## 6. 附：寿命

| 东西 | 寿命 |
|---|---|
| `src/verify/probe_runner.{h,cpp}` | 长期；WebView2 驱动 |
| `web/logic/probe-parse.js` | 长期；探针口径的唯一定义 |
| `src/book/book.{h,cpp}` | 长期；旁挂数据读半身 |
| `web/logic/book.js`（oracle 复制） | 长期；写半身 |
| `src/pipeline/cleanup.{h,cpp}` | 长期；清理清单与删除护栏 |
| `--selftest=verify` / `pipeline-repair` / `book` / `book-e2e` / `e2e-mock` | 长期；新判据继续往 phase1-verify 加 |
| `tools/package.ps1` | 长期；NSIS 可后续补 |
| `_verify-out/` | 运行期产物，每次重新生成 |
