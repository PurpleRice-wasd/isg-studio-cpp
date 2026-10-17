# 讲练一体工作台 · C++ 重写全流程验收报告

> 验收对象：`apps/isg-studio-cpp/`（C++ 宿主 2.0.0 + 系统 WebView2）
> 参照实现：`apps/isg-studio/`（Electron 1.4.2，oracle，不删不冻；C++ 版本有意分叉，见 §9.0）
> 报告截止：2026-10-17
> 最新全量验证：**103 条外层判据全过、0 跳过**，被测 exe SHA256 `34a69352c9550bb9c07e27270880a602921803ba1239ceeae8df391087da122f`（版本 2.0.0）
>
> **独立仓库说明**：本报告在原 monorepo（`apps/isg-studio-cpp` + `apps/isg-studio`，含
> Electron 1.4.2 oracle）中完成；本仓库只含 C++ 源码、运行期 skill 与生成契约。oracle、
> 真 PDF 样本、Phase 0 夹具与 `_verify-out/` 本地证据不在本仓库。本仓库的复验请用
> `tools/run-selftests.ps1` 与 `tools/package-acceptance.ps1`；`tools/phase1-verify.ps1`
> 依赖 oracle，未收录。

---

## 0. 验收结论（先看这里）

**Phase 0–6 全部走完，可以按本文做全流程验收。**

| 维度 | 结论 |
|---|---|
| 技术路线 | Phase 0 go：WebView2 能开、探针能跑、布局没被停、协议与 CSP 都做过 A/B |
| 功能等价 | 金标准拼装 **157557 字节逐字节相同**；老配置（含 Chromium OSCrypt Key）双向可读 |
| 抽取 | PDFium 三份真 PDF 对拍；页数/质量信号/栏序一致；`emptyMismatch=0`、`contentLossPages=0` |
| 网络与任务 | SSE/重试/400 降级原样跑 oracle 的 llm 层；取消约 0.26 秒生效，服务端确认连接断开 |
| 流水线 | 八阶段、并发 3、审题计票、修复回灌全部接通；`audit-pass` 999→200 等价回归通过 |
| 校验闭环 | 真 PDF → 真拼装 → 真 WebView2 探针 → 假模型，31 条全过；修复轮真重出、真重跑 |
| 收尾功能 | 旁挂 `.isg.json`、带上一章、多章/一册、多来源、清理、便携打包全部有判据 |
| 交付形态 | 便携目录 **10.79 MB**、zip **5.08 MB**；**安装版 3.83 MB、单文件便携版 3.79 MB**（2026-10-17 补验产出并实测，见 §9） |

**尚不能称为“纲领 §9 全部收口”的项**：真实手机/平板浏览器验证、内存/安装包体积/冷热启动六项硬指标的完整复测。这两项是验收时必须单独签字的缺口，不是隐藏问题。

---

## 1. 交付物与验收环境

### 1.1 交付物

| 东西 | 位置 |
|---|---|
| 可执行程序 | `build3/dist/isg-studio.exe` + `pdfium.dll` + `web/` |
| 便携交付目录 | `build-package/isg-studio-2.0.0/`（10.79 MB，含 `skill/`、`docs/generation-contract.md`） |
| 便携 zip | `build-package/isg-studio-2.0.0-portable.zip`（5.08 MB） |
| 安装版 exe | `build-package/ISG-Studio-Setup-2.0.0-x64.exe`（3.83 MB；静默安装/卸载/快捷方式已验） |
| 便携单文件 exe | `build-package/ISG-Studio-Portable-2.0.0-x64.exe`（3.79 MB；解到 TEMP 运行、退出清理已验） |
| 打包脚本 | `tools/package.ps1`（便携目录/zip + NSIS 安装版 + 单文件便携版） |
| 交付验收脚本 | `tools/package-acceptance.ps1` |
| 验证总入口 | `tools/phase1-verify.ps1` |
| 全量报告 | `docs/phase1-report.md`（每次运行覆盖，绑定 exe SHA256） |

### 1.2 环境（这台机器实测）

- Visual Studio Community 2026，MSVC 14.51，位于 `D:\visualstudio`
- Windows SDK 10.0.26100.0，位于 `D:\Windows Kits\10`
- WebView2 运行时 155.0.4283.x
- cmake/ninja 不在全局 PATH：必须用 `tools/build.ps1`（内部会 `call vcvars64.bat`）
- 所有 `.ps1` 必须带 UTF-8 BOM：`python tools/check-ps1-encoding.py`

