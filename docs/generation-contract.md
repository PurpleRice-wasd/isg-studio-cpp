# 生成契约（Generation Contract）

> 用途：isg-studio 用 API 调用大模型，生成与 `interactive-study-guide` skill **同样形态**的单页 HTML 学习材料。
> 本文件是给模型看的规格书，也是 app 侧校验器的实现依据。每条规则都标了出处（文件 + 小节）。
>
> 出处简写：`SKILL§三` = `skills/interactive-study-guide/SKILL.md` 第三节；`pit` = `references/pitfalls.md` 条目号；
> `QE§1.5` = `references/quiz-engine.md` 第 1.5 节；`DG` = `references/demo-guide.md`；`BV` = `references/build-and-verify.md`；
> `SKEL` = `assets/page-skeleton.html`；`DEMO` = `assets/demos-example.js`。

---

## 0. 边界：模型只产四样东西

**冻结资产（app 负责，模型一个字都不写）**：引擎 `<script id="engine">`、`practice.css`、吸顶条 `.bar`、`#result` 结算区、
陪练块 `#pet`、`<noscript>`、`.bgimg`、`PAGE` 配置块里的 `petImages/bgImages/petRoam*/petLines`、以及它们的样式与脚本。
这些直接来自 `assets/page-skeleton.html`（已实测可跑），**模型不得改动、不得复制、不得重写**。

**模型产物**（四段生成，每段一个 JSON）：

| 步骤 | 产物 | 粒度 | 出处 |
|---|---|---|---|
| S1 | `outline.json` | 一章一份 | SKILL§二.2 |
| S2 | `unit-prose.json` | 一个单元一份 | SKILL§二.2、SKILL§七（四段式讲法） |
| S3 | `bank.json` | 一个单元一份 | QE§1、QE§1.5、QE§4 |
| S4 | `demo.json` | 一个演示一份 | DG§一~三、DEMO |

app 的装配顺序（固定，不用模型操心）：骨架 → 每个单元插入讲解块
`<section id="{sectionId}"><h2><span class="num">{num}</span>{title}</h2>{prose.html}</section>`
→ 紧跟其后插入题区
`<section class="qsec" id="{qsecId}"><h2><span class="num">练</span>{qsecTitle} <span class="cnt" data-cnt="{lv}"></span></h2><p class="lede">{lede}</p><div class="qlist" data-lv="{lv}"></div></section>`
→ 每个演示的 markup 插到它所属单元的知识点旁 → 每个单元的 `items` 序列化成 `<script data-bank id="bankN" type="application/json">[…]</script>` 放在引擎之前
→ 综合大题单元与 `#result` 放在 `<footer>` 之前。

> ⚠ `title`（讲解块标题，如「13.1 磁介质与磁化」）与 `qsecTitle`（题区标题，如「练一练 · 13.1 的题」）是**两个不同的字符串**，别混用：结算条上的关卡名取自**题区** `h2`（SKEL L754-776），取错了会在结算区显示成讲解标题。

**术语**：`作答点` = 一道单题，或一道大题的一个 part。整章总量 = Σ(单题数) + Σ(大题的 parts 数)。

---

## 1. 输出契约

### 1.1 全局常量

| 常量 | 值 | 出处 |
|---|---|---|
| 整章作答点 | 45–90（参考 60–75：概念 ~25、计算 ~25、综合大题 ~20） | SKILL§一.6 |
| 单节迷你页作答点 | 6–20 | SKILL§七 |
| 单元数 | 3–8（迷你页 1） | SKILL§二.2 |
| 演示数 | 2–3（迷你页 0–2） | SKILL§二.4 |
| `lv` 取值范围 | 整数 0–9，互不重复，按单元顺序 0,1,2,… 连续 | QE§1、SKEL L1579 |
| 综合大题 `lv` | `max(units[].lv) + 1` | SKILL§二.2 |
| 每题选项数 | 2–6（字母表 `LETTERS=['A'..'F']`） | SKEL L1577 |
| 大题 parts 数 | 1–6 | QE§1.5 |

### 1.2 步骤 S1 — `outline.json`（先切单元）

**职责**：只切结构 + 配额度，**不写正文、不写题**。这样模型在最小上下文里做最重要的决策。

| 字段 | 类型 | 必填 | 约束（机器可判） |
|---|---|---|---|
| `chapter.no` | int | 是 | 1–999 |
| `chapter.title` | string | 是 | 2–24 字，不含「讲练一体」「练习册」等词 |
| `chapter.subject` | string | 是 | 1–12 字，如「大学物理学」 |
| `chapter.key` | string | 是 | `^ch\d{1,3}-[a-z0-9]{2,24}-study-guide-v\d+$`，每章唯一（**不换 key 会跟别章串记录**，SKEL L575） |
| `answerPoints` | int | 是 | 必须 **==** Σ`units[].targetCount` + `bigUnit.targetCount` |
| `finalAdvice` | string | 否 | 0–160 字；省略或 `""` = 用引擎默认 |
| `units` | array | 是 | 3–8 项（迷你页 1 项） |
| `units[].uid` | string | 是 | `^u[0-9]{1,2}$`，唯一 |
| `units[].lv` | int | 是 | 0–9；`kind=="warmup"` 的单元必须是 0；其余从 1 起按数组顺序连续递增 |
| `units[].kind` | enum | 是 | `warmup` \| `concept` \| `derive` \| `examples` \| `special` \| `comprehensive` |
| `units[].title` | string | 是 | 1–40 字；**讲解块的标题**，形如 `13.1 磁介质与磁化` |
| `units[].num` | string | 是 | 0–8 字；讲解块标题左侧的徽标，形如 `13.1`（热身单元写 `热身`） |
| `units[].qsecTitle` | string | 是 | 1–40 字；**题区标题**，必须以「练一练」开头，形如 `练一练 · 13.1 的题`。**不要含「x/y 已答」** |
| `units[].sectionId` | string | 是 | `^[a-z][a-z0-9-]{0,23}$`，唯一；正文 `<section id>` 用它 |
| `units[].qsecId` | string | 是 | 必须 **==** `"p-l" + lv` |
| `units[].refAnchor` | string | 是 | 必须 **==** `"#" + sectionId` |
| `units[].lede` | string | 否 | 0–120 字；题区那句引导话 |
| `units[].targetCount` | int | 是 | 4–16（`comprehensive` 单元 8–20）；必须 == 该单元 S3 里 Σ(单题) + Σ(parts) |
| `units[].concepts` | array\<string\> | 是 | 1–6 项，每项 1–20 字（这一节要讲透的概念） |
| `units[].formulas` | array\<string\> | 否 | 0–4 项，**纯 Unicode + 允许的 HTML 标签**，写法见 §3 |
| `units[].demoIds` | array\<string\> | 否 | 只能引用 `demos[].id` |
| `bigUnit` | object | 是 | 综合大题单元 |
| `bigUnit.lv` | int | 是 | == `max(units[].lv)+1`，≤ 9 |
| `bigUnit.title` | string | 是 | 默认 `综合大题 · 整章串起来` |
| `bigUnit.num` | string | 是 | 默认 `大题` |
| `bigUnit.qsecTitle` | string | 是 | 默认 `练一练 · 综合大题` |
| `bigUnit.sectionId` | string | 是 | 同 `units[].sectionId` 规则，唯一 |
| `bigUnit.refAnchor` | string | 是 | == `"#" + bigUnit.sectionId` |
| `bigUnit.targetCount` | int | 是 | 8–24；必须 == S3 里所有 `type=="big"` 的 parts 之和 |
| `demos` | array | 是 | 2–3 项（迷你页 0–2） |
| `demos[].id` | string | 是 | `^demo[A-Z]$`，按数组顺序 A、B、C |
| `demos[].unitUid` | string | 是 | 必须命中某个 `units[].uid` |
| `demos[].slider` | string | 是 | 1–12 字（拖什么） |
| `demos[].insight` | string | 是 | 1–40 字，一句话结论（`x 拖大 → y 变怎样`） |
| `demos[].formula` | string | 是 | 该演示唯一那条物理公式，纯文本/Unicode |
| `demos[].readouts` | array\<string\> | 是 | 3–4 项，每项「名称（单位）」 |
| `demos[].svgViewBox` | string | 是 | `^0 0 \d{3} \d{3}$`；宽 400–760，高 140–420 |

**S1 的机械不变量**（不满足就整份重出）：
1. `answerPoints == Σ units[].targetCount + bigUnit.targetCount`
2. `units[].lv` 互不重复且构成 `0..n` 连续序列
3. `sectionId` / `qsecId` / `uid` / `demoIds` 全局唯一且引用闭合（`qsecId == "p-l"+lv`、`refAnchor == "#"+sectionId`）
4. `chapter.key` 与别的章不重复
5. 每个 `qsecTitle` 以「练一练」开头，且**不含** `/` + `已答`（否则结算条关卡名被正则剥花，SKEL L764）

