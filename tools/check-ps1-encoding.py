# -*- coding: utf-8 -*-
"""确保本工程的 .ps1 都带 UTF-8 BOM。用法：

    python tools/check-ps1-encoding.py           # 只检查，不通过则退出码 1
    python tools/check-ps1-encoding.py --write   # 缺 BOM 的补上

为什么必须有这么个脚本（而不是靠记性）：

    Windows PowerShell 5.1 对**无 BOM** 的 .ps1 按系统代码页解码（这台机器是 936）。
    于是文件里的中文注释会被解成乱码，**解析器随后在乱码上崩掉**，报出来的却是一堆
    语法错误——`||` 不是合法的语句分隔符、字符串少了结束引号、try 少了 catch……
    每一条都指向错误的方向，真正的原因是编码。

    这个坑在本工程里踩过一次，而且它**会复发**：编辑工具在改写文件时通常不保留 BOM，
    所以"加过一次 BOM"并不等于"以后一直有"。既然规则会被无声打破，就得有东西去查它——
    这跟本工程 `sync-skeleton.py` 默认只检查、`--write` 才写入是同一个套路。

为什么用 Python 而不是 PowerShell 来查：这个脚本自己要是 .ps1，它就会掉进同一个坑。
"""
import sys
import pathlib

BOM = b'\xef\xbb\xbf'
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    write = '--write' in sys.argv
    files = sorted(p for p in ROOT.rglob('*.ps1') if 'build' not in p.parts)
    missing = []
    for p in files:
        raw = p.read_bytes()
        if raw.startswith(BOM):
            continue
        missing.append(p)
        if write:
            p.write_bytes(BOM + raw)
    if not files:
        print('[警告] 一个 .ps1 都没找到，检查范围是不是错了？')
        return 0
    if missing:
        verb = '已补' if write else '缺'
        print('[FAIL] %d 个 .ps1 %s UTF-8 BOM：' % (len(missing), verb))
        for p in missing:
            print('   ', p.relative_to(ROOT))
        if not write:
            print('   修：python tools/check-ps1-encoding.py --write')
        return 0 if write else 1
    print('[OK] %d 个 .ps1 都带 UTF-8 BOM' % len(files))
    return 0


if __name__ == '__main__':
    sys.exit(main())
