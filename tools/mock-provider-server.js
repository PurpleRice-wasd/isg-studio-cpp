'use strict';
/* 把 oracle 的 `test/mock-provider.js` 起成一个**独立进程**的本地假模型。
 *
 * 用法：
 *   node tools/mock-provider-server.js [audit] [repair]
 *     audit  = 打开 `auditMode:'catch-and-fix'`（第一次题库写错 999，审题抓住后改对）
 *     repair = 在代理层把**演示的 checks** 改坏（把第一组期望读数写成 999999）。
 *              用来验 Phase 5 的修复闭环：探针/demo-checks 必须发现它、repairRound
 *              必须真的重出演示并重跑校验。假模型本身不会"改对"，所以修完仍有 1 项没过 ——
 *              这正是我们要的：证明**修复轮真的跑了**，而不是把失败吞掉。
 *
 * 为什么 repair 要经过一层代理：oracle 的 mock-provider 没有"输出错误 checks"的开关，
 * 而我们不改 oracle（它是迁移的基准）。代理只拦截 chat/completions 的响应，其它字节原样转发。
 */

const path = require('path');
const http = require('http');
const fs = require('fs');

const mockPath = path.resolve(__dirname, '..', '..', 'isg-studio', 'test', 'mock-provider.js');
const { makeServer } = require(mockPath);

const modes = process.argv.slice(2).join(',').toLowerCase();
const audit = modes.indexOf('audit') >= 0;
const repair = modes.indexOf('repair') >= 0;

const server = makeServer({
    auditMode: audit ? 'catch-and-fix' : undefined,
    // 默认不包 Markdown 围栏；包围栏那条路径由 llm 层的 parseJsonLoose 覆盖，
    // pipeline 这里不需要再验一次。
    wrapFence: false
});

function mutateDemoContent(text) {
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        return text;
    }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.checks) || !obj.checks.length) return text;
    const first = obj.checks[0];
    if (!first || typeof first !== 'object') return text;
    first.expect = first.expect && typeof first.expect === 'object' ? first.expect : {};
    const keys = Object.keys(first.expect);
    if (keys.length) {
        first.expect[keys[0]] = '999999';
    } else {
        first.expect = { '不存在的读数': '999999' };
    }
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return text;
    }
}

/** SSE：把模型正文拼起来，改坏其中的 checks，再合成一条新的 SSE 流。 */
function rewriteSse(text) {
    const lines = String(text).split(/\r?\n/);
    let content = '';
    let usage = null;
    let saw = false;
    for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        if (obj && obj.usage) usage = obj.usage;
        const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (delta && typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            saw = true;
        }
    }
    if (!saw) return text;
    const fixed = mutateDemoContent(content);
    if (fixed === content) return text;
    const events = [
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: fixed }, finish_reason: null }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage || { prompt_tokens: 100, completion_tokens: 200 } }) + '\n\n',
        'data: [DONE]\n\n'
    ];
    return events.join('');
}

/* 变异证据：**独立于被测程序**的一行记录。run-mock-selftest 会把路径放进环境变量，
   phase1-verify 自己读这份文件对账（不是 app 自报）。 */
function recordEvidence() {
    const p = process.env.ISG_REPAIR_EVIDENCE;
    if (!p) return;
    try { fs.appendFileSync(p, JSON.stringify({ at: Date.now(), injected: '999999' }) + '\n'); } catch (e) {}
}

function startProxy(upstreamPort) {
    return new Promise((resolve) => {
        const proxy = http.createServer((req, res) => {
            if (req.method === 'GET' && /\/models$/.test(req.url)) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-large', object: 'model', owned_by: 'mock' }] }));
                return;
            }
            if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
                const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers },
                    (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
                req.pipe(up);
                return;
            }
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const up = http.request({ host: '127.0.0.1', port: upstreamPort, path: req.url, method: 'POST', headers: req.headers },
                    (ur) => {
                        const chunks = [];
                        ur.on('data', (c) => chunks.push(c));
                        ur.on('end', () => {
                            const raw = Buffer.concat(chunks).toString('utf8');
                            let out = raw;
                            const ctype = String((ur.headers && ur.headers['content-type']) || '');
                            if (ctype.indexOf('text/event-stream') >= 0) {
                                out = rewriteSse(raw);
                            } else {
                                try {
                                    const obj = JSON.parse(raw);
                                    const msg = obj && obj.choices && obj.choices[0] && obj.choices[0].message;
                                    if (msg && typeof msg.content === 'string') {
                                        msg.content = mutateDemoContent(msg.content);
                                        out = JSON.stringify(obj);
                                    }
                                } catch (e) { /* 原样转发 */ }
                            }
                            if (out !== raw) recordEvidence();
                            const headers = Object.assign({}, ur.headers);
                            delete headers['content-length'];
                            res.writeHead(ur.statusCode, headers);
                            res.end(out);
                        });
                    });
                up.on('error', () => {
                    res.writeHead(502, { 'content-type': 'text/plain' });
                    res.end('mock upstream failed');
                });
                up.end(body);
            });
        });
        proxy.listen(0, '127.0.0.1', () => resolve(proxy));
    });
}

server.listen().then(async () => {
    if (!repair) {
        process.stdout.write(JSON.stringify({ port: server.port }) + '\n');
        return;
    }
    const proxy = await startProxy(server.port);
    process.stdout.write(JSON.stringify({ port: proxy.address().port }) + '\n');
    shutdownProxy = proxy;
}).catch((e) => {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(2);
});

let shutdownProxy = null;
function shutdown() {
    try { if (shutdownProxy) shutdownProxy.close(); } catch (e) {}
    server.close().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