**S1 示例**（节选）：

```json
{
  "chapter": {"no":13,"title":"磁介质与磁场","subject":"大学物理学",
              "key":"ch13-magnetic-media-study-guide-v1"},
  "answerPoints": 68,
  "finalAdvice": "",
  "units": [
    {"uid":"u0","lv":0,"kind":"warmup","title":"热身 · 上一章还剩什么","num":"热身",
     "qsecTitle":"练一练 · 热身题","sectionId":"warmup","qsecId":"p-l0","refAnchor":"#warmup",
     "lede":"先把手热起来，再进正文。","targetCount":6,
     "concepts":["安培环路定理"],"formulas":["∮H·dl = ΣI₀"],"demoIds":[]},
    {"uid":"u1","lv":1,"kind":"concept","title":"13.1 磁介质与磁化","num":"13.1",
     "qsecTitle":"练一练 · 13.1 的题","sectionId":"s131","qsecId":"p-l1","refAnchor":"#s131",
     "lede":"刚看完就做，趁热。","targetCount":12,
     "concepts":["磁化强度 M","磁化电流"],"formulas":["B = μ₀μ<sub>r</sub>H"],
     "demoIds":["demoA"]}
  ],
  "bigUnit": {"lv":6,"title":"综合大题 · 整章串起来","num":"大题",
              "qsecTitle":"练一练 · 综合大题","sectionId":"sbig","refAnchor":"#sbig","targetCount":16},
  "demos": [
    {"id":"demoA","unitUid":"u1","slider":"μr",
     "insight":"μr 从 1 拖到 10⁴，B 被放大上万倍",
     "formula":"B = μ₀ μr H",
     "readouts":["μr","B₀（T）","B（T）","B′ = B − B₀（T）"],
     "svgViewBox":"0 0 520 200"}
  ]
}
```

### 1.3 步骤 S2 — `unit-prose.json`（一个单元一份讲解正文）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `uid` | string | 是 | 命中 `units[].uid`（`bigUnit` 不出正文） |
| `sectionId` | string | 是 | == 该单元 outline 里的 `sectionId` |
| `html` | string | 是 | HTML 片段，**从 `<h3>` 开始，不含 `<section>`／`<h2>` 外壳**（外壳由 app 加）。300–6000 字符 |
| `blocks` | int | 是 | 必须 **==** `html` 里 `<h3>` 的出现次数（1–4） |

**内容规格**（讲法由 skill 定死，别改，SKILL§七）：
- 每个 `<h3>` 是一个知识块，标题形如 `<h3>知识块 1 · 磁化强度 M</h3>`。
- 每个知识块内部按**四段式**写：① 大白话：要解决什么问题 → ② 核心公式 → ③ 公式为什么长这样 → ④ 单独一段易错点。
- 公式后面给「记忆锚」（一句口诀/图像），记忆锚与易错点是重点，不许省。

**S2 示例**：

```json
{
  "uid": "u1",
  "sectionId": "s131",
  "blocks": 1,
  "html": "<h3>知识块 1 · 磁化强度 M</h3>\n<p class=\"lede\">铁芯插进螺线管，为什么磁场能大几百倍？不是凭空多出来的电流，是介质自己也被磁化了。</p>\n<p>核心公式：<span class=\"fx\">B = μ₀μ<sub>r</sub>H</span>，其中 <span class=\"fx\">B′ = μ₀M</span> 是磁化电流单独贡献的那一份。</p>\n<p>为什么长这样：H 只认传导电流（<span class=\"fx\">∮H·dl = ΣI₀</span>），介质被磁化后多出一层磁化电流，它贡献的正是 B′……</p>\n<p><strong>易错点</strong>：H 与介质无关，B 与介质有关 —— 把 H 说成「磁场的强弱」是本单元最常见的错。</p>"
}
```

### 1.4 步骤 S3 — `bank.json`（一个单元一份题库）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `uid` | string | 是 | 命中 `units[].uid`；综合大题用 `"big"` |
| `bankId` | string | 是 | `^bank[0-9]{1,2}$`，全局唯一 |
| `lv` | int | 是 | == 该单元的 `lv`（综合大题 == `bigUnit.lv`）。**每个 item 的 `lv` 也必须等于它** |
| `items` | array | 是 | 1–16 项；Σ(单题) + Σ(`parts`) 必须 == `targetCount` |

#### 1.4.1 id 命名规则（S3 全部规则里最容易被撞车的一条）

- 单题 id 正则：`^(w|l[0-9]{1,2}|b[0-9]{1,2})-[0-9]{1,3}$`（`w`=热身、`l<n>`=第 n 单元、`b<n>`=综合大题里的单题）。
- 大题 id 正则：`^big[0-9]{1,2}$`。
- **全局唯一**，且必须额外满足：不存在 id `X` 与 id `X-<数字>` 同时出现（大题的每一步会自动生成 `<bigid>-<步号>`，SKEL L1868、L1893）。
  例：有了 `big1` 就**绝不允许**再出现 id 为 `big1-1` 的普通题（pit 70）。
- 序号不许以 `0` 开头。
- 这套前缀**天然不会撞车**：普通题的前缀是 `w`/`l<n>`/`b<n>`，大题是 `big<n>`，两者不可能互为 `X` 与 `X-<数字>`。
  **只要老老实实按这套命名写，规则 5 自动满足**；自己去发明 id（如 `big1-1`、`l1`）才会踩雷。

#### 1.4.2 公共字段（四种题型共有）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | string | 是 | 见 1.4.1；会当 `localStorage` 的键（QE§1） |
| `type` | enum | 是 | `single` \| `multi` \| `num` \| `big`（**只认这四个**，SKEL L1799） |
| `lv` | int | 是 | 0–9，且必须命中页面上存在的 `.qlist[data-lv=N]`（QE§1.5；否则整题跳过 + 告警） |
| `stem` | string | 是 | 题干，可含 HTML（见 §3）；非空 |
| `hint` | string | 否 | 思路提示，**只给方向不给答案** |
| `sol` | string | 否 | 解析；省略则不显示解析框，此时每个选项的 `why` 就是解析 |
| `ref` | object | 否 | `{"h":"#s131","t":"回手册 · 13.1 知识块 2"}`；`h` 必须命中页面真实存在的 id |

#### 1.4.3 `single` / `multi` 专有

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `opts` | array | 是 | 2–6 项 |
| `opts[].t` | string | 是 | 选项文字，可含 HTML |
| `opts[].ok` | bool | 是 | `single`：**恰好 1 个 true**（多于 1 会被判为不合格，SKEL L1815）；`multi`：**≥2 个 true** |
| `opts[].why` | string | 是 | 对的写「为什么对」，错的写「它错在哪」——**每条都要写**（QE§1、SKILL§一.4） |

`multi` 语义：用户勾选后点「提交答案」，**全对才算对**（QE§1）。`multi` 不得只有 1 个 `ok:true`（那就该是 `single`）。

#### 1.4.4 `num` 专有

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `ans` | **number** | 二选一 | JSON 数字，如 `1.257` / `2.51e-4`。**绝不能是字符串**（`"2.51×10⁻⁴"` 会让这题永远判错，QE§1） |
| `ansText` | array\<string\> | 二选一 | 非空；用于「单位是什么」这类文字答案题（`["A/m","a/m","A·m⁻¹"]`）。写了它则 `ans`/`tol` 被忽略 |
| `unit` | string | 否 | 显示用单位（`T`、`A/m`、`Wb`）；写 `ansText` 时不要写 |
| `tol` | number | 否 | 绝对容差，≥0；省略则 `|ans|×2%`（`ans=0` 时兜底 `1e-12`）。**手写时约束 `tol ≥ |ans|×0.005`**，否则学生照抄公布答案仍判错（pit 66） |

#### 1.4.5 `big` 专有（一步一问）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `parts` | array | 是 | 1–6 项，非空 |
| `parts[].type` | enum | 是 | `single` \| `multi` \| `num`（**不允许再嵌 big**） |
| `parts[].stem` | string | 是 | 这一小步的题干 |
| `parts[].opts` | array | `single`/`multi` 必有 | 同 1.4.3（含 `t`/`ok`/`why`） |
| `parts[].ans` | number | `num` 必有 | 同 1.4.4 |
| `parts[].ansText` | array\<string\> | 否 | 同 1.4.4 |
| `parts[].unit` | string | 否 | 同 1.4.4 |
| `parts[].tol` | number | 否 | 同 1.4.4 |
| `parts[].hint` | string | 否 | 同 1.4.2 |
| `parts[].sol` | string | 否 | 同 1.4.2 |
| `parts[].ref` | object | 否 | 同 1.4.2 |
| `parts[].id` | — | **禁止** | 小题 id 由引擎自动生成 `<bigid>-<步号>`（SKEL L1868），模型写了会被忽略 |

#### 1.4.6 严格 JSON Schema（draft-07 子集，`items` 的每一项）