### 1.3 复验命令

> **独立仓库**：`tools\phase1-verify.ps1` 依赖 Electron oracle，未收录；本仓库复验请用
> `tools\run-selftests.ps1` 与 `tools\package-acceptance.ps1`。下面保留原 monorepo 的命令作为历史记录。

```powershell
cd <repo>\apps\isg-studio-cpp

# 全量（构建 Release + Debug、全部自测、真 PDF、跨实现 Key、金标准、泄漏）
powershell -File tools\phase1-verify.ps1 -BuildDir build3 `
    -SampleDir "<samples>"

# 只跑已知构建（复验更快；报告会写明“没有核 exe 与源码的新旧关系”）
powershell -File tools\phase1-verify.ps1 -BuildDir build3 -SkipBuild `
    -SampleDir "<samples>"

# 打包
powershell -File tools\package.ps1 -BuildDir build3
```

预期：最后一行是 `**结论：全部通过。**`；`docs/phase1-report.md` 里 `外层判据 103 条，跳过 0 类`，exe SHA256 与当前 exe 一致。

---

## 2. 全流程阶段记录

### Phase 0 — 技术验证（go / no-go）✅

**问题**：探针能不能在 WebView2 离屏窗口里跑通？布局/几何会不会被停？本地协议和 CSP 能不能真的生效？

**做了什么**：`spike/` 最小工程；自定义 `isg://` 协议 + 显式目录白名单；屏外可见窗口 +
`--disable-features=CalculateNativeWinOcclusion` / `--disable-background-timer-throttling`；
真实产物页 + 三个探针。

**结论与数字**：
- 控制器就绪 **365 ms（冷）/ 362 ms（热）**；页面就绪 **2562 / 2540 ms**；宿主收尾 ~2900 ms，进程尾巴 49–57 ms。
- 真页 **20 个作答点、4 段 `<script data-bank>`**：缺卡=0、自动作答后判错=0、抛错=0、脚本错误=无。
- 几何信息是真值（`innerWidth=1280`、`elementFromPoint` 命中 `SPAN#s-total`、`visibilityState=visible`）。
- CSP 做了 A/B：带 CSP 时 fetch/sendBeacon/WebSocket/外链图/外链 iframe **5 条全拦**，不带时 0 条。
- 协议白名单拿 6 类越界形态自撞，全部被显式拒。

**关键教训**（详见 `guidance1.md`）：虚拟主机映射服务出来的文档不触发 `WebResourceRequested`，
CSP 曾经“看起来挂了、其实从没挂”；所以判据改成看 `docResponseServed > 0`，不是看过滤器注册成功。

### Phase 1 — 立壳 ✅

**做了什么**：CMake 工程、单实例、主窗口 + 离屏探针窗口、`isg://` + 白名单 + CSP、
31 个 invoke 通道登记（未实现明确报错）、settings/DPAPI/OSCrypt、渲染层原样搬入、金标准对拍链路。

**判据**：31 条全过；四套等价自测 settings 19 / background 30 / env 27 / key-leak 10；
协议 14 + protocol-live 5；UI 46；Debug 泄漏检查先自证会响，正常路径零泄漏。

**最有价值的发现**：Key 的落盘格式不是裸 DPAPI，而是 **Chromium OSCrypt**
（`"v10"` + 12B nonce + AES-256-GCM + 16B tag，AES 密钥由 DPAPI 保护在 `Local State`）。
**Electron 写 → C++ 读、C++ 写 → Electron 读**双向验证；自己的加密自己解密永远发现不了。
另发现 `PostWebMessageAsJson` 会重排对象键（所以桥的回包改用字符串），
以及 `ExecuteScript` 不等 Promise、在 WebView2 回调栈上做同步宿主→渲染调用会死锁。

**三路互验**修掉 22 项，其中 3 项是判据全绿时存在的真 bug：数组导致 `0xC0000409`、
桥的来源检查把 `#hash` 算进去导致切页后所有调用被静默丢弃、单实例的信箱窗口 `EnumWindows` 根本枚举不到。

### Phase 2 — 抽取 ✅（有一条记账缺口）

**做了什么**：PDFium（PDF）+ miniz（PPTX）+ 文本；`extract:preview` 接通桥与可编辑预览。

