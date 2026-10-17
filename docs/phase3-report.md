# Phase 3 工作记录 · 网络与任务

> 日期：2026-10-17。状态：**实现完成，判据通过**。过程与心路见 [`guidance5.md`](guidance5.md)。
> 参照实现仍是 `apps/isg-studio/`（oracle），**不删不冻**。

---

## 1. 架构：SSE 状态机留在 JS，C++ 只搬字节

纲领 §6 对 `llm/index.js` 的处置写得很清楚：

> **拆**：SSE 状态机/重试/降级策略 → 原样搬进 Worker；`fetch` 传输 → C++。

这次就按这一条做，而不是在 C++ 里重写一遍 SSE：

```
web/logic/llm-index.js       ← oracle 的 llm/index.js，逐字节复制
web/logic/llm-openai.js      ← oracle 的 llm/openai.js
web/logic/llm-anthropic.js   ← oracle 的 llm/anthropic.js
web/logic/providers.js       ← oracle 的 providers.js

web/logic/shims/runtime.inc.js  ← 本工程新写：把 Node 的 fetch 换成
                                   "postMessage 给 C++，拿回状态/头/字节块"

src/net/net.cpp              ← WinHTTP：建连、发请求、把响应体按块送回页面
```

为什么这样分：

- `llm/index.js` 的 SSE 注释里记着**三个真实回归 bug**（`data: 0` 保活行吞流、
  标量误清 pending、1MB 雪球）。逐行翻成 C++ 是最容易翻车、收益最低的活；
- 降级表（`response_format` / `stream_options` / `max_tokens`）与重试策略都在
  `openai.js` / `index.js` 里，原样运行 = 一个字都没改；
- C++ 只做它必须做的事：**Key 不进页面**、WinHTTP、取消时真的关掉在途连接。

## 2. Key 的边界

页面拿到的 provider 配置里 `apiKey` 是哨兵 `__ISG_HOST_KEY__`（或空串）。
`net.cpp` 在发出请求前：

1. 把带哨兵的头（`Authorization: Bearer __ISG_HOST_KEY__` / `x-api-key` / `?key=`）删掉；
2. 从 `store.provider_config()` 取真 Key，按 `authField` / `format` 重新注入；
3. **核对 URL 的 origin 与 provider.baseUrl 的 origin 一致**，否则 `EBADURL`。
   没有这一步，页面（同时承载模型产出的 HTML）就能把"任意 URL + 自动附 Key"当 SSRF/外带用。

跨实现测试（net-fault）里断言了：故障服务收到的 `Authorization` 正是环境变量里的
测试 Key，而页面里没有明文 Key。

**本机端点可以没有 Key**：这一条与 oracle 的 `llm/index.js: isLocalBase` 对齐。
以前 `store.provider_config()` 无条件要求 Key，于是 Ollama / LM Studio 这类本机端点
在页面侧通过了参数校验，却在宿主这里被 `ENO_PROVIDER` 挡住 —— 用户看到的是
"配置没问题但连不上"。现在 `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]` /
`host.docker.internal` 允许空 Key，并且**不发明 `Bearer `（空令牌）头**。
`run-mock-selftest.py --no-key` 是这条的回归入口（26 条仍全过）。

**设置保存后预热的 provider 快照要失效**：`isg-bridge.js` 在 `settings:save` /
`settings:import` 成功后调用 `window.__isgPipelineInvalidate()`，否则用户改完
Base URL / Key 再点「测试连接」或「开始生成」，用的仍是上一次的配置
（症状是"设置改了没用，重启才好"）。

## 3. 任务生命周期

`src/pipeline/jobs.cpp` 对应 oracle 的 `jobs.js`，但只负责"记账与广播"：

- `gen:start`：归一 `sources` / `mode` / `options`，校验输出目录，建任务；
- `job:event`：`stage` / `log` / `delta` / `ask` / `done`，字段名与 oracle 一致；
- `gen:get` / `gen:list`：内存任务 ∪ `history.json`（50 条摘要）；
- `gen:cancel`：置取消标志 → 通知页面 → **`NetManager::AbortJob` 关掉在途 WinHTTP 请求**；
- 中途提问（`ask`）：页面 `jobs.ask()` 走 `_pipeline:ask`，C++ 挂起回包，`gen:answer` 落地；
  取消 / 失败 / 结束时一律按默认值收掉（与 oracle 的"五条出口"一致）。

**快照瘦身**：`gen:get` 只带最近 120 条日志、单条截 1200 字、去掉
`options.editedPages`。原因不是省流量，是 WebView2 单条消息有大小限制
（Phase 1 实测 161 KB 的字符串收不到）；完整日志已经由 `job:event` 逐条送过。

## 4. 判据与证据

