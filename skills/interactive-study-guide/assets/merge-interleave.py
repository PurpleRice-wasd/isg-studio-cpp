# -*- coding: utf-8 -*-
"""把《拆解手册》与练习册合成「讲练一体」单页（ch13 跑通的脚本，改 CONFIG 即可换章）。

用法：python merge-interleave.py
输出：CFG['out']，一份仍可双击打开的单页 HTML。
"""
import io, re

# ==================== 每章要改的配置 ====================
CFG = dict(
    # 三个路径改成你自己的：讲解页（手册）、练习页、输出文件
    guide    = r"C:\path\to\your\chapter-guide.html",
    practice = r"C:\path\to\your\chapter-practice.html",
    out      = r"C:\path\to\your\chapter-full.html",
    title    = "磁介质 · 讲练一体（第 13 章）",

    # 题区：lv, 标题, 导语, 定位方式（before=注释锚点 / h3=关键词往前找 <h3>）, 锚点
    qsecs = [
        (0, "热身 3 题：先对上频道",
            "三题，做错了也不要紧，它们只是把这一章的重心摆正。点选项就判分，错了会告诉你错在哪儿。",
            "before", "  <!-- ================= 13.1 ================= -->"),
        (1, "练一练 · 13.1 的题",
            "刚看完磁化、三类介质、磁化电流，趁热做。做错了先看「思路提示」，再看解析。",
            "before", "  <!-- ================= 13.2 ================= -->"),
        (2, "练一练 · 13.2 前半：H 是怎么被逼出来的",
            "这一段的题几乎就是这一章的心脏——消元那三步、H 的真实身份、三条物性关系。",
            "h3", "知识块 6 · 例题 13.1"),
        (3, "练一练 · 例题与习题：动手算",
            "螺线管、螺绕环、同轴电缆、矩磁翻转。有数字要算，先自己动笔，再对答案。",
            "before", "  <!-- ================= 13.3 ================= -->"),
        (4, "练一练 · 13.3 铁磁质",
            "不算题，考的是你能不能分清 B_s、B_r、H_c，以及三类材料该用在哪。",
            "before", "  <!-- ================= SHEET ================= -->"),
        (5, "综合大题：四道，一步一问",
            "把整章串起来的四道题（螺线管、同轴电缆、螺绕环、矩磁磁芯），每道拆成几小步，一步一判。",
            "before", "  <footer>"),
    ],

    # 三个演示插到哪：演示 id, 定位方式, 锚点
    demos = [
        ("demoA", "h3", "知识块 3 · 顺磁质为什么会被"),
        ("demoB", "h3", "知识块 7 · 例题 13.2"),
        ("demoC", "h3", "知识块 4 · 三类铁磁材料"),
    ],

    # 手册目录里补的条目：(原条目, 追加的条目)
    toc = [
        ('<li><a href="#map">全章地图</a></li>',
         '<li><a href="#p-l0">└ 热身 3 题</a></li>'),
        ('<li><a href="#s131">13.1 磁介质的磁化</a></li>',
         '<li><a href="#p-l1">└ 练一练（13.1）</a></li>'),
        ('<li><a href="#s132">13.2 H 与两条定理</a></li>',
         '<li><a href="#p-l2">└ 练一练（13.2 前半）</a></li><li><a href="#p-l3">└ 练一练（例题·习题）</a></li>'),
        ('<li><a href="#s133">13.3 铁磁质</a></li>',
         '<li><a href="#p-l4">└ 练一练（13.3）</a></li>'),
        ('<li><a href="#check">自测清单</a></li>',
         '<li><a href="#p-l5">└ 综合大题</a></li><li><a href="#result">学习结算</a></li>'),
    ],

    facts_anchor = '<div><b>14</b><span>条常见陷阱</span></div>',
    facts_add    = '<div><b>72</b><span>个作答点</span></div>',

    howto_anchor = '    <h2>怎么用这份手册</h2>',
    howto_add    = '''
    <div class="tip">
      <span class="h">这一页怎么用</span>
      <p>讲解和练习已经在同一页里了：<strong>每个小节讲完，紧跟着就是这一节的题</strong>，点选项或填数值立刻判分，错了会逐项告诉你错在哪儿（想不出来先点「思路提示」）。中间还插了三处可以拖滑块的演示。一直往下走，最后是<strong>四道综合大题</strong>和一张学习结算表——不用切页面，往前翻直接滚。</p>
    </div>
''',
)
# =======================================================

def style(h): return re.search(r'<style>(.*?)</style>', h, re.S).group(1)

def body(h):
    m = re.search(r'<body[^>]*>(.*)</body>', h, re.S)
    if m: return m.group(1)
    # 手册那份省略了 </head> 与 <body>（浏览器容错）
    return h[h.rindex('</style>') + len('</style>'):h.rindex('</body>')]

def take_block(h, marker, tag='div'):
    """取出从 marker 开始、配对闭合的那一块，返回 (块, 剩余HTML)"""
    i = h.index(marker)
    o, c = re.compile(r'<%s\b' % tag), re.compile(r'</%s>' % tag)
    depth, j = 0, i
    while True:
        mo, mc = o.search(h, j), c.search(h, j)
        if mc is None: raise ValueError('没有闭合标签：' + marker)
        if mo is not None and mo.start() < mc.start():
            depth += 1; j = mo.end()
        else:
            depth -= 1; j = mc.end()
            if depth == 0: return h[i:j], h[:i] + h[j:]

g = io.open(CFG['guide'], encoding='utf-8').read()
p = io.open(CFG['practice'], encoding='utf-8').read()
css_g, css_p = style(g), style(p)
bd_g, bd_p = body(g), body(p)