```json
{ "oneOf": [
  { "type":"object", "required":["id","type","lv","stem","opts"],
    "properties":{
      "id":{"type":"string","pattern":"^(w|l[0-9]{1,2}|b[0-9]{1,2})-[0-9]{1,3}$"},
      "type":{"const":"single"},
      "lv":{"type":"integer","minimum":0,"maximum":9},
      "stem":{"type":"string","minLength":1},
      "opts":{"type":"array","minItems":2,"maxItems":6,"items":{
        "type":"object","required":["t","ok","why"],"additionalProperties":false,
        "properties":{"t":{"type":"string","minLength":1},"ok":{"type":"boolean"},"why":{"type":"string","minLength":1}}}},
      "hint":{"type":"string"},"sol":{"type":"string"},
      "ref":{"type":"object","required":["h","t"],"properties":{"h":{"type":"string","pattern":"^#[a-z][a-z0-9-]{0,23}$"},"t":{"type":"string"}}}
    },
    "additionalProperties":false },
  { "type":"object", "required":["id","type","lv","stem","opts"],
    "properties":{
      "type":{"const":"multi"},
      "opts":{"type":"array","minItems":2,"maxItems":6,"items":{
        "type":"object","required":["t","ok","why"],
        "properties":{"t":{"type":"string"},"ok":{"type":"boolean"},"why":{"type":"string"}}}}
    } },
  { "type":"object", "required":["id","type","lv","stem"],
    "properties":{
      "type":{"const":"num"},
      "ans":{"type":"number"},
      "ansText":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}},
      "unit":{"type":"string"},
      "tol":{"type":"number","minimum":0}
    },
    "oneOf":[{"required":["ans"]},{"required":["ansText"]}] },
  { "type":"object", "required":["id","type","lv","stem","parts"],
    "properties":{
      "id":{"type":"string","pattern":"^big[0-9]{1,2}$"},
      "type":{"const":"big"},
      "parts":{"type":"array","minItems":1,"maxItems":6,"items":{
        "type":"object","required":["type","stem"],
        "properties":{"type":{"enum":["single","multi","num"]},"stem":{"type":"string"}}}}
    } }
] }
```

> `single` 的「恰好一个 `ok:true`」与 `multi` 的「≥2 个 `ok:true`」是**跨元素的约束**，JSON Schema 表达不了，由 app 侧单独计数检查（SKEL L1813-1815）。

#### 1.4.7 生成方式（QE§4、SKILL§三.1）

模型**必须输出 JSON**（不要输出 `<script>` 包裹的文本）；app 侧用 `json.dumps(..., ensure_ascii=False)` 序列化后再加转义。
题库 JSON **绝不允许**尾逗号、注释、`NaN`、单引号 —— 一个尾逗号会让**整段**题目凭空消失且页面不报错（pit 1、SKILL§三.1）。

#### 1.4.8 真题题型 → 四题型映射（SKILL§二.1.5、subagents§代理人 C）

历年真题里出现的题型名**不是**引擎的题型名——引擎只认 `single` / `multi` / `num` / `big` 四种（SKEL L1799）。
所以从真题里提炼出的题型规律（`sources[].note.questionTypes[].shape`，见 §6.4）**必须映射**到其中一种，
映射表如下：

| 真题题型 | 映射到 | 落法 |
|---|---|---|
| 判断题 | `single` | 两个选项「正确」「错误」，恰好 1 个 `ok:true`（两个都标/都不标 → 这题不合格） |
| 填空（词/短语） | `num` + `ansText`，或 `single` | 答案唯一且是词/短语 → `ansText`（非空数组，可比对多种写法）；答案不唯一 → 拆成 `single` |
| 填空（数值） | `num` | `ans` 是 **JSON 数字** + `unit` + `tol`；`ans` 写成字符串会让这题永远判错 |
| 选择 | `single` / `multi` | 选项 2–6；`single` 恰好 1 个 `ok:true`，`multi` ≥2 个 |
| 简答 / 计算 / 证明 | `big` + `parts` | 一步一问，每步单独判分；`parts[].type` 只能是 `single`/`multi`/`num`（不许再嵌 `big`） |
| 作图 / 读图 | **不新增题型** | 归入 `big` 的一个 `single` 步（问"哪张图 / 哪条线"），或交给演示去建立直觉（§4） |

> ⚠️ **不要自创 `judge` / `fill` / `short` 这类题型名**——引擎不认识它们，会被降级成单选、答案语义错位
> （一道填空变成"从几个选项里选一个"），**而页面不报错**：题还能答、还能判分，判的却不是你想要的那个东西（pit 53）。
> 出题这一步的提示词里，真题题型规律会连同 `mapped` 一起渲染成"必须贴合"的约束（`questionTypeBlock()`）。
>
> 两条路径的表现不一样，但**都不是"报错"**：app 侧执行层（`bank.js` 的 `normalizePart`）会把它
> **按 `single` 处理**并记一条修正；独立的 skill 引擎（SKEL L1799 / `badReason()`）则把它
> **标红跳过、不计入总题数**（也就是 §2.1 规则 3 描述的那种）。别指望哪一条路径能替你把这个错拦住。

### 1.5 步骤 S4 — `demo.json`（一个演示一份）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | string | 是 | `^demo[A-Z]$`，== S1 里的 `demos[].id` |
| `markup` | string | 是 | HTML 片段，根元素 **必须**是 `<div class="demo" id="{id}">`；骨架见 §4 |
| `js` | string | 是 | **不含 `<script>` 标签**的 JS 片段；**必须以 `try{` 开头、以 `}catch(e){ console.error('演示 X 出错：',e); }` 结尾** |
| `sliderId` | string | 是 | == `"{id}-range"`（或该演示真实的 range 元素 id） |
| `sliderMap` | string | 是 | 滑块值 → 物理量的映射，如 `mu = 10^(s/1000*4)`（只给一条，供校验器复算） |
| `formulas` | object | 是 | `{读出量 id: 公式}`，如 `{"dA-3":"MU0*mu*H"}`；公式里出现的量必须全部能在 `sliderMap` + 常量里找到 |
| `checks` | array | 是 | 2–3 项手算核对表，见下 |
| `viewBox` | string | 是 | 与 markup 里的 `viewBox` 完全一致 |

`checks[]` 每项：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `set` | object | 是 | `{滑块元素 id: 值}`，如 `{"dA-range":500}` |
| `expect` | object | 是 | `{读数元素 id: 期望文本}`，元素 id 必须出现在 markup 里 |

`checks` 是**演示正确性的机器可判依据**：app 用它代替 `demo-guide.md` 要求的人工手算（DG§四.2）。
模型必须自己按公式算出这几组数再填进去，**不许猜**。

**S4 示例**：

```json
{
  "id": "demoA",
  "markup": "<div class=\"demo\" id=\"demoA\">…</div>",
  "js": "try{ (function(){ … })(); }catch(e){ console.error('演示 A 出错：',e); }",
  "sliderId": "dA-range",
  "sliderMap": "mu = 10^(s/1000*4)",
  "formulas": {"dA-1":"mu","dA-2":"MU0*H","dA-3":"MU0*mu*H","dA-4":"MU0*mu*H - MU0*H"},
  "checks": [
    {"set":{"dA-range":0},    "expect":{"dA-1":"1","dA-2":"2.513e-4","dA-3":"2.513e-4","dA-4":"0"}},
    {"set":{"dA-range":1000}, "expect":{"dA-1":"10000","dA-2":"2.513e-4","dA-3":"2.513","dA-4":"2.513"}}
  ],
  "viewBox": "0 0 520 200"
}
```

---

## 2. 硬性禁令清单

格式：`[规则] → 检查方法 → 违反后果`。**前 22 条针对模型输出，后 12 条针对模型可能抄错的引擎约定**。
§3.1「硬约定」与 §4.2「填空时必须遵守的七件事」同样是硬性规则，只是按产物归类写在那里，校验器要一并实现。

### 2.1 题库 / JSON（S3）

