# Phase 4 工作记录 · 流水线与拼装

> 日期：2026-10-17。状态：**实现完成，两条 DoD 都通过**。过程与心路见 [`guidance6.md`](guidance6.md)。
> 参照实现：`apps/isg-studio/`（oracle），不删不冻。

---

## 1. 交付了什么

### 1.1 逐字节搬过来的纯逻辑

| 新工程文件 | oracle 来源 | 做法 |
|---|---|---|
| `web/logic/pipeline.js` | `pipeline/index.js` | **逐字节复制**（只改了文件名） |
| `web/logic/prompts.js` | `pipeline/prompts.js` | 逐字节复制 |
| `web/logic/sources.js` | `pipeline/sources.js` | 逐字节复制 |
| `web/logic/chapters.js` | `pipeline/chapters.js` | 逐字节复制 |
| `web/logic/revive.js` | `pipeline/revive.js` | 逐字节复制 |
| `web/logic/bank.js` / `assemble.js` | 同名 | Phase 1 已搬，Phase 4 继续用 |
| `web/logic/llm-*.js` / `providers.js` | `llm/*.js` / `providers.js` | 逐字节复制（Phase 3 已搬） |

`tools/sync-web.ps1` 的 `$logicSourceMap` 是**唯一**的复制清单；`tools/golden/bundle-logic.js`
把同一批文件包成浏览器可加载的 `logic-bundle.js`，并在校验模式下检查 bundle 没过期。

### 1.2 新写的适配层（不是 oracle 的一部分）

| 文件 | 作用 |
|---|---|
| `web/logic/shims/runtime.inc.js` | `fs` / `path` / `store` / `jobs` / `preview` / `extract` / `skill` / `version` / `book` / `verify` / `fetch` 的浏览器垫片 |
| `web/logic/pipeline-host.js` | 取预热的 skill/契约/任务快照（分块）、驱动 `runGeneration`、转发取消与测试连接 |
| `web/isg-bridge.js` 的 `__isgHost` | 内部通道的唯一入口（不属于 31 个公开通道） |
| `src/pipeline/jobs.cpp` | 任务生命周期与 `job:event`（见 Phase 3 报告） |
| `src/bridge/bridge.cpp` 的 `_pipeline:*` | 分块取 skill/契约/任务、`_pipeline:ask` |

**为什么不把流水线翻成 C++**：纲领 §3.2 的决策是"纯逻辑留在 JS，只把特权能力落到 C++"。
`pipeline/index.js` 里最贵的是校验器、计票规则、提示词拼装和阶段编排 —— 这些逐字节搬过来，
比翻译成 C++ 更安全，也让 prompts 与契约保持"一个字的都不改"。

**同步 `fs` 的死结**：oracle 的模块大量用 `readFileSync`。解决方式是**预热 + 分块传输**：
启动自测/每次生成前，页面用 `_pipeline:env` + `_pipeline:filePart` 把
`SKILL.md` / `page-skeleton.html` / `generation-contract.md` 取回内存（`fs` 垫片只读这份快照）。
写文件走 `op:writeFileBegin/Chunk/End`，按 16K 个 UTF-16 码元分块（≤ ~48 KB JSON 文本），避免 WebView2 的单条消息上限；结束消息带块数与字节数，宿主对账。

### 1.3 八阶段编排

沿用 oracle 的 `runGeneration`：

```
extract → analyze* → plan → prose + bank → demo → assemble → verify → repair
```

- `extract`：页面调 `extract:preview`，实际由 C++ 的 PDFium/PPTX/文本层完成；
- `analyze`：多来源才跑（单来源跳过）；
- `plan` / `prose` / `bank`：`mapLimit` 并发 3（`CONCURRENCY_DEFAULT`）；
- `demo`：按大纲的 demoIds 逐个生成；
- `assemble`：`assemble.js` 原样调用；
- `verify` / `repair`：**Phase 5 的探针驱动还没实现**。`verify/runner` 的垫片明确抛
  "Phase 5 才实现"，`runGeneration` 的 `try/catch` 把它记成一条 warn
  （"页面已生成，但这一页没有被自动验证过"），然后 `repair` 标成 skipped。
  这不是静默跳过：日志与阶段状态都写得很清楚。

`auditBank` 的计票规则原样保留：N 位审题人各自独立重算、同一位内按题 id 去重、
多人时"两人独立确认"才改、只让 `severity:'high'` 触发重出、最多 2 轮。

## 2. DoD 与证据

### 2.1 金标准对拍（逐字节）

`tools/golden/make-golden.js` 现场用 oracle 的 `assemble.js` 生成基准；
C++ 侧在 WebView2 里加载**同一份** `logic-bundle.js`，喂**同一份** fixture，
产物 157557 字节、sha256 `c05a28cf…`，**逐字节相同**。
Phase 4 改了 bundle 的内容（多了 pipeline/llm 模块），这条判据仍然全过。

### 2.2 `audit-pass` 等价回归

