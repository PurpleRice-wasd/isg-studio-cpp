# Phase 1 设计与差异记账（立壳）

> **性质**：这一份记的是**做过的决定、必须解释的差异、以及踩到的东西**。
> 判断与路线仍以 [`guidance.md`](guidance.md) 为准；接口以 `../../isg-studio/docs/architecture.md` 为准；
> 模型契约与页面规范同理（那三份不在本工程里，见 [`README.md`](README.md)）。
>
> 写法参照 guidance1：**结论之外要说清"为什么"和"它要是假的会是什么样"**。

---

## 0. 一句话

Phase 1 的产物是**一个能跑起来的壳**：C++ 宿主 + 系统 WebView2 加载**原样搬过来的渲染层**，
31 个 `window.isg` 通道全部登记（未实现的明确报错），设置 / 背景图 / `.env` / Key 四套等价自测通过，
`isg://` 协议与白名单自证过，**金标准对拍逐字节相同**，**老配置（含 DPAPI 加密的 Key）双向可读**。

一条命令验完：`powershell -File tools\phase1-verify.ps1`（报告写到 `docs/phase1-report.md`）。
交付前开过一轮**三路交叉互验**（C++ 正确性 / 与纲领一致性 / 验证体系可信度），
审出来的问题与修复见 §10 —— 其中两条是**真的会毁掉功能**的 bug，而且是**判据全绿**时存在的。

---

## 1. 目录与分层

```
src/
  main.cpp            命令行、公寓（STA）、决定跑哪条路、把出口收拾干净
  app/                路径与版本、单实例、待打开的文件
  util/               字符串、文件、JSON（ordered_json）、Base64、SHA-256、日志、RAII、泄漏检查
  settings/           providers（生成物）、dpapi、oscrypt、env、store、bg
  shell/              窗口与 WebView2 宿主、isg:// 协议、系统对话框、外壳动作、外观
  bridge/             31 个通道的唯一登记表 + 唯一的消息路由
  selftest/           四套等价自测 + 桥 / 协议 / 金标准 / 跨实现 Key
web/                  从 oracle 的 src/renderer 逐字节复制（+ 3 处以补丁形式施加）
  logic/              assemble.js / bank.js 逐字节复制 + 生成的 logic-bundle.js
tools/                构建、同步、生成、验证
```

**依赖方向单向**：`util ← app ← settings ← shell/bridge ← selftest ← main`。
settings 不碰 WebView2，util 不做业务判断。

---

## 2. 必须解释的差异（纲领 §4.3 要求逐条记账）

### 2.1 渲染层的三处改动

渲染层是**逐字节复制**的（`tools/sync-web.ps1`，默认只检查、`-Write` 才写）。
三处有意的改动全部以**机器可读的补丁**形式存在 `tools/web-patches.json`，
每条都有 `why`，并且锚点**必须在原文里恰好出现一次**（0 次或 2 次都当场失败）。

| # | 文件 | 改了什么 | 为什么 |
|---|---|---|---|
| 1 | `index.html` | 加一行 `<script src="isg-bridge.js">` | 页面侧的桥必须被加载。index.html 自带 `script-src 'self'`，同目录脚本是它明确允许的形态；宿主注入的内联脚本要看 CSP 的脸色 |
| 2 | `app.js` | `acceptFile` 里取拖拽路径那一步包进 `Promise.resolve(...).then(...)` | WebView2 没有 `webUtils.getPathForFile` 这种**同步** API，取路径必然是一次异步往返 |
| 3 | 新增 `web/isg-bridge.js` | 页面侧实现 `window.isg` | oracle 里对应的是 Electron 的 `preload.js` + `ipcRenderer`，WebView2 没有这两样 |

**补丁清单本身也被钉住**：`tools/sync-web.ps1` 里写死了必须存在哪三个补丁 id
（`$requiredPatches`）。第三路审查证明过：把补丁从 json 里删掉、再把文件回退成 oracle 原版，
校验仍然全绿 —— 因为它校验的是"web == oracle + **当前 json 里恰好有的**补丁"，那叫自证。

### 2.2 本地协议的形态：选**自定义 scheme**（纲领 §5 遗留 1 要求 Phase 1 前决策）