1. **题库 JSON 不许有尾逗号、注释、`NaN`、单引号** → `JSON.parse(textContent)` 失败即违反 → **那一段题整段消失，页面没有任何报错**（pit 1、SKILL§三.1、QE§1）
2. **每个题库段必须有 `data-bank` 属性且 `type="application/json"`** → DOM 属性检查 → 缺了不被 `querySelectorAll('script[data-bank]')` 收集，题全不见（SKEL L635）
3. **`type` 只能是 `single|multi|num|big`** → enum 校验 → 该题标红跳过、不计入总题数（QE§1.5、SKEL L1799）
4. **`id` 必填且全局唯一** → `Set` 查重 → 重复 id 两题共用存盘键、答一次进度 +2、另一张永远"未作答"（pit 68、SKEL L1883）
5. **普通题 id 不许与任何大题的自动步号撞车（`<bigid>-<n>`）** → 检查是否存在 `X` 与 `X-<数字>` → `#s-total` 多算一道、一次作答计两分、**主探针查不出来**（pit 70、SKEL L1893）
6. **`lv` 必须命中页面上真实存在的 `.qlist[data-lv=N]`** → DOM 查询 → 整题跳过 + 告警，题不见但不报错（QE§1.5、SKEL L1843）
7. **选择题 `opts` 至少 2 项且至少一个 `ok:true`** → 计数 → 标红跳过；无 `ok:true` 时学生永远答不对（SKEL L1811-1814）
8. **`single` 恰好一个 `ok:true`，`multi` 至少两个** → 计数 → `single` 多标会被标红跳过；`multi` 只标一个等于单选（SKEL L1815）
9. **`num` 的 `ans` 必须是 JSON 数字，不许写字符串** → `typeof ans === 'number' && isFinite` → 写成 `"2.51×10⁻⁴"` 时这题**永远判错**（QE§1、SKEL L1823）
10. **`ansText` 与 `ans` 二选一，且 `ansText` 必须是非空数组** → 类型 + 长度 → 空数组/写错类型会被标红跳过（SKEL L1819）
11. **`tol` 若是手写，必须 `tol ≥ |ans|×0.005`** → 数值比较 → 容差过小会让"照抄公布答案"仍判错，学生陷入死循环（pit 66）
12. **每个 `opts[].why` 都要写** → 字段存在性 → 缺失时反馈退化成只有"错了"，等于没反馈（pit 3、SKILL§一.4）
13. **`hint` 只给方向，不许出现该题答案的数值文本** → 在 `hint` 里搜 `ans` 的字符串形式 → 提示变答案，练习失效（SKILL§一.4）
14. **`ref.h` 必须是页面真实存在的锚点 id** → `document.getElementById(ref.h.slice(1))` → 死链（QE§2）
15. **`parts[]` 里不许写 `id`** → 字段存在性 → 与自动步号冲突（见规则 5）
16. **`stem` 里的 HTML 引号必须正确转义**（整段 JSON 由 `json.dumps` 生成，别手写 `\"`） → `JSON.parse` → 整段消失（QE§4、pit 1）

### 2.2 讲解 HTML 片段（S2）

17. **片段里不许出现 `<script>` / `<style>` / `<iframe>` / `<h1>` / `<html>` / `<body>`** → 标签白名单正则 → `<script>` 会让 HTML 解析器提前关闭外层脚本，整页 JS 变可见文字、完全不执行（pit 26、pit 27）
18. **不许引 MathJax 或 LaTeX**：不出现 `$…$`、`\(…\)`、`\\frac`、`\\text`、`\\mu` 等反斜杠命令 → 正则 `\\[a-zA-Z]+` + `\$` → 中文进 `\text{}` 会静默消失；且离线/CDN 不可用（pit 12、SKILL§二.5）
19. **公式一律 Unicode + `<sub>/<sup>`**，如 `B = μ₀μ<sub>r</sub>H`、`∮H·dl = ΣI₀` → 正则找 `\backslash` 或 `$` → 见规则 18（pit 12）
20. **SVG `<text>` 里不许用 `<sub>/<sup>`** → 正则 `<text[^>]*>[^<]*<(sub|sup)>` → SVG 不认这两个标签，文字挤成一行、版式崩（pit 10、SKILL§三.4）
21. **表格必须包在 `<div class="tablewrap">` 里** → 找裸 `<table>` → 窄屏横向撑破版式（pit 13）
22. **正文里别用 `.box`（`display:none`）**；要强调块用 `<div class="card">` → 找 `class="box"` → `.box` 默认隐藏、只有引擎给题目加 `.on` 才显示，正文里写它等于丢内容（practice.css L273）
23. **不许用 `<img>` 指外网 URL / 自己的 URL** → 找 `src="http` 或 `src="` → 离线打开必挂；交付物唯一允许的外部资源是同目录的 `pet.*` 图片（pit 36、SKILL§五）
24. **页内跳转只用同页锚点 `#id`**；不许标签页、不许分文件、不许 JS 跳转 → 找 `<a href` 不是 `#` 开头 / 找 `location.` → 切页会重置滚动位置（用户明确否过，pit 14、pit 15、SKILL§一.1）
25. **`html` 字段必须从 `<h3>` 开始，`blocks` 必须等于 `<h3>` 的实际个数** → 正则计数 → app 装配错位，知识块标题丢失

### 2.3 演示（S4）

26. **演示 JS 必须写在引擎 `<script id="engine">` 内部**（骨架的「章专用演示」位置） → 位置检查 → 写到外面单独的 `<script>` 里会 `ReferenceError`，又被自己的 `try/catch` 吃掉 → **演示静默不显示**（pit 46、QE§3）
27. **每个演示 IIFE 必须 `try{…}catch(e){console.error(…)}` 包住** → 正则以 `try{` 开头且含 `catch` → 一个演示写崩会连累题目与进度条（pit 6、QE§3）
28. **演示 markup 必须排在引擎脚本之前** → DOM 顺序检查 → `getElementById` 拿到 `null` → 引擎整段中断、题全没了且不报错（pit 5、SKILL§三.2）
29. **读数与曲线必须由公式现算现写**，不许贴图、不许写死常量 → 检查 `render()` 里每个 `textContent` 都由变量推出 → 图和数对不上（DG§一.1）
30. **凡有数据映射，刻度坐标也必须 JS 算** → 检查带 `id` 的 `<line>/<text>` 是否在 JS 里 `setAttribute` → 图和数错位、"看着挺专业"但读数错（pit 11、SKILL§三.6）
31. **`viewBox` 四周留 8–12 单位余量；靠边的标签要翻边** → `getBBox()` 越界检查 + 截图 → 滑块拉到极值时标签被裁（DG§三、BV§二.3.11）
32. **演示内部 id 一律 `d<X>-` 前缀**（`dA-1`、`dA-range`、`dA-bar`） → 正则 → 与别的演示或题目 `.q` 撞车（demo-markup.html 注释）
33. **演示根元素 id 只能是 `demoA`/`demoB`/`demoC`** → 正则 → JS 里按 id 取不到元素（demo-markup.html 注释）
34. **`render(<初始值>)` 必须在 IIFE 末尾调一次** → 正则找 IIFE 结尾的 `render(` → 页面加载后演示是空的（demo-markup.html 注释、DEMO L48）
35. **chips 预设按钮必须 `type="button"`** → 属性检查 → 在表单里会触发提交
36. **不许 `requestAnimationFrame` 做演示/补间** → 正则 `requestAnimationFrame` → 无头浏览器与后台标签页里不推进，探针验不出来（pit 21、pet-guide§二）

### 2.4 引擎约定（模型可能抄错的地方，app 侧兜底）

37. **不许往引擎里写死章节内容**（关卡名、诊断关卡号 `1..5`、章节文件名、台词里的"演示 1/L0"） → 在输出里搜章节号/文件名 → 换章不报错、只是显示别章的东西（pit 17）
38. **`petImages` 里不许写某一章的文件名** → 正则 → 同上（SKILL§五、QE§3）
39. **题库段必须排在引擎脚本之前** → DOM 顺序 → 写在后面虽然会补扫一次并告警，但顺序对了最省事（QE§2、SKEL L1917）
40. **陪练块必须排在引擎脚本之前**（`HAS_PET` 在脚本求值时就算好了） → DOM 顺序 → 放后面等于没有陪练，而且不报错（QE§2）
41. **`#result` 结算区不能删，`#r-*`／`#goWrong`／`#goAll` 不能少** → DOM 查询 → 引擎引用它们，缺了功能消失（QE§2、QE§3）
42. **每个 `lv` 都要有 `.qlist[data-lv=N]` 与 `.cnt[data-cnt=N]`** → DOM 查询 → 题渲染不进去／计数空白（QE§2）
43. **不许用 `window.confirm/alert`** → 正则 → iPad 的 WKWebView 宿主常常没实现，`confirm()` 永远返回 false，"点了没反应"（pit 56、SKILL§四）
44. **不许 `location.reload()`** → 正则 → 沙盒宿主里可能被忽略（pit 58、SKILL§四）
45. **不许用 `window.innerWidth` 定位固定元素** → 正则 → 差一个滚动条宽度（约 15px）（pit 19、pet-guide§二）
46. **不许 `NodeList.forEach` / 二参 `classList.toggle`** → 正则 → 老 iOS Safari（<10.1）不支持（pit 7、pit 8）
47. **所有 `localStorage` 读写包 `try/catch`** → 正则检查 `localStorage` 是否在 `try` 内 → `file://` 下 Safari 抛 SecurityError 会中断脚本（pit 9、SKILL§四）
48. **`<input>` 的 `font-size` ≥ 16px** → 样式检查 → iOS 聚焦时自动放大整页（SKILL§四）

---

## 3. 讲解正文的 HTML 片段规范

### 3.1 外壳（app 生成，模型只写内部）

