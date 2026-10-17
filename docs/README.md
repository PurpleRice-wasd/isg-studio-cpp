# 这个目录里有什么，以及三份规格书在哪

## 本目录

| 文件 | 性质 |
|---|---|
| `guidance.md` | **★ 活的纲领。** 从 `../../isg-studio/docs/guidance.md` 移交过来后就地维护（纲领自己开头这么要求的）。Phase 0 的实测结论与 10 条坑已写回 §5。 |
| `guidance1.md` | **Phase 0 工作记录与接手笔记**（作者：接手重写的 agent，2026-10-17）。纲领只留结论，这一份留**过程**：卡在哪、当时怎么想的、怎么定位的、怎么解决的。**最值得看的是第 8、9 节**——三路交叉审查审出来的东西，以及"我差点相信了一份假的绿灯"。 |
| `guidance2.md` | Phase 1 工作记录与接手笔记。跨实现 Key 兼容怎么把"DPAPI"实现当场证伪（真身是 Chromium OSCrypt）、金标准对拍抓到的三件"读代码看不出来"的事、三路交叉互验审出的 22 项（3 项是**判据全绿时的真 bug**）、我自己犯的 8 类错，以及 §11「如果换我接手，我会先做这几件事」。 |
| `phase0-report.md` | `tools/phase0-verify.ps1` 每次运行生成的报告（机器可读的结论在 `spike/_fixtures/*.json`）。 |
| `phase1-design.md` | **★ Phase 1 的设计与差异记账**：本地协议为什么选自定义 scheme、渲染层那三处改动的逐条理由、桥的形态、**Key 的落盘格式其实是 Chromium OSCrypt 而不是裸 DPAPI**、金标准对拍抓到的东西、WebView2 上踩过的 10 条，以及**已知缺口**。 |
| `phase1-report.md` | `tools/phase1-verify.ps1` 每次运行生成的报告（原始件在 `_verify-out/`，本地生成、不提交；Phase 2–6 的判据也在这里）。 |
| `guidance3.md` | Phase 2 工作记录与接手笔记：PDFium 逐字符取数的六个坑、公式页为什么没有强行逐页 99%、三路互验审出的五类假绿、我自己犯的 10 类错。 |
| `phase2-report.md` | **★ Phase 2 抽取的工作记录**：交付清单、33 条合成夹具 + 11 条真 PDF + 46 条 UI 自测、三份真 PDF 的逐页对拍数字（含内容丢失/去空白口径）、**逐页 >99% 未达的诚实结论**、与 oracle 的必要差异、三路交叉验证修掉的问题，以及踩过的坑。 |
| `guidance4.md` | **Phase 3 + 4 的合并摘要**：三路互验后的完整修复清单、仍未修的边界。细节见 guidance5/6。 |
| `guidance5.md` | **★ Phase 3 工作记录与接手笔记**：消息漏 `kind` 导致"产物写出来了、任务永远 pending"、`.value()` 用在字符串上 0xC0000409、取消最终 failed、首次测试连接必失败、大快照超限；以及三路互验与修复。 |
| `guidance6.md` | Phase 4 工作记录与接手笔记：`editedPages` 被界面瘦身削掉、工作台选项字段名没归一、大回包不分块导致永久挂起、bundle 过期；以及"测试输入要贴近真实调用方"。 |
| `guidance7.md` | **★★ Phase 5 + 6 工作记录与接手笔记（最新，接手先读）**：原始字符串少一个 `)` 让 DOM 快照静默变空、demo 对象被当成 checks 数组、demo 核对把成品页面删了、oracle 的演示核对在多章改造后整轮失效；以及"删除逻辑必须知道这个文件是谁的"。 |
| `phase3-report.md` | Phase 3 结论与数字：SSE/重试/降级的分工、Key 边界、任务生命周期、net-fault 26 条、cancel 9 条、取消证据。 |
| `phase4-report.md` | Phase 4 结论与数字：逐字节复制清单、八阶段、金标准逐字节、audit-pass 等价回归（999→200）、pipeline-mock 23 条、与 oracle 的差异与缺口。 |
| `phase5-report.md` | **★ Phase 5 结论与数字**：WebView2 探针驱动、probe-parse 口径、demo 0.5% 核对、e2e-mock 31 条（真 PDF）、pipeline-repair 30 条、verify 19 条、与 oracle 的必要差异与缺口。 |
| `phase6-report.md` | **★ Phase 6 结论与数字**：旁挂 `.isg.json`、book:* 通道、carry、多章（book-e2e 28 条）、book 20 / book-data 20 / cleanup 26 / multi-source 8、打包尺寸与 NSIS 跳过。 |
| `acceptance-report.md` / `.html` | **★★ 全流程验收报告（2.0.0）**：Phase 0–6 的结论、证据、复验命令、人工验收步骤、反作弊方法与已知缺口。给人验收时先看这一份。 |
| `arch-bench.md` | **★ 架构对比实测**：Electron 1.4.2 vs C++ 2.0.0 的冷/热启动、内存、体积、PDF 抽取；口径与结论（体积/抽取是主要收益，启动/内存基本持平）。 |
| `evidence/arch-bench.json` | 架构对比的归档原始数据（不提交 `_verify-out/`，只归档这一份）。 |
| `release-notes-2.0.0.md` | 可直接粘贴到 GitHub Release 的「cpp版 2.0.0」文案。 |
| `README.md` | 本文件。 |