一条命令：`powershell -File tools\phase1-verify.ps1 -SkipBuild -SkipKeyCompat`
（Phase 3/4 的判据都挂在这个脚本里，不另起）。

### 4.1 `--selftest=net-fault`（26 条）

故障服务（`tools/net-fault-server.js`）按顺序回：

1. `400 response_format is not supported`
2. `400 stream_options is not supported`
3. `429` + `Retry-After: 0`
4. `200` + SSE（**故意切包**，并夹一条 `data: 0` 保活行）

实测全过：最终正文 `{"ok":1}`、`usage.in/out = 10/5`、`degraded` 含两个字段、
请求记录里第 1 次有 `response_format`、第 2 次没有、第 3/4 次两个都没有；
`Authorization` 由宿主注入；`settings:test`（GET /models）也通过。

这条同时覆盖了 Phase 3 DoD 里的 `request-shape` 与 `llm-smoke` 的等价检查：
请求体字段（`model` / `temperature` / `max_tokens` / `messages`）、
`response_format` 与 `stream_options` 的形状、流式开关、工具层重试与降级
都真的作用到了线上请求。页面侧还断言了收到 **>1 个 HTTP chunk**，
证明 SSE 确实是跨消息块拼出来的。

> ⚠️ `Retry-After` 故意写 `0`，所以这条证明的是"**会**重试"，不是"退避了多久"。
> 真实退避曲线（1s/3s/9s + 抖动）沿用 oracle 的 `backoffDelay`，没有单独测。

### 4.2 `--selftest=pipeline-mock`（23 条）

复用 oracle 的 `test/mock-provider.js`（独立进程），把**整条流水线**跑通。
mock 的 SSE 本来就是不规则切包的，因此这条也走了一遍跨 chunk 拼接；
但"确实收到了多个 chunk"的直接证据在 §4.1（`__isgLastFetchChunks > 1`）。
详见 Phase 4 报告。

### 4.3 `--selftest=pipeline-cancel`（9 条）

故障服务用 `slow` 模式（每个请求睡 10 秒）。任务启动 1.5 秒后取消：

- `cancelGeneration` 返回 true；
- **约 0.26 秒**内任务变成 `canceled`（服务端还要睡 10 秒，所以这不是"等它超时"）；
- 故障服务端记录到**连接在响应写完之前被关掉**（`aborted` 记录），证明宿主真的中止了在途请求；
- 日志里有「用户取消了任务」。

### 4.4 没单独做的一条

- **`emitted===0` 才允许重试**：net-fault 的 429 发生在还没有任何正文时，
  这正是允许重试的分支；"已经吐过字就不再重试"这一条沿用 oracle 的代码，
  没有另造一个"吐一半再 429"的服务去验。这条**已记账**，不是没实现。

## 5. 与 oracle 的差异（逐条）

1. **HTTP 传输换成 WinHTTP**：请求/响应字节层面等价；重定向、代理、TLS 走系统栈。
2. **Key 用哨兵 + 宿主注入**：页面里永远没有明文 Key（oracle 里 Key 在 Electron 主进程，
   等价）。
3. **取消适配**：oracle 的 `llm.chat` 在外部 abort 时抛 `LlmError{code:'EABORTED'}`，
   没有 `canceled` 标志；pipeline 的 `askJson` 只在 `e.canceled` 时走取消分支，
   否则会把"用户取消"记成 failed。宿主在 llm 模块外包了一层（**不改 oracle 文件**），
   给 EABORTED / signal.aborted 补 `canceled=true`。这条差异实测过（约 0.26 秒 → canceled）。
4. **`settings:test` 由页面里的 llm 层执行**：宿主只转发 providerId，
   与真生成走同一条代码路径（oracle 也是主进程直接调 `llm.testConnection`）。
5. **快照瘦身**（见 §3）。oracle 的 `snapshot()` 全量返回；我们在消息边界上做了裁剪。
6. **Anthropic 请求形状**没有单独造故障服务验：适配器是逐字节复制的；
   宿主侧只按 `anthropic-version` 头决定注入 `x-api-key` / `Authorization`。
7. **numeric-cases** 没有重跑：那套测的是生成页里的判分引擎（skill 资产），
   引擎在 Phase 4 的拼装里是**逐字节**进来的；要执行页面里的引擎需要 Phase 5 的探针窗口。

## 6. 留给下一阶段

- Phase 5：`verify:run` 仍是 `NOT_IMPLEMENTED`；探针窗口只有"能加载能读 title"。
- Phase 6：`run:scanCleanup` / `run:doCleanup` / `book:*` 仍是 `NOT_IMPLEMENTED`。
- 历史摘要的 `mergeStatus` 目前只有 `html` / `missing` / `unfinished`（没有 `chapter`），
  因为旁挂 `.isg.json` 是 Phase 6。
