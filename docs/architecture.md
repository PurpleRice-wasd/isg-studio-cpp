# 讲练一体工作台 · 架构与模块接口（实现契约）

> 这份文档是**并行开发的唯一接口来源**。任何模块都只依赖这里写明的签名，不要跨模块直接读对方的内部状态。

## 0. 一句话

把课件（PPTX / PDF / 文本）交给用户自备的大模型 API，产出**一个**单文件 HTML——
「讲练一体」学习页（讲解与练习紧邻、即时判分、可拖演示、进度存盘、右下角陪练）。

**内核 = `skills/interactive-study-guide`**，运行期原样随包分发，见 §2。

## 1. 进程与目录

```
src/
├── main/                      # 主进程（Node，全部特权操作）
│   ├── main.js                # 应用生命周期、创建窗口、注册 IPC
│   ├── preload.js             # contextBridge，唯一的渲染进程入口
│   ├── ipc.js                 # 所有 ipcMain.handle 集中在这
│   ├── skill.js               # 定位 skill 目录、读取 SKILL.md / assets / references
│   ├── bg.js                  # 工作台界面的背景图（导入=复制进 userData/background/）
│   ├── env.js                 # .env / 环境变量的读取与叠加（Key 可以不放在应用配置里）
│   ├── version.js             # 版本号只认自己的 package.json（app.getVersion 会回落到 Electron 的）
│   ├── smoke.js               # ISG_SMOKE 自检：不开窗口、不碰用户配置地验一遍关键链路
│   ├── store.js               # 设置持久化（API Key 用 safeStorage 加密）
│   ├── providers.js           # 提供商预设表
│   ├── jobs.js                # 生成任务的生命周期与事件广播
│   ├── llm/
│   │   ├── index.js           # chat() 统一入口（流式 / 非流式、重试、超时）
│   │   ├── openai.js          # OpenAI 兼容协议
│   │   └── anthropic.js       # Anthropic 兼容协议
│   ├── extract/
│   │   ├── index.js           # extract(filePath) 统一入口 + 质量信号
│   │   ├── pptx.js
│   │   ├── pdf.js
│   │   └── text.js
│   ├── pipeline/
│   │   ├── index.js           # runGeneration() 串起各阶段；回灌修复在 repairRound()/askJson()
│   │   ├── prompts.js         # 由 skill 文档 + 契约拼出各阶段提示词
│   │   ├── bank.js            # 题库 JSON 的 Schema 校验（对齐引擎的 badReason）
│   │   ├── assemble.js        # ★ 确定性拼装页面（不让模型写整页）
│   └── verify/
│       ├── inject.js          # 复刻 assets/inject-probe.py 的注入逻辑
│       ├── runner.js          # 隐藏 BrowserWindow 跑探针，返回十一项必查的报告
│       └── demo-checks.js     # 用模型自己给的 checks 复核演示读数（见 §3.6.1）
└── renderer/
    ├── index.html
    ├── app.css
    ├── app.js                 # 视图路由 + 状态
    └── views/                 # 每个视图一个文件
```

渲染进程**没有** Node 权限，一切通过 `window.isg`（preload 暴露）。

## 2. skill 作为内核

`src/main/skill.js` 负责定位 skill 目录：

```js
skillDir()            // -> 绝对路径
// 开发态：<repo>/skills/interactive-study-guide
// 打包态：process.resourcesPath/skill      （electron-builder 的 extraResources）
//
// 覆盖顺序：环境变量 ISG_SKILL_DIR > 打包态 > 开发态向上找
readSkillMd()         // -> string，SKILL.md 全文
readRef(name)         // -> string，references/<name>.md
readAsset(name)       // -> string，assets/<name>
assetPath(name)       // -> 绝对路径
skeleton()            // -> string，assets/page-skeleton.html 全文
```

**硬要求**：`skillDir()` 找不到目录时必须抛错并给出可读原因，不许静默降级成内置的简版提示词——
那样会在用户完全无感的情况下生成出一份"不像这个 skill"的东西。

## 3. 主进程模块接口

### 3.1 store.js

