# 题库与引擎手册

引擎原文见 `../assets/quiz-engine.js`。它做四件事：把题库渲染成题卡 → 判分并给逐项反馈 → 统计进度存盘 → 驱动「只看错题/重做/清空」。演示与陪练是附加功能。

## 1. 题库：`<script data-bank type="application/json">`

页面里放若干段，引擎用 `document.querySelectorAll('script[data-bank]')` 全部收集，顺序拼接。**一段写错 JSON，只丢这一段**（但页面不报错，要自己校）。

### 单选 / 多选

```json
{"id":"l1-3","type":"single","lv":1,
 "stem":"题干，可以用 HTML：<span class=\"fx\">μ<sub>r</sub> = B/B₀</span>",
 "opts":[
   {"t":"选项文字","ok":true,"why":"为什么对（答题后展开）"},
   {"t":"错的选项","ok":false,"why":"它错在哪"}
 ],
 "hint":"思路提示（只给方向，不给答案）",
 "sol":"解析（可选；不写就不显示解析框，选项里的 why 就是解析）",
 "ref":{"h":"#s131","t":"回手册 · 13.1 知识块 2"}}
```

- `type:"multi"`：多个 `ok:true`，用户勾选后点「提交答案」，**全对才算对**。
- `id` 必须全局唯一，会写进 `localStorage` 当键。**大题每一步的 id 是自动生成的 `<大题id>-<步号>`**，
  也要避免与别的题撞名（引擎现在会检测并自动改名 + 告警）。
- `lv` = 关卡号（0 起），决定它渲染进哪个 `<div class="qlist" data-lv="N">`。

### 填数值

```json
{"id":"l3-2","type":"num","lv":3,"unit":"T","ans":1.257,"tol":0.03,
 "stem":"……求 B（保留 3 位有效数字）","hint":"……","sol":"……"}
```

- `ans` 是**数字**（写成 `"2.51×10⁻⁴"` 这种字符串会让这道题永远判错，引擎现在会在渲染时拦下来并告警）。
- `tol` 是绝对容差，不写则取 `|ans|×2%`；`ans=0` 时会兜到 `1e-12`（不是"必须精确 0"）。
- `ansText:["A/m","a/m","A·m⁻¹"]` 用来出**文字答案**题（如"单位是什么"），忽略 `ans/tol`，做小写 + 去空格 + 去 `·` 比较。
- **数值输入认什么**（`parseNum`，2026-10-16 收紧过一次，见 pitfalls 第 64 条）：
  - 认：`1.06`、`1.06 T`、`1.06T`、`2.51e-4`、`2.51×10⁻⁴`、`2.51*10^-4`、`3×10^-4`、`1,06`（小数逗号）、`1,234,567`、`1 000 000`、
    **全角数字 `１５`**、**各种负号 `−5` / `－5` / `–5`**（Unicode 减号、全角减号都当负号）、`A/m` 这种带斜杠的单位。
  - **不认**（返回"看不懂"，不再当答错）：算式与多余数字 —— `5-3`、`1/2`、`2+3`、`5 T=9`、`5 (第2步)`、`1.2.3`、`0x10`、`1e`。
    这类输入以前会被 `parseFloat` 前缀截断成 `5` / `1` / `0`，**把错答判成对**。
  - 看不懂时的反馈是一句人话（"只认一个数字，可以带单位，别写算式"），与"算错了"区分开。
- 答错时**直接给出正确答案**（取自 `ansText[0]` 或 `fmt(ans)`）。`fmt` 的小数位数按量级给足，
  **保证页面公布的答案一定落在默认容差内**（否则学生照抄提示里的答案还是判错，会陷入死循环）。

## 1.5 题库字段校验（写错不会静默了）

引擎渲染前逐题 `badReason()` 校验，不合格的题：**控制台一条 warn + 页面上一张标红的"配置有误"卡 + 不计入总题数**。
判为不合格的情形：`type` 写错/没写；`id` 缺失；选择/多选题 `opts` 缺了或不足两个、没有任何 `ok:true`、
单选标了多个正确项；大题 `parts` 缺失或为空、某个 part 自己不合格；数值题 `ans` 不是有限数字、
`ansText` 不是非空数组、`tol` 是负数。

另外两条：
- **`lv` 指向不存在的题区**（页面没有 `.qlist[data-lv=N]`）→ 跳过 + 告警，不再抛错。
- **重复 `id`** → 后面那道自动改名（`dup-1` → `dup-1-2`）并告警。重复 id 会让两题共用一个存盘键、**一次作答计两分**。

