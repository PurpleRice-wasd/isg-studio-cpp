/* 浏览器侧垫片（**不是**从 oracle 复制的代码）。
 *
 * 这一段是整个"纯逻辑 JS 跑在 WebView2 里"方案的唯一新代码。它只做一件事：
 * 把 oracle 那些模块同步依赖的宿主能力（fs / path / store / jobs / fetch …）
 * 换成"与 C++ 宿主往返"的实现。**原文件一个字节都不改**（纲领 §7.4）。
 *
 * 为什么 fetch 也在这里而不是在 C++ 里重写 SSE：纲领 §6 的模块映射表写着
 * `llm/index.js` —— 「SSE 状态机/重试/降级策略 → 原样搬进 Worker；fetch 传输 → C++」。
 * 所以 C++ 只做 WinHTTP 的字节搬运（`_net:fetch`），分帧、重试、降级、打码全部
 * 仍由 oracle 的 llm/index.js 负责。这样三个真实回归 bug 的对策一个字都不会丢。
 *
 * 这个文件被 tools/golden/bundle-logic.js 原样内联进 logic-bundle.js；
 * 它是一个**函数表达式**：function (shims) { ... return {...}; }
 */
function (shims) {
  'use strict';

  var HOST_KEY = '__ISG_HOST_KEY__';   // 假的 Key：真 Key 只在 C++ 层，发出前被替换

  function env() { return shims.getEnv() || {}; }
  function jobId() { return shims.getJobId() || ''; }
  function post(msg) {
    msg.__isg = 1;
    /* 不写 kind 的调用全部是流水线内部操作（log / progress / emit / finish …）。
       ⚠️ 这一行漏过：`jobs.log()` 只传了 `{op:'log'}`，而 C++ 按 kind 路由，
       于是**日志与状态事件全部被丢掉**，只有显式写了 kind:'pipeline' 的写文件消息到达
       —— 现象是"页面已经写出来了，任务却永远停在 pending"。 */
    if (!msg.kind) msg.kind = 'pipeline';
    if (msg.kind === 'pipeline' && !msg.jobId) msg.jobId = jobId();
    try { shims.post(msg); } catch (e) { /* 宿主没了：不再抛 */ }
  }

  // -------------------------------------------------------------------------
  // path（win32 语义；pipeline 只用 basename / extname / join / dirname / resolve / sep）
  // -------------------------------------------------------------------------
  var path = (function () {
    function isAbs(p) {
      return /^[A-Za-z]:[\\\/]/.test(p) || /^\\\\/.test(p) || /^[\\\/]/.test(p);
    }
    function norm(p) {
      p = String(p == null ? '' : p).replace(/\//g, '\\');
      /* UNC（`\\server\share\…`）的双反斜杠必须保留：吃掉一个之后，
         `GetFullPathNameW` 会把它解释成**当前盘根**下的路径，输出目录校验必然失败。
         网络共享当输出目录在教学场景里很常见。 */
      var unc = /^\\\\/.test(p);
      if (unc) p = p.slice(2);
      var drive = '';
      var m = /^([A-Za-z]:)(.*)$/.exec(p);
      if (m) { drive = m[1].toUpperCase(); p = m[2]; }
      var parts = p.split('\\');
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var s = parts[i];
        if (!s || s === '.') continue;
        if (s === '..') { if (out.length) out.pop(); continue; }
        out.push(s);
      }
      if (unc) return '\\\\' + out.join('\\');
      return drive + '\\' + out.join('\\');
    }
    function join() {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = String(arguments[i] == null ? '' : arguments[i]);
        if (!a) continue;
        // 第一个绝对路径（含 UNC 的 `\\server\share`）保留前导分隔符；
        // 后面的相对段去掉首尾分隔符。
        if (i === 0 && isAbs(a)) parts.push(a.replace(/[\\\/]+$/, ''));
        else parts.push(a.replace(/^[\\\/]+|[\\\/]+$/g, ''));
      }
      return norm(parts.join('\\'));
    }
    function resolve() {
      var p = '';
      for (var i = 0; i < arguments.length; i++) {
        var a = String(arguments[i] == null ? '' : arguments[i]);
        if (!a) continue;
        if (isAbs(a)) p = a;
        else p = p ? p + '\\' + a : a;
      }
      if (!p) p = 'C:\\';
      if (!isAbs(p)) p = 'C:\\' + p;
      return norm(p);
    }
    function dirname(p) {
      var s = norm(p);
      if (/^[A-Za-z]:\\$/.test(s)) return s;
      var i = s.lastIndexOf('\\');
      if (i < 0) return '.';
      if (i === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
      return s.slice(0, i) || '\\';
    }
    function basename(p, ext) {
      var s = String(p == null ? '' : p).replace(/[\\\/]+$/, '');
      var i = s.lastIndexOf('\\');
      if (i < 0) i = s.lastIndexOf('/');
      var b = s.slice(i + 1);
      if (ext && b.length >= ext.length && b.slice(-ext.length).toLowerCase() === String(ext).toLowerCase()) {
        b = b.slice(0, -ext.length);
      }
      return b;
    }
    function extname(p) {
      var b = basename(p);
      var i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    }
    function relative(from, to) {
      var a = norm(resolve(from)).split('\\');
      var b = norm(resolve(to)).split('\\');
      var i = 0;
      while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
      var up = [];
      for (var j = i; j < a.length; j++) up.push('..');
      var down = b.slice(i);
      return up.concat(down).join('\\');
    }
    return {
      sep: '\\', delimiter: ';',
      isAbsolute: isAbs, normalize: norm, join: join, resolve: resolve,
      dirname: dirname, basename: basename, extname: extname, relative: relative
    };
  })();

  // -------------------------------------------------------------------------
  // fs：读的是启动时预热的 skill/契约快照；写走宿主（消息有序，且分块避免大消息）
  // -------------------------------------------------------------------------
  var fs = (function () {
    function lower(p) { return String(p).replace(/\//g, '\\').toLowerCase(); }
    function textOf(p) {
      var e = env();
      var files = e.files || {};
      var k = lower(p);
      if (Object.prototype.hasOwnProperty.call(files, k)) return files[k];
      if (/generation-contract\.md$/i.test(String(p))) return e.contract;
      if (/[\\\/]SKILL\.md$/i.test(String(p))) return e.skillMd;
      if (/page-skeleton\.html$/i.test(String(p))) return e.skeleton;
      return null;
    }
    function writeSync(p, text) {
      var s = String(text == null ? '' : text);
      post({ kind: 'pipeline', op: 'writeFileBegin', path: String(p) });
      // 16K 个 UTF-16 码元：中文最多 3 字节/码元 → 单条消息 ≤ ~48 KB JSON 文本。
      // 不要按"48K 字符"切：那在中文页面上会到 ~150 KB，接近 WebView2 的实测上限。
      var CH = 16 * 1024;
      var chunks = 0;
      for (var i = 0; i < s.length;) {
        var end = Math.min(s.length, i + CH);
        // 不要把代理对切成两半（否则两段各自编码都会变成 U+FFFD）
        if (end < s.length) {
          var c = s.charCodeAt(end - 1);
          if (c >= 0xD800 && c <= 0xDBFF) end++;
        }
        post({ kind: 'pipeline', op: 'writeFileChunk', path: String(p), text: s.slice(i, end) });
        chunks++;
        i = end;
      }
      /* 结束消息带上**字节数**与**块数**：任何一条 chunk 被消息层吞掉，
         C++ 都能当场发现并让任务失败，而不是静默交出一个被截断的页面。
         （`post()` 没有 ack，大消息的丢失是发不出去也看不出来的。） */
      post({ kind: 'pipeline', op: 'writeFileEnd', path: String(p),
             size: new TextEncoder().encode(s).length, chunks: chunks });
    }
    return {
      existsSync: function (p) { return textOf(p) !== null; },
      readFileSync: function (p) {
        var t = textOf(p);
        if (t === null) throw new Error('fs.readFileSync：垫片里没有这份文件（' + p + '）');
        return t;
      },
      writeFileSync: writeSync,
      mkdirSync: function () { /* 宿主写文件时会建目录 */ },
      copyFileSync: function (from, to) {
        // ⚠️ 字段名必须与 C++ 的 HandleWrite 对上：它读 `to`（也兼容 `path`）。
        // 以前这里发的是 `{from,to}`，而 C++ 读 `path` → 永远校验失败 → 整个任务 failed。
        post({ kind: 'pipeline', op: 'copyFile', from: String(from), to: String(to) });
      },
      statSync: function (p) {
        var t = textOf(p);
        if (t === null) throw new Error('ENOENT：' + p);
        return { isFile: function () { return true; }, isDirectory: function () { return false; }, size: t.length };
      },
      readdirSync: function () { return []; },
      /* 旁挂数据（book.js）的原子写：先写 `<...>.isg.json.tmp`，再 rename。
         消息是**有序**的（writeFileEnd 一定在 renameFile 之前到达宿主），
         所以这里不需要同步 ack；真正的失败由宿主记 warn（页面看不到返回值）。 */
      renameSync: function (from, to) {
        post({ kind: 'pipeline', op: 'renameFile', from: String(from), to: String(to) });
      },
      /* book.js 只在 catch 里清 tmp。宿主侧只允许删 `.isg.json.tmp`（见 jobs.cpp）。 */
      unlinkSync: function (p) {
        post({ kind: 'pipeline', op: 'deleteFile', path: String(p) });
      },
      rmSync: function () { /* 浏览器垫片没有目录操作 */ }
    };
  })();

  // -------------------------------------------------------------------------
  // store / skill / version / electron：全部从预热快照取；**Key 只有哨兵值**
  // -------------------------------------------------------------------------
  var store = {
    getSettings: function () { return env().settings || {}; },
    providerConfig: function (id) {
      var p = (env().providers || {})[String(id)];
      if (!p) throw new Error('没有这个模型提供商：' + id);
      return JSON.parse(JSON.stringify(p));
    }
  };
  var skill = {
    readSkillMd: function () { return env().skillMd || ''; },
    skeleton: function () { return env().skeleton || ''; },
    skillDir: function () { return env().skillDir || ''; }
  };
  var version = { appVersion: function () { return env().version || ''; } };
  var electron = {
    app: {
      isPackaged: false,
      getPath: function () { return env().userData || 'C:\\isg-userdata'; }
    }
  };

  // -------------------------------------------------------------------------
  // jobs：状态由 C++ 持有；这里只把 oracle 的同步 API 翻译成消息
  // -------------------------------------------------------------------------
  var jobs = (function () {
    var canceled = {};
    var asks = {};              // jobId -> { pub, resolve, timer }
    var askSeq = 0;
    var activeJob = null;       // 给 cancelLocal 找"当前任务"的默认值

    function CanceledError() {
      var e = new Error('任务已取消');
      e.name = 'CanceledError';
      e.canceled = true;
      return e;
    }
    function emit(job, ev) { post({ op: 'emit', ev: ev || {} }); }
    function log(job, level, message, extra) {
      var entry = { at: Date.now(), level: level, message: String(message == null ? '' : message) };
      if (extra && typeof extra === 'object') {
        var d = {};
        Object.keys(extra).forEach(function (k) {
          var v = extra[k];
          if (v == null) return;
          if (typeof v === 'object' && !Array.isArray(v)) return;
          d[k] = Array.isArray(v) ? v.slice(0, 20) : v;
        });
        entry.detail = d;
      }
      post({ op: 'log', entry: entry });
      return entry;
    }
    function progress(job, key, status, extra) {
      var m = { op: 'progress', key: key, status: status };
      if (extra && typeof extra === 'object') {
        Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
      }
      post(m);
    }
    function isCanceled(job) { return !!canceled[jobId()] || !!(job && job._abortRequested); }
    function settleAsk(jobId2, job, value, why) {
      var a = asks[jobId2];
      if (!a) return false;
      if (a.timer) clearTimeout(a.timer);
      delete asks[jobId2];
      // oracle 的 settleAsk 会清掉公开的 job.ask；这里以前漏了，于是 finish 快照
      // 会把一个已回答/已取消的问题又写回去，已完成的任务上仍挂着提问卡。
      if (job && typeof job === 'object') {
        job.ask = null;
        job._askDefault = null;
      }
      post({ op: 'askClear', askId: a.pub.id, why: why, title: a.pub.title });
      try { a.resolve(value); } catch (e) {}
      return true;
    }
    function ask(job, spec) {
      var s = spec && typeof spec === 'object' ? spec : {};
      var options = (Array.isArray(s.options) ? s.options : [])
        .filter(function (o) { return o && typeof o === 'object' && o.value !== undefined; })
        .map(function (o) {
          return {
            value: o.value,
            label: String(o.label === undefined || o.label === null ? o.value : o.label),
            detail: String(o.detail === undefined || o.detail === null ? '' : o.detail)
          };
        });
      var title = String(s.title === undefined || s.title === null ? '需要你选一下' : s.title);
      var id = String(s.id || 'ask' + (++askSeq));
      var def = s.default !== undefined ? s.default : (options[0] ? options[0].value : undefined);
      if (!options.length) {
        log(job, 'warn', '有一个问题没有任何可选项（' + title + '），没人能回答它，直接按默认继续');
        return Promise.resolve(def);
      }
      if (!job || typeof job !== 'object') return Promise.resolve(def);
      if (asks[jobId()]) {
        log(job, 'warn', '已经有一个没回答的问题（' + asks[jobId()].pub.title + '），这次的问题「' + title + '」不再打扰，直接用默认值继续');
        return Promise.resolve(def);
      }
      var pub = { id: id, title: title, message: String(s.message == null ? '' : s.message), options: options, default: def };
      return new Promise(function (resolve) {
        activeJob = job;
        asks[jobId()] = { pub: pub, resolve: resolve, timer: null };
        job.ask = pub;
        job._askDefault = def;          // oracle 的取消/结束路径取这个值
        var timeoutMs = Number(s.timeoutMs) > 0 ? Number(s.timeoutMs) : 10 * 60 * 1000;
        asks[jobId()].timer = setTimeout(function () {
          settleAsk(jobId(), job, def, 'timeout');
        }, timeoutMs);
        // 不额外发 askSet：C++ 的 OpenAsk 会 emit 一次 ask 事件。
        // 两处都发会让同一个问题在事件流里出现两次（oracle 只 emit 一次）。
        shims.invoke('_pipeline:ask', [{ jobId: jobId(), ask: pub }]).then(function (r) {
          // C++ 在用户回答 / 取消时回包；回包值以它为准（本地 settle 可能已经先跑）
          if (r && r.ok) settleAsk(jobId(), job, r.data, 'answer');
          else settleAsk(jobId(), job, def, 'end');
        });
      });
    }
    function fail(job, err) {
      settleAsk(jobId(), job, job && job._askDefault, 'end');
      var msg = err && err.message ? err.message : String(err);
      var stack = err && err.stack ? String(err.stack).split('\n').slice(0, 12).join('\n') : '';
      post({ op: 'fail', error: { message: msg, stack: stack } });
    }
    function summary(job) {
      var out = {};
      Object.keys(job || {}).forEach(function (k) {
        if (k.charAt(0) === '_') return;
        if (k === 'logs' || k === 'stages') return;   // 日志/阶段已逐条发过
        /* `carry` 是带过来的整章结构（units[].bank + lectureHtml + demos），
           宿主本来就有原件；把它塞进 finish 的**页面→宿主**单条消息里，
           多章时必然超过上限 —— 那条消息丢了，任务就永远停在 running。
           宿主侧的任务快照已经保留 carry，界面用不到这一份。 */
        if (k === 'carry') return;
        var v = job[k];
        if (typeof v === 'function') return;
        /* 大字段必须在这里剥掉：`sources[].pages` 是抽出来的**整页正文**（一份 26MB 的 PDF
           可以到几 MB），`options.editedPages` 同理。整份任务快照要过 WebView2 的单条消息，
           超过限制时会**静默收不到** —— 任务就跑完了但界面永远停在 running。
           界面重建只需要来源的元信息；正文由 C++ 的抽取缓存提供。 */
        if (k === 'options' && v && typeof v === 'object') {
          var o = {};
          Object.keys(v).forEach(function (kk) { if (kk !== 'editedPages') o[kk] = v[kk]; });
          out[k] = o;
          return;
        }
        if (k === 'sources' && Array.isArray(v)) {
          out[k] = v.map(function (s) {
            if (!s || typeof s !== 'object') return s;
            var c = {};
            Object.keys(s).forEach(function (kk) {
              if (kk === 'pages' || kk === 'scopedPages' || kk === 'note') return;
              c[kk] = s[kk];
            });
            return c;
          });
          return;
        }
        if (k === 'outputs' && Array.isArray(v)) {
          out[k] = v.map(function (o2) {
            if (!o2 || typeof o2 !== 'object') return o2;
            var c = {};
            Object.keys(o2).forEach(function (kk) { if (kk !== 'report') c[kk] = o2[kk]; });
            return c;
          });
          return;
        }
        /* 报告要跟着 finish 一起回宿主：结果页的「校验报告」靠它。
           报告本身只有几十条 item，远小于单条消息上限；`gen:get` 的通用分块
           会在它真的变大时兜住（bridge.cpp 的回包层）。 */
        out[k] = v;
      });
      /* 报告里唯一可能无界的是 consoleErrors（页面反复报错时能到几千条）。
         截断并留个计数，别让 finish 那条消息被撑爆。 */
      if (out.report && typeof out.report === 'object' && Array.isArray(out.report.consoleErrors)) {
        var ce = out.report.consoleErrors;
        out.report.consoleErrors = ce.slice(0, 50).map(function (s) { return String(s).slice(0, 500); });
        if (ce.length > 50) out.report.consoleErrorsTruncated = ce.length - 50;
      }
      return out;
    }
    function finish(job) {
      settleAsk(jobId(), job, job && job._askDefault, 'end');
      if (job) job.ask = null;
      post({ op: 'finish', snapshot: summary(job) });
      activeJob = null;
    }
    function saveHistory() { post({ op: 'saveHistory' }); }
    function cancelLocal(id) {
      var jid = String(id || jobId());
      canceled[jid] = true;
      settleAsk(jid, activeJob, activeJob && activeJob._askDefault, 'cancel');
    }
    return {
      log: log, progress: progress, emit: emit, isCanceled: isCanceled,
      CanceledError: CanceledError, fail: fail, finish: finish, ask: ask,
      saveHistory: saveHistory, _cancelLocal: cancelLocal, settleAsk: settleAsk
    };
  })();

  // -------------------------------------------------------------------------
  // preview / extract / book / verify：Phase 2/4 的实现；Phase 5/6 明确报未实现
  // -------------------------------------------------------------------------
  var preview = {
    allow: function (dir) { post({ op: 'allow', path: String(dir) }); }
  };
  var extract = {
    extract: function (p) {
      return shims.invoke('extract:preview', [String(p)]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '抽取失败');
        return r.data;
      });
    }
  };
  /* book 不再是垫片：oracle 的 `book.js` 被逐字节复制进 web/logic，由 bundle 加载，
     写盘走上面那个 fs 垫片（writeFileSync + renameSync），读盘走 C++ 的 book:* 通道。 */
  var verifyRunner = {
    runProbes: function (opts) {
      return shims.invoke('verify:run', [opts || {}]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '校验失败');
        var parser = (typeof window !== 'undefined') ? window.__isgProbeParse : null;
        if (!parser) throw new Error('probe-parse.js 没加载（校验结果没法解析）');
        return parser.buildReport(r.data || {});
      });
    }
  };
  var verifyDemo = {
    checkDemos: function (arg) {
      /* 只把 id/checks 发给宿主。整份 demos 还带 markup/js，多章合并后很容易超过
         WebView2 的单条消息上限 —— 那一丢是静默的，checkDemos 会永远 settle 不了。 */
      var demos = (arg && Array.isArray(arg.demos)) ? arg.demos : [];
      var slim = demos.map(function (d) {
        return { id: d && d.id, checks: (d && Array.isArray(d.checks)) ? d.checks : [] };
      });
      var payload = { htmlPath: (arg && arg.htmlPath) || '', demos: slim };
      return shims.invoke('_verify:demo', [payload]).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || '演示核对失败');
        var parser = (typeof window !== 'undefined') ? window.__isgProbeParse : null;
        if (!parser) throw new Error('probe-parse.js 没加载（演示核对没法比较）');
        return parser.buildDemoResult(r.data || {}, demos);
      });
    }
  };

  // -------------------------------------------------------------------------
  // fetch：只做"字节搬运"，SSE 分帧仍由 oracle 的 llm/index.js 负责
  // -------------------------------------------------------------------------
  var netPending = {};
  var netSeq = 1;

  function matchProvider(url) {
    var provs = env().providers || {};
    var lower = String(url).toLowerCase();
    var best = '', bestLen = -1;
    Object.keys(provs).forEach(function (id) {
      var b = String(provs[id].baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
      if (!b) return;
      var hit = lower === b || lower.indexOf(b + '/') === 0 || lower.indexOf(b + '?') === 0;
      if (hit && b.length > bestLen) { best = id; bestLen = b.length; }
    });
    return best;
  }

  function toError(code, message) {
    /* ⚠️ EABORTED **不能**用 `name:'AbortError'`：oracle 的 buildNetworkError 会把
       AbortError 统一改写成 ETIMEOUT（非重试），于是"宿主已中止"会被当成超时，
       pipeline 的取消分支就看不到 canceled 了。这里用一个别的名字 + code='EABORTED'，
       pipeline-host 的包装层会据此补 `canceled=true`。
       ETIMEDOUT 仍用 TimeoutError（llm 层按超时处理，不重试）。
       配置类错误（EBADURL / ENO_PROVIDER）映射到 ERR_INVALID_URL —— 它在 llm 的
       FATAL_NET_CODES 里，避免为"地址配错了"白重试 3 次（约 13 秒）。 */
    if (code === 'EABORTED') {
      var a = new Error(message || '请求已取消');
      a.name = 'IsgAborted';
      a.code = 'EABORTED';
      return a;
    }
    if (code === 'ETIMEDOUT') {
      try { return new DOMException(message || '请求超时', 'TimeoutError'); }
      catch (e) { var t = new Error(message || '请求超时'); t.name = 'TimeoutError'; return t; }
    }
    var fatal = (code === 'EBADURL' || code === 'ENO_PROVIDER');
    var err = new Error(message || ('网络请求失败：' + code));
    err.code = fatal ? 'ERR_INVALID_URL' : (code || 'ENETWORK');
    err.isgCode = code;
    return err;
  }

  function fetch(url, opts) {
    opts = opts || {};
    var id = netSeq++;
    var signal = opts.signal || null;
    return new Promise(function (resolve, reject) {
      var st = { resolve: resolve, reject: reject, settled: false, controller: null,
                 aborted: false, response: null, chunks: 0 };
      netPending[id] = st;
      if (typeof window !== 'undefined') window.__isgLastFetchChunks = 0;

      function fail(why, message) {
        var e = toError(why, message);
        if (!st.settled) { st.settled = true; delete netPending[id]; reject(e); }
        else if (st.controller) { try { st.controller.error(e); } catch (x) {} }
      }
      st.fail = fail;

      if (signal) {
        var onAbort = function () {
          st.aborted = true;
          post({ kind: 'http-abort', id: id });
          fail('EABORTED');
        };
        if (signal.aborted) { onAbort(); return; }
        try { signal.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
      }

      var headers = opts.headers || {};
      var head = {};
      Object.keys(headers).forEach(function (k) {
        var v = headers[k];
        if (v != null) head[k] = String(v);
      });
      var body = opts.body;
      if (body != null && typeof body !== 'string') body = String(body);

      post({
        kind: 'http-fetch', id: id, jobId: jobId(),
        providerId: matchProvider(url),
        url: String(url), method: String(opts.method || 'GET'),
        headers: head, body: body == null ? null : body
      });
    });
  }

  function makeResponse(st, head) {
    var status = Number(head.status) || 0;
    var headerMap = head.headers || {};
    var lower = {};
    Object.keys(headerMap).forEach(function (k) { lower[k.toLowerCase()] = headerMap[k]; });
    var stream = new ReadableStream({
      start: function (controller) { st.controller = controller; },
      cancel: function () { post({ kind: 'http-abort', id: head.id }); }
    });
    return {
      ok: status >= 200 && status < 300,
      status: status,
      url: String(head.url || ''),
      redirected: !!head.redirected,
      headers: {
        get: function (name) {
          var v = lower[String(name).toLowerCase()];
          return v === undefined ? null : v;
        }
      },
      body: stream,
      text: function () {
        var reader = stream.getReader();
        var dec = new TextDecoder('utf-8');
        var out = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { out += dec.decode(); return out; }
            out += dec.decode(r.value, { stream: true });
            return pump();
          });
        }
        return pump();
      },
      json: function () { return this.text().then(function (t) { return JSON.parse(t); }); }
    };
  }

  function onHostMessage(ev) {
    var msg = ev.data;
    if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || msg.__isg !== 1) return;
    if (msg.kind === 'http-head') {
      var st = netPending[msg.id];
      if (!st) return;
      st.response = makeResponse(st, msg);
      st.settled = true;
      st.resolve(st.response);
      return;
    }
    if (msg.kind === 'http-chunk' || msg.kind === 'http-end' || msg.kind === 'http-error') {
      var s2 = netPending[msg.id];
      if (msg.kind === 'http-error') {
        if (s2) s2.fail(msg.code || 'ENETWORK', msg.message);
        delete netPending[msg.id];
        return;
      }
      if (!s2 || !s2.controller) return;   // head 之前不会发 chunk（宿主顺序保证）
      if (msg.kind === 'http-chunk') {
        try {
          var bin = atob(String(msg.data || ''));
          var u8 = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          s2.controller.enqueue(u8);
          /* 自测用：证明 SSE 真的是**跨消息块**拼出来的，而不是被合并成一个块。
             只断言最终文本无法区分"切包状态机正确"与"根本没切包"。 */
          s2.chunks++;
          if (typeof window !== 'undefined') window.__isgLastFetchChunks = s2.chunks;
        } catch (e) { /* 坏块跳过；SSE 层会报解析失败 */ }
      } else {
        try { s2.controller.close(); } catch (e) {}
        delete netPending[msg.id];
      }
    }
  }

  if (typeof window !== 'undefined' && window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener('message', onHostMessage);
  }

  return {
    fs: fs, path: path, electron: electron, skill: skill, version: version,
    store: store, jobs: jobs, preview: preview, extract: extract,
    'verify-runner': verifyRunner, 'verify-demo': verifyDemo,
    fetch: fetch,
    HOST_KEY: HOST_KEY
  };
}