**判据**：`extract` 33 + `extract-pdf` 11 + UI 46；三份真 PDF（33 / 25 / 143 页）页数、每页
`reasons` / `suspect`、栏序全部一致；`emptyMismatch=0`、`contentLossPages=0`。

**记账缺口**：**逐页相似度 >99% 没有达到**。03-1 中位数 0.9971、03-2 1.0000、143 页压力样本 0.9815；
≥0.99 的页数 21/33、15/25、60/143。低相似度来自公式/表格页的阅读顺序差异，**不是丢字**：
去空白后中位数三份都是 1.0。要逐页 >99%，需要另做 PDFium 的文本 run 重建。

**三路互验**修掉：线程入口异常直通 `std::terminate`、zip 解压炸弹、已完成的抽取线程不回收、
页眉页脚归一化逐位替换导致剔除不完整、PPTX/文本取消语义不一致等。

### Phase 3 — 网络与任务 ✅

**做了什么**：**SSE 状态机、重试、退避、400 降级全部原样跑 oracle 的 `llm/index.js`**；
C++ 只做 WinHTTP 字节搬运。Key 以哨兵留在宿主，发出前由 `net.cpp` 注入真 Key，并核对 URL origin。
`jobs` 生命周期、`job:event`、历史、取消；`settings:test` 与真生成走同一条 llm 路径。

**判据**：`net-fault` 26 条（请求形状、测试连接、SSE 切包、400 降级、429 重试、`data: 0` 保活行）；
`pipeline-cancel` 9 条：约 **0.26 秒** running → canceled，且故障服务端记录到连接提前断开。

**抓到的静默失效**（详见 `guidance5.md`）：页面 `jobs.log()` 漏 `kind:'pipeline'` →
“产物写出来了、任务永远 pending”；`.value()` 用在字符串上 → `0xC0000409`；
取消后最终状态是 failed；首次「测试连接」必失败；大快照超过单条消息上限。

### Phase 4 — 流水线与拼装 ✅

**做了什么**：`pipeline` / `prompts` / `sources` / `chapters` / `revive` **逐字节复制**进
`web/logic/`；浏览器垫片提供 fs/path/store/jobs/fetch；八阶段编排、并发 3、取消、审题计票；
`assemble.js` 原样调用。

**判据**：
- **金标准仍是 157557 字节、sha256 `c05a28cf…`，逐字节相同**。
- `audit-pass` 等价回归：假模型先把 u1 数值题写成 **999** → 独立审题确认 → 按意见重出 **200**
  → 最终页面有 200、没有 999；`audit.rounds=5`、`audit.high=1`。
- `pipeline-mock` 当前 **28 条**（Phase 4 时 23 条，Phase 5 增加报告/探针/verify 阶段对账）。

**抓到的两类“跑通了但输入被削掉”**（详见 `guidance6.md`）：`Get()` 给界面瘦身时把
`options.editedPages` 也剥掉 → 用户逐页修订在到达流水线前丢失；`gen:start` 没做选项别名归一
→ 工作台滑杆和章标题完全无效。另有 `copyFile` 字段错位、大回包不分块导致永久挂起、bundle 过期。

### Phase 5 — 校验与修复闭环 ✅

**做了什么**：
- `src/verify/probe_runner.{h,cpp}`：探针注入（错误收集器、`</body>` 唯一、拒绝 script 字样）、
  同目录 `_probe_<pid>_<序号>_` 副本、独立 WebView2 environment/user data、导航/弹窗守卫、
  `ProcessFailed`、计时器状态机、轮询 title、DOM 快照、`__PROBE_ERRS__`/console.error、
  轮次间清浏览数据、关窗删副本。
- `web/logic/probe-parse.js`：从 oracle 逐函数搬来的解析与 0.5% 容差比较；`item()` 带 `label`。
- demo-checks、repairRound 真跑；结果页「重新校验」可用；`job.report` 回宿主。

**判据**：
- `e2e-mock` **31 条**：真 PDF（33 页）→ PDFium → 假模型 → 拼装 → **真探针**。
- `verify` **20 条**：好页面 0 项 false；把全部 `<script data-bank` 改坏 → 失败项恰好是「题库条目」；
  demo 核对正反例、0.5% 容差正反例。
