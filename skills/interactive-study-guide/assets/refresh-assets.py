# -*- coding: utf-8 -*-
"""从一份"跑通过"的练习页里，重新抽出 skill 的资产（引擎 / CSS / 演示示例 / 骨架页）。

什么时候用：你手改过某个**章节的练习页**（改了引擎或样式），想让 skill 的资产跟着更新。
反方向（改的是 assets/ 原文、要把骨架页的内联副本也更新）用 `sync-skeleton.py`，别用这个。
用法：改下面 SRC / SK 两个路径，然后 python refresh-assets.py
注意：它会用下面的模板重建 page-skeleton.html；模板里的陪练标记/页脚文案要保持和
      `assets/sync-skeleton.py` 的期望一致，两个脚本都认「第一个 style 块 + script id=engine」。
"""
import io, os, re

# 改成你自己的两个路径：SRC = 一份"跑通过"的章节页；SK = 本 skill 的目录
SRC = r"C:\path\to\your\chapter-page.html"
SK  = r"C:\path\to\skills\interactive-study-guide"

os.makedirs(SK + r"\assets", exist_ok=True)
h = io.open(SRC, encoding='utf-8').read()

def take_block(s, marker, tag='div'):
    i = s.index(marker)
    o, c = re.compile(r'<%s\b' % tag), re.compile(r'</%s>' % tag)
    depth, j = 0, i
    while True:
        mo, mc = o.search(s, j), c.search(s, j)
        if mo is not None and mo.start() < mc.start():
            depth += 1; j = mo.end()
        else:
            depth -= 1; j = mc.end()
            if depth == 0: return s[i:j]

css = re.search(r'<style>(.*?)</style>', h, re.S).group(1)
eng = re.search(r'<script id="engine">(.*?)</script>', h, re.S).group(1)

DEMO_MARK = ('  /* ================= 章专用演示：把本章的演示 IIFE 放在这里 =================\n'
             '     每个演示都用 try{ ... }catch(e){console.error(...)} 包住，坏了不连累别的；\n'
             '     演示的 DOM 直接写在正文对应知识点旁边（建议 <div class="demo" id="demoA">…</div>），\n'
             '     JS 只按 id 取元素、按公式现算现画。示例见 assets/demos-example.js。 */\n')
i, j = eng.index('/* ---------------- 演示 1'), eng.index('/* ---------------- 收尾')
demos, generic = eng[i:j], eng[:i] + DEMO_MARK + eng[j:]

io.open(SK + r"\assets\quiz-engine.js", 'w', encoding='utf-8').write(
    "/* 可交互练习册引擎（通用部分，含陪练形象与背景图的自动识别）。\n"
    "   由 assets/refresh-assets.py 从跑通的页面抽出，别手改这里——改源页面再重抽。\n"
    "   题库用若干 <script data-bank type=\"application/json\">[…]</script> 提供，字段见 references/quiz-engine.md。 */\n"
    + generic)
io.open(SK + r"\assets\demos-example.js", 'w', encoding='utf-8').write(
    "/* 三个「可拖滑块演示」的完整写法（ch13 实例，可改成别的章）。\n"
    "   读数与曲线都由公式现场算出来画，所以数据与图永远自洽；刻度坐标也要 JS 算，别写死。 */\n" + demos)
io.open(SK + r"\assets\practice.css", 'w', encoding='utf-8').write(
    "/* 讲练一体页的样式（深浅色 token、题卡、选项反馈、演示台、吸顶条、陪练、背景层）。 */\n" + css)

# ---- 骨架页：用页面里真实可用的标记拼一个最小可跑版本 ----
bar    = take_block(h, '<div class="bar">')
pet    = take_block(h, '<div class="pet"', 'div')
result = take_block(h, '<section id="result">', 'section')

