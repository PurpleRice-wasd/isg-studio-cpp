# -*- coding: utf-8 -*-
"""把探针脚本安全地注入被测页，生成一份可跑的无头校验副本。

用法：
    python inject-probe.py 被测页.html                       # 只注入 verify-probe.js
    python inject-probe.py 被测页.html demo-probe.js         # 再追加一个探针
    python inject-probe.py 被测页.html --out _check.html

做的事：
    1. 在 <head> 最前面插一段**错误收集器**（把脚本报错攒进 window.__PROBE_ERRS__）；
    2. 在 </body> 之前，把每个探针脚本**各自包一层 script 标签**再插进去；
    3. 输出到**同一个目录**（名字默认 _probe_原文件名）——必须同目录，否则页面里相对路径
       引用的图片会加载失败，探针会把"陪练/背景图"误报成"没有"。

为什么要有这个脚本（血的教训）：
    · 直接把自己写的 JS 贴进 HTML 而不包 script 标签 → 那段 JS 变成页面上可见的文字、
      完全不执行，表现是"探针好像坏了 / 页面好像坏了"，白排查一轮；
    · 探针正文里若出现**字面的结束标签**（斜杠 + script + 右尖括号），HTML 解析器会在
      那里提前关闭脚本，后面的代码全部失效 —— 本脚本会先检查并报错，不让你踩第二次。
"""
import io, os, re, sys


def check_no_script_tags(text, path):
    """探针正文里绝不能出现 script 的开/闭标签（会被 HTML 解析器截断）"""
    bad = re.findall(r'<\s*/?\s*script', text, re.I)
    if bad:
        raise SystemExit('[错误] %s 的正文里出现了 script 标签字样（%d 处）——'
                         '写注释时请用 ⟨⟩ 代替尖括号，或把标签名拆开写。' % (path, len(bad)))


def inject(page_path, probes, out_name=None):
    h = io.open(page_path, encoding='utf-8').read()

    # 只记真正的脚本错误：e.message 存在才是 ErrorEvent。资源加载失败（图片/脚本 404）
    # 也会冒 error 事件，但它们没有 message，混进来会让"脚本错误=无"这条误报（踩过）。
    collector = ('<script>window.__PROBE_ERRS__=[];window.addEventListener("error",function(e){'
                 'if(e&&e.message)window.__PROBE_ERRS__.push(e.message+"@"+(e.lineno||0));},true);</script>')
    if '<meta charset="utf-8">' in h:
        h = h.replace('<meta charset="utf-8">', '<meta charset="utf-8">' + collector, 1)
    else:
        h = h.replace('<head>', '<head>' + collector, 1)

    assert h.count('</body>') == 1, '页面里 </body> 不唯一，先人工确认结构'
    blk = ''
    for p in probes:
        js = io.open(p, encoding='utf-8').read()
        check_no_script_tags(js, p)
        blk += '\n<script>\n' + js + '\n</script>\n'
    h = h.replace('</body>', blk + '</body>', 1)

    d, base = os.path.split(os.path.abspath(page_path))
    out = os.path.join(d, out_name or ('_probe_' + base))
    io.open(out, 'w', encoding='utf-8').write(h)
    print('[OK] 生成', out)   # 控制台是 GBK：别打印 ✓ / emoji
    print('   跑：msedge --headless=new --disable-gpu --no-sandbox \\')
    print('        --user-data-dir=%TEMP%\\probe_新目录 --virtual-time-budget=16000 \\')
    print('        --dump-dom "file:///%s" | grep "<title>"' % out.replace('\\', '/'))
    return out


if __name__ == '__main__':
    args = [a for a in sys.argv[1:]]
    if not args:
        raise SystemExit(__doc__)
    here = os.path.dirname(os.path.abspath(__file__))
    out_name = None
    if '--out' in args:
        i = args.index('--out')
        out_name = args[i + 1]
        del args[i:i + 2]
    page = args[0]
    probes = args[1:] or [os.path.join(here, 'verify-probe.js')]
    probes = [p if os.path.isabs(p) else os.path.join(here, p) for p in probes]
    inject(page, probes, out_name)