用 `isg://local/<逐段编码的绝对路径>`，通过 `CoreWebView2CustomSchemeRegistration` 登记，
请求全部由 `WebResourceRequested` 自己服务。**不**用 `https://isg.local/`（Phase 0 的临时形态）。

理由：
- oracle 用自定义标准协议 → **fail-closed**（处理器没挂上时请求根本没地方去）；
  `https://isg.local` 是 **fail-open**（处理器没挂上会真的走网络）；
- 渲染层的 `previewUrl` / iframe / `<img src>` 本来就按 `isg://` 写的，换 scheme 等于为了 spike 的临时形态去改渲染层。

⚠️ Phase 0 的坑**仍然复用**：`SetVirtualHostNameToFolderMapping` 服务出来的文档请求不触发
`WebResourceRequested`（那次 CSP 从来没挂上去，页面照样渲染、探针照样跑绿）。
自定义 scheme 的请求**必须**由我们服务，但"必须"是推理，所以判据看**结果**：
`docResponseServed > 0`（见 `protocol_stats()`），UI 自测里用 iframe 真的 `onload` 来证。

### 2.3 白名单：词法 + 真实路径**两遍**，并且按 URL 段判形态

- 词法：`GetFullPathNameW` + 小写归一化 + 前缀比较（大小写不敏感）；
- 真实路径：**按句柄反查**（`GetFinalPathNameByHandleW`），挡住 junction / 符号链接穿透
  （纲领 §5 遗留 7 点名要升级，这里做了）；
- 形态：在**解码之后的每一段**上判 —— 段里出现分隔符（UNC / 设备路径 / 根相对）、
  段是 `.` / `..`、冒号不在第一段的盘符位置（NTFS 数据流），一律**显式 403**。
  为什么要显式 403 而不是让它掉进 404：404 判据分不清"白名单拦住了"和"根本没这个文件"。

自测拿 7 种越界形态去撞（`--selftest=protocol`），同时**也测"正常形态要能放行"**——
只测拒，一个永远拒的实现也能全绿。

---

## 3. 桥（`window.isg`）

### 3.1 形态

```
web/isg-bridge.js                     src/bridge/bridge.cpp
window.isg.xxx(args)                  OnWebMessage(raw)
  └─ postMessage({__isg,id,channel,args}) ─▶ Dispatch(channel,args,reply)
pending[id].resolve(信封)      ◀────────── reply({ok,data} | {ok:false,error})
```

- **信封与 ipc.js 逐字一致**：`{ok,data}` / `{ok:false,error:{code,message,detail}}`。
  错误一律走正常返回、不 reject —— 理由也是 oracle 的：异常跨边界之后只剩 message。
- **编号表只有一份实现**（`Bridge::PostToPage` / 页面侧 `invoke`），不许各视图自己拼。
- **31 个通道全部登记**（`src/bridge/channels.h`，`static_assert` 钉住条数）。
  未实现的返回 `NOT_IMPLEMENTED`，**文案里说清属于哪一阶段**。
- 来源检查：只认我们自己那一页（`get_Source()` 与首条消息的来源比对，整条路径相等）。

### 3.2 Phase 1 已实现 / 未实现

| 已实现 | `app:info` `app:openPath` `app:openExternal` `app:revealPath` `app:previewUrl` `app:registerPath` `app:takePendingFile` `dialog:pickFile` `dialog:pickOutputDir` `dialog:pickImage` `bg:info` `bg:import` `bg:clear` `settings:get` `settings:save` `settings:export` `settings:import` |
|---|
| 未实现（明确报错） | `settings:test`(P3) `gen:*`(P4) `run:*`/`book:*`(P6) `extract:preview`(P2) `verify:run`(P5) |

⚠️ **Phase 1 的界面启动时会看到一条「读取任务列表」失败提示**：`restoreLastJob()` 在启动时调
`listJobs`，而它还没实现。这是**刻意的**——静默返回空数组会让"没有任务"和"功能没做"分不开，
那正是本项目最恨的静默失效。到 Phase 4 接上任务系统后这条提示自然消失。

### 3.3 拖拽取路径