BANK = '''[
  {"id":"s-1","type":"single","lv":0,
   "stem":"（示例单选题）这一章最后要用来判断「磁场强不强」的量是哪个？",
   "opts":[
     {"t":"B（磁感应强度）","ok":true,"why":"对。决定受力与强弱的是 B。"},
     {"t":"H（磁场强度）","ok":false,"why":"名字骗人——H 只是为了好算而引入的辅助量。"}
   ],
   "hint":"想想谁出现在 F = qv×B 里。",
   "ref":{"h":"#guide-anchor","t":"回手册 · 对应小节"}},

  {"id":"s-2","type":"num","lv":0,"unit":"A/m","ans":200,"tol":3,
   "stem":"（示例填数题）螺线管 n = 2000 匝/m，电流 I = 0.10 A，求管内 H。",
   "hint":"H = nI —— 这一步与介质无关。",
   "sol":"H = nI = 2000 × 0.10 = 200 A/m。"}
]'''

PAGE = '''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>第 XX 章 · 讲练一体（骨架示例）</title>
<!-- 不引外部字体：字体栈里已有本机回退（iPad 上是苹方），这样离线/查看器里打开零外部请求 -->
<style>__CSS__</style>
<style>
  /* 讲练一体页的合并层：题区、计数、吸顶条让位 */
  .qsec{margin-top:56px}
  .cnt{font-family:var(--font-mono);font-size:13px;font-weight:600;color:var(--ink-3);margin-left:10px;vertical-align:2px}
  .bar{top:0}
  section{scroll-margin-top:calc(var(--barh,58px) + 8px)}
</style>
</head>
<body>

<noscript><p style="margin:0;padding:14px 18px;background:var(--warn-soft);color:var(--warn)">
这个页面需要 JavaScript：题目、判分与演示都是现场生成的。请用 Safari / Chrome 等浏览器打开，别用系统文件预览。</p></noscript>

<div class="bgimg" id="bgimg" aria-hidden="true"></div>

__PET__

<header class="top"><div class="top-inner">
  <span class="eyebrow">大学物理学 · 第 XX 章 · 讲练一体</span>
  <h1>（章标题）</h1>
  <p class="sub">上面讲解、下面就是题；每个小节讲完紧跟着这一节的练习。</p>
  <div class="facts">
    <div><b>N</b><span>个作答点</span></div>
  </div>
</div></header>

__BAR__

<div class="shell">
<main>

  <!-- 讲：知识块写在这里（从《拆解手册》整节搬过来即可） -->
  <section id="guide-anchor">
    <h2><span class="num">XX.1</span>（小节标题）</h2>
    <p class="lede">（这一节的正文……）</p>
  </section>

  <!-- 练：紧跟在这一节后面 -->
  <section class="qsec" id="p-l0">
    <h2><span class="num">练</span>练一练 · 本节 <span class="cnt" data-cnt="0"></span></h2>
    <p class="lede">刚看完就做，趁热。点选项/填数值立刻判分，错了会逐项告诉你错在哪。</p>
    <div class="qlist" data-lv="0"></div>
  </section>

  __RESULT__

  <footer><p style="margin-bottom:0">骨架示例：样式与引擎已就位，换成这一章的正文与题库即可。右下角那个陪练要<b>同目录有图片</b>（pet.png 等）才出现，也可以右键把它切成内置的大肥鱼；两个都没有就什么都不显示。</p></footer>
</main>
</div>

<script data-bank id="bank0" type="application/json">__BANK__</script>

<script id="engine">__ENGINE__</script>
</body>
</html>
'''

page = (PAGE.replace('__CSS__', css).replace('__PET__', pet).replace('__BAR__', bar)
            .replace('__RESULT__', result).replace('__BANK__', BANK).replace('__ENGINE__', generic))
io.open(SK + r"\assets\page-skeleton.html", 'w', encoding='utf-8').write(page)

print('quiz-engine.js :', len(generic), '字节')
print('demos-example.js:', len(demos), '字节')
print('practice.css   :', len(css), '字节')
print('page-skeleton  :', len(page), '字节')
print('引擎里残留的章专用 id：', [x for x in ['dA-', 'dB-', 'dC-', 'demoA'] if x in generic.replace('id="demoA"', '')])
