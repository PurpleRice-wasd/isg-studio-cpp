# guidance2 · Phase 1 工作记录与接手笔记

> **作者**：接手这次 C++ 重写、完成 Phase 1 的 agent（Claude Code），2026-10-17。
> **性质**：不是纲领，是**工作记录**——我干了什么、卡在哪、当时怎么想的、怎么定位的、
> **我怎么发现自己是错的**。判断与路线仍以 [`guidance.md`](guidance.md) 为准；
> 设计与差异记账在 [`phase1-design.md`](phase1-design.md)；验证结果在 [`phase1-report.md`](phase1-report.md)。
>
> 与 [`guidance1.md`](guidance1.md) 的关系：那一份是 Phase 0 的过程，这一份是 Phase 1 的过程。
> guidance1 §9「心路」里的三条——**最难的是不让自己被骗、我的默认倾向是相信自己的判据、
> 我倾向于把话说满**——在 Phase 1 全部又发生了一遍，而且换了新花样。

---

## 0. 一句话

Phase 1 的判据是 **31 条全绿**，但**真正值钱的不是绿**：是那三轮"我以为是绿的、其实不是"，
以及三路交叉互验审出的 **22 项**——其中 3 项是**判据全绿时存在、会真毁功能**的 bug。
这一份记的就是这三轮是怎么被发现的，以及**下一次该往哪儿看**。

---

## 1. 起点：我接手时仓库长什么样

- `apps/isg-studio/`：完整的 Electron 版（oracle），**不删不冻**，继续当对拍基准。
- `apps/isg-studio-cpp/`：只有 Phase 0 的 spike（约 2k 行）＋ 一堆脚本与两份文档
  （`guidance.md` 纲领、`guidance1.md` 过程记录）。
- 没有 `src/`、没有 `web/`、没有任何 Phase 1 的东西。
- Phase 0 的六项判据全过；`docs/phase1-report.md` 还不存在。

**我的第一件事不是写代码**，是把纲领 §4/§5/§7、guidance1 §8/§9、architecture.md 的 §4/§5.5
重读了一遍。理由很实际：这次要做的每一个决定（协议形态、通道登记、Key 存哪），
纲领里都已经有结论或者"必须拿一次实测来定"的指令，**自己重新发明一遍只会把已经踩过的坑再踩一遍**。
事后看，这一步直接省掉了至少两次返工。

---

## 2. 我按什么顺序做

1. **先立骨架、再填肉**（纲领 §4.3）：`util → app → settings → shell/bridge → selftest`，
   依赖方向单向。先让"能编过、能起窗口"，再往里塞逻辑。
2. **契约面先冻结**：`src/bridge/channels.h` 把 31 个通道写成一张表 + `static_assert` 钉住条数。
   这一步做完之后，后面所有"哪个功能没实现"的问题都变成查表，而不是翻代码。
3. **翻译优先**：`store.js` / `env.js` / `bg.js` / `providers.js` / 渲染层，全部按"逐行对照"搬。
   其中 `providers.js` 用**生成器**（`tools/gen-providers.py`）把数据表从 oracle 倒成 C++ 快照，
   而不是手抄——手抄 20 KB 中文数据，**错一个字看不出来**，而生成物有 `--check` 盯着。
4. **每搬一块就给它配等价判据**，不等最后一起测。四套 DoD 自测（settings/background/env/key-leak）
   是**边搬边写**的，最后才补桥/协议/UI/金标准。

---

## 3. 第一版骨架：编译期教我的那些 API

这一段和 guidance1 §4 一模一样：**MSVC + WebView2 的第一轮几乎全是签名问题**，而且都 fail-loud，
所以不算危险。记下来只是为了让下一个人少查一次：

| 报错 | 真因 |
|---|---|
| `CoreWebView2EnvironmentOptions 未声明` | 在 `WebView2EnvironmentOptions.h`，**不在** `WebView2.h` |
| `get_AdditionalObjects 不是成员` | 在 `ICoreWebView2WebMessageReceivedEventArgs2`，基础接口没有 |
| `get_Environment 不是成员` | 在 `ICoreWebView2_2` |
| `put_AllowExternalDrop 不是成员` | 在 `ICoreWebView2Controller4`（不是 3） |
| `CoreWebView2EnvironmentOptions(3 个参数)` 编不过 | 它**没有带参构造**，参数要 `put_*` 上去 |
| `BCryptDecrypt` 返回 `0xC0000008` | 把**算法句柄**当密钥句柄用了，要先 `BCryptGenerateSymmetricKey` |

