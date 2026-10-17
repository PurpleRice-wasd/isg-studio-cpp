# Phase 5 工作记录 · 校验与修复闭环

> 日期：2026-10-17。状态：**实现完成，DoD 通过**。
> 参照实现：`apps/isg-studio/`（oracle），不删不冻。过程与踩坑见 [`guidance7.md`](guidance7.md)。

---

## 1. 交付了什么

### 1.1 宿主：探针窗口驱动（`src/verify/probe_runner.{h,cpp}`）

| 能力 | 实现 |
|---|---|
| 探针注入 | 逐条复刻 oracle `verify/inject.js`：错误收集器插在 `<meta charset>` / `<head>` 之后；`</body>` 必须唯一；探针正文里出现 `script` 字样直接拒绝 |
| 探针副本 | 写到被测页**同目录** `_probe_<pid>_<序号>_<原名>`；目录不可写才退化到 `%TEMP%\isg-probe-…` 并写明"陪练/背景两项会被误报" |
| 独立浏览器上下文 | 自己的窗口类 + 自身的 WebView2 environment/user data（`<userData>\WebView2\verify`）+ 自己的协议安装 |
| 导航守卫 | `NavigationStarting` / `FrameNavigationStarting` 只放行我们自己发起的那个 URL，页面跳转一律取消；`NewWindowRequested` 一律 `Handled=TRUE` |
| 等待结果 | 计时器驱动状态机：轮询 `document.title`（250ms）→ DOM 快照 → `__PROBE_ERRS__` / console.error 收集器；全部主动动作**从计时器那一拍发**（避开 WebView2 回调栈重入） |
| 收尾 | `ClearBrowsingDataAll` 清轮次间的 localStorage → 删探针副本 → 回包；关窗时取消在途请求并按序释放 controller/webview/env/窗口/类 |
| demo 核对 | 在同一个探针窗口里执行 `set → 读读数`，返回 groups；0.5% 相对容差在页面侧比较（见下） |

### 1.2 页面：解析与比较（`web/logic/probe-parse.js`）

从 oracle 的 `verify/runner.js` / `demo-checks.js` **逐函数搬**过来，落成一个普通脚本：

- `；` 分隔 + `【组名】` 前缀继承；
- `顶栏总数` 用 DOM 快照与题库作答点数对账（防"题库渲染两遍"）；
- `各关计数` 的分母按**作答点**算，不平题卡数；
- 陪练段逐行判据（`evalPetLine`）；
- 超时 / 中断 / 环境告警 / `__PROBE_ERRS__` 的补项；
- `sameValue` / `pickNumber` / `near`：数字按 **0.5% 相对容差**，文本按去空白后逐字。

宿主只回**原始读数**（title / domFacts / probeErrs / consoleErrors / warnings / timedOut），
"什么叫通过"只有一份实现。

### 1.3 接线

- `runtime.inc.js` 的 `verify-runner` / `verify-demo` 改为调 `verify:run` / `_verify:demo`；
- `isg-bridge.js` 的 `verifyHtml` 在回包后解析成报告（结果页「重新校验」直接可用）；
- `pipeline.js` 的 `verify` / `repair` 阶段不再标"Phase 5 才实现"：
  `runProbesAndChecks` 真的跑探针与 demo-checks，`repairRound` 真的重出演示并重跑校验；
- `job.report` 不再被 `summary()` 丢掉：`finish` 快照会把它带回合宿主，结果页能显示 11 项报告。

### 1.4 修掉的两处 oracle 侧回归（同步回 oracle，再逐字节复制）

1. `pipeline/index.js` 的章节 demos 映射漏了 `checks` / `sliderId` / `viewBox` ——
   `page.demos` 里每一组都没有 checks，`checkDemos` 永远判"没有可核对的 checks"，
   **演示核对在多章改造后静默失效**。修复轮写回 `target` 时也补上这三个字段。
2. 旁挂数据的 `chapter.no` 只认 `no`，而拼装器落盘的是 `number` ——
   真实生成链写出的旁挂数据会丢章号；带过来的章会按数组序号显示"第 1 章"。
   现在 `book.js` 两种写法都认，`pipeline` 的 carried 映射补 `number`。

## 2. DoD 与证据

