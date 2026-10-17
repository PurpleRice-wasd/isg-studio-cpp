#!/usr/bin/env python3
"""起一个本地假模型/故障服务，跑一项需要窗口的自测，然后把它收掉。

为什么单独一个脚本：
  · 这些自测要连本地 HTTP 服务，而服务端口是系统分配的 —— 必须从服务进程的
    stdout 读回端口，不能写死；
  · 服务进程不能留在机器上（验证脚本会反复跑）；
  · Windows 上 `& exe` 不等 GUI 程序，必须用 subprocess 等退出码。

用法（由 tools/phase1-verify.ps1 调用，也可手工跑）：
  python -I tools/run-mock-selftest.py --selftest=pipeline-mock \
      --exe build2\\dist\\isg-studio.exe --report _verify-out\\selftest\\pipeline-mock.json \
      --server tools/mock-provider-server.js --server-arg audit \
      --fixture tools/mock-fixture.md --out _verify-out\\pipeline\\out
"""

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time


def read_first_line(proc, timeout=15.0):
    q = queue.Queue()

    def reader():
        try:
            q.put(proc.stdout.readline())
        except Exception as e:  # pragma: no cover
            q.put('')

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        return q.get(timeout=timeout).strip()
    except queue.Empty:
        return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exe', required=True)
    ap.add_argument('--report', required=True)
    ap.add_argument('--selftest', required=True)
    ap.add_argument('--server', required=True)
    ap.add_argument('--server-arg', action='append', default=[])
    ap.add_argument('--fixture', default='')
    ap.add_argument('--out', default='')
    ap.add_argument('--net-requests', default='')
    ap.add_argument('--timeout', type=float, default=100.0)
    ap.add_argument('--no-key', action='store_true',
                    help='不设 ISG_API_KEY（验本机端点允许无 Key）')
    args = ap.parse_args()

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    # 清旧请求记录：这是一份"证据"文件，陈旧的内容会被读成这一轮的结果。
    # **只允许删自己预期的临时根**（用户硬要求：删除前先看目标）。
    allowed = (os.path.join(root, '_verify-out') + os.sep,
               tempfile.gettempdir() + os.sep)
    if args.net_requests:
        target = os.path.abspath(args.net_requests)
        if not any(target.startswith(a) for a in allowed):
            sys.stderr.write('拒绝删除不在允许根内的请求记录：' + target + '\n')
            return 2
        if os.path.exists(target):
            os.remove(target)
    # 产物目录每次重新生成：旧 HTML 会冒充本轮产物（mtime/内容判据都可能被骗过）。
    # 只删 `_verify-out/` 或系统临时目录之内的、明确给出的那个目录。
    if args.out:
        outdir = os.path.abspath(args.out)
        if not any(outdir.startswith(a) for a in allowed):
            sys.stderr.write('拒绝清理不在允许根内的产物目录：' + outdir + '\n')
            return 2
        if os.path.isdir(outdir):
            shutil.rmtree(outdir)
        os.makedirs(outdir, exist_ok=True)
    # repair 模式的**变异证据**：由假服务写、验证器自己读（不是被测程序自报）。
    evidence = os.path.abspath(args.report) + '.repair-events.jsonl'
    if os.path.exists(evidence):
        os.remove(evidence)
    # 假服务是**先启动**的，后面构造的 env 只传给被测程序；证据路径要在启动前放进本进程环境。
    os.environ['ISG_REPAIR_EVIDENCE'] = evidence

    server_cmd = [sys.executable if args.server.endswith('.py') else 'node', args.server]
    # 故障服务把收到的请求写进 argv[2]；`slow` 之类的模式在 argv[3]。
    # 这两者都必须**在服务启动时**给，只传给 exe 是不够的（踩过：host 读到 0 个请求）。
    if args.net_requests:
        server_cmd.append(os.path.abspath(args.net_requests))
    server_cmd += list(args.server_arg)

    server = subprocess.Popen(
        server_cmd, cwd=root,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding='utf-8', errors='replace',
    )
    try:
        line = read_first_line(server)
        if not line:
            err = server.stderr.read() if server.stderr else ''
            sys.stderr.write('假服务没有输出端口：' + (err or '(没有 stderr)') + '\n')
            return 2
        try:
            port = int(json.loads(line)['port'])
        except Exception:
            sys.stderr.write('假服务的端口行看不懂：' + line + '\n')
            return 2

        env = dict(os.environ)
        env.update({
            'ISG_PROVIDER': 'deepseek',
            'ISG_BASE_URL': 'http://127.0.0.1:%d/v1' % port,
            'ISG_MODEL': 'mock-large',
            'ISG_FORMAT': 'openai',
        })
        # 隔离用户的真实 Key / .env：provider 专属变量优先级高于 ISG_API_KEY，
        # 不清掉的话"假模型测试"可能把用户真 Key 发给本地服务。
        for k in list(env.keys()):
            if k.endswith('_API_KEY') and k != 'ISG_API_KEY':
                env.pop(k, None)
        empty_env = tempfile.NamedTemporaryFile('w', suffix='.env', delete=False)
        empty_env.write('# 自测隔离：空 .env\n')
        empty_env.close()
        env['ISG_ENV_FILE'] = empty_env.name
        env['ISG_REPAIR_EVIDENCE'] = evidence
        if not args.no_key:
            env['ISG_API_KEY'] = 'sk-mock-selftest-000000'
        else:
            env.pop('ISG_API_KEY', None)
        cmd = [args.exe, '--selftest=' + args.selftest, '--report=' + args.report, '--offscreen']
        if args.fixture:
            cmd.append('--pipeline-fixture=' + os.path.abspath(args.fixture))
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            cmd.append('--pipeline-out=' + os.path.abspath(args.out))
        if args.net_requests:
            cmd.append('--net-requests=' + os.path.abspath(args.net_requests))

        try:
            r = subprocess.run(cmd, cwd=root, env=env, capture_output=True, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            sys.stderr.write('自测超时（%.0fs）\n' % args.timeout)
            return 124
        out = r.stdout.decode('utf-8', 'replace')
        err = r.stderr.decode('utf-8', 'replace')
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return r.returncode
    finally:
        try:
            fp = locals().get('empty_env')
            if fp is not None:
                os.remove(fp.name)
        except Exception:
            pass
        try:
            server.terminate()
            server.wait(timeout=5)
        except Exception:
            try:
                server.kill()
            except Exception:
                pass


if __name__ == '__main__':
    sys.exit(main())