```html
<section id="s131">                     <!-- id = outline 的 sectionId -->
  <h2><span class="num">13.1</span>磁介质与磁化</h2>   <!-- num + title，由 app 从 outline 拼 -->
  <p class="lede">……</p>
  <!-- ↑↓ 模型产出的 html 字段插在这里 -->
  <h3>知识块 1 · 磁化强度 M</h3>
  …
</section>

<section class="qsec" id="p-l1">        <!-- id = qsecId，紧跟讲解之后 -->
  <h2><span class="num">练</span>练一练 · 13.1 的题 <span class="cnt" data-cnt="1"></span></h2>
  <p class="lede">刚看完就做，趁热。……</p>
  <div class="qlist" data-lv="1"></div>  <!-- 题目由引擎填，模型不写 -->
</section>
```

**硬约定**：
- 题区的 `<span class="num">` 内容必须是**单个「练」字**，正文紧接着是 `qsecTitle`（必须以「练一练」开头）。引擎的 `levelName()` 只在 `.num` 以「练」开头时才剥掉它（SKEL L769-770、pit 74）。写成 `<span class="num">练一练</span>练一练…` 会让结算条上的关卡名变成「一练 · …」；把它写成别的字（如「题」）则关卡名会多出一个「练」。
- 题区 `<h2>` 里**不要自己写「3/5 已答」**，那是 `.cnt` 的活；自己写会被 `levelName()` 正则剥掉或残留空括号（SKEL L764-765、pit 74）。
- `<h2>` 与 `<h3>` 不重复表达同一层级：`<h2>` 只出现在 section 外壳里，模型产出的片段只用 `<h3>`（及更低）。

### 3.2 允许的标签白名单

| 用途 | 写法 |
|---|---|
| 知识块标题 | `<h3>知识块 N · 关键词</h3>` |
| 段落 / 引导句 | `<p>` / `<p class="lede">` |
| 列表 | `<ul>` `<ol>` `<li>` |
| 强调 | `<strong>` `<b>` `<em>` |
| 公式、数值、单位（等宽，不换行） | `<span class="fx">B = μ₀μ<sub>r</sub>H</span>` |
| 次要说明 | `<span class="sub">…</span>` |
| 上下标 | `<sub>` `<sup>` |
| 卡片块（小结、记忆锚） | `<div class="card">…</div>` |
| 表格 | `<div class="tablewrap"><table>…</table></div>` |
| 图注/引用 | `<figure><figcaption>` / `<blockquote>` |
| 同页锚点 | `<a href="#s132">` |
| 行内代码 | `<code>` |

**禁止**：`<h1>` `<h2>`（外壳专用）`<script>` `<style>` `<iframe>` `<img src="http…">` `<form>` `<input>`（题目的输入框由引擎生成）`class="box"`（默认 `display:none`）。

### 3.3 公式怎么排（**纯 HTML，不引 MathJax**）

这条是硬性的：新页面**一律不引 MathJax**（pit 12）。理由有两条：① CJK 字形不在 MathJax 的字体里，中文进 `\text{}` 会**静默变空白**；② 离线打开时 CDN 拿不到。

可用写法（全部来自骨架页与 demos-example.js 的实测用法）：

```
积分/环路    ∮H·dl = ΣI₀            Σ  ∮  ∂  ∇  ∫  →  直接写 Unicode
上下标       B = μ₀μ<sub>r</sub>H    磁导率、下标一律 <sub>
幂           B₀ = μ₀H，μ<sub>r</sub> = 1 + χ<sub>m</sub>
分式         用 / ：H = nI ；B/B₀ ；I·r²/R₁²（必要时 <span class="fx"> 包起来保持一行）
矢量与叉乘   v×B（用 ×，不要 \times）
希腊字母     μ ε χ ρ σ ω θ λ Δ Φ  直接写
特殊符号     ⊥ ∝ ≈ ≠ ≥ ≤ ° ′ ″ · − （负号用 U+2212 或 ASCII '-'，两者引擎都认）
数字下标     ₀₁₂₃₄₅₆₇₈₉（可用；但字母下标请写 μr 而不是 μᵣ）
```

**记忆锚**：在公式后紧跟一句 `<p><strong>记忆锚</strong>：…</p>`，用大白话+图像（如「H 只认传导电流，B 才认介质」）。

**易错点**：每个知识块末尾单独一段，`<p><strong>易错点</strong>：…</p>`，写清「最常见的错法 → 为什么错」。
这两项是 skill 的既定写法，别省（SKILL§七）。

---

## 4. 演示的写法契约

### 4.1 骨架（填空模板）

**markup**（放讲解正文对应知识点旁，**必须在引擎脚本之前**）：

```html
<div class="demo" id="demoA">
  <p class="demo-h"><span class="pill">演示 1</span>{{拖什么、看什么}}</p>
  <p class="demo-p">{{一句话说清这条演示想让人看懂什么}}</p>

  <div class="demo-grid two">
    <div class="demo-fig">
      <svg viewBox="{{viewBox}}" role="img" aria-label="{{这张图画的是什么}}">
        <text class="s b" x="12" y="28">{{固定那一行}}</text>
        <rect x="12" y="36" width="150" height="20" rx="4"
              fill="var(--surface-2)" stroke="var(--rule-strong)"></rect>

        <text class="s b ta" x="12" y="92">{{随滑块变的那一行}}</text>
        <rect id="dA-bar" x="12" y="100" width="6" height="26" rx="4" fill="var(--field)"></rect>
        <text class="s ta b" id="dA-barval" x="330" y="119"></text>
        <line class="thin" x1="12" y1="146" x2="500" y2="146"></line>

        {{曲线类演示才写：}}
        <path id="dA-curve" fill="none" stroke="var(--field)" stroke-width="2"></path>
        <circle id="dA-curvedot" r="4" fill="var(--warn)"></circle>
        {{刻度（坐标由 JS setAttribute，别写死）：}}
        <line id="dA-t1" class="thin" y1="150" y2="156"></line>
        <text id="dA-l1" class="s" y="172"></text>
      </svg>
    </div>

    <div>
      <div class="ctrl">
        <div class="row"><span>{{滑块名}}</span><b id="dA-val">—</b></div>
        <input type="range" id="dA-range" min="0" max="1000" value="0" aria-label="{{滑块名}}">
      </div>
      <div class="chips">
        <button type="button" data-v="0">{{预设 1}}</button>
        <button type="button" data-v="1000">{{预设 2}}</button>
      </div>
      <div class="readout">
        <div><span>{{量 1}}（{{单位}}）</span><b id="dA-1">—</b></div>
        <div><span>{{量 2}}（{{单位}}）</span><b id="dA-2">—</b></div>
        <div><span>{{量 3}}（{{单位}}）</span><b id="dA-3">—</b></div>
      </div>
      <p class="say" id="dA-say">{{随滑块变化的点评}}</p>
    </div>
  </div>
</div>
```

**js**（放在引擎的「章专用演示」位置，**不许写 `<script>` 标签**）：

```js
try{ (function(){
  var rng   = document.getElementById('dA-range'),
      bar   = document.getElementById('dA-bar'),
      barval= document.getElementById('dA-barval'),
      val   = document.getElementById('dA-val'),
      say   = document.getElementById('dA-say'),
      out   = [document.getElementById('dA-1'),
               document.getElementById('dA-2'),
               document.getElementById('dA-3')];

  var {{常量}} = {{值}};                     /* 固定量全部提到这里，别散在函数里 */

  function {{滑块→物理量}}(s){ return {{映射式}}; }   /* 与 S4.sliderMap 一致 */
  function px(m){ return {{x0}} + m*{{kx}}; }        /* 数学坐标 → 屏幕坐标 */
  function py(m){ return {{y0}} - m*{{ky}}; }        /* ⚠ 屏幕 y 向下，所以要减 */

  function render(x){                        /* 唯一入口：图和读数都从这里出去 */
    var y = {{物理公式}};                     /* ← 只有这一行是物理 */
    val.textContent = {{滑块量的显示文本}};
    out[0].textContent = fmt({{量1}});
    out[1].textContent = fmt({{量2}});
    out[2].textContent = fmt({{量3}});

    var frac = Math.min(1, y/{{量程}});        /* 长度 ∝ 物理量，可压缩但要在文案里说明 */
    bar.setAttribute('width', String(6 + frac*{{条长}}));
    barval.setAttribute('x', String({{标签 x}}));
    barval.setAttribute('y', String({{标签 y}}));
    barval.textContent = {{标签文本}};

    /* 曲线类演示：曲线与工作点也必须现算 */
    {{curve.setAttribute('d', buildPath()); }}
    {{cdot.setAttribute('cx', String(px(x))); cdot.setAttribute('cy', String(py(y)));}}

    say.innerHTML = (x > {{阈值}}) ? '{{大值时的说法}}' : '{{小值时的说法}}';
  }

  rng.addEventListener('input', function(){ render({{滑块→物理量}}(+rng.value)); });
  Array.prototype.forEach.call(document.querySelectorAll('#demoA .chips button'), function(b){
    b.addEventListener('click', function(){
      render(+b.getAttribute('data-v'));
      rng.value = b.getAttribute('data-v');
    });
  });
  render({{初始值}});                          /* ⚠ 必须画一次初始状态 */
})(); }catch(e){ console.error('演示 A 出错：',e); }
```