| DoD | 证据 |
|---|---|
| `e2e-mock` 等价端到端 | `--selftest=e2e-mock`：真 PDF（`03 地球椭球-1.pdf`，33 页）→ PDFium 抽取 → 假模型生成 → 拼装 → **真探针**；31 条判据全过 |
| 探针真的会失败 | `--selftest=verify`：把页面里所有 `<script data-bank` 改坏 → 报告 `题库条目` ok=false；好页面则 0 项 false |
| demo 读数核对 | 同一套里：`_verify:demo` 对 `3×2=6` 判 ok，对"期望 7"判 false；0.5% 容差的正反例都过 |
| 修复闭环 | `--selftest=pipeline-repair`：假服务代理把演示 checks 改坏 → demo-checks 抓 false → `repair` 阶段 done（detail「仍有 1 项」）→ 日志有「演示 … 已重出」；**没有**假装全绿 |
| 真实流水线 | `--selftest=pipeline-mock`：28 条（含宿主对 `job.report.items`、demo-checks、verify 阶段状态的对账） |
| 清理 | 探针副本在收尾后 0 残留（verify 自测与 book 自测的宿主判据）；demo 核对加载**原页面**时不会被当成副本删掉 |

## 3. 与 oracle 的必要差异

1. 解析与 0.5% 比较放在页面侧（`probe-parse.js`），宿主只交原始读数；
   oracle 的解析也本来就在 Electron 主进程里，对"口径只有一份"的要求一致。
2. WebView2 没有 Electron 的 `console-message` 事件：用
   `AddScriptToExecuteOnDocumentCreated` 注入 `console.error` 收集器，读回后作为 `consoleErrors`。
3. 探针窗口复用**一个** environment + 每轮 `ClearBrowsingDataAll`，而不是每次新建 profile
   （oracle 的结论也是"固定池 + 每轮清空"）。
4. `ExecuteScript` 返回值在运行时版本间有"对象 JSON / 再包一层字符串"两种口径，
   宿主两种都认（`exec_result_json`）。只认一种时，DOM 快照与 demo groups 会静默变空。

## 3.1 三路互验后补的硬修复

第三路（验证体系）与第一/二路互验指出的问题，已在本轮修掉并补了判据：

1. **`probe-parse.js` 的 `item()` 丢了 `label`**：`repairRound` 靠 `/演示|滑块|SVG/`
   匹配 label 决定要不要重出演示，`undefined` 永远不匹配 —— 修复轮对探针报出的
   SVG/滑块/脚本错误静默失效。现在 `label: LABELS[key] || key`。
2. **演示核对用 plan id 去最终页面找元素**：一册里两章都有 demoA 时，后一个被拼装器
   改成 demoB；`demosForChecks()` 用 `finalChapters` 的最终 id 对齐，checks 仍取原对象。
3. **finish 回包里的 `carry` 可能超单条消息上限**：`summary()` 不再回传 carry
   （宿主本来就有原件），`consoleErrors` 截到 50 条。
4. **`host-request` / `host-reply` 两个方向都分块**：revive 要传整份 HTML、回传整章结构，
   150 KB 量级；现在头（chunked）+ base64 分片 + end，页面拼整串 base64 再解码。
5. **probe 窗口的挂起兜底**：加 `ProcessFailed`；collector 10 秒装不上就跳过；
   总截止时间后强制收工；清浏览数据 5 秒超时；关窗时删除在途探针副本。
6. **demo 核对失败不能伪装成"没读数"**：ExecuteScript 失败时注入一条 miss；
   超时回包带 `timedOut`，页面侧判 `ok=false`。
7. **环境/控制器重试的代际**：每次新建/销毁 `++gen`，迟到的回调只认自己那一代，
   避免"控制器绑在已销毁窗口上"被后续请求复用。

## 4. 记账的缺口

- 结果页的「重新校验」与流水线校验共用同一条 `verify:run`；单次超时固定 45s，
  没有按页面大小自适应（与 oracle 的 `ipc.js:998` 一致）。
- 未测"多审计人 split"与探针窗口的 26 演示上限；它们由 oracle 代码保证，C++ 没另造判据。
- `repairRound` 的"修好后全绿"路径没有专门的假模型用例（代理会持续弄坏 checks）；
  现有用例证明的是**修复轮真的跑了并如实报告仍有问题**，而不是"修好"。

## 5. 复跑

```powershell
# 全套（含真 PDF 与 Key 兼容；没有样本时 e2e-mock/extract-pdf 会被明确跳过）
powershell -File tools\phase1-verify.ps1 -BuildDir build3 `
    -SampleDir "<samples>"

# 单跑
python -I tools\run-mock-selftest.py --selftest=e2e-mock --exe build3\dist\isg-studio.exe `
    --report _verify-out\selftest\e2e-mock.json --server tools\mock-provider-server.js `
    --server-arg audit --fixture "C:\...\03 地球椭球-1.pdf" --out _verify-out\e2e
```