每道题的渲染各自 `try/catch`，一整轮渲染再包一层 —— **任何一道题写坏都不许把统计/筛选/陪练带走**
（历史上真出过：一处手误让 IIFE 中断，顶部显示 `0/0`、「清空重来」点了没反应，而题目还能答，用户完全看不出来）。

### 大题（一步一问）

```json
{"id":"big1","type":"big","lv":5,
 "stem":"<strong>大题一 · 插铁芯的螺线管</strong>：已知 ……",
 "parts":[
   {"type":"num","unit":"A/m","ans":200,"tol":3,"stem":"求 H。","hint":"…","sol":"…"},
   {"type":"single","stem":"结论是——","opts":[{"t":"…","ok":true,"why":"…"},{"t":"…","ok":false,"why":"…"}]}
 ]}
```

每个 part 就是一个独立作答点（id 自动变成 `big1-1`、`big1-2`…），单独判分、单独重做。

## 2. 页面必备 DOM（引擎按 id/class 取，缺一个就会中断）

| 位置 | 必须存在 |
|---|---|
| 吸顶进度条 | `<div class="bar">` 内含 `#s-done #s-total #s-rate #s-wrong #s-fill #onlyWrong #petToggle #resetAll` |
| 题区宿主 | `<div class="qlist" data-lv="N">`（每个关卡一个，放哪题就长在哪；标题里的计数用 `<span class="cnt" data-cnt="N"></span>`） |
| 结算区 | `#result` 内含 `#r-done #r-rate #r-wrong #r-verdict #r-bars #r-advicetext #goWrong #goAll` |
| 陪练（**可选**） | `#pet` `#petBubble` `#petFig`（**必须排在引擎脚本之前**：`HAS_PET` 在脚本求值时就算好了，放到后面等于没有陪练，而且不报错）；顶部那个 `#petToggle` 在 `.bar` 里，**它可以缺**（缺了引擎会把开关藏起来）。整块删掉引擎也不会崩（判空 + `say()` 变空操作）。**`#petFig` 里的内容归引擎所有**：切形象时会被清空，别把自己写的标记放进去 |
| 题目侧（**硬依赖但已判空**） | `#s-done/#s-total/#s-rate/#s-wrong/#s-fill`、`.qlist[data-lv]`、`#r-done/#r-rate/#r-wrong/#r-verdict/#r-bars/#r-advicetext`、`#onlyWrong/#goWrong/#goAll/#resetAll`。**缺了不会崩**（只 `console.warn` 一次并跳过那项），但缺哪个就少哪个功能 |
| 题库段 | `<script data-bank type="application/json">` **建议放在引擎之前**；写在引擎之后也能跑（DOM 就绪后会补扫一次并 warn），但顺序对了最省事 |
| 背景（可选） | `#bgimg` |

**陪练没有形象时不会显示任何东西**（`#petFig` 默认 `display:none`，只有引擎确认"图找到了 / 选了内置大肥鱼"
才加 `.hasimg`）。**不要**给它塞一个内置的简笔画小人——用户明确否过。形象与台词的完整规范见
`pet-guide.md`；第三方素材见 `../third-party/dafeiyu-pet/`。

`assets/page-skeleton.html` 里这些标记都是全的，直接抄最省事。

## 3. 引擎对外的小接口

- **换章只改引擎顶部的 `PAGE` 配置块**（`.qsec` / `.cnt` 这两个类定义在骨架页的"合并层" `<style>` 里，不在 `practice.css`）：
  ```js
  var PAGE={
    key:'ch14-induction-study-guide-v1',     /* 存盘用的键，**每章换一个**（不换会跟别章串记录） */
    finalAdvice:'',                          /* 所有关卡都达标时显示的话；留空用默认 */
    petImages:['pet.png','pet.jpg','pet.jpeg','pet.webp',   /* 同目录找到哪张就用哪张 */
               'venti.png','venti.jpg','venti.jpeg','venti.webp'],
    bgImages:['pet-bg.png','pet-bg.jpg','pet-bg.webp'],     /* 留空则拿头像那张铺背景 */
    petLines:{}                              /* 想改陪练台词就写这里，键位表见 pet-guide.md */
  };
  ```
  **别把某一章的文件名写进 `petImages`**（引擎里出现的名字要对所有章通用，这是坑清单第 17 条的延伸）。
  其余全是推导的：**关卡名**优先读题区上的 `data-name`，没有就读该题区 `h2` 的标题
  （去掉「3/5 已答」计数、去掉计数被拿走后剩下的空括号；只有标题确实以「练」徽标开头时才剥掉那个「练」），
  都没有才叫「第 n 关」；**结算条**遍历实际存在的关卡（不写死 1..5）：**条宽 = 该关进度（已答/总数）**、
  **右边数字 = 正确率（对/已答）**，正确率 <60% 时条变警示色；
  **「各关都达标」是正向判的**——每关已答够（≥3 题或该关做完）且正确率 ≥70%，否则给"还没到各关达标"的提示。