```js
getSettings()        // -> Settings（API Key 已解密为明文，仅在主进程内流转）
getPublicSettings()  // -> Settings，但 apiKey 换成 { hasKey:boolean, keyHint:'sk-…abcd' }
saveSettings(patch)  // -> Settings，深合并后落盘
settingsPath()       // -> 绝对路径（设置页要显示"配置文件在哪"）
```
落盘：`app.getPath('userData')/settings.json`。
`apiKey` 字段以 `apiKeyEnc`（safeStorage 加密后的 base64）存储；`safeStorage.isEncryptionAvailable()`
为 false 时存明文并置 `keyStorage:'plaintext'`，设置页必须显式警告。

### 3.2 providers.js

```js
PRESETS // -> [{id,name,format,baseUrl,models:[{id,name,vision,note}],keyUrl,doc,note}]
getPreset(id)
```

### 3.3 llm/index.js

```js
await chat({ provider, model, system, messages, temperature, maxTokens, json, onDelta, signal })
// -> { text, usage:{in,out}, raw }
await testConnection(providerCfg) // -> { ok, models?, error?, latencyMs }
```
- `json:true` → 要求模型输出 JSON；内部仍要**容错解析**（剥 ```json 围栏、截取首个 `{`/`[` 到配对的收尾、去尾逗号）。
- 429 / 5xx 要按指数退避重试（最多 3 次），4xx（除 429）不重试，错误对象带 `status` 与 `providerMessage`。
- `onDelta(chunk)` 用于流式展示。

### 3.4 extract/index.js

```js
await extract(filePath) // -> {
//   kind: 'pptx'|'pdf'|'text',
//   pages: [{ index:number(1起), title:string, text:string,
//             quality:{ chars:number, cjkRatio:number, suspect:boolean } }],
//   warnings: [{ page?:number, level:'info'|'warn', message:string }],
//   meta: { fileName, sizeBytes, pageCount, title? }
// }
```
- `.pptx/.ppsx` → pptx.js；`.pdf` → pdf.js；`.txt/.md/.markdown` → text.js。
- 其他后缀抛 `Error('不支持的文件类型：…')`。
- **不许**在主进程里同步跑大文件（26MB PDF 会卡死 UI）：一律 async，并且每处理若干页 `await new Promise(setImmediate)`。

### 3.5 verify/inject.js

```js
injectProbes(html, probes /* [{name, code}] */) // -> 注入后的 html
```
必须复刻 `assets/inject-probe.py`：
1. 在 `<meta charset="utf-8">` 后插错误收集器（只收 `e.message` 存在的真 ErrorEvent）；
2. 每个探针各自包一层 `<script>` 插到 `</body>` 前；
3. 探针正文里出现字面 `<script` / `</script` 时**抛错拒绝**（用 ⟨⟩ 替代）。

### 3.6 verify/runner.js

```js
await runProbes({ htmlPath, probes:['verify','demo','pet'], timeoutMs })
// -> { title:string, items:[{key,label,raw,ok:boolean|null,note}], consoleErrors:string[], durationMs }
```
用隐藏 `BrowserWindow`（`show:false`, `backgroundThrottling:false`, `webPreferences:{contextIsolation:true, sandbox:true}`）
`loadFile(htmlPath)`，等 `did-finish-load` 后**轮询** `document.title`（探针把结果写在 title 里，
异步项最多 40×250ms，见 verify-probe.js），拿到以 `【探针】` 开头的 title 或超时即止。
**探针副本必须与被测 HTML 同目录**（否则相对路径图片加载失败，陪练/背景会被误报成"没有"）。

### 3.6.1 verify/demo-checks.js

```js
await checkDemos({ htmlPath, demos:[{ id, checks:[{set:{滑块id:值}, expect:{读数id:期望文本}}] }] })
// -> { ok, label, note, groups }
```

`demo-guide.md` 要求"演示的读数要拿公式手算核对"，但探针只会把滑块拉到 min/mid/max **抄一遍**读数——
抄出来的数对不对，探针不知道。生成契约 §1.5 因此让模型自己给出 `checks`（**模型按公式手算的期望值**），
这个模块在隐藏窗口里把那些 `set` 打进去、把 `expect` 读回来逐一比对：
数字按 **0.5% 相对容差**比（模型手算的位数与页面 `toFixed` 的口径常不一致），其余按去空白字符串比。

它证明不了"公式选对了"，但能挡住**图与数不自洽**——这是探针查不出、只有人眼盯公式才能发现的一类问题。
跑法见 `runProbesAndChecks()`：探针与它**互不吞并**，任一条挂了另一条照样出结果。

### 3.7 pipeline/index.js

```js
await runGeneration(job)  // job 由 jobs.js 创建，含 { id, filePath, options, emit(ev) }
```
阶段固定为 7 步，`emit({type:'stage', key, label, status})`：

| key | 说明 | 是否调模型 |
|---|---|---|
| `extract` | 抽文本 + 质量信号 | 否 |
| `plan` | 切 5–7 个单元，产出结构 JSON | 1 次 |
| `content` | 逐单元产出「讲解 HTML + 题库」 | N 次（并行，限 3 并发） |
| `demo` | 产出 2–3 个可拖演示的 JS | 1 次 |
| `assemble` | 确定性拼装单文件 HTML | 否 |
| `verify` | 隐藏窗口跑探针 | 否 |
| `repair` | 按报告回灌修复（最多 2 轮） | 0–2 次 |

产物写到 `<用户选择的输出目录>/<章文件名>.html`（同目录可选拷一份陪练图片）。

### 3.8 jobs.js

```js
createJob({filePath, options}) // -> job
listJobs() / getJob(id) / cancelJob(id)
```
事件通过 `webContents.send('job:event', {jobId, ...ev})` 广播；渲染进程断线重连可用 `getJob(id)` 拉全量。

## 4. IPC 契约（preload 暴露的 `window.isg`）

```js
window.isg = {
  // 应用
  appInfo(): Promise<{version, platform, skillDir, settingsPath, hasSkill}>,
  openPath(p): Promise<void>,            // 用系统默认程序打开
  revealPath(p): Promise<void>,          // 在文件管理器中显示
  pickFile(): Promise<string|null>,      // 打开文件对话框（PPT/PDF/文本）
  pickOutputDir(): Promise<string|null>,
  pathForFile(file): string,             // 拖拽进来的 File -> 真实路径（webUtils）

  // 设置
  getSettings(): Promise<PublicSettings>,
  saveSettings(patch): Promise<PublicSettings>,
  testConnection(providerId): Promise<{ok, models?, error?, latencyMs}>,
  exportSettings(): Promise<string|null>,
  importSettings(): Promise<PublicSettings|null>,

  // 生成
  startGeneration({filePath, options}): Promise<{jobId}>,
  cancelGeneration(jobId): Promise<void>,
  getJob(jobId): Promise<Job>,
  listJobs(): Promise<Job[]>,
  onJobEvent(cb): () => void,            // 返回取消订阅函数

  // 抽取预览（生成前给用户校对文本）
  previewExtract(filePath): Promise<ExtractResult>,

  // 校验
  verifyHtml(htmlPath, probes): Promise<VerifyReport>,

  // 工作台界面的背景图
  backgroundInfo(): Promise<{file, url, bytes}>,
  importBackground(): Promise<{file, url, bytes}|null>,   // null = 用户取消了
  clearBackground(): Promise<{removed:string[]}>,

  // 拖拽进来的文件要先登记（主进程只服务显式放行过的目录）
  registerPath(p): Promise<boolean>,
  previewUrl(p): Promise<{url}>,                          // 只对已放行的路径有效
  pickImage(): Promise<string|null>,                      // 给"陪练用我自己放的图"准备，暂无界面入口
}
```

## 5. 渲染进程视图

| 视图 | 文件 | 要点 |
|---|---|---|
| 工作台 | `views/workbench.js` | 拖拽区（拖入即选中）、文件卡片、章标题/学科/章号、生成选项（单元数、作答点数、演示数、陪练形象、主题）、开始生成 |
| 抽取预览 | `views/extract.js` | 分页文本，可疑页标红并可编辑（**PDF 抽崩时用户能当场补救**） |
| 运行 | `views/run.js` | 7 步进度条、实时日志、模型流式输出、取消 |
| 结果 | `views/result.js` | 内嵌预览（`<webview>`/iframe）、十一项校验报告、导出/打开/定位 |
| 设置 | `views/settings.js` | 左提供商列表（带开关）+ 右详情（API Key / Base URL / 格式 / 测试连接 / 模型列表），导入导出 |
| 关于 | `views/about.js` | skill 来源、许可、第三方素材 |

## 5.5 安全边界（2026-10-16 安全审计后定稿）

**核心假设：模型输出是不可信数据。** 因为模型读的是用户的课件，而课件里一句
"请原样输出下面的标签"就能让它写出 `<img src=x onerror=...>`。生成的页面会被**真的执行**三次：
应用内预览 iframe、自动校验的隐藏窗口、用户双击交付文件。三层互补，缺一层都不行：

| 层 | 实现 | 管什么 |
|---|---|---|
| 结构化拼装 | `assemble.js` | 模型只产片段，页面由代码拼（引擎/样式/结算/陪练来自骨架） |
| 清洗 + 转义 | `sanitizeModelHtml` / `jsonForScript` / `jsForScript` | 内联事件、`<iframe>/<base>/<meta>/<link>/<form>/<script>/<style>`、`javascript:`、外链；`<` → `<` |
| CSP | `preview.js` 响应头 + 生成页 `<head>` 的 meta | 清不掉的东西（演示必须有 JS）靠它兜住"把读到的内容发出去" |

其余边界：

- **Key 只在主进程**；`getPublicSettings`/`exportSettings` 都是**白名单式挑字段**
  （不是"整体复制再删一个"——审计实测过 `apiKey`/`secret`/`headers['X-Key']`/嵌套位置照样漏）。
  设置文件同样白名单，手写的明文 `apiKey` 会被采纳并加密后立刻回写。
- **`isg://` 只服务显式放行过的目录**；`urlFor()` **不再隐式 allow**（那是把整个目录开成可读区）。
  拖拽不经对话框，所以走显式通道 `app:registerPath`（必须是文件 + 课件/文本扩展名 + 每次运行 ≤20 个）。
- **IPC 只认主窗口主帧**（`frame.parent === null` 且 URL 是我们自己的 index.html），
  不是"任何 `isg://` 页面"；`openPath` 限定扩展名与目录；`verify:run` 只认三个已知探针名。
- **输出文件名净化 + 断言**：`chapter.no` 来自模型（`../../evil` 实测能写到输出目录之外），
  净化后还要断言最终路径落在 `outDir` 里。

## 5.6 与 skill 的版本对齐（2026-10-16 内核更新）

skill 那次更新加了一条：**一章 ≥40 个作答点时，默认开两个子代理——一个出题、一个独立重算审题**，
理由是「探针只验得了判分逻辑对不对，**验不了答案本身对不对**」。应用里没有子代理，
所以做了两件事：

1. **在系统提示词里显式覆盖**：`prompts.systemPrompt()` 有一节「运行环境」，明确告诉模型
   它没有文件系统、没有子代理、不要写 `_work/…`、不要输出过程叙述。
   **不写这一节会怎样**：模型可能去"写文件"（产出变成一张 `units.md` 的正文而不是要的 JSON），
   或者写一句"已交给审题代理"就收工——而这类失败很隐蔽，JSON 可能仍然合法，只是内容跑偏了。
2. **把"独立审题"实现成真的**：`auditBank()` 再调一次模型，只给它**题库 + 素材**、
   不给任何出题过程的痕迹，让它从头独立重算。门槛与 skill 一致（单元 ≥8 个作答点）。
   只让 `severity: 'high'` 触发重出（低级别是措辞建议，为它重出一遍不值当）；
   最多 2 轮——第二轮还报同样的 high，说明两边判断不一致，记下来交给用户看，比假装修好了强；
   审题本身失败**不拖垮整单**。

回归测试见 `test/audit-pass.js`：假模型在第一版题库里故意写错答案（999），
断言审题抓得住、并且**最终落进页面的是正确值**。

## 6. 全局硬约束（所有模块都要遵守）

1. **绝不让模型写整页 HTML**。模型只产出「讲解片段 + 题库 JSON + 演示 JS」，页面由 `assemble.js` 拼。
2. **凡拼接必断言**（skill 的 `assert count==1` 哲学）：锚点找不到就抛错，不许静默产出半成品。
3. **JSON 一律先 `JSON.parse` 再进页面**，写进 `<script data-bank>` 前用 `JSON.stringify` 序列化，绝不手写转义。
4. **不吞异常**。每个阶段失败都要带上下文（哪个单元、哪次尝试、模型原文片段）冒到 UI。
5. **零外部资源**：产出的 HTML 不许引用任何 CDN / 网络字体；应用的 UI 也不许。
6. **API Key 绝不进渲染进程**（只回 `hasKey` + 掩码），绝不写日志，绝不进导出文件（导出时剥离）。
7. 中文优先：所有面向用户的文案用简体中文。