### 4.2 填空时必须遵守的七件事

1. **一个 `render()` 出入口**：图和读数全部由它写，映射函数（`px`/`py`）共用 —— 这样"数对不上图"在结构上就不可能发生（DG§一.1）。
2. **长度 ∝ 物理量**：箭头/条形的长度按公式值映射，可以压缩刻度但要说明；**不许随手画一个好看的长度**（DG§一.2）。
3. **方向算完再画**：先按数学坐标算 `v×B`（或 `dl×r`），**再**决定箭头朝哪；不要在屏幕坐标里凭感觉（DG§二.2）。
4. **"⊥"要真垂直**：用坐标保证（`y1==y2`、`x1==x2`），再在交点加一个小直角方块（DG§二.3）。
5. **`×`/`⊙` 用 JS 铺、跳过导体附近几列**（如跳过 `|x − 棒x| < 26`），否则记号压在字上（DG§二.4）。
6. **`fmt()` 是引擎闭包里的函数**（还有 `el()`/`say()`/`LINES`）：演示 JS 必须在引擎脚本内部才能用；读数一律用 `fmt(值)`（它已保证小数位按量级给足）（QE§3、pit 46）。
7. **自洽性自查**（画完逐条过）：该垂直的点乘 = 0；端点落在它该在的线上；共线的箭头真共线；箭头首尾能闭合成你声称的绕向（DG§二.5）。

### 4.3 曲线面板（只有一个滑块时）

- 只让数字跳是不够的，补一条 **「读数—自变量」关系曲线**；再给第二个滑块时，拖它曲线转动、拖第一个工作点沿曲线移动（DG§三）。
- 量程取"滑块极值时读数的最大值"再往上取整（例：最大 1.44 → 纵轴到 1.6）。
- 防越界清单：**端点标签、工作点标签、轴标题、刻度数字**四类都要留位；`viewBox` 四周 ≥ 8–12 单位余量；轴标题与刻度数字别贴同一行（DG§三）。

---

## 5. 校验项 → 生成步骤映射

`BV§二.3` 的十一项必查。左列是探针报出的字段名，中列是"哪一步错了会让它失败"，右列是**自动修复时要回灌给模型的信息**。

| # | 检查项（探针字段） | 失败通常来自 | 回灌给模型的内容 |
|---|---|---|---|
| 1 | `题库条目=N`（应 = 单题数 + parts 数）与题卡总数一致 | **S3**：漏题（`items` 短于 `targetCount`）；某题 `parts` 写成 0 或漏写；某题被 `badReason` 判不合格而跳过 | 该单元的 `targetCount`、实际条目数、每道被跳过题的 `badReason` 原文 + 那道题的原始 JSON。**要求只补/只改那几条，重出整个 `items` 数组** |
| 2 | `缺卡=0`（每道题都有 `#q-<id>`） | **S3**：`id` 缺失；`id` 重复被引擎改名（改名后探针按原名取不到）；`lv` 指向不存在的题区；该题渲染抛错 | 缺卡的 id 列表 + 每个 id 的失败原因（`缺 id` / `重复` / `lv=N 无题区` / `渲染抛错: <msg>`）。**S1 也要回灌**：若原因是 lv 无宿主，把 `units`/`bigUnit` 的 lv 表一并给模型 |
| 3 | `自动作答后判错=0 抛错=0` | **S3**：`ans` 算错（模型算错数）；`tol` 太小；`multi` 的 `ok` 标错；`ansText` 拼写与题目不符；`num` 题实际是文字答案却写了 `ans` | 每道错题的：`id`、探针实际写入的值、引擎判定的正确答案（`fmt(ans)` 或 `ansText[0]`）、该题 JSON 原文。**明确要求"只改这一题的字段，重新验算一遍"** |
| 4 | `写法容错(id) 带单位=对 科学计数法=对` | **S3**：`unit` 与 `ans` 的单位不一致（如 `ans` 按 T 写、`unit` 却写 `mT`），导致带单位写法判错 | 那道题的 `ans`、`unit`、期望"带单位写法"的字符串。**要求二选一：改 `unit`，或把 `ans` 换到 `unit` 的量级** |
| 5 | 进度/计数：`已作答=总数`、各关 `.cnt` 与卡片数一致、`结算关卡名=…` | **S1**：`qsecTitle` 写得不规范（`.num` 不是单字「练」、标题自带了「x/y 已答」、残留空括号、不以「练一练」开头） → 关卡名取错；**S1**：`lv` 不连续或有洞 | 探针打印出的关卡名 vs S1 里该 `lv` 的 `qsecTitle`。**要求只改 `qsecTitle`**；若 lv 有洞，重出整个 `units` 数组并附上"lv 必须是 0..n 连续"的约束 |
| 6 | `重做后该题=已复位` | 引擎保证；失败只可能是自定义 JS 破坏了卡片结构 | 一般不需回灌。若反复失败，检查 S4 的 JS 有没有误取 `.q` 里的元素 |
| 7 | `脚本错误=无`（含 `异步脚本错误=`） | **S2**：片段里混入 `<script>` 或未闭合标签；**S4**：JS 语法错误、取到 `null` 元素后没判空；**S1**：`refAnchor` 指向不存在的 id | 错误文本 + 出错的文件（S2/S4）+ 该单元/演示的原始产物。**要求只重出那一个产物**，不要动别的 |
| 8 | `演示：滑块 min/mid/max 读数` + `SVG 越界元素=0` | **S4**：公式写错；刻度坐标写死；`viewBox` 太小；标签贴边；`checks` 与实际不符 | 该演示的 `checks`（模型的期望值）vs 探针实测值，逐元素列出；越界元素的 id 列表 + 当前 `viewBox`。**要求：先把公式重新算一遍，再改 `viewBox` 或让标签翻边** |
| 9 | 陪练三态（`无图`/`有图`/`fish`） | **app 侧不变式**，与模型无关（`petImages` 由 app 配置）。模型唯一能破坏它的方式是往 `PAGE` 里塞章节文件名 | 不需要回灌模型 |
| 10 | 台词覆盖（`在用台词 right=…`） | **app 侧不变式**（`petLines` 由 app 配置） | 不需要回灌模型 |
| 11 | 截图（浅色 + 深色各一张，看叠字/压线/裁切） | **S2**：表格没包 `tablewrap`；**S4**：图面文字压线、标签贴边、形象被裁 | 需要视觉模型或人工产出"哪个元素、什么坐标、什么问题"的描述，再把该演示/该段正文回灌。**这条不能省**（ch14 曲线面板做窄、工作点标签被裁就是靠它发现的） |

### 5.1 自动修复的通用回灌格式

回灌消息应当是**三元组**，不要贴整页 HTML：

```
步骤：S3（单元 uid=u3，lv=3）
问题：<badReason 原文 / 探针字段原文>
证据：<那道题的 JSON 原文 / 探针实测的 id:值 列表>
要求：只重出这一条（或这一组），其余保持逐字节不变；重出后必须满足 <把相关规则从 §2 抄一遍>
```

**理由**：弱模型在长上下文里会顺手改坏本来正确的部分。**一次只让它修一个失败项**，并在重出后重新跑全部十一项（不是只跑失败那项）。

---

## 附录 A — 常量速查

| 项 | 值 / 出处 |
|---|---|
| 判分后正确答案的显示 | `ansText[0]` 或 `fmt(ans)`（SKEL L1594） |
| 数值输入认什么 | `1.06` / `1.06 T` / `2.51e-4` / `2.51×10⁻⁴` / `1,06` / `1 000 000` / 全角数字 / 各种负号 / `A/m` |
| 数值输入不认什么 | `5-3`、`1/2`、`2+3`、`5 T=9`、`1.2.3`、`0x10`、`1e`（返回"看不懂"，不再当答错）（QE§1、pit 64-65） |
| 每题卡片 id | `#q-<qid>`；大题壳 `#grp-<bigid>`（SKEL L1674、L1858） |
| 大题步号 | `<bigid>-1`、`<bigid>-2`…（SKEL L1868） |
| 选项目标字母 | `A`–`F`（SKEL L1577） |
| 达标判定 | 每关已答 ≥3 或该关做完，且正确率 ≥70%（SKEL L812-814、pit 69） |
| 结算条 | 条宽 = 该关已答/总数；右边数字 = 对/已答；<60% 变警示色（SKEL L798-801） |
| 存盘 key | `PAGE.key`，每章必须换（SKEL L575、pit 17） |

## 附录 B — 题型字段速查（哪种题型有哪些字段）

