# -*- coding: utf-8 -*-
"""把 assets 里的引擎 / CSS 同步进 page-skeleton.html 的内联副本（并检查两边有没有走散）。

为什么需要它：骨架页是**单文件交付**的起点，所以它把 quiz-engine.js 与 practice.css 内联在里面；
而这两份资产也是"给我查阅、给别的章节抄"的原文。两边一旦走散，就会出现
「改了资产、新章却还是老引擎」这种最难查的问题。这个脚本负责把方向定成 **assets → 骨架**：

    python assets/sync-skeleton.py            # 只检查，两边不一致就列出第一处差异并以 1 退出
    python assets/sync-skeleton.py --write    # 把资产写进骨架（会覆盖骨架里那两段内联副本）

改过资产的正常流程：改 `assets/quiz-engine.js` / `assets/practice.css` → 跑 `--write` → 再校验页面。
反过来（改的是某个跑通的章节页面、想更新资产）用 `refresh-assets.py`，别用这个。
"""
import io, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKEL = os.path.join(HERE, 'page-skeleton.html')
CSS = os.path.join(HERE, 'practice.css')
ENG = os.path.join(HERE, 'quiz-engine.js')

# 资产文件顶部那几行"说明性注释"不参与比对（它们是给读资产的人看的，不进页面）
CSS_HEAD = 1     # practice.css 第 1 行是注释
ENG_HEAD = 3     # quiz-engine.js 前 3 行是注释


def blocks(html):
    """取骨架页里参与同步的两段：第一个 style 块 与 script id=engine 块"""
    i = html.index('<style>')
    j = html.index('</style>', i)
    k = html.index('<script id="engine">')
    l = html.index('</script>', k)
    return (i + len('<style>'), j), (k + len('<script id="engine">'), l)


def first_diff(a, b):
    for n, (x, y) in enumerate(zip(a.split('\n'), b.split('\n')), 1):
        if x != y:
            return '第 %d 行：\n  骨架: %s\n  资产: %s' % (n, x[:120], y[:120])
    return '行数不同：骨架 %d 行 / 资产 %d 行' % (len(a.split('\n')), len(b.split('\n')))


def main():
    write = '--write' in sys.argv
    html = io.open(SKEL, encoding='utf-8').read()
    css = io.open(CSS, encoding='utf-8').read().split('\n', CSS_HEAD)[CSS_HEAD]
    eng = io.open(ENG, encoding='utf-8').read().split('\n', ENG_HEAD)[ENG_HEAD]
    (ci, cj), (ei, ej) = blocks(html)
    now_css, now_eng = html[ci:cj], html[ei:ej]

    bad = []
    if now_css != css:
        bad.append('CSS 不一致 —— ' + first_diff(now_css, css))
    if now_eng != eng:
        bad.append('引擎不一致 —— ' + first_diff(now_eng, eng))
    if '<div class="pet"' not in html:
        bad.append('骨架里没有陪练标记（<div class="pet"）——引擎会跳过它，但页面就永远没有陪练了')

    if not bad:
        print('OK: 骨架页内联副本与 assets 一致（CSS %d 字节 / 引擎 %d 字节）' % (len(css), len(eng)))
        return 0
    if not write:
        print('不一致：')
        for b in bad:
            print(' -', b)
        print('跑 python assets/sync-skeleton.py --write 把资产写进骨架')
        return 1

    html = html[:ci] + css + html[cj:]
    (ci, cj), (ei, ej) = blocks(html)          # 前一段变长后重新定位
    html = html[:ei] + eng + html[ej:]
    io.open(SKEL, 'w', encoding='utf-8').write(html)
    print('已同步：CSS %d 字节 / 引擎 %d 字节 -> page-skeleton.html（共 %d 字节）'
          % (len(css), len(eng), len(html)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