真正让我停下来的是另一类：**编得过、跑得起来、结果是错的**。

---

## 4. 第一次跑起来，我很想收工

主窗口起来、渲染层加载、`window.isg` 通了、五个视图都渲染、设置能存、`isg://` 能出图。
四套 DoD 自测写完就全绿。那一刻确实很像"Phase 1 做完了"。

让我没收工的是**两个我自己加的判据**：金标准对拍、跨实现 Key 兼容。
它们的出发点不是"再验一遍"，而是"**我凭什么相信搬过来的东西行为没变**"。

---

## 5. 转折一：跨实现 Key 兼容，把我的实现当场证伪

我按"DPAPI 直接加密"实现了 Key 的落盘，然后写了四套自测，全绿。**自己加密自己解密，永远绿。**

于是我加了一条规矩：**让 oracle 真的写一份 settings.json，让 C++ 去读。**

结果读不出来。排查路径（这一段值得完整记）：

1. 先把盘上的密文取出来看：只有 64 字节，开头是 ASCII 的 `v10` ——
   **这不是 DPAPI blob**（DPAPI 以 `01 00 00 00 D0 8C 9D DF …` 开头）。
2. 用 Python 的 ctypes 直接调 `CryptUnprotectData`：`ERROR_INVALID_DATA (13)`。排除"我的 C++ 写错了"。
3. 数长度：`v10` 之后 61 字节 = 12 + **33** + 16；而我的测试 Key 正好 33 字节。
   → 12 字节 nonce、16 字节 tag、中间是密文。**这是 AES-GCM。**