`--selftest=pipeline-mock`（23 条）用 oracle 的 `test/mock-provider.js` 的
`auditMode:'catch-and-fix'`：

1. 假模型第一次给 u1 的数值题写 **999**；
2. 独立审题读到 `"ans":999`，报一条 `wrong-answer`；
3. 计票达到 1/1（auditors=1），触发重出；
4. 第二次题库写 **200**；
5. 最终页面里 `"ans":200` 在、`"ans":999` 不在。

宿主侧还独立核对了：
- `audit.rounds ≥ 1`、`audit.high ≥ 1`（来自宿主保存的任务快照；值是页面在 `finish` 时写入的，不是宿主独立计算的）；
- 日志里有「答案级问题被独立确认 → 按意见重出」；
- 产物 >10 KB、含 `data-bank`、`s-total`、演示块；
- `usage.calls > 0`。

这条同时证明：流水线、提示词、题库校验、审题、重出、拼装、落盘是一条真的链，
不是"把 oracle 的 JSON 复制了一份"。

### 2.3 并发与取消

- 并发限 3：代码里是 oracle 的 `mapLimit(…, 3)`；本测试**没有独立测量并发度**，只看到页面回传的 `usage.calls=16`。
- 取消：`--selftest=pipeline-cancel` 9 条全过，约 0.26 秒内从 running → canceled，且服务端看到连接提前断开（见 Phase 3 报告）。

### 2.4 判据条数

| 自测 | 条数 |
|---|---|
| `net-fault` | 26 |
| `pipeline-mock` | 23 |
| `pipeline-cancel` | 9 |
| 金标准 | 逐字节 + 指纹/新鲜度/输入 SHA256 |
| Phase 1/2 原有 | 91 |

> **口径说明**：91 是 Phase 2 报告里的**顶层判据**口径；上表的 26/23/9 是
> 各套自测内部的**子判据**条数。两者不能相加（`phase1-verify.ps1` 的
> `expectedCounts` 只用于后者）。外层判据的条数取决于跳过了哪些：
> 全量（含样本与 Key 兼容）是 **95 条**；只跑 Phase 1–4 且跳过样本/Key 时是 **31 条**。

## 3. 与 oracle 的差异（逐条）

1. **`text.js` 的切页逻辑仍留在 C++**。Phase 2 已记账：编码识别是宿主能力，
   纯切页逻辑本该搬回 Worker。这次没有搬 —— Phase 4 的抽取走 `extract:preview`（C++），
   把它搬回 Worker 会与 PDFium 的页模型重复。**这条 DoD 缺口继续记账**，
   若要做，应单独立项并补 `check-logic-sync`。
2. **verify/repair 是明确的 Phase 5 缺口**（见 §1.3）。
3. **`book.js` 的旁挂 `.isg.json` 是 Phase 6**：`writeBook` 垫片返回
   `{ok:false, reason:'Phase 6 才实现'}`，`runGeneration` 记一条 warn。
   产出的页面照常可用，但"以后并进一册"的能力还没有。
4. **`jobs.ask` 的实现**：oracle 在进程内挂 Promise；这里走 `_pipeline:ask` 到 C++，
   由 `gen:answer` 回包。语义相同（一个任务同时只有一个未决问题、取消/结束按默认值收掉）。
5. **`fs` 垫片**：只读预热的 skill/契约快照；写文件走分块消息。
   路径拼接用一份 win32 语义的 `path` 垫片，不是 Node 的 `path`。
6. **`electron` 垫片**：`app.isPackaged=false`、`getPath('userData')` 返回宿主给的目录。
   `prompts.js` 的契约查找因此总是走到"开发态候选"，由 `fs.existsSync` 垫片命中预热的契约。
7. **取消标志的包装**（见 Phase 3 报告 §5.3）。
8. **大字段裁剪**：任务完成时页面回传的 `sources[].pages` / `options.editedPages` /
   `outputs[].report` 被剥掉（`jobs` 垫片的 `summary()`），否则单条消息可能超限。

## 4. 复跑

```powershell
# 全部判据（含干净构建）
powershell -File tools\phase1-verify.ps1 -BuildDir build2

# 只跑 Phase 3/4 的三套（需要先构建）
python -I tools\run-mock-selftest.py --selftest=pipeline-mock `
    --exe build2\dist\isg-studio.exe --report _verify-out\selftest\pipeline-mock.json `
    --server tools/mock-provider-server.js --server-arg audit `
    --fixture tools/mock-fixture.md --out _verify-out\pipeline
```

## 5. 留给下一阶段

- Phase 5：`verify/runner` / `demo-checks` 的垫片接上真探针窗口；`repairRound` 就能跑。
- Phase 6：旁挂 `.isg.json`、多章/带上以前的章、清理、计费预估。
- `numeric-cases` / `hostile-input` 的页面级等价检查需要 Phase 5 的探针窗口；
  它们测的是 skill 引擎，而引擎是逐字节进来的。