- `pipeline-repair` **31 条**：假服务把演示 checks 改成 `999999` → demo-checks 抓到 →
  repair 阶段 done（detail「仍有 1 项」）→ 日志有「演示 … 已重出」；假服务另写
  `repair-events.jsonl` 作为独立变异证据。

**修掉的两处 oracle 静默回归**：章节 demos 映射丢 `checks/sliderId/viewBox`
（demo-checks 整轮失效）；旁挂数据 `chapter.no` 只认 `no`、不认拼装器的 `number`（章号丢失）。

### Phase 6 — 收尾功能 ✅

**做了什么**：
- 旁挂 `.isg.json`：写半身逐字节用 oracle `book.js`（tmp + rename 原子写）；
  读半身是 `src/book/`；schema `isg-book/1`。
- `book:list` / `book:pickFile` / `book:inspect` / `book:continuity`；
  `gen:start` 的 `carry`（history/file 两种来源、frozen、册的顶层 key、先验后建）；
  多章/一册/`separate`；多来源独立分析；取消时「清除」；`run:scanCleanup/doCleanup`；
  计费预估与导入导出沿用已搬渲染层；`tools/package.ps1`。
- `host-request` / `host-reply` 两个方向都做了分块（revive 会传整份 HTML/整章结构）。

**判据**：
- `book`（真窗口通道）**20 条**；`book-data` **20 条**。
- `book-e2e` **28 条**：第 1 次生成第 13 章；第 2 次生成第 14 章并带上第 13 章 →
  1 份一册、2 章、日志有「带上了 1 章」「这一份是一册」；冻结章 id 逐字保留
  （哨兵 `s131-u1-s1`），新章落在 `c2-…`；进度搬家脚本在；第 13/14 章号都在；
  两章都有演示时 `demoA→demoB` 改名后，demo-checks 用最终 id 核对（第二册 42 项无 false）。
- `cleanup` **26 条**：认产物/旁挂/探针副本/`*.run.log`/真拷过的陪练图；不误认用户文件；
  目录外路径拒删；并走 `Bridge::DispatchForTest` 验 `run:scanCleanup/doCleanup`
  自己查任务、自己重扫。
- `multi-source` **8 条**：courseware + exampaper 独立分析，产出页里搜到真题哨兵 `MARK-EXAM`。

**打包**：便携目录 10.79 MB、zip 5.08 MB；NSIS 因本机无 `makensis.exe` 明确跳过。

---

## 3. 最终验证快照

**全量：103 条外层判据、0 跳过。**

| 自测 | 条数 | 自测 | 条数 |
|---|---:|---|---:|
| settings | 19 | background | 30 |
| env | 27 | key-leak | 10 |
| bridge | 38 | protocol | 14 |
| protocol-live | 5 | probe | 3 |
| ui | 46 | extract | 33 |
| extract-pdf | 11 | net-fault | 26 |
| pipeline-cancel | 9 | pipeline-mock | 28 |
| verify | 20 | pipeline-repair | 31 |
| book | 20 | book-e2e | 28 |
| book-data | 20 | cleanup | 26 |
| multi-source | 8 | e2e-mock | 31 |

另外的硬判据：

- 金标准：157557 字节，sha256 `c05a28cf…`，expected/actual 逐字节相同。
- 跨实现 Key：Electron 写 → C++ 读；C++ 写 → Electron 读，双向都成功。
- 泄漏：`--leak-selftest` 故意漏 4 KB，报告里出现；正常路径报告为空；自测 exit=0。
- 构建：Debug 构建零告警；自有代码 `/W4` 零告警。
- 资产：`web/` 与「oracle + 4 处补丁」逐字节一致；`logic-bundle.js` 与源一致且能被 node 解析。
- 版本：C++ 宿主 **2.0.0**（`VERSION` / CMake / exe 资源 / 安装包一致）；oracle 仍是 1.4.2（有意分叉）。
- 启动：控制器就绪 429 ms、页面就绪 596 ms、teardown 3553 ms（本次实测，判据阈值 1000/6000 ms）。

---

## 4. 验收步骤

### 4.1 自动验收（必须做）

1. 跑全量命令，确认退出码 0、报告末行 `**结论：全部通过。**`。
2. 打开 `docs/phase1-report.md`，确认：
   - `外层判据 103 条，跳过 0 类`；
   - 报告里的 exe SHA256 与 `build3\dist\isg-studio.exe` 当前 SHA256 一致；
   - `[BAD]` 行数为 0。