| 字段 | single | multi | num | big |
|---|---|---|---|---|
| `id` | ✅ | ✅ | ✅ | ✅ |
| `type` | ✅ | ✅ | ✅ | ✅ |
| `lv` | ✅ | ✅ | ✅ | ✅ |
| `stem` | ✅ | ✅ | ✅ | ✅ |
| `opts` | ✅(2–6, 恰好 1 ok) | ✅(2–6, ≥2 ok) | — | — |
| `ans` | — | — | ✅（number） | — |
| `ansText` | — | — | ⭕（与 ans 二选一） | — |
| `unit` | — | — | ⭕ | — |
| `tol` | — | — | ⭕（≥ \|ans\|×0.005） | — |
| `parts` | — | — | — | ✅(1–6) |
| `hint` / `sol` / `ref` | ⭕ | ⭕ | ⭕ | ⭕（parts 里也各有） |

✅ = 必填，⭕ = 可选，— = 不适用。

---

## 6. 输入来源与多来源融合

> 这一节只对**逐来源分析**那一步有意义（`systemPrompt('analyze')` 取的是 `§0 + §6` 两段）。
> 常规四个阶段拿到的是 `sources[]` 与各来源的分析结论，不是这一节的原文。
> （SKILL§二.1、SKILL§二.1.5、subagents§代理人 C）

一次任务可以导入**多份**材料，每份材料是一个**来源**（source），带一个**角色**（`role`）。
融合后的产物（单元、正文、题库）要同时照顾到几份材料，**但它们不会以"原文"的形式一股脑塞进来**——
它们各自先被单独理解一遍，产出一份 `sourceNote`（见 6.4），规划与出题主要看的是这些结论。

### 6.1 `sources[]` 的结构

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 本任务内唯一；`sourceNote.sourceId` 必须原样回填它 |
| `role` | enum | 是 | `courseware` \| `textbook` \| `exercises` \| `exampaper`（语义见 6.2） |
| `label` | string | 否 | 用户给这份来源起的名字；提示词里优先用它称呼这份材料 |
| `fileName` | string | 否 | 原始文件名；没有 `label` 时用它 |
| `pages` | array | 是 | 抽取出来的页 `{index, text}` |
| `scopedPages` | array | 否 | 课本被 `scope` 限成一节时，这里是**那一节**的页；有它就用它，不看 `pages` |
| `scope.label` | string | 否 | 用户指定的范围（如「第 13 章 13.1 节」）；分析时要把这句原样写进提示词 |
| `note` | object | 否 | 该来源的分析结论（`sourceNote`，见 6.4）；没有它时退化成"只喂原文" |
| `dropped` | bool | 否 | 该来源没有有效文本、被丢弃；`dropped` 的来源不进任何素材段 |

**单来源退化必须逐字节保真**：只有一份 `courseware`、且没有 `note` 时，走的还是从前的 `sourceText()` 那条路
（这是"既有自测继续全绿"的闸门）。多来源才走"结论在前、原文在后"的融合素材段。

### 6.2 四种角色的语义

| 角色 | 中文 | 它在融合里提供什么 | 原文权重 |
|---|---|---|---|
| `courseware` | 课件 | 这一章的**主线**：单元怎么切、讲到什么深度，以它为准 | 1（**整份给**，护栏见 6.5） |
| `textbook` | 课本 | **定义与推导链条**的权威版本；讲解与出题都要与它一致 | 0.6 |
| `exercises` | 习题 | **练法与易错点**：覆盖哪些知识点、各是什么题型、学生最容易卡在哪一步 | 0.4 |
| `exampaper` | 历年真题 | **题型规律**：让生成的题贴合真题的形态与考法（§1.4.8） | **0** |

### 6.3 每份来源各一次独立分析（互不可见）

**每份来源各起一次独立的模型调用**去理解它，那次调用**只拿到这一份来源的正文与角色说明**：
拿不到别的来源的结论，也拿不到任何出题过程的痕迹（与"独立审题"（`subagents.md` 代理人 B）是同一条隔离原则）。
产物就是这份来源的 `sourceNote`（6.4）。这样每份材料被独立理解一遍，做融合的那个人拿到的才是
**互不污染的视角**，而不是"第一份材料的结论污染了后面每一份"。

**三条必须写死的规矩**：

1. **`exampaper` 只提炼题型规律，绝不摘抄原题**。要的是"这份卷子由哪些题型构成、各占多少、
   考法是直接套公式还是两步计算、哪些考法反复出现"，**不是**某一道题长什么样。
   工程上它落在**原文权重 0**：真题正文**根本不进提示词**，模型就算想抄也无从抄起；
   它仍然以**摘要**（题型分布、常考考法）的形式参与融合。提炼出的题型一律先映射成四种题型（§1.4.8）。
2. **`textbook` 只看用户指定的那一章/一节**（`scope`）：那一次调用只看 `scope.label` 那一节，
   其余部分不在本次范围内。整本课本一次分析既超上下文、又会把这一章稀释掉。
3. **扫描件这一轮不做 OCR**：整页都是图片的 PDF 没有文字层，抽出来是空的。
   这件事必须在**导入时**就告诉用户——"请自行转成可选中文字的 PDF，或导出成 `.md` / `.txt`"——
   **不要等生成失败才报错**（pit 54）。app 侧那条"一个字都没抽出来"的兜底是最后一道闸，不是提示方式。

### 6.4 `sourceNote` 的字段表（一次调用、分析一份来源的产物）

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `sourceId` | string | 是 | 原样回填该来源的 `id` |
| `role` | enum | 是 | 原样回填该来源的 `role` |
| `summary` | string | 是 | ≤300 字：这份材料是什么、覆盖什么 |
| `outline` | array | 是 | `[{title, points:[...]}]`；`points` 是这一小节的核心结论 |
| `terms` | array | 是 | `[{zh, en}]`：术语中英对照；**后面所有步骤都照它写**，防止几份材料各说各话 |
| `formulas` | array\<string\> | 是 | 关键公式；纯文本 / Unicode，写法见 §3.3 |
| `constants` | array | 是 | `[{name, value, unit}]`，如 `{name:"真空磁导率", value:"4π×10⁻⁷", unit:"H/m"}` |
| `questionTypes` | array | **仅 `exampaper` 必填** | `[{shape, mapped, note}]`；`mapped` 只能取 `single`/`multi`/`num`/`big`（§1.4.8） |
| `warnings` | array\<string\> | 是 | 这份材料里没看懂、没把握的地方——**写出来，而不是猜** |

别的角色给了 `questionTypes` 也无妨：只有 `exampaper` 的那一份会被渲染成"出题必须贴合"的约束段
（`questionTypeBlock()`），其余角色的 `questionTypes` 不进那一段，不制造噪音。

### 6.5 素材段的取舍（为什么不是"把几份原文都附上"）

- **摘要在前、原文在后**。摘要便宜、信息密度高，先讲清"这是什么"。
- 课件原文**整份给**，但有一条**护栏**（不是预算）：超过约 60000 字才截断并在日志里说明——
  真遇到几百页的材料，截断总比整个任务 400 好。
- 其余角色的原文在**剩余预算里按权重分**，每份**独立**走同一条刹车（避免一份 300 页课本把课件饿死）。
  `exampaper` 权重为 0，所以它**不会出现在原文段里**。
- 单来源（只有一份 `courseware`）时不走这套，行为与从前逐字节一致——上面这条闸门别顺手改掉。

---

## 7. 一册多章（把以前生成过的章并成一册）

> 出处：`pipeline/assemble.js`（`toChapters()`、`-0. 全局槽位表`、`-0.2 演示 id 的全局分配`、第 9 步的跨章防线）、
> `book.js`（旁挂数据）、`pipeline/revive.js`（从成品页反推）、`jobs.js` 的 `describe()`；
> 测试在 `test/assemble-merge.js` 与 `test/revive.js`。
> 这一节只写"并成一册"多出来的约束——§1~§5 的规则一条都不变，模型的四段产物（S1~S4）形状也不变。

课是一节一节上的：这一周的课件常常只有今天讲的那一章。用户可以把**以前生成过的页面**带上，
让新生成的这一章与它拼成**同一册**（可选）；以后再加一章，就继续往上并。所以"合并"不是一条一次性的路，
而是一种**可持续的形态**：每加一章都必须是"零改名、零搬家"的。

### 7.1 拼装器的入参：单章与一册

```js
assemble({ skeleton, chapters:[{ chapter, units, demos }], pageKey, finalAdvice, pet, generator })
```

- `chapters[]` 每项的 `chapter` 就是 §1.2 的 `chapter`（`{no|number, title, subject, intro}`），
  `units[]` 是 §1.2 的 `units`（每项带 `id`/`num`/`title`/`qsecTitle`/`lectureHtml`/`bank[]`），`demos[]` 见 §1.5。
- **`frozen` 写在 `chapter` 这一层上**（`chapters[].chapter.frozen === true`）：表示"这一章以前生成过、
  已经交付给用户了"，它的作答点 id 一个字都不许改（见 7.2 规则 2）。**不写在这层上的 `frozen` 不会生效**——
  归一函数只向 `chapter` 取值。