4. 那 AES 密钥在哪？`<userData>/Local State` 的 `os_crypt.encrypted_key`，
   形如 base64(`"DPAPI"` + `CryptProtectData(32 字节密钥)`）。

这就是 Chromium 的 OSCrypt 格式。`src/settings/oscrypt.cpp` 按它实现，
**双向**都验过（Electron 写 → C++ 读；C++ 写 → Electron 读）。

**中途还有一个假线索差点让我得出错误结论**：第一版夹具用 `app.exit()` 直接杀进程，
于是 `Local State` 根本没落盘 —— 第二个进程（哪怕是 Electron 自己）也解不开。
我一度真的写下了"Electron 44 无法兼容"。停下、重来、换成 `app.quit()`，密钥落盘，一切正常。
**夹具把现场毁了，结论就一定是错的。**

> 这一段的教训一句话：**"自己能读自己"不是兼容性证据；跨实现才是。**

---

## 6. 转折二：金标准对拍抓到的三件"光读代码看不出来"的事

金标准对拍的链路很短：oracle 的 `assemble.js` 产 `expected.html`；
**逐字节搬过来的**同一份 `assemble.js` 在 WebView2 里跑，产 `actual.html`；逐字节比。

它抓到的东西比"验证有没有翻译错"多得多：

1. **`assemble.js` 用了 Node 专有的 `Buffer.byteLength`**。
   一直说到"纯逻辑 JS 跑在 Worker 里"——但**只有真的跑一遍才知道**它并不完全与环境无关。
   解法是在包装层给垫片（不改原文件，符合纲领 §7.4）。
2. **`PostWebMessageAsJson` 会把对象的键重排。** 第一次跑出来两边都是 157557 字节，
   但 sha256 不同，第一个差异在偏移 37933：题库 JSON 的键从 `id,type,stem,opts`
   变成了字典序 `hint,id,opts...`。真因是 Chromium 的 `base::Value` 字典按键名排序。
   **这条对 Phase 4 是致命的**：如果桥或流水线里任何一处"顺手把对象传过去"，
   拼出来的 HTML 就不会与 oracle 逐字节相同，而那时会很难查。
3. **我自己生成的 bundle 是语法错误**（正则转义少写了一层），而页面上的表现只是
   "bundle 没加载"——子资源加载失败是静默的。现在验证里有一条：**用 node 真的把 bundle 解析一遍**。

---

## 7. 转折三：三路交叉互验，判据全绿时的真 bug

用户授权在每个阶段交付时开三路互验（C++ 正确性 / 与纲领一致性 / 验证体系可信度）。
我先自己跑完全绿、写好文档，然后才开 —— 顺序很重要：**审查者要能看见"你声称的样子"**。

### 7.1 第一路（C++ 正确性）：一个会让应用直接崩的 bug

- **【严重】settings.json 里只要出现数组，进程就 `0xC0000409`。**
  `deep_merge` / `drop_secret_fields` 显式允许数组，却用 `iter.key()` 遍历数组；
  nlohmann 对非 object 迭代器会抛 `invalid_iterator.207`，而宿主侧没有 try/catch → `std::terminate`。
  触发面不是恶意输入：顶层 `[1,2,3]`、手写的 `"ui":{"recentDirs":["C:\\a"]}` 都算。
  **而"读设置一律容错"是那个文件的头号承诺。** 已修（数组按元素遍历 + 逐元素递归清 secret），
  并加了 5 条回归判据。
- **【高】探针窗口复用了主窗口的窗口类与 WndProc。** 探针 `ShowWindow` 时的 `WM_SIZE`
  会把**主窗口的 WebView2 缩成探针客户区**；对探针点叉会 `DestroyWindow(hwnd_)` **销毁主窗口**。
  已改成自己的窗口类 + `WS_EX_TOOLWINDOW`。
- **【中】`TeardownProbe()` 只定义、从未被调用。** controller 没 `Close()`、窗口活到进程退出、
  主窗口 `UnregisterClass` 必失败。**一条写了但没人调的收尾路径，和没写是一样的。**
- 另有：对话框线程只增不减、正常关窗退出码 2、删除护栏只查叶子、`--leak-selftest` 用
  `HeapAlloc`（不在 CRT 调试堆里，所以"故意漏 4KB"报告是空的）等，全部已修。

### 7.2 第二路（一致性）：两条"判据全绿时存在"的功能性 bug

- **桥的来源检查把 URL 的 `#fragment` 也算进去了。** 首条消息来源是 `…index.html#workbench`；
  一切到 `#settings` / `#about`，来源字符串就变了 → **所有 `window.isg` 调用被静默丢弃**
  （连失败回包都没有，Promise 永远悬着）。用户看到的是"进了设置页之后保存/换背景点了没反应"。
  **为什么我的 UI 自测没抓到**：那 32 项恰好都在 hash 还是 `#workbench` 的时候跑完。
  修法：只比 pathname；被拒时回 `BAD_ORIGIN` 失败信封；并把"五个视图"改成断言每个视图**自己的标题**。
- **单实例完全没工作。** 信箱窗口是 `HWND_MESSAGE` 创建的消息窗口，而 `EnumWindows`
  只枚举屏幕上的顶层窗口 —— 第二个实例永远找不到第一个。另外事件名/形状也与渲染层不一致
  （渲染层只认 `job:event` + `file-dropped`）。已修并**手工两进程验过**。

### 7.3 第三路（验证体系）：十种假绿

这一路是投资回报最高的一路。它没有"再跑一遍看绿不绿"，而是**去骗**验证脚本：

| 它做的事 | 结果 |
|---|---|
| 用一个只写 `{"ok":true,"checked":0,"bad":0,"groups":[]}` 的 stub 冒充自测 | **七套全绿**——因为验证器只汇总 `bad`，从不要求"真的跑过东西" |
| 在报告里放一行 `[BAD]` 但把 `bad` 写成 0 | **全绿**——验证器从不独立数 `[BAD]` 行 |
| 让 C++ 不写 `actual.html`（上一轮的还留着） | **金标准全绿**——从来没人删旧的 |
| 让 `make-golden.js` 静默 `exit(2)` | **全绿**——退出码没人看 |
| 让设置页的 `mount()` 抛错 / 删掉 `views/settings.js` | **"五个视图 5/5"**——判据只看 `children.length > 0` |
| 让 iframe 指向一个**未放行**的 `isg://` | **"文档真的被服务出来了"**——**403 也会触发 onload** |
| 从补丁清单里删掉两条、把文件回退成 oracle 原版 | **sync-web 与全套验证全绿**——它校验的是"web == oracle + 当前 json 里恰好有的补丁"，那是自证 |

它给的一句话，我把整段抄进了 `phase1-design.md`：

> **任何一条判据，只要它的输入是被测程序写的 JSON，就必须有一个验证器自己算出来的数字来对账。**

现在的对应修法：断言每套的**固定条数**、独立数 `[BAD]` 行并与自报的 `bad` 对账、
拒绝 `checked=0`、运行前删产物并断言"本次新产出"、指纹改读机器可读的 `expected.json`、
把协议判据改成**导航驱动 + 宿主统计**（`docResponseServed` / `deniedCount` / `cspHeaderSent`）、
把必须存在的补丁 id 写死、报告开头列出"本次跳过了什么"。

---

## 8. 我自己犯的错（比审出来的更值得记）

1. **C++ 实参求值顺序。** 我把有副作用的调用写在判据第 1 个实参里、把依赖它的 `err`/`cfg`
   写在第 3 个实参里。C++ **不规定求值顺序**，MSVC 从右往左 → 先读到默认构造的 null →
   `Json::value()` 抛异常 → `terminate`（进程 0xC0000409 直接消失、报告一个字节都没有）。
   **一条判据把自己跑死了。** 现在的规矩：有副作用的调用先落变量，再进判据。
2. **DPAPI 的 RAII 把输入缓冲也放进了 `LocalFree`。** 输入指向调用方的 `std::string`，
   析构时对一块不是 `LocalAlloc` 来的内存调 `LocalFree` → heap corruption，
   而且是在**进程退出时**才炸，看起来像"跑完了没输出就死了"。现在输入用"不拥有"的类型。
3. **`Finish()` 发 `WM_CLOSE`，而 `WM_CLOSE` 处理里又调 `Finish()`。** 两边互相触发 →
   永不停止的消息循环 → 进程永久挂住，连超时兜底都轮不到（`completed_` 已为真）。
4. **在 WebView2 的回调栈上发导航/发消息。** `NavigationCompleted` 里调
   `PostWebMessageAsJson` 会重入死锁；在 `ExecuteScript` 回调里调
   `await` 一个永不 settle 的 Promise 也一样。**一切主动动作都从计时器那一拍发。**
5. **`ExecuteScript` 不等 Promise。** 我照搬了 Electron 的 `executeJavaScript` 的用法，
   结果拿到 `{}`，日志里是"自测脚本返回了（2 字节）：{}"。结果改成走消息回传。
6. **构建系统**：`POST_BUILD` 只在 target 重新链接时跑，只改 `web/` 不会触发 ——
   改了资产、跑起来还是老页面。改成带 `DEPENDS` 的独立目标。
7. **PowerShell 的若干坑**：`if` 不能当表达式（实参要用 `$(...)`）；`Get-Content -Raw`
   默认按 GBK 解，JSON 里的中文会变乱码、`ConvertFrom-Json` 报"无效的 JSON"；
   正则里 `\d` 写成 `\\d` 上一层转义会吃掉；**用 Python 写文件时反斜杠会被多解一层**
   （我因此把 `tools\golden\out\fixture.json` 写成了带 form-feed 的路径，`Test-Path` 报"非法字符"）。
8. **工具层面**：一条后台命令如果用 `ReadToEnd()` 读子进程 stdout，而子进程把管道另一端留住了，
   它会**永远挂着**（我留下过一个显示"运行 2 小时"的空壳 shell）。
   经验：长跑命令一律带超时；前台命令不要用会缓冲的管道。

---

## 9. 可从迁移的方法（比具体修法更值钱）

1. **让 oracle 真的写一份，让新实现去读。** 自己读自己不是证据。
2. **判据看结果，不看意图。** "过滤器注册成功"≠"CSP 挂上了"；"onload 了"≠"文档是我们送出去的"。
3. **先证明检测器会响，再说"没有出事"。** 泄漏检查、CSP、白名单、甚至"零告警"都适用。
   这一次连"泄漏自检"本身都是假的（`HeapAlloc` 不在 CRT 堆里）——**证明"检测器会响"这一步也要能被证伪**。
4. **对"判据全绿"保持怀疑，尤其是当判据的输入来自被测程序时。** 去骗它，比再跑一遍有用。
5. **任何"文件/字节级"的比对，都要先删旧产物、并断言"本次新产出"。** 陈旧绿是最便宜的一种假绿。
6. **凡自己生成的中间物（bundle、生成表、注入副本），都要有一个"走散检查"。**
   这个仓库里已经有三例：`sync-skeleton`、`sync-web`、`gen-providers`、`bundle-logic`。
7. **先写文档再开审查。** 审查者要能看见你声称的样子，才能指出你在哪里把话说满了。

---

## 10. 心路（写给下一个人）

**① 我又一次先相信了自己的判据，而且这次更隐蔽。**
Phase 0 那次是"我查了意图没查结果"；这次是"我的判据**结构上**就允许假绿"——
只汇总 `bad`、只数 `children.length`、只看 `onload`。
它们每一条单独看都很合理，合起来就是"一套看起来很严格的验证，实际上什么都能放过"。

**② 最难受的不是 bug，是"绿的时候功能已经坏了"。**
桥的 hash 来源检查、单实例、数组崩溃——这三条都是**31 条判据全绿**时存在的。
如果没有那三路"去骗它"的审查，我会很有信心地宣布"Phase 1 完成"，而用户在设置页点的第一个按钮就是没反应。
**"全部通过"这句话本身需要有人来质疑。**

**③ 跨实现测试是这次最值的一笔投入。**
它花了大概两个小时（写夹具、被 `app.exit()` 骗一次、重来、实现 OSCrypt、双向验证），
但它找出的是**四套自测永远找不到**的东西。凡是"新实现要读旧数据"的地方，都值得这么做。

**④ 我对"写了一半"的东西特别容易放松警惕。**
`TeardownProbe()` 写得很完整、注释也齐全，就是没人调用。
`--leak-selftest` 写得很像那么回事，就是检测器根本看不见它漏的那块内存。
**"写了"和"生效了"之间，永远差一次断言。**

**⑤ 用户的两次提醒又一次指到了要害。**
一次是"删除指令要三思"——它让所有删除走了同一份护栏，而审查随后在这份护栏上抓到了
"只查叶子、不查祖先"的漏洞；一次是"要关得干净"——它让泄漏检查、收尾顺序、
"写了但没调用"这类问题都变成了必须回答的问题。
**这不是附注，是设计约束。**

---

## 11. 如果换我接手，我会先做这几件事

1. **跑一次 `powershell -File tools\phase1-verify.ps1`**，然后**挑一条判据，试着让它失败**。
   做不到就说明那条判据是散文。重点试：
   - 把一份自测报告的 `bad` 改成 0、把 `[BAD]` 行留着 → 应该红；
   - 删掉 `_verify-out/golden/actual.html` 后让程序不写它 → 应该红；
   - 让设置页的 `mount()` 抛错 → 应该红。
2. **读 `docs/phase1-design.md` §6 与 §10**（WebView2 的 10 条坑、三路审查的 22 项）。
   那里面每一条都对应一次真实的"看起来好了，其实没有"。
3. **读 `web/isg-bridge.js` 与 `src/bridge/bridge.cpp` 一起读。** 这一对是界面与宿主的唯一入口，
   Phase 2–6 的所有功能都要从这儿过；它的两条纪律（信封形状、未实现明确报错）不能松。
4. **Phase 2 的第一件事不是写 PDFium**，是**把逐页文本对拍搭起来**：
   oracle 的 `extract/pdf.js` 对同一份 PDF 产出的分页文本 vs PDFium 的，
   相似度 >99% 且**栏序一致**。没有这个，后面所有抽取质量的讨论都没有基准。
5. **别急着改 `web/` 里的任何文件。** 它们是 oracle 的拷贝；要改先改 oracle，
   再跑 `tools/sync-web.ps1 -Write`，最后让 `-Check` 变绿。
6. **遇到"进程杀不掉"先看线程数与句柄数。** 都是 0 就是已经退出的空壳（不是内存泄漏，
   管理员也杀不掉），重启即消失。这一条是这次真查过的，别重复查。

---

## 附：这次留下的东西（以及它们的寿命）

| 东西 | 寿命 |
|---|---|
| `src/**`（宿主 + 设置 + 桥 + 自测） | **长期**。Phase 2 起往里加 `extract/`、`net/` |
| `web/`（渲染层）与 `web/logic/`（纯逻辑 JS） | **长期**，但永远是 oracle 的**拷贝**；用 `sync-web.ps1` 维护 |
| `tools/sync-web.ps1` + `tools/web-patches.json` | **长期**。补丁清单必须与 `docs/phase1-design.md` §2.1 同步改 |
| `tools/gen-providers.py`（生成物 + `--check`） | **长期**。改了 `providers.js` 必须重生成 |
| `tools/golden/*`（金标准对拍） | **长期**，Phase 4 的主判据会建立在这条链路上 |
| `tools/phase1-verify.ps1` | **长期**。Phase 2+ 的判据都往这里加，别另起 |
| `tools/make-key-fixture.js` / `electron-decrypt-probe.js` | **长期**（跨实现兼容的取证工具） |
| `spike/`（Phase 0） | 保留作对照；默认不构建 |
| `--selftest=probe` | 最小版（能开/能加载/能读 title）。Phase 5 在上面接探针注入 |
| `_verify-out/`、`_selftest-out/`、`tools/golden/out/` | 运行期产物，已 `.gitignore`；每次验证重新生成 |

**最后一句**：这一阶段真正值钱的产出不是那个 800 KB 的 exe，是
**"判据全绿的时候，功能可以是坏的"这件事被记下来了**，以及那句可以复用的规矩：

> 任何一条判据，只要它的输入是被测程序写的 JSON，就必须有一个验证器自己算出来的数字来对账。

下一个接手的人，请把它继续往下传。