3. 打开 `docs/acceptance-report.md` 附录里的证据文件，抽查至少 3 份：
   - `_verify-out/selftest/e2e-mock.json`（真 PDF 端到端）；
   - `_verify-out/selftest/pipeline-repair.json` + 同名 `.repair-events.jsonl`（变异证据）；
   - `_verify-out/selftest/book-e2e.json`（冻结 id / 进度搬家 / 跨章演示）。

### 4.2 人工验收（建议做）

1. 双击 `build-package/isg-studio-2.0.0/isg-studio.exe`（需要 WebView2 运行时；Win11 自带）。
2. 进入设置页：配置一个模型、测试连接、拉取模型列表、保存、换背景图。
3. 拖入一份真实课件，完整生成一遍，亲眼看八个阶段与结果页的校验报告。
4. 结果页的「重新校验」跑一次；打开产物 HTML，检查单页形态、判分、进度保存。
5. 再生成第 14 章并勾选「带上第 13 章」，确认一册、章号、进度迁移提示。
6. 跑砸/取消一次，确认清理入口列出的文件与真实留下的一致。

### 4.3 反作弊验收（强烈建议挑 1–2 条）

判据“全绿”不等于判据有强度。`docs/guidance7.md` §5 给了现成的变坏方法：

| 改什么 | 应该看到 |
|---|---|
| `probe_runner.cpp` 的 `kDomFactsJs` 结尾改回少一个 `)` | 报告少「顶栏总数」 |
| `probe_runner.cpp` 的 demo 调用把 `demo.checks` 改回 `demo` | demo 核对变“0 组读数” |
| `probe_runner.cpp` 的 `ownsProbeCopy` 恒置 true | demo 核对跑完会删成品页 |
| `oracle book.js` 的 `no` 改回只认 `no` | `book-e2e` 的「第 13/14 章」判据变红 |
| `tools/mock-provider-server.js` 不再注入 `999999` | `pipeline-repair` 的 999999 判据变红 |
| `tools/phase1-verify.ps1` 的 `expectedCounts` 调 1 | 全量立刻红 |

---

## 5. 已知缺口与限制

**必须让验收人知道的“没做/没验”：**

1. ~~**NSIS 安装包未产出**：本机没有 `makensis.exe`；便携目录与 zip 已实测。~~
   **已于 2026-10-17 补验解决**：NSIS 3.13 已装，安装版与单文件便携版已产出，并由
   `tools/package-acceptance.ps1` 实测通过（见 §9.3）。
2. **没有真实手机/平板浏览器验收**：产物页的移动端形态只有静态审查与无头探针，
   没有在 iOS/Android 真机上打开过。
3. **纲领 §3.5 六项硬指标未完整复测**：交付目录与启动时间有数；内存占用、安装包体积、
   冷/热启动的完整对照没有重新做。
4. **逐页相似度 >99% 未达到**（Phase 2 已记账）：不是丢字，公式/表格阅读顺序不同。
5. `verify` / `book` 使用静态基准页与手写 sidecar，验的是通道/解析口径；
   真实生成链路由 `e2e-mock` / `book-e2e` / `pipeline-mock` 覆盖。
6. 修复轮只验证了“真的重出并如实报告仍有问题”，没有验证“修好后全绿”；
   `separate + carry + 多来源`组合矩阵未穷举。
7. `text.js` 的切页逻辑仍在 C++（Phase 2 记账）；未搬回 Worker。
8. `book:pickFile` 是模态对话框，自动化里只验了方法存在与放行语义，没有真点。

---

## 6. 关键设计与差异（验收时需要知道的“为什么”）

1. **这是翻译，不是重写**：纯逻辑 JS 逐字节复制；提示词逐字复制；只有 I/O、窗口、
   网络传输、解析、加密这些宿主能力才重新实现。
2. **Key 不进页面**：provider 配置里是 `__ISG_HOST_KEY__` 哨兵；`net.cpp` 发出前删掉哨兵头、
   注入真 Key，并核对 URL origin。渲染层拿不到明文。
3. **产出页面由代码拼**：模型只产片段；吸顶条、结算区、判分引擎、样式、陪练块全部来自骨架页。
4. **同步 fs 的死结用“预热 + 分块”解决**：skill/契约/任务快照从宿主分块取；写文件按 16K 码元分块，
   结束消息带块数与字节数，宿主对账。
