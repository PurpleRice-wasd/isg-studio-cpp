# Phase 6 工作记录 · 收尾功能

> 日期：2026-10-17。状态：**实现完成**。参照实现：`apps/isg-studio/`（oracle）。
> 过程与踩坑见 [`guidance7.md`](guidance7.md)；Phase 5 见 [`phase5-report.md`](phase5-report.md)。

---

## 1. 交付了什么

### 1.1 旁挂结构化数据（`.isg.json`）

- **写**：oracle 的 `book.js` 逐字节复制进 `web/logic/book.js`，由 bundle 加载；
  写盘走浏览器垫片：
  `writeFileSync` → 分块消息 → 宿主写 `<页面>.isg.json.tmp`，
  `renameSync` → 宿主 `MoveFileEx(REPLACE_EXISTING)` 原子替换。
  失败**只记 warn**，页面照常交付（与 oracle 的约定一致）。
- **读**：宿主 `src/book/book.{h,cpp}`。`book:list` / `book:inspect` / `gen:start(carry)`
  都走它；schema 只认 `isg-book/1`，坏文件/版本不认识会**明确说不可用**，不猜。
- `chapter.no` 与 `chapter.number` 两种写法都认；数据库里的题库**原样搬**，不重算题 id。

### 1.2 「带上一章」

- `book:list`：历史 + 内存任务摘要，带 `mergeStatus`（chapter / html / missing / unfinished）、
  `canMerge`、`exactMerge`、`mergeHint`。
- `book:pickFile`：系统文件对话框（只留 HTML），**当场放行**用户选中的位置。
- `book:inspect`：旁挂数据优先；没有时把 HTML 交给页面里原样搬来的 `revive()` 反推。
  返回形状恰好 `{ok, from, chapter, problems, canCarry}`，**不返回 data**。
- `book:continuity`：C++ 等价实现 `chapters.js:judgeContinuity`
  （数字章号按数值、非数字一律判不连续、重复按集合看）。
- `gen:start` 的 `carry`：
  - 路径来源分信任级：`history` 的路径出自我们自己的历史，可放行；
    `file` 必须已经通过 `book:pickFile` 的放行；
  - 带过来的章**排在新章前面**、条目标 `frozen:true`；
  - 本身是册时记下册的**顶层 key**（再加一章进度不用搬家）；
  - 不可用 → `CARRY_UNUSABLE`，**先验后建**，不留僵尸任务；
  - `separate + carry` 当场 `BAD_ARG`。
- 多章：`JobStore::Create` 做章号归一与"一部分填了、一部分没填"的拒绝；
  流水线自己重新分组、串行跑、按 `book` / `separate` 出页面。

### 1.3 收尾与清理

- `src/pipeline/cleanup.{h,cpp}` 等价 oracle `cleanup.js`：
  - 认产物 / 旁挂数据 / 探针副本（`_probe_<pid>_<序号>_`，两段数字是硬特征）/
    `*.run.log` / **本次真拷过**的陪练图（必须拿到日志证据）；
  - 用户自己起的 `_probe_notes.html`、`_probe_2024.html`、`*.run.log.bak`、`pet.png`
    在没证据时**一律不列**；
  - `run:doCleanup` **重新扫一遍**、只删仍在清单里的路径，且必须在输出目录内；
  - 取消时用户选「清除」→ 流水线收尾后按清单删除，并把结果写进任务日志。
- 「取消并清除」的文案不再说"Phase 6 才实现"。

### 1.4 打包

`tools/package.ps1`：

- 铺 `build-package/isg-studio-1.4.2/`：exe + pdfium.dll + web/ + skill/ +
  docs/generation-contract.md + LICENSE + README.txt；
- 生成便携 zip（本次实测 **5.08 MB**，目录 **10.79 MB**，≤ 15 MB 目标）；
- 有 `makensis.exe` 时生成 NSIS 安装包；**没装时明确打印跳过**，不静默。

### 1.5 已有能力（Phase 1–4 已做，本轮接上界面）

- 设置导入/导出（白名单挑字段）、计费预估（结果页读 `job.usage` + 用户填的单价）、
  关于页（skill 来源、许可、第三方素材）——都已由原样搬来的渲染层使用。
- `book:list/pickFile/inspect/continuity`、`run:scanCleanup/doCleanup` 全部从
  "明确报 NOT_IMPLEMENTED" 变成真实现。

## 2. DoD 与证据