- `say(text, cls)`：让陪练冒一句话（`cls==='happy'` 会额外跳一下）。答对/答错/点提示/换模式/整关做完都由引擎自动说，
  台词表与自定义方式见 `pet-guide.md`。
- `window.__PET__`：**调试接口**（给探针和"我上传的台词认没认出来"这种自查用）：
  `__PET__.lines` 是引擎实际在用的台词表的**副本**，`art()` 返回 `'image'|'fish'|null`，`hasImg()`、`position()`、`goal()`、`mode()` 都是读状态的 getter；
  `say(text)` 是唯一有副作用的动作。
- `paintProgress()` / `applyFilter()`：答题后自动调用；若自己加了新统计，改完 DOM 记得再调一次 `paintProgress()`。
- **引擎不替演示兜底**：每个演示 IIFE 要自己用 `try{…}catch` 包住，所以演示写崩了不会连累题目——请保持这个写法。
- **演示 JS 必须写在引擎脚本内部**（骨架页里那段 `章专用演示：把本章的演示 IIFE 放在这里` 的位置），
  因为 `fmt()` / `el()` / `say()` / `LINES` 都是引擎闭包里的函数。写到外面单独的 `⟨script⟩` 里会
  `ReferenceError`，而且被自己的 try/catch 吃掉 → **演示静默不显示**。
- 题区宿主要满足两点：`<div class="qlist" data-lv="N">`（题渲染到这里）+ 标题里放 `<span class="cnt" data-cnt="N"></span>`（自动填「已答/总数」）。**`#result` 结算区不能删**（引擎引用了里面的 `#r-*` 与 `#goWrong/#goAll`）。

## 4. 写题库的正确姿势（别手写转义）

JSON 里要嵌 HTML（如 `class=\"why\"` 的引号），手写迟早出错。用 Python 生成：

```python
import json
items = [ { "id": "l1-1", "type": "single", "lv": 1,
            "stem": '题干，可以带 HTML：<span class="fx">B = μ₀μ<sub>r</sub>H</span>',
            "opts": [ {"t":"…","ok":True,"why":"…"}, {"t":"…","ok":False,"why":"…"} ],
            "hint": "…" } ]
txt = json.dumps(items, ensure_ascii=False, indent=1)
json.loads(txt)                     # 回读校验一次（尾逗号这类错误在这里就现形）
# 再把 txt 塞进 <script data-bank type="application/json">…</script>
```

## 5. 配套工具（都在 `assets/`）

| 什么时候用 | 用哪个 |
|---|---|
| 校验这个页面（判分、统计、报错、数值写法容错、陪练形象） | `inject-probe.py` + `verify-probe.js` |
| 专门校验陪练（没图时不占地方 / 有图能拖能切 / 台词认没认出来） | `inject-probe.py` + `pet-probe.js`（和上一条一起用） |
| 页面里有可拖演示，想知道读数对不对 | `inject-probe.py` + `demo-probe.js`（拖 min/mid/max 抄读数、查 SVG 越界） |
| 搭演示台 | `demo-markup.html`（标记）+ `demo-guide.md`（画法约定） |
| 与《拆解手册》合体成单页 | `merge-interleave.py` |
| 改过源页面后同步资产 | `refresh-assets.py` |

## 6. 常用样式类（`assets/practice.css` 已定义）

`.pet` 陪练容器（`.off` 收起 · `.flip` 气泡翻到右边 · `.menuon` 菜单展开 · `.dragging` 正在拖）· `.pet .fig.hasimg` 形象（`.kind-image` 图片 / `.kind-fish` 内置大肥鱼 —— 这两个只当 JS/探针的钩子用，样式都在 `.hasimg` 上）· `.petmenu` 右键菜单 · `.q` 题卡（`.right`/`.wrongq` 表对错）· `.qno` 题号徽标 · `.qmark` 右上角判定 · `.opt` 选项（`.ok`/`.bad`/`.picked`）· `.why` 选项解释 · `.fb` 判定横幅 · `.box.hint` / `.box.sol` 提示与解析 · `.qfoot .mini` 提示/重做按钮 · `.qfoot .link` 回手册链接 · `.numrow` 填数行 · `.demo` 演示台 · `.readout` 读数格子 · `.chips` 预设按钮 · `.cnt` 计数 · `.qsec` 题区 · `.pet` 陪练 · `.bar` 吸顶条。

配色 token 全在 `:root`（含深色模式），改 `--field` 就能换整套主色。