5. **两个方向都要防大消息**：宿主→页面分块（skill/契约/任务快照/回包）；
   页面→宿主分块（revive 回包、finish 的 carry 裁剪、consoleErrors 截断）。
6. **oracle 侧主动修了两处静默回归**：`pipeline/index.js` 的 demos 映射补 `checks`；
   `book.js` 的 `chapter.no` 兼容 `number`。两处都先改 oracle、再 `sync-web.ps1` 逐字节同步。
7. **删除前先看目标**：探针副本按 `_probe_<pid>_<序号>_` 形状认；`ownsProbeCopy` 区分
   “我们写的副本”和“demo 加载的原页面”；清理通道重新扫一遍清单，只删仍在清单内的路径。

---

## 7. 证据索引

> `_verify-out/` 是本地运行产物（每次验证重新生成），**不提交**；仓库里保留的归档证据是
> [`docs/evidence/arch-bench.json`](evidence/arch-bench.json) 与 [`docs/portable-run.png`](portable-run.png)。

| 证据 | 位置 |
|---|---|
| 全量验证报告 | `docs/phase1-report.md` |
| Phase 0 | `docs/phase0-report.md`、`spike/_fixtures/bench-summary.json` |
| Phase 1 | `docs/phase1-design.md`、`docs/phase1-report.md`、`docs/guidance2.md` |
| Phase 2 | `docs/phase2-report.md`、`_verify-out/phase2/cmp-*.json` |
| Phase 3 | `docs/phase3-report.md`、`_verify-out/selftest/net-fault.json`、`pipeline-cancel.json` |
| Phase 4 | `docs/phase4-report.md`、`_verify-out/selftest/pipeline-mock.json`、`tools/golden/out/` |
| Phase 5 | `docs/phase5-report.md`、`docs/guidance7.md`、`_verify-out/selftest/{e2e-mock,verify,pipeline-repair}.json` |
| Phase 6 | `docs/phase6-report.md`、`docs/guidance7.md`、`_verify-out/selftest/{book,book-data,book-e2e,cleanup,multi-source}.json` |
| 打包 | `build-package/`、`tools/package.ps1` |

---

## 8. 验收签署清单

- [ ] 全量验证命令退出码 0，103 条外层判据、0 跳过
- [ ] 报告 exe SHA256 与当前 exe 一致
- [ ] 自动报告里 `[BAD]` 行为 0
- [ ] 人工打开便携版，完成一次真实课件生成
- [ ] 设置页测试连接 / 保存 / 背景图 / 导入导出抽查
- [ ] 结果页校验报告与「重新校验」可用
- [ ] 带上一章：一册、章号、进度搬家、冻结 id 抽查
- [ ] 取消/失败后的清理清单与真实文件一致
- [ ] 反作弊：至少挑一条判据让它失败
- [ ] 已知缺口逐条确认（真机、六项硬指标、Phase 2 相似度、静态夹具等）
- [ ] 交付形态：`tools/package-acceptance.ps1` 跑一遍（本次已全过）

---

## 9. 最终交付补验（2026-10-17 接手验收）

这一节记录自动判据**覆盖不到**、但真机上看得见的问题，以及交付形态的补齐。
全部改动之后已重新跑完 103 条外层判据：**0 跳过、0 `[BAD]`**。

### 9.0 版本号：C++ 2.0.0，oracle 1.4.2（有意分叉）

宿主从 Electron 换成 C++/WebView2 是主架构变更，C++ 侧定为 **2.0.0**。Electron 版
（`apps/isg-studio/`，1.4.2）**不跟着改**，它是迁移与对拍的基准。版本唯一真源是工程根的
`VERSION` 文件；`src/CMakeLists.txt`、exe 的 `VERSIONINFO`、`tools/package.ps1` 都跟它走，
`tools/phase1-verify.ps1` 会核对这三处与 `VERSION` 一致，并单独确认 oracle 仍是 1.4.2。

数据兼容性不变：两者共用 `%APPDATA%\isg-studio`，设置格式、Chromium OSCrypt 加密的 Key、
历史与旁挂 `.isg.json` 互为可读（Phase 1 的双向验证仍有效）。

### 9.1 200% 缩放下界面发虚 —— 已修