# --- 从练习册里取出要搬走的块 ---
bar,       bd_p = take_block(bd_p, '<div class="bar">')
demos          = {}
for did, _, _ in CFG['demos']:
    demos[did], bd_p = take_block(bd_p, '<div class="demo" id="%s">' % did)
resultSec, bd_p = take_block(bd_p, '<section id="result">', 'section')
pet,       bd_p = take_block(bd_p, '<div class="pet"', 'div')

# 练习册页脚里关于陪练图片的那段，搬到合成页的页脚
petnote = ''
m = re.search(r'<p style="margin-bottom:0">右下角的陪练.*?</p>', bd_p, re.S)
if m: petnote = m.group(0)

scripts = bd_p[bd_p.index('<script data-bank'):]     # 题库 + 引擎

# --- 工具：定位插入 ---
def before(h, anchor, blk):
    assert h.count(anchor) == 1, '锚点不唯一或不存在：' + anchor[:40]
    return h.replace(anchor, blk + anchor, 1)

def before_tag(h, needle, blk, tag='<h3>'):
    assert h.count(needle) == 1, '关键词不唯一或不存在：' + needle[:40]
    i = h.index(needle)
    return h[:h.rindex(tag, 0, i)] + blk + h[h.rindex(tag, 0, i):]

def qsec(lv, title, sub):
    return ('''
  <!-- ===== 题区 L%d ===== -->
  <section class="qsec" id="p-l%d">
    <h2><span class="num">练</span>%s<span class="cnt" data-cnt="%d"></span></h2>
    <p class="lede">%s</p>
    <div class="qlist" data-lv="%d" id="ql%d"></div>
  </section>
''' % (lv, lv, title, lv, sub, lv, lv))

# --- 插题区 ---
qblocks = {lv: qsec(lv, t, s) for lv, t, s, _, _ in CFG['qsecs']}
for lv, t, s, how, anchor in CFG['qsecs']:
    blk = qblocks[lv]
    if lv == 5:      # 综合大题与结算一起放最后
        blk += resultSec.replace('<h2><span class="num">✓</span>你现在到哪儿了</h2>',
                                 '<h2><span class="num">✓</span>学习结算：你现在到哪儿了</h2>')
    if how == 'h3':
        bd_g = before_tag(bd_g, anchor, blk)
    else:
        bd_g = before(bd_g, anchor, blk)

# --- 插演示 ---
for did, how, anchor in CFG['demos']:
    bd_g = before_tag(bd_g, anchor, demos[did]) if how == 'h3' else before(bd_g, anchor, demos[did])

# --- 页头计数、说明书、目录 ---
if CFG.get('facts_add'):
    assert bd_g.count(CFG['facts_anchor']) == 1
    bd_g = bd_g.replace(CFG['facts_anchor'], CFG['facts_anchor'] + '\n      ' + CFG['facts_add'], 1)
if CFG.get('howto_add'):
    bd_g = bd_g.replace(CFG['howto_anchor'], CFG['howto_anchor'] + '\n' + CFG['howto_add'], 1)
for a, b in CFG['toc']:
    assert bd_g.count(a) == 1, '目录锚点不唯一：' + a
    bd_g = bd_g.replace(a, a + b, 1)

# --- 吸顶进度条插到页头下面；页脚补陪练说明 ---
assert bd_g.count('</header>') == 1
bd_g = bd_g.replace('</header>', '</header>\n\n' + bar, 1)
if petnote:
    bd_g = bd_g.replace('</footer>', '    ' + petnote.strip() + '\n</footer>', 1)

MERGE_CSS = """
  /* ================= 合并层：一页到底 ================= */
  .qsec{margin-top:56px}
  .qsec h2{font-size:clamp(20px,2.5vw,26px)}
  .cnt{font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--ink-3);margin-left:10px;vertical-align:2px}
  .qsec > .lede{margin-bottom:6px}
  .bar{top:0}
  @media (min-width:1000px){ nav.toc{top:48px} }
  section{scroll-margin-top:58px}
  nav.toc a{scroll-margin-top:58px}
  .nojs{margin:0;padding:14px 18px;background:var(--warn-soft);color:var(--warn);
        border-bottom:1px solid var(--warn);font-size:14.5px;line-height:1.7}
"""

DOC = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>__TITLE__</title>
<!-- 不引外部字体：字体栈里已有本机回退（iPad 上是苹方），这样离线/查看器里打开零外部请求 -->
<style id="css-guide">__CSS_G__</style>
<style id="css-practice">__CSS_P__</style>
<style id="css-merge">__CSS_M__</style>
</head>
<body>

<noscript>
  <p class="nojs"><strong>这个页面需要 JavaScript。</strong>讲解部分是纯文字，但题目、判分和三个演示都是网页现场生成的。
  如果你只看到讲解、题目位置是空的，说明打开它的程序不跑 JS（例如系统自带的文件预览）——请改用 Safari、Chrome，或用「Documents」这类支持本地网页的 App 打开。</p>
</noscript>

<div class="bgimg" id="bgimg" aria-hidden="true"></div>

__PET__

__BODY_G__

__SCRIPTS__
</body>
</html>
"""

doc = (DOC.replace('__TITLE__', CFG['title'])
          .replace('__CSS_G__', css_g).replace('__CSS_P__', css_p).replace('__CSS_M__', MERGE_CSS)
          .replace('__PET__', pet).replace('__BODY_G__', bd_g.strip()).replace('__SCRIPTS__', scripts))

io.open(CFG['out'], 'w', encoding='utf-8').write(doc)
print('写出:', CFG['out'], len(doc), 'bytes')