- 老的单章形状 `{ skeleton, chapter, units, demos, … }` **继续接受**（内部归一成 `chapters:[{…}]`）；
  **只有一章时，产出与"支持多章之前"逐字节一致**——这是既有自测继续全绿的闸门，别顺手改掉。
- 一册里"目录分组、页头章数、题区 `data-name`"这类只在多章时才出现的东西，全部由拼装器按章数决定，模型不写。

### 7.2 四条硬规则

**规则 1：`lv`（关卡号）跨章连续，严格 `0..N-1` 无跳号。**
同一个号同时出现在**三处**：正文的 `data-lv`（题区宿主 `.qlist`）与 `data-cnt`（计数 `span`）、
题库 JSON 里**每道题**的 `lv`、以及**引擎运行期**按 `data-lv` 建的分桶（`quiz-engine.js` 的 `lvHosts`，
题是按 `lvHosts[q.lv]` 取宿主的，SKEL L1057、L1327）。三处必须同源。
各章各自从 0 编（按章内下标）时，两章的第一个单元都拿到 0 —— 第一章的题会**渲进第二章的题区**，
而**页面不报错**：题还在、还能判分，只是挂到了别人的讲解下面（`pit 83`）。
拼装器在多章时硬断言 `data-lv` 恰好是 `0..N-1` 各一次；单章不做这项断言（那样会把既有产出判成失败）。
> 单章时 `lv` 的上界还是 §1.1 的 9；并成一册后一个单元的 `lv` 是**全册**槽位下标，可以超过 9
> （引擎按 `data-lv` 字符串取宿主，不设这个上限）。

**规则 2：作答点 id 不撞不改。**
带过来的章（`frozen`）**一个字都不改**；本次新生成的那一章**只有会撞车时**才把前缀换成 `c<章序>-`
（如 `c2-u1-q1`）。为什么不能"一律加前缀"：作答点 id 就是做题进度的**存盘键**
（引擎把进度按 `store.pts[q.id]` 存在 `localStorage[PAGE.key]` 下，QE§1），给已经发出去的章改名，
学员在这一章的记录就全部对不上。配套的一条：**冻结章先占 id、先占锚点**，
所以"新章排在旧章前面"时被改名的也是**新章自己**；反过来会把冻结章挤去改名，而那是静默的（`pit 84`）。
于是"在已有册子上再加一章"是**零改名、零搬家**——这条路上根本没有"进度迁移"这一步。

**规则 3：册的存盘键与章列表无关。**
带过来的那一份**本身已经是册**，就用它自己的键；否则用**第一份被带的章**的键。
要是键随章列表变（比如"把各章的键拼起来"），每加一章都要把全册进度搬一次家，
而搬家的失败模式是完全静默的串档（`pit 84`）。首次确定后一直复用。

**规则 4：一册一份引擎、一个进度条、一个结算区。**
每章有自己的章标题块与它的小节；一册里只有一个 `#result`、一套吸顶条计数、
一份 `<script id="engine">`。题区带 `data-name="<章号 单元号 标题>"`（如 `data-name="第 13 章 13.1 磁化"`），
引擎取关卡名时**优先读它**、其次才是题区 `h2`（`quiz-engine.js` L199-206）——
所以两章都叫「小结」也能在结算区分得清。单章不加 `data-name`（加了会改变既有产出）。

### 7.3 旁挂文件：`<名字>.html.isg.json`

生成成功后，在 HTML **同目录、同 basename** 写一份结构化数据（`book.js`）：

```
ch13-磁介质-讲练一体.html  →  ch13-磁介质-讲练一体.html.isg.json
```

```json
{
  "schema": "isg-book/1",
  "kind": "chapter",
  "appVersion": "1.2.0",
  "title": "磁介质与磁场",
  "subject": "大学物理学",
  "key": "ch13-...-studio-v1",
  "chapters": [
    {
      "chapter": {"no":"13","title":"磁介质与磁场","subject":"大学物理学","intro":"…"},
      "key": "ch13-...-studio-v1",
      "sourceFile": "第13章课件.pdf",
      "createdAt": 1730000000000,
      "jobId": "…",
      "units": [
        {"id":"u1","num":"13.1","title":"磁介质与磁化","shortTitle":"13.1","qsecTitle":"练一练 · 13.1 的题",
         "lede":"…","lectureHtml":"<h3>知识块 1 · …</h3>…","bank":[ {"id":"u1-q1","type":"single","lv":1,"stem":"…","opts":[]} ]}
      ],
      "demos": [{"id":"demoA","title":"…","markup":"…","js":"…","unitId":"u1"}],
      "frozen": false
    }
  ]
}
```

- `kind` 是 `chapter`（一章单独成页）或 `book`（几章合成的一册），**`chapters[]` 都是列表**——
  单章就是只有一项的列表，同一个形状两处共用。
- ⚠️ 两处字段名在"喂回拼装器"时要过一层映射，别直接原样塞：旁挂格式里章号叫 `chapter.no`、
  `frozen` 在**章条目这一层**（`chapters[].frozen`），而拼装器要的是 `chapter.number` 与 `chapter.frozen`（§7.1）。
- **`bank` 存的是已规范化的 items（含**最终**的 `q.id`）**，`book.js` 只搬不改。这是"进度不丢"的前提：
  只要重新拼装时 id 一模一样，`localStorage` 里那些作答记录就还认得这些题。
- 它是"以后能不能并进一册"的依据：文件在不在决定"能不能**准确**合并"（`jobs.js` 的 `mergeStatus:'chapter'`，
  与"只剩 HTML、只能反推"的 `'html'` 分开）。写入是**原子**的（先写 `.tmp` 再 rename），
  半截 JSON 不会被当成能用的数据。
- 写不进去**不拖垮这一单**：页面照常交付，只在结果里说清"这一章以后不能并进一册"。

### 7.4 两条来源：有旁挂数据 / 只有 HTML

- **有旁挂数据** → 精确重装配：把 `chapters[]` 直接喂回拼装器，零损失。
- **只有 HTML 文件** → 从成品页**反推**（`pipeline/revive.js`）。

**反推对不上就拒绝，不给错结构**（`revive()` 在 `ok:false` 时 `data` 一律为 `null`：
宁可让调用方拿到"什么都没有"，也不能让它拿到一份"看起来是好的"错结构）。已知的拒绝理由：

| 对不上的是哪一处 | 代码 |
|---|---|
| 单元数 ≠ 题库段数（一段题库对一个单元，对不上就无法确定哪段题属于哪一节） | `unit-bank-count-mismatch` |
| 题区编号缺号 / 重号 / 不从 0 起 | `qsec-sequence` |
| `data-lv` 与题区 id 里的编号不一致 | `qsec-lv-mismatch` |
| 题区标题行 / PAGE 配置解析不出（含 `PAGE.key` 拿不到） | `qsec-h2-unreadable`、`page-block-missing`、`pagekey-missing` |
| 某段题库 JSON 坏（尾逗号、漏引号 —— 正是引擎会静默吞掉整段的那种坏法） | `bank-json-invalid` |
| 页头 / 正文区 / 引擎 / 结算区缺失 | `header-missing`、`content-region-missing`、`engine-missing` |

- **能被反推的只限本工具生成的页面**：同时有 `script[data-bank]`、`id="engine"`、`id="result"`，
  并且带着拼装器注入的 CSP meta（那条 `<meta http-equiv="Content-Security-Policy"` 是"确实出自拼装器"最便宜的证据）。
  第三方 HTML 一律拒绝，不做"尽力而为"的结构猜测。
- 反推拿到的是**规范化之后**的结构：id 已带单元命名空间、`lv` 是拼装器写进去的、章号那个字段在旁挂格式里叫 `no`
  而拼装器要的是 `number`——喂回拼装器之前要过一层字段映射（`test/revive.js` 的往返段就是这么拼的）。

### 7.5 进度与跨 origin（这条不写清，用户会把它当成 bug）

- 做题进度存在浏览器本地的 `localStorage[PAGE.key]` 下，`PAGE.key` 就是册的存盘键（7.2 规则 3）。
- **三种打开方式的 `localStorage` 互不相通**：应用内预览走 `isg://local`、双击文件走 `file://`、
  起个本地服务器看走 `http://localhost`。这是浏览器的同源策略，**任何脚本都搬不过去**，
  不是页面缺了一段同步代码，也不是应用的缺陷（`pit 86`）。
- 而且 `file://` 在 Chromium 里是 **opaque origin**：`localStorage` 可能直接抛错，
  引擎自己就会走"存不住"的降级路径（顶栏写「进度无法保存」，`pit 57`）。
- 所以**不许承诺"进度一定在"**：要如实说明"换一种打开方式看不到之前的进度"。
  合并成一册只能保证**存盘键不变**（老章的记录还认它自己那些题），保证不了"换个入口还能看见"。