本机是 192 DPI（200% 缩放）。原 exe 的清单里只有 `asInvoker`，没有 DPI 感知声明；
Windows 会把整个窗口位图拉伸，WebView2 里的文字发虚，与 Electron 原版不一致。

修复：

- 新增 `src/app/isg-studio.manifest`：`PerMonitorV2`（保留旧键 `dpiAware true/pm` 兜底）与 `longPathAware`；
- 新增 `src/app/isg-studio.rc`：把清单作为资源 #1 嵌入，并补 `VERSIONINFO`（产品名/版本/版权）；
- `src/main.cpp` 在创建任何窗口前调用 `SetProcessDpiAwarenessContext(PerMonitorV2)`（与清单冗余兜底）；
- `src/shell/app_window.cpp`：创建主窗口/探针窗口时，把 1180×820、900×700 的 DIP 按
  `GetDpiForSystem()` 换成物理像素；处理 `WM_DPICHANGED`。

实测：进程 `GetProcessDpiAwareness = 2`，主窗口 2360×1630 物理像素（= 1180×815 DIP）；
物理分辨率截图中文字清晰。

### 9.2 安装后立刻启动的控制器竞态 —— 已加兜底

验收脚本在“静默安装 → 立刻启动”这个序列里复现了
`CreateCoreWebView2Controller` 返回 `E_ABORT`（0x80004004），应用以退出码 2 结束；
隔几秒重开就正常。用户装完马上双击也可能撞上。

修复：失败后不在 WebView2 回调栈上重入，改由 100 ms 计时器在下一拍重试，
最多 3 次（0.4 / 0.8 / 1.2 秒），全部失败才收工。重试分支用临时环境变量钩子
强制首次失败验证过：日志出现「第 1 次重试」，随后导航成功；钩子已删除。

### 9.3 交付形态：安装版 + 单文件便携版 —— 已产出并实测

装好 NSIS 3.13 后，`tools/package.ps1` 产出与原 Electron 档同名的两个 exe：

| 产物 | 大小 | SHA256 |
|---|---:|---|
| `build-package/ISG-Studio-Setup-2.0.0-x64.exe` | 3.83 MB | `c37509066bec56def5a4b30a9738a6ee81300d93bebb28b84fbfacd7e7699cce` |
| `build-package/ISG-Studio-Portable-2.0.0-x64.exe` | 3.79 MB | `7e265ce07fc536800615321cc711abb23310bd45244ffa8a0f29141022d5e821` |

安装版按当前用户装到 `%LOCALAPPDATA%\Programs\isg-studio`，建桌面/开始菜单快捷方式与卸载项；
**卸载保留 `%APPDATA%\isg-studio`**（历史、设置、进度）。便携版解到 `%TEMP%` 运行，
退出后连空目录一起清掉。

交付验收脚本 `tools/package-acceptance.ps1`（安装 → 启动 → DPI → 抽取真 PDF → 卸载 →
便携版 → 临时目录清理）**31 项全过**。便携版运行截图见 [`portable-run.png`](portable-run.png)。
另修了卸载器从安装目录启动时删不掉当前目录的问题（卸载段先 `SetOutPath "$TEMP"`）。

### 9.4 架构对比实测：Electron 1.4.2 vs C++ 2.0.0

同一台机器、同一份 web 资产、同一份 143 页 PDF 的实测（完整口径与数据见
[`arch-bench.md`](arch-bench.md) / [`evidence/arch-bench.json`](evidence/arch-bench.json)）：

| 指标 | Electron 1.4.2 | C++ 2.0.0 |
|---|---:|---:|
| 热启动 UI 就绪（UIA） | 567 ms | 654 ms |
| 热启动进程树私有内存 | 91.3 MB | 96.0 MB |
| 143 页 PDF 抽取 | 624 ms | **205 ms（3.0×）** |
| 单文件便携版 | 127.05 MB | **3.97 MB（小 96.9%）** |
| 安装目录 | 444.12 MB | **11.32 MB（小 97.5%）** |

**收益主要来自分发体积与原生抽取**；启动/内存基本持平，不能把“窗口更早出现”当成启动更快。

---

**一句话**：Phase 0–6 的实现与自动判据都能复现；剩下的验收重点不是“再跑一遍绿不绿”，
而是**人工走一遍真实生成**，以及**对已知缺口逐条签字**。