页面在 drop 事件里 postMessage，宿主从**这条消息的** `AdditionalObjects` 里取
`ICoreWebView2File` 的真实路径（需要 `AllowExternalDrop(true)`）。
返回的是"这次拖进来的全部路径"，页面按文件名配一次。拿不到就返回空串，由渲染层给出人话提示。

---

## 4. 设置与密钥（这一节是本阶段**最大的意外**）

### 4.1 Key 的落盘格式：不是裸 DPAPI，是 Chromium OSCrypt

第一版按"DPAPI 直接加密"实现，跨实现测试当场证伪：

| 观测 | 结论 |
|---|---|
| Electron 写出的密文解开后是 `v10` + 61 字节 | 不是 DPAPI blob（DPAPI blob 以 `01 00 00 00 D0 8C 9D DF…` 开头） |
| 61 = 12(nonce) + 33(明文长) + 16(tag) | 是 **AES-256-GCM** |
| `CryptUnprotectData` 返回 `ERROR_INVALID_DATA(13)` | 明文不是 DPAPI 保护的 |

真相（Chromium OSCrypt / Windows）：
- 一份 32 字节随机密钥，**用 DPAPI 保护**后存在 `<userData>/Local State` 的
  `os_crypt.encrypted_key` 里（base64(`"DPAPI" + CryptProtectData(密钥)`））；
- 每个值：`"v10"` + 12 字节 nonce + AES-256-GCM(明文) + 16 字节 tag。

`src/settings/oscrypt.cpp` 按这个格式实现，**双向兼容已实测**：
- Electron 写 → C++ 读：`--selftest=keycompat`（8 项判据）；
- C++ 写 → Electron 读：`tools/electron-decrypt-probe.js`（判据在 `phase1-verify.ps1` 里）。

⚠️ 夹具要 `app.quit()` 而不是 `app.exit()`：`Local State` 是在**正常退出流程**里写盘的，
用 `app.exit()` 直接杀进程，密钥就永远没落盘 —— 看起来像"跨实现不兼容"，
其实是夹具把现场毁了（第一版就是这样，差点得出"Electron 44 无法兼容"的错误结论）。

### 4.2 设置文件的其它形态

- `ordered_json`（不是 `json`）：默认的 `nlohmann::json` 键按字典序排，落盘顺序会与 oracle 不同；
- `num_json()`：整数值存整数，避免 `"units": 6.0` 这种与 oracle 不同的形态；
- **绝不**对 const Json 用 `operator[]`（缺键会抛 → 宿主侧没有 try/catch → `std::terminate`，
  进程原地消失、报告一个字节都没有）。读可能不存在的键一律 `find`/`contains`。

---

## 5. 金标准对拍（纲领 §4.2）

链路：`tools/golden/fixture.js`（一份手写夹具）→
**oracle 的 assemble.js**（Node）产出 `expected.html` →
**搬过来的 assemble.js**（WebView2 里跑）产出 `actual.html` → **逐字节比**。

当前结果：两侧都是 157557 字节、sha256 `c05a28cf…`，**逐字节相同**。

这条链路抓到的三件事（都是"光读代码看不出来"的）：

1. **`assemble.js` 用了 Node 专有的 `Buffer.byteLength`**（统计里的字节数）。
   所谓"纯逻辑 JS"并不完全与环境无关 —— 解决办法是在**包装层**给垫片（`bundle-logic.js`），
   原文件一个字节不动（纲领 §7.4）。
2. **`PostWebMessageAsJson` 会把对象的键重排**（Chromium 的 `base::Value` 字典按键名排序）。
   把夹具当对象送过去，产出的题库 JSON 键序就与 oracle 不同 → 逐字节对拍必失败。
   **给 Phase 4 的警告**：桥上任何一处"顺手转成对象"都可能重排键序，而 Phase 4 的 DoD 是逐字节相同。
3. **bundle 生成器自己的正则转义写错了**，产出的 bundle 是语法错误；
   症状是页面上"bundle 没加载"（子资源加载失败是静默的），与真因隔了三层。
   现在 `phase1-verify.ps1` 里有一条判据：**用 node 真的把 bundle 解析一遍**。

---

## 6. WebView2 上踩到的东西（每条都对应一次真实的"看起来好了，其实没有"）

| # | 现象 | 真因 | 做法 |
|---|---|---|---|
| 1 | 自测"跑了十分钟没动静"，日志停在一行 | 在 `NavigationCompleted` / `ExecuteScript` 的回调栈里调 `PostWebMessageAsJson`（同步的宿主→渲染进程调用）→ **重入死锁** | 一切宿主→页面的调用都从**计时器那一拍**发；回调里只置标志 |
| 2 | `ExecuteScript` 返回 `{}`，像脚本什么都没干 | **WebView2 的 `ExecuteScript` 不等 Promise**（Electron 的 `executeJavaScript` 会等） | 结果走消息回传（`kind:'selftestResult'`），不靠 return |
| 3 | `file://` 页面加载同目录 `<script src>` 静默失败 | 子资源加载失败不报错 | 改成 `AddScriptToExecuteOnDocumentCreated` 注入，并给"没加载"一条显式判据 |
| 4 | 对象经 `PostWebMessageAsJson` 后键序变了 | Chromium `base::Value` 的字典按键名排序 | 传字符串、页面自己 `JSON.parse` |
| 5 | 关闭窗口后进程不退 / `Finish` 与 `WM_CLOSE` 互相触发 | `WM_CLOSE` 处理里调 `Finish`，而 `Finish` 又发 `WM_CLOSE` | `WM_CLOSE` → `DestroyWindow`；`WM_DESTROY` 里 `PostQuitMessage` 并清空 `hwnd_` |
| 6 | 自测挂住时连超时也不响 | 超时判定排在"已完成"之后 / 忘了置 `selftestStarted_` | 先判已完成、再判超时；`RunGoldenInject` 里显式置位 |
| 7 | 无窗口时弹了系统对话框，进程永久挂住 | `IFileDialog::Show(nullptr)` | 没有 owner 且没有桩时**明确失败**，绝不弹 |
| 8 | 改了 `web/` 但 exe 里还是老页面 | `POST_BUILD` 只在 target 重新链接时才跑 | 改成带 `DEPENDS` 的独立目标（`isg-web-assets`） |
| 9 | 重定向/管道下"程序什么都没打印" | `attach_parent_console` 无条件 `freopen("CONOUT$")`，把别人接好的管道关掉了 | 标准输出已经是管道/文件时**什么都不动** |
| 10 | 自测 0xC0000409 直接消失、报告一个字节都没有 | ① 把有副作用的调用写进判据的第 1 个实参、把结果写进第 3 个（**C++ 不规定实参求值顺序**）；② DPAPI 的 RAII 对**输入**缓冲也 `LocalFree` | ① 有副作用的调用先落变量；② 输入缓冲单独一个不拥有所有权的类型 |

---

## 7. 判据与证据（`tools/phase1-verify.ps1`，一条命令）

报告写到 `docs/phase1-report.md`；原始件在 `_verify-out/` 下。

| 判据 | 怎么证的 |
|---|---|
| 四套等价自测 | `--selftest=settings / background / env / key-leak`（14 / 30 / 27 / 10 项） |
| 31 个通道登记 + 未实现明确报错 | `--selftest=bridge`（51 项） |
| 真页面端到端 | `--selftest=ui`（32 项：桥、信封、五个视图、`isg://` 文档真的 onload） |
| 协议与白名单 | `--selftest=protocol`（14 项，含 7 种越界形态） |
| 老配置可读 / 双向兼容 | `make-key-fixture.js` + `keycompat` + `electron-decrypt-probe.js` |
| 金标准对拍 | `golden`（逐字节 + sha256） |
| 资产不走散 | `sync-web.ps1` / `gen-providers.py` / `bundle-logic.js` 三个检查 |
| 体积 | 交付目录 1.30 MB（exe 757 KB + web 601 KB） |
| 启动 | 控制器就绪 ~387 ms、页面就绪 ~532 ms、收尾 ~2.7 s（含 webview 全部工作） |
| 构建零告警 | 第三方头标 `SYSTEM`，我们自己的代码 `/W4` 零告警 |

---

## 8. 已知缺口（**记了账的"还没做"，不是"做错了"**）

1. **标题栏深浅色不跟随页面主题**：渲染层的主题存在它自己的 localStorage 里，宿主读不到；
   现在只在启动时按系统设置定一次。等 Phase 4/5 铺开界面 ↔ 宿主的通道之后再加一条"主题变了"的事件。
2. **`skill/` 与 `docs/generation-contract.md` 还没拷进交付目录**：Phase 1 用不到（生成在 Phase 4），
   `docs/README.md` 里记了"构建时拷进去"的安排，Phase 6 打包时落地。
3. **启动时会看到一条"读取任务列表失败"**：见 §3.2，Phase 4 接上任务系统后消失。
4. **`settings:test`（测试连接）未实现**：Phase 3。
5. **单实例只做了**手工**两进程验证**（第二个实例退出、第一个收到 `sample.txt`），
   还没有进 `phase1-verify.ps1` 的自动判据 —— 那需要"一个长驻实例"，得加一个 `--hold` 之类
   的开关才能稳定测。代码路径（`FindWindowExW(HWND_MESSAGE, …)`）已经按审查意见改对了。
6. **没有量内存**：纲领 §3.5 的内存指标要等有真界面（Phase 5/6），现在量的是空壳，意义不大。
7. ~~`phase1-verify.ps1` 没有调 `check-ps1-encoding.py`~~ **已补**（现在是第一条判据）。
8. **没有 vcpkg**：纲领 §5 Phase 1 写的是"CMake + vcpkg 工程"，实际是 CMake + NuGet 取 WebView2
   + `fetch-deps.ps1` 取 nlohmann（带 sha256 固定）。**这是有意的推迟**：Phase 1 只需要一个头文件，
   而 vcpkg 要 bootstrap 一整套构建体系；真正需要它的是 Phase 2 的 PDFium / miniz / pugixml。
   这一条以前没写进文档，现在记在这里。
9. **启动指标不是 §3.5 的口径**：验证器读的是 ui 自测里的"控制器就绪 / 页面就绪"，
   不是 §3.5 的"冷/热启动到窗口 ≤1.5s / ≤800ms"（那要冷热两臂、n≥3、删 user data）。
   `bench-startup.ps1` 仍指向 spike。Phase 2 起把这项补成真正的高低温两臂。

---

## 9. 与 oracle 的代码同步纪律

- `web/` 与 `web/logic/` 里的文件是**拷贝**，单一真源仍是 oracle；改逻辑请先改 oracle。
- 三道检查（`sync-web` / `gen-providers` / `bundle-logic`）都在 `phase1-verify.ps1` 里跑，
  任何一处走散都会让验证变红。
- C++ 侧需要的环境适配**只加在包装层**（`bundle-logic.js` 的 `shims`、`web-patches.json`），
  不改原文件。


---

## 10. 三路交叉互验审出来的东西（2026-10-17）

> 用户授权在每个阶段交付时开三路互验。下面是**审出来的**与**修掉的**。
> 这一节的写法与 guidance1 §8 一致：先写"它原来错在哪"，再写"现在怎么防"。

### 10.1 真的会毁掉功能的两条（当时判据全绿）

1. **桥的来源检查把 URL 的 hash 也算进去了。**
   首条消息的来源是 `...index.html#workbench`，一切到 `#settings` / `#about`，
   来源字符串就变了 → **所有 `window.isg` 调用被静默丢弃**（连失败回包都没有，Promise 永远悬着）。
   症状是"进了设置页之后保存/导入/换背景全都点了没反应"。
   为什么判据没抓到：UI 自测的 32 项恰好都在 hash 还是 `#workbench` 的时候跑完。
   **修法**：只比 pathname（与 oracle 的 `isOurUiUrl` 一致）；被拒时**回一条 `BAD_ORIGIN` 失败信封**
   而不是静默丢弃；并把"五个视图"改成**断言每个视图自己的标题文字**，且禁止出现"渲染失败"横幅
   （原来只看 `viewRoot.children.length > 0`，而 `render()` 在 mount 前就必塞一个 `.page`）。
2. **单实例完全没工作。** 信箱窗口用 `HWND_MESSAGE` 创建，而 `EnumWindows` 只枚举屏幕上的顶层窗口 ——
   第二个实例永远找不到第一个。**修法**：`FindWindowExW(HWND_MESSAGE, …)`；
   交接的事件名与形状改成渲染层真正认的 `job:event` + `{type:'file-dropped', filePath}`；
   递过去的是**一条文件路径**（argv 已拆好），不再拼命令行再解析（带空格的路径会被拆坏）；
   收到之后先 `protocol_allow`（否则预览/抽取会被白名单拒掉）并把窗口提到前台。
   已手工两进程验证：第二个实例退出、第一个收到文件。

### 10.2 验证体系自身被打穿的十处（第三路）

最要命的一条总结是：**任何一条判据，只要它的输入是被测程序写的 JSON，就必须有一个验证器自己算出来的数字来对账。**
逐条修法：

| 洞 | 现在怎么防 |
|---|---|
| 自测只汇总 `bad`，`checked=0` 也全绿 | 断言**每套的固定条数**（14/30/27/10/51/14/5/3/35）、断言 `checked>0`、断言自报 `bad` == 验证器自己数的 `[BAD]` 行数 |
| 报告里唯一一行是 `[BAD]` 但 `bad=0` 照样绿 | 同上（独立数行），ui 也改成数行而不是信 `selftestResult.bad` |
| 金标准 `actual.html` 不删 → 陈旧绿 | 运行前删 actual/fixture/expected；断言 actual 的 mtime 晚于本次开始 |
| `make-golden.js` 的退出码被忽略 → 用上一轮的 expected | 检查 `$LASTEXITCODE`；指纹从 `expected.json`（机器可读）读，不读会被控制台代码页转码的日志 |
| "五个视图"是空判据 | 断言每个视图自己的标题 + 禁止出现渲染失败横幅 |
| `isg://` 的 iframe `onload` 对 403 也成立 | 改成 `--selftest=protocol-live`：用**导航**驱动 handler，判据读宿主统计（`docResponseServed` / `deniedCount` / `cspHeaderSent`） |
| 补丁清单自证 | `sync-web.ps1` 写死必须存在的三个补丁 id |
| `-SkipBuild` / `-SkipKeyCompat` 静默缩小判据集 | 报告开头列出"本次跳过了什么"，结论措辞改成"跑过的判据全部通过；另有 N 类被跳过" |
| `run-selftests.ps1` 断言程序自报的 `ok` | 改成数 `[BAD]` 行 + 要求 `checked>0` |
| `dist/web` 与 `web/` 没有比对 | 新增逐文件哈希比对（缺/多/内容不同分别计数） |
| 单测/判据自己也说谎 | 版本检查用 UTF-8 读 package.json；`^OK` 前先 Trim；告警正则放宽到 LNK/CMake/D1 |

### 10.3 一致性审查点出的其它项（已修）

- **`skill_dir()` 的环境变量语义**：`ISG_SKILL_DIR` 一旦设置就**只认它**，无效时给出原因、
  绝不静默回退（architecture §2 原文）；并校验它确实像一份 skill（有 `SKILL.md` 与 `assets/`）。
- **主窗口的导航守卫**：补上 `NavigationStarting`，离开工作台界面的顶层导航一律拦（oracle 的 `will-navigate` 等价物）。
- **协议按 environment/webview 安装**：去掉了"只登记一次 / 只安装一次"的全局短路，
  离屏探针窗口（第二个 environment）才能拿到 `isg://`。
- **离屏探针窗口**：补上了（独立窗口 + 独立 environment + 独立 user data + 自己的协议安装），
  并有 `--selftest=probe`（3 条判据：能加载、能读回 title、文档由我们服务）。
- **桥回包改用 `PostWebMessageAsString`**：`PostWebMessageAsJson` 会经 Chromium 的 `base::Value`
  按键名重排对象键序 —— 设置页的提供商列表是按 `Object.keys` 顺序渲染的，键序一变顺序就与 oracle 不同。
- **泄漏检查进验证**：Debug 构建 + `--leak-selftest`（先证明检测器会响）+ 正常路径零泄漏。
  顺带修了一个真问题：`--leak-selftest` 原来用 `HeapAlloc`，**不在 CRT 的调试堆里**，
  所以"故意漏 4 KB"报告仍然是空的 —— 看起来像检测器没装上。
- **文档不实**：本文 §8 的缺口 5 / 7 已按事实改写。

### 10.4 还没做的（留给下一阶段，别当成已完成）

- 单实例的**自动**判据（手工验过，见 §8.5）。
- 设置导出/导入的**文件往返**、`dialog:*` 的桩语义、`openPath`/`revealPath`/`registerPath` 的
  正反例、拖拽路径的端到端 —— 都是 Phase 1 范围内"该测而没测"的（第三路列的 A 组）。
- §3.5 口径的冷/热启动基准（见 §8.9）。
- CSP 的 A/B 对照（Phase 0 做过，Phase 1 的协议层没有重做）。


### 10.5 C++ 正确性那一路审出来的（全部已修）

| # | 问题 | 修法 |
|---|---|---|
| 1 | **【严重】settings.json 里出现数组 → 进程 0xC0000409**：`deep_merge` / `drop_secret_fields` 对数组迭代器调 `key()`，nlohmann 会抛 `invalid_iterator.207`；宿主侧没有 try/catch → `std::terminate`。触发面很宽（顶层 `[1,2,3]`、手写的 `"ui":{"recentDirs":[…]}` 都算），而"读设置一律容错"是这个文件的头号承诺 | `deep_merge` 的数组分支按下标遍历；`drop_secret_fields` 的数组分支**逐元素递归**（跳过数组会留下泄漏面：`active/generation/ui` 里的数组元素带 secret 时会被整块外发）。加了 5 条回归判据（settings 14→19） |
| 2 | **【高】探针窗口复用主窗口的类与 WndProc**：探针 `ShowWindow` 触发的 `WM_SIZE` 会把**主窗口**的 WebView2 缩成探针的客户区；对探针点叉会 `DestroyWindow(hwnd_)` **销毁主窗口** | 探针用自己的窗口类与 WndProc（最小 DefWindowProc + 只处理自己的 WM_CLOSE），并加 `WS_EX_TOOLWINDOW`（不进任务栏/Alt-Tab） |
| 3 | **【中】`TeardownProbe()` 只定义、从未被调用**：探针 controller 没 `Close()`、窗口活到进程退出、主窗口 `UnregisterClass` 必然失败 | 在 `Teardown()` 里、销毁主窗口之前调用；并注销探针窗口类 |
| 4 | **【中低】对话框线程只增不减**：每个对话框留下一个 joinable `std::thread`，线程句柄不关 | 改成 `Worker{thread, done}`，每次 `dialog_show` 先把已完成的 join 掉（锁只用来搬运，join 在锁外） |
| 5 | **【低】正常关窗退出码是 2**：`completed_` 规则被无差别用到交互模式上，正常退出被读成崩溃 | `WM_CLOSE` 置 `userClosed_`；收尾时"用户关窗 → 0 / 意外结束 → 2"（实测 taskkill 后退出码 0） |
| 6 | **【低】ui 的"渲染失败横幅"判据过宽**：任何 `.banner.warn`（如"没找到 skill 目录"）都算失败 | 改成钉那句具体文案 |
| 7 | **【低】`protocol-live` 没进 `RunSelftest()`**：第二次导航慢一点就会得到误导性的"不认识的自测" | 加了明确分支（只说"第二次导航还没回来"，不误报） |
| 8 | **【低】单实例找不到信箱时"不建自己的信箱"**：会留下"持有互斥体却不可见"的实例链 | 照常启动并**继续创建自己的信箱** |
| 9 | **【低】删除护栏的两处缺口**：`Assert-NotReparsePoint` 只查叶子（祖先某一级是 junction 时形同虚设）；脚本里还有裸 `Remove-Item` | 逐段向上查；新增 `Remove-GuardedFile`（在根内 + 非重解析点 + 是文件），验证器与自测脚本的删除全部走它；`-Only` 的名字先过形态校验 |
| 10 | **【低】`--user-data` 用正斜杠时 env/protocol 两套自测假红** | 比较前统一 `GetFullPathNameW` 归一化 |