## 三份规格书（独立仓库里随仓库带一份）

纲领 §0 点名了三样"在重写中一个字都不能动"的东西，其中两份是规格书：

| 规格书 | 位置 | 管什么 |
|---|---|---|
| `architecture.md` | `docs/architecture.md`（随仓库） | **接口的唯一来源**（含 `window.isg` 的 31 个 invoke 通道 + `job:event` 订阅、校验报告结构） |
| `generation-contract.md` | `docs/generation-contract.md`（随仓库） | **模型侧契约的唯一来源**（模型只产哪四样、字段表、§5 的校验项↔生成步骤映射） |
| `SKILL.md` | `skills/interactive-study-guide/SKILL.md`（随仓库） | **页面侧规范的唯一来源**（形态铁律、最致命的坑） |

**为什么原 monorepo 不复制、独立仓库却要带一份**：本项目最贵的资产是"一个都不丢"，而复制是**走散的第一步**；原 monorepo 里三份规格书由 Electron 版继续维护，C++ 版只读。独立仓库没有 oracle 可依赖，为了让"clone 下来就能构建/运行"，只能把`architecture.md` 与 `generation-contract.md` 随仓库带一份（`SKILL.md` 在 `skills/`）。
这类坑在本仓库有前科——`assets/sync-skeleton.py` 就是为"资产与骨架内联副本走散"造的
（默认只检查、`--write` 才写），走散的症状是"改了资产、新章却还是老引擎"。
在原 monorepo 里，三份规格书在重写期间由 Electron 版继续维护；
本独立仓库里的副本请视为**运行期依赖**；修改时记得同步回原 monorepo。guidance/phase 报告是历史记录，其中引用的 Electron oracle、样本与 `_verify-out/` 不在本仓库。

运行期也一样：这三份（加 `references/*.md`）由应用**从磁盘原样读**，
不许内联成 C++ 字符串常量（纲领 §4.6 第 6 条）——"改了 skill，应用行为跟着变，不用改代码"
是这栋楼的地基，把它内联了就把承诺变成了谎言。

### 但"仓库里不复制" ≠ "交付物里没有"（这一半原来漏了）

契约在**运行期必须读得到**，所以它**一定会进交付物**。oracle 的做法是两条腿：

