# 与手册合体 + 无头校验配方

## 一、把《拆解手册》和练习册合成"讲练一体"单页

**思路：以手册的 body 为骨架，把练习册的东西插到对应位置。** 手册本来就是"讲解 + 表格 + 图"的长文，插完就是一页到底。

### 取块工具（别用正则硬匹配嵌套 div）

```python
def take_block(h, marker, tag='div'):
    """取出从 marker 开始、配对闭合的那一块，返回 (块, 剩下的HTML)"""
    i = h.index(marker)
    o, c = re.compile(r'<%s\b' % tag), re.compile(r'</%s>' % tag)
    depth, j = 0, i
    while True:
        mo, mc = o.search(h, j), c.search(h, j)
        if mo is not None and mo.start() < mc.start():
            depth += 1; j = mo.end()
        else:
            depth -= 1; j = mc.end()
            if depth == 0: return h[i:j], h[:i] + h[j:]
```

用 `take_block` 从练习册里取出：吸顶条 `'<div class="bar">'`、三个演示 `'<div class="demo" id="demoA">'`、结算区 `'<section id="result">'`（tag 传 `section`）、陪练 `'<div class="pet"'`、以及最后那段题库+引擎脚本（从 `'<script data-bank'` 到结尾）。

### 定位插入点：用"关键词 + 往前找标签开头"

**不要**拿带引号的标题当锚点——文件里的引号可能是全角、直引号或别的码位，匹配会失败（实测踩过）。

```python
def before_tag(h, needle, blk, tag='<h3>'):
    assert h.count(needle) == 1, '关键词不唯一：' + needle
    i = h.index(needle); j = h.rindex(tag, 0, i)
    return h[:j] + blk + h[j:]
```

手册里的可靠锚点：章节分节注释 `<!-- ================= 13.1 ================= -->`、`<h3>知识块 N · 关键词`、`<section id="sheet">`、`  <footer>`。**每个锚点都 `assert count == 1`**，对不上立刻报错，别让它静默插错位置。

### 插哪些、插哪里（ch13 的成品布局，照着套）

| 插什么 | 插在哪 |
|---|---|
| 热身题区 `lv0` | 第一节讲之前（全章地图之后） |
| 演示 A/B/C | 各自对应的知识点 `<h3>` 之前（13.1 / 例 13.1 之后 / 13.3 磁滞回线之后） |
| 练一练题区 `lv1…lvN` | 各自单元最后一小节结束处（下一个 `<section id="sXXX">` 之前） |
| 综合大题 `lvN+1` + 结算区 `#result` | `  <footer>` 之前 |

题区模板（只有宿主，题目由引擎填）：

```html
<section class="qsec" id="p-l3">
  <h2><span class="num">练</span>练一练 · 例题与习题：动手算<span class="cnt" data-cnt="3"></span></h2>
  <p class="lede">有数字要算，先自己动笔，再对答案。</p>
  <div class="qlist" data-lv="3"></div>
</section>
```

另外三件小事：
- 手册的目录 `<ol>` 里补上题区条目（`<li><a href="#p-l3">└ 练一练（例题·习题）</a></li>`），一份目录就能看出讲练节奏。
- 手册页头的 `.facts` 里加一格 `<div><b>72</b><span>个作答点</span></div>`。
- 手册的 `#howto` 里加一段「这一页怎么用」：讲完紧跟题、最后是综合大题，不用切页。

### CSS 合并

直接按「手册 CSS → 练习册 CSS → 合并层 CSS」顺序拼。练习册 CSS 在后 → 全套 token 变成练习册那套配色（手册一起变，可接受）。合并层只补少量：

```css
.qsec{margin-top:56px}
.cnt{font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--ink-3);margin-left:10px;vertical-align:2px}
.bar{top:0}                        /* 吸顶进度条 */
@media (min-width:1000px){ nav.toc{top:48px} }   /* 手册目录给吸顶条让位 */
section{scroll-margin-top:58px}
```

手册那份文件**省略了 `</head>` 和 `<body>`**（浏览器容错），抽正文要退回「最后一个 `</style>` 之后到 `</body>`」。两份文件有同名 id（都用 `howto`）要先改名。

