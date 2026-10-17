'use strict';
/* 生成流水线在页面里的宿主（**本工程新写**，oracle 里没有对应物）。
 *
 * 分工（纲领 §6 / §3.2）：
 *   · 纯逻辑（pipeline / prompts / bank / assemble / llm 分帧与重试）仍是 oracle 的 JS，
 *     由 logic-bundle.js 原样加载；
 *   · 宿主能力（窗口、文件、Key、WinHTTP 字节搬运、任务生命周期）在 C++；
 *   · 这个文件只做"把两边接上"：取预热的 skill/契约、取任务快照、驱动 runGeneration、
 *     转发取消与测试连接。
 *
 * 两条必须守住的纪律：
 *   1. **API Key 不进页面**。provider 配置里给的是 `apiKey: '__ISG_HOST_KEY__'` 哨兵，
 *      真正的 Key 由 C++ 的 `_net:fetch` 在发出前替换（见 net/net.cpp）。
 *   2. **大消息分块**。WebView2 的消息大小有限（Phase 1 实测 161KB 的字符串收不到），
 *      所以 skill/契约/任务快照都走 `_pipeline:filePart` / `_pipeline:jobPart` 分块取。
 */
(function () {
  if (window.__isgPipelineHost) return;
  window.__isgPipelineHost = true;

  var bridge = window.chrome && window.chrome.webview;
  if (!bridge) return;

  var host = window.__isgHost;
  if (!host) {
    // isg-bridge.js 必须先加载；没加载时不要静默 —— 生成会全部失效
    console.error('[pipeline-host] 找不到 __isgHost（isg-bridge.js 没加载？）');
    return;
  }

  var envPromise = null;
  var currentJob = null;
  var running = {};

  /* 设置保存/导入之后由 isg-bridge 调用：下一轮重新取 skill/契约/provider 快照。 */
  window.__isgPipelineInvalidate = function () { envPromise = null; };

  function post(msg) {
    msg.__isg = 1;
    try { bridge.postMessage(JSON.stringify(msg)); } catch (e) {}
  }

  function b64FromText(text) {
    var bytes = new TextEncoder().encode(String(text));
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /* 页面 → 宿主的回包可能很大（revive 的反推结果含整章 units/bank）。
     单条消息超限会静默丢：先发头（chunked:true），再发 base64 分片，最后 end。
     分片切的是**整串 base64**，宿主拼起来再解一次 —— 不能各片单独编码再拼。 */
  function replyHost(id, ok, dataOrError) {
    var msg = { __isg: 1, kind: 'host-reply', id: id, ok: !!ok };
    if (ok) msg.data = dataOrError === undefined ? null : dataOrError;
    else msg.error = dataOrError || { code: 'PAGE_ERROR', message: '页面没有说明原因' };
    var text = JSON.stringify(msg);
    var b64 = b64FromText(text);
    if (b64.length <= 64 * 1024) {
      try { bridge.postMessage(text); } catch (e) {}
      return;
    }
    post({ kind: 'host-reply', id: id, chunked: true, bytes: text.length });
    for (var off = 0; off < b64.length; off += 36 * 1024) {
      post({ kind: 'host-reply-chunk', id: id, data: b64.slice(off, off + 36 * 1024) });
    }
    post({ kind: 'host-reply-end', id: id });
  }

  function b64ToText(chunks) {
    var dec = new TextDecoder('utf-8');
    var out = '';
    for (var i = 0; i < chunks.length; i++) {
      var bin = atob(chunks[i]);
      var u8 = new Uint8Array(bin.length);
      for (var j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
      out += dec.decode(u8, { stream: true });
    }
    return out + dec.decode();
  }

  /** 按块取一个文本（skill / 契约 / 任务快照）。 */
  function readChunks(invokeName, extraArgs, total) {
    var off = 0;
    var chunks = [];
    function next() {
      if (off >= total) return Promise.resolve(b64ToText(chunks));
      var args = (extraArgs || []).concat([off, 36 * 1024]);
      return host.invoke(invokeName, args).then(function (rr) {
        if (!rr || !rr.ok) throw new Error((rr && rr.error && rr.error.message) || '分块读取失败');
        chunks.push(rr.data.data || '');
        var after = Number(rr.data.next);
        off = isFinite(after) && after > off ? after : (off + 36 * 1024);
        return next();
      });
    }
    return next();
  }

  function loadEnv() {
    if (envPromise) return envPromise;
    var p = host.invoke('_pipeline:env', []).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '拿不到生成环境');
      var env = r.data || {};
      env.files = {};
      var names = ['skillMd', 'skeleton', 'contract'];
      return Promise.all(names.map(function (n) {
        var info = env[n + 'Info'];
        if (!info || !Number(info.bytes)) return Promise.resolve('');
        return readChunks('_pipeline:filePart', [n], Number(info.bytes)).then(function (text) {
          env[n] = text;
          return text;
        });
      })).then(function () { return env; });
    });
    /* 失败的 Promise **不能**留在缓存里：否则一次瞬态失败会让之后每次
       "开始生成 / 测试连接"都复用同一个 rejected promise，用户看到的是
       "重试也永远失败"，只有保存一次设置才会恢复。 */
    envPromise = p.catch(function (e) { envPromise = null; throw e; });
    return envPromise;
  }

  function loadJob(id) {
    return host.invoke('_pipeline:jobInfo', [id]).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '拿不到任务快照');
      var total = Number(r.data && r.data.bytes) || 0;
      return readChunks('_pipeline:jobPart', [id], total);
    }).then(function (text) {
      return JSON.parse(text);
    });
  }

  function start(jobId) {
    return Promise.all([loadEnv(), loadJob(jobId)]).then(function (pair) {
      var env = pair[0];
      var job = pair[1];
      var logic = window.__isgLogic;
      if (!logic) throw new Error('logic-bundle.js 没加载');
      logic.setEnv(env);
      logic.setJobId(job.id);
      currentJob = job;
      running[job.id] = true;
      /* 取消语义的适配（**不改 oracle 文件**）。
         oracle 的 llm 层在外部 signal 被 abort 时抛的是 `LlmError{code:'EABORTED'}`，
         没有 `canceled` 标志；而 pipeline 的 askJson 只在 `e.canceled` 时才把它当成取消，
         否则会走"模型调用失败 → 重试/失败"。结果是：用户点了取消，任务最终显示 failed。
         这里在 llm 模块外面包一层：EABORTED / signal.aborted 一律补上 `canceled=true`，
         于是 pipeline 原封不动的 `if (e.canceled) throw e` 就能正确走到 canceled 分支。
         （这是宿主适配层，不是对纯逻辑的修改；差异记在 phase3-4 报告里。） */
      try {
        var llm = logic.require('llm');
        if (!llm.__isgCancelWrapped) {
          var origChat = llm.chat;
          llm.chat = function (o) {
            return origChat(o).catch(function (e) {
              if (e && (e.canceled || e.code === 'EABORTED'
                        || (o && o.signal && o.signal.aborted))) {
                e.canceled = true;
              }
              throw e;
            });
          };
          llm.__isgCancelWrapped = true;
        }
      } catch (e) { /* 包装失败不影响主流程；取消会以 failed 呈现 */ }
      var pipe = logic.require('pipeline');
      // runGeneration 自己会 catch → fail/finish；这里只兜"连它都没跑起来"的灾难
      return pipe.runGeneration(job).then(function () {
        running[job.id] = false;
      }, function (e) {
        running[job.id] = false;
        post({
          kind: 'pipeline', op: 'fail', jobId: job.id,
          error: { message: (e && e.message) || String(e), stack: (e && e.stack) || '' }
        });
      });
    }).catch(function (e) {
      // 环境/快照都没取到：明确报失败，别让任务永远停在"排队中"
      post({
        kind: 'pipeline', op: 'fail', jobId: jobId,
        error: { message: '流水线没能启动：' + ((e && e.message) || e), stack: (e && e.stack) || '' }
      });
    });
  }

  function cancel(jobId) {
    var logic = window.__isgLogic;
    if (logic) logic.cancelJob(jobId);
    if (currentJob && String(currentJob.id) === String(jobId) && currentJob._abort) {
      try { currentJob._abort.abort(); } catch (e) {}
    }
  }

  function onHostRequest(msg) {
    /* Phase 6：宿主读到了 HTML，但要反推结构（revive 是纯逻辑，住在页面里）。
       宿主不能自己执行 JS，所以把 HTML 交过来、拿回 revive 的结果。 */
    if (msg.name === 'revive') {
      try {
        var html = (msg.args && msg.args[0]) || '';
        var rev = window.__isgLogic.require('revive').revive(String(html));
        replyHost(msg.id, true, rev);
      } catch (e) {
        replyHost(msg.id, false, { code: 'REVIVE_FAILED',
               message: '反推页面结构时抛错：' + ((e && e.message) || e) });
      }
      return;
    }
    if (msg.name !== 'testConnection') {
      replyHost(msg.id, false, { code: 'UNKNOWN_REQUEST', message: '页面不认识这个宿主请求：' + msg.name });
      return;
    }
    var providerId = (msg.args && msg.args[0]) || '';
    loadEnv().then(function (env) {
      // fetch 垫片靠 logic 里的 env 把 URL 映射到 providerId；**首次**使用设置页的
      // 「测试连接」时还没跑过生成，不在这里 setEnv 的话 providerId 会是空串，
      // 宿主回 ENO_PROVIDER —— 用户看到"配置没问题但连不上"。
      window.__isgLogic.setEnv(env);
      var p = (env.providers || {})[providerId];
      if (!p) throw new Error('没有这个模型提供商：' + providerId);
      var llm = window.__isgLogic.require('llm');
      return llm.testConnection(p, { timeoutMs: 10000 });
    }).then(function (res) {
      replyHost(msg.id, true, res);
    }).catch(function (e) {
      replyHost(msg.id, true, { ok: false, models: [], error: (e && e.message) || String(e), latencyMs: 0 });
    });
  }

  /* 自测入口（**只在本工程页面里存在**）：直接调原样搬来的 llm 层。
     用来验 SSE 切包 / 400 降级 / 429 重试；生产路径在 runGeneration 里。 */
  window.__isgTestChat = function (opts) {
    opts = opts || {};
    return loadEnv().then(function (env) {
      // 必须先把 env 交给 logic-bundle：fetch 垫片靠它把 URL 映射到 providerId
      // （真 Key 只存在于 C++，页面里只有哨兵）。
      window.__isgLogic.setEnv(env);
      const id = opts.providerId || (env.settings.active && env.settings.active.provider);
      const base = (env.providers || {})[id] || {};
      const provider = Object.assign({}, base, opts.provider || {});
      const llm = window.__isgLogic.require('llm');
      return llm.chat({
        provider: provider,
        model: opts.model || (env.settings.active && env.settings.active.model) || 'mock-large',
        system: opts.system,
        messages: opts.messages || [{ role: 'user', content: 'ping' }],
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        json: !!opts.json,
        stream: opts.stream === undefined ? true : !!opts.stream,
        onDelta: opts.onDelta
      });
    });
  };

  var hostRequests = {};
  bridge.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || msg.__isg !== 1) return;
    if (msg.kind === 'pipeline-run') { start(msg.jobId); return; }
    if (msg.kind === 'pipeline-cancel') { cancel(msg.jobId); return; }
    if (msg.kind === 'host-request') {
      if (msg.chunked) { hostRequests[msg.id] = { name: msg.name, chunks: [] }; return; }
      onHostRequest(msg);
      return;
    }
    if (msg.kind === 'host-request-chunk') {
      var hr = hostRequests[msg.id];
      if (hr) hr.chunks.push(String(msg.data || ''));
      return;
    }
    if (msg.kind === 'host-request-end') {
      var done = hostRequests[msg.id];
      delete hostRequests[msg.id];
      if (!done) return;
      try {
        var args = JSON.parse(b64ToText(done.chunks));
        onHostRequest({ id: msg.id, name: done.name, args: args });
      } catch (e) {
        replyHost(msg.id, false, { code: 'BAD_CHUNK', message: '宿主请求分块拼不起来：' + ((e && e.message) || e) });
      }
      return;
    }
  });
})();