| DoD | 等价检查 |
|---|---|
| `multi-chapter` | `--selftest=book-e2e`：第 1 次生成第 13 章；第 2 次生成第 14 章并带上第 13 章 → 1 份一册、2 章、日志有「带上了 1 章」「这一份是一册」 |
| `progress-move` | 同一套：第二份 HTML 里有「进度搬家」脚本；带过来的章 id 与它单独成页时一致（哨兵 `s131-u1-s1`），新章落在 `c2-…` 命名空间 |
| `book-ipc` | `--selftest=book`（真窗口）：三条通道信封/形状、`book:inspect` 不返回 data、没放行的路径 `NOT_ALLOWED`、坏文件 `canCarry=false`、`gen:start` carry 失败不留僵尸任务、`separate+carry` 拒绝；`--selftest=book-data`（无窗口）：schema/章号/连续性/mergeStatus/题库原样搬 |
| `cleanup` | `--selftest=cleanup`：认 5 类文件、不误认用户文件、totalBytes 对账、只删清单内、目录外拒绝、单个失败不中断；**还走 bridge 通道**验 `run:scanCleanup/doCleanup` 自己查任务、自己重扫 |
| 多来源独立分析 | `--selftest=multi-source`：courseware + exampaper 两份来源各跑一次分析；产出页里搜到真题分析的哨兵 `MARK-EXAM`（8 条） |
| 跨章演示 id | `book-e2e` 两章都有演示：后一个 `demoA` 被拼装器改成 `demoB`，demo-checks 用最终 id 核对，第二册报告 42 项无 false |
| 旁挂数据真的落盘 | `book-e2e` 宿主读回第二份 `.isg.json`：2 章、带过来的章条目 `frozen:true`、册的顶层 key 稳定 |
| 打包 | `tools/package.ps1` 实测产出便携 zip；NSIS 因本机无 makensis 被明确跳过 |

## 3. 与 oracle 的差异

1. 旁挂数据的**读半身**在 C++（IPC 通道需要同步返回）；写半身仍是 oracle 的 `book.js`。
2. `book:inspect` 的反推路线通过 `host-request 'revive'` 交给页面执行（revive 是纯逻辑，
   继续住在 `web/logic/`），宿主只负责读 HTML 和包信封。
3. 取消了 oracle 中"`.isg.json` 旁挂 + 以后并册"之外的 `bookFile` 语义：本工程没有
   单独的册文件，册就是 HTML 本身（与 oracle 一致），`bookFile` 字段保留为空串。
4. NSIS 脚本是本次新写的；本机没有 makensis，**安装包未产出**。

## 3.1 三路互验后补的硬修复

1. **`finish` 快照里的 `htmlPath/chapterFile` 先校验再落账**：历史会把 `htmlPath`
   当成可信路径再次放行；现在必须落在任务输出目录内，且 `chapterFile` 在磁盘上真实存在。
2. **`gen:start`/`book:inspect` 的 revive 路线分块**：见 Phase 5 报告 §3.1 第 4 条。
3. **`book-e2e` 的独立证据**：两份产物各自新鲜、是不同文件；`chapterFile` 必须等于
   `<页面>.isg.json`；册的顶层 key 必须等于第一份产物的 key。
4. **`cleanup` 走到了通道层**：`Bridge::DispatchForTest` 直接调
   `run:scanCleanup/doCleanup`，验证"任意 jobId / 任意路径"删不了东西。
5. **`pipeline-repair` 的变异证据**：假服务写 `repair-events.jsonl`（注入 999999），
   `phase1-verify.ps1` 自己读并核新鲜度；宿主同时断言失败 note 里带 999999。

## 3.2 全量验证

`powershell -File tools\phase1-verify.ps1 -BuildDir build3 -SampleDir <试验PPT>`：
**103 条外层判据、0 跳过**，报告绑定 exe SHA256（与当前 exe 一致）。

## 4. 记账的缺口

- **NSIS 安装包未实测**（`makensis.exe` 不在 PATH）；便携目录与 zip 已实测。
- 未单独造"带上一章 + 多来源 + separate"三者的组合矩阵；
  `book-e2e` 覆盖了 book 模式，`separate` 只用拒绝路径验过。
- `book:pickFile` 会弹模态对话框，自动化里没有点它；只验了方法存在与放行语义
  （与 oracle 的 book-ipc 测试同一取舍）。
- `cancel + clear` 的端到端只有 `cleanup` 模块与通道级判据，没有在真实取消中途删除文件
  （删除发生在流水线收尾之后，此时探针副本已不再被使用）。
- `book` 的 sidecar 夹具是手写 JSON、`verify` 的基准页是 `spike/_fixtures` 的静态产物；
  它们验的是"通道/解析口径"，不是"当前生成器的产物"。真实生成链路由
  `book-e2e` / `e2e-mock` / `pipeline-mock` 覆盖；只改生成器、不动夹具时，
  `verify`/`book` 这两套不会红 —— 这是刻意的分工，别把它读成"夹具也验了生成器"。