## 二、无头校验配方（Windows / Edge）

### 1. 注入探针 —— 用脚本，别手工贴

```bash
SK="<你的项目>/.claude/skills/interactive-study-guide"
python "$SK/assets/inject-probe.py" "页面.html" verify-probe.js demo-probe.js   # 没有演示就只给 verify-probe.js
# 它会：head 插错误收集器 + 把每个探针各包一层 script 标签插到 </body> 前
#       + 输出到**同目录**的 _probe_页面.html + 打印现成的 msedge 命令
```

**为什么必须用脚本**：手工贴探针有两个必踩的坑——忘了包 script 标签（JS 变页面可见文字、不执行）、探针正文里出现字面的 script 结束标签（解析器提前关闭脚本，后面全废）。两个子代理都在第一个坑上白烧了一轮；注入器里带了检查，第二类问题直接拒绝。

### 2. 跑

```bash
E="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
T="${TEMP:-/tmp}"                     # Windows Git Bash 下 $TEMP 已经是可用的路径
"$E" --headless=new --disable-gpu --no-sandbox --user-data-dir="$T\\prof_新目录" \
     --virtual-time-budget=16000 --dump-dom "file:///C:/…/_probe_页面.html" > dom.html
grep -o '<title>[^<]*</title>' dom.html      # 结果都在这行里
```

要点：
- **每次换一个 `--user-data-dir`**，否则连续调用会复用进程、结果串味；也避免上次的 localStorage 让题目处于已答状态。
- **探针副本必须与被测页同目录**（注入器已经保证）——跨目录时相对路径的图片加载失败，会把"陪练/背景"误报成没有。
- 探针结果**写进 `document.title`**：同步部分一定拿得到；**异步项（图片）要轮询**，验证脚本里已用 `setTimeout` 轮询（`setTimeout` 在 `--virtual-time-budget` 下是会跑的；真正不可靠的是 `load` 事件和长链回调，别把结论押在它上面）。
- 控制台是 GBK：**中文/✓ 直接 print 会 UnicodeEncodeError**，结果写文件再读。
- 别在探针 JS 里写含 `\n` 的正则（Python 转义会变成真换行 → JS 语法错误 → 整段不执行，表现是"什么都没发生"）。
- **不要拿 `for` 循环连续跑两次 msedge**（Windows 上遇到过 0 字节输出）；一次一条命令，或分开调用。
- `--virtual-time-budget` 给 **22000**（有陪练的页面要等图片异步定性，16000 会不够；探针里最长的那条链是
  「轮询 40×250ms + 交互 + 跟随 1200ms」）。
- 页面里写了 `⟨script src="pet-lines.js"⟩` 但文件不在 → 浏览器会**资源加载失败**。早先它会被记成
  `脚本错误=?@0`（误报）；现在注入器的收集器只收真 ErrorEvent，这类 404 不再污染"脚本错误=无"。

### 3. 十一项必查（一项不过就不算完成）

`verify-probe.js` 会自动报出前七项，你只要核对数字：

1. **题库条目数**（= 单题数 + 大题 `parts` 数）——这就是「作答点数」。
   ⚠️ **不要拿它去比页面上的题卡数**：一道大题渲染成**一张卡**，卡里含多个作答点，
   所以含大题的关卡上"作答点数 > 题卡数"是正常的（2 道大题 / 6 个 parts → `.cnt` 是 `6/6`、`.q` 只有 2 张）。
   题卡该不该存在，看第 2 条。
2. **缺卡=0**：每个**作答点**都有对应元素（`q-<id>`，大题的每一步是 `q-<大题id>-<步号>`）。
3. **自动作答后判错=0、抛错=0**：探针按题库里的正确答案把每道题都做了一遍。
4. **写法容错**：填数题"带单位""科学计数法"两种写法都判对。
5. **进度/计数**：顶部 `已作答 = 总数`、各关 `.cnt` 的分母 == 该关**作答点数**（不是题卡数）、
   **结算关卡名**是从页面推导出来的（打印出来核对有没有取错标题）。
   ⚠️ **补一条必须做的：在 `load` 之后（不是探针那一刻）再读一次 `#s-total`，与题库的作答点总数对一遍。**
   探针插在 `</body>` 前、赶在 `DOMContentLoaded` 之前执行，而**引擎的题库二次扫描发生在
   `DOMContentLoaded`**——真有页面因此把题库渲染了两遍（题卡与总数一起翻倍），
   而探针在那一刻看到的还是对的。骨架页自己中过这个招，见 `pitfalls.md` 第 50 条。