| 场合 | 从哪读 |
|---|---|
| 开发期（`npm start`） | 相对路径回退到 `apps/isg-studio/docs/generation-contract.md`、`skills/…`（`pipeline/prompts.js:22-39`） |
| 打包态 | `resources/docs/generation-contract.md`、`resources/skill/`（`package.json` 的 `extraResources` 两条） |

C++ 版的对应安排（**Phase 1 落地，此处先记账**）：
**单源在仓库**（即上面那三处，不复制第二份），**构建时拷进交付物**；
dev 期按相对路径回退，打包态按安装目录下的 `docs/` 与 `skill/` 找。
纲领 §3.2 要求启动时把 `SKILL.md + references/*.md + page-skeleton.html + generation-contract.md`
（合计约 1 MB，全部只读）**一次性预读进内存**再交给 Worker——那一份内存快照就是打包态的实际读取来源。

## 移交记录

| 日期 | 事件 |
|---|---|
| 2026-10-17 | Phase 0（go/no-go）通过：判据 1 / 2 / 3 / 4a / 4b / 6 / 7 与 CSP 对照、白名单越界（4c）全过。`../../isg-studio/docs/guidance.md` 顶部加了一条"已移交、别在这里改"的提示，指向本目录。 |
| 2026-10-17 | 三路交叉审查（C++ 正确性 / 与纲领一致性 / 验证体系可信度）后的修复批次：白名单归一化、退出码与判据并账、超时永不触发、`抛错=0` 假绿、陈旧绿报告、删除护栏统一、计时改单调时钟。详见 `guidance.md` §5 与 `phase0-report.md`。 |
| 2026-10-17 | **Phase 1（立壳）完成**：31 条判据全过（三路交叉互验审出 22 项，全部修完）。设计与差异记账见 `phase1-design.md`（含"Key 的落盘格式是 Chromium OSCrypt"这个跨实现测试才发现的结论）；过程与心路见 `guidance2.md`。 |
| 2026-10-17 | **Phase 2（抽取）实现完成**：91 条判据全过；逐页 >99% 的 DoD 缺口如实记账（中位数 0.9971/1.0、内容丢失 0）。详见 `phase2-report.md` 与 `guidance3.md`。 |
| 2026-10-17 | **Phase 3（网络与任务）完成**：net-fault 26 条、cancel 9 条；SSE/重试/降级原样跑 oracle 的 llm 层，C++ 只做 WinHTTP 与 Key 注入。详见 `phase3-report.md` 与 `guidance5.md`。 |
| 2026-10-17 | **Phase 4（流水线与拼装）完成**：金标准逐字节相同；audit-pass 等价回归（假模型写 999 → 审题抓住 → 最终 200）；pipeline-mock 23 条。三路互验后修复了 `editedPages`、选项别名、大回包分块、bundle 过期等。详见 `phase4-report.md` 与 `guidance6.md`。 |
| 2026-10-17 | **Phase 5（校验与修复）完成**：WebView2 探针窗口、title/DOM 解析、demo 0.5% 核对、repair 真跑；e2e-mock（真 PDF 33 页）31 条、pipeline-repair 30 条、verify 19 条、pipeline-mock 28 条。修掉 oracle 侧"demos 丢 checks"的静默回归。详见 `phase5-report.md` 与 `guidance7.md`。 |
| 2026-10-17 | **Phase 6（收尾功能）完成**：旁挂 `.isg.json`、book:* 通道、carry、多章/一册、取消清除、清理清单；book-e2e 23 条、book 20 条、book-data 20 条、cleanup 20 条。便携包 10.74 MB / zip 5.06 MB；NSIS 因本机无 makensis 明确跳过。详见 `phase6-report.md` 与 `guidance7.md`。 |
| 2026-10-17 | **2.0.0 · cpp版交付**：全量 103/103、交付验收 31/31；补齐 DPI 感知、控制器启动重试、NSIS 安装版/单文件便携版与卸载 CWD 修复；Electron 1.4.2 保持为 oracle。架构对比见 `arch-bench.md`，更新记录见根目录 `CHANGELOG.md`。 |
