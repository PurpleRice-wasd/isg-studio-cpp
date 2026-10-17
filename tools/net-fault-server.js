'use strict';
/* Phase 3 的故障注入服务：专门用来证明 **llm/index.js 的重试与降级真的生效**。
 *
 * 它按请求顺序回：
 *   1) 400「response_format is not supported」 → llm 去掉 response_format 重试
 *   2) 400「stream_options is not supported」   → llm 去掉 stream_options 重试
 *   3) 429 + Retry-After: 0                     → llm 退避后重试
 *   4) 200 + SSE（**故意切包**、并夹一条 `data: 0` 保活行）
 *
 * 每个请求（方法/URL/头/体）都追加到 argv[2] 指定的 JSONL 文件里。
 * 验证脚本读那份文件，断言"第二、三次请求真的少了那个字段"——
 * 只看最终成功是证明不了降级的（服务端也可能碰巧接受了它）。
 *
 * 用法： node tools/net-fault-server.js <requests.jsonl>
 */

const fs = require('fs');
const http = require('http');

const requestsFile = process.argv[2] || '';

let seq = 0;

function record(req, body) {
    const entry = {
        n: seq,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body
    };
    if (requestsFile) {
        try { fs.appendFileSync(requestsFile, JSON.stringify(entry) + '\n', 'utf8'); } catch (e) {}
    }
}

function sendJson(res, status, obj, extraHeaders) {
    res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}));
    res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
        record(req, null);
        sendJson(res, 200, { object: 'list', data: [{ id: 'fault-model', object: 'model' }] });
        return;
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
        record(req, null);
        sendJson(res, 404, { error: { message: 'net-fault: 没有这个端点 ' + req.url } });
        return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) {}
        seq++;
        record(req, body);
        /* 取消测试要证明"在途连接真的断了"：客户端 abort 时记一条。
           `writableEnded` 为假说明连接是在响应写完之前关掉的。 */
        const markAborted = () => {
            if (requestsFile) {
                try {
                    fs.appendFileSync(requestsFile,
                        JSON.stringify({ n: seq, type: 'aborted', aborted: true }) + '\n', 'utf8');
                } catch (e) {}
            }
        };
        req.on('aborted', markAborted);
        res.on('close', () => { if (!res.writableEnded) markAborted(); });

        const slow = process.argv[3] === 'slow';
        const respond = () => handle(body, res);
        if (slow) setTimeout(respond, 10000);
        else respond();
    });

    function handle(body, res) {
        if (body.response_format) {
            sendJson(res, 400, { error: { message: 'response_format is not supported by this model' } });
            return;
        }
        if (body.stream_options) {
            sendJson(res, 400, { error: { message: 'stream_options is not supported by this endpoint' } });
            return;
        }
        if (seq === 3) {
            sendJson(res, 429, { error: { message: 'rate limited, please retry' } }, { 'retry-after': '0' });
            return;
        }

        const text = '{"ok":1}';
        if (!body.stream) {
            sendJson(res, 200, {
                choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 }
            });
            return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const events = [
            'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(0, 4) }, finish_reason: null }] }) + '\n\n',
            // 保活行：旧状态机会把它当成解析失败并卡住 pending，吞掉后面所有事件。
            'data: 0\n\n',
            'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(4) }, finish_reason: null }] }) + '\n\n',
            'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n',
            'data: [DONE]\n\n'
        ];
        /* 先塞一条 20 KB 的 SSE 注释：SSE 解析器会忽略 `:` 开头的行，但它保证
           响应体 > 16 KB（宿主一次 ReadData 的上限），于是**必然**跨至少两个 chunk。
           不这样做时，几百字节的流会被内核一次性交给 WinHTTP，测试看到 chunk=1，
           跨包状态机其实没被压到。 */
        const wire = ':' + 'x'.repeat(20000) + '\n\n' + events.join('');
        // 不规则的切法：保证有事件被 TCP 分片切断
        const cuts = [11, 29, 53, 71, 97, 131, 173, 211];
        let at = 0, k = 0;
        function next() {
            if (at >= wire.length) { res.end(); return; }
            const step = cuts[k++ % cuts.length];
            res.write(wire.slice(at, at + step));
            at += step;
            setTimeout(next, 10);
        }
        next();
    }
});

server.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});

function shutdown() {
    server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