6. **重做本题**能把卡片复位成未答。
7. **脚本错误=无**。
8. **演示**（有演示时）：`demo-probe.js` 打印每个滑块在 min/mid/max 的读数——**拿公式手算核对**；再看 `SVG 越界元素=0`。
9. **陪练（有陪练时，`pet-probe.js` 报）**：同目录**没有**图片的页面 → `陪练形象=无`、`形象占位=0px`、
   `display=none`、开关=「没放图」、点开关的气泡里有两条路；**有**图片的页面 → `陪练形象=同目录图片`、
   拖动有位移且存盘、双击换模式、右键菜单按钮数对、形象能切回图片、跟随模式位移 > 0。
   **三种页面都要跑**：没图的、有图的、预置了 `petArt:'fish'` 的（没图那页跑不了有图的分支，别只跑一种就下结论）。
   还要额外量一次**气泡宽度**（长台词下应约 230px，不是细长条）——这条探针量不出来。
   如果这一轮动过陪练，再补一组"残缺页"：把 `#pet` 整块删掉、把它挪到引擎脚本之后、把 `#petFig` 删掉，
   每种都跑一遍，确认**题库/进度/结算没被连累**（历史上这里出过"引擎静默中断、进度显示 0/0"）。
10. **台词覆盖（改过台词才查）**：`pet-probe.js` 的 `【陪练·跟随】在用台词 right=… empty=… hint=…`
   打印的是引擎**实际在用**的那几句，拿它跟你写的对一遍；页面里也能用控制台 `__PET__.lines` 看。
11. **截图**：浅色 + 深色各一张，看叠字/压线/裁切，**陪练形象有没有被裁、气泡有没有出屏也在这一条里看**。
   **这条不能省**（ch14 的曲线面板做窄了、滑块拉到最大时工作点标签被裁，就是靠截图才发现的）。

### 平板 / 手机矩阵（动过样式就过一遍）

```bash
E="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
FLAGS="--blink-settings=primaryPointerType=2,availablePointerTypes=2,primaryHoverType=1,availableHoverTypes=1"  # 模拟触摸
for 尺寸 in 820,1180 1180,820 800,1280 507,1000 520,900; do ...   # 每种一次 msedge，别 for 循环连跑
```
要看的四件事：**横向溢出**（`documentElement.scrollWidth > innerWidth` 就是版式被撑破）、
**触摸目标 ≥40px**（顶栏按钮 / chips / 题卡小按钮 / `.btn` / 陪练菜单项 / 滑块）、
**弹出层在视口内**、以及 `matchMedia('(pointer:coarse)')` 是否真的是 true（不是的话量到的全是鼠标尺寸）。

### 视觉校验

- 想只看某一段：做一份临时副本，在 `</head>` 前插 `<style>#id1,#id2{display:none!important}</style>` 把别的藏起来（比截图滚动可靠）。截图前别忘了 `--window-size=1100,1500`。
- 想截"已经选定内置大肥鱼"的页面：在 `<script id="engine">` **之前**插一段
  `<script>localStorage.setItem('存盘键',JSON.stringify({pts:{},ui:{pet:true,petArt:'fish'}}))</script>`
  （每次跑无头都要新 `--user-data-dir`，否则 localStorage 留着上一轮的进度）。
- 浅色主题：临时副本里把 `<html lang="zh-CN">` 改成 `<html lang="zh-CN" data-theme="light">`。
- 画图的自洽性（叉乘方向、三维可行性、刻度对齐）见 `demo-guide.md` 第二节的硬约定与自查清单。

## 三、收尾

删掉所有探针页、截图、临时脚本（**只删明确列出的文件名，不要对 %TEMP% 用通配符**），项目目录里只留交付的 HTML 和用户放的图片。
