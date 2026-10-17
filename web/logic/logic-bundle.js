// 【生成物，别手改】由 tools/golden/bundle-logic.js 生成。
//
// 把 web/logic/ 下的 CommonJS 文件包成浏览器可加载的形态：**只加一层函数壳**，
// 文件内容一个字节都不改。逻辑的单一真源仍是 oracle 的 src/main/，
// 由 tools/sync-web.ps1 逐字节复制过来。
//
// 模块名用 `./名字` 这个写法，与文件里的 `require('./bank')` 直接对上。
(function (global) {
  'use strict';
  var factories = {};
  var cache = {};
  var currentEnv = null;
  var currentJobId = '';
  var nextNetId = 1;
  var shims = {
    Buffer: { byteLength: function (s) { return new TextEncoder().encode(String(s)).length; } },
    process: { platform: 'win32', env: {}, resourcesPath: '' },
    __dirname: 'C:\\isg\\apps\\isg-studio\\src\\main\\pipeline',
    post: function (o) { try { window.chrome.webview.postMessage(JSON.stringify(o)); } catch (e) {} },
    invoke: function (channel, args) { return window.__isgHost.invoke(channel, args || []); },
    getEnv: function () { return currentEnv; },
    setEnv: function (e) { currentEnv = e; },
    getJobId: function () { return currentJobId; },
    setJobId: function (id) { currentJobId = id || ''; },
    nextNetId: function () { return nextNetId++; }
  };
  var makeShims = (/* 浏览器侧垫片（**不是**从 oracle 复制的代码）。
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
);
  var shimApi = makeShims(shims);
  shims.fetch = shimApi.fetch;
  var alias = {
    "llm": "llm-index",
    "openai": "llm-openai",
    "anthropic": "llm-anthropic",
    "runner": "verify-runner",
    "demo-checks": "verify-demo"
  };
  var SHIM_IDS = ["fs","path","electron","skill","version","store","jobs","preview","extract","verify-runner","verify-demo"];
  function resolveId(name) {
    var raw = String(name == null ? '' : name).replace(/\\/g, '/');
    var base = raw.replace(/^.*\//, '').replace(/\.js$/i, '');
    var hit = alias[base];
    return hit || base;
  }
  function require(name) {
    var id = resolveId(name);
    if (SHIM_IDS.indexOf(id) >= 0) {
      if (!Object.prototype.hasOwnProperty.call(shimApi, id)) throw new Error('logic-bundle: 垫片缺模块 ' + id);
      return shimApi[id];
    }
    if (cache[id]) return cache[id].exports;
    var f = factories[id];
    if (!f) throw new Error('logic-bundle: 没有这个模块 ' + name);
    var mod = { exports: {} };
    cache[id] = mod;
    f(mod, mod.exports, require, shims);
    return mod.exports;
  }
  factories["bank"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 题库的规范化 + 校验。
 *
 * 这里的规则**逐条对齐**引擎里的 badReason()（skills/interactive-study-guide/assets/quiz-engine.js:1237）。
 * 为什么要在应用侧再写一遍：引擎遇到不合格的题是"标红跳过 + 告警"，页面不报错——
 * 对人来说这就是"题凭空少了几道"。我们必须在拼装之前就发现，并且**带着明确的指示去让模型重写**，
 * 而不是把一份残缺的页面交给用户。
 *
 * 本模块只做纯函数变换，不碰 DOM、不碰网络。
 */

/**
 * 引擎认识的全部题型——**唯一一处定义**。
 *
 * 提示词、契约、校验层都从这里取，别再各自抄一份字面量：
 * 抄散的后果是"某一处加了新题型、另一处还在拦"，而症状是题目静默少掉几道。
 * `big` 是综合大题（含 parts），其余三种是叶子题型。
 */
const KNOWN_TYPES = new Set(['single', 'multi', 'num', 'big']);
/** 大题的子题只允许这三种——引擎的 badReason() 递归时也只认它们。 */
const PART_TYPES = new Set(['single', 'multi', 'num']);

/** Unicode 上/下标 → ASCII，用于把 "2.51×10⁻⁴" 这类写法救回来。 */
const SUP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁻': '-', '⁺': '+',
};
const SUB = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₋': '-', '₊': '+',
};

function desuper(s) {
  return String(s).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, (c) => SUP[c]);
}
function desub(s) {
  return String(s).replace(/[₀₁₂₃₄₅₆₇₈₉₋₊]/g, (c) => SUB[c]);
}

/* 一个"完整的数字"：不许有多余字符。 */
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/* 单位长什么样：必须以字母/单位符号开头，且只由这些字符组成，**而且不能含阿拉伯数字**。
   "A/m"、"A·m⁻¹"、"T"、"m/s²"、"kg·m/s²"（上标不算数字）都算；
   "-3"、"/2"、"(第2步)"、"x 100"、"T=9" 都不算。

   ⚠️ **"不许含数字"这条是防前缀截断的关键**（引擎的 parseNum 早就吃过亏，见
   references/pitfalls.md 第 64 条）。反例：`"5 x 100"` 里的 "x 100" 长得像单位，
   放过去就会把 5×100 截成 5，学员答 500 永远判错。凡带数字的尾巴，一律当"写法看不懂"退回。 */
const UNIT_RE = /^[A-Za-zΩμ°%][A-Za-zΩμ°%·⋅^*⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺₀₁₂₃₄₅₆₇₈₉/()\s.\-]*$/;

/** 把各种"人写的数字"归一成 ASCII 的纯数字串。返回 null 表示**看不懂**（而不是"算错了"）。 */
function cleanNumeric(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (!t) return null;
  // 十六/八/二进制前缀：一律不认（"0x10" 被截成 0 会把错答判对）
  if (/^[+-]?0[xXbBoO]/.test(t)) return null;
  // 各种 Unicode 减号 / 全角负号
  t = t.replace(/[−–—－]/g, '-').replace(/＋/g, '+');
  // 全角数字与全角句点
  t = t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/g, '.');
  // 千分位分隔优先（1,234,567）——判据是"整串就是 1~3 位 + 若干组 3 位"
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(/(\d),(\d)/g, '$1.$2'); // 否则逗号当小数点（欧洲写法 1,06）
  // 上标/乘方写法 → e 记法。**必须在 desuper 之前做**，否则分不清 "10⁻⁴"（乘方）与 "100"（就是一百）。
  // 只认两种明确形态：`×10` 后面跟**上标数字**，或 `×10^` 后面跟普通指数。
  // `5 x 100` 两种都不匹配，于是会留成 "5 x 100"，最终被当作"写法看不懂"退回——
  // 这正是我们要的（以前它被当成 5×10^0 = 5，学员答 500 永远判错）。
  t = t
    .replace(/\s*[×xX*⋅]\s*10\s*([⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (m, sup) => 'e' + desuper(sup))
    .replace(/\s*[×xX*⋅]\s*10\s*\^\s*([+-]?\d+)/g, 'e$1')
    // `×10-4`（没写尖号）：只能靠"10 后面直接跟正负号"来认，而这个形状不可能出现在
    // "5 x 100" 里（100 后面没有符号），所以不会误伤那条。
    .replace(/\s*[×xX*⋅]\s*10\s*([+-]\d+)/g, 'e$1')
    .replace(/\s10\s*\^\s*([+-]?\d+)/g, 'e$1');
  // ⚠️ 这里**故意不 desuper 整串**：上标是"单位"的一部分（`kg·m/s²`），
  // 也是"乘方"的一部分（`10⁻⁴`，上一段已经吃掉）。如果在这里把 ² 变成 2，
  // 单位的字母表里就混进了 ASCII 数字，"不许含数字"那条规则会把合法单位一起误杀。
  // 数字中间的空格（"1 000 000"）
  t = t.replace(/(\d)\s+(\d)/g, '$1$2');
  return t.trim();
}

/**
 * 尽力把一个值变成有限的数字。失败返回 null（**绝不猜**）。
 * 认：200 / "200" / "2.51e-4" / "2.51×10⁻⁴" / "2.51*10^-4" / "1,06" / "1,234,567" /
 *     "1.06 T" / "200 A/m" / "−5"（各种负号）/ "１５"（全角）
 * 不认（返回 null，当作"这个写法看不懂"）：5-3 / 1/2 / 2+3 / "5 T=9" / 1.2.3 / 0x10 / 1e
 */
/**
 * 把一串"人写的数字"切成 { 数值, 单位 }。看不懂返回 null。
 *
 * **coerceNumber 与 extractUnit 必须共用这一个函数**：它们以前各写一套判据，
 * 于是同一个输入会出现"值取不到、单位却取到了"这种自相矛盾的结果
 * （实测 `extractUnit("1e")` 返回 "e"，而 `coerceNumber("1e")` 返回 null）——
 * 上层拿这个单位显示给学员看，就会显示成单位 "e"。
 */
function splitNumUnit(v) {
  if (typeof v !== 'string') return null;
  const t = cleanNumeric(v);
  if (t == null) return null;
  if (NUM_RE.test(t)) {
    const n = Number(t);
    return isFinite(n) ? { n, u: '' } : null;
  }
  // 数字 + 单位：整串必须**恰好**是「数字」+「像样的单位」，多一个字符都不行
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S[\s\S]*)$/);
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest) {
    const n = Number(m[1]);
    return isFinite(n) ? { n, u: '' } : null;
  }
  if (!UNIT_RE.test(rest) || rest.length > 16) return null;
  // "1e" / "5e-" / "5e+" / "1ee" 都是写坏的科学计数法，不是"5 艾"之类——绝不能猜成 5。
  // 判据：整个"单位"只由 e/E 与正负号组成（真单位不会长这样）。
  if (/^[eE+\-]+$/.test(rest)) return null;
  const n = Number(m[1]);
  return isFinite(n) ? { n, u: rest } : null;
}

function coerceNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const r = splitNumUnit(v);
  return r ? r.n : null;
}

/** 从 "2.51×10⁻⁴ T" 里取出单位 "T"（取不到返回 ''）。判据与 coerceNumber 完全一致。 */
function extractUnit(v) {
  const r = splitNumUnit(v);
  return r ? r.u : '';
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 规范化一段题库。就地改传入的对象副本，返回 {items, fixes, issues}。
 *   fixes  —— 我们**自动改好**的地方（会写进日志，让用户知道模型哪里没按规矩来）
 *   issues —— 我们**改不了**的，必须回灌给模型重写
 */
function normalizeBank(rawItems, opts) {
  const o = opts || {};
  const lv = o.lv; // 这一段的关卡号，由我们定，不采信模型写的
  const ns = o.namespace || ''; // id 前缀，保证跨单元唯一
  const fixes = [];
  const issues = [];
  const items = [];

  if (!Array.isArray(rawItems)) {
    return { items: [], fixes, issues: [{ code: 'not-array', message: 'bank 不是数组' }] };
  }

  const seen = new Set();
  const seenSlash = o.seenIds instanceof Set ? o.seenIds : new Set();

  rawItems.forEach((raw, idx) => {
    const at = `第 ${idx + 1} 道`;
    if (!isPlainObject(raw)) {
      issues.push({ code: 'not-object', at, message: `${at}不是一个对象` });
      return;
    }
    const q = JSON.parse(JSON.stringify(raw));
    q.lv = lv;

    // id：加命名空间前缀，并保证全局唯一（引擎遇到重复 id 会自动改名并告警，
    // 那会让两题共用一个存盘键，所以我们在上游就断掉这个可能）
    let base = String(q.id == null ? '' : q.id).trim();
    if (!base) {
      base = 'q' + (idx + 1);
      fixes.push({ at, message: '模型没给 id，已自动补 ' + base });
    }
    base = base.replace(/[^\w\-.]/g, '-');
    let id = ns ? `${ns}-${base}` : base;
    if (seen.has(id) || seenSlash.has(id)) {
      let n = 2;
      while (seen.has(id + '-' + n) || seenSlash.has(id + '-' + n)) n++;
      fixes.push({ at, message: `id 重复（${id}），已改名为 ${id}-${n}` });
      id = id + '-' + n;
    }
    q.id = id;
    seen.add(id);
    seenSlash.add(id);

    if (q.type === 'big') {
      if (!Array.isArray(q.parts) || !q.parts.length) {
        issues.push({ code: 'big-no-parts', at, id, message: `${at}（${id}）是 big 类型但没有 parts` });
        return;
      }
      q.parts = q.parts
        .map((p, i) => {
          const pp = isPlainObject(p) ? Object.assign({}, p) : {};
          pp.type = pp.type || 'single';
          const ok = normalizePart(pp, `${at} 第 ${i + 1} 步`, id, i, issues, fixes);
          if (ok && (typeof ok.stem !== 'string' || !ok.stem.trim())) {
            // 没有题干的小问会在页面上渲染成一张**空白卡片**：引擎的 badReason 不查 stem，
            // 探针也查不出来（它只看 id 与判分），学员只会看到一张点不动的空题。
            issues.push({ code: 'part-no-stem', at, id, message: `${at} 第 ${i + 1} 步没有题干 stem（会渲染成一张空白题卡）` });
            return null;
          }
          return ok;
        })
        .filter(Boolean);
      if (!q.parts.length) {
        issues.push({ code: 'big-empty-parts', at, id, message: `${at}（${id}）的 parts 全部不合格` });
        return;
      }
      // 引擎会把每个小问的 id 自动生成为 `<大题id>-<步号>`，那也当存盘键用。
      // 这里必须一并登记：否则题库里另有一道普通题叫 "big1-1" 时会撞车，引擎只能靠自动改名兜住，
      // 而 id 一改，学员的作答记录就对不上了（见 pitfalls 第 70 条）。
      q.parts.forEach((_, i) => {
        const pid = `${id}-${i + 1}`;
        if (seen.has(pid) || seenSlash.has(pid)) {
          issues.push({
            code: 'big-step-id-clash',
            at,
            id,
            message: `${at}（${id}）的第 ${i + 1} 步占用的 id「${pid}」与题库里另一道题撞车，请改掉那道题的 id`,
          });
        }
        seenSlash.add(pid);
      });
    } else {
      const ok = normalizePart(q, at, id, null, issues, fixes);
      if (!ok) return;
      Object.assign(q, ok);
    }

    if (typeof q.stem !== 'string' || !q.stem.trim()) {
      issues.push({ code: 'no-stem', at, id, message: `${at}（${id}）没有题干 stem` });
      return;
    }
    items.push(q);
  });

  return { items, fixes, issues };
}

function normalizePart(p, at, parentId, partIndex, issues, fixes) {
  const type = p.type;
  if (!['single', 'multi', 'num'].includes(type)) {
    // 大题里的小题也允许再嵌 big？引擎的 badReason 递归时只认 single/multi/num，
    // 所以这里也只在三者里取值；缺省按单选处理，交给后面的校验兜底。
    if (type === 'big') {
      issues.push({ code: 'nested-big', at, message: `${at} 不允许再嵌 big 大题` });
      return null;
    }
    fixes.push({ at, message: `type「${type === undefined ? '没写' : type}」不认识，已按 single 处理` });
    p.type = 'single';
  }

  if (p.type === 'single' || p.type === 'multi') {
    if (!Array.isArray(p.opts)) {
      issues.push({ code: 'no-opts', at, message: `${at} 没有选项 opts 数组` });
      return null;
    }
    const opts = [];
    p.opts.forEach((oo, i) => {
      if (typeof oo === 'string') {
        // 模型偶尔把选项写成裸字符串数组 —— 救得回来（但没有 why，要提示）
        fixes.push({ at, message: `选项 ${i + 1} 是裸字符串，已转成对象（该选项没有 why 解释）` });
        opts.push({ t: oo, ok: false, why: '' });
        return;
      }
      if (!isPlainObject(oo)) {
        issues.push({ code: 'bad-opt', at, message: `${at} 的第 ${i + 1} 个选项不是对象` });
        return;
      }
      const o2 = { t: String(oo.t == null ? '' : oo.t), why: String(oo.why == null ? '' : oo.why) };
      o2.ok = oo.ok === true || oo.ok === 'true' || oo.ok === 1;
      if (oo.ok !== undefined && oo.ok !== true && oo.ok !== false && oo.ok !== 'true' && oo.ok !== 1 && oo.ok !== 0) {
        fixes.push({ at, message: `选项 ${i + 1} 的 ok 是「${oo.ok}」，已按 ${o2.ok} 处理` });
      }
      opts.push(o2);
    });
    p.opts = opts;

    if (opts.length < 2) {
      issues.push({ code: 'opts-too-few', at, id: parentId, message: `${at} 的选项不足两个（现在 ${opts.length} 个）` });
      return null;
    }
    if (opts.some((x) => !x.t.trim())) {
      issues.push({ code: 'empty-opt', at, id: parentId, message: `${at} 有选项文字是空的` });
      return null;
    }
    const okN = opts.filter((x) => x.ok).length;
    if (!okN) {
      issues.push({ code: 'no-correct', at, id: parentId, message: `${at} 没有任何一个选项标了 ok:true` });
      return null;
    }
    if (p.type === 'multi' && okN < 2) {
      // 契约 §1.4.3：多选至少两个正确项。只标一个的多选会退化成单选（勾一个也对、勾两个也错），
      // 学员按"多选"的心态去做必然做不对，而页面不会给任何提示。
      issues.push({
        code: 'multi-too-few-ok',
        at,
        id: parentId,
        message: `${at} 是 multi 多选，但只有 ${okN} 个正确项（至少要 2 个；只有一个正确项就应改用 type:"single"）`,
      });
      return null;
    }
    if (p.type === 'single' && okN > 1) {
      // 这条能自动救：把多出来的正确项降级会**改变答案**，绝不能自作主张。
      issues.push({
        code: 'single-multi-ok',
        at,
        id: parentId,
        message: `${at} 是单选却标了 ${okN} 个正确项——要么改成 type:"multi"，要么只留一个 ok:true`,
      });
      return null;
    }
    if (opts.some((x) => x.ok && !x.why.trim())) {
      fixes.push({ at, message: '有正确选项没写 why 解释（学生答对后看不到"为什么对"）' });
    }
    return p;
  }

  // num
  if (p.ansText != null) {
    if (!Array.isArray(p.ansText) || !p.ansText.length || p.ansText.some((x) => typeof x !== 'string' || !x.trim())) {
      issues.push({ code: 'bad-anstext', at, id: parentId, message: `${at} 的 ansText 要写成非空字符串数组，如 ["A/m","A·m⁻¹"]` });
      return null;
    }
    p.ansText = p.ansText.map((x) => String(x).trim());
    return p;
  }

  if (typeof p.ans === 'number') {
    if (!isFinite(p.ans)) {
      issues.push({ code: 'ans-not-finite', at, id: parentId, message: `${at} 的 ans 不是有限数字（NaN/Infinity）` });
      return null;
    }
  } else {
    const n = coerceNumber(p.ans);
    if (n == null) {
      issues.push({
        code: 'ans-not-number',
        at,
        id: parentId,
        message: p.ans === undefined
          ? `${at} 没写 ans（填数题必须有数字答案）`
          : `${at} 的 ans 必须是数字，现在是 ${JSON.stringify(p.ans)}（2.51×10⁻⁴ 要写成 2.51e-4）`,
      });
      return null;
    }
    // 救得回来就救，并顺手把答案里的单位搬进 unit（模型很爱把单位写在 ans 里）
    const u = extractUnit(p.ans);
    if (u && !p.unit) {
      p.unit = u;
      fixes.push({ at, message: `ans 里带着单位「${u}」，已搬到 unit 字段` });
    }
    fixes.push({ at, message: `ans 写成了 ${JSON.stringify(p.ans)}，已转成数字 ${n}` });
    p.ans = n;
  }

  if (p.tol != null) {
    // tol 只接受**纯数字**，不接受带单位的写法。`tol:"1%"` 被 coerceNumber 救成 1 是危险的：
    // 1% 是相对容差的意思，当成绝对容差 1 就意味着 ans=300 时 ±1 都算对，**错答会被判成对**。
    const raw = typeof p.tol === 'string' ? p.tol.trim() : p.tol;
    const t = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) ? Number(raw) : null;
    if (t == null || t < 0) {
      issues.push({ code: 'bad-tol', at, id: parentId, message: `${at} 的 tol 要是非负数字，现在是 ${JSON.stringify(p.tol)}` });
      return null;
    }
    p.tol = t;
  }
  if (p.unit != null && typeof p.unit !== 'string') p.unit = String(p.unit);
  return p;
}

/** 数一段题库里的"作答点"数（big 按 parts 数算），用于核对总量与占比。 */
function countPoints(items) {
  let n = 0;
  const byType = { single: 0, multi: 0, num: 0, big: 0 };
  for (const q of items) {
    if (q.type === 'big') {
      byType.big++;
      n += (q.parts || []).length;
    } else {
      byType[q.type] = (byType[q.type] || 0) + 1;
      n++;
    }
  }
  return { total: n, byType };
}

module.exports = {
  normalizeBank, coerceNumber, extractUnit, countPoints, desuper, desub,
  KNOWN_TYPES, PART_TYPES,
};

/*__ISG_BUNDLE_END__*/};
  factories["assemble"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 确定性拼装：把「模型产出的片段」塞进 skill 的骨架页。
 *
 * 这是整个应用里最要紧的一条设计：**页面永远不由模型写**。
 * 模型只产出
 *   · 每个单元的讲解正文片段（inner HTML，不含 <section> 外壳）
 *   · 每个单元/综合单元的题库（结构化 JSON）
 *   · 若干演示的标记 + JS
 * 引擎、样式、吸顶条、结算区、陪练块一律原样来自 page-skeleton.html。
 * 这样 SKILL.md 里"最致命的六个坑"（尾逗号、script 顺序、DOM 缺失…）在结构上就不可能发生。
 *
 * 拼装哲学照抄 skill 的规矩：**凡拼接必断言**。锚点找不到就抛错，
 * 绝不允许静默产出一份"看起来还行、其实少了半个单元"的页面。
 *
 * ── 这一版针对"模型输出是敌意的"做了三处加固（每处都有实测的复现）──
 *   1. 写进 script 的东西一律转义（jsonForScript / jsForScript）。
 *      原来 `<!--` 会被转成 `<\!--`，那是**非法 JSON**，引擎 JSON.parse 抛错后
 *      整段题库静默消失；finalAdvice / 演示 js 里的 `</script>` 更会把引擎提前闭合、
 *      整页没有任何 JS，而任务照报"完成"。
 *   2. 引擎区间的替换**只在引擎区间里做**。正文不可信，它可能"引用"骨架配置原文，
 *      全局 replace 会改到正文那处、放过引擎里真正该改的那处（症状：用户选了"不要陪练"，
 *      右下角还是冒出陪练，且一声不响）。
 *   3. 断言失败时的报错要把"嫌疑指向模型正文"说清楚，别再一律怪骨架页被改过。
 */

const { normalizeBank, countPoints } = require('./bank');

/** 骨架页里我们用到的全部锚点。任何一条失配都会让拼装立刻失败。 */
const MARK = {
  title: /<title>([\s\S]*?)<\/title>/,
  header: /<header class="top">[\s\S]*?<\/header>/,
  // 正文区：从"讲：知识块写在这里"的注释到结算区之前
  contentStart: '  <!-- 讲：知识块写在这里（从《拆解手册》整节搬过来即可） -->',
  contentEnd: '  <section id="result">',
  bankBlock: /<script data-bank id="bank0" type="application\/json">[\s\S]*?<\/script>/,
  pageKey: /(\n\s*)key:'chXX-study-guide-v1',/,
  finalAdvice: /(\n\s*)finalAdvice:'',/,
  petImages: /petImages:\[[^\]]*\]/,
  bgImages: /bgImages:\[[^\]]*\]/,
  demoSlot: '/* ================= 章专用演示：把本章的演示 IIFE 放在这里 =================',
  demoSlotEnd: '/* ---------------- 收尾 ---------------- */',
  footer: /<footer>[\s\S]*?<\/footer>/,
  engineOpen: '<script id="engine">',
};

/**
 * 断言某段文本恰好出现 1 次。
 *
 * 出现 0 次 = 骨架页被改过（锚点过期）；出现 2 次以上 = **多半是模型正文里抄了骨架原文**。
 * 两者要分开说，否则用户会拿着"骨架页被改过"的错误线索去翻一个没问题的文件。
 */
function assertOnce(haystack, needle, what) {
  const n = haystack.split(needle).length - 1;
  if (n === 1) return;
  if (n > 1) {
    throw new Error(
      `拼装失败：全页里「${what}」出现了 ${n} 次，应该只有 1 次。` +
        '最常见的成因是**模型在讲解正文里抄了骨架页的片段**（例如把一段配置当例子贴出来）。'
    );
  }
  throw new Error(
    `拼装失败：全页里找不到「${what}」。这通常意味着 ` +
      'skills/interactive-study-guide/assets/page-skeleton.html 被改过，' +
      '请对照 apps/isg-studio/docs/architecture.md 更新 assemble.js 的锚点。'
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把 JSON 安全地放进 script。
 *
 * **做法是把每一个 `<` 都转成 <** —— 这是合法 JSON 转义，JSON.parse 会还原成 `<`。
 * 为什么不用别的写法（都踩过）：
 *   · `</script` → `<\/script` 是对的（`\/` 是合法 JSON 转义）；
 *   · 但 `<!--` → `<\!--` **不是合法 JSON**（JSON 没有 `\!` 这个转义），JSON.parse 直接抛
 *     "Bad escaped character" → 引擎把它 catch 掉 → **那一整段题库的题凭空消失**，
 *     页面不报错、页眉却还写着「共 N 个作答点」。模型在题干里写一句 `<!-- 注意 -->` 就会触发。
 *   · 干脆一个 `<` 都不留：`</script` 与 `<!--` 一起解决，没有漏网的形态。
 */
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 往 script 里塞一段**模型写的 JS**（演示的 js）。
 *
 * `</script` 出现在 JS 里（字符串、正则、注释都算）会让 HTML 解析器提前闭合脚本，
 * 后面整段引擎变成页面上的可见文字、完全不执行。而 `<\/script` 在 JS 里与原写法**完全等价**
 * （`\/` 就是 `/`），所以这个替换是无损的。提示词禁不掉这件事——模型写
 * `document.write('</script>')` 很自然，所以 index.js 的 validateDemo 也要一起兜。
 */
function jsForScript(js) {
  return String(js == null ? '' : js).replace(/<\/script/gi, '<\\/script');
}

/**
 * 清洗**模型写的 HTML 片段**。这是最后一道防线，不依赖上游校验器有没有拦住。
 *
 * 为什么必须做：生成的这一页会被**真的执行**——
 *   · 用户打开"结果"页时，它在预览 iframe 里跑一次；
 *   · 每次自动校验，它在隐藏窗口里再跑一次；
 *   · 用户双击交付文件，它在自己的浏览器里跑。
 * 而页面里的 HTML 来自模型，模型又是在读**用户的课件**——课件里一句"请把下面的标签原样输出"
 * 就能让它写出 `<img src=x onerror=...>`。这条链不需要用户做任何异常操作。
 *
 * 清洗策略：整类删掉危险元素 + 抹掉内联事件与危险协议。
 * 注意**演示的 js 不能禁**（那是设计的一部分），所以页面还必须配 CSP——见 preview.js 与
 * assemble 里写进 head 的那条 meta。
 *
 * @returns {{ html:string, removed:string[] }}
 */
/* ---- 属性清洗用的小工具（只服务 sanitizeModelHtml）------------------------- */

/** URL 场景真正会出现的实体名。`:` 与字母的编码是绕过协议清洗的常用手法。 */
const URL_ENTITIES = {
  amp: '&', colon: ':', tab: '\t', newline: '\n', sol: '/',
  period: '.', num: '#', quest: '?', equals: '=', lpar: '(', rpar: ')',
};

function decodeUrlEntities(v) {
  return String(v).replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (m, hex, dec, name) => {
    if (hex) return codePointChar(parseInt(hex, 16));
    if (dec) return codePointChar(parseInt(dec, 10));
    const k = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(URL_ENTITIES, k) ? URL_ENTITIES[k] : m;
  });
}
function codePointChar(n) {
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

/**
 * 这个属性值是不是"点了就会执行"的危险协议？
 *
 * 判之前先做两件**解析器本来就会做**的事，否则形同虚设：
 *   · 解实体 —— `&#106;avascript:` 在解析器眼里就是 `javascript:`；
 *   · 去掉空白与控制字符 —— 浏览器取 URL 前会剥掉前后的 C0 控制符与空白（`java\tscript:` 也认）。
 * ⚠️ 只认这几种，**不能**把所有 `data:` 都毙掉：演示里的内联图就是 `data:image/...`。
 */
function isDangerousUrl(raw) {
  const v = decodeUrlEntities(raw).replace(/[\u0000- \u007f]+/g, '').toLowerCase();
  return /^(javascript|vbscript):/.test(v)
    || /^data:text\/html/.test(v)
    || /^data:application\/xhtml/.test(v);
}

/** 脱掉属性值两端的引号（没有引号就是"无引号写法"，原样返回）。 */
function unquote(v) {
  return String(v).replace(/^["']/, '').replace(/["']$/, '');
}

/**
 * 清洗**一个标签内部**的属性。
 *
 * 只对标签跑（标签外是正文），所以不会像"对整段文本跑属性正则"那样把正文里的
 * `online=1`、`H/one=1` 当成内联事件删掉。`kinds` 由调用方传入，记录清掉了哪几类。
 */
function scrubTagAttrs(tag, kinds) {
  let t = tag;
  const sub = (re, repl, label) => {
    const before = t;
    t = t.replace(re, repl);
    if (t !== before) kinds.add(label);
  };

  // 内联事件：onclick= / onerror= / onload= …
  // 分隔符不能只认空白：HTML 解析器把 `/`（以及紧随引号的下一个字符）也当属性分隔符，
  // 所以 `<img src=x/onerror=…>` 与 `<img src="x"onerror=…>` 里的属性**照样生效**。
  sub(/([\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1', '内联事件（on*=）');

  // 危险协议：带引号 / 无引号 / 字母被实体编码 —— 三种写法都要认
  sub(
    /([\s/"'])(href|src|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, name, raw) => (isDangerousUrl(unquote(raw)) ? pre + name + '="#"' : m),
    'javascript:/vbscript:/data:text-html 链接'
  );

  // 外链资源（页面必须零外部请求，离线也要能看）
  sub(
    /([\s/"'])(src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, name, raw) => (/^(?:https?:)?\/\//i.test(unquote(raw).trim()) ? pre + name + '="#"' : m),
    '外链资源'
  );
  sub(/([\s/"'])srcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1', '外链资源');
  sub(
    /([\s/"'])style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, raw) => {
      const q = /^["']/.test(raw) ? raw[0] : '';
      const v = unquote(raw);
      const cleaned = v.replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*['"]?\s*\)/gi, 'none');
      return cleaned === v ? m : pre + 'style=' + q + cleaned + q;
    },
    '外链资源'
  );
  return t;
}

function sanitizeModelHtml(input) {
  let s = String(input == null ? '' : input);
  const removed = [];
  const drop = (re, label) => {
    const before = s;
    s = s.replace(re, '');
    if (s !== before) removed.push(label);
  };
  // 整类删掉的元素（这些在"讲练一体"页面里没有任何正当用途）
  drop(/<script\b[\s\S]*?<\/script\s*>/gi, '<script>');
  drop(/<script\b[^>]*\/?>/gi, '<script>');
  drop(/<\/script\s*>/gi, '</script>');
  drop(/<style\b[\s\S]*?<\/style\s*>/gi, '<style>');
  drop(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '<iframe>');
  drop(/<iframe\b[^>]*\/?>/gi, '<iframe>');
  drop(/<object\b[\s\S]*?<\/object\s*>/gi, '<object>');
  drop(/<embed\b[^>]*\/?>/gi, '<embed>');
  drop(/<base\b[^>]*\/?>/gi, '<base>');
  drop(/<meta\b[^>]*\/?>/gi, '<meta>');
  drop(/<link\b[^>]*\/?>/gi, '<link>');
  drop(/<form\b[\s\S]*?<\/form\s*>/gi, '<form>');
  drop(/<form\b[^>]*\/?>/gi, '<form>');
  // ⚠️ <input> / <button> / <canvas> **不能整体删**：演示的滑块就是 <input type="range">、
  //    预设按钮就是 <button>——它们是这个页面的核心控件（实测误删过一次，症状是
  //    「演示的滑块不见了、读数全是 —」）。真正要防的是「能执行代码」与「能往外发东西」，
  //    那两类已经在上面 + 下面的事件/协议清洗里覆盖了。

  /* ---- 属性级清洗：**只在标签内部**做 ----
     ⚠️ 为什么必须先切出标签，而不是对整段文本跑正则：
     "属性名边界"判据（`on` 前面是空白 / `/` / 引号）在**标签外的正文**里也会命中普通文字。
     实测 `<p>把 online=1 填进去</p>` → `<p>把  填进去</p>`：` online=` 前面正好是空白，
     `on` 接上 `line` 又正好凑成 `on[a-z]+`，于是正常文字连同它的值一起被删掉了。 */
  const kinds = new Set();
  s = s.replace(/<[^<>]*>/g, (tag) => scrubTagAttrs(tag, kinds));
  for (const k of kinds) removed.push(k);
  return { html: s, removed };
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text || '')
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n');
}

/**
 * 把两种入参形状归一成 `[{ chapter, units, demos }]`。
 *
 * 为什么要归一而不是直接要求新形状：`{chapter, units, demos}` 的单章形状是**存量调用方**
 * （index.js 的 assembleInput、test/hostile-input.js 的 base()）在用的，改形状会让它们全炸。
 */
function toChapters(input) {
  if (Array.isArray(input.chapters)) {
    if (!input.chapters.length) throw new Error('拼装失败：chapters 是空的');
    return input.chapters.map((c) => ({
      chapter: (c && c.chapter) || {},
      units: (c && c.units) || [],
      demos: (c && c.demos) || [],
      // 这一章**单独成页**时用的存盘键（见「进度搬家」那段）：一章并进一册时，
      // 学员在那一章单独页面里做过的题就存在这个键下。老的单章形状没有它。
      key: String((c && c.key) || ''),
    }));
  }
  // 老的单章形状：chapter/units/demos 都在顶层
  return [{ chapter: input.chapter || {}, units: input.units || [], demos: input.demos || [], key: '' }];
}

/** 目录与正文里的章标题（如「第 13 章 · 磁介质」）。 */
function chapterLabel(chapter, index) {
  const num = chapter && chapter.number ? `第 ${chapter.number} 章` : `第 ${index + 1} 章`;
  const title = String((chapter && chapter.title) || '').trim();
  return [num, title].filter(Boolean).join(' · ');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一个单元的题库在给定 namespace 下**会得到哪些 id**。
 *
 * ⚠️ 这里刻意把 bank.js:169-175 的"id 前缀规则"抄了一份：我们要在**调用 normalizeBank 之前**
 * 判断"加了 ns0 之后会不会撞车"，而 normalizeBank 只在已经撞了之后才把冲突**静默改名**
 * （记一条 fix 就过去了）。等到那时候再改就已经晚了——它的 id 已经进了 items。
 * 规则一旦在 bank.js 里改了，这里必须跟着改（两边都只做 `[^\w\-.]` → `-` 再拼前缀）。
 */
function prospectiveIds(bank, ns) {
  const out = [];
  (Array.isArray(bank) ? bank : []).forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    let base = String(raw.id == null ? '' : raw.id).trim() || 'q' + (idx + 1);
    base = base.replace(/[^\w\-.]/g, '-');
    out.push(ns ? ns + '-' + base : base);
  });
  return out;
}

/** 演示 id 只在 `demoA…demoZ` 这 26 个槽里取（引擎与契约约定的 id 空间）。 */
function nextFreeDemoId(used) {
  for (let i = 0; i < 26; i++) {
    const id = 'demo' + String.fromCharCode(65 + i);
    if (!used.has(id)) return id;
  }
  return '';
}

/**
 * 一道题自身 + 它的子问（big 的 parts）—— 凡是"带 id 的作答点"都在这里。
 * 页面上的题卡 id 是 `q-<顶层 id>`（quiz-engine.js:1159），子问不再单独占 id。
 */
function endpointsOf(q) {
  return q && q.type === 'big' ? q.parts || [] : [q];
}

/**
 * 把一个演示的**整族 id**（`demoA`、`demoA-r`、`demoA-rv`…）从 oldId 改名到 newId。
 *
 * 为什么要连 js 一起改，而不是只改元素上的 id：多章拼在一起时，两章的演示很可能都叫
 * `demoA`（模型每章独立生成，取名习惯一样）。同一个文档里出现两套同名 id 的后果是
 * `getElementById` 只返回第一个 → 第二章的滑块拖了没反应、读数永远不动，**页面上什么都不报**。
 * 而只改元素 id、不改 js 里对它的引用更糟：演示直接 `getElementById` 拿到 null，整块不显示。
 *
 * 只改三类**确实是 id 引用**的位置，不做全局文本替换：演示 id 可能是个普通词（`demo`），
 * 全局替换会把 CSS 类名 `demo-head` / `demo-body` 一起改花。
 *   ① HTML 的 id 引用型属性：id= / for= / list= / form= / aria-controls= …
 *   ② 选择器字符串里的 `#demoA…`
 *   ③ js 里**整段就是 id 本身或它的派生 id** 的字符串字面量：'demoA' / 'demoA-r'
 */
function renameDemoIds(text, oldId, newId) {
  let out = String(text == null ? '' : text);
  if (!oldId || !newId || oldId === newId) return out;
  const o = escapeRe(oldId);
  const n = newId;
  out = out.replace(
    new RegExp(
      '(\\b(?:id|for|list|form|headers|aria-controls|aria-labelledby|aria-describedby|aria-owns|aria-flowto)\\s*=\\s*["\'])'
        + o + '(?=[-"\'\\s])',
      'gi'
    ),
    (m, pre) => pre + n
  );
  out = out.replace(
    new RegExp('(["\'])#' + o + '(?=[\\s.#:>\\[,"\']|$)', 'g'),
    (m, q) => q + '#' + n
  );
  out = out.replace(
    new RegExp('(["\'])' + o + '(?=[-"\'\\]\\)\\.,;]|$)', 'g'),
    (m, q) => q + n
  );
  return out;
}

/* ================= 进度搬家（多章合成一册时） =================
 *
 * 要解决的问题：引擎把做题进度放在 `localStorage[PAGE.key]` 下，形状是 `{pts:{…}, ui:{…}}`。
 * 学员很可能在**某一章单独成页**时做过题——那份页面的键是**那一章自己的**（`chapters[i].key`）。
 * 合并成一册之后，册用的是另一个键（调用方给的 pageKey），于是那一章在册里**看不见进度了**
 * ——记录其实还在 localStorage 里，只是新页面里没有任何一道题再引用它（症状与"进度清零"一样）。
 *
 * 怎么搬：多章合并的设计是"作答点 id 不撞不改"（冻结章的 id 一个字不动），所以绝大多数情况下
 * **把整个 `pts` 从旧键拷到新键**就够了，不用动任何 id。
 * 只有"两章各自独立生成、撞了 id、其中一章被加了 `c<章序号>-` 前缀"（见上面 namespace 那段）时
 * 才需要一张 id 映射表 —— 那张表就在 namespace 决策处顺手记下来（`namespace !== rawAnchor`），
 * 不是猜的。冻结章与没撞车的章一律 `map:{}`（= 整键拷贝）。
 *
 * ⚠️ 两条必须写清楚、也写进了页面注释里的事：
 *   1. **跨 origin 不通**：应用内预览走 `isg://local`、双击交付文件走 `file://`，
 *      两者 localStorage **不同源**，这段脚本只在"同一个源里"有效。
 *      所以**任何文案都不该承诺"进度一定在"**。
 *   2. **旧键不删**：用户可能还在用那份单章页面（甚至已经把它转发给别人）。
 *      删掉旧键会让那份页面的进度凭空消失，而这里一点好处都没有。
 */

/** 载荷指纹：各来源键排序后拼起来做个小哈希（FNV-1a），同一个册/同一批来源恒定。 */
function migrationFingerprint(keys) {
  const s = keys.join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'mig-' + h.toString(36);
}

/**
 * 生成搬家**载荷**（纯数据，注入前不碰页面）。
 *
 * @returns {{id:string,targetKey:string,sources:Array<{key:string,map:object}>}|null}
 *   `null` = 不需要搬家（只有一章、或者各章的键与册的键相同）→ **一个字节都不注入**。
 */
function progressMovePayload(chapterInfos, slots, normalized, pageKey, multi) {
  if (!multi) return null; // 单章：产出必须与"支持搬家之前"逐字节一致
  const sources = [];
  for (const info of chapterInfos) {
    const key = String(info.key || '');
    if (!key || key === pageKey) continue; // 这一章的进度本来就在册的键下
    const map = {};
    for (const s of slots) {
      if (s.info !== info) continue;
      const ns = s.namespace;
      // 没改名（冻结章 ns 是空串；没撞车的章 ns === rawAnchor）→ map 留空 = 整个 pts 直接拷贝
      if (!ns || ns === s.rawAnchor) continue;
      const pre = ns + '-';
      for (const q of normalized[s.lv] || []) {
        if (!q || typeof q.id !== 'string' || q.id.lastIndexOf(pre, 0) !== 0) continue;
        /* 新 id = `<新命名空间>-<模型写的 id>`，而**那一章单独成页时**用的是它自己的命名空间
           （= rawAnchor，见 slots 那段）：旧 id = `<rawAnchor>-<模型写的 id>`。
           ⚠️ 不能反过来"从新 id 上剥掉新前缀"当作旧 id —— 那剥下来的是模型写的那个 id，
           在册里长这样：新前缀 `c2-u1-`、旧 id 其实是 `u1-q1`，剥出来却成了 `q1`，
           于是 map 里一个键都对不上，旧记录会**原样留在旧 id 上**（看着像"搬了"，其实一道题都没接上）。 */
        const base = q.id.slice(pre.length);
        const oldId = s.rawAnchor ? s.rawAnchor + '-' + base : base;
        map[oldId] = q.id;
        // 大题的小问在引擎里是 `<大题 id>-<步号>`（quiz-engine.js:1290），也一并映射，
        // 否则大题做过的每一步都会留在旧键下、在册里显示成"没做"。
        if (q.type === 'big' && Array.isArray(q.parts)) {
          for (let i = 1; i <= q.parts.length; i++) map[oldId + '-' + i] = q.id + '-' + i;
        }
      }
    }
    sources.push({ key, map });
  }
  if (!sources.length) return null;
  sources.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // 与章顺序无关的稳定输出
  return {
    id: migrationFingerprint(sources.map((s) => s.key)),
    targetKey: pageKey,
    sources,
  };
}

/**
 * 把载荷包成一段 `<script>`。**位置必须在 `<script id="engine">` 之前**：
 * 引擎在脚本解析时就把 `localStorage[KEY]` 读成快照了（quiz-engine.js:34-38），晚一步跑等于没跑。
 *
 * 脚本只做四件事：读旧键 → 按 map 改名 → **只补不覆盖**地并进目标 → 打一个幂等标记。
 * 整段包在 try/catch 里：`localStorage` 在 `file://`（opaque origin）下可能直接抛，
 * **搬家失败绝不能影响页面正常打开**。
 */
function migrationScript(payload) {
  return [
    '<script>',
    '/* 进度搬家：把「这一章单独成页」时做过的题搬到册的键下（完整说明在 assemble.js）。',
    '   ⚠️ 只在**同一个源**里有效：应用内预览走 isg://local、双击文件走 file://，',
    '      两者 localStorage 不同源 —— 所以不要承诺「进度一定在」。',
    '   ⚠️ 旧键不删：用户可能还在用那份单章页面。 */',
    '(function(){try{',
    '  var M=' + jsonForScript(payload) + ';',
    '  var LS=localStorage, flag=M.targetKey+"__mig";',
    '  if(LS.getItem(flag)===M.id) return;                /* 幂等：同一册重开不再搬 */',
    '  var tgt={}; try{ tgt=JSON.parse(LS.getItem(M.targetKey)||"{}")||{}; }catch(e){ tgt={}; }',
    '  var out={}; for(var k in tgt) out[k]=tgt[k];        /* 只碰 pts/ui，其余字段原样保留 */',
    '  out.pts=out.pts||{}; out.ui=out.ui||{};',
    '  for(var i=0;i<M.sources.length;i++){',
    '    var src=M.sources[i], old=null;',
    '    try{ old=JSON.parse(LS.getItem(src.key)||"null"); }catch(e){ old=null; }',
    '    if(!old||typeof old!=="object") continue;',
    '    var op=old.pts||{};',
    '    for(var id in op){',
    '      var to=Object.prototype.hasOwnProperty.call(src.map,id)?src.map[id]:id;',
    '      if(!Object.prototype.hasOwnProperty.call(out.pts,to)) out.pts[to]=op[id];  /* 只补不覆盖 */',
    '    }',
    '    /* ui（陪练位置/大小/模式）逐个字段补：目标里已经有的不覆盖 */',
    '    if(old.ui&&typeof old.ui==="object") for(var u in old.ui){ if(!(u in out.ui)) out.ui[u]=old.ui[u]; }',
    '  }',
    '  LS.setItem(M.targetKey,JSON.stringify(out));',
    '  LS.setItem(flag,M.id);',
    '}catch(e){}})();',
    '</script>',
    '',
  ].join('\n');
}

/**
 * 拼装单文件页面。
 *
 * 入参有两种形状，**都接受**：
 *   新（一册多章）`{ skeleton, chapters:[{ chapter, units, demos }], pageKey, finalAdvice, pet, generator }`
 *   旧（单章）    `{ skeleton, chapter, units, demos, pageKey, finalAdvice, pet, generator }`
 *
 * ⚠️ **只有一章时，产出与"支持多章之前"逐字节一致**。这是"存量自测继续全绿"的闸门，
 * 所以下面所有"只有多章才需要"的东西（目录分组、按册统计、题区 data-name…）一律用 `multi` 挡着。
 *
 * ── 一册多章最要紧的一条：**不要把已经发出去的章改名** ──
 * 作答点 id 就是进度的存盘键（引擎把进度按 `store.pts[q.id]` 存在 `localStorage[PAGE.key]` 下）。
 * 如果"再加一章"就顺手给全册的 id 加章前缀，那么**每合并一次，学员已经做过的题就全部对不上**
 * ——旧记录还在 localStorage 里，只是没有任何一道题再引用它，界面表现是"进度清零"。
 * 所以规则是：
 *   · 章对象上带 `frozen:true`（这一章以前生成过、已经交付给用户了）→ 它的 item id **一个字都不改**，
 *     只把它们登记进 `seenIds`；
 *   · 本次新生成的那一章 → 先用老的 namespace（`u.id || 'u'+(章内下标+1)`），
 *     **只有真的会与已登记的 id 撞车**时才改用 `c<章序号>-<老 namespace>`。
 * 于是最常见的那条路——"在已有的册子上再加一章"——完全不需要改名、不需要任何进度迁移。
 * 单元锚点、演示 id 用的是同一条思路（不撞不改）。
 *
 * @param {object} input
 * @param {string} input.skeleton      page-skeleton.html 全文
 * @param {Array}  [input.chapters]    [{ chapter:{subject,number,title,intro,frozen}, units:[…], demos:[…],
 *                                       key }]，`key` = 这一章单独成页时的存盘键（多章时用它把那一章的
 *                                       进度搬进册的键下，见「进度搬家」那段）
 * @param {object} [input.chapter]     旧的单章写法：{ subject, number, title, intro }
 * @param {Array}  [input.units]       旧的单章写法：[{ id, num, title, lede, lectureHtml, bank, isFinal }]
 * @param {Array}  [input.demos]       旧的单章写法：[{ id, title, markup, js, unitId, unitTitle }]
 * @param {object} input.pageKey       存盘键（一册唯一）
 * @param {string} input.finalAdvice
 * @param {'none'|'fish'|'image'} input.pet
 * @returns {{ html:string, stats:object, fixes:Array, warnings:Array }}
 */
function assemble(input) {
  const { skeleton, pageKey } = input;
  const pet = input.pet || 'none';
  const fixes = [];
  const warnings = [];

  const chapters = toChapters(input);
  const multi = chapters.length > 1;
  for (const c of chapters) {
    if (!Array.isArray(c.units) || !c.units.length) throw new Error('拼装失败：没有任何单元');
  }
  if (!pageKey || !/^[\w\-.]+$/.test(pageKey)) throw new Error('拼装失败：pageKey 不合法（' + pageKey + '）');

  /* ---------- -0. 全局槽位表 ----------
     一切"按单元算"的东西都从这里取，不再各算各的：
       lv = 槽位下标 → **跨章连续、0..N-1 无跳号**（引擎的 lvHosts 是按 data-lv 字符串建的普通对象，
       取不到就产出坏卡）。`data-lv` / `.cnt` 的 `data-cnt` / 题库里的 `q.lv` 三处必须同源，
       各算各的（按章内下标）会让两章都从 0 开始，题被渲染到错误的题区里。 */
  const chapterInfos = chapters.map((c, ci) => ({
    chapter: c.chapter,
    units: c.units,
    demos: c.demos,
    key: c.key, // 这一章单独成页时的存盘键（进度搬家要用，见 7.5 节）
    idx: ci,
    frozen: !!(c.chapter && c.chapter.frozen),
    anchorByRaw: new Map(), // 原始 unitId → 最终锚点（演示挂载点要用最终值去页面里找）
  }));
  const slots = []; // 全部单元拉平；每项带着它所属的章
  for (const info of chapterInfos) {
    info.units.forEach((u, ui) => {
      slots.push({
        info,
        chapter: info.chapter,
        unit: u,
        ui,
        lv: slots.length,
        rawAnchor: u.id || 'u' + (ui + 1), // 与改动前同源：章内下标，不是全局 lv
        anchor: '',
        namespace: '',
        lectureHtml: '',
      });
    });
  }

  /* 处理顺序：**冻结章先占坑**。
     冻结章是"以前生成过、已经交付给用户"的章（`chapter.frozen`），它的 id / 锚点一个字都不能改，
     否则旧页面里的作答记录、以及它自己正文里的 `ref.h` 回看链接就全对不上了。
     所以先让它们把 id 与锚点登记下来，新章再来时**让新章改名**——
     反过来（新章先占）会把冻结章挤去改名，而那是静默的：页面照常打开，
     只是学员在这一章的作答记录全部对不上（进度看起来被清零了）。
     没有冻结章时（含现有的单章调用）这个顺序就是 lv 升序，与改动前完全一致。 */
  const processOrder = slots
    .slice()
    .sort((a, b) => (a.info.frozen === b.info.frozen ? a.lv - b.lv : a.info.frozen ? -1 : 1));

  /* 单元锚点：**撞了才改名**。两章的单元都自动生成 `u1`/`u2` 时锚点会撞，而锚点是全页共用的
     （目录、`ref.h` 的回看链接都按它找）。不撞就一个字不改。 */
  const usedAnchors = new Set();
  for (const s of processOrder) {
    let anchor = s.rawAnchor;
    if (usedAnchors.has(anchor)) {
      anchor = 'c' + (s.info.idx + 1) + '-' + s.rawAnchor;
      let n = 2;
      while (usedAnchors.has(anchor)) anchor = 'c' + (s.info.idx + 1) + '-' + s.rawAnchor + '-' + n++;
      warnings.push(`第 ${s.info.idx + 1} 章的单元锚点 ${s.rawAnchor} 与前面某处重名，已改成 ${anchor}`);
    }
    usedAnchors.add(anchor);
    s.anchor = anchor;
    if (!s.info.anchorByRaw.has(s.rawAnchor)) s.info.anchorByRaw.set(s.rawAnchor, anchor);
  }
  /* 章标题块的锚点（目录里的章小标题链到它）。排在单元锚点之后：单元的锚点更"正式"
     （冻结章里那些 `ref.h` 回看链接按它找），冲突时让单元赢。只有多章才需要。 */
  if (multi) {
    for (const info of chapterInfos) {
      let sec = 'c' + (info.idx + 1);
      let n = 2;
      while (usedAnchors.has(sec)) sec = 'c' + (info.idx + 1) + '-' + n++;
      usedAnchors.add(sec);
      info.secId = sec;
    }
  } else {
    chapterInfos[0].secId = '';
  }
  /* ---------- -0.2 演示 id 的全局分配 ----------
     演示的 id 空间只有 `demoA…demoZ` 共 26 个（引擎与生成契约都按这个形状认）。
     两章各自生成演示时，几乎必然都从 `demoA` 开始——同一个文档里两套同名 id 会让
     `getElementById` 只返回第一个，第二章的演示**静默失灵**（拖滑块没反应、读数不动）。
     所以这里统一分配：不撞就用原来的 id，撞了才换成**第一个没用过的大写字母**。
     改名要同步三处，漏掉任何一处都是静默故障：
       ① 演示自己的 id（markup 里的 id= 与 js 里的引用）——由 renameDemoIds 一起改；
       ② 它所在章的 `units[].lectureHtml` 里的 `<!--DEMO:旧id-->` 占位（**漏这处演示会被挂到错的单元**，
          而 :512 那段兜底只会记一条 warning，极难查）；
       ③ 后面挂 js 时用的那个 id。
     ⚠️ ② 的替换**必须一次扫过**（用 Map + 单趟正则），不能一个个 replace：同章内
     `demoA→demoB`、`demoB→demoC` 这样的连环改名按顺序替换会把两处都变成 demoC。 */
  const demoPlan = [];
  const usedDemoIds = new Set();
  const demoOrder = chapterInfos
    .slice()
    .sort((a, b) => (a.frozen === b.frozen ? a.idx - b.idx : a.frozen ? -1 : 1)); // 冻结章的演示先占 id
  for (const info of demoOrder) {
    for (const d of info.demos) {
      if (!d || !d.id) continue; // 与改动前一致：没有 id 的演示直接跳过
      const origId = String(d.id);
      let id = origId;
      if (usedDemoIds.has(id)) {
        const alt = nextFreeDemoId(usedDemoIds);
        if (!alt) {
          throw new Error(
            `拼装失败：一册最多 26 个演示（demoA…demoZ），现在要给第 ${demoPlan.length + 1} 个演示 ` +
              `${origId} 找不重名的 id 却已经用满了。请把一册拆成两册，或减少演示数量。`
          );
        }
        warnings.push(`演示 ${origId} 与前面某处的演示重名，已改名为 ${alt}（不改名两章的演示会互相抢控件）`);
        id = alt;
      }
      usedDemoIds.add(id);
      // 这个演示所属单元的**最终**锚点（原始 unitId 可能因为撞车被改成 c<章>-…）：
      // 挂载点要用它去找，finalChapters 落盘时也要存最终值，否则下次合并会找错单元。
      const rawUnitId = String(d.unitId || '');
      demoPlan.push({
        d, info, id, origId,
        unitAnchor: rawUnitId ? info.anchorByRaw.get(rawUnitId) || rawUnitId : '',
        finalMarkup: '',
        finalJs: '',
      });
    }
  }
  for (const s of slots) {
    const renames = new Map();
    for (const p of demoPlan) {
      if (p.info === s.info && p.origId !== p.id) renames.set(p.origId, p.id);
    }
    const raw = String(s.unit.lectureHtml || '');
    s.lectureHtml = renames.size
      ? raw.replace(/<!--DEMO:([\w.-]+)-->/g, (m, id) => (renames.has(id) ? `<!--DEMO:${renames.get(id)}-->` : m))
      : raw;
  }

  /* ---------- -0.3 正文里嵌的 id：跨章去重（**只有多章才做**） ----------
   *
   * 为什么必须做：模型写的讲解正文里带着自己的锚点（契约要求 `<h3>` 上有形如 `id="k1311"`
   * 的稳定 id，题库的「回看」链接按它找）。**这些 id 是章内自洽的，跨章没有任何机制区分** ——
   * 两章各自从同一套编号开始时（模型按"章内第几个单元第几个知识块"编号，这在同一个提示词下
   * 是最自然的写法），页面里就出现两套同名 id：`getElementById` 只返回第一个，
   * 另一章的回看链接全部指到前一章去。
   *
   * 不处理的话，拼装末尾的全页 id 自检会**当场判失败**（那是对的，宁可不发也不发一份坏页），
   * 但用户拿到的是"拼装自检失败：页面上有重复的 id" —— 他做不了任何事，只能换模型重跑。
   * 而这里其实有一个和"单元锚点""演示 id"完全同源的解：**不撞不改**。
   *
   * ⚠️ 只在 `multi` 时做。单章时章内重名是**模型自己写错了**，那种错值得当场炸出来
   * （现有的敌意输入测试正是压着它），不该被这里悄悄抹平。
   * ⚠️ 走 `processOrder`（冻结章先占 id），与锚点/演示同一套顺序：要让**新章**改名。
   */
  if (multi) {
    const usedInnerIds = new Set();
    for (const s of processOrder) {
      const html = String(s.lectureHtml || '');
      const rename = new Map();
      const withIds = html.replace(/(\sid\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'>]+))/gi, (m, pre, q, quoted, bare) => {
        const id = quoted !== undefined ? quoted : bare;
        if (!id || !usedInnerIds.has(id)) { if (id) usedInnerIds.add(id); return m; }
        let alt = 'c' + (s.info.idx + 1) + '-' + id;
        let n = 2;
        while (usedInnerIds.has(alt)) alt = 'c' + (s.info.idx + 1) + '-' + id + '-' + n++;
        usedInnerIds.add(alt);
        rename.set(id, alt);
        return q ? pre + q + alt + q : pre + alt;
      });
      if (!rename.size) { s.lectureHtml = html; continue; }
      /* 正文里指向自己的链接要**跟着一起改**：只改 id 不改 `href="#…"`，
         那些链接会指到**前一章的**同名锚点上去（点一下跳到别章，而且没有任何报错）。 */
      s.lectureHtml = withIds.replace(/(\shref\s*=\s*)(?:(["'])#([^"']*)\2|#([^\s"'>]+))/gi,
        (m, pre, q, quoted, bare) => {
          const id = quoted !== undefined ? quoted : bare;
          if (!id || !rename.has(id)) return m;
          return q ? pre + q + '#' + rename.get(id) + q : pre + '#' + rename.get(id);
        });
      /* 题库的「回看」链接存在 bank 里（不在这段 HTML 里），单独记下来，
         等题库规范化之后一并改（见下面 ref 校验之前那一段）。
         不改的后果不是"链接坏掉"而是**链接被摘掉**：第 3 节的死链检查发现 `#k1311` 不存在，
         把整条 ref 删掉、只记一条 fix —— 学员觉得"这题怎么没有回看"，没人知道为什么。 */
      s.innerIdMap = rename;
      warnings.push(`第 ${s.info.idx + 1} 章的正文里有 ${rename.size} 个锚点与前面某处重名，`
        + `已改成 c${s.info.idx + 1}-…（不改名的话这些锚点全都会指到前一章去）`);
    }
  }
  const firstChapter = chapterInfos[0].chapter;
  let h = skeleton;

  /* ---------- -1. 给交付页装一条 CSP ----------
     这一页会被**真的执行**三次（应用内预览、自动校验的隐藏窗口、用户双击打开）。
     内容来自模型、模型读的是用户的课件——所以必须假设页面里可能出现不该有的东西。
     这条 CSP 不改变任何既有功能（引擎与演示都是内联 script，图片是同目录文件或 data URI），
     但掐死了"把读到的内容往外发"这条路。 */
  assertOnce(h, '<meta charset="utf-8">', '<meta charset="utf-8">');
  const CSP =
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: file:; " +
    "font-src 'self' data:; " +
    "media-src 'self' data: file:; " +
    "connect-src 'none'; frame-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'";
  h = h.replace(
    '<meta charset="utf-8">',
    () => '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
  );

  /* ---------- 0. 题库：规范化 + 校验（不合格的在这里就炸出来，别拼出一份残缺的页） ----------
     `seenIds` 跨**全册**共用：两章的题 id 撞了同样会让两题共用一个存盘键。

     namespace 的取舍见文件头那段：**冻结章一个字都不改**（它的 id 已经跟着 localStorage 里的
     作答记录发出去了），新章也只在"真会撞车"时才加 `c<章序号>-` 前缀。
     按 `processOrder` 走（冻结章先占 id），新章撞车时改的才是新章自己。
     没有冻结章时（含现有的单章调用）processing 顺序就是 lv 升序：单章时 seenIds 一开始是空的，
     "撞车"只可能发生在同一个章内——那是改动前就有的情形，仍旧交给 normalizeBank 自己改名
     （并记一条 fix），行为与从前完全一致。 */
  const seenIds = new Set();
  const bankErrors = [];
  const normalizedByLv = new Array(slots.length);
  for (const s of processOrder) {
    const ns0 = s.rawAnchor;
    let ns = ns0;
    if (s.info.frozen) {
      ns = ''; // 冻结章：沿用 items 里已经写好的 q.id，只登记进 seenIds
    } else if (multi && prospectiveIds(s.unit.bank, ns0).some((id) => seenIds.has(id))) {
      ns = 'c' + (s.info.idx + 1) + '-' + ns0;
      warnings.push(
        `第 ${s.info.idx + 1} 章「${s.unit.title || s.rawAnchor}」的题目 id 与别的章撞车，` +
          `已把这一章的前缀改成 ${ns}`
      );
    }
    s.namespace = ns;
    const res = normalizeBank(s.unit.bank, { lv: s.lv, namespace: ns, seenIds });
    for (const fx of res.fixes) fixes.push({ unit: s.unit.title, message: fx.message });
    for (const it of res.issues) bankErrors.push({ unit: s.unit.title, message: it.message });
    normalizedByLv[s.lv] = res.items;
  }
  // 题库段仍按**页面顺序**落盘（bank0..bankN 与 .qlist[data-lv] 一一对应）
  const normalized = normalizedByLv;
  if (bankErrors.length) {
    const err = new Error(`题库有 ${bankErrors.length} 处不合格，无法拼装`);
    err.bankErrors = bankErrors;
    throw err;
  }

  const stat = countPoints(normalized.flat());
  if (!stat.total) throw new Error('拼装失败：题库里一个作答点都没有');

  /* ---------- 1. 标题 / 页头（只有一章时逐字沿用旧文案） ---------- */
  const DEFAULT_INTRO = '上面讲解、下面就是题；每个小节讲完紧跟着这一节的练习。';
  const chapterTitles = chapterInfos
    .map((c) => String(c.chapter.title || '').trim())
    .filter(Boolean);
  const subjectTxt = multi
    ? String(chapterInfos.map((c) => c.chapter.subject || '').find(Boolean) || '课件')
    : firstChapter.subject || '课件';
  const numTxt = multi ? '' : firstChapter.number ? `第 ${firstChapter.number} 章` : '';
  const eyebrow = multi
    ? [subjectTxt, `共 ${chapters.length} 章`, '讲练一体'].filter(Boolean).join(' · ')
    : [subjectTxt, numTxt, '讲练一体'].filter(Boolean).join(' · ');
  const pageTitle = multi
    ? chapterTitles.join(' · ') || '讲练一体'
    : [numTxt, firstChapter.title].filter(Boolean).join(' · ') || '讲练一体';

  assertOnce(h, '</title>', '</title>');
  h = h.replace(MARK.title, () => `<title>${escapeHtml(pageTitle)} · 讲练一体</title>`);

  assertOnce(h, '<header class="top">', '<header class="top">');
  const demoCount = chapterInfos.reduce(
    (n, c) => n + c.demos.filter((d) => d && (d.js || d.markup)).length,
    0
  );
  const facts = [];
  facts.push(`    <div><b>${stat.total}</b><span>个作答点</span></div>`);
  facts.push(`    <div><b>${slots.length}</b><span>个单元</span></div>`);
  // 一册多章时把章数也报出来：页头那几个数字是学员判断"这一册有多大"的唯一依据
  if (multi) facts.push(`    <div><b>${chapters.length}</b><span>章</span></div>`);
  if (demoCount) facts.push(`    <div><b>${demoCount}</b><span>个可拖演示</span></div>`);
  h = h.replace(
    MARK.header,
    () =>
      [
        '<header class="top"><div class="top-inner">',
        `  <span class="eyebrow">${escapeHtml(eyebrow)}</span>`,
        `  <h1>${escapeHtml(multi ? chapterTitles.join(' · ') || '讲练一体' : firstChapter.title || pageTitle)}</h1>`,
        `  <p class="sub">${escapeHtml(multi ? DEFAULT_INTRO : firstChapter.intro || DEFAULT_INTRO)}</p>`,
        '  <div class="facts">',
      ]
        .concat(facts)
        .concat(['  </div>', '</div></header>'])
        .filter(Boolean)
        .join('\n')
  );

  /* ---------- 2. 正文：讲解 + 紧跟的题区 ---------- */
  assertOnce(h, MARK.contentStart, '正文起始注释');
  assertOnce(h, MARK.contentEnd, '结算区 <section id="result">');
  const i0 = h.indexOf(MARK.contentStart);
  const i1 = h.indexOf(MARK.contentEnd, i0);
  if (i1 < 0) throw new Error('拼装失败：结算区在正文起始注释之前，骨架顺序不对');

  const bodyParts = [];
  /* 本页地图：长页面靠锚点跳转，不做标签页（切页会丢滚动位置——见 SKILL.md 形态铁律第 1 条）。
     ⚠️ 锚点要指向**讲解区**，不是题区。
     以前这里是 `#p-l${i}`（题区），而链接文字用的是讲解标题 —— 于是点「13.1 磁化」
     会直接跳过 13.1 整节讲解、落到 13.1 的题上（实测：讲解区 y=632，落点 y=1736）。
     这一行是页面唯一的导航手段，指错了等于导航不可用。
     多章时按章分组（每章一个小标题 + 它下面的单元链接）：一册好几章、几十个小节，
     一条平铺的链接串根本找不到"第 14 章在哪"。 */
  if (multi) {
    const toc = [
      '  <div class="card" id="howto">',
      '    <h4>这一页怎么用</h4>',
      `    <p>一册到底，不用切页：每个小节讲完，紧接着就是这一节的题；每一章最后是综合大题，全册最后是学习结算。共 ${chapters.length} 章、${slots.length} 个单元、${stat.total} 个作答点。</p>`,
      '    <p style="margin-bottom:0">跳到：</p>',
    ];
    for (const info of chapterInfos) {
      const mine = slots.filter((s) => s.info === info);
      if (!mine.length) continue;
      toc.push(`    <p style="margin:.5em 0 .2em"><a href="#${escapeHtml(info.secId)}"><b>${escapeHtml(chapterLabel(info.chapter, info.idx))}</b></a></p>`);
      toc.push(
        '    <p style="margin:0 0 .2em 1.2em">' +
          mine
            .map(
              (s) =>
                `<a href="#${escapeHtml(s.anchor)}">${escapeHtml(
                  s.unit.shortTitle || s.unit.title || '第 ' + (s.ui + 1) + ' 节'
                )}</a>`
            )
            .join(' · ') +
          '</p>'
      );
    }
    toc.push('  </div>');
    bodyParts.push(toc.join('\n'));
  } else {
    bodyParts.push(
      [
        '  <div class="card" id="howto">',
        '    <h4>这一页怎么用</h4>',
        '    <p>一页到底，不用切页：每个小节讲完，紧接着就是这一节的题；全章最后是综合大题与学习结算。</p>',
        '    <p style="margin-bottom:0">跳到：',
        slots
          .map(
            (s) =>
              `<a href="#${escapeHtml(s.anchor)}">${escapeHtml(
                s.unit.shortTitle || s.unit.title || '第 ' + (s.ui + 1) + ' 节'
              )}</a>`
          )
          .join(' · '),
        '    </p>',
        '  </div>',
      ].join('\n')
    );
  }

  slots.forEach((s) => {
    const u = s.unit;
    const info = s.info;
    /* 多章时给每章开头插一个章标题。一册几百道题、几十个小节，没有章标题就分不清
       自己翻到哪一章了；目录里的章分组也才有落点。 */
    if (multi && s.ui === 0) {
      bodyParts.push('');
      bodyParts.push(`  <section id="${escapeHtml(info.secId)}">`);
      bodyParts.push(
        `    <h2><span class="num">第 ${escapeHtml(String(info.chapter.number || info.idx + 1))} 章</span>${escapeHtml(
          String(info.chapter.title || '')
        )}</h2>`
      );
      if (info.chapter.intro) bodyParts.push(`    <p class="lede">${escapeHtml(info.chapter.intro)}</p>`);
      bodyParts.push('  </section>');
    }
    bodyParts.push('');
    bodyParts.push(`  <section id="${escapeHtml(s.anchor)}">`);
    bodyParts.push(
      `    <h2><span class="num">${escapeHtml(u.num || String(s.ui + 1))}</span>${escapeHtml(u.title || '第 ' + (s.ui + 1) + ' 节')}</h2>`
    );
    if (u.lede) bodyParts.push(`    <p class="lede">${escapeHtml(u.lede)}</p>`);
    // 模型写的正文先过一遍清洗器（见 sanitizeModelHtml 的说明：这一页会被真的执行）
    const cleanProse = sanitizeModelHtml(s.lectureHtml);
    if (cleanProse.removed.length) {
      fixes.push({ unit: u.title, message: `正文里清掉了不该有的东西：${[...new Set(cleanProse.removed)].join('、')}` });
    }
    s.pageHtml = cleanProse.html; // 真正进页面的那一份（finalChapters 落盘时用它）
    bodyParts.push(indent(cleanProse.html, 4));
    bodyParts.push('  </section>');
    bodyParts.push('');
    /* 多章时题区上挂一个 data-name。引擎取关卡名是 `data-name` **优先于** h2
       （quiz-engine.js:206），所以"两章都有『小结』、结算区分不清是哪个小结"这个问题
       一行属性就解决了，不用动引擎。单章不加：h2 已经够用，而加了会改变既有产出。 */
    const dataName = multi
      ? ` data-name="${escapeHtml(
          [`第 ${info.chapter.number || info.idx + 1} 章`, [u.num, u.title].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(' ')
        )}"`
      : '';
    bodyParts.push(`  <section class="qsec" id="p-l${s.lv}"${dataName}>`);
    // 题区标题用模型给的 qsecTitle（契约 §0 的警告：它和讲解标题是两回事，
    // 结算条上的关卡名取自**题区** h2，用错了会在结算区显示成讲解标题）。
    // 兜底必须是「练一练 · X」——引擎只在 .num 是单个「练」字时才剥它，别的写法都会把关卡名弄花。
    const qsecTitle =
      u.qsecTitle && /^练一练/.test(u.qsecTitle)
        ? u.qsecTitle
        : `练一练 · ${u.shortTitle || u.title || '第 ' + (s.ui + 1) + ' 节'}`;
    s.qsecTitle = qsecTitle; // 生效的那一个（finalChapters 落盘时用它，别再让调用方猜兜底规则）
    bodyParts.push(`    <h2><span class="num">练</span>${escapeHtml(qsecTitle)}<span class="cnt" data-cnt="${s.lv}"></span></h2>`);
    if (u.quizLede || u.lede) bodyParts.push(`    <p class="lede">${escapeHtml(u.quizLede || u.lede)}</p>`);
    bodyParts.push(`    <div class="qlist" data-lv="${s.lv}"></div>`);
    bodyParts.push('  </section>');
  });

  h = h.slice(0, i0) + bodyParts.join('\n') + '\n\n' + h.slice(i1);

  /* ---------- 2.9 正文锚点改过名的，题库里的「回看」跟着改 ----------
     必须在下面的死链校验**之前**：晚一步，那些链接就会被当成死链静默摘掉。 */
  for (const s of slots) {
    if (!s.innerIdMap || !s.innerIdMap.size) continue;
    for (const q of normalized[s.lv] || []) {
      const targets = q.type === 'big' ? q.parts || [] : [q];
      for (const t of targets) {
        if (!t || !t.ref || !t.ref.h) continue;
        const id = String(t.ref.h).replace(/^#/, '');
        if (s.innerIdMap.has(id)) t.ref.h = '#' + s.innerIdMap.get(id);
      }
    }
  }

  /* ---------- 3. ref 锚点校验（在题库落进页面之前做，省得改完再序列化一次） ---------- */
  const idSet = new Set();
  for (const m of h.matchAll(/\sid="([^"]+)"/g)) idSet.add(m[1]);
  // 题区宿主与单元外壳的 id 也要算进去
  slots.forEach((s) => {
    idSet.add(s.anchor);
    idSet.add('p-l' + s.lv);
  });
  let deadRefs = 0;
  for (const items of normalized) {
    for (const q of items) {
      const targets = q.type === 'big' ? q.parts || [] : [q];
      for (const t of targets) {
        if (t && t.ref && t.ref.h) {
          const raw = String(t.ref.h);
          if (!raw.startsWith('#') || !idSet.has(raw.slice(1))) {
            delete t.ref;
            deadRefs++;
          }
        }
      }
    }
  }
  if (deadRefs) fixes.push({ unit: '—', message: `摘掉了 ${deadRefs} 处指向不存在位置的「回看」链接` });

  /* ---------- 4. 题库：一段一个单元，JSON 由我们序列化 ---------- */
  assertOnce(h, '<script data-bank id="bank0" type="application/json">', '题库锚点 bank0');
  const bankHtml = normalized
    .map(
      (items, i) =>
        `<script data-bank id="bank${i}" type="application/json">\n` + jsonForScript(items) + '\n</script>'
    )
    .join('\n\n');
  h = h.replace(MARK.bankBlock, () => bankHtml); // 用函数形式：避免 $& 之类的替换模式被解释

  /* ---------- 5. 引擎区间：PAGE 配置 ----------
     这一节以及下面的演示槽，全部**只在引擎脚本那一小段里替换**。
     原因：正文是模型写的、不可信，它完全可能"引用"骨架里的配置原文（例如讲解里贴一段
     `petImages:['pet.png']` 做例子）。全局 replace 会改到正文那一处、放过引擎里真正该改的那处，
     症状是"用户明明选了不要陪练，右下角还是冒出陪练"——而且一声不响。 */
  assertOnce(h, MARK.engineOpen, '引擎脚本起点');
  const engStart = h.indexOf(MARK.engineOpen);
  // 引擎区间 = 从 <script id="engine"> 到 </body>。
  // ⚠️ 不能用 <footer> 当终点：骨架里 footer 排在**引擎之前**（footer → 题库 → 引擎）。
  const bodyEnd = h.indexOf('</body>', engStart);
  if (bodyEnd < 0) throw new Error('拼装失败：引擎脚本之后找不到 </body>，骨架结构不对');
  let eng = h.slice(engStart, bodyEnd);

  /* 计数一律以**引擎原文**为准，而不是"被前面几次 patch 改过之后的 eng"。
     ⚠️ 踩过：`finalAdvice` 是**注入到引擎区间里**的，而它的内容来自模型。
     收尾语里只要出现一次 `petImages:[…]` 的字面量（比如在讲"陪练图是怎么配的"），
     后面对 `PAGE.petImages` 的计数就从 1 变成 2 → 直接抛错 → **整单失败、一个 HTML 都不产出**，
     而错误信息还把人往"骨架页被改过"上引。用户选了"不要陪练"时必现。
     （实测复现：`test/_audit/v1/t6-prompts-map.js` C1）
     拿原文计数之后，任何"前一次 patch 注入进来的文本"都不可能再影响后一次的计数。 */
  const engOriginal = eng;

  function patchEngine(re, repl, what) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const hits = engOriginal.match(new RegExp(re.source, flags));
    const count = hits ? hits.length : 0;
    if (count !== 1) {
      throw new Error(
        `拼装失败：引擎脚本里的「${what}」应该恰好出现 1 次，实际 ${count} 次。` +
          '这说明 skills/interactive-study-guide/assets/page-skeleton.html 的引擎被改过——' +
          '请对照 apps/isg-studio/docs/architecture.md 更新 assemble.js 的锚点。'
      );
    }
    eng = eng.replace(re, repl);
  }

  patchEngine(MARK.pageKey, (m, ws) => `${ws}key:'${pageKey}',`, 'PAGE.key');
  if (pet === 'none') {
    // 用户选了"不要陪练"：清空图片名清单，右下角就什么都不出现（引擎不内置任何小人）
    patchEngine(MARK.petImages, () => 'petImages:[]', 'PAGE.petImages');
    patchEngine(MARK.bgImages, () => 'bgImages:[]', 'PAGE.bgImages');
  }
  /* ⚠️ finalAdvice 必须放在**最后一个** patch：它是唯一一处把"模型给的文本"注入引擎区间的，
     而后面若还有 patch，注入进去的那段文字就可能被当成锚点命中（计数、替换都会错位）。
     目前它就是最后一个。 */
  if (input.finalAdvice) {
    // finalAdvice 落在 <script id="engine"> 内部，必须走 jsonForScript 转义：
    // 一句带 `</script>` 的收尾语会让解析器提前闭合引擎 → 整页没有任何 JS，而任务照报"完成"。
    patchEngine(
      MARK.finalAdvice,
      (m, ws) => `${ws}finalAdvice:${jsonForScript(String(input.finalAdvice))},`,
      'PAGE.finalAdvice'
    );
  }
  h = h.slice(0, engStart) + eng + h.slice(bodyEnd);

  /* ---------- 6. 演示：标记替换 + JS 塞进引擎的演示槽 ---------- */
  const demoJs = [];
  for (const p of demoPlan) {
    const d = p.d;
    const id = p.id; // 全局分配后的 id（不撞车时就是模型给的那个）
    const ph = `<!--DEMO:${id}-->`;
    if (d.markup) {
      const cleanMark = sanitizeModelHtml(d.markup);
      if (cleanMark.removed.length) {
        fixes.push({ unit: id, message: `演示标记里清掉了不该有的东西：${[...new Set(cleanMark.removed)].join('、')}` });
      }
      d.markup = cleanMark.html;
      // 改了名就同步改演示自己这一族的 id 引用（标记里的 id= 与 js 里的 getElementById）
      const markup = renameDemoIds(d.markup, p.origId, id);
      p.finalMarkup = markup; // finalChapters 落盘的是"最终形态"，见第 10 节
      if (h.includes(ph)) {
        h = h.replace(ph, () => markup);
      } else {
        // 挂到**该演示所属单元**的题区之前；连单元都找不到才退到第一个题区。
        // （以前统一挂到末尾、日志却说"最后一个单元"，位置和日志都不对）
        let placed = false;
        // 单元锚点可能因为重名被改过名（见上面 usedAnchors 那段），页面里要找**最终**那个
        const rawUnitId = String(d.unitId || '');
        const anchor = rawUnitId ? p.info.anchorByRaw.get(rawUnitId) || rawUnitId : '';
        const owner = anchor ? h.indexOf(`<section id="${anchor}"`) : -1;
        if (owner > 0) {
          const qsec = h.indexOf('<section class="qsec"', owner);
          if (qsec > 0) {
            h = h.slice(0, qsec) + markup + '\n\n' + h.slice(qsec);
            placed = true;
            warnings.push(`演示 ${id} 的占位注释没出现在正文里，已挂到「${d.unitTitle || rawUnitId}」的题区之前`);
          }
        }
        if (!placed) {
          const firstQsec = h.indexOf('<section class="qsec"', i0);
          if (firstQsec > 0) {
            h = h.slice(0, firstQsec) + markup + '\n\n' + h.slice(firstQsec);
            warnings.push(`演示 ${id} 没找到所属单元，已挂到第一个题区之前`);
          } else {
            warnings.push(`演示 ${id} 找不到任何可以挂载的位置，已丢弃`);
          }
        }
      }
    }
    if (d.js) {
      // 先留一份"最终形态"再套 jsForScript：落盘的是改名后的原始 js（不带 </script 转义、
      // 也不带下面那层 try/catch 外壳 —— 那些是"嵌进页面"时才要做的事）。
      p.finalJs = renameDemoIds(String(d.js).trim(), p.origId, id);
      const js = jsForScript(p.finalJs);
      // 契约 §1.5 要求模型自己把 js 写成 try{…}catch(e){…}；它已经包好了就不再套一层
      // （套两层不是错，但会让"演示自己抛错"的堆栈多一层噪音，排查时容易看错）
      if (/^try[ \t]*[{]/.test(js)) demoJs.push(`/* ${d.title || id} —— 由工作台校验 */\n${js}`);
      else
        demoJs.push(
          `/* ${d.title || id} —— 由工作台补上兜底 try/catch 的演示 */\n` +
            `try{\n${js}\n}catch(e){ console.error('[演示 ${id}] 出错：', e); }`
        );
    }
  }
  if (demoJs.length) {
    assertOnce(h, MARK.demoSlot, '演示槽注释');
    assertOnce(h, MARK.demoSlotEnd, '演示槽结束标记');
    const s2 = h.indexOf(MARK.demoSlotEnd);
    h = h.slice(0, s2) + demoJs.join('\n\n') + '\n\n    ' + h.slice(s2);
  }
  /* 没被替换掉的占位注释会原样留在页面上（页面上多出一行 `<!--DEMO:demoB-->` 文本，
     或者更糟：演示被别处的兜底逻辑挂到了错的单元）。改动前这种情况一声不响，这里至少留个记号。 */
  {
    const left = [...h.matchAll(/<!--DEMO:([\w.-]+)-->/g)].map((m) => m[1]);
    if (left.length) {
      warnings.push(`有 ${left.length} 处演示占位注释没被替换掉（${[...new Set(left)].join('、')}）：正文里的 <!--DEMO:…--> 与演示的 id 对不上`);
    }
  }

  /* ---------- 7. 陪练默认形象：内置大肥鱼 ---------- */
  if (pet === 'fish') {
    assertOnce(h, MARK.engineOpen, '引擎脚本起点');
    const seed =
      '<script>\n' +
      '/* 工作台生成时默认选用内置「大肥鱼」形象。已经自己改过偏好的用户不会被覆盖。 */\n' +
      '(function(){try{\n' +
      `  var k=${JSON.stringify(pageKey)};\n` +
      "  var s=JSON.parse(localStorage.getItem(k)||'{}')||{};\n" +
      '  s.ui=s.ui||{};\n' +
      "  if(s.ui.petArt!=='image'&&s.ui.petArt!=='fish') s.ui.petArt='fish';\n" +
      '  if(s.ui.pet===undefined) s.ui.pet=true;\n' +
      '  localStorage.setItem(k,JSON.stringify(s));\n' +
      '}catch(e){}})();\n' +
      '</script>\n';
    h = h.replace(MARK.engineOpen, () => seed + MARK.engineOpen);
  }

  /* ---------- 7.5 进度搬家：把「那一章单独成页」时的作答记录搬到册的键下 ----------
     位置有两个硬要求：
       · 必须在 `<script id="engine">` **之前** —— 引擎是在脚本解析时把 `localStorage[KEY]`
         读成快照的（quiz-engine.js:34-38），晚一步跑就等于没跑，而症状与"根本没做这件事"一样。
       · 排在陪练预置脚本（上一节）之后 —— 那段会先写好 `ui.petArt/pet`，搬家按"目标里没有才补"
         来填，于是**册这一层的陪练选择优先**，而旧章的陪练位置/大小/模式照样搬过来。
     不搬家时（单章、或各章的键与册的键相同）什么都不注入：单章产出必须逐字节不变。 */
  {
    const move = progressMovePayload(chapterInfos, slots, normalized, pageKey, multi);
    if (move) {
      assertOnce(h, MARK.engineOpen, '引擎脚本起点');
      // 载荷里的来源键来自调用方，走 jsonForScript 转义（与 finalAdvice、题库同一套）：
      // 里面只要出现一个 `</script`，解析器就会提前闭合这段脚本，整段搬家静默失效。
      h = h.replace(MARK.engineOpen, () => migrationScript(move) + MARK.engineOpen);
    }
  }

  /* ---------- 8. 页脚 ---------- */
  assertOnce(h, '<footer>', '<footer>');
  const fparts = [];
  // 带上生成它的版本号：出问题时第一句话往往是"这页是哪个版本生成的"，
  // 而后台报错、界面截图都不一定看得出构建时间。成本是一行字。
  const byline = input.generator ? `本页由「${input.generator}」依课件生成` : '本页由「讲练一体工作台」依课件生成';
  fparts.push(byline + '：讲解与练习紧挨着，点选项/填数值立刻判分，进度存在本机浏览器里。');
  if (multi) {
    fparts.push(
      `一册共 ${chapters.length} 章、${slots.length} 个单元、${stat.total} 个作答点` +
        `（概念题 ${stat.byType.single + stat.byType.multi}、计算题 ${stat.byType.num}、综合大题 ${stat.byType.big}）。`
    );
  } else {
    fparts.push(
      `共 ${stat.total} 个作答点（概念题 ${stat.byType.single + stat.byType.multi}、计算题 ${stat.byType.num}、综合大题 ${stat.byType.big}）。`
    );
  }
  fparts.push('建议在手机或平板上看：电脑上跑 <code>python -m http.server 8000</code>，手机同 Wi-Fi 访问即可。');
  h = h.replace(MARK.footer, () => `<footer><p style="margin-bottom:0">${fparts.join(' ')}</p></footer>`);

  /* ---------- 9. 交付前自检：必备 DOM / 题区宿主 / script 配平 ---------- */
  const must = [
    'id="s-done"', 'id="s-total"', 'id="s-rate"', 'id="s-wrong"', 'id="s-fill"',
    'id="onlyWrong"', 'id="resetAll"',
    'id="r-done"', 'id="r-rate"', 'id="r-wrong"', 'id="r-verdict"', 'id="r-bars"',
    'id="r-advicetext"', 'id="goWrong"', 'id="goAll"',
    'id="engine"',
  ];
  const missing = must.filter((m) => !h.includes(m));
  if (missing.length) throw new Error('拼装自检失败，缺少必备 DOM：' + missing.join(', '));
  slots.forEach((s) => {
    if (!h.includes(`data-lv="${s.lv}"`)) throw new Error(`拼装自检失败：缺少第 ${s.lv} 个题区宿主 .qlist[data-lv="${s.lv}"]`);
  });
  /* ---- 跨章撞车的机器防线 ----
     下面这几条全是"撞了会静默"的故障：页面能打开、不报错，只是某些题永远答不对、
     或者两章的题共用一份进度。多章时才当硬错误——单章时它们（除了 lv 那条）都是既有行为，
     一册只有一章本来就撞不起来，把既有的产出判成失败没有意义。 */
  // ① data-lv 必须恰好是 0..N-1 各一次（引擎的 lvHosts 是对象，跳号/重号都会产出坏卡）
  {
    const lvs = [...h.matchAll(/data-lv="(\d+)"/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(lvs)].sort((a, b) => a - b);
    const want = slots.map((s) => s.lv);
    if (lvs.length !== slots.length || uniq.length !== want.length || uniq.some((v, i) => v !== want[i])) {
      throw new Error(
        `拼装自检失败：题区宿主 .qlist 的 data-lv 应该是 ${want.join(',')}（0..${want.length - 1} 各一次），` +
          `实际出现的是 ${lvs.join(',')}。`
      );
    }
  }
  // ② 所有作答点 id 全局唯一（含 big 的 parts 派生 id）——重复 = 两题共用一个存盘键
  {
    const ids = [];
    for (const items of normalized) for (const q of items) for (const x of endpointsOf(q)) if (x.id) ids.push(x.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) {
      throw new Error(`拼装自检失败：作答点 id 重复（${[...new Set(dup)].join('、')}），两题会共用一份作答记录。`);
    }
  }
  // 一段正文里出现未闭合的 <!-- 会把它之后的**整个页面**（含题库与引擎）吞成注释，
  // 而浏览器一声不响。这里按数量配平来挡：注释开闭必须成对。
  // ⚠️ 必须先把 <script> 段整段剔掉再数：JSON 里的 `-->` 只是普通文本（`<` 已被转义成
  //    `<`，但 `>` 没有），拿它当注释结尾会让检查误报（实测踩到过）。
  const markupOnly = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const cmtOpen = (markupOnly.match(/<!--/g) || []).length;
  const cmtClose = (markupOnly.match(/-->/g) || []).length;
  if (cmtOpen !== cmtClose) {
    // 把嫌疑位置一并报出来。不说清楚的话，用户拿着一份十几万字的页面根本无从下手。
    const spots = [];
    let k = -1;
    while ((k = markupOnly.indexOf('-->', k + 1)) >= 0 && spots.length < 3) {
      spots.push('…' + markupOnly.slice(Math.max(0, k - 36), k + 3).replace(/\s+/g, ' ') + '…');
    }
    throw new Error(
      `拼装自检失败：HTML 注释开标记 ${cmtOpen} 个、闭标记 ${cmtClose} 个，配不平。` +
        '这种情况会让注释之后的所有内容（题库、引擎）被浏览器当成注释吞掉，而页面完全不报错。' +
        (spots.length ? ' 疑似位置：' + spots.join(' ｜ ') : '')
    );
  }
  const scriptOpen = (h.match(/<script\b/gi) || []).length;
  const scriptClose = (h.match(/<\/script>/gi) || []).length;
  if (scriptOpen !== scriptClose) {
    throw new Error(
      `拼装自检失败：script 开标签 ${scriptOpen} 个、闭标签 ${scriptClose} 个，配不平。` +
        '多半是某段模型内容里带了 `</script>`，把引擎提前闭合了。'
    );
  }

  /* ---- ③④ 只有在"真正的 DOM"里查才有意义 ----
     ⚠️ 必须先剔掉 <script> 段与 <!-- 注释 -->：`id="…"` 出现在注释里（骨架页的演示槽注释
     就写着 `建议 <div class="demo" id="demoA">…</div>` 当例子）或 JSON 里都**不会**进 DOM，
     拿原文去数会把骨架自己的说明文字当成撞车，一册多章时每单都误报。
     排在注释/脚本配平检查之后：配不平的时候先报那个更根本的问题。 */
  const domOnly = markupOnly.replace(/<!--[\s\S]*?-->/g, '');
  if (multi) {
    // ③ 页面里**静态**写着的 `id="q-…"` 必须与题库对得上：引擎渲染出来的题卡就是 `q-<id>`，
    //    正文里若混进一个同名的静态 id，getElementById 会拿到错的那个，判分/「重做本题」全歪。
    const known = new Set();
    for (const items of normalized) for (const q of items) for (const x of endpointsOf(q)) if (x.id) known.add(x.id);
    const bad = [];
    const seenStatic = new Set();
    for (const m of domOnly.matchAll(/\sid="q-([^"]+)"/g)) {
      if (!known.has(m[1]) || seenStatic.has(m[1])) bad.push(m[1]);
      seenStatic.add(m[1]);
    }
    if (bad.length) {
      throw new Error(
        `拼装自检失败：页面里有静态 id="q-…" 与题库对不上或重复（${[...new Set(bad)].join('、')}）。` +
          '引擎渲染的题卡 id 就是 `q-<作答点 id>`，正文里再出现一个同名的会抢走 getElementById。'
      );
    }

    // ④ 全页 id 无重复（多章时两套同名的 id 会让 getElementById 只认第一个）
    const first = new Map(); // id → 第一次出现的顺序
    const hits = new Map(); // id → [位置…]
    let n = 0;
    for (const m of domOnly.matchAll(/\sid="([^"]+)"/g)) {
      const id = m[1];
      if (!first.has(id)) first.set(id, n);
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push(m.index);
      n++;
    }
    const dups = [...hits.keys()].filter((id) => hits.get(id).length > 1);
    if (dups.length) {
      // 报错要带**位置**：一份十几万字的页面，只说"id 重复"用户根本无从下手
      const where = dups.slice(0, 3).map((id) => {
        const spots = hits
          .get(id)
          .slice(0, 2)
          .map((k) => '…' + domOnly.slice(Math.max(0, k - 40), k + 40).replace(/\s+/g, ' ') + '…');
        return `  ${id}（第 ${first.get(id) + 1} 处）\n      ${spots.join('\n      ')}`;
      });
      throw new Error(
        `拼装自检失败：页面上有重复的 id：${dups.slice(0, 5).join('、')}。` +
          '同一个文档里两套同名 id 会让 getElementById 只返回第一个（另一处静默失灵）。\n' +
          where.join('\n')
      );
    }
  }

  /* ---------- 10. finalChapters：给调用方落盘的「最终形态」 ----------
     为什么要有它：调用方（生成流程）要把每一章的结构化数据存下来，供**以后合并成一册**用。
     存的时候必须存**命名空间生效之后**的题库 id，否则会出这种静默故障：
       · 旁挂数据里存的是原始的 `u1-s1`，而页面题库里的题号是 `s131-u1-s1`；
       · 带过来的章被冻结时 namespace 变成空串、id 保持原样（`u1-s1`），
         于是**学员按 `s131-u1-s1` 存的那些记录一条都读不出来** —— 页面看着完全正常。
     这件事**不能交给调用方自己再算一遍**：那等于把"命名空间怎么定"这套规则复制两份，
     两份规则迟早走散，而走散的后果又是静默的（id 对不上 → 进度丢）。
     所以由这里 —— 唯一知道最终结果的地方 —— 把它整个交出去。

     形状：与传入的 `chapters[]` **一一对应、同序**，且是纯数据（没有函数、没有循环引用），
     调用方可以直接 JSON.stringify 落盘：
       { chapter, key, units:[{ …传入的字段, id:最终锚点, lectureHtml, qsecTitle, bank:最终 items }],
         demos:[{ id:最终演示 id, title, unitId:最终锚点, unitTitle, markup, js }] }
     ⚠️ 只是**多返回一个字段**：`html` 一个字节都不受影响（单章产出逐字节不变是硬闸门）。 */
  const finalChapters = chapterInfos.map((info) => ({
    chapter: Object.assign({}, info.chapter),
    key: info.key || '',
    // slots 是按章号连续排下来的，filter 出来的顺序就是这一章的单元顺序
    units: slots
      .filter((s) => s.info === info)
      .map((s) =>
        Object.assign({}, s.unit, {
          id: s.anchor, // 最终生效的锚点（撞车时会变成 `c<章序号>-…`）
          lectureHtml: s.pageHtml == null ? String(s.unit.lectureHtml || '') : s.pageHtml,
          qsecTitle: s.qsecTitle,
          bank: normalized[s.lv], // ★ 规范化之后的题库：id 已带命名空间、含 lv、ref 已摘净
        })
      ),
    demos: demoPlan
      .filter((p) => p.info === info)
      .map((p) => ({
        id: p.id, // 全局分配之后的演示 id（撞车时会变成 demoB…）
        title: p.d.title || '',
        unitId: p.unitAnchor, // 最终的单元锚点（下次合并要按它找挂载点）
        unitTitle: p.d.unitTitle || '',
        markup: p.finalMarkup, // 清洗 + 改名之后的那一份
        js: p.finalJs, // 改名之后的 js（不含 try/catch 外壳与 </script 转义）
      })),
  }));

  return {
    html: h,
    stats: {
      ...stat,
      units: slots.length,
      chapters: chapters.length,
      demos: demoCount,
      bytes: Buffer.byteLength(h, 'utf8'),
    },
    finalChapters,
    fixes,
    warnings,
  };
}

module.exports = {
  assemble, jsonForScript, jsForScript, escapeHtml, sanitizeModelHtml, MARK, assertOnce,
  renameDemoIds, toChapters,
};

/*__ISG_BUNDLE_END__*/};
  factories["prompts"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 提示词装配。
 *
 * 「内核是 skill」这句话在这里落地：系统提示词 = SKILL.md 全文 + 生成契约的相关章节，
 * 两者都是**运行期从磁盘读**的（打包后从 resources/skill 与 resources/docs 读），
 * 改了 skill 不用改代码。
 *
 * 一条重要的取舍：**每个阶段只喂它那一段契约**。
 * 契约全文约 25KB，四段生成要跑 7~10 次调用，全量喂进去既贵又会让模型的注意力散掉。
 */

const fs = require('fs');
const path = require('path');

let cachedContract = null;
let cachedSkillMd = null;
let cachedContractPath = null;

/** 契约文档在哪：开发态在 apps/isg-studio/docs，打包态在 resources/docs。 */
function contractPath() {
  if (cachedContractPath) return cachedContractPath;
  const { app } = require('electron');
  const candidates = [];
  if (app && app.isPackaged) candidates.push(path.join(process.resourcesPath, 'docs', 'generation-contract.md'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'docs', 'generation-contract.md'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'isg-studio', 'docs', 'generation-contract.md'));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedContractPath = c;
      return c;
    }
  }
  throw new Error('找不到生成契约文档 generation-contract.md（应该在 apps/isg-studio/docs/ 下）');
}

/**
 * 把契约文档按 `## N. 标题` 切成小节。
 * 切不出来就抛错——**不允许静默退化成一整份文档**，那样提示词会悄悄变成另一个东西。
 */
function contractSections() {
  if (cachedContract) return cachedContract;
  const text = fs.readFileSync(contractPath(), 'utf8');
  const parts = {};
  const re = /^##\s+(\d+)\.\s*(.+)$/gm;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ n: m[1], title: m[2], start: m.index });
  if (!hits.length) throw new Error('生成契约文档里找不到 "## N. 标题" 形式的小节');
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    parts[h.n] = { title: h.title, body: text.slice(h.start, end).trim() };
  });
  // 前言（第一个小节之前的内容）
  parts.intro = { title: '前言', body: text.slice(0, hits[0].start).trim() };
  cachedContract = parts;
  return parts;
}

function skillMd() {
  if (cachedSkillMd) return cachedSkillMd;
  const { readSkillMd } = require('../skill');
  cachedSkillMd = readSkillMd();
  return cachedSkillMd;
}

const CORE_SECTIONS = ['0', '1', '2', '3'];

/** 系统提示词。stage ∈ 'plan'|'prose'|'bank'|'demo'。 */
/** 从上下文里取语言设置。默认简体中文——这套材料是给中文学生看的。 */
function langOf(ctx) {
  return (ctx && ctx.options && ctx.options.language) || 'zh-CN';
}

function systemPrompt(stage, opts) {
  const sec = contractSections();
  // §6 是"输入来源与多来源融合"，只对逐来源分析那一步有意义（它在契约末尾，见那里的说明）。
  // 取不到就跳过——`sec[k]` 为空时下面的循环本就不 push，所以这里不需要额外兜底。
  const want = stage === 'demo' ? ['0', '4', '2'] : stage === 'analyze' ? ['0', '6'] : CORE_SECTIONS;
  const chunks = [];
  chunks.push('# 你是「讲练一体」学习页的生成器');
  chunks.push(
    '你在为一位老师/学生生产**单文件 HTML 学习材料**的**零件**。' +
      '页面外壳、判分引擎、样式、进度条、结算区、陪练全部由宿主程序注入，' +
      '**你一个字都不要写它们**——你只产出下面契约里规定的那几样东西。'
  );
  /* ⚠️ 这一节是**对 SKILL.md 的覆盖**，不是补充说明。
     SKILL.md 是写给 Claude Code 的：它会让模型"把素材落盘到 _work/units.md"、
     "开两个子代理（出题 / 审题）"、"跑 inject-probe.py 校验"。这些在应用里**一样都做不到**——
     应用只是一次普通的 API 调用，没有文件系统、没有子代理、没有无头浏览器。
     不写清楚会怎样：模型可能去"写文件"（产出变成一段 _work/units.md 的正文而不是要的 JSON）、
     或者写一句"已交给审题代理"就收工。这类失败还很隐蔽——JSON 可能仍然是合法的，
     只是内容跑偏了。所以必须明说。 */
  chunks.push(
    '## 运行环境（**这一节覆盖 SKILL.md 里与它冲突的部分**）\n' +
      '你是在**一次普通的 API 调用**里工作的，不是 Claude Code。具体地说：\n' +
      '1. **没有文件系统**。不要"把素材落盘到 `_work/…`"、不要写任何文件、' +
      '也不要说"已保存到某路径"。你需要的一切，我在下面的提示词里直接给你。\n' +
      '2. **没有子代理**。不要派代理、不要等"审题代理"回来、不要写"这一步交给 XX 代理"。' +
      '该做的内容你一次做完；**独立审题那一步由调用你的程序另起一次调用完成**——' +
      '所以你只需要保证自己这一步的输出质量，不用替它操心。\n' +
      /* ⚠️ 多来源之后必须补这一条。用户可能一次给了课件 + 课本 + 习题 + 历年真题，
         而每一份来源**已经**被另一次独立调用分析过了。不写清楚会怎样：
         模型会试图"把整本课本也分析一遍"（顶爆上下文），或者写一句
         "已分别分析完三份来源"就收工——**而 JSON 仍然合法**，失败极其隐蔽。 */
      '   多来源时同理：**每一份来源也各由一次独立调用分析过了**，它们的结论会在下面直接给你。' +
      '你不要重做那份分析、不要假装去读文件、也不要写"我先分析一下各份材料"。\n' +
      '3. **不要输出过程叙述或工具调用**：不要写"我先读一下…""接下来我会…"，直接给约定的那个 JSON。\n' +
      '4. SKILL.md 里凡提到 `_work/`、子代理、`inject-probe.py`、无头浏览器、截图的地方，' +
      '都是给 Claude Code 用的，**与你无关**，按上面三条做即可。'
  );

  /* ⚠️ 语言：以前**一个字都没写**，完全指望模型自己"看着办"。
     后果很实在：课件是英文时（外文教材、英文 PPT 很常见），模型会顺着用英文写讲解、
     选项、解析——而这一整套材料是给中文学生看的。所以显式钉住，并做成可选项。 */
  const lang = (opts && opts.language) || 'zh-CN';
  if (lang === 'follow') {
    chunks.push(
      '## 语言\n' +
        '**跟随课件原文的语言**：课件是中文就用简体中文写、是英文就用英文写，别混着来。' +
        '同一份材料里前后保持一致。'
    );
  } else {
    chunks.push(
      '## 语言：**全部内容一律用简体中文**\n' +
        '包含但不限于：单元标题、讲解正文、题干、选项文字、`hint`（思路提示）、`sol`（解析）、' +
        '选项的 `why`（错在哪）、演示的标题与读数名、`finalAdvice`。\n' +
        '- **课件原文是英文（或别的语言）也一样**：读懂之后用简体中文重写；' +
        '不要照抄原文，也不要中英混排、两边各说一半。\n' +
        '- 专业术语可以「中文（English）」这样并排标注**一次**（例如「磁化强度（magnetization）」），' +
        '但正文、题干、解析必须是简体中文。\n' +
        '- 符号、公式、单位、变量名保持原样（`μ₀`、`A/m`、`nI` 这些不翻译）。'
    );
  }

  chunks.push('## 你的输出铁律\n' +
    '1. 只输出**一个 JSON 对象**，不要 Markdown 围栏、不要任何解释文字。\n' +
    '2. JSON 里**不许有尾逗号、注释、单引号、NaN、undefined**。\n' +
    '3. 字符串里的换行用 \\n 转义，引号用 \\" 转义。\n' +
    '4. 宁可少写一点，也不要写坏结构——结构坏了整段内容会凭空消失，而页面不会有任何报错。');
  for (const k of want) {
    if (sec[k]) chunks.push(sec[k].body);
  }
  // SKILL.md 只在"写讲解/写题"的阶段附上——它讲的是讲法、形态铁律与踩过的坑。
  // 演示那一步要的是契约 §4 的填空模板，附上整份 SKILL.md 只是白占上下文：
  // 实测演示是**最容易撞输出上限**的一步（要一次吐 markup + JS + checks），
  // 把这几 KB 让给输出更划算。
  if (stage !== 'demo') {
    chunks.push('## 附：技能规范原文（讲法、形态铁律、踩过的坑都以它为准）\n' + skillMd());
  }
  return chunks.join('\n\n---\n\n');
}

function json(obj) {
  return JSON.stringify(obj, null, 1);
}

/** 把抽取出来的课件文本按预算裁成可喂给模型的段落。 */
function sourceText(pages, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 24000;
  const keep = (pages || []).filter((p) => p && p.text && p.text.trim());
  const total = keep.reduce((n, p) => n + p.text.length, 0);
  if (total <= maxChars) {
    return keep.map((p) => `【第 ${p.index} 页】\n${p.text.trim()}`).join('\n\n');
  }
  // ⚠️ **必须真的刹车**：页数一多，`per` 的下限（400）会把总长顶穿预算——
  // 实测 100 页时 plan 提示词 4.3 万字（预算 2.6 万）、300 页 12.9 万字、800 页 34 万字，
  // 直接超出多数模型的上下文而 400 失败；这段文本还会在每个单元的调用里**重复发一遍**。
  //
  // 刹车按**实际累计长度**算，不是按正文长度：每页还有 `【第 N 页】` 页头、"（此处截断）"
  // 尾注与 `\n\n` 分隔符，页数一多这些加起来能到上千字（只按正文算会超 1~1.1 千字，实测过）。
  const out = [];
  let emitted = 0;
  let dropped = 0;
  const reserve = 120; // 给最后那句汇总留位置
  const budget = Math.max(600, maxChars - reserve);
  const per = Math.max(200, Math.floor(budget / keep.length));

  for (const p of keep) {
    const t = p.text.trim();
    const head = `【第 ${p.index} 页】\n`;
    const room = budget - emitted - head.length;
    if (room <= 40) {
      // 预算用完：**只留页号**，让模型知道这里还有内容，而不是以为这一页不存在
      dropped++;
      continue;
    }
    const take = Math.min(t.length, per, room);
    let chunk;
    if (take >= t.length) {
      chunk = head + t;
    } else if (take > 0) {
      chunk = `${head}${t.slice(0, take)}\n…（本页共 ${t.length} 字，此处截断）`;
      if (chunk.length > budget - emitted) chunk = head + t.slice(0, Math.max(0, room));
    } else {
      dropped++;
      continue;
    }
    out.push(chunk);
    emitted += chunk.length + 2; // +2 是 join('\n\n') 的分隔符
  }

  out.push(
    dropped
      ? `（课件较长，以上为节选：有 ${dropped} 页因篇幅原因未展开，共 ${keep.length} 页 / ${total} 字。` +
        '如需覆盖它们，请把这一章拆成几个文件分别生成。）'
      : `（课件较长，以上为节选；共 ${keep.length} 页 / ${total} 字）`
  );
  return out.join('\n\n');
}

/* ---------------- 多来源：素材段的组织 ---------------- */

/* 各角色的**原文权重**。
   ⚠️ `exampaper: 0` 不是"省 token"，是把"只提炼真题规律、不收录真题原文"从口号
   落到工程上：真题的正文**根本不进提示词**，模型就算想抄也无从抄起。
   它仍然会以"摘要"的形式参与（题型分布、常考考法），那是我们要的那部分。 */
const ROLE_WEIGHTS = { courseware: 1, textbook: 0.6, exercises: 0.4, exampaper: 0 };

/* 课件原文的上限——这是**护栏，不是预算**。
   ⚠️ 为什么不干脆"全附"：`sourceText()` 里那条刹车（见它自己的注释）正是因为
   「100 页课件会让规划提示词涨到 4.3 万字、直接超出多数模型的上下文而 400」才加的。
   **常规的一章课件远达不到这个数**——低于上限时 `sourceText()` 原样返回全部页，
   所以正常情况下这就是"全附"。真遇到几百页的材料会截断并在日志里说明，
   总比整个任务失败好。 */
const COURSEWARE_CAP = 60000;

/** 这份来源该用哪组页。textbook 可能被 scope 限成一节，那就用那一节。 */
function pagesOf(s) {
  if (!s) return [];
  if (Array.isArray(s.scopedPages)) return s.scopedPages;
  return s.pages || [];
}

/** 提示词里怎么称呼这份来源——用用户起的名字，其次文件名，最后才是内部 id。 */
function labelOf(s) {
  return (s && (s.label || s.fileName || s.id)) || '未命名来源';
}

const ROLE_LABEL = { courseware: '课件', textbook: '课本', exercises: '习题', exampaper: '历年真题' };

/** 把一份来源的分析结论压成一小段（它会进后面每一次调用，所以必须短）。 */
function noteSummary(s) {
  const n = s && s.note;
  if (!n) return '';
  const L = [];
  L.push(`### 来源「${labelOf(s)}」（${ROLE_LABEL[s.role] || s.role}）的分析结论`);
  if (n.summary) L.push(n.summary);
  if (Array.isArray(n.outline) && n.outline.length) {
    L.push('结构：' + n.outline.map((u) => u && u.title).filter(Boolean).join(' / '));
  }
  if (Array.isArray(n.terms) && n.terms.length) {
    L.push('术语：' + n.terms.slice(0, 20).map((t) => (t && t.en ? `${t.zh}（${t.en}）` : (t && t.zh) || '')).filter(Boolean).join('、'));
  }
  if (Array.isArray(n.formulas) && n.formulas.length) L.push('关键公式：' + n.formulas.slice(0, 10).join('；'));
  if (Array.isArray(n.questionTypes) && n.questionTypes.length) {
    L.push('题型规律（**出题必须贴合**）：' +
      n.questionTypes.slice(0, 12).map((q) => q && `${q.shape}→${q.mapped}${q.note ? `（${q.note}）` : ''}`).join('；'));
  }
  if (n.coverage && n.coverage.truncated) L.push('（这份材料较长，分析时只看了节选）');
  return L.join('\n');
}

/**
 * 多来源的素材段。**摘要在前，原文在后**——摘要便宜且信息密度高，先讲清"这是什么"。
 *
 * 单来源时与从前**逐字节一致**：`list.length === 1` 直接走 `sourceText()`，
 * 而低于上限时 `sourceText()` 原样返回全部页，所以常规课件的行为一个字都没变。
 * 这条不是巧合，是刻意保的——它是"现有 16 套自测继续全绿"的闸门。
 */
function sourceTextAll(sources, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 24000;
  const list = (sources || []).filter((s) => s && !s.dropped && pagesOf(s).length);
  if (!list.length) return '';

  /* ⚠️ 单来源这一支**必须原样**用传进来的预算，不能换成 COURSEWARE_CAP。
     多来源才走"课件全附"那条路（那是用户对"融合时喂什么"的选择）；
     单来源保持与从前逐字节一致，是"现有自测继续全绿"的闸门——
     换了上限，中等长度的课件会突然不再截断，提示词跟着变，闸门就没了。 */
  if (list.length === 1) {
    return sourceText(pagesOf(list[0]), { maxChars });
  }

  const parts = [];
  // ① 每份来源的分析结论（含真题——它只给规律，不给原文）
  for (const s of list) {
    const note = noteSummary(s);
    if (note) parts.push(note);
  }
  // ② 课件原文：整份给（护栏见 COURSEWARE_CAP 的说明）
  for (const s of list.filter((x) => x.role === 'courseware')) {
    parts.push(`### 来源「${labelOf(s)}」原文\n` + sourceText(pagesOf(s), { maxChars: COURSEWARE_CAP }));
  }
  // ③ 其余来源的原文：在剩余预算里按权重分。exampaper 权重为 0，所以这里根本不会出现它。
  const others = list.filter((x) => x.role !== 'courseware' && ROLE_WEIGHTS[x.role] > 0);
  if (others.length) {
    const rest = Math.max(0, maxChars - parts.join('\n\n').length);
    const wsum = others.reduce((n, s) => n + ROLE_WEIGHTS[s.role], 0);
    for (const s of others) {
      // 每份**独立**走 sourceText 的刹车，避免一份 300 页课本把课件饿死
      const quota = Math.max(2000, Math.floor((rest * ROLE_WEIGHTS[s.role]) / wsum));
      parts.push(`### 来源「${labelOf(s)}」原文\n` + sourceText(pagesOf(s), { maxChars: quota }));
    }
  }
  const out = parts.join('\n\n');
  if (out.length > maxChars * 1.05) {
    // 护栏：万一 helper 被改坏，也不能让单次提示词悄悄超预算（超了就是 400）
    return out.slice(0, Math.floor(maxChars * 1.05));
  }
  return out;
}

/** 从 ctx 里取来源列表。**老调用只有 `ctx.pages`**（没有 sources），退化成"只有一份课件"。 */
function sourcesOf(ctx) {
  if (ctx && Array.isArray(ctx.sources) && ctx.sources.length) return ctx.sources;
  return [{ id: 's1', role: 'courseware', pages: (ctx && ctx.pages) || [] }];
}

/** 规划阶段要的素材：多来源时以"分析结论"为主（它要的是融合后的结构，不是几份原文）。 */
function materialForPlan(ctx) {
  const sources = (ctx && ctx.sources) || [];
  const usable = sources.filter((s) => s && !s.dropped && pagesOf(s).length);
  // 单来源 courseware 且没有分析结论 → 与从前逐字节一致
  if (usable.length <= 1 && !usable.some((s) => s.note)) {
    return sourceText(ctx.pages, { maxChars: 26000 });
  }
  return sourceTextAll(sources, { maxChars: 26000 });
}

/* ---------------- S0 · 逐来源分析 ---------------- */

/**
 * 每份来源各起一次**独立**调用去理解它。
 *
 * 隔离原则与独立审题（`auditMessages`）完全一致：只给它**这一份**来源的材料与角色说明，
 * 不给它别的来源的结论、不给任何出题过程的痕迹。这样每份材料被独立理解一遍，
 * 后面做融合的人才拿到互不污染的几个视角。
 */
function sourceNoteMessages(ctx, src) {
  const lang = langOf(ctx);
  const role = (src && src.role) || 'courseware';
  const scopeLine = src && src.scope && src.scope.label
    ? `\n**只看这一部分**：${src.scope.label}（用户指定；其余部分不在本次范围内，不要分析它）`
    : '';
  const byRole = {
    courseware: '这是**课堂课件**。把它的知识骨架抽出来：讲了哪几块、每块的核心结论、' +
      '用到的公式与常数、以及课件里出现过的例题类型。',
    textbook: '这是**教材**。把这一节的骨架抽出来：概念的定义、推导链条、' +
      '用到的公式与常数、以及定义性/前提性的表述（以后出题必须与它一致）。',
    exercises: '这是**习题集**。不要抄题，提炼它的**练法**：覆盖哪些知识点、' +
      '各是什么题型、难度分布、以及学生最容易在哪一步出错。',
    exampaper: '这是**历年真题**。⚠️ **绝对不要摘抄原题**，只提炼**题型规律**：' +
      '这份卷子由哪些题型构成、各占多少题/多少分、考法是"直接套公式"还是"两步计算"、' +
      '哪些考法反复出现。每一条都要给出它对应到我们四种题型的哪一种。',
  };
  const user =
    `## 任务：来源分析（S0 / source-note.json）\n\n` +
    `来源 id 是 "${src.id}"，角色是：${role}（${ROLE_LABEL[role] || role}）。` +
    `文件名：${src.fileName || ''}。${scopeLine}\n\n` +
    (byRole[role] || byRole.courseware) + '\n\n' +
    `### 我们的四种题型（你给出的 mapped 只能取其中之一）\n` +
    `- single 单选 · multi 多选 · num 填数值 · big 综合大题（含 parts）\n` +
    `真题里的判断题请映射成 two-option 的 single，填空题映射成 num（非数值用 ansText），` +
    `简答/计算/证明映射成 big。**不要自创 judge/fill/short 这类题型名。**\n\n` +
    `### 输出这个 JSON\n` +
    json({
      sourceId: '<照抄上面给的 id>',
      role: '<照抄上面给的角色>',
      summary: '这份材料是什么、覆盖什么（≤300 字）',
      outline: [{ title: '小节标题', points: ['这一小节的核心结论'] }],
      terms: [{ zh: '中文术语', en: 'English' }],
      formulas: ['T = nI'],
      constants: [{ name: '真空磁导率', value: '4π×10⁻⁷', unit: 'H/m' }],
      questionTypes: [{ shape: '两步计算', mapped: 'big', note: '每年必考' }],
      coverage: { truncated: false, note: '如果你只看到了一部分材料（被截断），把 truncated 写成 true' },
      warnings: ['这份材料里我没看懂的地方'],
    }) +
    `\n\n（questionTypes 只在 exampaper 时必填；别的角色给了也没关系。` +
    `不要输出任何解释文字，只给一个 JSON 对象。）\n\n` +
    `### 材料正文\n` +
    sourceText(pagesOf(src), { maxChars: role === 'exampaper' ? 20000 : 24000 });

  return { system: systemPrompt('analyze', { language: lang }), user };
}

/**
 * 把历年真题里提炼出的**题型规律**渲染成一段"必须贴合"的约束。
 *
 * 没有真题来源时返回空串——**不制造噪音**：只导了一份课件的人不该在提示词里
 * 看到一整节跟他无关的规矩。
 */
function questionTypeBlock(ctx) {
  const papers = ((ctx && ctx.sources) || []).filter((s) => s && s.role === 'exampaper' && s.note);
  if (!papers.length) return '';
  const rows = [];
  for (const s of papers) {
    for (const q of (s.note.questionTypes || [])) {
      if (!q || !q.shape) continue;
      rows.push(`- ${q.shape} → 用 \`${q.mapped}\`${q.note ? `：${q.note}` : ''}`);
    }
  }
  if (!rows.length) return '';
  return (
    '### 真题题型规律（**出题必须贴合这些形态**）\n' +
    rows.slice(0, 16).join('\n') + '\n' +
    '右边那一列是它在我们引擎里对应的题型。**`type` 只能取 single / multi / num / big 这四种**，' +
    '不要自创 judge（判断）、fill（填空）、short（简答）这类名字 —— 引擎不认识它们，' +
    '后果是题目被降级成单选、答案语义错位，**而页面不会有任何报错**。'
  );
}

/* ---------------- 跨章：前面几章讲了什么 ---------------- */

/**
 * 「关联生成」时才存在的那一段（用户在这一册的两章关联大时，在运行中选了它）。
 *
 * ⚠️ 返回的是**行数组**，不是字符串 —— 调用点用 `...` 展开进 `[...].join('\n')`。
 * 这么写是为了"没有这个字段时**逐字节不变**"：往数组里插一个空串会让 `join('\n')`
 * 多出一个空行，而绝大多数生成走的是"简单缝合"那一路，它们的提示词一个字都不许变。
 *
 * 为什么只给摘要：这一段的用处是"知道前面讲过什么"，不是"再读一遍前面的材料"。
 * 上下文要留给这一章自己的原文；而摘要本来就是"这份材料是什么"里密度最高的那一段。
 */
function priorChapterLines(ctx) {
  const rows = ((ctx && ctx.priorChapters) || []).filter((c) => c && c.summary);
  if (!rows.length) return [];
  return [
    '',
    '### 这本册子里**前面**已经讲过的章',
    '（用户选了「关联生成」，所以下面这些你在写这一章时要**主动照应**：前面讲过的概念不要'
      + '再从头解释一遍，能引用就引用；本章要用的工具如果前面讲过，点一句"上一章那个 X 在这里'
      + '怎么用"。**但不要为呼应而呼应** —— 跟本章没关系的地方就别硬扯。）',
  ].concat(rows.map((c) => `- 第 ${c.no} 章${c.title ? '「' + c.title + '」' : ''}：${c.summary}`));
}

/* ---------------- S1 · 切单元 ---------------- */

function planMessages(ctx) {
  const { meta, options } = ctx;   // 素材走 materialForPlan(ctx)，这里不再直接读 ctx.pages
  const unitLo = 3;
  const unitHi = 8;
  const want = Math.min(unitHi, Math.max(unitLo, options.units || 6));
  const user = [
    '## 任务：切单元（S1 / outline.json）',
    '',
    `这门课件是：**${meta.subject || '（未填）'}** 的 **第 ${meta.number || '?'} 章 · ${meta.title || '（未填）'}**。`,
    `请把整章切成 **${want} 个讲解单元** + **1 个综合大题单元**，总共 ${want + 1} 个题区。`,
    `整章的作答点目标：**约 ${options.points || 65} 个**（概念题与计算题大致各半，综合大题占 1/4 左右）。`,
    options.demos > 0
      ? `请设计 **${options.demos} 个可拖演示**（详见契约 §1.2 的 demos 字段）。`
      : '不要设计演示（demos 给空数组）。',
    '',
    '**你这一轮只切结构、配额度，不要写正文、不要写题。**',
    '',
    '### 输出前自查（不满足就改到满足）',
    '1. `answerPoints` == Σ`units[].targetCount` + `bigUnit.targetCount`（**必须精确相等**）',
    '2. `units[].lv` 互不重复，且构成 0..n 的连续序列（热身单元是 0；不要热身就从 0 开始）',
    '3. `sectionId` / `uid` / `qsecId` 全局唯一；`qsecId == "p-l"+lv`；`refAnchor == "#"+sectionId`',
    '4. 每个 `qsecTitle` 以「练一练」开头，且**不含**「已答」二字',
    '5. `chapter.key` **不要写**——宿主程序会自己生成存盘键，你写了也会被覆盖。',
    ...priorChapterLines(ctx),
    '',
    /* ⚠️ 这里必须走 materialForPlan，不能直接 sourceText(ctx.pages, …)。
         多来源时规划要的是**各份来源的分析结论**（融合后的结构），而不是几份原文——
         N 份原文全塞进这一步是最容易把上下文顶爆的地方。
         单来源课件时 materialForPlan 内部就退化成原来那一句，输出逐字节不变。 */
    ctx.sources && ctx.sources.length > 1 ? '### 各来源的材料' : '### 课件原文',
    materialForPlan(ctx),
    '',
    '只返回 S1 的 JSON。',
  ].join('\n');
  return { system: systemPrompt('plan', { language: langOf(ctx) }), user };
}

/* ---------------- S2 · 单元讲解正文 ---------------- */

function proseMessages(ctx, unit) {
  const { outline, options } = ctx;
  const demos = (outline.demos || []).filter((d) => d.unitUid === unit.uid);
  const user = [
    `## 任务：写「${unit.title}」这一节的讲解正文（S2 / unit-prose.json）`,
    '',
    `所属：${outline.chapter.subject} 第 ${outline.chapter.no} 章 · ${outline.chapter.title}`,
    // uid / sectionId 必须原样回填：执行层靠它把这份正文对上是哪个单元。
    // 不写在提示里，模型就只能猜，猜错的表现是"两个单元换了正文"且不报错。
    `本单元的 uid 是 "${unit.uid}"，sectionId 是 "${unit.sectionId}" —— 请**原样**回填到输出的同名字段里。`,
    `本节要讲透的概念：${(unit.concepts || []).join('、')}`,
    unit.formulas && unit.formulas.length ? `本节的核心公式：${unit.formulas.join('；')}` : '',
    ...priorChapterLines(ctx),
    '',
    '**讲法按 skill 的既定四段式，不许改**：每个知识块内部依次写',
    '① 大白话：这一块要解决什么问题 → ② 核心公式 → ③ 公式为什么长这样 → ④ **单独一段易错点**。',
    '公式后面给一句**记忆锚**（口诀或图像）。**记忆锚与易错点是重点，不许省。**',
    '',
    // ⚠️ 这行原来写成「（`<h3>`）」，模板字符串里的裸反引号会把 `<h3>` 甩到 JS 语法里去，
    // 变成 `字符串 < h3 > 字符串` 这种**语法合法、语义错误**的比较表达式（报 h3 is not defined）。
    // 凡是模板字符串，正文里提到标签一律用 ⟨⟩ 或去掉反引号——这个坑探针查不出来，只有真跑才炸。
    `写 ${Math.max(1, Math.min(4, (unit.concepts || []).length))} 个知识块（每个知识块一个 <h3> 小标题）。`,
    '',
    '### 硬性要求',
    '- `html` **从 `<h3>` 开始**，**不要**写 `<section>` / `<h2>` 外壳（宿主程序会加）。',
    '- 不许出现 `<script>`、`<style>`、`<h1>`；不许引 MathJax / LaTeX / CDN；公式一律用纯 HTML + Unicode 写。',
    '- `<h3>` 上要带一个稳定的 id（形如 `id="k1311"`），题库的「回看」链接会指向它。',
    demos.length
      ? `- 本节的演示要嵌在它对应的知识点**正下方**，位置写成占位注释：${demos.map((d) => `\`<!--DEMO:${d.id}-->\``).join('、')}（每个**恰好出现一次**，不要写演示的 HTML，宿主会填）`
      : '',
    '- `blocks` 字段必须**精确等于** `html` 里 `<h3>` 的出现次数。',
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 18000 }),
    '',
    '只返回 S2 的 JSON（`{uid, sectionId, blocks, html}`）。',
  ]
    .filter(Boolean)
    .join('\n');
  return { system: systemPrompt('prose', { language: langOf(ctx) }), user };
}

/* ---------------- S3 · 单元题库 ---------------- */

function bankMessages(ctx, unit) {
  const { outline, options } = ctx;
  const isBig = !!unit.isBigUnit;
  const n = unit.targetCount || 10;
  const mix = isBig
    ? `全部用 \`type:"big"\` 的大题（一步一问），**parts 总数必须精确等于 ${n}**，建议 ${Math.max(1, Math.round(n / 5))} 道大题、每题 4~6 步。`
    : `共 **${n} 个作答点**。建议配比：单选/多选约 ${Math.round(n * 0.4)} 个、填数值约 ${Math.round(n * 0.6)} 个。`;
  const user = [
    `## 任务：写「${unit.title}」这一节的题库（S3 / bank.json）`,
    '',
    mix,
    // 关联生成时，前面几章讲过的概念就不要再出重复的题了
    ...priorChapterLines(ctx),
    '',
    ...(questionTypeBlock(ctx) ? [questionTypeBlock(ctx), ''] : []),
    '### 硬性要求（每一条都会被执行层机械校验，不合格会打回重写）',
    '- 数值题的 `ans` **必须是 JSON 数字**，写成字符串会永远判错。`2.51×10⁻⁴` 要写成 `2.51e-4`。单位写在 `unit` 字段里，不要写在 `ans` 里。',
    '- 单选恰好一个 `ok:true`；多选至少两个 `ok:true`（或至少两个正确项）。选项 2~6 个。',
    '- 每个选项都要有 `why`：正确项写「为什么对」，干扰项写「**它错在哪**」——这句是给学生看的，要具体。',
    '- 每题都要有 `hint`（**只给方向，不给答案**）。',
    '- `id` 只写本单元内唯一的短名（如 `l1-1`、`n1-2`），宿主会加前缀保证全局唯一。',
    '- `lv` 不用你写（宿主按单元填）。',
    '- 干扰项要**像真的**：用学生真会犯的错（把 H 当磁场强弱、漏掉 μ₀、把 μr 当 1…），不要写一眼假的。',
    isBig
      ? '- 综合大题要**把整章串起来**：题干给一个完整情境，每一步单独作答、单独判分。'
      : `- 题目要扣住这两件事：${(unit.concepts || []).join('、')}。`,
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 16000 }),
    '',
    `只返回 S3 的 JSON（\`{uid:"${unit.uid}", bankId:"bankN", lv:${unit.lv}, items:[...]}\`）。`,
  ].join('\n');
  return { system: systemPrompt('bank', { language: langOf(ctx) }), user };
}

/* ---------------- S3.5 · 独立审题（对应 skill 的「子代理 B」） ----------------
 *
 * skill 在 2026-10-16 的版本里加了一条：一章 ≥40 个作答点时，默认开两个子代理——
 * 一个出题、一个**独立重算**审题。理由是探针只验得了"判分逻辑对不对"，
 * **验不了"答案本身对不对"**：数值题答案错一位，学生就照着学错，这是最贵的一类错。
 *
 * 应用里没有子代理，但**可以真的再调一次模型**：给它题库和素材、不给任何出题过程的痕迹，
 * 让它自己从头算一遍。这正是"独立"的含义——它的判断不依赖出题人的推导。
 */
function auditMessages(ctx, unit, bankItems, opts) {
  const total = (opts && opts.total) || 1;
  const index = (opts && opts.index) || 1;
  const user = [
    `## 任务：独立审题 —— 把「${unit.title}」这一节的题库重算一遍`,
    '',
    '你是**审题人**，不是出题人。你看不到出题过程，也**不要去猜**它当时怎么想的。',
    '你唯一的职责：**用你自己的推导，独立判断每道题的答案对不对**。',
    '',
    '### 为什么要你来（这不是走过场）',
    '自动探针只能验证"判分逻辑对不对"（选项标了 ok 没有、数值容差合不合理、卡片渲染出来没有），',
    '**验证不了"答案本身对不对"**。数值题答案错一位，学生就照着错一位学下去——',
    '这是这套材料里最贵的一类错误，而它恰恰是自动检查抓不到的。',
    '',
    '### 怎么审',
    '1. **数值题**：自己从题干条件重新算一遍，与 `ans` 比。',
    '   注意常数与量级（μ₀ = 4π×10⁻⁷、c = 3×10⁸、10⁻⁴ 这类最容易错一位），',
    '   也要看 `tol` 是不是明显不合理（比如答案 300 却给 ±1 的容差）。',
    '2. **选择题**：标了 `ok:true` 的那个**是不是真的对**；每个干扰项**是不是真的错**；',
    '   `why` 里写的理由对不对（理由写反了同样是错——学生看的就是这句）。',
    '3. **多选题**：正确项的集合对不对（漏一个、多一个都算错）。',
    '4. **综合大题**：逐步重算，每一步都要对。',
    '5. 还要看：题干本身自不自洽、有没有两个选项其实都对、',
    '   数值题的答案有没有用到题干根本没给的条件。',
    '',
    // 多人交叉检验时，**必须告诉模型它是第几位**：它是独立重算的，不该猜别人在查什么，
    // 也不该为了"和前一位不一样"而刻意放过或加码。（顺带：假模型靠这句话区分审题人。）
    // 模板字符串：它本来就允许真换行，所以这里不写任何 \n 转义
    //（这个文件因为转义被写坏过两次，能不用就不用）
    total > 1
      ? `（你是 ${total} 位审题人里的**第 ${index} 位**。前面或后面还有别人在独立审同一份题库，
但你**看不到他们的结论**、也不需要猜他们在查什么。只按你自己的推导给出判断；
既不要因为"可能有人已经报过"就漏报，也不要为了显得不一样而硬报。
全对就照实写 {"issues":[]}。）`
      : '',
    '### 只报**你确信**的问题',
    '拿不准的**不要报**——误报会让出题人把本来对的改成错的。宁可漏报，不可误报。',
    '',
    '### 输出（只输出这一个 JSON）',
    '{"issues":[{"id":"题号","severity":"high","kind":"wrong-answer","detail":"问题是什么","suggest":"你认为应该是多少 / 应该怎么改"}]}',
    '',
    '- `severity`：`high` = 答案或判分会让学生学错（必须改）；`low` = 措辞、附加建议（可改可不改）。',
    '- `kind`：`wrong-answer` | `ambiguous` | `bad-why` | `off-topic` | `other`。',
    '- **全都正确就输出 {"issues":[]}** —— 这是正常且常见的结果，不要为了"交差"硬报几条。',
    '',
    '### 这一节对应的课件原文（核对常数、条件、单位用）',
    sourceTextAll(sourcesOf(ctx), { maxChars: 12000 }),
    '',
    '### 待审的题库',
    '```json',
    JSON.stringify(bankItems, null, 1),
    '```',
    '',
    '只返回那个 JSON。',
  ].join('\n');
  return { system: systemPrompt('bank', { language: langOf(ctx) }), user };
}

/* ---------------- S4 · 演示 ---------------- */

function demoMessages(ctx, demo) {
  const unit = (ctx.outline.units || []).find((u) => u.uid === demo.unitUid) || {};
  const user = [
    `## 任务：写演示 ${demo.id}（S4 / demo.json）`,
    '',
    `它属于「${unit.title || ''}」这一节。`,
    `拖什么：**${demo.slider}**`,
    `一句话结论（必须成立）：${demo.insight}`,
    `这条演示的物理公式：${demo.formula}`,
    `读数格子（3~4 个）：${(demo.readouts || []).join('、')}`,
    `画布：viewBox = "${demo.svgViewBox || '0 0 520 200'}"`,
    '',
    '### 硬性要求',
    `- \`markup\` 的根元素必须是 \`<div class="demo" id="${demo.id}">\`；里面所有元素 id 一律以 \`${demo.id}-\` 或契约 §4 的短前缀开头，**绝不与别的演示或题目卡片撞名**。`,
    '- `js` **不要包 `<script>` 标签**，必须以 `try{` 开头、以 `}catch(e){ console.error(...) }` 结尾（契约 §4.1 给了填空模板，照着填）。',
    '- **读数与图形都由公式现场算**，绝不许把数值写死；刻度坐标也要用 JS 算。',
    '- `viewBox` 四周留 8~12 单位余量（滑块拉到底时标签不能被裁）。',
    '- SVG 的 `<text>` 里**不能**用 `<sub>`/`<sup>`（会挤成一行）：数字下标用 ₀₁₂₃，字母写成 `μr`。',
    `- \`checks\` 给 2~3 组：你自己**按公式手算**出读数该是多少，再填 \`expect\`。**不许猜。**`,
    '',
    '### 篇幅（很重要）',
    '- `markup` 控制在 **60 行以内**、`js` 控制在 **80 行以内**、`checks` 只给 2~3 组。',
    '- 演示要**小而准**：一个滑块 + 两三个读数 + 一条曲线就够了，不要写复杂的动画或多组联动。',
    '- 写太长会被输出上限截断，那时**整段 JSON 都作废**（前功尽弃），宁可小一点。',
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 12000 }),
    '',
    '只返回 S4 的 JSON。',
  ].join('\n');
  return { system: systemPrompt('demo', { language: langOf(ctx) }), user };
}

/* ---------------- 修复回灌 ---------------- */

function repairMessages(ctx, stage, problems, previousRaw, what) {
  const lines = [
    `## 任务：上一轮生成的「${what}」没通过校验，请修好重出`,
    '',
    '### 具体问题（逐条改，别改别的地方）',
  ];
  // 修复轮里**必须重申这是哪个单元**：模型看不到上一轮的提示词了，
  // 只靠标题猜的话，它完全可能把第二个单元的题塞进第一个单元，而页面不会有任何报错。
  if (ctx && ctx.unit) {
    lines.push('');
    lines.push(`（重申）本单元的 uid 是 "${ctx.unit.uid}"，sectionId 是 "${ctx.unit.sectionId || ''}"，lv 是 ${ctx.unit.lv} —— 请原样回填。`);
  }
  for (const p of problems) lines.push(`- ${p}`);
  const prev = String(previousRaw || '').trim();
  if (prev) {
    lines.push('');
    lines.push('### 你上一轮的原样输出（供对照，可能被截断）');
    lines.push('```');
    lines.push(prev.slice(0, 6000));
    lines.push('```');
  } else {
    // 上一轮返回的是**空正文**。塞一个空的代码块进去只会让模型困惑
    // （"上一轮输出为空"本身不是它能修正的东西——要说清的是"没写出来"）。
    lines.push('');
    lines.push('### 说明');
    lines.push('你上一轮**没有输出任何正文**（不是格式问题，是空回复）。这一次请务必把完整的 JSON 写出来。');
  }
  lines.push('');
  lines.push('只返回修好后的完整 JSON（整份重出，不要只给差异）。');
  return { system: systemPrompt(stage, { language: langOf(ctx) }), user: lines.join('\n') };
}

module.exports = {
  systemPrompt,
  contractSections,
  contractPath,
  planMessages,
  proseMessages,
  bankMessages,
  auditMessages,
  demoMessages,
  repairMessages,
  /* ---- 多来源 ---- */
  sourceNoteMessages,   // S0：每份来源各一次独立分析
  sourceTextAll,        // 多来源的素材段（单来源时与从前逐字节一致）
  materialForPlan,      // 规划阶段要的素材
  sourcesOf,            // ctx → 来源列表（老调用退化成"只有一份课件"）
  questionTypeBlock,    // 真题题型规律 → 出题约束
  noteSummary,          // 一份来源的分析结论 → 一小段文字
  labelOf,              // 一份来源在提示词/日志里的称呼
  pagesOf,              // 一份来源该用哪几页（scope 生效时是那一节）
  ROLE_LABEL,
  ROLE_WEIGHTS,
  /* ---- 多章 ---- */
  priorChapterLines,    // 「关联生成」时那一段；没有 ctx.priorChapters 时返回**空数组**（逐字节不变）
  /* ---- 基础 ---- */
  sourceText,
  json,
};

/*__ISG_BUNDLE_END__*/};
  factories["sources"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 多来源：角色的定义、入参归一、以及「来源分析结论」的校验。
 *
 * 分工：**提示词住在 `prompts.js`**（这个仓库的约定——所有给模型看的话都在那一个文件里，
 * 免得改措辞时要满仓库找）。这里只管**结构**：哪些角色合法、一份结论长什么样、
 * 什么样的结论必须打回重写。
 *
 * 为什么校验要写在这里而不是塞进流水线：这些规则每一条都对应一次真实的失败，
 * 它们值得有名字、有注释、能被单独测。塞进流水线的 `if` 里，下一个人只会看到一堆条件。
 */

const { KNOWN_TYPES } = require('./bank');

const ROLES = new Set(['courseware', 'textbook', 'exercises', 'exampaper']);

/**
 * 把界面/调用方给的入参归一成 `sources[]`。
 *
 * **向后兼容是这里的一半职责**：老调用只给 `input.filePath`（`test/e2e-mock.js`
 * 与 `test/auditors.js` 都直接 `createJob({filePath})`，连 IPC 都不走），
 * 那种调用要退化成"只有一份课件"，行为与从前完全一致。
 *
 * 出错时**抛错**而不是静默填默认值：角色写错、没给路径这类事必须当场说出来。
 * 调用方（IPC）把它转成 `BAD_ARG` 信封；默认值会让人以为配置生效了。
 */
function normalizeSources(input) {
  const raw = input && Array.isArray(input.sources) ? input.sources : null;

  if (raw && raw.length) {
    return raw.map((s, i) => {
      const at = `第 ${i + 1} 份来源`;
      const role = String((s && s.role) || '');
      if (!ROLES.has(role)) {
        throw new Error(`${at}的角色「${role || '没填'}」不认识——只认 ${[...ROLES].join(' / ')}`);
      }
      const filePath = String((s && s.filePath) || '');
      if (!filePath) throw new Error(`${at}没有给出文件路径`);
      return {
        id: String((s && s.id) || 's' + (i + 1)),
        role,
        filePath,
        fileName: String((s && s.fileName) || ''),
        label: String((s && s.label) || ''),
        scope: (s && s.scope) || null,
        /* 「这份材料属于第几章」。**与 role 是两个独立维度**：第 13 章的课本 + 课件是同一章的
           两份来源，而第 13 章与第 14 章是两章。留空 = "跟着 `options.chapterNo` 走"，
           全空时整份产出就是唯一的一章（老路径）。
           ⚠️ 这两个字段**必须原样带下去**：分组发生在流水线里（`pipeline/chapters.js`），
           中间任何一层把它们丢了，多章就会静默退化成"所有材料挤成一章"。 */
        chapterNo: String((s && s.chapterNo) || '').trim(),
        chapterTitle: String((s && s.chapterTitle) || '').trim(),
      };
    });
  }

  if (input && typeof input.filePath === 'string' && input.filePath) {
    return [{
      id: 's1', role: 'courseware', filePath: input.filePath,
      fileName: '', label: '', scope: null, chapterNo: '', chapterTitle: '',
    }];
  }
  return [];
}

/** 递归收集对象里的所有字符串值（跳过 sourceId/role —— 那两个是回填字段，不是内容）。 */
function collectStrings(obj, out, depth) {
  const acc = out || [];
  if (depth > 6 || obj == null) return acc;
  if (typeof obj === 'string') { acc.push(obj); return acc; }
  if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, acc, (depth || 0) + 1);
    return acc;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === 'sourceId' || k === 'role') continue;
      collectStrings(obj[k], acc, (depth || 0) + 1);
    }
  }
  return acc;
}

/**
 * 这份结论里有没有**整段抄自材料原文**的字符串？
 *
 * 为什么要有这条机器判据：真题那一步的规矩是"只提炼规律，不摘抄原题"，
 * 而这句话写在提示词里是**没有牙齿的**——模型完全可能把整道大题连题干带选项贴进 `summary`，
 * 而 JSON 依旧合法、后面每一步都照常跑。用户以为拿到的是仿题，其实页面里是真题原文。
 *
 * 判据取 200 字以上、且在材料正文里**逐字命中前 120 字**的字符串。
 * 用前 120 字做探针而不是整串：模型往往会顺手改个标点或去个空格，
 * 整串比对会被这种无关紧要的改动绕过。
 */
function findCopiedText(note, pages) {
  const hay = (pages || []).map((p) => (p && p.text) || '').join('\n');
  if (!hay) return '';
  for (const s of collectStrings(note)) {
    if (typeof s !== 'string' || s.length < 200) continue;
    if (hay.includes(s.slice(0, 120))) return s;
  }
  return '';
}

/**
 * 校验一份来源分析结论。返回**问题列表**（空数组＝通过）。
 * 返回列表而不是抛错：调用方要把这些问题**回灌给模型**让它重写，所以它们得是文字。
 */
function validateSourceNote(note, src, pages) {
  const bad = [];
  if (!note || typeof note !== 'object' || Array.isArray(note)) return ['返回的不是一个 JSON 对象'];

  /* ⚠️ 回填字段必须对得上。不查会怎样：模型在分析"课本"那一份时，
     顺手写成了上一次调用里的 sourceId —— 于是这份结论被挂到**另一份来源**头上，
     后面的融合拿错材料还不知道。这与 repairMessages 里"重申 uid"是同一类教训。 */
  if (String(note.sourceId == null ? '' : note.sourceId) !== src.id) {
    bad.push(`sourceId 必须原样回填 "${src.id}"，你写的是 "${note.sourceId}"`);
  }
  if (String(note.role == null ? '' : note.role) !== src.role) {
    bad.push(`role 必须原样回填 "${src.role}"，你写的是 "${note.role}"`);
  }
  if (!note.summary || !String(note.summary).trim()) bad.push('summary 不能为空——用一句话说清这份材料是什么、覆盖什么');

  if (src.role === 'exampaper') {
    const qt = Array.isArray(note.questionTypes) ? note.questionTypes : [];
    if (!qt.length) bad.push('历年真题必须给出 questionTypes —— 这份卷子由哪些题型构成');
    qt.forEach((q, i) => {
      if (!q || !q.shape) { bad.push(`questionTypes[${i}] 缺 shape（这一题型长什么样）`); return; }
      if (!KNOWN_TYPES.has(q.mapped)) {
        bad.push(`questionTypes[${i}].mapped 是「${q.mapped}」，不是四种题型之一`
          + '（single 单选 / multi 多选 / num 填数值 / big 综合大题）。'
          + '判断题请映射成两个选项的 single，填空题用 num，简答与计算用 big。');
      }
    });
  }

  const copied = findCopiedText(note, pages);
  if (copied) {
    bad.push(`疑似摘抄了材料原文（有一段 ${copied.length} 字的内容在材料里逐字出现）。`
      + '这里只要**结论与规律**（讲了哪些知识点、什么题型、常考什么），不要把原文贴进来。');
  }

  return bad;
}

/* 一份结论会进后面每一次调用（每个单元两次起步），所以必须封顶。
   超了就砍最长的那些数组，而不是砍 summary —— summary 是信息密度最高的那一段。 */
const NOTE_MAX_CHARS = 2500;

function trimNote(note) {
  if (!note || typeof note !== 'object') return note;
  const out = Object.assign({}, note);
  const size = () => JSON.stringify(out).length;
  const trim = (key, keep) => {
    if (Array.isArray(out[key]) && out[key].length > keep) out[key] = out[key].slice(0, keep);
  };
  for (const [k, keep] of [['outline', 6], ['terms', 15], ['formulas', 8], ['constants', 8], ['questionTypes', 10], ['warnings', 3]]) {
    if (size() <= NOTE_MAX_CHARS) break;
    trim(k, keep);
  }
  if (size() > NOTE_MAX_CHARS && typeof out.summary === 'string') {
    out.summary = out.summary.slice(0, 300);
  }
  return out;
}

/**
 * 这份来源实际该用哪几页。
 *
 * 课本整本塞不进任何模型的上下文（几百页），所以按**一章/一节**给——用户填了页码范围就只取那一段。
 * 没填 scope、或填了但两头都是空的，就返回全部页（课件/习题/真题的正常路径）。
 * 取不到的边界情况一律返回全部页而不是空数组：**宁可多给，也不要静默把材料变成空的**。
 */
function scopePages(pages, scope) {
  const list = pages || [];
  if (!scope) return list;
  const from = Number(scope.pageFrom) || 0;
  const to = Number(scope.pageTo) || 0;
  if (!from && !to) return list;
  const out = list.filter((p) => (from ? p.index >= from : true) && (to ? p.index <= to : true));
  return out.length ? out : list;
}

module.exports = { ROLES, normalizeSources, validateSourceNote, trimNote, findCopiedText, scopePages };

/*__ISG_BUNDLE_END__*/};
  factories["chapters"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 多章生成：**怎么把一堆材料分成几章**、**章序怎么排**、**新旧章接不接得上**、
 * 以及**两章之间像不像在讲同一件事**。
 *
 * 为什么单独一个文件、而且只有纯函数：这四个问题**全是判据**，不是流程。
 * 判据写进流水线里就会变成一堆 `if`，下一个人既看不出规则，也没法单测；
 * 而这个仓库最贵的一课正是"规则藏在流程里 ⇒ 出错时没人说得清它到底按什么判的"。
 *
 * ⚠️ 这里**不读盘、不发请求、不碰 job**。给什么算什么，算不出来就如实说算不出来。
 */

/** 一份材料"有效章号"的来源：材料自己标的优先，没标才看全局的那个默认章号。 */
function pickOptionsChapterNo(options) {
  const o = options && typeof options === 'object' ? options : {};
  /* `chapterNo` 是**契约里的名字**（界面/§4.1 发给主进程的那套字段名）。
     再认一个 `number` 是刻意的容错：`ipc.js` 的 normalizeOptions 会把
     界面字段 `chapterNo` 改名成流水线字段 `number`，所以"归一之后的那份 options"
     里是没有 `chapterNo` 的。谁要是把归一后的 options 递进来而这里只认 chapterNo，
     结果不是报错而是**静静地全归成"没填章号"⇒ 一份材料一章**——
     正是这个仓库最怕的那种"看着完全正常"的错。两者都在时以 chapterNo 为准。 */
  const a = o.chapterNo;
  if (a !== undefined && a !== null && String(a).trim() !== '') return String(a).trim();
  const b = o.number;
  if (b !== undefined && b !== null && String(b).trim() !== '') return String(b).trim();
  return '';
}

/** 日志/报错里指一份材料用的人话。 */
function sourceName(s, i) {
  const x = s && typeof s === 'object' ? s : {};
  return String(x.label || x.fileName || x.filePath || x.id || `第 ${i + 1} 份`);
}

/**
 * 一份材料归到哪一章。
 * 材料自己标了就用它；没标 ⇒ **全局那个章号**（老路径：一份材料 + 章号填在选项里）。
 */
function effectiveNo(src, options) {
  const own = src && src.chapterNo;
  const ownStr = own === undefined || own === null ? '' : String(own).trim();
  return ownStr || pickOptionsChapterNo(options);
}

/* 章号"像不像数字"。只认非负整数与小数：章号不会带正负号、也不会是科学计数法，
   多余的容忍只会让 "1e2" 这种怪东西被当成第 100 章。 */
const NUMERIC_NO = /^\d+(?:\.\d+)?$/;

/**
 * 章序比较器（给 `Array.prototype.sort` 用）。
 *
 * 规则：**两边都像数字就按数值比，否则按字符串比**。
 * 为什么不是"能转数字就按数字"：一章叫「附录」、一章叫「13」时，
 * 把「附录」转成 NaN 再去比，排序结果取决于引擎怎么处理 NaN —— 那是不可复现的。
 * 宁可退成字符串比较（结果稳定、可解释），也不要一个"大部分时候对"的序。
 *
 * 数值相等但写法不同（`013` 与 `13`）时再按字符串决定先后：
 * 返回 0 会把这个顺序交给 sort 的稳定性，而稳定性是实现的细节，不该被依赖。
 */
function compareChapterNo(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (NUMERIC_NO.test(x) && NUMERIC_NO.test(y)) {
    const nx = Number(x);
    const ny = Number(y);
    if (nx !== ny) return nx < ny ? -1 : 1;
  }
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * 把材料分组成章。
 *
 * @param {Array} sources 归一之后的 `sources[]`（可能带 `chapterNo` / `chapterTitle`）
 * @param {Object} options 原始 `input.options`（读 `chapterNo` / `subject`）
 * @returns {{ok:true, chapters:Array}|{ok:false, code:string, message:string}}
 *   Chapter = `{ no, title, subject, sources:[source…] }`
 *
 * 三条规则各自对应一次真实的坏结果：
 *   1. **全都没填章号** ⇒ 一章（`no:''`）。这是老路径：只给一份材料、章号留空，
 *      改造前改造后必须**逐字节一样**（`test/assemble-smoke.js` 的 sha256 压着）。
 *   2. **有的填了、有的没填** ⇒ 当场 `NO_CHAPTER`，且点名**是哪几份**没填。
 *      不报的话，那几份会被默默并进"全局章号"那一章里 —— 用户以为分好了章，
 *      拿到的却是一章混着两章的内容，而且**要复习到才看得出来**。
 *   3. **只有一部分材料时**也一样：分组只按章号，不看份数。
 */
function groupSources(sources, options) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s === 'object') : [];
  if (!list.length) {
    /* 空输入**不是**"一章空章"。真放过去，流水线会拿到一个一份材料都没有的章节去跑，
       错误会出现在离这里很远的地方（模型对着一份空材料硬编）。
       这里就地说清楚，代价是一条 message。 */
    return { ok: false, code: 'NO_SOURCES', message: '还没有选任何材料——先拖一份课件或课本进来' };
  }

  const noByIdx = list.map((s) => effectiveNo(s, options));

  // 规则 2：一部分有一份没有 —— 说不清"没填的那几份"该并进哪一章，只能当场拒
  const missing = [];
  noByIdx.forEach((no, i) => {
    if (!no) missing.push(sourceName(list[i], i));
  });
  if (missing.length && missing.length < list.length) {
    return {
      ok: false,
      code: 'NO_CHAPTER',
      message: `有 ${missing.length} 份材料没填章号：${missing.join('、')}。`
        + '要么每份都填上它属于哪一章，要么全都留空（全都留空就是只生成一章）。',
    };
  }

  // 规则 3：按有效章号分组，章序按 compareChapterNo 升序
  const byNo = new Map(); // 章号 → Chapter（章号是字符串，Map 的键正好）
  for (let i = 0; i < list.length; i++) {
    const no = noByIdx[i];
    let ch = byNo.get(no);
    if (!ch) {
      ch = { no, title: '', subject: '', sources: [] };
      byNo.set(no, ch);
    }
    ch.sources.push(list[i]);
    // 规则 5：章标题取组内**第一份非空**的 chapterTitle（空标题后面由流水线自动推断）
    if (!ch.title) {
      const t = list[i].chapterTitle;
      if (t !== undefined && t !== null && String(t).trim()) ch.title = String(t).trim();
    }
  }

  const chapters = [...byNo.values()].sort((a, b) => compareChapterNo(a.no, b.no));
  // 规则 6：subject 是**整次生成**的，不是每份材料各自的
  const subject = options && options.subject != null ? String(options.subject) : '';
  for (const ch of chapters) ch.subject = subject;

  return { ok: true, chapters };
}

/* ---------------- 新旧章接不接得上 ---------------- */

/**
 * 新章紧接在旧章后面吗？
 *
 * @param {Array<string|number>} newNos   这次要生成的章号
 * @param {Array<string|number>} knownNos 已经在册里的章号（"带上的章"）
 * @returns {{continuous:boolean, knownMin:number|null, knownMax:number|null,
 *            newMin:number|null, newMax:number|null, gapBefore:boolean}}
 *
 * "连续"的定义（两条**都要**成立）：
 *   1. 已知章号本身是一段**连续整数**（12、13 可以，12、14 不行）；
 *   2. `min(newNos) === max(knownNos) + 1`（14 接在 13 后面）。
 *
 * `gapBefore` = 新章**跳过了**旧章后面的号（旧 10、新 13 ⇒ 中间空着 11、12）。
 * 它是给日志/提示用的：接不上照样能出活（自成一份册子），但用户该被告知一声。
 *
 * ⚠️ **非数字章号一律判不连续**（宁可不缝，也不猜）。
 * 为什么这么死板：`上` / `下` / `附录` 这类章号既排不出序，也推不出"下一个是什么"。
 * 猜错的代价是**两支内容被缝成一份连续复习的书**，而错的地方要等用户复习到才发现；
 * 判错成"接不上"的代价只是少缝一次（产品形态上本来就是允许的 —— 自成一份册子）。
 * 这个仓库的惯例是"两个错里挑那个能看出来的"。
 *
 * 章号重复（12、12、13）按**集合**看：重复是用户手滑，不该因此判成"不连续"。
 */
function judgeContinuity(newNos, knownNos) {
  const toNums = (arr) => {
    const raw = Array.isArray(arr) ? arr : [];
    const out = [];
    let all = true;
    for (const v of raw) {
      const s = String(v == null ? '' : v).trim();
      if (!NUMERIC_NO.test(s)) { all = false; continue; }
      out.push(Number(s));
    }
    return { nums: [...new Set(out)].sort((a, b) => a - b), allNumeric: all && raw.length > 0 };
  };

  const know = toNums(knownNos);
  const news = toNums(newNos);
  const knownMin = know.nums.length ? know.nums[0] : null;
  const knownMax = know.nums.length ? know.nums[know.nums.length - 1] : null;
  const newMin = news.nums.length ? news.nums[0] : null;
  const newMax = news.nums.length ? news.nums[news.nums.length - 1] : null;

  /* 已知章号是不是一段连续整数：排序去重之后逐个差 1 就行。
     （`allNumeric` 已经保证里面没有"附录"这种混进来的东西。） */
  let knownRun = know.allNumeric && know.nums.length > 0;
  for (let i = 1; knownRun && i < know.nums.length; i++) {
    // 章号是整数才有"下一号"可言：12.5 接 13.5 不是章与章的关系
    if (!Number.isInteger(know.nums[i]) || know.nums[i] !== know.nums[i - 1] + 1) knownRun = false;
  }

  /* 没有旧章可接时返回**不连续**，而不是"空集也算连续"：
     调用方要问的是"这次的新章能不能缝进手上这一册"，手上什么都没有时就没什么可缝的；
     而返回 true 会让上层去算一个不存在的接缝（`max(knownNos) + 1` 是 undefined+1）。
     产品上这与"接不上"是同一个处理（自成一份册子），所以不会丢掉任何东西。 */
  const continuous = !!(knownRun
    && news.allNumeric
    && newMin !== null
    && knownMax !== null
    && news.nums.every((n) => Number.isInteger(n))
    && newMin === knownMax + 1);

  const gapBefore = !!(knownMax !== null && newMin !== null && newMin > knownMax + 1);

  return { continuous, knownMin, knownMax, newMin, newMax, gapBefore };
}

/* ---------------- 两章像不像在讲同一件事 ---------------- */

/* 阈值：两条都按 §4.5 定死在这里，别处不许再写魔数。
   ASK  —— 高到值得**打断用户**问一句"要不要关联生成"；
   NOTE —— 低到只值得在日志里提一句"这两章可能有点关系"（问会烦人，不提又会漏）。 */
const AFFINITY_ASK = 0.25;
const AFFINITY_NOTE = 0.12;

/* 中日韩统一表意文字（含扩展 A 与兼容区）。用来判"这个字符串要不要额外切 2-gram"。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 一段文字 → 词元集合。
 *
 * 两套表示**都要**（并集，见 §4.5 的"中文按字/词都要能对上"）：
 *   · **整串**：对上"词"。同一个术语两边写法一致时（`磁通量` / `磁通量`，
 *     `Magnetic Flux` / `Magnetic Flux`）直接命中 —— 这是最强的信号，不该被切碎。
 *   · **中文 2-gram**：对上"字"。中文没有空格，整串比对要求一字不差，
 *     而两章讲同一件事时措辞几乎不会完全相同（`磁通量` / `磁通密度`、
 *     `安培环路定理` / `环路定理`）。切成 2-gram 之后这类重叠才看得见。
 *     只切 2-gram 不切 1-gram：单字（`场`/`的`）在任何两份物理材料里都会撞上，
 *     那不是"像在讲同一件事"，那是噪声。
 *
 * 英文一律转小写：`magnetic field` 与 `Magnetic Field` 是同一个术语，
 * 大小写不同不该算成两个词（中文转小写无影响，所以这一段对所有串都安全）。
 */
function tokensOf(text) {
  const out = new Set();
  const s = String(text == null ? '' : text).trim();
  if (!s) return out;
  out.add(s.toLowerCase());
  if (!CJK.test(s)) return out;
  /* 只在**连续的汉字段**内切：混排的 `磁场 magnetic` 切成跨段的 2-gram
     会造出 `场 ` 这种既不是汉字也不是词的碎片，把交集撑大。 */
  for (const run of s.match(/[㐀-䶿一-鿿豈-﫿]+/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 从一份来源分析结论（`note`）里取词元。只取 §4.5 指定的三处：术语（中/英）与结构标题。 */
function tokensOfNote(note) {
  const out = new Set();
  if (!note || typeof note !== 'object' || Array.isArray(note)) return out;
  const terms = Array.isArray(note.terms) ? note.terms : [];
  for (const t of terms) {
    if (!t || typeof t !== 'object') continue;
    for (const tk of tokensOf(t.zh)) out.add(tk);
    for (const tk of tokensOf(t.en)) out.add(tk);
  }
  const outline = Array.isArray(note.outline) ? note.outline : [];
  for (const u of outline) {
    if (!u || typeof u !== 'object') continue;
    for (const tk of tokensOf(u.title)) out.add(tk);
  }
  return out;
}

/**
 * 两份来源分析结论有多像（0..1，集合 Jaccard：交集 ÷ 并集）。
 *
 * ⚠️ **任一份为空 ⇒ 0，不做假设**。为什么不做"缺一份就按另一份算"之类的兜底：
 *   这个数只有两个用途 —— 要么触发一次**打断用户**的提问，要么在日志里提一句。
 *   两份都没内容却算出个高分，用户会被一个莫名其妙的问题拦住；
 *   而返回 0 的后果只是"少问一次、按默认的简单缝合继续"。两个错里挑那个安静的。
 */
function chapterAffinity(noteA, noteB) {
  const a = tokensOfNote(noteA);
  const b = tokensOfNote(noteB);
  if (!a.size || !b.size) return 0; // 其中一份没内容，或两份都没有
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/* 导出面**恰好是这六个**（§4.2 的三个判据 + §4.5 的关联度与两个阈值）。
   多导出一个名字就是多一个接口：下一个人会以为它有约定、会去依赖它。 */
module.exports = {
  groupSources,
  compareChapterNo,
  judgeContinuity,
  chapterAffinity,
  AFFINITY_ASK,
  AFFINITY_NOTE,
};

/*__ISG_BUNDLE_END__*/};
  factories["revive"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 反推：把一份**已经生成好的单文件学习页 HTML** 还原成结构化数据。
 *
 * 为什么需要它：用户想把「以前生成的页面」跟新生成的一章**合成一册**。
 *   · 本应用自己生成的页面 → 从现在起会把结构化数据落盘，走那条路是准的；
 *   · 别人传给他的、或本功能上线前生成的 HTML → 只有成品文件，只能从 HTML 反推。
 * 产物格式是我们自己定的（page-skeleton.html 经 assemble.js 替换），所以反推可行。
 *
 * ⚠️ **反推的成功标准不是"能拼出一份 JSON"，而是"对不上时必须报出来"。**
 * 一份安静生成出来的错结构，用户几周后才会发现（拿到一册串了单元的复习书），
 * 那时已经无从追查是哪一步错的。所以返回值里 problems 与 data 同等重要：
 * 每一条对不上都要带"具体是哪个单元 / 哪个 id"与"建议怎么办"。
 * `ok:false` 时 data 一律为 null —— 宁可让调用方拿到"什么都没有"，
 * 也不能让它拿到一份"看起来是好的"错结构（需求里最硬的一条）。
 *
 * ── 反推**做不到**的三件事（写在这里，免得下游以为拿到了完整原稿）──
 *   1. 单元导语 vs 正文里的第一个 <p class="lede">：
 *      assemble 把 u.lede 单独渲染成 <p class="lede"> 放在 <h2> 后面；如果模型自己写的
 *      正文第一句正好也是 <p class="lede">…</p>，两者在成品页里长得**一模一样**，无从区分。
 *      （症状：合并后那一段会重复一次。）概率低，但确实是反推的分辨率上限。
 *   2. 演示的 markup 原本挂在正文的哪一处：占位注释 <!--DEMO:id--> 会被 assemble **就地替换**，
 *      替换后的 DOM 与"模型自己写在正文里的演示 DOM"在成品页里同样无从区分。
 *      本模块的策略是：**DOM 留在 lectureHtml 里不动**，这类演示的 markup 记成空串，
 *      只把 JS 收进 demos[]。位置不变、内容不丢；抠出来反而再也不知道该塞回哪一行。
 *   3. 模型原始输出的原文：id 已经是命名空间化过的（`u1-q1`）、`lv` 是我们写进去的、
 *      选项已被规范化过。反推拿到的是**规范化之后**的题库；重新拼装时会再规范化一次，
 *      id 会变成 `u1-u1-q1`。存盘键跟着变（见 references/pitfalls.md「id 即存盘键」）。
 *      需要保持存盘键不变的下游，请看 data.注。
 *
 * 纯函数：不碰网络、不碰 Electron、不碰文件系统，可以用 node runner 直接测。
 */

const { countPoints } = require('./bank');

/* ------------------------------------------------------------------ *
 * 锚点：与 assemble.js 的 MARK 是同一批字面量
 * ⚠️ 这里的匹配一律**对空白宽容**（行尾 \r?、缩进任意、标签间可有空白）：
 *    成品页是用户手里的文件，过一遍邮件/网盘/编辑器之后行尾与缩进都可能变。
 *    但"宽容"只用在空白上，**属性值一个字都不许含糊**——含糊处正是结构串行的高发区，
 *    所以凡是结构对不上，宁可报出来也不猜。
 * ------------------------------------------------------------------ */
const RE = {
  /** 正文区起点：骨架里的那句注释。注意它在**成品页里已经被 assemble 吃掉了**（见下）。 */
  contentStartComment: /<!--\s*讲：知识块写在这里[\s\S]*?-->/,
  /** 正文区终点：结算区。 */
  contentEnd: /<section id="result">/,
  /** 成品页真正的"正文开始"证据：目录卡（assemble 每次都生成它）。 */
  howtoCard: /<div class="card" id="howto">/,
  mainOpen: /<main>/,
  /** 讲解小节的开始：<section id="…"> 后面紧跟 <h2><span class="num">…。
   *  两个条件一起用是有原因的：正文是模型写的，理论上可能自己带一个
   *  <section id="x">；但"下一行就是 <h2><span class="num">"这个组合只有 assemble 会写。 */
  lectureOpen: /^[ \t]*<section id="([^"]+)">[ \t]*\r?\n[ \t]*<h2><span class="num">/gm,
  /** 题区：一个单元一个，id 是 p-l<单元序号>。 */
  qsec: /<section class="qsec" id="p-l(\d+)">/g,
  /** 题库段：一段一个单元。JSON 里的 `<` 已被转义成 <，所以段内不会出现 </script>。 */
  bankSeg: /<script data-bank id="([^"]*)" type="application\/json">([\s\S]*?)<\/script>/g,
  engineOpen: /<script id="engine">/,
  /** 演示槽：从注释到"收尾"注释之间。 */
  demoSlot: /\/\* =+ 章专用演示：把本章的演示 IIFE 放在这里 =+/,
  demoSlotEnd: /\/\* -+ 收尾 -+ \*\//,
  /** 引擎之前的"预置大肥鱼"脚本（只有 pet:'fish' 才会被塞进去）。 */
  fishSeed: /工作台生成时默认选用内置「大肥鱼」形象/,
  /** assemble 给交付页注入的 CSP：**它是"这页确实出自拼装器"最便宜的一条证据**。 */
  cspMeta: /<meta http-equiv="Content-Security-Policy"/,
};
/* 演示槽里的每一条演示。标题与"由工作台…"后缀都是 assemble 写的固定形状。
   ⚠️ 每处用到都要 new 一个新的 RegExp：带 /g 的正则对象是有状态的（lastIndex），
   共享一个实例会让第二次调用从上次的位置继续扫，症状是"第一次解析对、第二次少几条"。 */
const demoEntryRe = () =>
  /^[ \t]*\/\* (.+?) —— 由工作台(校验|补上兜底 try\/catch 的演示) \*\/[ \t]*\r?$/gm;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** assemble 的 escapeHtml 的逆。只认它真正会产出的那几个实体，认不出的原样留着。 */
function unescapeHtml(s) {
  return String(s == null ? '' : s).replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    if (name.charAt(0) === '#') {
      const n = name.charAt(1) === 'x' || name.charAt(1) === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, name) ? ENT[name] : m;
  });
}

function offsetToLine(text, off) {
  let n = 0;
  for (let i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 去掉 assemble 的 indent(html, 4)：每行最多去掉 4 个前导空格。
 *
 * ⚠️ skipLines 里的行必须原样保留。症状说明为什么：演示的 DOM 是**占位注释替换**塞进正文的
 * （替换发生在 indent() 之后），它的续行缩进是模型自己写的、没有被 +4 过；
 * 跟着一起减 4 会把 `<div class="demo-h">` 这种两格缩进减成顶格，
 * 反推出来的 lectureHtml 就跟原文不一样了（`<pre>` 里还会真的改变显示）。
 */
function dedentLines(text, skipLines) {
  const skip = skipLines || null;
  return String(text)
    .split('\n')
    .map((line, i) => {
      if (!line.trim() || (skip && skip.has(i))) return line;
      let k = 0;
      while (k < 4 && (line.charAt(k) === ' ' || line.charAt(k) === '\t')) k++;
      return line.slice(k);
    })
    .join('\n');
}

/**
 * 反推出来的正文一律用 `\n`，**不受原文件行尾影响**。
 *
 * 为什么不是原样保留：成品页的行尾常常不是拼装器写的那样——用户用记事本"另存为"过一次，
 * 整份文件就变成 CRLF，模型写的正文里于是多出一堆 `\r`。
 * 那种 `\r` 只是 HTML 里的空白、不影响显示（HTML 解析器本来就会把 CRLF 归一成 LF），
 * 但会让"同一份页面在改行尾前后反推出两个不同的结构"，
 * 于是 diff 里全是噪音、也没法断言往返一致。剥掉它，往返就与行尾无关。
 *
 * ⚠️ 只对 **HTML 文本**（讲解正文、演示 markup）用，**不要用在演示的 JS 上**：
 * JS 里的 `\r\n` 在模板字符串里是有意义的内容，归一化就等于偷偷改了程序。
 */
function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

/** 去掉首尾的空行（保留行内的缩进形态）。 */
function trimBlankLines(s) {
  const lines = String(s).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

/**
 * 在 html 里找出所有 `<div class="demo" …>…</div>`（按 div 配对，支持嵌套）。
 *
 * 为什么不用正则截取：演示的 DOM 是自己带闭合标签的一整块，正则数不了嵌套，
 * 遇到 `<div class="demo"><div class="row"><div>…` 会提前收尾，症状是 markup 被截半、
 * 后半截留在 lectureHtml 里变成"谁也管不着的野 DOM"。
 */
function findDemoDivs(html) {
  const out = [];
  const tagRe = /<div\b[^>]*>|<\/div\s*>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const t = m[0];
    if (t.charAt(1) === '/') {
      const open = stack.pop();
      if (open && open.isDemo) out.push({ start: open.at, end: m.index + t.length, id: open.id });
    } else {
      const c = /\bclass\s*=\s*"([^"]*)"/.exec(t) || /\bclass\s*=\s*'([^']*)'/.exec(t);
      const idm = /\bid\s*=\s*"([^"]*)"/.exec(t) || /\bid\s*=\s*'([^']*)'/.exec(t);
      stack.push({
        at: m.index,
        // 只认整词 demo：class="demo-h" / "demo-body" 不是演示外壳
        isDemo: !!(c && /(^|\s)demo(\s|$)/.test(c[1])),
        id: idm ? idm[1] : '',
      });
    }
  }
  return out;
}

/**
 * 把片段**开头**的 <p class="lede">…</p> 摘下来，返回 {lede, rest}。
 * ⚠️ `^\s*` 里的 `\s*` 不能省：片段是从上一行标签的**后面**切起的，开头是那个换行。
 * 只写 `^[ \t]*` 的话，只有导语正好跟在上一个标签同一行时才能摘到（实测踩到：
 * 导语被当成正文的第一段，于是它既在 lede 里、又在 lectureHtml 里，合并后重复一次）。
 */
function takeLede(fragment) {
  const m = /^\s*<p class="lede">([\s\S]*?)<\/p>[ \t]*\r?\n?/.exec(fragment);
  if (!m) return { lede: null, rest: fragment };
  return { lede: unescapeHtml(m[1]), rest: fragment.slice(m[0].length) };
}

function problem(code, level, message, hint) {
  return { code, level, message, hint: hint || '' };
}

/* ------------------------------------------------------------------ *
 * 第 1 块：页头（章标题 / 学科 / 章号 / 导语 / 页面自称的数字）
 * ------------------------------------------------------------------ */

function parseHeader(h, problems) {
  const head = /<header class="top">([\s\S]*?)<\/header>/.exec(h);
  const titleTag = /<title>([\s\S]*?)<\/title>/.exec(h);
  const out = { found: false, subject: '', no: '', title: '', intro: '', claimed: {} };

  // <title> 的形状是「第 X 章 · <章标题> · 讲练一体」；章号只能从这里或 eyebrow 拿。
  if (titleTag) {
    let t = unescapeHtml(titleTag[1]).replace(/[ \t]*·[ \t]*讲练一体[ \t]*$/, '');
    const m = /^第\s*(.+?)\s*章\s*·\s*([\s\S]*)$/.exec(t);
    if (m) { out.no = m[1].trim(); out.title = m[2].trim(); }
    else { out.title = t.trim(); }
  }

  if (!head) {
    problems.push(problem('header-missing', 'blocker',
      '页头解析不出来：这份文件里找不到 <header class="top">…</header>，章标题、学科、章号都拿不到。',
      '确认这是不是「讲练一体」页面（骨架页一定带这个页头）。若不是，这份文件不能用"从 HTML 反推"这条路，' +
      '请让用户改用手工提供的信息，或重新生成一次。'));
    return out;
  }
  out.found = true;
  const inner = head[1];

  const eye = /<span class="eyebrow">([\s\S]*?)<\/span>/.exec(inner);
  if (eye) {
    const parts = unescapeHtml(eye[1]).split(' · ');
    if (parts.length && parts[parts.length - 1] === '讲练一体') parts.pop();
    for (const p of parts) {
      const m = /^第\s*(.+?)\s*章$/.exec(p);
      if (m) { if (!out.no) out.no = m[1].trim(); }
      else if (!out.subject) out.subject = p.trim();
    }
  }
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(inner);
  if (h1) out.title = unescapeHtml(h1[1]).trim();
  const sub = /<p class="sub">([\s\S]*?)<\/p>/.exec(inner);
  if (sub) out.intro = unescapeHtml(sub[1]);

  // 页面自称的数字（页头 facts）：用来交叉核对"题目是不是少了几道"
  const pts = /<b>(\d+)<\/b><span>个作答点<\/span>/.exec(inner);
  const uns = /<b>(\d+)<\/b><span>个单元<\/span>/.exec(inner);
  const dms = /<b>(\d+)<\/b><span>个可拖演示<\/span>/.exec(inner);
  out.claimed = {
    points: pts ? Number(pts[1]) : null,
    units: uns ? Number(uns[1]) : null,
    demos: dms ? Number(dms[1]) : null,
  };
  if (!out.title) {
    problems.push(problem('chapter-title-missing', 'warn',
      '章标题解析不出来（页头里 <h1> 是空的）。合并后这一章在目录里会没有名字。',
      '手工补一个章标题。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 2 块：正文区（目录卡 + 每单元的小节 + 紧跟的题区）
 * ------------------------------------------------------------------ */

function parseBody(h, problems) {
  const out = { regionStart: -1, regionEnd: -1, howtoFound: false, howtoLinks: [], units: [] };

  const endM = RE.contentEnd.exec(h);
  if (!endM) {
    problems.push(problem('content-region-missing', 'blocker',
      '找不到结算区 <section id="result">，无法确定正文的范围。',
      '这份文件不是「讲练一体」页面（或被改坏过）。请让用户确认文件来源。'));
    return out;
  }
  out.regionEnd = endM.index;

  /* 正文区起点：骨架里那句「讲：知识块写在这里」的注释在**成品页里已经被吃掉了**
     （assemble.js 用 bodyParts 整段替换掉了它，注释本身不保留）。所以先找它、
     找不到再退到目录卡、再退到 <main>。第一次读这份代码的人很容易在这里踩空。 */
  const cm = RE.contentStartComment.exec(h);
  if (cm && cm.index < out.regionEnd) {
    out.regionStart = cm.index + cm[0].length;
  } else {
    const hw = RE.howtoCard.exec(h);
    if (hw && hw.index < out.regionEnd) {
      out.regionStart = hw.index;
      out.howtoFound = true;
    } else {
      const mn = RE.mainOpen.exec(h);
      if (mn && mn.index < out.regionEnd) out.regionStart = mn.index + mn[0].length;
    }
  }
  if (out.regionStart < 0) {
    problems.push(problem('content-region-missing', 'blocker',
      '找不到正文区的起点（既没有「讲：知识块写在这里」注释，也没有目录卡 <div class="card" id="howto">）。',
      '这份文件可能不是本工具生成的。请让用户确认它的来源。'));
    return out;
  }
  const region = h.slice(out.regionStart, out.regionEnd);

  // 目录卡：它本身是生成的、不用反推；但它里面那串锚点链接是**免费的一条校验**
  if (!out.howtoFound) {
    problems.push(problem('howto-missing', 'warn',
      '正文里没有「这一页怎么用」的目录卡（<div class="card" id="howto">）。这一块合并后会重新生成，不影响内容；' +
      '但它不见说明这一页**被人手工改过**，其余部分请一并留意。',
      '不用处理；若同时还有别的对不上，优先怀疑这份文件被改过。'));
  } else {
    const card = /<div class="card" id="howto">([\s\S]*?)<\/div>/.exec(region);
    if (card) {
      const aRe = /<a href="#([^"]+)">([\s\S]*?)<\/a>/g;
      let m;
      while ((m = aRe.exec(card[1]))) out.howtoLinks.push({ href: m[1], text: unescapeHtml(m[2]) });
    }
  }

  /* ---- 题区（先找题区，讲解小节靠它定位：题区是每个单元的收尾，位置最稳）---- */
  RE.qsec.lastIndex = 0;
  const qs = [];
  let q;
  while ((q = RE.qsec.exec(region))) qs.push({ at: q.index, atEnd: RE.qsec.lastIndex, lv: Number(q[1]), lid: q[1] });

  if (!qs.length) {
    problems.push(problem('no-units', 'blocker',
      '正文里一个题区（<section class="qsec" id="p-lN">）都没有。',
      '这份文件不是本工具生成的页面，或正文被整体删掉了。请让用户确认来源。'));
    return out;
  }

  RE.lectureOpen.lastIndex = 0;
  const lec = [];
  let L;
  while ((L = RE.lectureOpen.exec(region))) lec.push({ at: L.index, tagEnd: L.index + L[0].length, id: L[1] });

  qs.forEach((qsec, k) => {
    const u = {
      index: k, id: '', num: '', title: '', lede: '', quizLede: '',
      lectureHtml: '', qsecTitle: '', qsecLede: '', lv: qsec.lv, qsecId: 'p-l' + qsec.lid,
    };
    // 讲解小节 = 这个题区之前、上一个题区之后的最后一个讲解小节
    const floor = k > 0 ? qs[k - 1].atEnd : -1;
    let open = null;
    for (const l of lec) if (l.at > floor && l.at < qsec.at) open = l;
    if (!open) {
      problems.push(problem('lecture-missing', 'blocker',
        `第 ${k + 1} 个题区（id="${u.qsecId}"）前面找不到对应的讲解小节（<section id="…"> + <h2><span class="num">）。`,
        '正文结构已经乱了，无法确定这一节讲的是什么、属于哪个单元。请让用户重新生成这一章。'));
      out.units.push(u);
      return;
    }
    u.id = open.id;

    /* 标题行。窗口只开 600 字：再长就不是标题了，而放开到整节会让
       `[\s\S]*?</h2>` 匹配到正文深处偶然出现的 </h2>（正文是模型写的）。 */
    const h2slice = region.slice(open.at, open.tagEnd + 600);
    const h2m = /<h2><span class="num">([\s\S]*?)<\/span>([\s\S]*?)<\/h2>/.exec(h2slice);
    if (h2m) {
      u.num = unescapeHtml(h2m[1]);
      u.title = unescapeHtml(h2m[2]);
    } else {
      problems.push(problem('lecture-h2-unreadable', 'warn',
        `单元 ${k + 1}（section id="${open.id}"）的标题行看不懂（不是 <h2><span class="num">…</span>…</h2> 的形状）。`,
        '合并后这一节的编号与标题会是空的，需要手工补。'));
    }

    const closeAt = region.lastIndexOf('</section>', qsec.at);
    const bodyStart = h2m ? open.at + h2m.index + h2m[0].length : open.tagEnd;
    if (closeAt < 0 || closeAt < bodyStart) {
      problems.push(problem('lecture-unclosed', 'blocker',
        `单元 ${k + 1}（section id="${open.id}"）的 </section> 找不到，讲解正文的范围无法确定。`,
        '这份文件被改坏了。请让用户重新生成这一章。'));
      out.units.push(u);
      return;
    }
    let inner = region.slice(bodyStart, closeAt);
    const first = takeLede(inner);
    if (first.lede !== null) { u.lede = first.lede; inner = first.rest; }

    // 正文里的演示 DOM：它们没有经过 indent()，去缩进时要跳过这几行（见 dedentLines）
    const demoRanges = findDemoDivs(inner).map((d) => [d.start, d.end]);
    const skip = new Set();
    for (const [a, b] of demoRanges) {
      const la = offsetToLine(inner, a);
      const lb = offsetToLine(inner, b);
      for (let i = la; i <= lb; i++) skip.add(i);
    }
    /* ⚠️ 顺序：先归一 EOL，再去缩进。
       反过来的话（先去缩进再归一），行尾的 `\r` 会被当成行内容的一部分，
       于是"最后那行只有缩进的空行"判不出是空行、去不掉，
       归一之后它就变成一个多余的行尾换行——症状是同一份页面在 CRLF 与 LF 下
       反推出两个不一样的 lectureHtml，diff 里全是噪音。 */
    u.lectureHtml = trimBlankLines(dedentLines(normalizeEol(inner), skip));

    /* ---- 题区 ---- */
    /* 题区窗口要开得足够大：题区导语（quizLede）是模型写的一整段话，
       窗口窄了会在中间截断，导语就被读成半句（⚠️ 实测 900 字会截到，改 4000）。 */
    const qTail = region.slice(qsec.atEnd, qsec.atEnd + 4000);
    const qh = /<h2><span class="num">([\s\S]*?)<\/span>([\s\S]*?)<span class="cnt" data-cnt="(\d+)"><\/span><\/h2>/.exec(qTail);
    if (qh) {
      u.qsecTitle = unescapeHtml(qh[2]);
      u.cntIndex = Number(qh[3]);
    } else {
      u.cntIndex = null;
      problems.push(problem('qsec-h2-unreadable', 'warn',
        `单元 ${k + 1} 的题区标题行看不懂（不是 <h2><span class="num">练</span>…<span class="cnt" data-cnt="N"></span></h2> 的形状）。` +
        '题区标题会决定结算区里那一关叫什么，拿不到就只能用讲解标题兜底。',
        '手工确认一下这一节的"练一练"标题；其余内容不受影响。'));
    }
    /* ⚠️ 要从 `qh.index + qh[0].length` 切，不能只按长度切：h2 前面有缩进与换行，
       按长度切会从 h2 的**中间**开始，导语就永远摘不到（症状：每个单元的题区导语都读成空，
       还反过来报"讲解有导语、题区没有"，把人往"文件被改过"上引）。 */
    const ql = takeLede(qTail.slice(qh ? qh.index + qh[0].length : 0));
    if (ql.lede !== null) u.qsecLede = ql.lede;
    const lv = /<div class="qlist" data-lv="(\d+)">/.exec(qTail);
    u.dataLv = lv ? Number(lv[1]) : null;
    // 题区与讲解之间那一段：assemble 会把"占位注释没写进正文"的演示挂在这里
    u.gap = region.slice(closeAt + '</section>'.length, qsec.at);
    out.units.push(u);
  });

  // 最后一个题区之后还有讲解小节 → 多出来的一节，合并时会丢
  const lastQ = qs[qs.length - 1];
  const extra = lec.filter((l) => l.at > lastQ.at);
  if (extra.length) {
    problems.push(problem('lecture-after-last-qsec', 'warn',
      `最后一个题区之后还有 ${extra.length} 个讲解小节（id：${extra.map((e) => e.id).join('、')}），` +
      '它们没有配套的题区。',
      '这些小节的内容合并后会**丢掉**（结构里每个单元都必须带一段题库）。要保住就先把它们并进相邻单元。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 3 块：题库段（一段一个单元，段内是扁平数组）
 * ------------------------------------------------------------------ */

function parseBanks(h, problems) {
  const segs = [];
  const re = new RegExp(RE.bankSeg.source, 'g');
  let m;
  while ((m = re.exec(h))) segs.push({ id: m[1], text: m[2], index: segs.length });
  if (!segs.length) {
    problems.push(problem('no-banks', 'blocker',
      '一个题库段（<script data-bank …>）都没有。题目全部丢失，反推没有意义。',
      '这份文件不是本工具生成的页面，或题库段被整体删掉了。请让用户确认来源。'));
    return segs;
  }
  segs.forEach((s, i) => {
    const want = 'bank' + i;
    s.indexOk = s.id === want;
    try {
      s.items = JSON.parse(s.text);
    } catch (e) {
      s.items = null;
      s.error = e.message;
      problems.push(problem('bank-json-invalid', 'blocker',
        `题库段 ${i + 1}（id="${s.id}"）的 JSON 解析失败：${e.message}。` +
        (s.id !== want ? `（顺带一提，它的 id 应该是 "${want}"）` : '') +
        ' ⚠️ 这正是引擎会**静默吞掉**整段题库的那种坏法：页面上那几道题凭空消失，而页面不报任何错。',
        '这一段必须修好才能用。若只是想看其余单元，请让用户先把那一段的 JSON 补完整（多半是最后一个逗号或漏了引号）。'));
    }
  });
  return segs;
}

/* ------------------------------------------------------------------ *
 * 第 4 块：引擎区间的 PAGE 配置（pageKey / finalAdvice / pet）
 * ------------------------------------------------------------------ */

function parseEngine(h, problems) {
  const out = { found: false, pageKey: '', finalAdvice: '', pet: '', petImagesFound: false, bgEmpty: null };
  const open = RE.engineOpen.exec(h);
  if (!open) {
    problems.push(problem('engine-missing', 'blocker',
      '找不到引擎脚本 <script id="engine">。没有它就等于没有页面的存档键（PAGE.key），' +
      '合并后这一章的作答记录会跟别的章串在一起。',
      '这份文件不是本工具生成的页面。请让用户确认来源，或重新生成这一章。'));
    return out;
  }
  const bodyEnd = h.indexOf('</body>', open.index);
  if (bodyEnd < 0) {
    problems.push(problem('engine-unclosed', 'blocker',
      '引擎脚本之后找不到 </body>，页面结构不完整。',
      '这份文件被截断或被改坏了，请让用户重新生成这一章。'));
    return out;
  }
  out.found = true;
  const eng = h.slice(open.index, bodyEnd);

  /* PAGE 配置块：用 `var PAGE={` … 第一个 `};` 夹出来，而不是在整个引擎里搜。
     整个引擎里搜会被**注入进去的 finalAdvice** 骗到：收尾语里只要出现一次
     `key:'…'` 的字面量（比如在讲"存盘键是怎么配的"），就会命中错的那处，
     症状是 pageKey 反推成了收尾语里的例子，而且一声不响。 */
  const pi = eng.indexOf('var PAGE={');
  if (pi < 0) {
    problems.push(problem('page-block-missing', 'blocker',
      '引擎里找不到 PAGE 配置块（var PAGE={…}）。',
      '骨架页被改过，或这不是本工具生成的页面。请让用户确认来源。'));
    return out;
  }
  const pj = eng.indexOf('};', pi);
  const page = pj < 0 ? eng.slice(pi, pi + 4000) : eng.slice(pi, pj + 2);

  const km = /\bkey\s*:\s*'([^']*)'/.exec(page);
  if (!km) {
    problems.push(problem('pagekey-missing', 'blocker',
      'PAGE 配置里没有 key（存盘键）。没有它就无法保证合并后这一章的作答记录不跟别的章串。',
      '这份页面的引擎被改过。请让用户重新生成这一章，或手工指定一个存盘键。'));
    return out;
  }
  out.pageKey = km[1];

  /* finalAdvice 只从 key 之后的文本里找：注入的收尾语在它后面，见上面那段说明。
     ⚠️ 必须同时认单引号与双引号两种字面量：
       · 有收尾语时 assemble 写的是 JSON 字符串 → finalAdvice:"…"（双引号）；
       · **没有收尾语时它压根不替换这一行**，骨架原文的 finalAdvice:'' 会原样留着（单引号）。
         只认双引号的话，"没写收尾语"这个再普通不过的情况会被判成"引擎配置解析不出来"，
         整份页面直接不能用——实测踩到过。 */
  const fam = /\bfinalAdvice\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(page.slice(km.index));
  if (!fam) {
    problems.push(problem('finaladvice-unreadable', 'blocker',
      'PAGE.finalAdvice 解析不出来（既不是 finalAdvice:"…" 也不是 finalAdvice:\'\'）。',
      '这份页面的引擎被改过。请让用户手工补一句收尾语（留空也行），或重新生成这一章。'));
  } else if (fam[1].charAt(0) === '"') {
    try { out.finalAdvice = JSON.parse(fam[1]); }
    catch (e) {
      problems.push(problem('finaladvice-unreadable', 'blocker',
        'PAGE.finalAdvice 是一个坏掉的 JSON 字符串：' + e.message,
        '请让用户重新生成这一章。'));
    }
  } else {
    // 骨架里那个没被填过的空串（也兼容手工写进去的单引号字符串）
    out.finalAdvice = fam[1].slice(1, -1).replace(/\\(['\\])/g, '$1');
  }

  const pm = /\bpetImages\s*:\s*\[([^\]]*)\]/.exec(page);
  const bm = /\bbgImages\s*:\s*\[([^\]]*)\]/.exec(page);
  if (!pm || !bm) {
    problems.push(problem('pet-config-missing', 'blocker',
      'PAGE 配置里找不到 petImages / bgImages（陪练形象的候选图片名），无法判断原来选的陪练方式。',
      '这份页面的引擎被改过。请让用户手工指明陪练方式（不要陪练 / 内置大肥鱼 / 同目录图片）。'));
    return out;
  }
  out.petImagesFound = true;
  const petEmpty = !pm[1].trim();
  const bgEmpty = !bm[1].trim();
  const seed = RE.fishSeed.test(h.slice(0, open.index));

  if (seed && petEmpty) {
    problems.push(problem('pet-ambiguous', 'warn',
      '这一页同时有"预置大肥鱼"脚本、又把 petImages 清空了，两个证据互相矛盾（正常生成不会这样）。' +
      '已按"内置大肥鱼"处理。',
      '照原样合并即可；若原来选的是"不要陪练"，合并后右下角会多出一个陪练，届时在页面上关掉就行。'));
    out.pet = 'fish';
  } else if (seed) out.pet = 'fish';
  else if (petEmpty) out.pet = 'none';
  else out.pet = 'image';

  if (out.pet !== 'none' && bgEmpty) {
    problems.push(problem('bg-images-empty', 'warn',
      'petImages 有内容但 bgImages 是空的：页面背景图会退回用头像那张铺开。',
      '这是引擎的正常兜底（留空 bgImages 就等于"拿头像铺背景"），不用处理。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 5 块：演示（演示槽里的 JS + 正文里的 DOM）
 * ------------------------------------------------------------------ */

function parseDemoSlot(h, problems) {
  const out = { found: false, entries: [] };
  const s = RE.demoSlot.exec(h);
  const e = RE.demoSlotEnd.exec(h);
  if (!s || !e || e.index < s.index) {
    problems.push(problem('demo-slot-missing', 'warn',
      '找不到演示槽（「章专用演示」注释与「收尾」注释之间那一段）。这一页上的演示 JS 无法反推。',
      '合并后这一章的演示会全部消失，讲解与题目不受影响。若这一章本来就没有演示，可以忽略。'));
    return out;
  }
  out.found = true;
  const close = h.indexOf('*/', s.index + s[0].length);
  const from = close < 0 ? s.index + s[0].length : close + 2;
  const region = h.slice(from, e.index);

  const marks = [];
  const re = demoEntryRe();
  let m;
  while ((m = re.exec(region))) marks.push({ at: m.index, end: re.lastIndex, title: m[1], kind: m[2] });

  if (!marks.length) {
    if (region.trim()) {
      problems.push(problem('demo-slot-unrecognized', 'warn',
        '演示槽里有内容，但不是本工具生成的形状（既没有「由工作台校验」也没有「由工作台补上兜底 try/catch」的标记）。' +
        '这一段 JS 合并后会**丢掉**。',
        '若这一章的演示是后来手工加的，请让用户把它单独保存一份。'));
    }
    return out;
  }
  if (region.slice(0, marks[0].at).trim()) {
    problems.push(problem('demo-slot-prefix', 'warn',
      '演示槽开头有一段不属于任何演示的内容，反推时会被丢掉。',
      '若这段内容重要，请让用户单独保存一份。'));
  }

  marks.forEach((mk, i) => {
    const body = region.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : region.length);
    const en = { title: mk.title, kind: mk.kind, id: '', js: '' };
    if (mk.kind === '校验') {
      // 模型自己把 js 包成了 try{…}catch：assemble 原样放进来，没有加 id 标记
      en.js = body.trim();
    } else {
      /* ⚠️ 开头的 `\s*` 不能省：body 是从注释行**后面**切起的，第一个字符就是那个换行。
         少了它这条就永远匹配不上，症状是"每个演示都报 JS 外壳看不懂、id 全部丢失"。
         行尾的 `catch` 也要按 assemble.js 里那行字面量**逐字**写（` console.error(...)` 前有一个空格）。 */
      const w = /^\s*try\{\r?\n([\s\S]*?)\r?\n\}catch\(e\)\{\s*console\.error\('\[演示 ([\s\S]*?)\] 出错：', e\); \}/.exec(body);
      if (w) { en.js = w[1].trim(); en.id = w[2]; }
      else {
        en.js = body.trim();
        problems.push(problem('demo-js-unrecognized', 'warn',
          `演示「${mk.title}」的 JS 外壳看不懂（不是本工具补的那层 try/catch），已原样收下。` +
          '它的 id 也就无从得知，只能靠出现顺序跟正文里的演示 DOM 配对。',
          '合并后在页面上点一遍这个演示，确认它还动得起来。'));
      }
    }
    out.entries.push(en);
  });
  return out;
}

/**
 * 把演示槽里的 JS 与正文里的演示 DOM 配成对。
 *
 * 配对的**唯一硬证据**是 id：JS 用 getElementById 去取 DOM，两边的 id 必然相同。
 * 拿不到 id 时只能按出现顺序配——那是猜，所以：
 *   · 数量正好对得上 → 配下去，但写一条 warn 说清"这是按顺序配的"；
 *   · 数量对不上     → 只配能配的，多出来的**逐条报出来**，绝不闷掉。
 */
function pairDemos(entries, cands, problems) {
  const demos = [];
  const usedE = new Set();
  const usedC = new Set();
  /* 嵌在正文里的演示**合并成一条**报出来。
     一章往往有三四个演示，逐条报会刷屏，用户反而会跳过不看——
     而这条说明本身是"内容没丢、位置也是对的"，只是交代一下它换了个存法。 */
  const inLecture = [];

  const mk = (en, c, n) => {
    const d = {
      id: (en && en.id) || (c && c.id) || 'demo' + (n + 1),
      title: (en && en.title) || '',
      markup: '',
      js: (en && en.js) || '',
      unitId: '',
    };
    if (c && c.inLecture) {
      // DOM 留在 lectureHtml 里，但 unitId 照报：调用方要靠它知道这个演示属于哪一节
      d.unitId = c.unitId;
      inLecture.push(`${d.title || d.id}（在单元「${c.unitTitle || c.unitId}」的正文里）`);
    } else if (c) {
      d.markup = c.html;
      d.unitId = c.unitId;
    }
    return d;
  };

  // ① 先按 id 配
  entries.forEach((en, i) => {
    if (!en.id) return;
    const k = cands.findIndex((c, j) => !usedC.has(j) && c.id && c.id === en.id);
    if (k >= 0) { usedE.add(i); usedC.add(k); demos.push(mk(en, cands[k], demos.length)); }
  });

  // ② 剩下的按出现顺序配
  const restE = entries.map((_, i) => i).filter((i) => !usedE.has(i));
  const restC = cands.map((_, j) => j).filter((j) => !usedC.has(j));
  if (restE.length && restC.length) {
    const n = Math.min(restE.length, restC.length);
    for (let k = 0; k < n; k++) {
      usedE.add(restE[k]); usedC.add(restC[k]);
      demos.push(mk(entries[restE[k]], cands[restC[k]], demos.length));
    }
    if (restE.length === restC.length) {
      problems.push(problem('demo-paired-by-order', 'warn',
        `有 ${n} 个演示没法按 id 配对（JS 里没有工作台写的 id 标记），已按**出现顺序**跟正文里的演示 DOM 配对。` +
        '顺序配对在"某一段演示的 DOM 被删过"时会把 JS 接到错的演示上。',
        '合并后逐个点一遍这几个演示，确认动的是它自己那一块。'));
    }
  }
  restE.filter((i) => !usedE.has(i)).forEach((i) => {
    const en = entries[i];
    demos.push(mk(en, null, demos.length));
    problems.push(problem('demo-js-without-markup', 'warn',
      `演示「${en.title || en.id || '(无标题)'}」在演示槽里有 JS，但正文里找不到对应的演示 DOM。` +
      '它合并后**不会显示**（JS 跑起来取不到元素）。',
      '要么把它原来那块 DOM 找回来，要么让用户确认这个演示已经废弃、直接从结构里删掉。'));
  });
  restC.filter((j) => !usedC.has(j)).forEach((j) => {
    const c = cands[j];
    demos.push(mk(null, c, demos.length));
    problems.push(problem('demo-markup-without-js', 'warn',
      `单元「${c.unitTitle || c.unitId}」的正文里有一块演示 DOM（${c.id ? 'id="' + c.id + '"' : '没有 id'}），` +
      '但演示槽里没有对应的 JS。这多半是"纯静态演示"（只摆图不动），也可能是它的 JS 在生成时就丢了。',
      '合并后它会照原样留在正文里；如果是该动不动的演示，请让用户回头查一下那一章的生成日志。'));
  });

  if (inLecture.length) {
    problems.push(problem('demo-markup-in-lecture', 'warn',
      `有 ${inLecture.length} 个演示的 DOM 嵌在讲解正文里：${inLecture.join('；')}。` +
      '（生成时是 <!--DEMO:id--> 占位注释被就地替换的。）反推时它们**留在 lectureHtml 里不动、markup 记为空串**，' +
      '合并后会出现在原来的位置，内容一点不会丢。',
      '不用处理。但这也意味着"演示原本挂在正文的哪一行"无法再从结构里看出来，改动正文时留意别把演示块当成普通段落删掉。'));
  }
  return demos;
}

/* ------------------------------------------------------------------ *
 * 校验：每一条都返回"哪一条对不上 + 建议怎么办"
 * ------------------------------------------------------------------ */

function validate(p) {
  const P = [];

  // 0) 这页到底是不是拼装器生成的
  if (!RE.cspMeta.test(p.html)) {
    P.push(problem('no-csp-meta', 'warn',
      '这份 HTML 里没有交付页应有的 CSP meta 标签（assemble.js 每次都会注入）。' +
      '它可能不是本工具生成的页面，或者被人手工改过。',
      '先确认文件来源；如果确实是本工具生成的，说明这一页比当前拼装器旧，反推结果请人工核对一遍。'));
  }

  // 1) 单元数 vs 题库段数 —— 结构上最要命的一条
  const nu = p.units.length;
  const nb = p.banks.length;
  if (nu !== nb) {
    P.push(problem('unit-bank-count-mismatch', 'blocker',
      `单元数 ${nu} 与题库段数 ${nb} 不一致：正文里有 ${nu} 个题区，页面上有 ${nb} 段题库。` +
      '一段题库对应一个单元，对不上就无法确定"哪段题属于哪个单元"——硬猜的结果是一册题连着别人的讲解。',
      nb < nu
        ? `多半是第 ${nb + 1} 段题库（<script data-bank id="bank${nb}">）被删掉了或 JSON 坏掉被浏览器吞了。请让用户重新生成这一章，或把缺的那段补回来。`
        : `多出来的是第 ${nu + 1} 段之后的题库段。请让用户确认是不是多复制了一段；确认后删掉多余的，再合并。`));
  }

  // 2) 题库段 id 必须是 bank0…bankN-1
  p.banks.forEach((b, i) => {
    if (!b.indexOk) {
      P.push(problem('bank-id-sequence', 'blocker',
        `第 ${i + 1} 段题库的 id 是 "${b.id}"，按顺序应该是 "bank${i}"。` +
        '引擎只按出现顺序读这些段（不看 id），但 id 对不上说明这一页被手工改过，其余地方也要打问号。',
        '请让用户确认这一页的来源；若确认只是 id 被改了，可以按出现顺序改造后用。'));
    }
  });

  // 3) 题区序号：必须从 0 起、连续、不重号
  const seq = p.units.map((u) => u.lv);
  const dup = seq.filter((n, i) => seq.indexOf(n) !== i);
  const missing = [];
  for (let i = 0; i < seq.length; i++) if (!seq.includes(i)) missing.push(i);
  const seqBad = seq.length !== new Set(seq).size || missing.length || seq.some((n, i) => n !== i);
  if (seqBad) {
    // 报错里带上 id 原文：用户拿到这句话要能在十几万字的文件里搜索到它
    const seqTxt = p.units.map((u) => u.qsecId).join('、');
    P.push(problem('qsec-sequence', 'blocker',
      `题区序号不对：正文里的题区依次是 ${seqTxt}（序号 [${seq.join(', ')}]），不是从 0 起的连续序列。` +
      (dup.length ? ` 重号：${[...new Set(dup)].join('、')}。` : '') +
      (missing.length ? ` 缺号：${missing.join('、')}。` : '') +
      ' 引擎会把题按 lv 塞进 .qlist[data-lv=N]，序号一乱，题目就会渲染进别的单元的题区里（而页面不报错）。',
      '这一页必须修好再用。请让用户重新生成这一章——手工改回连续序号会连带影响题库里的 lv 与存盘键。'));
  }

  p.units.forEach((u, k) => {
    // 4) 题区 id 的 N 与 data-lv、data-cnt 三处必须一致
    if (u.dataLv != null && u.dataLv !== u.lv) {
      P.push(problem('qsec-lv-mismatch', 'blocker',
        `单元 ${k + 1} 的题区 id 是 "p-l${u.lv}"，但里面 .qlist 的 data-lv 是 ${u.dataLv}。` +
        '引擎按 data-lv 决定题目渲染到哪里，两者不一致时这一节的题会跑到别的单元下面。',
        '请让用户重新生成这一章。'));
    }
    if (u.cntIndex != null && u.cntIndex !== k) {
      P.push(problem('cnt-index-mismatch', 'warn',
        `单元 ${k + 1} 的题区标题上写着 data-cnt="${u.cntIndex}"，应该是 "${k}"。` +
        '吸顶条上"3/5 已答"那个计数会挂到错的题区上。',
        '合并后计数会重新生成，不用处理；但可以据此判断这一页被人手工改过。'));
    }
    // 5) 讲解导语 vs 题区导语
    if (u.lede && u.qsecLede && u.lede !== u.qsecLede) {
      u.quizLede = u.qsecLede;
    } else if (u.lede && u.qsecLede === '') {
      P.push(problem('lede-missing-in-qsec', 'warn',
        `单元 ${k + 1} 的讲解有导语，题区却没有。成品页里这两处应当一致（题区导语缺省就取讲解那段），` +
        '不一致说明这一页被人改过。已按讲解那处为准。',
        '不用处理。但这一页既然被改过，其余内容请抽查一下。'));
    } else if (!u.lede && u.qsecLede) {
      // assemble 的取值顺序是 quizLede || lede，讲解那处没有导语却只有题区有 —— 只可能是 quizLede
      u.quizLede = u.qsecLede;
    }
  });

  // 6) 每段的 lv 必须与它所属单元的序号一致
  p.units.forEach((u, k) => {
    const b = p.banks[k];
    if (!b || !Array.isArray(b.items)) return;
    const bad = b.items.filter((it) => it && typeof it === 'object' && it.lv != null && it.lv !== k);
    if (bad.length) {
      P.push(problem('bank-lv-mismatch', 'blocker',
        `第 ${k + 1} 段题库（id="${b.id}"）里有 ${bad.length} 道题的 lv 不是 ${k}` +
        `（例如「${bad[0].id}」的 lv 是 ${bad[0].lv}）。lv 是"这道题属于哪个题区"的唯一依据，` +
        '对不上就说明这段题库实际属于别的单元——按段号硬配会把 A 单元的题挂到 B 单元下面。',
        '请让用户重新生成这一章。'));
    }
  });

  // 7) 合计作答点：页头/页脚自称的数字 vs 实际算出来的
  let total = 0;
  const perUnit = [];
  p.units.forEach((u, k) => {
    const b = p.banks[k];
    const items = b && Array.isArray(b.items) ? b.items : [];
    const c = countPoints(items);
    perUnit.push(c.total);
    total += c.total;
    u.bank = items;
    u.points = c.total;
    if (items.length === 0) {
      P.push(problem('unit-bank-empty', 'blocker',
        `单元 ${k + 1}（${u.title || u.id}）的题库是空的：合并后这一节只有讲解、一道题都没有。`,
        '请让用户重新生成这一章，或确认这一段题库本来就没题（那也应该把它并进相邻单元）。'));
    }
  });

  const claimed = p.header.claimed || {};
  if (claimed.points != null && claimed.points !== total) {
    P.push(problem('point-total-mismatch', 'warn',
      `页头写着「${claimed.points} 个作答点」，但从题库里算出来的是 ${total} 个` +
      `（每段分别是：${perUnit.join(' / ')}）。` +
      (claimed.points > total
        ? `差 ${claimed.points - total} 个：这几道题在成品页里**已经不存在**了（多半是某段题库的 JSON 坏了被引擎吞掉、或生成时就没写进去），反推拿不回来。`
        : `实际比页头多 ${total - claimed.points} 个：页头是生成时写的，题库后来被加过题。`),
      '合并后的新页面会按题库重新算这个数字，所以不用处理；但请把这句话告诉用户——' +
      '有题目在历史页面上就已经丢了，只能重新生成那一章才能补回来。'));
  }
  if (claimed.units != null && claimed.units !== p.units.length) {
    P.push(problem('unit-total-mismatch', 'warn',
      `页头写着「${claimed.units} 个单元」，正文里实际有 ${p.units.length} 个。`,
      '合并后按实际单元数走；但两个数字对不上说明这一页被改过，请抽查一遍。'));
  }

  // 8) ref.h 的锚点必须都能在页面里找到
  const dead = [];
  p.units.forEach((u, k) => {
    const walk = (items, label) => {
      items.forEach((q, qi) => {
        if (!q || typeof q !== 'object') return;
        const targets = q.type === 'big' ? (q.parts || []) : [q];
        targets.forEach((t) => {
          if (!t || !t.ref || !t.ref.h) return;
          const raw = String(t.ref.h);
          if (!raw.startsWith('#') || !p.ids.has(raw.slice(1))) {
            dead.push(`${label} 第 ${qi + 1} 题（${q.id}）→ ${raw}`);
          }
        });
      });
    };
    walk(u.bank || [], `单元 ${k + 1}`);
  });
  if (dead.length) {
    P.push(problem('dead-ref', 'warn',
      `有 ${dead.length} 处「回看」链接指向页面上不存在的位置：${dead.slice(0, 5).join('；')}` +
      (dead.length > 5 ? ` …另有 ${dead.length - 5} 处` : '') + '。' +
      '合并后这些链接点下去没有任何反应。',
      '合并时把这些 ref 去掉即可（拼装器本来也会自动摘掉死链，见 assemble.js 第 3 步）。'));
  }

  // 9) 目录卡的锚点
  const badLinks = (p.howtoLinks || []).filter((l) => !p.ids.has(l.href));
  if (badLinks.length) {
    P.push(problem('howto-link-dead', 'warn',
      `目录卡里有 ${badLinks.length} 个跳转链接指向不存在的小节：` +
      badLinks.slice(0, 5).map((l) => `「${l.text}」→ #${l.href}`).join('；') + '。',
      '目录合并后会重新生成，不用处理。'));
  }

  // 10) 演示数
  if (claimed.demos != null && claimed.demos !== p.demos.length) {
    P.push(problem('demo-total-mismatch', 'warn',
      `页头写着「${claimed.demos} 个可拖演示」，反推出来 ${p.demos.length} 个。`,
      '合并后按反推出来的算；对不上的部分请对照上面关于演示的几条具体说明。'));
  }

  return P;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

function buildData(p) {
  const unitPoints = p.units.map((u) => u.points || 0);
  return {
    // 与 assemble() 的 chapter 对齐：no 就是它要的 number，subject/title/intro 同名
    chapter: {
      no: p.header.no || '',
      title: p.header.title || '',
      subject: p.header.subject || '',
      intro: p.header.intro || '',
    },
    pageKey: p.engine.pageKey,
    finalAdvice: p.engine.finalAdvice,
    pet: p.engine.pet,
    units: p.units.map((u) => {
      const o = {
        id: u.id,
        num: u.num,
        title: u.title,
        qsecTitle: u.qsecTitle,
        lede: u.lede,
        lectureHtml: u.lectureHtml,
        bank: u.bank || [],
        points: u.points || 0,
      };
      // quizLede 只在"与讲解导语不同"时才带上：拼装时它优先于 lede，不带就等于丢了一段话
      if (u.quizLede && u.quizLede !== u.lede) o.quizLede = u.quizLede;
      return o;
    }),
    demos: p.demos,
    不确定的地方: p.problems.map((x) => (x.level === 'blocker' ? '【不能用】' : '【注意】') + x.message + (x.hint ? ' 建议：' + x.hint : '')),
    注: [
      '题库是**规范化之后**的：id 已带单元命名空间（如 ' + (p.units[0] && p.units[0].id ? p.units[0].id + '-q1' : 'u1-q1') + '）、' +
        '每道题多了一个 lv、选项已整理成 {t,ok,why}。再拼装时会再规范化一次，id 会变成两层前缀。',
      '每个单元的作答点数：' + unitPoints.join(' / ') + '，合计 ' + unitPoints.reduce((a, b) => a + b, 0) + '。',
    ],
  };
}

/**
 * 解析 + 校验。
 *
 * @returns {{ ok:boolean, data:object|null, problems:Array }}
 *   ok       —— 能不能用。false 就是"不能用"，**这时 data 一定是 null**：
 *               宁可让调用方拿到"什么都没有"，也不能让它拿到一份看起来是好的错结构。
 *   data     —— 与落盘格式对齐的结构（见 buildData），可直接喂给拼装器。
 *   problems —— 每一条都是 { code, level:'blocker'|'warn', message, hint }，
 *               message 里带具体的单元名/id，hint 是"建议怎么办"。
 */
function revive(html) {
  if (typeof html !== 'string' || !html) {
    return {
      ok: false,
      data: null,
      problems: [problem('empty-input', 'blocker', '没有拿到任何 HTML 内容。', '请确认文件读进来了（是不是空的、或读错了文件）。')],
    };
  }

  const problems = [];
  const p = { html, ids: new Set(), problems };

  // 页面里所有 id：ref.h 的锚点校验要用（与 assemble.js 第 3 步同源）
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) p.ids.add(m[1]);

  p.header = parseHeader(html, problems);
  p.body = parseBody(html, problems);
  p.units = p.body.units;
  p.banks = parseBanks(html, problems);
  p.engine = parseEngine(html, problems);
  p.howtoLinks = p.body.howtoLinks;

  // 演示：JS 在演示槽里，DOM 在正文里，两边配起来
  const slot = parseDemoSlot(html, problems);
  const cands = [];
  p.units.forEach((u) => {
    (findDemoDivs(u.lectureHtml) || []).forEach((d) => {
      cands.push({ html: u.lectureHtml.slice(d.start, d.end), id: d.id, inLecture: true, unitId: u.id, unitTitle: u.title });
    });
    (findDemoDivs(u.gap || '') || []).forEach((d) => {
      /* 题区前那一段：这是 assemble 给"占位注释没写进正文"的演示留的位置，要抠出来交给 demos[]。
         ⚠️ 这里的 markup **不能去缩进**：它是 assemble 在拼装最后一步**原样插进去**的
         （不像讲解正文那样过了 indent(html,4)）。去缩进会把演示 DOM 自己的两格缩进吃掉，
         反推出来的 markup 与原文对不上（症状：`<pre>` 里的显示会变）。 */
      cands.push({ html: normalizeEol(trimBlankLines(u.gap.slice(d.start, d.end))), id: d.id, inLecture: false, unitId: u.id, unitTitle: u.title });
    });
  });
  p.demos = pairDemos(slot.entries, cands, problems);
  p.problems = problems.concat(validate(p));

  const blocked = p.problems.some((x) => x.level === 'blocker');
  return { ok: !blocked, data: blocked ? null : buildData(p), problems: p.problems };
}

module.exports = { revive, parseHeader, parseBody, parseBanks, parseEngine, parseDemoSlot, validate, findDemoDivs, unescapeHtml, dedentLines, normalizeEol };

/*__ISG_BUNDLE_END__*/};
  factories["book"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 「累积成一册」的地基之一：**结构化数据的旁挂落盘**。
 *
 * 为什么要有这一层：章节成品 HTML 是**拼装器**（pipeline/assemble.js）把
 * 大纲 / 每个单元的讲解与题库 / 演示拼出来的。想把"以前生成的那一章"和新的合成一册，
 * 就必须**重新装配**一次 —— 在 HTML 文本层面拼两份成品是做不出来的（两份骨架、
 * 两套 `PAGE.key`、两套引擎的题区索引都会打架）。
 * 重新装配需要那一章生成时的结构化数据，而那些数据以前只活在 `runPipeline` 的局部 const 里，
 * 任务一结束就随进程一起没了，磁盘上只剩一份成品 HTML。
 *
 * ---- 为什么落在**产物旁边**，而不是 userData 里 ----
 * 这个功能的判断依据是"**这一份页面**"，不是"这台机器上的历史记录"：
 *   · 历史里的 `htmlPath` 是绝对路径，换目录/换机器就失效；
 *   · 旁挂文件**跟着文件走** —— 用户把 HTML 拷给同学、拖到另一个文件夹，数据还在；
 *   · 更要紧的是，它让"**选一个 HTML 文件**"这个入口能直接读到数据（否则只能从页面反推）。
 * 路径规则：与 HTML **同目录、同 basename**，再加 `.isg.json`：
 *   `ch13-磁介质-练一练.html` → `ch13-磁介质-练一练.html.isg.json`
 * 所以不需要"按 jobId 保留 N 份"的回收逻辑 —— 用户删页面时，旁挂文件自然跟着没了。
 *
 * ---- 同一个文件形状，单章与整册共用 ----
 * `kind` 区分 `chapter`（一章单独成页）与 `book`（几章合成的一册），`chapters[]` 都是列表
 * （单章就是只有一项的列表）。详见 `writeBook()` 的注释。
 *
 * ---- 调用方应该在什么时候调 ----
 *   · `writeBook(htmlPath, data)`：**在 pipeline 里 HTML 落盘成功之后、`jobs.finish(job)` 之前**调一次。
 *     失败策略：**只记 warn，页面照常交付** —— 页面已经写出来了，不能因为"旁挂数据没写下去"
 *     就让用户拿不到东西。但结果里要**明说**"这一章的数据没存下来，以后不能并进一册"
 *     （`writeBook` 返回 `{ok:false, reason, detail}`，reason 就是拿来写这句提示的）。
 *     拼装失败 / 用户取消的任务**不要**调：半份数据拿去合并只会拼出残页。
 *   · `readBook(htmlPath)` / `hasBook(htmlPath)`：给"选一个 HTML 进来合并"这条入口用，
 *     以及历史列表判断"这一份还能不能用来合并"。**读永远不会抛给调用方**：
 *     文件不在、JSON 坏、schema 版本不认识，都会得到一个说得清楚的"不可用"。
 *
 * ---- 两条纪律 ----
 *   1. **写入是原子的**：先写 `<...>.isg.json.tmp` 再 rename。中途断电/被杀进程不会留下
 *      半截 JSON —— 半截 JSON 会被读路径判成"坏文件"，等于用户白白丢了一章的结构数据。
 *   2. **`bank` 原样保存**（已规范化的 items，含最终的 `q.id`）。这是"进度零迁移"的前提：
 *      再拼装时 id 必须一模一样，否则 localStorage 里的作答记录全对不上。
 *      所以这一层**绝不去碰 bank 里的题**，只搬。
 */

const fs = require('fs');
const path = require('path');

/** 当前 schema。改结构时**只加不减**，并把老版本的读法登记进 READERS。 */
const SCHEMA = 'isg-book/1';

const SUFFIX = '.isg.json';
const KINDS = new Set(['chapter', 'book']);

/* schema → 读取器。表里没有的一律判"不可用"，
   绝不"尽力而为"地当成本版读 —— 那会让拼装器拿到缺字段的对象，
   表现是页面缺单元、题库静默少一半，而不是一条清楚的报错。 */
const READERS = {
  'isg-book/1': (raw) => raw,
};

/* ---------------- 路径 ---------------- */

/** 旁挂文件的路径。htmlPath 空或不是字符串 → null（调用方按"没有"处理）。 */
function sidecarPathFor(htmlPath) {
  const p = typeof htmlPath === 'string' ? htmlPath.trim() : '';
  if (!p) return null;
  return p + SUFFIX;
}

/** 这个路径是不是一个旁挂文件（用于"用户拖进来一个 .isg.json"之类的地方）。 */
function isSidecar(p) {
  return typeof p === 'string' && p.toLowerCase().endsWith(SUFFIX);
}

/* ---------------- 形状归一 ---------------- */

function str(v) {
  return v == null ? '' : String(v);
}

/**
 * 一章。**只有 `chapter` 和 `units` 是必需的**（units 由调用方保证非空，
 * 这里不拦：拦了只会让用户在"某章一个单元都没有"时丢掉整份数据）。
 */
function normalizeChapterEntry(c) {
  const x = c && typeof c === 'object' ? c : {};
  const ch = x.chapter && typeof x.chapter === 'object' ? x.chapter : {};
  const units = Array.isArray(x.units) ? x.units : [];
  const demos = Array.isArray(x.demos) ? x.demos : [];
  return {
    chapter: {
      /* `no` 与 `number` 两种写法都认：拼装器落盘的是 `number`，而旁挂数据自己的
         读取端与 revive 用 `no`。只认一个的话，真实生成链写出来的旁挂数据会**静默丢掉章号**
         （页面看起来完全正常，只是「带上一章」时显示"第 N 章"退化成序号）。 */
      no: str(ch.no !== undefined && ch.no !== null && String(ch.no).trim() !== '' ? ch.no : ch.number),
      title: str(ch.title),
      subject: str(ch.subject),
      intro: str(ch.intro),
    },
    // 这一章单独成页时用的存盘键：搬家（把一章并进一册）时要用它来认"这是同一章"
    key: str(x.key),
    sourceFile: str(x.sourceFile),
    createdAt: Number(x.createdAt) || Date.now(),
    jobId: str(x.jobId),
    units: units.map(normalizeUnit),
    demos: demos.map(normalizeDemo),
    // "这一章已经发出去过了，id 不许重算" —— 重算 id 会让用户已有的作答记录全部失联
    frozen: !!x.frozen,
  };
}

function normalizeUnit(u, i) {
  const x = u && typeof u === 'object' ? u : {};
  const out = Object.assign({}, x);
  out.id = str(x.id || 'u' + (i + 1));
  out.num = str(x.num);
  out.title = str(x.title);
  out.shortTitle = str(x.shortTitle);
  out.qsecTitle = str(x.qsecTitle);
  out.lede = str(x.lede);
  out.lectureHtml = str(x.lectureHtml);
  // ⚠️ 题库原样搬（见文件顶部第 2 条纪律）：这里**不规范化、不改 id**
  out.bank = Array.isArray(x.bank) ? x.bank : [];
  return out;
}

function normalizeDemo(d, i) {
  const x = d && typeof d === 'object' ? d : {};
  const out = Object.assign({}, x);
  out.id = str(x.id || 'd' + (i + 1));
  out.title = str(x.title);
  out.markup = str(x.markup);
  out.js = str(x.js);
  out.unitId = str(x.unitId);
  out.unitTitle = str(x.unitTitle);
  return out;
}

/**
 * 把调用方给的任意对象归一成要落盘的册/章，并顺手报出"哪儿不对劲"。
 *
 * 硬性要求只有两条：`kind` 认识、`chapters` 非空。其余一律容错填默认值 ——
 * 为了一个可选字段把整份结构数据拒掉，代价是用户以后再也合不了这一章。
 *
 * @returns {{ok:true, book:object, warnings:string[]}|{ok:false, reason:string, detail:string}}
 */
function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  const kind = str(d.kind || 'chapter');
  if (!KINDS.has(kind)) {
    return { ok: false, reason: 'bad-kind', detail: `kind 只认 ${[...KINDS].join(' / ')}，收到「${kind}」` };
  }
  const chapters = (Array.isArray(d.chapters) ? d.chapters : []).map(normalizeChapterEntry);
  if (!chapters.length) return { ok: false, reason: 'no-chapters', detail: 'chapters 是空的，这份数据拿不去合并' };

  const warnings = [];
  for (const c of chapters) {
    if (!c.key) warnings.push(`第 ${chapters.indexOf(c) + 1} 章的 key 是空的，将来搬家时认不出它`);
    if (!c.units.length) warnings.push(`「${c.chapter.title || '未命名'}」没有任何单元`);
    for (const u of c.units) {
      if (!u.id) warnings.push('有单元缺 id');
      if (u.bank.length && u.bank.some((q) => !q || !q.id)) {
        // 没有 id 的题在重新拼装时会拿到**新**的 id → 用户已有的作答记录会对不上号
        warnings.push(`「${c.chapter.title || '未命名'}」有题目没有 id（重新拼装时 id 会变，作答记录会对不上）`);
      }
    }
  }

  return {
    ok: true,
    warnings,
    book: {
      schema: SCHEMA,
      kind,
      appVersion: str(d.appVersion),
      title: str(d.title),
      subject: str(d.subject),
      /* 册的 key：**必须与章列表无关**（别用"各章键拼起来"那种做法），
         否则每加一章就换一次键，用户每次都得搬一遍作答记录。
         首次合并时生成一次，之后一直复用。 */
      key: str(d.key),
      chapters,
    },
  };
}

/* ---------------- 写 ---------------- */

/**
 * 把结构化数据写到 HTML 旁边的 `<htmlPath>.isg.json`。
 *
 * **不抛异常**：出问题返回 `{ok:false, reason, detail}`，由调用方记 warn 并如实告诉用户
 * "这一章以后不能并进一册"。reason 取值：`bad-path` / `bad-kind` / `no-chapters` / `io`。
 *
 * @param {string} htmlPath 成品页面的路径（必须是文件路径，不是目录）
 * @param {object} data     形状见文件顶部；`kind` 缺省按 `chapter`
 * @returns {{ok:boolean, path?:string, warnings?:string[], reason?:string, detail?:string, error?:string}}
 */
function writeBook(htmlPath, data) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return { ok: false, reason: 'bad-path', detail: 'htmlPath 是空的，不知道该把数据写到哪儿去' };

  const n = normalize(data);
  if (!n.ok) return n;

  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(n.book, null, 2), 'utf8');
    // rename 覆盖同目录下的同名文件：Windows 上 Node 走 MOVEFILE_REPLACE_EXISTING，是原子的
    fs.renameSync(tmp, file);
    return { ok: true, path: file, warnings: n.warnings };
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp); // 不留半截临时文件
    } catch (e2) {}
    return { ok: false, reason: 'io', error: (e && e.message) || String(e) };
  }
}

/** 删掉旁挂文件（暂不导出给界面用，但合并/搬家那条线会需要它）。不抛。 */
function removeBook(htmlPath) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 读（全部容错） ---------------- */

/**
 * 读 HTML 旁边的结构化数据，并把"为什么读不出来"说清楚。
 *
 * @param {string} htmlPath
 * @returns {{ok:true, book:object, path:string}}
 *        | {{ok:false, reason:'bad-path'|'missing'|'corrupt'|'unsupported-schema'|'io',
 *            detail:string, path?:string, schema?:string}}
 *   `unsupported-schema` 表示"这份数据是别的版本写的"（降级展示时可以用 schema 说明），
 *   它与 `corrupt`（文件坏了/不是我们的文件）是两回事，界面上的说法也该不一样。
 */
function readBook(htmlPath) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return { ok: false, reason: 'bad-path', detail: 'htmlPath 是空的' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const reason = e && e.code === 'ENOENT' ? 'missing' : 'io';
    return { ok: false, reason, path: file, detail: (e && e.message) || String(e) };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'corrupt', path: file, detail: 'JSON 解析失败：' + ((e && e.message) || String(e)) };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'corrupt', path: file, detail: '文件内容不是一个对象' };
  }
  const schema = str(obj.schema);
  if (!schema) {
    return { ok: false, reason: 'corrupt', path: file, detail: '没有 schema 字段（可能不是本程序写的文件）' };
  }
  const reader = READERS[schema];
  if (!reader) {
    return {
      ok: false,
      reason: 'unsupported-schema',
      path: file,
      schema,
      detail: `这份数据的版本「${schema}」不认识（本程序支持到 ${SCHEMA}）`,
    };
  }
  const migrated = reader(obj);
  if (!migrated || typeof migrated !== 'object' || !Array.isArray(migrated.chapters) || !migrated.chapters.length) {
    return { ok: false, reason: 'corrupt', path: file, schema, detail: '读取器拿不到 chapters 数组' };
  }
  return { ok: true, book: migrated, path: file };
}

/** 读一份结构化数据；**不可用一律返回 null**（想看原因用 `readBook()`）。 */
function getBook(htmlPath) {
  const r = readBook(htmlPath);
  return r.ok ? r.book : null;
}

/**
 * 这一份页面**有没有能用的**旁挂数据。
 *
 * 默认只 stat（**便宜**）：历史列表有几十条，每条都整份解析一遍（一份几百 KB）
 * 会把"列个表"变成几十 MB 的读盘。代价是"文件在但内容坏了"这里会报 true。
 *
 * `{deep:true}` 才是**准**的（真解析一遍）。它带一层按 (路径, mtime, 大小) 记忆的缓存：
 * 同一份文件只要没被改写就只解析一次 —— 所以"每次刷列表都深层判断"也是可以接受的，
 * 界面要如实说"这份还能不能准确合并"，宁可准一点。
 * 缓存命中不了的两头（文件被删 / 被改写）都会落到真解析上，不会给出过期的答案。
 */
const deepCache = new Map();
const DEEP_CACHE_MAX = 200;

function hasBook(htmlPath, opts) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return false;
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile() || st.size <= 1) return false;
  } catch (e) {
    return false;
  }
  if (!(opts && opts.deep)) return true;
  const hit = deepCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.ok;
  const ok = readBook(htmlPath).ok;
  deepCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, ok });
  if (deepCache.size > DEEP_CACHE_MAX) {
    // 简单粗暴地丢最早插入的那条：缓存只是加速，丢了下次再解析一遍而已
    deepCache.delete(deepCache.keys().next().value);
  }
  return ok;
}

module.exports = {
  SCHEMA,
  SUFFIX,
  sidecarPathFor,
  isSidecar,
  normalize,
  writeBook,
  readBook,
  getBook,
  hasBook,
  removeBook,
};

/*__ISG_BUNDLE_END__*/};
  factories["pipeline"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';
/* 生成流水线：抽取 → 规划 → 内容 → 演示 → 拼装 → 校验 → 修复。
 *
 * 贯穿全流程的三条纪律：
 *   1. **模型只产片段**，页面由 assemble.js 拼（见该文件顶部的说明）。
 *   2. **每一段模型输出都要先过校验**，不合格就带着具体问题回灌重出，
 *      绝不把"大概率有问题"的东西拼进页面。
 *   3. **不吞异常**：每个阶段失败都带上"哪个单元、第几次尝试、模型原文片段"，冒到 UI 上。
 */

const fs = require('fs');
const path = require('path');

const store = require('../store');
const jobs = require('../jobs');
const preview = require('../preview');
const { log, progress, isCanceled, CanceledError, fail, finish } = jobs;
const { normalizeBank, KNOWN_TYPES, PART_TYPES } = require('./bank');

/* 这些模块由别的子代理实现，用懒加载避免"它还没写好时整个应用起不来" */
function lazy(mod, name) {
  return () => {
    const m = require(mod);
    if (!m || typeof m[name] !== 'function') {
      throw new Error(`内部错误：模块 ${mod} 没有导出 ${name}()，应用装错了或文件被改坏了`);
    }
    return m[name];
  };
}
const getExtract = lazy('../extract', 'extract');
const getAssemble = lazy('./assemble', 'assemble');
const getSkill = lazy('../skill', 'skeleton');

const CONCURRENCY_DEFAULT = 3;

/* ---------------- 小工具 ---------------- */

/** 字符串的短哈希（FNV-1a，8 位十六进制）。给存盘键做去重指纹用，不做任何安全用途。 */
function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function slugify(s, fallback) {
  const t = String(s || '')
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return t || fallback;
}

/**
 * 章号：**规划阶段**的 chapter 用 `no`（`outline.chapter.no`），而**拼装器形状**的 chapter
 * 用 `number`（`newChapter.chapter`，见 assemble 的契约）。两个名字都得认。
 *
 * ⚠️ 只认一个的话，文件名会**静默**少掉 `ch13-` 那一段前缀（`outName` 读到的是 undefined）——
 * 产出照常、页面照常，只是文件名叫「磁介质-讲练一体.html」而不是「ch13-磁介质-讲练一体.html」。
 * 用户按名字归档时会发现它排不到一起，而没有任何地方报错。
 */
function chapterNoOf(chapter) {
  const c = chapter || {};
  return c.no != null && c.no !== '' ? c.no : (c.number == null ? '' : c.number);
}

function outName(chapter, srcPath) {
  // ⚠️ 章号来自**模型**（或用户在界面上随手填的），必须净化。
  // 实测过 `no: "../../../../evil"` 会让产出被写到输出目录之外；配合结果页那句
  // "用系统程序打开"，等于把攻击者编写的本地 HTML 摆到用户面前。
  // 只留字母数字与 - _ .，并截断——章号本来就只有几个字符。
  const safeNo = String(chapterNoOf(chapter))
    .replace(/[^\w.\-]/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 16);
  const no = safeNo ? `ch${safeNo}-` : '';
  const base = slugify(chapter.title || path.basename(srcPath, path.extname(srcPath)), 'study-guide');
  return `${no}${base}-讲练一体.html`;
}

/**
 * 把这次任务的日志落到**输出目录**，给"跑砸了之后还能回头看"用。
 *
 * 为什么需要它：任务日志以前**只在内存里**（还封顶 2000 条），应用一关就永久消失 ——
 * 用户看到一大段报错、关掉窗口就再也找不着，想复盘只能凭记忆。
 *
 * 命名与清理那边约定好了：`<产物名>.run.log`（`src/main/cleanup.js` 按 `*.run.log` 后缀认它，
 * 所以**改名字要两边一起改**）。产物还没写出来时（失败在拼装之前）就按源文件名推一个基名。
 *
 * ⚠️ 写日志这件事**绝不能反过来把收尾弄崩**：失败路径上再抛一个异常，
 * 用户连"任务失败"都看不到了。所以整段吞异常，只往日志里补一句。
 */
function writeRunLog(job, why) {
  try {
    const outDir = job.options.outputDir || path.dirname(job.filePath || '');
    if (!outDir) return '';
    fs.mkdirSync(outDir, { recursive: true });
    const base = job.htmlPath
      ? path.basename(job.htmlPath)
      : slugify(path.basename(job.filePath || 'run', path.extname(job.filePath || '')), 'run') + '-讲练一体.html';
    const logPath = path.join(outDir, base + '.run.log');
    const lines = [];
    lines.push('讲练一体工作台 · 这一次没跑完');
    lines.push('时间：' + new Date().toISOString());
    lines.push('材料：' + (job.sources || []).map((s) => s.fileName || s.filePath).join('、'));
    lines.push('结果：' + why);
    lines.push('产物：' + (job.htmlPath || '（还没到拼装那一步，所以什么都没写出来）'));
    lines.push('');
    lines.push('—— 下面是这次任务的完整日志 ——');
    for (const it of (job.logs || [])) {
      const t = new Date(it.ts || it.at || Date.now()).toISOString().slice(11, 19);
      lines.push(`[${t}] ${it.level || 'info'}  ${it.message}`);
    }
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    return logPath;
  } catch (e) {
    try { log(job, 'warn', '失败日志没能写出来（' + ((e && e.message) || e) + '）—— 界面上的日志照常可以看'); } catch (e2) { /* 连日志都写不了就算了 */ }
    return '';
  }
}

/**
 * 一册的文件名。**为什么不能沿用 `outName`**：那个只由"章号+标题"决定，
 * 而合并产物的章号取的是**本次新生成那一章**的 —— 于是它会**静默覆盖**掉这一章的单章产物。
 * 单章页有它自己的用处（这周就发这一章给同学），所以两个都得留着，名字必须区分开。
 */
function bookOutName(bookTitle, chapters, srcPath) {
  const nos = (chapters || [])
    .map((c) => String(chapterNoOf(c && c.chapter)).replace(/[^\w.\-]/g, '').replace(/\.{2,}/g, '.').slice(0, 16))
    .filter(Boolean);
  // 章号区间：`ch13-15-`。章号是字符串，直接取首尾（用户普遍按 13、14、15 这么写）
  const range = nos.length ? (nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : nos[0]) : '';
  const fallback = range ? `第${range}章` : path.basename(srcPath || '', path.extname(srcPath || ''));
  const base = slugify(bookTitle || fallback, 'book');
  return `${range ? 'ch' + range + '-' : ''}${base}-一册-讲练一体.html`;
}

/**
 * 有限并发地跑一批任务，保留顺序。
 *
 * **任何一项失败都立刻停下后面的**：`Promise.all` 只负责把错误抛出去，
 * 它**不会取消**其它 worker——它们会继续把剩下的单元一个个跑完、继续烧 API 额度，
 * 而且失败之后还在往这个任务里写"「U2」完成"的日志，界面上一片错乱
 * （用户此刻多半已经点了"重新生成"，于是两份任务同时在打模型）。
 * 所以这里用一个共享的停止标志，每个 worker 在取下一项之前都看一眼。
 *
 * @param {object} [state] 可选，调用方可以拿到 `state.stopped` 来判断"已经出事了"
 */
async function mapLimit(items, limit, fn, state) {
  const out = new Array(items.length);
  const st = state || {};
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      if (st.stopped) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        st.stopped = true;
        st.error = e;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 单次输出上限：先说好墙在哪 ---------------- */

/**
 * 由**声明的上下文窗口**推一个保守的单次输出上限。
 *
 * 除以 16 不是精确科学，是刻意保守：绝大多数模型的单次输出上限在上下文的 1/8 ~ 1/4 之间，
 * 取 1/16 意味着"这个数几乎不可能撞上服务端的硬上限"——而撞上硬上限的代价是
 * **整单在第一次调用就失败**（有些中转会直接把 `max_tokens` 超限当请求错误拒掉）。
 * 上下再夹一道：低于 16000 没有意义（还不如现在的默认值），高于 64000 就不必再大了——
 * 一次真吐出 6 万 token 的 JSON，解析与回灌的成本已经超过"重出一次"。
 */
function deriveOutputCap(contextLimit) {
  const n = Math.floor(Number(contextLimit) || 0);
  if (n <= 0) return 0;
  return Math.max(16000, Math.min(64000, Math.floor(n / 16)));
}

/**
 * 这次生成该用多大的输出上限。**整个应用只有这一个地方决定它**。
 *
 * 背景（这是一次真实故障的产物）：以前没有任何声明，`askJson` 从 16000 起步，
 * 撞上"输出被截断"就 16k→32k→64k 往上翻——**每翻一次就白烧一轮完整的调用**，
 * 而那一轮的结果一定是废的（截断的 JSON 解析不出来）。更糟的是最后一档也失败时，
 * 用户拿到的是一句"任务失败"，看不出"其实是墙太矮"。
 *
 * 现在：用户在设置里为每个模型声明一次上限，这里就**一步到位**。
 * 声明了就不爬（爬也没有意义——声明的就是墙）；没声明则**完全保持从前的行为**，
 * 免得老配置因为这一版突然变了性子。
 *
 * @param {object|undefined} modelCfg `providers.<id>.models` 里匹配上的那一项
 * @param {object} genOptions         任务选项（读 `maxOutput`：用户手填的覆盖值，0 = 自动）
 * @returns {{start:number, ceiling:number, climb:boolean, source:string}}
 *   `source` 取值：`declared-output` / `derived-context` / `user` / `default-climb`（进日志用）
 */
function resolveTokenPlan(modelCfg, genOptions) {
  const m = modelCfg && typeof modelCfg === 'object' ? modelCfg : {};
  const declaredOut = Math.floor(Number(m.maxOutput) || 0);
  const declaredCtx = Math.floor(Number(m.contextLimit) || 0);
  const user = Math.floor(Number(genOptions && genOptions.maxOutput) || 0);

  const hasDeclared = declaredOut > 0 || declaredCtx > 0;
  let ceiling;
  let source;
  if (declaredOut > 0) {
    ceiling = declaredOut;
    source = 'declared-output';
  } else if (declaredCtx > 0) {
    ceiling = deriveOutputCap(declaredCtx) || 64000;
    source = 'derived-context';
  } else {
    ceiling = 64000;
    source = user > 0 ? 'user' : 'default-climb';
  }

  let start;
  if (user > 0) start = Math.min(user, ceiling);
  else if (hasDeclared) start = ceiling;
  else start = 16000;

  /* 用户手填的值可能比声明的还大：那就以**声明的**为准（声明是墙），
     但起点仍给他填的那个数 —— 他要保守一点是他的自由，要冒进则不该越过墙。 */
  if (ceiling < start) ceiling = start;

  return { start, ceiling, climb: start < ceiling, source };
}

/**
 * 把这一次调用的 token 用量累加进任务（结果页据此给"预估费用"）。
 *
 * 三条取舍：
 *   · **只累加，不做任何计费判断** —— 单价是用户自己在设置里填的，这里不认识钱。
 *   · `usage.reported === false`（提供商没返回用量，例如某些中转的流式响应）时**照样计入调用次数**、
 *     但把 `reported` 记下来：结果页会明说"其中 N 次没有用量数据"，而不是假装总数是准的。
 *   · 失败/重试的那几轮**也算**（它们真的发出去并计费了）—— 只统计"成功那次"会把花费算少，
 *     而少算的那部分恰好是"重试很多次"的任务，正是用户最想知道的。
 */
function addUsage(job, usage) {
  if (!usage || typeof usage !== 'object') return;
  const u = job.usage || (job.usage = { in: 0, out: 0, calls: 0, unreported: 0 });
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  u.calls++;
  if (usage.reported === false) { u.unreported++; return; }
  u.in += n(usage.in);
  u.out += n(usage.out);
}

/** 提供商配置里取某个模型的声明。找不到就给 undefined（`resolveTokenPlan` 会走"没声明"那一路）。 */
function modelCfgOf(provider, model) {
  const list = (provider && Array.isArray(provider.models)) ? provider.models : [];
  const want = String(model == null ? '' : model);
  for (const m of list) {
    if (!m) continue;
    if (typeof m === 'string') { if (m === want) return { id: m }; continue; }
    if (String(m.id) === want) return m;
  }
  return undefined;
}

/**
 * 某个阶段该用哪个模型。
 *
 * 「分阶段用不同模型」只在**同一家提供商内**生效（跨提供商要另一把 Key，不做）：
 * 目的只有一个——把"便宜模型够用的那些调用"挪走，把贵模型留给真正要质量的那一步。
 * 用户没配就一直回落到主模型，于是**不配 = 与从前完全一样**。
 */
function modelForStage(settings, stage) {
  const st = (settings && settings.active && settings.active.stages) || {};
  if (stage === 'analyze' && st.analyze) return st.analyze;
  if (stage === 'audit' && st.audit) return st.audit;
  return (settings && settings.active && settings.active.model) || '';
}

/** 人话描述一份 token plan（进日志）。用户看得懂的措辞，不是枚举值。 */
function tokenPlanText(plan, scope) {
  const why = {
    'declared-output': '按你在设置里为这个模型声明的单次输出上限',
    'derived-context': '按你在设置里为这个模型声明的上下文窗口推算',
    user: '按你在工作台填的上限',
    'default-climb': '没有声明上限，沿用从前的"失败再往上翻倍"',
  }[plan.source] || '未知来源';
  return `${scope}单次输出上限 ${plan.start}${plan.climb ? `（${why}，不够会往上试到 ${plan.ceiling}）` : `（${why}，不再往上试）`}`;
}

/**
 * 要一次「必须是合法 JSON」的模型输出，不合法就带问题回灌重出。
 * validate(obj) 返回问题数组，空数组 = 通过。
 */
/**
 * 模型返回了**空正文**时，说清楚到底发生了什么，并给出"下一次换什么打法"。
 *
 * 为什么需要它：以前这种情况只会报 `JSON 解析失败：Unexpected end of JSON input`
 * —— 用户看到的是"解析失败"，而真正的原因是"压根没有正文可解析"，两者要采取的行动
 * 完全不同（前者改提示词，后者改模型参数）。
 *
 * 实测最常见的一种：**推理型模型（名字带 reasoner / thinking，或界面标了「思考」的）
 * 在难题上把整个输出预算花在思考里**，`content` 就是空的、`finish_reason` 是 `length`。
 * 这时候原样重发只会再空一次，必须**把输出上限调大**才有意义。
 */
function explainEmptyText(res, maxTokens, cap) {
  const fr = (res && res.finishReason) || '未知';
  const reasoning = (res && res.reasoning) || '';
  const out = (res && res.usage && res.usage.out) || 0;
  /* 往上翻的**天花板**。以前是写死的 64000；现在它是"这个模型声明的墙"——
     声明过就不再越过它往上试（越过了服务端只会拒掉整次请求，白烧一轮）。 */
  const top = Math.floor(Number(cap) || 0) || 64000;
  const facts = `模型这次返回了**空正文**（finish_reason=${fr}，输出 token=${out}，本次上限=${maxTokens}）`;
  const plan = { maxTokens: 0, dropJsonMode: false };

  if (reasoning.length > 0) {
    plan.maxTokens = Math.min(top, Math.max(maxTokens * 2, maxTokens + 8000));
    return {
      say: `${facts}，但它输出了 ${reasoning.length} 字的**思考内容**。` +
        '这几乎可以确定是「推理把输出预算吃光了」——推理型模型在难任务上会这样。' +
        `下一次把输出上限提到 ${plan.maxTokens} 再试。`,
      short: `空正文，但思考有 ${reasoning.length} 字（推理吃光了输出预算）`,
      maxTokens: plan.maxTokens,
      dropJsonMode: false,
    };
  }
  if (fr === 'length') {
    plan.maxTokens = Math.min(top, Math.max(maxTokens * 2, maxTokens + 8000));
    return {
      say: `${facts}，输出被上限截断了。下一次把上限提到 ${plan.maxTokens} 再试。`,
      short: '空正文，finish_reason=length（被输出上限截断）',
      maxTokens: plan.maxTokens,
      dropJsonMode: false,
    };
  }
  // 既没思考内容也没截断 —— 多半是这个提供商在 JSON 模式下返回了空
  return {
    say: `${facts}，也没有思考内容。多半是这个提供商在 \`response_format: json_object\`（JSON 模式）下返回了空。` +
      '下一次不带这个参数再试。',
    short: `空正文且无思考内容（finish_reason=${fr}）`,
    maxTokens: 0,
    dropJsonMode: true,
  };
}

async function askJson(job, opts) {
  const prompts = require('./prompts');
  const llm = require('../llm');
  const { stage, what, ctx, messages, validate, provider, model, temperature, signal, rounds } = opts;
  // 允许外部**先**给一份问题清单（例如独立审题的结果）：那样第一次调用就已经是"带着意见重出"，
  // 而不是先原样重发一遍把问题再犯一次。
  const seed = Array.isArray(opts.seedProblems) && opts.seedProblems.length ? opts.seedProblems : null;
  const maxRounds = Math.max(
    seed ? 1 : 0,
    rounds == null ? (job.options.repairRounds != null ? job.options.repairRounds : 2) : rounds
  );

  let last = '';
  let problems = seed;
  let lastMeta = null;
  /* 输出上限的**起点**与**天花板**。传了 `tokenPlan`（生成类调用点都会传）就按
     "用户/模型声明好的墙"起步；没传（小调用：规划、来源分析）保持各自的显式默认值，
     免得几个从不会被截断的调用突然发出一个 6 万 token 的请求。
     ⚠️ 天花板这一档**两边都要用**：它不只是起点，也是"往上试"的终点。 */
  const tokenPlan = opts.tokenPlan || null;
  const cap = (tokenPlan && Math.floor(Number(tokenPlan.ceiling)) > 0) ? Math.floor(Number(tokenPlan.ceiling)) : 64000;
  let maxTokens = (tokenPlan && Math.floor(Number(tokenPlan.start)) > 0)
    ? Math.floor(Number(tokenPlan.start))
    : (opts.maxTokens || 16000);
  let wantJson = true;

  for (let attempt = seed ? 1 : 0; attempt <= maxRounds; attempt++) {
    if (isCanceled(job)) throw new CanceledError();
    const repairCtx = opts.repairCtx || ctx;
    const msg = attempt === 0 ? messages : prompts.repairMessages(repairCtx, stage, problems, last, what);
    if (attempt > 0) log(job, 'warn', `「${what}」第 ${attempt + 1} 次尝试（共 ${maxRounds + 1} 次）`);

    let res;
    try {
      res = await llm.chat({
        provider,
        model,
        system: msg.system,
        messages: [{ role: 'user', content: msg.user }],
        temperature: temperature == null ? job.options.temperature : temperature,
        maxTokens,
        json: wantJson,
        signal,
        onDelta: (t) => jobs.emit(job, { type: 'delta', stage, what, text: t }),
      });
    } catch (e) {
      if (e && e.canceled) throw e;
      // 网络/鉴权类错误回灌给模型没有意义，直接冒上去
      if (e && (e.status === 401 || e.status === 403)) throw e;
      problems = ['上一次调用模型失败：' + (e.message || e)];
      last = '';
      if (attempt >= maxRounds) throw e;
      continue;
    }
    // 用量在**这一层**累加：所有模型调用都从 askJson 走，别处再各记一份迟早对不上
    addUsage(job, res.usage);
    last = res.text || '';
    lastMeta = {
      finishReason: res.finishReason,
      reasoningChars: ((res.reasoning) || '').length,
      outTokens: (res.usage && res.usage.out) || 0,
      maxTokens,
    };
    jobs.emit(job, { type: 'delta', stage, what, text: '', done: true });

    /* ★ 空正文：先把原因说清楚，再换一种打法重试。
       这一步不能省——"解析失败"和"压根没正文"要做的事完全不同。 */
    if (!last.trim()) {
      const why = explainEmptyText(res, maxTokens, cap);
      problems = [why.say];
      log(job, 'warn', `「${what}」${why.short}`);
      if (why.maxTokens > maxTokens) {
        maxTokens = why.maxTokens;
        log(job, 'info', `下一次把输出上限提到 ${maxTokens}`);
      }
      if (why.dropJsonMode && wantJson) {
        wantJson = false;
        log(job, 'info', '下一次不带 response_format 再试（有些提供商在 JSON 模式下会返回空）');
      }
      continue;
    }

    let obj;
    try {
      obj = llm.parseJsonLoose(last);
    } catch (e) {
      problems = [
        'JSON 解析失败：' + e.message,
        '常见原因：尾逗号、注释、单引号、输出被截断、或把 JSON 包在了 Markdown 围栏外的解释文字里。请只输出一个 JSON 对象。',
      ];
      log(job, 'warn', `「${what}」的 JSON 没解析出来：${e.message}`);
      // 输出被截断也会让 JSON 合不上括号：这时同样要把上限调大，否则下一次还是截断
      if (lastMeta && lastMeta.finishReason === 'length' && maxTokens < cap) {
        maxTokens = Math.min(cap, maxTokens * 2);
        log(job, 'info', `上一次的输出被上限截断了，下一次提到 ${maxTokens}`);
      }
      continue;
    }
    problems = validate(obj) || [];
    /* 校验器可能顺手把"能自动修正"的地方改好了（validateProse 会把裸 <table> 包一层、
       把 blocks 数改对）——改了什么要说出来，别静默改用户的东西。 */
    for (const f of (problems.fixed || [])) log(job, 'info', `「${what}」已自动修正：${f}`);
    if (!problems.length) return obj;

    /* ★ 最后一次尝试：只把 STRUCTURAL 类的问题交给"判失败"那一层；
       CLEANABLE / TOLERABLE 的降级成警告，让任务继续走完（讲解照常进页面，拼装时会清掉）。
       理由见文件上部 KIND 那一段：我们明明有能力安全处理它们，却拿它们在内容校验这一层
       把整段讲解回炉，会把重试机会耗光——真正该重试的"输出被截断"反而没机会重试。
       ⚠️ 前面几次**照旧按不合格回炉**：这条质量压力必须保住，不能一上来就降级。 */
    if (attempt >= maxRounds && opts.softenLastRound) {
      const soft = [];
      const hard = [];
      problems.forEach((m, i) => (problemKind(problems, i) === KIND.STRUCTURAL ? hard : soft).push(m));
      if (soft.length) {
        (job.proseDowngrades = job.proseDowngrades || []).push({ what, problems: soft.slice() });
        log(job, 'warn', `「${what}」有 ${soft.length} 处问题属于「拼装时会自动清理、或不影响页面能用」的类型，`
          + `不再为它重试，已照常交付（正文其余内容都在）：${soft.slice(0, 3).join('；')}${soft.length > 3 ? ' …' : ''}`);
      }
      if (!hard.length) return obj;
      problems = hard;   // 只剩结构性 → 下面照常判失败（也只把这几条交上去）
    }
    log(job, 'warn', `「${what}」有 ${problems.length} 处不合格：${problems.slice(0, 4).join('；')}${problems.length > 4 ? ' …' : ''}`);
  }
  const err = new Error(`「${what}」连续 ${maxRounds + 1} 次都没能产出合格结果。最后的问题：${(problems || []).join('；')}`);
  err.stage = stage;
  err.problems = problems;
  err.raw = last.slice(0, 4000);
  err.meta = lastMeta;
  throw err;
}

/* ---------------- 各阶段的校验器 ---------------- */

/** 正则元字符转义（演示 id 会被拼进 RegExp）。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 引擎与骨架页自己占用的元素 id。
 *
 * 模型给单元起 `sectionId` 时如果撞上这些，`getElementById` 会先拿到模型那个 `<section>`
 * ——引擎随后把它的 textContent 写成 "0 / 2"，**整节标题与讲解正文被一串数字抹掉**，
 * 而真正的结算面板永远停在初始值。页面不报错，只能靠肉眼发现。所以撞了就回灌重写。
 */
const RESERVED_IDS = new Set([
  's-done', 's-total', 's-rate', 's-wrong', 's-fill', 's-nosave',
  'onlyWrong', 'resetAll', 'petToggle',
  'r-done', 'r-rate', 'r-wrong', 'r-verdict', 'r-bars', 'r-advice', 'r-advicetext',
  'goWrong', 'goAll', 'wrongEmpty', 'result', 'howto', 'engine', 'pet', 'petBubble', 'petFig', 'bgimg',
]);

function validateOutline(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!o.chapter || typeof o.chapter !== 'object') p.push('缺 chapter 对象');
  else {
    if (!o.chapter.title) p.push('chapter.title 没写');
    if (!o.chapter.subject) p.push('chapter.subject 没写');
  }
  if (!Array.isArray(o.units) || !o.units.length) p.push('units 不是非空数组');
  else {
    const seen = { uid: new Set(), sectionId: new Set(), qsecId: new Set(), lv: new Set() };
    o.units.forEach((u, i) => {
      const at = `units[${i}]`;
      // ⚠️ 先判它是不是对象：模型给出 [null] / ["u1"] 时，下面每一句 `u.uid` 都会抛
      // TypeError 冒到界面上（用户看到 "Cannot read properties of null"），
      // 而且**一轮修复都不会触发**——校验器自己崩了，回灌自然无从谈起。
      if (!u || typeof u !== 'object' || Array.isArray(u)) {
        p.push(`${at} 不是一个对象（数组里每项都得是 {\"uid\":…} 这样的对象）`);
        return;
      }
      if (!u.uid) p.push(`${at} 缺 uid`);
      else if (seen.uid.has(u.uid)) p.push(`${at}.uid 与前面重复（${u.uid}）`);
      else seen.uid.add(u.uid);

      if (!u.title) p.push(`${at} 缺 title（讲解块标题）`);
      if (!u.qsecTitle) p.push(`${at} 缺 qsecTitle（题区标题，要以「练一练」开头）`);
      else if (!/^练一练/.test(u.qsecTitle)) p.push(`${at}.qsecTitle 必须以「练一练」开头，现在是「${u.qsecTitle}」`);
      // 结算条的关卡名是从题区 h2 推出来的，标题里混进计数或斜杠会被正则剥花
      else if (/已答|\d\s*\/\s*\d/.test(u.qsecTitle)) p.push(`${at}.qsecTitle 里不要写「已答」或 "x/y" 这类计数（结算条会自己算）`);

      if (!u.sectionId) p.push(`${at} 缺 sectionId`);
      else if (RESERVED_IDS.has(u.sectionId)) {
        // 撞上引擎自己的元素 id：引擎会把该 <section> 的 textContent 设成 "0 / 2"，
        // **整节标题与讲解正文被一串数字抹掉**，而真正的结算面板永远停在初始值，页面无报错
        p.push(`${at}.sectionId 用了引擎保留 id「${u.sectionId}」，换一个（如 s131）`);
      } else if (seen.sectionId.has(u.sectionId)) p.push(`${at}.sectionId 与前面重复（${u.sectionId}）`);
      else seen.sectionId.add(u.sectionId);

      if (u.qsecId != null && u.qsecId !== 'p-l' + u.lv) p.push(`${at}.qsecId 必须等于 "p-l"+lv（现在 lv=${u.lv}，qsecId=${u.qsecId}）`);
      if (!(u.targetCount > 0)) p.push(`${at}.targetCount 要不是正数`);
      if (u.lv != null && seen.lv.has(u.lv)) p.push(`${at}.lv 与前面重复（${u.lv}）`);
      else if (u.lv != null) seen.lv.add(u.lv);
    });
  }
  if (!o.bigUnit || typeof o.bigUnit !== 'object') p.push('缺 bigUnit（综合大题单元）');
  else {
    if (!o.bigUnit.title) p.push('bigUnit.title 没写');
    if (!(o.bigUnit.targetCount > 0)) p.push('bigUnit.targetCount 要不是正数');
    if (o.bigUnit.sectionId && RESERVED_IDS.has(o.bigUnit.sectionId)) {
      p.push(`bigUnit.sectionId 用了引擎保留 id「${o.bigUnit.sectionId}」，换一个（如 sbig）`);
    }
    if (o.bigUnit.sectionId && Array.isArray(o.units)) {
      const clash = o.units.some((u) => u && u.sectionId === o.bigUnit.sectionId);
      if (clash) p.push(`bigUnit.sectionId 与某个单元重复（${o.bigUnit.sectionId}）`);
    }
  }
  // 演示必须挂在真实存在的单元上，否则它的占位注释永远没人填
  if (Array.isArray(o.demos) && Array.isArray(o.units)) {
    const uids = new Set(o.units.filter((u) => u && u.uid).map((u) => u.uid));
    const seenDemoIds = new Set();
    o.demos.forEach((d, i) => {
      if (!d || typeof d !== 'object') {
        p.push(`demos[${i}] 不是一个对象`);
        return;
      }
      /* 演示 id 必须校验：它会被拼进 `new RegExp('<!--DEMO:' + id + '-->')`。
         模型给出含正则元字符的 id（`a(b`、`a[b`）时，**校验器自己**抛 SyntaxError，
         从 askJson 冒到整单 failed —— 已经烧掉的讲解/题库调用全部作废、一个文件都不产出，
         而用户看到的只有一句 `Invalid regular expression: … Unterminated group`。
         契约 §1.2 明写 id 要满足 ^demo[A-Z]$，之前只查了 unitUid。 */
      if (!d.id) {
        p.push(`demos[${i}] 没有 id（必须形如 demoA / demoB，宿主靠它把演示放回正文）`);
        return;
      }
      if (!/^demo[A-Z]$/.test(d.id)) {
        p.push(`demos[${i}].id「${d.id}」不合规：必须形如 demoA / demoB（只允许 demo + 一个大写字母）`);
        return;
      }
      if (seenDemoIds.has(d.id)) {
        p.push(`demos[${i}].id 与前面重复（${d.id}）——两个演示会抢同一个 DOM id，请改成 demoB / demoC`);
        return;
      }
      seenDemoIds.add(d.id);
      if (d.unitUid && !uids.has(d.unitUid)) {
        p.push(`demos[${i}].unitUid「${d.unitUid}」不在 units 里（可选：${[...uids].join('、')}）`);
      }
    });
  }
  if (Array.isArray(o.units) && o.bigUnit && typeof o.bigUnit.targetCount === 'number') {
    const sum = o.units.reduce((n, u) => n + (Number(u && u.targetCount) || 0), 0) + o.bigUnit.targetCount;
    if (o.answerPoints != null && Number(o.answerPoints) !== sum) {
      // 这一条是契约 §1.2 的不变量 1。不致命——执行层以 targetCount 为准——
      // 但差别大说明模型没在认真配额度，值得让它重来一次
      p.push(`answerPoints(${o.answerPoints}) 与 ΣtargetCount(${sum}) 不等，请改成一致`);
    }
  }
  return p;
}

/* ================= 讲解校验：哪些问题该回炉，哪些可以降级交付 =================
 *
 * 这一段是为一个**用户实跑报上来的故障**加的：
 *   某个单元的讲解连续 3 次没过校验，整个任务被打死、一个文件都没产出。
 *   而三次里前两次的问题（内联事件、裸 <table>）**拼装时本来就会被安全处理掉**
 *   （见 assemble.js 的 sanitizeModelHtml）—— 我们明明有能力处理，却先拿它们在内容校验
 *   这一层把整段讲解回炉，把三次机会耗光，真正该重试的"输出被截断"反而没机会重试。
 *
 * 所以每条规则都带一个类别：
 *   · CLEANABLE  拼装时 sanitizeModelHtml 会安全处理掉（整类删掉，或把值改成 #），
 *                交付出去的页面里不会剩下它 —— 最后一次尝试不再为它重试
 *   · TOLERABLE  清洗器**有意保留**（演示的滑块/预设按钮就是 <input>/<button>），
 *                但也执行不了任何东西；或者拼装器有兜底并会记一条警告 —— 也不再为它重试
 *   · STRUCTURAL 拼装器兜不住：交付出去就是坏页面（整页被吞、内容静默消失、引擎静默失效）
 *                —— 无论第几次尝试都判失败
 *
 * ⚠️ 判据是 sanitizeModelHtml **实际会做什么**（assemble.js 里 drop(...) 的清单 + scrubTagAttrs
 *    的两条 sub），每条 cleanable 规则旁边都注明了对应它的哪一句 —— 别凭印象挪类别。
 * ⚠️ 别为了"少报一点"把 STRUCTURAL 往 CLEANABLE 上挪：`<style>` 没配平、注释没配平、
 *    用了引擎保留 id 这几类，交付出去是真会坏页面的。
 * ⚠️ sanitizeModelHtml 本身一个字都别动（它被 20+ 套测试压着，见 test/hostile-input.js）。
 */
const KIND = { CLEANABLE: 'cleanable', TOLERABLE: 'tolerable', STRUCTURAL: 'structural' };

/** 问题 m 属于哪一类。没标类别的校验器一律算 structural（它们的失败都是真失败，行为与从前一致）。 */
function problemKind(problems, i) {
  const k = problems && problems.kinds;
  return (Array.isArray(k) && k[i]) || KIND.STRUCTURAL;
}

/**
 * 给"问题数组"挂上两样元信息：每条属于哪一类、以及校验器顺手自动改了什么。
 *
 * 用**不可枚举**属性挂：`join('；')`、`JSON.stringify`、`.slice()`、遍历都看不见它，
 * 所以日志、修复提示词、以及 test/_audit 里的脚本拿到的仍是一个普通的字符串数组。
 */
function withKinds(problems, kinds, fixed) {
  Object.defineProperty(problems, 'kinds', { value: kinds.slice(), enumerable: false });
  if (fixed && fixed.length) Object.defineProperty(problems, 'fixed', { value: fixed.slice(), enumerable: false });
  return problems;
}

/** `<style>` 这类标签：清洗器只删得掉**成对**的，开闭数量一致才敢说"拼装时会被清掉"。 */
function pairBalanced(html, open, close) {
  return (html.match(open) || []).length === (html.match(close) || []).length;
}

/**
 * 讲解正文的规则表：`[正则, 说法, 类别]`。类别可以是字符串，也可以是 `(html) => 类别`。
 * 每一条都对应"页面会静默出问题"的具体后果，不是洁癖。契约 §2.2 明说这些校验器要一并实现。
 */
const PROSE_RULES = [
  /* —— 清洗器**整类删掉**的（sanitizeModelHtml 里的 drop 列表）—— */
  [/<script\b/i, 'html 里出现了 <script>（会让外层解析器提前关闭脚本，整页 JS 失效）', KIND.CLEANABLE],   // drop(/<script\b[^>]*\/?>/) + 成对那一句
  [/<\/script/i, 'html 里出现了 </script>（同上）', KIND.CLEANABLE],                                   // drop(/<\/script\s*>/)
  [/<iframe\b/i, 'html 里出现了 <iframe>（本页不许嵌任何外部内容）', KIND.CLEANABLE],                  // drop(<iframe> 成对/单个)
  [/<base\b/i, 'html 里出现了 <base>（会改掉同目录图片的相对路径，陪练/背景就找不到了）', KIND.CLEANABLE], // drop(/<base\b[^>]*\/?>/)
  [/<link\b/i, 'html 里出现了 <link>（本页零外部资源，不引任何样式表）', KIND.CLEANABLE],               // drop(/<link\b[^>]*\/?>/)
  [/<meta\b/i, 'html 里出现了 <meta>（宿主已在 head 里写好，别再插）', KIND.CLEANABLE],                 // drop(/<meta\b[^>]*\/?>/)
  [/<form\b/i, 'html 里出现了 <form>（页面自己有按钮，别自己造）', KIND.CLEANABLE],                     // drop(<form> 成对/单个)
  /* —— 清洗器**改值/剥属性**的（scrubTagAttrs）—— */
  [/on[a-z]+\s*=/i, '标签上出现了内联事件（如 onclick=）——做题页不执行讲解里的脚本', KIND.CLEANABLE],     // sub(/([\s/"'])on[a-z]+\s*=/)
  [/\bsrc\s*=\s*["']?(?:https?:)?\/\//i, '出现了外链资源（本页必须零外部请求，离线也要能看）', KIND.CLEANABLE], // 外链那条 sub → 改成 "#"
  [/\bhref\s*=\s*["']https?:/i, '出现了外链链接（讲解里的链接一律用同页锚点 #xxx）', KIND.CLEANABLE],     // 同上
  /* —— 清洗器**有意保留**的控件（sanitizeModelHtml 那段注释：演示的滑块就是 <input type=range>、
        预设按钮就是 <button>，删了整个演示就没了）。它们执行不了任何东西（on*= 已被剥、
        外链已被改成 #），交付出去只是页面上多一个没用的控件，不该为它把整段讲解回炉。 —— */
  [/<input\b|<button\b/i, 'html 里出现了表单控件（页面自己有按钮，别自己造）', KIND.TOLERABLE],
  [/<canvas\b|<video\b|<audio\b/i, 'html 里出现了 canvas/video/audio（本页不用这些）', KIND.TOLERABLE],
  /* —— 清洗器兜不住的真失败 —— */
  [/<h1\b/i, 'html 里出现了 <h1>（页面已经有 h1 了）', KIND.STRUCTURAL],
  [/<section\b/i, 'html 里出现了 <section>（外壳由宿主加，你只写内部片段）', KIND.STRUCTURAL],
  [/<h2\b/i, 'html 里出现了 <h2>（小节标题由宿主加）', KIND.STRUCTURAL],
  /* <style> 单独说：清洗器只删**成对**的 <style>…</style>；配不平的那一个（例如只写了 <style>
     没闭合）会原样漏进页面，把**后面整页**吞成 CSS 文本 —— 而拼装器的自检拦不住它
     （那里数的是 <!-- 与 <script> 的配平）。所以按配平情况分：配平 = 拼装时会被清掉。 */
  [/<style\b/i, 'html 里出现了 <style>（样式由宿主提供）',
    (html) => (pairBalanced(html, /<style\b/gi, /<\/style\s*>/gi) ? KIND.CLEANABLE : KIND.STRUCTURAL)],
  [/class\s*=\s*["'][^"']*\bbox\b/i, '用了 class="box"——那个类默认 display:none，整段内容会凭空消失', KIND.STRUCTURAL],
  [/\$\$?[^$]+\$\$?/, 'html 里出现了 LaTeX 的 $…$ 公式（本页不引 MathJax，学生看到的是原始符号）', KIND.STRUCTURAL],
  [/\\frac|\\text\{|\\\(|\\\[/, 'html 里出现了 LaTeX 命令（本页不引 MathJax，学生看到的是原始符号）', KIND.STRUCTURAL],
  // 注意：<sub>/<sup> 在**讲解正文**里是允许的（契约 §3 的公式就写作 μ₀μ<sub>r</sub>H），
  // 只有 SVG 的 <text> 里不能用。那条由演示自己的 checks 与演示探针去管，不在这里一刀切。
];

/**
 * 数一数正文里有多少个**没被包起来**的 `<table>`。
 *
 * 两种写法都算"包好了"（判据与 autoFixProse 完全一致，否则自动包完还会被自己报一嗓子）：
 *   · `<div class="tablewrap"><table>` —— 契约 §3 表格那一行的写法（我们自动包出来的就是这个）
 *   · `<table class="tablewrap">`      —— 旧写法，兼容着
 * ⚠️ 原来的正则只认后一种，于是**契约要求的写法反而被判成不合格**：模型按契约写了
 *    `<div class="tablewrap"><table>`，校验器还照报"裸的 <table>"，回炉重出还是那样，白烧三轮。
 */
function bareTableCount(html) {
  let n = 0;
  for (const m of html.matchAll(/<table\b[^>]*>/gi)) {
    if (/\btablewrap\b/i.test(m[0])) continue;                                  // 自己带了 tablewrap
    if (/<div class="tablewrap">\s*$/i.test(html.slice(0, m.index))) continue;  // 上一句就是包它的 div
    n++;
  }
  return n;
}

/**
 * 顺手能改好的，直接改好 —— **比报警告好**（用户明确要的）。
 * 只做**内容无损**的改动：改坏了自己看不出来，那比回炉重出更糟。
 * @param {object} o prose 对象（就地改 o.html / o.blocks）
 * @param {string[]} fixed 收"改了什么"（人话，会进日志与报告）
 */
function autoFixProse(o, fixed) {
  /* ① 裸 <table> 包一层 <div class="tablewrap">。
     窄屏横向撑破版式就是这个引起的，而它**不值得回炉**：包一层纯属好事。 */
  if (/<table\b/i.test(o.html)) {
    const before = o.html;
    o.html = o.html.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (m, offset, whole) => {
      const head = m.slice(0, m.indexOf('>') + 1);
      if (/\btablewrap\b/i.test(head)) return m;                      // 自己带了 tablewrap，不动它
      if (/<div class="tablewrap">\s*$/i.test(whole.slice(0, offset))) return m;  // 已经包过一层了
      /* 里面还套着表格：非贪婪配对配到的不是真正的那一对，包下去会把 <div> 插进表格结构内部
         （浏览器会把它从表里挪出去，版式反而更乱）—— 这种不碰，留给上面的规则报一嗓子。 */
      if (/<table\b/i.test(m.slice(head.length))) return m;
      return '<div class="tablewrap">' + m + '</div>';
    });
    if (o.html !== before) fixed.push('把裸的 <table> 包进了 <div class="tablewrap">（窄屏就不会撑破版式了）');
  }

  /* ② blocks 字段与 <h3> 个数不符 → 直接改成实测值。
     这个字段**只有本校验器在读**（页面、拼装、落盘、合并都不看它），为它对不上回炉不值当。 */
  const h3 = (o.html.match(/<h3\b/gi) || []).length;
  if (o.blocks != null && Number(o.blocks) !== h3) {
    fixed.push(`把 blocks 字段从 ${o.blocks} 改成了 ${h3}（html 里就是 ${h3} 个 <h3>）`);
    o.blocks = h3;
  }
}

function validateProse(o, unit) {
  if (!o || typeof o !== 'object') return withKinds(['返回的不是一个对象'], [KIND.STRUCTURAL]);
  const p = [];
  const kinds = [];
  const fixed = [];
  const put = (msg, kind) => { p.push(msg); kinds.push(kind || KIND.STRUCTURAL); };
  if (typeof o.html !== 'string' || o.html.length < 80) put('html 太短或不是字符串');
  else {
    // 能自动修正的先改掉（改完再按规则看剩下的），别为"我们自己顺手能改好"的事回炉
    autoFixProse(o, fixed);
    const html = o.html;
    for (const [re, msg, kind] of PROSE_RULES) {
      if (re.test(html)) put(msg, typeof kind === 'function' ? kind(html) : kind);
    }

    // 注释必须配平：一个孤立的 <!-- 会把它之后**整个页面**（题库、引擎全在内）吞成注释，
    // 而浏览器完全不给信号——页面只剩页眉，控制台干干净净。
    // 结构性：清洗器不碰注释，拼装器的自检也会因它抛错 —— 兜不住，交付不了。
    const cmtOpen = (o.html.match(/<!--/g) || []).length;
    const cmtClose = (o.html.match(/-->/g) || []).length;
    if (cmtOpen !== cmtClose) {
      put(`HTML 注释没配平（<!-- ${cmtOpen} 个、--> ${cmtClose} 个）——除了演示占位注释，正文里不要写注释`);
    }

    /* 正文里写出引擎自己的 id → 文档序在前的那个（模型这个）会被 getElementById 拿到，
       引擎随后把它的 textContent 写成 "0 / 2"，**真正的结算面板永远停在初始值**，
       而页面与控制台都不报错。RESERVED_IDS 这套检查原本只用在 outline 的 sectionId 上。 */
    /* ⚠️ 属性写法要认全：`id=r-rate`（无引号）、`ID="r-rate"`（大写）在 HTML 里同样生效。
       旧正则写死了 `\sid\s*=\s*["']…["']`（必须小写 + 必须带引号），于是这两种写法直接放行，
       页面里同一个 id 出现两次、模型那份文档序在前 → getElementById 拿到它 →
       引擎把统计写进去的是那个假节点，**真正的结算区永远停在初始值，页面与控制台都不报错**。 */
    const reservedHit = [];
    for (const m of o.html.matchAll(/[\s/"']id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const idv = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      if (RESERVED_IDS.has(idv)) reservedHit.push(idv);
    }
    if (reservedHit.length) {
      // 结构性：清洗器不认 id，交付出去就是引擎静默写错地方（页面与控制台都不报错）
      put(`html 里用了引擎保留的 id（${[...new Set(reservedHit)].join('、')}）——它们会和结算区/顶栏重名，` +
        '导致那部分静默失效。请换一个 id（比如加上本节前缀 k131-）。');
    }

    /* 裸 <table>：正常情况 autoFixProse 已经自动包好了；这里兜的是它包不了的（没闭合的、
       里外套着的）。窄屏横向撑破版式是**观感**问题，不是坏页面 —— 别为它把整段讲解回炉。 */
    const bareTables = bareTableCount(html);
    if (bareTables) {
      put(`html 里有 ${bareTables} 个裸的 <table> 没包 <div class="tablewrap">（窄屏会撑破版式）`, KIND.TOLERABLE);
    }

    const h3 = (o.html.match(/<h3\b/gi) || []).length;
    // 块数为 0 = 结构不成形（契约 §2：每个知识块必须是一个 <h3>）→ 结构性
    if (!h3) put('html 里一个 <h3> 都没有（每个知识块必须是一个 <h3>）');
    // blocks 字段在 autoFixProse 里已经改对了；万一没改（html 不是字符串那种情况）这里也不兜——
    // 它只有本校验器在读，对不上不该让整段讲解回炉

    /* ⚠️ 演示占位这一段**必须在"html 是字符串"这个分支里面**：
       放在外面时，模型返回 `{error:…}`（或 html 写成 null / 数字）会让 `o.html.match`
       抛 TypeError —— **校验器自己崩了**，回灌自然无从谈起，用户看到的是一句
       "Cannot read properties of undefined (reading 'match')" 加一句"任务失败"，
       而且单元挂没挂演示决定了它犯不犯（有演示的单元必犯）。这是本轮测试真跑出来的。 */
    if (unit && Array.isArray(unit.demoIds)) {
      for (const id of unit.demoIds) {
        const n = (o.html.match(new RegExp(`<!--DEMO:${escapeRegExp(id)}-->`, 'g')) || []).length;
        /* 演示占位：拼装器**有兜底**（占位没出现在正文里时，它会挂到该演示所属单元的题区之前，
           并记一条警告；多出来的占位会原样留在页面上，也记一条警告）。页面不会坏，
           所以归 tolerable —— 最后一次尝试不再为它回炉。 */
        if (n !== 1) put(`演示占位 <!--DEMO:${id}--> 应该恰好出现 1 次，现在出现 ${n} 次`, KIND.TOLERABLE);
      }
    }
  }
  return withKinds(p, kinds, fixed);
}

function validateBankShape(o, unit) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!Array.isArray(o.items) || !o.items.length) return ['items 不是非空数组'];

  /* ⚠️ **自创题型必须在数条数之前拦下来**。
     `normalizeBank` 遇到不认识的 `type` 是**静默降级成 single**（见 bank.js 的 normalizePart），
     所以它拦不住模型自创的 `judge`（判断）/ `fill`（填空）/ `short`（简答）——
     那会变成一道**语义错位的单选题**（题干写着"判断对错"、选项却还是原来的四个），
     **而页面、控制台都不会报任何错**，用户只会觉得"这题怪怪的"。
     真题那一步最容易撞上：卷面写着"判断题"，模型就顺手写了个 `type:"judge"`。
     只对"写了但写错"的 type 硬判；"压根没写 type"保持原有的宽容降级，别动它。 */
  const badTypes = [];
  o.items.forEach((it, i) => {
    if (it && typeof it === 'object' && it.type !== undefined && !KNOWN_TYPES.has(it.type)) {
      badTypes.push(`items[${i}].type 是「${it.type}」，不是四种题型之一`
        + '（single 单选 / multi 多选 / num 填数值 / big 综合大题）。'
        + '判断题请写成两个选项（「正确」「错误」）的 single，填空题用 num，简答与计算用 big。');
    }
    if (it && it.type === 'big' && Array.isArray(it.parts)) {
      it.parts.forEach((pt, j) => {
        if (pt && typeof pt === 'object' && pt.type !== undefined && !PART_TYPES.has(pt.type)) {
          badTypes.push(`items[${i}].parts[${j}].type 是「${pt.type}」，大题的小题只能是 single / multi / num。`);
        }
      });
    }
  });
  if (badTypes.length) return badTypes;   // 先让它把题型改对，别的（条数、选项）这轮先不数

  if (unit) {
    // 数量对不上就重来——契约要求 targetCount 精确等于作答点总数
    let n = 0;
    for (const it of o.items) n += it && it.type === 'big' && Array.isArray(it.parts) ? it.parts.length : 1;
    const want = Number(unit.targetCount);
    if (want && n !== want) p.push(`items 里的作答点共 ${n} 个，但 outline 里这一节写的是 ${want} 个，请改成 ${want} 个`);
  }
  // **内容级校验也要在这里做**，不能只数条数。
  // 以前只有 assemble 才跑 normalizeBank，那时所有单元的正文都生成完了——
  // 一处"单选标了两个 ok:true"会让整单直接 failed，**没有任何一轮修复**，
  // 已花的费用与已生成的讲解全部作废，输出目录里连 HTML 都没有。
  // 现在把问题当回灌文本交给 askJson，模型能当场改。
  try {
    const res = normalizeBank(o.items, { lv: unit ? unit.lv || 0 : 0, namespace: 'check' });
    for (const it of res.issues) p.push(it.message);
  } catch (e) {
    p.push('题库规范化时出错：' + e.message);
  }
  return p;
}

/* ---------------- 分章 ---------------- */

/**
 * 这一次要生成哪几章。
 *
 * ⚠️ **永远在流水线里重新分组，不用 `job.chapters` 里那些来源对象。**
 * `gen:start` 分组用的是它自己 `normalizeSources(input)` 出来的那一份，而 `job.sources` 是
 * `createJob` 里**另一次**归一的产物 —— 两个数组里的对象不是同一个引用。
 * 拿前者去跑，抽取时会往 A 上写 `pages`、而规划读的是 B 上的 `pages`（undefined）：
 * 症状是"章是分对了，但每一章的材料都是空的"，而页面会照常生成出一份没有内容的册子。
 * 来源对象是**流水线这一路自己长出来的**（抽取、分析都往上挂东西），所以只能用它自己那一份。
 */
function resolveChapters(job) {
  const ch = require('./chapters');
  const g = ch.groupSources(job.sources || [], job.options || {});
  if (!g.ok) throw new Error(g.message);
  return g.chapters;
}

/**
 * 跨章关联：**只算，然后按需要问一句**（第 6 条）。
 *
 * 判据全部来自已经拿到的逐来源分析结论（S0），所以这里**不多烧一次模型调用**。
 * 只在"合成一册 + 至少两章"时才可能问；`separate`（本来就要各出各的）与单章一个字都不问。
 *
 * 问出口的门槛（`AFFINITY_ASK`）比"值得在日志里提一句"的门槛（`AFFINITY_NOTE`）高不少：
 * 每多问一次就多打断用户一次，而"两章有点关系"是常态，不值得为它停下来。
 *
 * @returns {Promise<'linked'|'simple'>}
 */
async function decideCrossChapter(job, chapters) {
  const ch = require('./chapters');
  if ((job.mode || 'book') === 'separate') return 'simple';
  if (chapters.length < 2) return 'simple';

  const notesOf = (c) => (c.sources || []).map((s) => s.note).filter(Boolean);
  const pairs = [];
  for (let i = 1; i < chapters.length; i++) {
    let best = 0;
    for (const x of notesOf(chapters[i - 1])) {
      for (const y of notesOf(chapters[i])) best = Math.max(best, ch.chapterAffinity(x, y));
    }
    if (best >= ch.AFFINITY_NOTE) {
      pairs.push({ i, score: best, prev: chapters[i - 1], next: chapters[i] });
    }
  }
  const name = (c, k) => (c.title ? `第 ${c.no || k + 1} 章「${c.title}」` : `第 ${c.no || k + 1} 章`);
  for (const p of pairs) {
    log(job, 'info', `${name(p.prev, p.i - 1)} 与 ${name(p.next, p.i)} 的内容有重合（关联度 ${p.score.toFixed(2)}）`);
  }
  const strong = pairs.filter((p) => p.score >= ch.AFFINITY_ASK).sort((a, b) => b.score - a.score);
  if (!strong.length) return 'simple';

  const p = strong[0];
  log(job, 'info', `${name(p.prev, p.i - 1)} 与 ${name(p.next, p.i)} 关联很大（${p.score.toFixed(2)}）——问一下要不要让它们互相照应`);
  const answer = await jobs.ask(job, {
    id: 'cross-chapter',
    title: '这两章关联很大，要不要让它们互相照应？',
    /* ⚠️ 这里（以及所有会进界面的文案）**不许用 Markdown 强调标记**：
       `ask.message` 是当纯文本渲染的，`**怎么生成**` 会连着星号一起显示给用户。 */
    message: `${name(p.prev, p.i - 1)} 和 ${name(p.next, p.i)} 讲的东西重合得不少。`
      + '下面的选择只影响「怎么生成」，不影响章的划分。',
    options: [
      {
        value: 'simple',
        label: '简单缝合（各自生成，直接拼在一起）',
        detail: '每章独立生成，互不引用。最省事，也最不容易出岔子；代价是同一件事可能在两章里各讲一遍。',
      },
      {
        value: 'linked',
        label: '关联生成（后面的章能看到前面几章讲了什么）',
        detail: '生成第 N 章时把前面几章的摘要放进提示词：它会主动呼应前面讲过的概念、不重复讲，'
          + '也会在需要时点明"上一章那个工具在这里怎么用"。多出来的代价只有提示词变长一点。',
      },
    ],
    default: 'simple',
  });
  return answer === 'linked' ? 'linked' : 'simple';
}

/* ---------------- 主流程 ---------------- */

async function runGeneration(job) {
  const ac = new AbortController();
  job._abort = ac;
  const signal = ac.signal;
  const t0 = Date.now();
  job.status = 'running';
  jobs.emit(job, { type: 'started', at: t0 });

  try {
    const settings = store.getSettings();
    const providerId = settings.active.provider;
    const model = settings.active.model;
    if (!providerId || !model) throw new Error('还没选模型：请到「设置」里启用一个提供商并选定模型');
    const provider = store.providerConfig(providerId);
    job.model = { provider: provider.name, model };
    log(job, 'info', `使用模型：${provider.name} / ${model}`);

    /* 「分阶段用不同模型」：只影响两个**便宜模型够用**的调用点（逐来源分析、独立审题），
       其余全部走主模型。没配就是空串 ⇒ `modelForStage` 回落主模型 ⇒ 与从前一模一样。 */
    const modelOf = (stage) => modelForStage(settings, stage);
    const stageModel = { analyze: modelOf('analyze'), audit: modelOf('audit') };
    for (const [k, v] of Object.entries(stageModel)) {
      if (v && v !== model) log(job, 'info', `分阶段模型：${{ analyze: '逐来源分析', audit: '独立审题' }[k]}用「${v}」`);
    }

    /* 单次输出上限**先说好墙在哪**（见 `resolveTokenPlan` 的注释）。每个调用点按它**自己那个模型**
       的声明取值 —— 分阶段模型不同，声明也就不同。 */
    const planFor = (m) => resolveTokenPlan(modelCfgOf(provider, m), job.options);
    const mainPlan = planFor(model);
    log(job, 'info', tokenPlanText(mainPlan, ''));
    if (stageModel.analyze && stageModel.analyze !== model) {
      log(job, 'info', tokenPlanText(planFor(stageModel.analyze), '逐来源分析：'));
    }
    /* ⚠️ `default-climb`（没声明、也没手填）时把 plan 传成 `null`，让各调用点用**它自己原来的**
       那个数值 —— 这样"老配置"发出的请求与 1.3.0 **逐字节一致**，不会因为这一版突然变了性子。
       一旦有声明或手填，plan 才接管（那正是"先说好墙在哪"要生效的情形）。 */
    const asPlanArg = (p) => (p.source === 'default-climb' ? null : p);
    const mainTokenPlan = asPlanArg(mainPlan);

    /* ---- 1. 抽取（每份来源各抽一次） ---- */
    progress(job, 'extract', 'running');
    const tEx = Date.now();
    const prompts = require('./prompts');
    const { labelOf, pagesOf, ROLE_WEIGHTS } = prompts;
    const { scopePages, validateSourceNote, trimNote } = require('./sources');
    const sources = job.sources || [];
    const label = (s) => labelOf(s);
    const textOf = (s) => pagesOf(s).filter((p) => p.text && p.text.trim());

    /* 用户手工修订按 **`${来源 id}:${页号}`** 回填。
       ⚠️ 这个键以前是**裸页号**。多来源下页号必然重复，于是"改了课本第 3 页"会变成
       "改了课件第 3 页"——不报错、不崩溃，内容悄悄错位，是最难发现的一类失效。
       没有 sourceId 的旧格式（老渲染进程 / 第三方脚本）归给主来源，保证修订不被丢掉。 */
    const editedByKey = new Map(
      (job.options.editedPages || []).map((e) => [`${e.sourceId || sources[0].id}:${e.index}`, e.text])
    );
    let usedEdits = 0;

    await mapLimit(sources, job.options.concurrency || 3, async (src) => {
      const ex = await getExtract()(src.filePath);
      src.kind = ex.kind;
      src.meta = ex.meta;
      src.diagnosis = ex.diagnosis;
      src.warnings = ex.warnings || [];
      src.pages = ex.pages;
      if (editedByKey.size) {
        src.pages = src.pages.map((p) => {
          const t = editedByKey.get(`${src.id}:${p.index}`);
          if (t === undefined) return p;
          usedEdits++;
          return Object.assign({}, p, { text: t, edited: true });
        });
      }
      src.scopedPages = scopePages(src.pages, src.scope);   // 课本只取用户指定的那一节
    });
    if (usedEdits) log(job, 'info', `采用了用户手工修订的 ${usedEdits} 页文本`);

    for (const src of sources) {
      if (src.diagnosis && src.diagnosis.likely) {
        log(job, 'warn', `「${label(src)}」看起来是扫描件或整页图片（${src.diagnosis.reason}）——本工具不做 OCR，这份材料多半抽不到文字`);
      }
      for (const w of src.warnings) log(job, w.level === 'warn' ? 'warn' : 'info', `[${label(src)}] ${w.message}`);
    }

    /* ⚠️ 硬失败**只针对主来源**。
       一份来源时语义与从前完全一致（主来源就是唯一来源）。
       多来源时，一份扫描件真题既不该把整单拖下水，也不该被静默忽略——
       所以其余来源抽不出文字只**降级**：标记 dropped + warn + 写进报告，用户看得见。 */
    const mainSource = sources[0];
    if (!textOf(mainSource).length) {
      throw new Error(
        `「${label(mainSource)}」里一个字都没抽出来。若是扫描版 PDF（整页都是图片），需要先做 OCR；` +
          '若是 PPT，请确认每页有文本框而不是整页图片。'
      );
    }
    for (const src of sources.slice(1)) {
      if (!textOf(src).length) {
        src.dropped = true;
        log(job, 'warn', `「${label(src)}」没抽到文字（多半是扫描件），本次生成不使用它——其余材料照常`);
      }
    }

    const suspect = [...new Set(sources.flatMap((s) => (s.pages || [])
      .filter((p) => p.quality && p.quality.suspect).map((p) => p.index)))];
    if (suspect.length) {
      log(job, 'warn', `有 ${suspect.length} 页疑似抽取异常（第 ${suspect.slice(0, 12).join('、')} 页）——生成前建议在「抽取预览」里核对`);
    }
    job.extract = {
      // kind/pageCount/chars 保持同名同义（单来源时数值与从前相同）
      kind: mainSource.kind,
      pageCount: sources.reduce((n, s) => n + (s.pages || []).length, 0),
      chars: sources.reduce((n, s) => n + textOf(s).reduce((m, p) => m + p.text.length, 0), 0),
      suspect,
      bySource: sources.map((s) => ({
        id: s.id, role: s.role, label: label(s), kind: s.kind,
        pageCount: (s.pages || []).length,
        chars: textOf(s).reduce((m, p) => m + p.text.length, 0),
        dropped: !!s.dropped,
      })),
    };
    log(job, 'info', `抽取完成：${sources.length} 份来源，合计 ${job.extract.pageCount} 页 / 有效文本 ${job.extract.chars} 字，用时 ${((Date.now() - tEx) / 1000).toFixed(1)}s`);
    progress(job, 'extract', 'done', { detail: `${sources.length} 份 / ${job.extract.pageCount} 页 / ${job.extract.chars} 字` });

    /* ---- 1.5 逐来源分析（S0） ---- */
    /* 每份来源各起一次**独立**调用去理解它（"课本、课件、习题分别开代理抓取分析"）。
       隔离原则与独立审题一致：只给这一份来源的正文与角色说明，不给别的来源的结论、不给过程痕迹。
       单来源时**整段跳过**——那是老路径，为唯一的一份材料多花一次调用没有意义。 */
    const liveSources = sources.filter((s) => !s.dropped);
    const needAnalyze = sources.length > 1 && liveSources.length > 1;
    progress(job, 'analyze', needAnalyze ? 'running' : 'skipped');
    if (needAnalyze) {
      const noteCtx = { sources, options: job.options };
      await mapLimit(liveSources, job.options.concurrency || 3, async (src) => {
        try {
          const note = await askJson(job, {
            stage: 'analyze',
            what: `「${label(src)}」来源分析`,
            ctx: noteCtx,
            messages: prompts.sourceNoteMessages(noteCtx, src),
            validate: (o) => validateSourceNote(o, src, pagesOf(src)),
            provider,
            // 逐来源分析只读不写：读一份材料、说它是什么。所以它是最该交给便宜模型的一步。
            model: modelOf('analyze'),
            signal,
            maxTokens: 8000,
            rounds: 1,
          });
          src.note = trimNote(note);
          log(job, 'info', `「${label(src)}」来源分析完成`);
        } catch (e) {
          if (e && e.canceled) throw e;
          /* ⚠️ 这句必须**按角色**说，不能一句话盖过去。
             对原文权重 > 0 的来源（课件/课本/习题）：分析没了，它仍然以**原文**参与融合；
             对**真题**（`ROLE_WEIGHTS.exampaper === 0`）：它的正文按设计根本不进提示词，
             只靠分析结论里的题型规律参与 —— 所以分析一失败，这份材料就**彻底没参与**。
             以前这里对所有角色都写"它仍以原文参与"，对真题是**假话**：
             用户会以为题型规律还在用，实际一个字都没进去，而且没有任何地方会告诉他。
             （这条有机器证据：`test/sources.js` 的反例里，真题分析失败后产出的页面
               搜不到 `MARK-EXAM`，而正例能搜到。） */
          const viaText = ROLE_WEIGHTS[src.role] > 0;
          log(job, 'warn', `「${label(src)}」来源分析没能完成（${
            viaText ? '只丢这份的分析结论，它仍以原文参与' : '这份材料本次**完全没有参与**——它的正文按设计不进提示词，只靠分析结论，而分析失败了'
          }）：${((e && e.message) || e).slice(0, 140)}`);
        }
      });
      progress(job, 'analyze', 'done', { detail: `${liveSources.filter((s) => s.note).length} / ${liveSources.length} 份` });
    } else {
      log(job, 'info', '本次只有一个来源，跳过逐来源分析');
    }

    /* ---- 1.8 分章：这一次要生成哪几章 ----
       分组规则与"哪几份材料没填章号"这类校验全在 `pipeline/chapters.js`（那边有单测压着），
       这里只管"拿到章定义之后怎么跑"。**一份材料、章号留空 ⇒ 退化成唯一的一章**，
       整条路径与改造前逐字节一致（有 sha256 断言压着）。 */
    const chapters = resolveChapters(job);
    /* 每章结尾那句"最后的忠告"是**大纲的一部分**（模型按这一章的内容写的），
       但拼装契约上它是**整份页面一个**。所以在这里按章收集，收尾时取该份页面**最后一章**的
       —— 一册读到最后，那句话正好是对全册的收束。 */
    const chapterAdvice = [];
    /* 多章时告诉界面"现在跑到第几章了"。单章时给 `undefined`：进度事件的形状与从前一致。 */
    /* 「现在跑到第几章」。**每一处按章跑的进度事件都要带上它** ——
       不带的话，界面在第二章开始时只能看着计数从 `4/4` 跳回 `0/4`，
       而没有任何东西能说明"这是在跑下一章"。用户看到的就是"进度倒退了"。
       单章时返回**空对象**（不是 `{chapter:undefined}`）：事件的形状与从前逐字节一致。 */
    const chExtra = (ci) => (chapters.length > 1
      ? { chapter: { index: ci + 1, total: chapters.length, no: chapters[ci].no || '' } }
      : {});
    job.chapterList = chapters.map((c) => ({ no: c.no, title: c.title, subject: c.subject }));
    /* 这次一共生成了**哪几章**。
       ⚠️ 它与 `job.chapter`（单数，取第一章）不是一回事，两个都要有：
       历史列表里的「这一章是什么」只显示得下一个章号，而**连续性判断**必须知道全部 ——
       合订本只记第一章的话，"上次生成过 13、14，这次接 15"会被判成接不上
       （已知章号只有 13），于是那条"从头缝到尾"的提示永远不会出现。 */
    job.chapterNos = chapters.map((c) => String(c.no || '')).filter(Boolean);
    if (chapters.length > 1) {
      log(job, 'info', `本次生成 ${chapters.length} 章：`
        + chapters.map((c, i) => `第 ${c.no || i + 1} 章${c.title ? '「' + c.title + '」' : ''}`).join('、')
        + `（产出方式：${job.mode === 'separate' ? '分开生成 HTML' : '合成一册'}）`);
    }

    /* ---- 1.9 跨章关联（第 6 条） ----
       判据来自已经拿到的**逐来源分析结论**，所以这里不需要再多烧一次模型调用。
       只在"合成一册 + 至少两章"时才可能问用户；其余情形一个字都不问。 */
    const linkMode = await decideCrossChapter(job, chapters);

    /* ---- 2~4. 逐章生成（规划 → 内容 → 演示） ----
       一章一趟、**串行**。为什么不做"一次规划多章"：那样要把整个规划契约推倒重来
       （模型一次吐出 N 章的单元树），而收益只是省几次调用；串行的改动面小得多，
       而且失败隔离天然——第 13 章砸了，已经跑完的第 14 章不至于跟着一起废掉。 */
    async function buildChapter(chDef, ci) {
      // 多章时才给日志/进度加章前缀：单章时一个字的输出都不许多（有测试在比对日志）
      const chTag = chapters.length > 1 ? `第 ${chDef.no || ci + 1} 章 · ` : '';
      const chSources = chDef.sources;
      const chMain = chSources[0];

      /* ---- 2. 规划 ---- */
      progress(job, 'plan', 'running', chExtra(ci));
      const meta = {
        subject: job.options.subject || '',
        number: chDef.no || job.options.number || '',
        title: chDef.title || job.options.title
          || chMain.meta.title || path.basename(chMain.filePath, path.extname(chMain.filePath)),
      };
      /* `ctx.pages` 保留 = **这一章的主来源**的页：现有几个阶段的提示词都读它，
         保留就不必逐个改写；多来源时它们走 `sourceTextAll(ctx.sources, …)`。
         ⚠️ 多章时 `ctx.sources` 只放**这一章的**来源。放全部会怎样：第 13 章的规划
         看得见第 14 章的课件，于是两章的单元互相串、术语混着用——而页面看起来完全正常。 */
      const ctx = { meta, pages: pagesOf(chMain), sources: chSources, options: job.options };
      /* 「关联生成」（用户在这一册的两章关联大时选的）：把**前面**几章的摘要挂上去。
         只给摘要、不给它们的原文 —— 上下文要留给这一章自己的材料，而摘要本来就是
         "这份材料是什么"里信息密度最高的那一段。没选关联生成时这个字段**根本不存在**，
         于是提示词与从前逐字节一致（prompts.js 那边就是按"有没有这个字段"分支的）。 */
      if (linkMode === 'linked' && ci > 0) {
        ctx.priorChapters = chapters.slice(0, ci).map((c, k) => ({
          no: c.no || String(k + 1),
          title: c.title || '',
          summary: (c.sources || []).map((s) => (s.note && s.note.summary) || '')
            .filter(Boolean).join(' ').slice(0, 400),
        })).filter((c) => c.summary);
      }
      const outline = await askJson(job, {
        stage: 'plan',
        what: '切单元',
        ctx,
        messages: require('./prompts').planMessages(ctx),
        validate: validateOutline,
        provider,
        model,
        signal,
        maxTokens: 8000,
      });

      // 存盘键由**我们**生成：模型写的 key 一旦重复，各章的作答记录就会串在一起
      const no = meta.number || outline.chapter.no || '';
      /* 存盘键：每章必须唯一，且必须能被 assemble 的校验器接受（`/^[\w\-.]+$/`，纯 ASCII）。
         ⚠️ 以前只靠"标题 slug"做唯一性，而中文标题 slug 之后只剩一串 `-`
         （JS 的 `\w` 就是 `[A-Za-z0-9_]`，不含 CJK）：
         实测 `磁介质与磁场中的介质` → `ch13------------studio-v1`。
         后果不是"难看"，而是**串档**：章号留空时，两章只要标题字数相同就得到完全相同的 key，
         localStorage 里的作答记录互相覆盖 —— 这正是骨架注释里点名要防的那件事。
         （实测复现：`test/_audit/v5/p1.html` 的 `key:'ch13------------studio-v1'`）
         所以再缀一段**标题的短哈希**：ASCII 安全，标题不同则 key 必不同。
         英文标题仍留可读的 slug，中文标题那段为空就整个省掉，不至于变成一排破折号。 */
      const titleForKey = String(outline.chapter.title || '');
      const asciiSlug = titleForKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
      const pageKey = `${no ? 'ch' + String(no).replace(/[^\w]/g, '') + '-' : ''}`
        + `${asciiSlug ? asciiSlug + '-' : ''}${shortHash(titleForKey)}-studio-v1`;
      outline.chapter = Object.assign({}, outline.chapter, { no, subject: meta.subject || outline.chapter.subject, title: meta.title || outline.chapter.title });
      job.chapter = { no: outline.chapter.no, title: outline.chapter.title, subject: outline.chapter.subject, key: pageKey };

      // 后续几个阶段的提示词都要引用大纲（章节信息、演示归属），挂到同一个 ctx 上
      ctx.outline = outline;

      const units = (outline.units || []).slice().sort((a, b) => (a.lv || 0) - (b.lv || 0));
      // bigUnit 在契约里没有 uid（§1.2），但执行层要用它来配对题库与提示词，
      // 所以这里统一补一个 —— 契约 §1.4 规定综合大题的 bank.uid 就是 "big"。
      const bigUnit = Object.assign({}, outline.bigUnit, { isBigUnit: true, uid: outline.bigUnit.uid || 'big' });
      const allUnits = units.concat([bigUnit]);
      const planPoints = allUnits.reduce((n, u) => n + (Number(u.targetCount) || 0), 0);
      log(job, 'info', `规划完成：${units.length} 个讲解单元 + 1 个综合大题单元，目标 ${planPoints} 个作答点，${(outline.demos || []).length} 个演示`);
      progress(job, 'plan', 'done', Object.assign({ detail: `${units.length} 个单元 · ${planPoints} 个作答点` }, chExtra(ci)));

      /* ---- 3. 内容（讲解 + 题库，逐单元并行） ---- */
      progress(job, 'content', 'running', Object.assign({ total: allUnits.length, done: 0 }, chExtra(ci)));
      // `prompts` 已经在抽取那一段声明过了（那里要调 sourceNoteMessages），这里不再重复 require
      let doneCount = 0;
      const runState = {};
      const content = await mapLimit(allUnits, job.options.concurrency || CONCURRENCY_DEFAULT, async (u) => {
        if (isCanceled(job)) throw new CanceledError();
        const unitForCtx = Object.assign({}, u, { demoIds: (outline.demos || []).filter((d) => d.unitUid === u.uid).map((d) => d.id) });

        // 综合大题单元不出讲解正文（契约 §1.3），只出大题
        let prose = { html: '', blocks: 0 };
        if (!u.isBigUnit) {
          prose = await askJson(job, {
            stage: 'prose',
            what: `${u.title} 的讲解`,
            ctx,
            repairCtx: Object.assign({}, ctx, { unit: u }),
            messages: prompts.proseMessages(ctx, unitForCtx),
            validate: (o) => validateProse(o, unitForCtx),
            provider,
            model,
            signal,
            // 声明过上限就按声明**一步到位**起步；没声明时它是 null，退回 12000（与 1.3.0 一致）
            tokenPlan: mainTokenPlan,
            maxTokens: 12000,
            /* 最后一次尝试时，"拼装时会安全处理/不影响页面能用"的问题降级成警告，照常交付
               （见 KIND 那一段与 askJson 里的软化逻辑）。前面几次照旧回炉。 */
            softenLastRound: true,
          });
        }
        let bank = await askJson(job, {
          stage: 'bank',
          what: `${u.title} 的题库`,
          ctx,
          // 修复时也要告诉模型"这是哪个单元"，否则它只能从标题猜——猜错的表现是
          // 第二个单元的题被塞进第一个单元，而且页面不会有任何报错
          repairCtx: Object.assign({}, ctx, { unit: u }),
          messages: prompts.bankMessages(ctx, unitForCtx),
          validate: (o) => validateBankShape(o, u),
          provider,
          model,
          signal,
          tokenPlan: mainTokenPlan,
          maxTokens: 16000,
        });

        /* 独立审题（skill 2026-10-16 版新增的「子代理 B」在应用里的对应物）。
           门槛与 skill 保持一致：作答点少的单元不值得多花一次调用。 */
        const auditors = Number(job.options.auditors) || 0;
        if (auditors > 0 && (Number(u.targetCount) || 0) >= 8) {
          /* 审题用的是**另一个模型**（用户配了的话）：审题只读不写——它拿题库重新算一遍、
             报出可疑的题，却不负责出题。所以它是"便宜模型也能干"的典型，正是分阶段模型要省的那一步。
             而下面"按审题意见重出题库"那一轮仍然是**主模型**：那是在出题，要质量。 */
          bank = await auditBank(job, {
            unit: u, unitForCtx, ctx, bank, provider, model, signal, auditors,
            tokenPlan: mainTokenPlan,
            auditModel: stageModel.audit || model,
            auditTokenPlan: asPlanArg(planFor(stageModel.audit || model)),
          });
        }
        // 别的单元已经失败/用户已取消时，这一份刚跑完的结果**不要再写日志与进度**：
        // 界面上已经显示"任务失败"，几秒后又冒出"「U2」完成"只会让人以为出了别的问题。
        if (runState.stopped || isCanceled(job)) return { unit: u, prose, bank, stale: true };
        doneCount++;
        progress(job, 'content', 'running', Object.assign({ done: doneCount, total: allUnits.length, detail: `${doneCount}/${allUnits.length}` }, chExtra(ci)));
        log(job, 'info', `「${u.title}」完成：讲解 ${(prose.html || '').length} 字，题库 ${(bank.items || []).length} 题`);
        return { unit: u, prose, bank };
      }, runState);
      if (isCanceled(job)) throw new CanceledError();
      progress(job, 'content', 'done', Object.assign({ detail: `${allUnits.length}/${allUnits.length}` }, chExtra(ci)));

      /* ---- 4. 演示 ---- */
      const demoPlans = (outline.demos || []).filter((d) => d && d.id);
      const demos = [];
      if (demoPlans.length) {
        progress(job, 'demo', 'running', Object.assign({ total: demoPlans.length, done: 0 }, chExtra(ci)));
        let dDone = 0;
        const failed = [];
        const built = await mapLimit(demoPlans, Math.min(2, job.options.concurrency || 2), async (d) => {
          if (isCanceled(job)) throw new CanceledError();
          let o;
          try {
            o = await askJson(job, {
              stage: 'demo',
              what: `演示 ${d.id}（${d.slider}）`,
              ctx,
              messages: prompts.demoMessages(ctx, d),
              validate: (x) => validateDemo(x, d),
              provider,
              model,
              signal,
              tokenPlan: mainTokenPlan,       // 演示是最容易撞上"输出被截断"的一步
              maxTokens: 16000,
            });
          } catch (e) {
            if (e && e.canceled) throw e;
            /* **演示做不出来，不该让整单失败。**
               演示是加分项（SKILL.md 里单节迷你页的演示本来就是可选的），而它恰好是
               最容易撞上"模型输出被截断/空正文"的一步——要一次吐出一大段 markup + JS + checks。
               以前这里一失败，用户拿不到任何东西：讲解、题库、校验全都白跑了。
               现在只丢掉这一个演示，页面照常产出，并在日志里说清楚是哪个、为什么。 */
            failed.push({ id: d.id, why: (e && e.message) || String(e) });
            log(job, 'warn', `演示 ${d.id} 没能生成，已跳过（页面其余部分照常）：${((e && e.message) || e).slice(0, 200)}`);
            return null;
          }
          dDone++;
          progress(job, 'demo', 'running', Object.assign({ done: dDone, total: demoPlans.length, detail: `${dDone}/${demoPlans.length}` }, chExtra(ci)));
          return { id: d.id, title: `${d.slider} · ${d.insight || ''}`, markup: o.markup, js: o.js, checks: o.checks, sliderId: o.sliderId, viewBox: o.viewBox };
        });
        demos.push(...built.filter(Boolean));
        if (failed.length) {
          log(
            job,
            'warn',
            `有 ${failed.length} 个演示没能生成（${failed.map((f) => f.id).join('、')}），页面其余部分不受影响。` +
              '演示这一步最费模型的输出长度——换一个输出上限更大的模型、或把「演示数」调小，通常就能出。'
          );
          job.demoFailures = failed;
        }
        progress(job, 'demo', failed.length === demoPlans.length ? 'failed' : 'done', Object.assign({
          detail: failed.length ? `${built.filter(Boolean).length}/${demoPlans.length}（${failed.length} 个跳过）` : `${built.length}/${demoPlans.length}`,
        }, chExtra(ci)));
      } else {
        progress(job, 'demo', 'skipped', Object.assign({ detail: '本次不生成演示' }, chExtra(ci)));
      }

      chapterAdvice[ci] = outline.finalAdvice || '';

      /* 这一章的产物，形状就是拼装器认的那个 `chapters[]` 元素。
         以前它一整段住在主流程里；多章之后它必须**跟着章走**——
         `pageKey` / `outline` / `content` / `demos` 全是这一章自己的东西。 */
      return {
        key: pageKey,
        frozen: false,
        chapter: { subject: outline.chapter.subject, number: outline.chapter.no, title: outline.chapter.title, intro: outline.chapter.intro || '' },
        units: content.map((c) => ({
          id: c.unit.sectionId || c.unit.uid,
          num: c.unit.num || '',
          title: c.unit.title,
          qsecTitle: c.unit.qsecTitle,
          lede: c.unit.lede || '',
          lectureHtml: c.prose.html || '',
          bank: (c.bank && c.bank.items) || [],
        })),
        // 带上 unitId：占位注释没被模型写进正文时，assemble 要能把它挂到**该演示所属单元**的
        // 题区之前。以前统一挂到末尾、日志却说"最后一个单元"，位置与日志都不对。
        demos: demos.map((d) => {
          const plan = demoPlans.find((x) => x.id === d.id) || {};
          const owner = allUnits.find((u) => u.uid === plan.unitUid);
          return {
            id: d.id,
            title: d.title,
            markup: d.markup,
            js: d.js,
            /* ⚠️ `checks` 必须跟着走：demo-checks（契约 §1.5）拿它做"模型手算 vs
               页面实算"的核对。多章改造时这里漏了它，于是 page.demos 里的每一项都没有
               checks —— checkDemos 直接判"这次没有可核对的 checks"，整条演示核对**静默失效**。
               sliderId / viewBox 同理：修复轮重出演示时要用它们做字段级校验。 */
            checks: Array.isArray(d.checks) ? d.checks : [],
            sliderId: d.sliderId || '',
            viewBox: d.viewBox || '',
            unitId: owner ? owner.sectionId || owner.uid : '',
            unitTitle: owner ? owner.title : '',
          };
        }),
      };
    }

    /* 逐章跑。**串行**：第 N+1 章开始之前第 N 章已经完整跑完 —— 于是日志与进度是线性的、
       失败点明确，也不会出现两章同时在打模型（多来源时那样做是为了融合，多章没有这个必要）。 */
    const newChapters = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      newChapters.push(await buildChapter(chapters[ci], ci));
    }

    /* ---- 5. 拼装 ---- */
    // 收尾几个阶段以前完全不看取消信号：用户在"校验"那一步（最长 45s，是最宽的窗口）
    // 点了取消，日志里会同时出现"用户取消了任务"和"全部完成"，状态还是 done、文件也落了盘。
    if (isCanceled(job)) throw new CanceledError();
    /* 用户以前生成过的章（`gen:start` 载入后挂在 `job.carry` 上），**排在新的前面**。
       `frozen: true` 是给拼装器的信号：**这一章的作答点 id 一个字都不许改**——
       id 就是做题进度的存盘键，改了那一章的记录就全部对不上（而且症状是静默的串档）。 */
    const carried = (job.carry || []).map((c) => ({
      /* ⚠️ `frozen` 必须写在 **chapter 里面**：拼装器读的是 `c.chapter.frozen`（`assemble.js:534`）。
         写在条目这一层是**静默失效**——带过来的章不会被当成冻结章，它的作答点 id 会被重新命名，
         于是**那一章以前做过的题全部对不上**，而页面看起来完全正常。
         CHAPTER_MERGE_CONTRACT: frozen 在 chapter 内。 */
      /* 拼装器读的是 `chapter.number`；旁挂数据/revive 给的是 `no`。
         不补这一下的话，带过来的章在页面里会退化成"第 1 章/第 2 章"（按数组序号），
         而且不报错 —— 用户只会觉得"章号没带过来"。 */
      chapter: Object.assign({}, c.chapter, {
        number: (c.chapter && (c.chapter.number || c.chapter.no)) || '',
        frozen: true,
      }),
      units: c.units,
      demos: c.demos || [],
      key: c.key || '',
    }));

    const outDir = job.options.outputDir || path.dirname(job.filePath);
    fs.mkdirSync(outDir, { recursive: true });
    preview.allow(outDir);

    /* 这一次要写出**几份页面**：
         · `book`      —— 一份，装的是 [以前那些章…, 这次新生成的 N 章…]（N 可以是 1，就是老路径）
         · `separate`  —— 每章一份，各自独立、互不引用（用户要的就是"这周只发这一章"）
       两种模式共用下面同一段收尾代码，差别只在"这一份页面里装哪几章"。 */
    const separate = job.mode === 'separate' && chapters.length > 1;
    const pages = separate
      ? newChapters.map((c, i) => ({
        set: [c],
        tag: `第 ${chapters[i].no || i + 1} 章 · `,
        subject: c.chapter.subject,
        title: c.chapter.title,
        finalAdvice: chapterAdvice[i] || '',
        demos: c.demos || [],
      }))
      : [{
        set: [...carried, ...newChapters],
        tag: '',
        subject: newChapters[newChapters.length - 1].chapter.subject,
        title: newChapters[newChapters.length - 1].chapter.title,
        finalAdvice: chapterAdvice[chapterAdvice.length - 1] || '',
        // 修复轮与演示读数核对要按**这一份页面里实际有**的演示来，不能拿全部章的
        demos: newChapters.reduce((acc, c) => acc.concat(c.demos || []), []),
      }];

    const outputs = [];
    for (const page of pages) {
    let chapterFile = '';
    const what = page.set.length > 1 ? '这一册' : '这一章';
    progress(job, 'assemble', 'running');
    /* 册的存盘键**必须与章列表无关**：
         · 带过来的那份本身已经是册 → 用它的键（`gen:start` 放在 `job.carryBookKey`）
         · 否则用**这一份页面里第一章**的键 → 于是"再加一章"时键不变，进度一个字都不用搬
       ⚠️ 键要是随章列表变，每加一章都得把全册进度搬一次家，
       而搬家的失败模式是**完全静默的串档**（页面看着完全正常，做题记录却串到别的题上）。 */
    const isBook = page.set.length > 1;
    const bookKey = job.carryBookKey || (page.set[0] && page.set[0].key) || '';
    if (!bookKey) throw new Error('内部错误：算不出这一份页面的存盘键（章列表是空的）');
    if (isBook && carried.length) {
      log(job, 'info', `${page.tag}这一份是**一册**：${page.set.length} 章`
        + `（册的存盘键沿用「${(carried[0] && carried[0].chapter && carried[0].chapter.title) || '带过来的那一章'}」的，`
        + '这样以前做过的题在这个页面里还看得到）');
    }

    const assembleInput = {
      skeleton: getSkill()(),
      chapters: page.set,
      pageKey: bookKey,                       // 一册一个键；单章时就是这一章的键
      book: isBook ? { title: job.options.bookTitle || '', subject: page.subject } : null,
      generator: '讲练一体工作台 v' + require('../version').appVersion(),
      finalAdvice: page.finalAdvice,
      pet: job.options.pet || 'none',
    };
    let built;
    try {
      built = getAssemble()(assembleInput);
    } catch (e) {
      if (e.bankErrors) {
        e.message =
          `题库有 ${e.bankErrors.length} 处不合格，无法拼装：\n` +
          e.bankErrors.slice(0, 10).map((b) => `· [${b.unit}] ${b.message}`).join('\n') +
          (e.bankErrors.length > 10 ? `\n… 另有 ${e.bankErrors.length - 10} 处` : '');
      }
      throw e;
    }
    for (const w of built.warnings) log(job, 'warn', w);
    for (const f of built.fixes.slice(0, 30)) log(job, 'info', `自动修正：${f.unit ? '[' + f.unit + '] ' : ''}${f.message}`);
    if (built.fixes.length > 30) log(job, 'info', `另有 ${built.fixes.length - 30} 处同类自动修正未逐条列出`);

    /* ---- 6. 落盘 ---- */
    const htmlPath = path.join(outDir, isBook
      ? bookOutName(job.options.bookTitle, assembleInput.chapters, job.filePath)
      : outName(page.set[0].chapter, job.filePath));
    // 最后一道：**断言产出真的落在用户选的目录里**。净化函数哪天被人改坏、
    // 或者将来加了别的名字来源，这一句都能当场拦住"写到别处去"。
    const resolvedOut = path.resolve(outDir) + path.sep;
    if (!path.resolve(htmlPath).startsWith(resolvedOut)) {
      throw new Error(`内部错误：算出来的输出路径跑到了输出目录外面（${htmlPath}），已中止以免写错地方`);
    }
    fs.writeFileSync(htmlPath, built.html, 'utf8');
    if (!job.htmlPath) job.htmlPath = htmlPath;      // 结果页默认打开第一份
    job.htmlPaths = (job.htmlPaths || []).concat([htmlPath]);

    // 陪练：用户自备图片 → 拷到 HTML 同目录并起一个引擎认识的名字
    if ((job.options.pet || 'none') === 'image' && job.options.petImagePath) {
      try {
        const ext = path.extname(job.options.petImagePath).toLowerCase() || '.png';
        const okExt = ['.png', '.jpg', '.jpeg', '.webp'];
        if (okExt.includes(ext)) {
          const dest = path.join(outDir, 'pet' + ext);
          fs.copyFileSync(job.options.petImagePath, dest);
          log(job, 'info', `陪练图片已放到页面同目录：${path.basename(dest)}`);
        } else {
          log(job, 'warn', `陪练图片格式不支持（${ext}），请用 png/jpg/jpeg/webp；本次页面会显示内置大肥鱼`);
        }
      } catch (e) {
        log(job, 'warn', '复制陪练图片失败：' + e.message);
      }
    }

    log(job, 'info', `${page.tag}页面已写出：${htmlPath}（${(built.stats.bytes / 1024).toFixed(1)} KB，${built.stats.total} 个作答点）`);
    progress(job, 'assemble', 'done', { detail: `${(built.stats.bytes / 1024).toFixed(0)} KB · ${built.stats.total} 个作答点` });

    /* ---- 7. 校验 ---- */
    if (isCanceled(job)) throw new CanceledError();
    progress(job, 'verify', 'running');
    let report = null;
    const probes = ['verify'];
    if (built.stats.demos > 0) probes.push('demo');
    probes.push('pet');
    try {
      report = await runProbesAndChecks(htmlPath, probes,
        demosForChecks(built, page, newChapters.length), job.demoFailures, job.proseDowngrades);
      if (!job.report) job.report = attachAudit(job, report);
      const bad = (report.items || []).filter((i) => i.ok === false);
      if (bad.length) log(job, 'warn', `校验有 ${bad.length} 项没过：${bad.map((b) => b.label).join('、')}`);
      else log(job, 'info', '页内校验全部通过');
      if (report.consoleErrors && report.consoleErrors.length) {
        log(job, 'warn', `页面控制台有 ${report.consoleErrors.length} 条错误：${report.consoleErrors.slice(0, 3).join(' | ')}`);
      }
      progress(job, 'verify', 'done', { detail: bad.length ? `${bad.length} 项待修` : '全部通过' });
    } catch (e) {
      // 校验跑不起来不是致命问题——页面已经产出且可以打开。但必须说清楚，别让用户以为"验过了"。
      log(job, 'warn', '自动校验没能跑完：' + e.message + '（页面已生成，但**这一页没有被自动验证过**）');
      progress(job, 'verify', 'failed', { detail: e.message });
    }

    /* ---- 8. 修复（只修"能定位到具体单元"的问题） ---- */
    if (isCanceled(job)) throw new CanceledError();
    if (report && job.options.repairRounds > 0) {
      const fixes = await repairRound(job, { report, demos: page.demos, provider, model, signal, tokenPlan: mainTokenPlan, htmlPath, built, assembleInput, outDir });
      if (fixes) {
        progress(job, 'repair', 'running', { detail: '重出有问题的演示' });
        try {
          built = getAssemble()(assembleInput);
          fs.writeFileSync(htmlPath, built.html, 'utf8');
          if (!job.htmlPath) job.htmlPath = htmlPath;
          report = await runProbesAndChecks(htmlPath, probes,
        demosForChecks(built, page, newChapters.length), job.demoFailures, job.proseDowngrades);
          if (!job.report) job.report = attachAudit(job, report);
          const bad2 = (report.items || []).filter((i) => i.ok === false);
          progress(job, 'repair', 'done', { detail: bad2.length ? `仍有 ${bad2.length} 项没过` : '修复后全部通过' });
          log(job, bad2.length ? 'warn' : 'info', bad2.length ? `修复后仍有 ${bad2.length} 项没过` : '修复后校验全部通过');
        } catch (e) {
          progress(job, 'repair', 'failed', { detail: e.message });
          log(job, 'warn', '修复后重跑校验失败：' + e.message);
        }
      } else {
        progress(job, 'repair', 'skipped', { detail: '没有需要修复的项' });
      }
    } else {
      progress(job, 'repair', 'skipped', { detail: report ? '已关闭自动修复' : '没有校验报告' });
    }

    /* ---- 6.1 旁挂一份结构化数据（"以后能不能并进一册"全靠它）----
       ⚠️ 位置很讲究，两条：
         · 必须写在**最终产物之后**。修复轮会重拼一次（上面那段），
           要是写在初次落盘那里，演示的修正就不会进这份数据 —— 而合并时用的是它。
         · 必须写在**成功路径上**（`finish` 之前）。半途失败的任务没有页面，
           留一份数据下来是孤儿：谁都打不开，还会在历史里假装"能准确合并"。
       ⚠️ 失败**不拖垮整单**：页面照常交付。但这句警告要说清后果 ——
       用户得知道"这一章以后不能并进一册"，而不是等到那天才发现。 */
    try {
      const bk = require('../book');
      const r = bk.writeBook(htmlPath, {
        // 一册写 'book'、单章写 'chapter'：**同一个文件形状**，读取端一套代码。
        // `kind:'book'` 还有个用处——下次再带它进来时，合并页要用**册的键**（不是某一章的键），
        // 否则每加一章都得把全册进度搬一次家。
        kind: isBook ? 'book' : 'chapter',
        title: job.options.bookTitle || page.title,
        subject: page.subject,
        key: bookKey,                          // 一册一个键；单章时就是这一章的键
        /* ⚠️ 一定要用 `built.finalChapters`（拼装器**最终**那一份），不能用 `assembleInput.chapters`。
           两者差在**作答点 id**：输入里是模型给的原始 id（`u1-s1`），而页面里生效的是加了单元命名空间的
           （`s131-u1-s1`）。存错那一份的后果是**静默的**：带过来的章被冻结、id 保持原样，
           而学生原来的进度是按带命名空间的那个存的 —— 那一章的记录会全部读不出来，
           而页面看起来完全正常。（这条是实测对比"页面题库 vs 旁挂数据"抓出来的。）
           自己再算一遍命名空间是不行的：两份规则迟早走散，走散又是静默丢进度。
           所以只能由**唯一知道最终结果的那个地方**（拼装器）给出来。 */
        chapters: (built.finalChapters || []).map((fc, i) => {
          const src = page.set[i] || {};
          return {
            chapter: fc.chapter,
            key: src.key || '',
            sourceFile: src.chapter && src.chapter.frozen
              ? src.chapter.sourceFile || '(以前生成的)'
              : job.fileName || path.basename(job.filePath || ''),
            createdAt: Date.now(),
            jobId: src.chapter && src.chapter.frozen ? '' : job.id,
            units: fc.units,
            demos: fc.demos || [],
            frozen: !!(src.chapter && src.chapter.frozen),
          };
        }),
      });
      if (r && r.ok) {
        chapterFile = r.path;
        for (const w of (r.warnings || [])) log(job, 'warn', '章节数据：' + w);
      } else {
        log(job, 'warn', `${what}的结构化数据没能存下来（${(r && r.reason) || '未知原因'}）——`
          + '页面照常能用，但以后不能再把它并进一册');
      }
    } catch (e) {
      log(job, 'warn', `${what}的结构化数据没能存下来（` + ((e && e.message) || e) + '）——'
        + '页面照常能用，但以后不能再把它并进一册');
    }

    /* 结果页按这份清单逐个列出（`separate` 模式会有好几份）。
       兼容字段：`job.htmlPath` / `job.chapterFile` / `job.report` 取**第一份**的 ——
       老的结果页只读这三个，取第一份比取最后一份更符合"我这次到底生成了什么"的直觉。 */
    outputs.push({ htmlPath, chapterFile, isBook, chapters: page.set.length,
      chapter: page.set[0].chapter, report, tag: page.tag });
    }   // ← for (const page of pages)

    job.outputs = outputs;
    if (outputs.length && !job.chapterFile) job.chapterFile = outputs[0].chapterFile || '';
    job.durationMs = Date.now() - t0;
    log(job, 'info', `全部完成，用时 ${(job.durationMs / 1000).toFixed(1)}s`
      + (outputs.length > 1 ? `，共写出 ${outputs.length} 份页面` : ''));

    finish(job);
    return job;
  } catch (e) {
    if (e && e.canceled) {
      job.status = 'canceled';
      log(job, 'warn', '任务已取消');
      /* 取消也留一份日志：取消和失败同属"没跑完"，用户回头想看当时跑到哪儿了，是同一个需求。
         而且取消之后往往还会去清理文件，日志正好说明"清掉的是什么、当时发生了什么"。 */
      const p = writeRunLog(job, '被你取消了');
      if (p) log(job, 'info', '这次的日志已写在输出目录：' + path.basename(p));
      jobs.emit(job, { type: 'done', status: 'canceled' });
      jobs.saveHistory();
      return job;
    }
    /* 失败时先把日志落到输出目录，**再**调 fail —— 顺序反过来的话 fail 会先把状态改成 failed，
       而这份日志正是要记"失败在哪一步"。 */
    const lp = writeRunLog(job, '任务失败：' + ((e && e.message) || e));
    if (lp) log(job, 'info', '这次的日志已写在输出目录：' + path.basename(lp));
    fail(job, e);
    return job;
  } finally {
    job._abort = null;
  }
}

/** 审题报告的校验器：只要求结构对；**不给"必须有问题"的压力**（全对是常见结果）。 */
function validateAudit(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!Array.isArray(o.issues)) return ['缺 issues 数组（全对时写成 "issues":[]）'];
  o.issues.forEach((it, i) => {
    if (!it || typeof it !== 'object') p.push(`issues[${i}] 不是一个对象`);
    else {
      if (!it.id) p.push(`issues[${i}] 缺 id（哪道题）`);
      if (!it.detail) p.push(`issues[${i}] 缺 detail（问题是什么）`);
    }
  });
  return p;
}

/** 把题干压成一行摘要。题库里的 stem 常带 HTML 标签，报告里是纯文本，得先剥掉。 */
function stemBrief(s) {
  const t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 46 ? t.slice(0, 46) + '…' : t;
}

/**
 * **独立审题**：对应 skill 2026-10-16 版新增的「子代理 B」。
 *
 * 探针只验得了"判分逻辑对不对"，验不了"答案本身对不对"——数值题答案错一位，
 * 学生就照着错一位学。这一步补的就是这个缺口：再调一次模型，只给它题库和素材、
 * 不给任何出题过程的痕迹，让它从头独立重算。
 *
 * 三条设计取舍：
 *   · **审题失败不拖垮整单**：它是加分项，挂了就保留原题库，只记一条警告。
 *   · **只让 high 级问题触发重出**：low 是措辞建议，为它重出一遍不值当。
 *   · **最多重出 2 轮**：第二轮还报同样的 high 问题，说明两边判断不一致，
 *     再循环只会烧钱——记下来交给用户看，比假装修好了强。
 */
async function auditBank(job, o) {
  const prompts = require('./prompts');
  let bank = o.bank;
  if (!bank || !Array.isArray(bank.items) || !bank.items.length) return bank;

  /* 审题人的**人数**由用户选（0–3）。应用没有"子代理"机制，但这件事在语义上就是交叉检验：
     N 个互不可见的模型调用、各自从头独立重算。所以这里不做任何"共享上下文"的事——
     它们谁也不看谁的结论，计票在最后。
     0 = 不开（省调用，但答案对不对没人独立复核）；上限 3 是成本墙，再多边际收益很小。 */
  const N = Math.max(0, Math.min(3, Number(o.auditors) || 0));
  if (!N) return bank;

  /** 多人时要求"两个独立的人报同一题"才改；单人时当然一个人说了算。 */
  const NEED = N === 1 ? 1 : 2;

  job.audit = job.audit || { rounds: 0, auditors: N, high: 0, single: 0, low: 0, byUnit: {}, suspect: [] };

  for (let round = 0; round < 2; round++) {
    if (isCanceled(job)) throw new CanceledError();

    // N 位审题人**并行**跑（他们本来就互不依赖），一位失败只丢这一位
    const reports = await mapLimit(
      Array.from({ length: N }, (_, i) => i),
      N,
      async (i) => {
        try {
          const r = await askJson(job, {
            stage: 'bank',
            what: N > 1 ? `${o.unit.title} 的独立审题（第 ${i + 1}/${N} 位）` : `${o.unit.title} 的独立审题`,
            ctx: o.ctx,
            messages: prompts.auditMessages(o.ctx, o.unit, bank.items, { index: i + 1, total: N }),
            validate: validateAudit,
            provider: o.provider,
            // 审题人用的可能是**便宜的那个模型**（见 gen 主流程里"分阶段模型"那段）
            model: o.auditModel || o.model,
            signal: o.signal,
            tokenPlan: o.auditTokenPlan || null,
            maxTokens: 8000,
            rounds: 1,
          });
          return { ok: true, issues: Array.isArray(r.issues) ? r.issues : [] };
        } catch (e) {
          if (e && e.canceled) throw e;
          log(job, 'warn', `「${o.unit.title}」第 ${i + 1}/${N} 位审题没能完成（只丢这一位）：${((e && e.message) || e).slice(0, 140)}`);
          return { ok: false, issues: [] };
        }
      }
    );

    const okOnes = reports.filter((r) => r.ok);
    if (!okOnes.length) {
      log(job, 'warn', `「${o.unit.title}」${N} 位审题人都没能完成，题库保留原样`);
      return bank;
    }

    // 逐题计票：哪位审题人报了哪道题为 high
    /* 计票必须按**人数**，不能按**条数**。
       审计实测过一个能让整套交叉检验失效的写法：同一位审题人在一次回答里对同一道题
       给两条 high（例如同时报 wrong-answer 与 bad-why）——按条数就是两票，
       直接凑够"两人独立确认"，**一个人的误报就能改掉一个本来正确的答案**，
       而日志还会谎报"2 位审题人中至少 2 位都报了同一题"。
       所以：每位审题人内部先按 id 去重，再计入 Map。 */
    const votes = new Map();
    let lowCount = 0;
    /* 计票要**记得住是谁投的**：报告里得写清"谁怀疑"（第 i/N 位审题人）。
       所以这里不能先 filter 出 okOnes 再遍历——那样会丢掉原始序号，
       只能写出"有一个人报了"，用户拿着这句话没法判断该不该信。 */
    for (let ai = 0; ai < reports.length; ai++) {
      const r = reports[ai];
      if (!r.ok) continue;                      // 没跑完的那位不参与计票
      const seenByThisAuditor = new Set();
      for (const it of r.issues) {
        if (!it || it.severity !== 'high') {
          lowCount++;
          continue;
        }
        const k = String(it.id);
        if (seenByThisAuditor.has(k)) continue; // 同一位重复报同一题只算一票
        seenByThisAuditor.add(k);
        const v = votes.get(k) || { n: 0, samples: [], by: [] };
        v.n++;
        v.by.push(ai + 1);                      // 1 起，与日志/提示词里的"第 i 位"同一个编号
        if (v.samples.length < 3) v.samples.push(it);
        votes.set(k, v);
      }
    }

    // 题号 → 题干摘要：报告是给人看的，只丢一个 `u1-n1` 这种内部 id，用户对不上是哪道题
    const stemById = new Map();
    for (const it of (bank.items || [])) {
      if (it && it.id) stemById.set(String(it.id), it.stem || '');
    }
    const agreed = [...votes.entries()].filter(([, v]) => v.n >= NEED);
    const single = [...votes.entries()].filter(([, v]) => v.n < NEED);

    job.audit.rounds++;
    job.audit.byUnit[o.unit.title] = {
      auditors: okOnes.length,
      high: agreed.length,
      single: single.length,
      low: lowCount,
    };
    job.audit.low += lowCount;

    /* 只被少数人报出的**不改**，但也不丢：记进报告。
       理由：审题最大的风险是误报（误报会让出题人把对的改成错的），
       所以多人模式下宁可用"两个独立确认"这道门槛；而只报一次的那些，
       交给用户人工看一眼，比让模型按可疑意见改掉更稳。 */
    if (single.length) {
      job.audit.single += single.length;
      for (const [id, v] of single) {
        const x = v.samples[0] || {};
        job.audit.suspect.push({
          unit: o.unit.title,
          id,
          n: v.n,
          of: okOnes.length,
          by: v.by.slice(),          // 是哪几位审题人（1 起）——"谁怀疑"
          kind: x.kind || '',
          detail: x.detail || '',    // "怀疑什么"
          suggest: x.suggest || '',
          stem: stemBrief(stemById.get(String(id))),   // "哪一题"
        });
      }
      log(job, 'info', `「${o.unit.title}」有 ${single.length} 题只被 ${okOnes.length} 位审题人中的少数报出（${single.map(([id, v]) => `${id}×${v.n}`).join('、')}）——**没到"两人独立确认"，不改**，已记进校验报告的「有人怀疑、但没被确认的题」一节供你人工看一眼`);
    }

    if (!agreed.length) {
      log(job, 'info', `「${o.unit.title}」独立审题通过（${okOnes.length} 位审题人${lowCount ? `，另有 ${lowCount} 条非致命建议` : ''}）`);
      return bank;
    }

    job.audit.high += agreed.length;
    log(job, 'warn', `「${o.unit.title}」${agreed.length} 处**答案级**问题被独立确认` +
      `（${okOnes.length} 位审题人${NEED > 1 ? `中至少 ${NEED} 位都报了同一题` : ''}），正在按意见重出：` +
      agreed.slice(0, 3).map(([id, v]) => `第 ${id} 题 ${(v.samples[0] || {}).detail || ''}`).join('；') +
      (agreed.length > 3 ? ' …' : ''));

    try {
      bank = await askJson(job, {
        stage: 'bank',
        what: `${o.unit.title} 的题库（按审题意见重出）`,
        ctx: o.ctx,
        repairCtx: Object.assign({}, o.ctx, { unit: o.unit }),
        messages: prompts.bankMessages(o.ctx, o.unitForCtx || o.unit),
        seedProblems: agreed.map(([id, v]) => {
          const x = v.samples[0] || {};
          return `第 ${id} 题（${x.kind || '问题'}）：${x.detail || ''}${x.suggest ? ' → ' + x.suggest : ''}`;
        }),
        validate: (r) => validateBankShape(r, o.unit),
        provider: o.provider,
        // ⚠️ 这一轮**仍然用主模型**：它是在出题，不是在挑错。审题可以交给便宜模型，重出不行。
        model: o.model,
        signal: o.signal,
        tokenPlan: o.tokenPlan || null,
        maxTokens: o.maxTokens || 16000,
      });
    } catch (e) {
      if (e && e.canceled) throw e;
      log(job, 'warn', `「${o.unit.title}」按审题意见重出失败（保留上一版题库）：${((e && e.message) || e).slice(0, 160)}`);
      return bank;
    }
  }
  log(job, 'warn', `「${o.unit.title}」按审题意见重出后**仍有**答案级问题——两边判断不一致，已按模型给的版本交付，建议人工看一眼这几题`);
  return bank;
}

/**
 * 跑探针 + 演示读数核对，合成一份报告。
 *
 * 两条是**互相独立**的证据：探针看的是"页面能不能用"（判分/计数/存盘/陪练/报错），
 * demo-checks 看的是"演示的图和数自不自洽"（模型手算的公式值 vs 页面实算的读数）。
 * 任一条挂了都不该把另一条吞掉——所以这里用 allSettled 的手工版本，各自 try/catch。
 */
/**
 * 交给 demo-checks 的演示列表：**id 必须是最终 id**。
 *
 * 拼装器会给撞名的演示改名（一册里两章都从 demoA 开始 → 后一个变 demoB），
 * 而 `page.demos` 里还是模型给的 plan id。拿 plan id 去最终页面里找元素，
 * 轻则"找不到读数"，重则**核对到另一章的同名演示**。
 *
 * finalChapters 与 page.set 同序；`newCount` 是本次新生成的章数（前面的都是带过来的）。
 * 只把 final id 换上去，checks 仍取 page.demos 里的那一份。
 */
function demosForChecks(built, page, newCount) {
  const list = (page && Array.isArray(page.demos)) ? page.demos : [];
  const finals = [];
  if (built && Array.isArray(built.finalChapters) && built.finalChapters.length >= newCount) {
    for (let ci = built.finalChapters.length - newCount; ci < built.finalChapters.length; ci++) {
      const ch = built.finalChapters[ci] || {};
      for (const d of (ch.demos || [])) finals.push(d);
    }
  }
  return list.map((d, i) => Object.assign({}, d, {
    id: (finals[i] && finals[i].id) || d.id,
  }));
}

async function runProbesAndChecks(htmlPath, probes, demos, fails, proseDowngrades) {
  const report = await require('../verify/runner').runProbes({ htmlPath, probes, timeoutMs: 45000 });
  try {
    const r = await require('../verify/demo-checks').checkDemos({ htmlPath, demos: demos || [] });
    if (r && r.label) {
      report.items = (report.items || []).concat([{ key: 'demo-checks', label: r.label, raw: r.note, ok: r.ok, note: r.note }]);
      report.demoChecks = r;
    }
  } catch (e) {
    report.items = (report.items || []).concat([
      { key: 'demo-checks', label: '演示读数与公式是否自洽', raw: '核对没跑起来：' + e.message, ok: null, note: e.message },
    ]);
  }
  // 有演示没生成出来的话，报告要如实写出来——否则用户只会觉得"说好的 2 个演示呢"
  if (fails && fails.length) {
    report.items = report.items || [];
    report.items.unshift({
      key: 'demo-missing',
      label: `有 ${fails.length} 个演示没能生成`,
      raw: fails.map((f) => `${f.id}：${String(f.why).slice(0, 120)}`).join(' ｜ '),
      ok: false,
      note:
        '演示是加分项，页面其余部分不受影响。这一步最费模型的输出长度——' +
        '换个输出上限更大的模型，或把工作台里的「演示数」调到 1，通常就能出。',
    });
  }
  /* 降级交付也要如实写进报告（见 askJson 里"最后一次尝试"那段）。
     用户翻开报告时得知道："这一段的讲解在最后一次尝试时仍然带着这类问题，是我们**没再重试**
     直接交付的" —— 而不是以为它是一次就过。
     ⚠️ `ok:null` 是**第三类**结果（既不是通过也不是没通过，更不是"没测到"）：
     写成 ok:false 会被算进"没通过"、还会被 repairRound 当成"要不要重出演示"的判据，
     写成 ok:true 则是假话（它并不是校验通过的）。渲染层为这个 key 单独显示「降级交付」标签。 */
  if (proseDowngrades && proseDowngrades.length) {
    report.items = report.items || [];
    const n = proseDowngrades.reduce((s, d) => s + (d.problems || []).length, 0);
    report.items.push({
      key: 'prose-downgrade',
      label: `${proseDowngrades.length} 段讲解有 ${n} 处「拼装时会自动处理 / 不影响页面能用」的问题，未再重试（已照常交付）`,
      raw: proseDowngrades.map((d) => `${d.what}：${(d.problems || []).join('；')}`).join(' ｜ '),
      ok: null,
      note:
        '这些讲解在最后一次尝试时仍然带着这几处问题，而重试次数已经用完。它们要么会被拼装器安全处理掉' +
        '（内联事件剥掉、外链改成 #、<link>/<meta>/<form>/<iframe> 整类删掉），要么交付后也不影响页面能不能用' +
        '（例如正文里多出来的表单控件）——所以不再为它们重试，照常交付了。页面里的正文内容没有丢。' +
        '如果你不希望正文里出现这类写法，换一个更听话的模型，或把「修复轮次」调大。',
    });
    report.proseDowngrades = proseDowngrades.slice();
  }
  return report;
}

/**
 * 把独立审题的结论并进校验报告。
 *
 * ⚠️ 这一步曾经整个漏掉，症状是**信息只在日志里活着**：`auditBank` 明明把
 * "只被少数审题人报出、没到两人确认"的疑点记进了 `job.audit.suspect`，
 * 日志里也明写着"已记进校验报告供你人工看一眼"，可 `job.report` 里根本没有
 * audit 这一节，渲染层只读 `report`（全仓没有任何地方读 `job.audit`）。
 * 用户关掉日志窗口，这条**最该人看一眼**的信息就没了——而日志还告诉他去看报告。
 *
 * 注意**别**把它塞进 `report.items`：items 是探针结果，会参与"没通过 N 项"的统计，
 * 而"有人怀疑"既不是通过也不是没通过。写成失败项或写成断言，用户就会去改
 * 本来正确的答案——这正是多人投票门槛要防的事。所以单独放在 `report.audit` 里。
 */
function attachAudit(job, report) {
  if (!report) return report;      // 校验压根没跑起来时没有报告可挂（这种情况渲染层会回落读 job.audit）
  const a = job.audit;
  if (!a) return report;
  report.audit = {
    auditors: a.auditors,
    rounds: a.rounds,
    high: a.high,                  // 被"两人独立确认"、已按意见重出的处数
    single: a.single,
    low: a.low,
    suspect: (a.suspect || []).slice(),
    byUnit: a.byUnit || {},
  };
  return report;
}

function validateDemo(o, plan) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (typeof o.markup !== 'string' || !o.markup.includes(`id="${plan.id}"`)) {
    p.push(`markup 的根元素必须是 <div class="demo" id="${plan.id}">`);
  }
  if (typeof o.markup === 'string') {
    if (/<script\b|<\/script/i.test(o.markup)) p.push('markup 里不许有 script 标签');
    if (/<style\b/i.test(o.markup)) p.push('markup 里不许有 <style>（样式写在 practice.css 或行内 style 属性里）');
  }
  if (typeof o.js !== 'string' || o.js.length < 40) p.push('js 太短或不是字符串');
  else {
    // `</script` 与 `<script>` 一样致命：前者让解析器**提前闭合**引擎脚本，
    // 整页 JS 全死、残余源码变成页面上的文字，而生成端毫无察觉。
    // （assemble 的 jsForScript 会兜一层转义，这里拦下来是为了让模型改对，而不是靠兜底活着。）
    if (/<script\b/i.test(o.js)) p.push('js 里不许有 <script> 标签');
    if (/<\/script/i.test(o.js)) p.push('js 里不许出现 </script（哪怕在字符串里）——它会提前闭合页面的脚本标签');
    // 演示里的元素 id 必须带自己的前缀，否则会和别的演示/题目卡片撞名。
    // 契约 §4 允许两种前缀：`d<X>-` 或 `<本演示id>-`（提示词里就是这么写的，别把后者判成不合格）。
    const prefix = new RegExp('^(?:d[A-Z]|' + String(plan && plan.id ? plan.id : 'demo[A-Z]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')-');
    const badIds = [];
    for (const m of o.js.matchAll(/getElementById\(\s*["']([^"']+)["']/g)) {
      if (!prefix.test(m[1])) badIds.push(m[1]);
    }
    if (badIds.length) {
      p.push(`演示里取的这些 id 没有本演示的前缀（${badIds.slice(0, 4).join('、')}）——请用 \`${plan.id}-\` 开头，避免与别的演示或题卡撞名`);
    }
  }
  if (!Array.isArray(o.checks) || o.checks.length < 2) p.push('checks 至少给 2 组手算核对（不许猜）');
  return p;
}

/** 依据校验报告决定要不要重出演示；返回 true 表示改过了。 */
async function repairRound(job, ctx) {
  const { report, demos, provider, model, signal, built, assembleInput } = ctx;
  const items = report.items || [];
  const demoBad = items.find((i) => /演示|滑块|SVG/.test(i.label) && i.ok === false);
  const scriptBad = items.find((i) => /脚本错误/.test(i.label) && i.ok === false);
  if (!demoBad && !scriptBad) return false;
  if (!demos.length) return false;

  const problems = [];
  if (demoBad) problems.push(`校验探针报告：${demoBad.label} —— ${demoBad.raw || demoBad.note || '未通过'}`);
  if (scriptBad) problems.push(`页面里有脚本错误：${scriptBad.raw || ''}（很可能来自演示的 JS）`);
  problems.push('请逐条修好，并**保持 markup 里的元素 id 与 js 里取的一致**。');

  const prompts = require('./prompts');
  let changed = false;
  for (const d of demos) {
    if (isCanceled(job)) throw new CanceledError();
    try {
      // 修复时手上只有演示自己的信息（所属单元的原文不再重复喂），所以 plan 只用来做字段级校验
      const plan = { id: d.id, slider: d.title, viewBox: d.viewBox || '0 0 520 200' };
      const fixed = await askJson(job, {
        stage: 'demo',
        what: `演示 ${d.id} 的修复`,
        ctx: { outline: { units: [] }, pages: [], options: job.options },
        messages: prompts.repairMessages({ outline: { units: [] }, pages: [], options: job.options }, 'demo', problems, JSON.stringify({ id: d.id, markup: d.markup, js: d.js }), `演示 ${d.id}`),
        validate: (o) => validateDemo(o, plan),
        provider,
        model,
        signal,
        tokenPlan: ctx.tokenPlan || null,
        rounds: 1,
        maxTokens: 12000,
      });
      d.markup = fixed.markup;
      d.js = fixed.js;
      d.checks = fixed.checks;
      changed = true;
      /* ⚠️ 这里**必须**把修好的 markup/js 写回**拼装输入里那个对象**。
         以前写的是 `assembleInput.demos.find(...)` —— 而 `assembleInput` 上根本没有 `demos`
         这个字段（它只有 `chapters`），于是那一句是个 TypeError，被下面的 catch 吞成一句
         "演示 X 修复失败"；重拼用的是**没改过**的 chapters，页面上的演示一点变化都没有。
         这就是最坏的一类 bug：日志说修了、界面说修了、校验也重跑了，而**产物根本没修**。
         现在按 id 在**所有章**里找那个对象（`demos` 与 `chapters[].demos` 里是同一个引用，
         找到就直接改它；找不到说明传进来的 demos 与拼装输入不是一套，那也不该静默）。 */
      const target = (assembleInput.chapters || [])
        .reduce((acc, c) => acc.concat((c && c.demos) || []), [])
        .find((x) => x && x.id === d.id);
      if (target && target !== d) {
        target.markup = d.markup;
        target.js = d.js;
        target.checks = d.checks;
        target.sliderId = d.sliderId;
        target.viewBox = d.viewBox;
      }
      // 正文里的旧占位已经被替换过了，第二次拼装要从骨架重来——
      // 所以这里让调用方重新拼装（assembleInput 里的 lectureHtml 仍带占位注释）
      log(job, 'info', `演示 ${d.id} 已重出`);
    } catch (e) {
      log(job, 'warn', `演示 ${d.id} 修复失败：${e.message}`);
    }
  }
  return changed;
}

module.exports = {
  runGeneration, validateOutline, validateProse, validateBankShape, mapLimit, slugify,
  // 「先说好墙在哪」的唯一实现，值得单独钉住（自测直接调它，比隔着 runGeneration 好验得多）
  resolveTokenPlan, deriveOutputCap, modelForStage, modelCfgOf,
  // 用量的累加（结果页的"预估费用"靠它），单独导出便于钉住"重试那几轮也算"
  addUsage,
};

/*__ISG_BUNDLE_END__*/};
  factories["providers"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';

/**
 * 提供商预设表（架构文档 §3.2）
 * ---------------------------------------------------------------------------
 * PRESETS    -> [{ id, name, format, baseUrl, keyUrl, doc, homepage,
 *                   fullUrl, authField, userAgent, proxyHeader, proxyBody, billing,
 *                   models:[{id,name,contextLimit,maxOutput,vision?,note?}], note? }]
 * getPreset(id)
 *
 * 数据来源与置信度：
 *   每条 baseUrl 都用官方文档页面核对过（见 doc 字段）。
 *   模型 ID 照抄官方页面的拼写；官方页面没写的一律留空或用 note 标"未能确认"，
 *   不编造。厂家会改域名和模型名，所以每一项都建议用设置页的"测试连接"复核。
 *   homepage 也逐条访问核对过；**抓不到或拿不准的宁可留空，也不写一个"看起来像"的地址**
 *   —— 官网链接点开是别人的站点（或 404），比没有链接更糟。
 *   models[].contextLimit / maxOutput 一律先给 0（= 未声明）：本表的 note 里出现过
 *   "100 万 token""256k"之类**二手描述**，把它抄成数字就等于替官方声明了一个上限，
 *   而 resolveTokenPlan 会照着它去定请求的 max_tokens —— 抄错就是请求被截断，
 *   用户还看不出是自己没填过的一个数字干的。要声明让用户在设置页按官方页填。
 *   同理 vision 只标官方明确说过的，没说不标（不标的那条必须有 note 说明）。
 *
 * 1.4.0 起每家还带一组「请求整形」默认值（设置页里可改，见 DESIGN-1.4.0 §1.1）：
 *   homepage     官网（给人点的，不是 API 端点）
 *   fullUrl      true = baseUrl 本身就是完整请求地址，不再拼端点路径
 *   authField    '' = 按 format 的默认；可选 'auth_header' / 'api_key_header' / 'query'
 *   userAgent    空 = 不覆盖运行时默认
 *   proxyHeader  JSON 文本，解析后合并进请求头（用户的值赢）
 *   proxyBody    JSON 文本，解析后合并进请求体（用户的值赢，但覆盖不了 messages/stream）
 *   billing      {enabled,inputPerM,outputPerM,currency} —— 只用来算钱，不影响请求
 * ⚠️ 这些是**默认值**不是"预设限定值"：它们会被原样写进设置文件，之后一切以设置文件为准
 *   （改这里动不了老用户的配置——这正是 store.defaults() 那句"字段加在这里就等于做迁移"的另一面）。
 *
 * ⚠️ 本文件里的 `note` 是**预设的说明文案**（数据来源/置信度，给用户判断敢不敢用），
 *    跟设置文件里那个「备注」（用户自己写的，默认 ''）**不是一回事**，别合并成一个字段：
 *    说明文案删掉就再没有第二处记录"这条模型为什么算可信/哪儿未能确认"了，
 *    而且 test/llm-smoke.js 压着"没标 vision 的模型必须有 note"这条。
 *    设置里那个「备注」的默认值在 store.defaults() 里给（那边才是它该在的地方）。
 *
 * 额外字段（非契约，供 UI/接入层使用）：
 *   jsonMode  该预设是否支持 response_format:{type:'json_object'}；省略=支持
 *   local     true = 本机端点，不需要 API Key
 *   order     显示顺序
 *
 * 本文件不依赖 llm/ —— 依赖方向是单向的（llm/openai.js -> providers.js）。
 */

const PRESETS = [
  // -------------------------------------------------------------------------
  // 国内
  // -------------------------------------------------------------------------
  {
    id: 'deepseek',
    order: 10,
    name: 'DeepSeek 深度求索',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    doc: 'https://api-docs.deepseek.com/',
    homepage: 'https://www.deepseek.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextLimit: 0, maxOutput: 0, note: '官方模型页当前列出的主力模型' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextLimit: 0, maxOutput: 0, note: '官方模型页当前列出的旗舰模型' },
    ],
    note:
      '官方参数表给的 Base URL 就是不带 /v1 的裸域名（本应用会自动补 /v1，两种写法都能用）。' +
      '官方页另注明 deepseek-v4-flash / deepseek-v4-flash-vision-exp 属遗留名，仍可调用但背后已换成 V4.1-Flash。' +
      '视觉能力官方页未标注 —— 未能确认。另有 Anthropic 格式端点：https://api.deepseek.com/anthropic',
  },
  {
    id: 'deepseek-anthropic',
    order: 11,
    name: 'DeepSeek（Anthropic 格式）',
    format: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    doc: 'https://api-docs.deepseek.com/',
    homepage: 'https://www.deepseek.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextLimit: 0, maxOutput: 0, note: '与 OpenAI 格式共用同一批模型' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextLimit: 0, maxOutput: 0, note: '与 OpenAI 格式共用同一批模型' },
    ],
    note:
      '用来验证 Anthropic 协议这条链路（有些任务用 Messages 格式更省事）。' +
      '端点 = {baseUrl}/v1/messages。模型 ID 请以官方页为准。',
  },
  {
    id: 'moonshot',
    order: 12,
    name: 'Moonshot 月之暗面 · Kimi',
    format: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    doc: 'https://platform.kimi.com/docs/api/chat',
    homepage: 'https://www.moonshot.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称原生支持视觉理解，100 万 token 上下文' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称支持视觉与文本输入，256k 上下文' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextLimit: 0, maxOutput: 0, note: '编码专向，256k' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed', contextLimit: 0, maxOutput: 0, note: '上面那个的高速版' },
    ],
    note:
      '文档站已迁到 platform.kimi.com，但 API host 仍是 api.moonshot.cn，两者别混。' +
      'moonshot-v1 全系、kimi-k2、kimi-latest 等已被官方标为下线。' +
      '两个 code 变体的视觉能力官方未标注 —— 未能确认。',
  },
  {
    id: 'dashscope',
    order: 13,
    name: '阿里云百炼 · 通义千问',
    format: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    doc: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    homepage: 'https://www.aliyun.com/product/bailian',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'qwen3.8-max', name: '通义千问 3.8 Max', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen3.7-plus', name: '通义千问 3.7 Plus', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen3.8-flash', name: '通义千问 3.8 Flash', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen-long', name: '通义千问 Long', contextLimit: 0, maxOutput: 0, note: '兼容性页正文点名过的长文本模型' },
    ],
    note:
      '官方明确要求第三方客户端填的 Base URL 必须以 /compatible-mode/v1 结尾，且不要带 /chat/completions。' +
      '这里的 dashscope.aliyuncs.com 是官方标注的「旧域名，仍可用」；官方现在更推荐业务空间专属域名 ' +
      'https://{业务空间ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1（企业用户建议换成这个）。' +
      '新加坡地域换 dashscope-intl.aliyuncs.com。⚠ API Key 与地域绑定，跨地域会 401。' +
      '视觉：官方把 Qwen-VL 列为支持兼容协议的家族，但兼容页没列具体 VL 模型 ID —— 未能确认。' +
      '另有 Anthropic 格式端点：https://dashscope.aliyuncs.com/apps/anthropic',
  },
  {
    id: 'zhipu',
    order: 14,
    name: '智谱 GLM',
    format: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    doc: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    homepage: 'https://www.bigmodel.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', contextLimit: 0, maxOutput: 0, note: '旗舰，官方未标为视觉模型；1M 上下文 / 128K 输出' },
      { id: 'glm-5.2', name: 'GLM-5.2', contextLimit: 0, maxOutput: 0, note: '支持 thinking；官方未标为视觉模型' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称原生多模态，能理解图片/视频' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', contextLimit: 0, maxOutput: 0, vision: true, note: 'Flash 的更快版，同属多模态' },
      { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', contextLimit: 0, maxOutput: 0, vision: true, note: '多模态 Coding 基座' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '免费，视觉推理' },
    ],
    note:
      '官方 OpenAI 兼容页通篇用带尾斜杠的 https://open.bigmodel.cn/api/paas/v4/，' +
      '本应用存不带斜杠的写法，拼接时自己补（v4 已经含在 base 里，不会再补 /v1）。' +
      '另有 Anthropic 兼容端点 https://open.bigmodel.cn/api/anthropic（社区反映可能被 Coding Plan 门控，未在官方页确认）。',
  },
  {
    id: 'minimax',
    order: 15,
    name: 'MiniMax',
    format: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    doc: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
    homepage: 'https://www.minimax.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextLimit: 0, maxOutput: 0, vision: true, note: '支持图片/视频输入，1M 上下文' },
      { id: 'MiniMax-M3.1-Flash-Preview', name: 'MiniMax M3.1 Flash Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '官方注明暂时仅通过 M Plan 和 MiniMax Code 提供' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', contextLimit: 0, maxOutput: 0, note: '同上，速度更快' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
      { id: 'MiniMax-M2', name: 'MiniMax M2', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
    ],
    note:
      '⚠ 域名已变：现行官方文档的 API host 是 api.minimax.cn（国内）/ api.minimax.io（海外）。' +
      '老的 api.minimax.chat 和 api.minimaxi.com 在现在的官方文档里找不到作为 API 端点的证据 —— 未能确认。' +
      '另有 Anthropic 兼容端点 https://api.minimax.cn/anthropic',
  },
  {
    id: 'ark',
    order: 16,
    name: '火山方舟 · 豆包',
    format: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    doc: 'https://docs.volcengine.com/docs/ark/chat-api',
    // 方舟自己的产品页路径（/product/ark）抓取拿不到内容，不按印象写；总部站点根已核对过
    homepage: 'https://www.volcengine.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-pro-260915', name: 'Doubao Seed 2.1 Pro', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-lite-260915', name: 'Doubao Seed 2.1 Lite', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao Seed 2.1 Turbo', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
    ],
    note:
      '⚠ model 字段可能有两种填法：预置推理接入点填 Model ID（形如 doubao-seed-2-1-pro-260915），' +
      '自定义推理接入点填控制台里的 Endpoint ID（ep-xxxx）—— 「自定义接入点需填 Endpoint ID」这条' +
      '出自接入点文档页，本次未在 chat-api 页二次复核，填错会 404，遇到就换另一种试试。' +
      '官方模型列表页没有逐模型标注图片输入能力 —— 视觉未能确认。' +
      'Anthropic 协议只在 Coding Plan 下提供（https://ark.cn-beijing.volces.com/api/coding），且官方警告用错端点会额外计费。',
  },
  {
    id: 'siliconflow',
    order: 17,
    name: '硅基流动 SiliconFlow',
    format: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    doc: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    homepage: 'https://www.siliconflow.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-ai/DeepSeek-V3.1', name: 'DeepSeek V3.1', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3 32B', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'zai-org/GLM-4.5', name: 'GLM-4.5', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'Qwen/Qwen3-VL-32B-Instruct', name: 'Qwen3 VL 32B Instruct', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档里归在 VLM 组' },
    ],
    note:
      '模型 ID 是「组织/模型名」两段式，官方示例还出现过带 tier 前缀的三段式（Pro/deepseek-ai/DeepSeek-R1）。' +
      '国际站换 https://api.siliconflow.com/v1（CN 站的 key 能否通用，官方未声明 —— 未能确认）。' +
      '除显式标注的那个 VL 模型外，其余模型的视觉能力官方未逐项标注。',
  },

  // -------------------------------------------------------------------------
  // 国际
  // -------------------------------------------------------------------------
  {
    id: 'openai',
    order: 30,
    name: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    doc: 'https://developers.openai.com/api/docs',
    homepage: 'https://openai.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
    ],
    note:
      '⚠ Base URL：官方模型页没有直接写 base_url，这个值是按其官方示例里的 /v1/... 路径推导的，' +
      '不是文档原文直述 —— 未能 100% 确认（实际调用一直是这个）。' +
      'keyUrl 页面本身抓取返回 403，只有检索旁证 —— 未能确认。' +
      '新的旗舰模型可能只吃 max_completion_tokens 而不是 max_tokens，接入层遇到这个 400 会自动改名重试。',
  },
  {
    id: 'anthropic',
    order: 31,
    name: 'Anthropic Claude',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://platform.claude.com/settings/keys',
    doc: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    homepage: 'https://www.anthropic.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '当前 Opus，综合最稳，推荐默认' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '速度与能力平衡，日常主力' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '最便宜，适合测试连接/轻任务' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextLimit: 0, maxOutput: 0, vision: true, note: '最强的公开模型，价格也最高' },
    ],
    note:
      '端点 = {baseUrl}/v1/messages，必须带 anthropic-version: 2023-06-01（本应用自动带）。' +
      'system 是顶层字段；max_tokens 必填（接入层会给兜底值）。' +
      '官方文档现在把 Authorization: Bearer 列为主要的认证头，x-api-key 是仍被支持的 legacy fallback —— ' +
      '本应用对官方域名发 x-api-key（文档明确still supported），对第三方 Anthropic 兼容网关两个都发。' +
      '这些 ID 都是固定快照，不要自己加日期后缀。新版模型可能拒答（stop_reason=refusal），接入层会直接报错而不是给你空结果。',
  },
  {
    id: 'openrouter',
    order: 32,
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    doc: 'https://openrouter.ai/docs/quickstart',
    homepage: 'https://openrouter.ai',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: '~anthropic/claude-sonnet-latest', name: 'Claude Sonnet（latest 别名）', contextLimit: 0, maxOutput: 0, note: '官方快速开始页给的 ~ 别名形式' },
      { id: '~openai/gpt-sol-latest', name: 'OpenAI GPT Sol（latest 别名）', contextLimit: 0, maxOutput: 0, note: '官方快速开始页给的 ~ 别名形式' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', contextLimit: 0, maxOutput: 0, note: 'API 参考页示例 slug' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', contextLimit: 0, maxOutput: 0, note: 'API 参考页示例 slug' },
    ],
    note:
      'model 必须带组织前缀（org/slug），上游模型更新很快，这里的 slug 只是示例 —— ' +
      '强烈建议点"测试连接"拉一次实时列表再选。视觉能力未逐项标注 —— 未能确认。',
  },
  {
    id: 'gemini',
    order: 33,
    name: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyUrl: 'https://aistudio.google.com/apikey',
    doc: 'https://ai.google.dev/gemini-api/docs/openai',
    // 没有面向 Gemini API 的独立"官网"，官方给开发者的入口就是 ai.google.dev（已核对可访问）
    homepage: 'https://ai.google.dev',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '官方 OpenAI 兼容页示例用的模型' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档对照表中出现' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档对照表中出现' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '预览版' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '预览版' },
    ],
    note:
      '⚠ 必须带 /v1beta/openai 这一段，否则不是 OpenAI 协议（本应用会原样保留这段，不会再补 /v1）。' +
      '没有官方 Anthropic 兼容端点 —— 未能确认存在。' +
      '逐模型的 vision 标记官方没写，官方只说所有 Gemini 模型都是多模态，这里按 true 处理。' +
      'gemini-2.0-* 与 gemini-3-pro-preview 已 shut down，gemini-2.5-* 只对老用户开放，都没放进来。',
  },

  // -------------------------------------------------------------------------
  // 本机
  // -------------------------------------------------------------------------
  {
    id: 'ollama',
    order: 50,
    name: 'Ollama（本机）',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    doc: 'https://docs.ollama.com/api/openai-compatibility',
    homepage: 'https://ollama.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    local: true,
    jsonMode: false,
    models: [
      { id: 'qwen3:8b', name: 'Qwen3 8B', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull；ID 以你本地已拉的为准' },
      { id: 'qwen3-vl:8b', name: 'Qwen3 VL 8B', contextLimit: 0, maxOutput: 0, vision: true, note: '官方兼容页的 vision 示例模型' },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull' },
      { id: 'llama3.2', name: 'Llama 3.2', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull' },
    ],
    note:
      '本机端点，不需要 API Key（随便填或留空都行）。' +
      '官方明确前缀要带 /v1（裸 :11434 不行）。' +
      '模型 ID 取决于你本地已 pull 的东西，建议点"测试连接"拉实时列表。' +
      '默认不发 response_format（Ollama 对它的支持随版本变动）。',
  },
  {
    id: 'lmstudio',
    order: 51,
    name: 'LM Studio（本机）',
    format: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    keyUrl: '',
    doc: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    homepage: 'https://lmstudio.ai',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    local: true,
    jsonMode: false,
    models: [],
    note:
      '本机端点，不需要 API Key。官方文档刻意不给具体模型 ID（示例里写的是 ' +
      '"use the model identifier from LM Studio here"）—— 未能确认列表，' +
      '请加载好模型后点"测试连接"，从 /v1/models 拉取真实 ID 再填。',
  },

  // -------------------------------------------------------------------------
  // 兜底
  // -------------------------------------------------------------------------
  {
    id: 'custom',
    order: 99,
    name: '自定义 / 中转网关',
    format: 'openai',
    baseUrl: '',
    keyUrl: '',
    doc: '',
    // 自建/中转网关没有固定的官网 —— 留空。这里**绝不**填一个"看起来像"的地址：
    // 用户会点开它，然后得到一个跟这个应用毫无关系的站点。
    homepage: '',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [],
    note:
      '填任意 OpenAI 兼容或 Anthropic 兼容的 Base URL。可以只填域名（如 api.example.com），' +
      '接入层会自动补协议和 /v1；也可以整段粘贴完整的 chat/completions 地址，同样能识别。' +
      '模型 ID 请用"测试连接"从 /v1/models 拉取。',
  },
];

/** id -> preset */
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/**
 * 按 id 取预设。取不到返回 undefined（上游要自己决定怎么提示，
 * 不要在这里悄悄回退成 custom —— 那会让用户以为配置生效了）。
 */
function getPreset(id) {
  if (typeof id !== 'string') return undefined;
  return BY_ID.get(id.trim());
}

module.exports = { PRESETS, getPreset };

/*__ISG_BUNDLE_END__*/};
  factories["llm-openai"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';

/**
 * OpenAI 兼容协议适配器。
 * ---------------------------------------------------------------------------
 * 只做"协议翻译"：URL 归一化 / 请求头 / 请求体 / 流事件 / 响应解析 / 参数降级表。
 * HTTP、超时、重试、SSE 分帧都在 index.js 里，本文件不碰网络。
 *
 * 导出 joinUrl() / normalizeBase() 是本文件独有的（Anthropic 适配器也复用），
 * 因为它是"用户粘贴的 Base URL 千奇百怪"这件事的唯一收敛点。
 */

const { getPreset } = require('../providers');

const CHAT_PATH = 'chat/completions';
const MODELS_PATH = 'models';

/** 形如 v1 / v1beta / v2 / v3 / v4 的版本段 */
const VERSION_SEGMENT = /^v\d+[a-z0-9]*$/i;
/** 不带版本号、但也算"已经到端点根"的尾段 */
const VERSIONLESS_TAILS = new Set(['beta']);
/** 用户可能整段粘贴进来的端点后缀（长的排前面，先剥长的） */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/models'];

/** 本机端点不需要 Authorization */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Key 的位置（设置页的 authField）。只认这三个，其余一律当"没选"。
 * 为什么不能"认不得就当 query/当裸头"：这三个值决定的是**鉴权往哪儿发**，
 * 一个拼错的枚举如果被当成"没有鉴权方式"，请求就会带着 401 回来，
 * 而用户看到的配置页上明明勾着一个选项 —— 排查方向会被彻底带偏。
 */
const AUTH_FIELDS = new Set(['auth_header', 'api_key_header', 'query']);

/**
 * proxyBody 里**不许**被用户改掉的两把钥匙。详见 applyProxyBody 的注释。
 * 这里是唯一一处"用户的值不赢"的地方，所以单独提出来当常量，改它必须改注释。
 */
const PROTECTED_BODY_KEYS = ['messages', 'stream'];

// ---------------------------------------------------------------------------
// Base URL 归一化
// ---------------------------------------------------------------------------

/**
 * 把用户随手填的 Base URL 收敛成"版本根"，例如：
 *   https://api.deepseek.com                       -> https://api.deepseek.com/v1
 *   https://api.deepseek.com/v1/chat/completions    -> https://api.deepseek.com/v1
 *   https://open.bigmodel.cn/api/paas/v4            -> 原样（已有 v4）
 *   https://generativelanguage.googleapis.com/v1beta/openai/  -> 原样（已有 v1beta）
 *   localhost:11434                                 -> http://localhost:11434/v1
 * 规则：只在"整条路径里没有版本段"且"尾段不是 beta"时才补 /v1。
 */
function normalizeBase(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) throw new Error('Base URL 为空');
  s = s.replace(/\s+/g, '');

  // 只填了域名/主机时补协议；本机默认 http，其余默认 https
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = (LOCAL_HOST.test(s) ? 'http://' : 'https://') + s;
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`Base URL 协议不支持（只支持 http/https）：${s}`);
  }

  s = s.replace(/[?#].*$/, ''); // 丢 query / hash
  s = s.replace(/\/+$/, ''); // 丢尾斜杠

  // 整段粘贴了完整端点时剥掉
  const lower = s.toLowerCase();
  for (const suf of ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length).replace(/\/+$/, '');
      break;
    }
  }

  const path = s.replace(/^https?:\/\/[^/]+/i, '');
  const segs = path.split('/').filter(Boolean);
  const hasVersion = segs.some((seg) => VERSION_SEGMENT.test(seg));
  const last = (segs[segs.length - 1] || '').toLowerCase();
  if (!hasVersion && !VERSIONLESS_TAILS.has(last)) s += '/v1';

  return s;
}

/** normalizeBase + 拼一段路径，保证中间只有一个斜杠 */
function joinUrl(baseUrl, path = CHAT_PATH) {
  const base = normalizeBase(baseUrl);
  const tail = String(path == null ? '' : path).replace(/^\/+/, '').replace(/\/+$/, '');
  return tail ? `${base}/${tail}` : base;
}

/**
 * `fullUrl:true` 时 baseUrl **本身就是**请求地址：不拼端点、不补 /v1、不剥掉路径里的
 * `/chat/completions`（有些中转的地址就长这样，剥掉之后没有东西拼回来，端点是空的）。
 *
 * 只做两件"不做就直接不能用"的清理：
 *   ① 去掉粘贴时带进来的空白/换行 —— 从文档里复制地址常会夹进空格，
 *      而 fetch 遇到这种 URL 抛的是 `ERR_UNESCAPED_CHARACTERS`，和"地址写错了"长得一模一样，
 *      用户根本查不出是空格；normalizeBase 也是这么做的，这里保持一致。
 *   ② 没有协议时补一个（本机默认 http，其余 https）—— 缺协议 fetch 直接失败。
 *
 * ⚠️ 这里**不**丢 query：中转常把参数写在地址上，而 authField:'query' 还要继续往上追加 key。
 */
function normalizeFullUrl(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) throw new Error('Base URL 为空');
  s = s.replace(/\s+/g, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = (LOCAL_HOST.test(s) ? 'http://' : 'https://') + s;
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`Base URL 协议不支持（只支持 http/https）：${s}`);
  }
  return s;
}

/**
 * 端点地址。`opts.fullUrl` 由 provider 透传（协议无关，两个适配器共用）。
 * 第二个参数是**可选的**：llm-smoke / request-shape 那几套按老签名直接传字符串，
 * 只给路径不认 fullUrl，行为必须与从前逐字节一致。
 */
function endpointUrl(baseUrl, path, opts = {}) {
  if (opts && opts.fullUrl === true) return normalizeFullUrl(baseUrl);
  return joinUrl(baseUrl, path);
}

function chatUrl(baseUrl, opts) {
  return endpointUrl(baseUrl, CHAT_PATH, opts);
}

function modelsUrl(baseUrl, opts) {
  return endpointUrl(baseUrl, MODELS_PATH, opts);
}

/** 认得的 authField，认不得的返回 ''（= 按该格式的默认走） */
function resolveAuthField(provider) {
  const v = provider && provider.authField;
  return AUTH_FIELDS.has(v) ? v : '';
}

/**
 * authField:'query' —— 一部分中转只认 `?key=xxx`（Key 根本不在头里）。
 *
 * 为什么单独一个函数：它改的是 **URL**，而 URL 是 index.js 决定、适配器拼的；
 * 想把它塞进 buildHeaders 是做不到的（头里放不下 URL）。也因此这个 URL 之后
 * **任何**要进日志/错误的地方都必须先洗一遍 —— 见 index.js 里的 safeUrl。
 */
function withQueryAuth(url, provider) {
  const key = provider && provider.apiKey;
  if (!key || resolveAuthField(provider) !== 'query') return url;
  const u = String(url);
  // 地址自带的 query 不能覆盖：用 & 接上去；末尾已经是 ? / & 时不再补分隔符
  const sep = /[?&]$/.test(u) ? '' : u.includes('?') ? '&' : '?';
  return `${u}${sep}key=${encodeURIComponent(key)}`;
}

/**
 * 大小写不敏感地写一个请求头。
 *
 * 为什么不能直接 `headers[k] = v`：HTTP 头名**不区分大小写**，于是用户写
 * `authorization` 而我们已放了 `Authorization` 时，对象里会同时留下两个键，
 * undici 会把它们合并成 `Bearer 我的, Bearer 你的` 发出去 —— 表面上看"用户覆盖了
 * Authorization"，实际发的是两个值拼在一起，服务端按坏凭据处理。
 * 这类错只有抓包才看得出来（界面上、响应里都只是"鉴权失败"）。
 */
function setHeader(headers, name, value) {
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
  headers[name] = value;
}

/**
 * 解析设置页里那两段 JSON 文本（proxyHeader / proxyBody）。
 *
 * 解析失败**绝不抛**：这两段是"锦上添花"的覆盖项，为了它把整个生成任务打死不值得，
 * 上层应当降级成"没配"并留一条人话警告（testConnection 那条路也一样）。
 *
 * ⚠️ 返回的 error **不含原始文本**、也不含 JSON.parse 的原话：
 * Node 的解析错误会把出错的那一小段原文回显出来
 * （`Unexpected token 'B', "Bearer sk-…" is not valid JSON`），
 * 而这两段恰恰是用户最容易粘 Key 进去的地方 —— 那等于把 Key 写进日志。
 */
function parseJsonOverride(raw, label) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: true, value: null };
  let value;
  try {
    value = JSON.parse(s);
  } catch {
    return { ok: false, value: null, error: `${label} 不是合法 JSON，本次已忽略这一项覆盖` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, error: `${label} 必须是一个 JSON 对象，本次已忽略这一项覆盖` };
  }
  return { ok: true, value };
}

/**
 * 把 proxyHeader（JSON 文本）与 userAgent 落到请求头上。
 *
 * 顺序就是"谁说了算"：我们的默认 → provider.headers → proxyHeader → userAgent。
 *   · proxyHeader 排在 Authorization 之后 —— 用户**可以**用它换掉整条鉴权头（有些网关要
 *     `Authorization: Basic …` 或自家签名），这是这个功能存在的意义；
 *   · userAgent 排在最后：它比"一大包头"更具体，两个地方都写了 User-Agent 时以那个输入框为准。
 * warn(text) 由上层给（chat 收进 degraded、testConnection 收进连接失败的说明）。
 */
function applyHeaderOverrides(headers, provider, warn) {
  const raw = provider && provider.proxyHeader;
  if (raw && String(raw).trim()) {
    const got = parseJsonOverride(raw, 'proxyHeader');
    if (!got.ok) {
      if (typeof warn === 'function') warn('proxyHeader', got.error);
    } else if (got.value) {
      for (const [k, v] of Object.entries(got.value)) {
        /* 只收标量：JSON 里塞个对象/数组进来，undici 会把头值写成 "[object Object]"，
           请求照发、头是坏的，而界面上什么都看不出来。 */
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          setHeader(headers, k, String(v));
        }
      }
    }
  }
  const ua = provider && provider.userAgent;
  if (ua && String(ua).trim()) setHeader(headers, 'User-Agent', String(ua).trim());
  return headers;
}

/**
 * 把 proxyBody（JSON 文本）合并进请求体。
 *
 * 顺序：我们的默认在前、用户在后 —— 用户赢（temperature / top_p / 各家私有字段
 * 如 `X-Provider` 都能改，这正是这个功能的用途）。
 *
 * 例外只有两样，合并完**必须还原回我们的值**：
 *   · `messages` —— 对话内容是应用拼出来的。让一段配置改写它，等于设置页在背后
 *     换掉用户要问的问题，而日志里显示的提示词还是对的 —— 出了事根本查不出来。
 *   · `stream`   —— 这个标志必须与 index.js 里"按哪条路解析响应"的判断一致：
 *     流式解析器遇到整包 JSON 会一直等到超时，非流式解析器遇到 SSE 只会拿到一段
 *     解析不了的文本。用户配错时的症状是"模型一直没反应"或"响应不是合法 JSON"，
 *     跟这个开关的联系一点都看不出来。
 */
function applyProxyBody(body, provider, warn) {
  const raw = provider && provider.proxyBody;
  if (!raw || !String(raw).trim()) return body;
  const got = parseJsonOverride(raw, 'proxyBody');
  if (!got.ok) {
    if (typeof warn === 'function') warn('proxyBody', got.error);
    return body;
  }
  const merged = { ...body, ...got.value };
  for (const key of PROTECTED_BODY_KEYS) {
    // 用 hasOwnProperty 而不是 `body[key]` 判断：我们**没有**这个字段时，
    // 用户也不能凭空加上（例如非流式请求里塞 stream:true）
    if (Object.prototype.hasOwnProperty.call(body, key)) merged[key] = body[key];
    else delete merged[key];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

function buildHeaders(provider, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
  };
  // 只要用户配了 key 就带上。本机端点(Ollama/LM Studio)不**要求** key，
  // 但用户要是填了（比如指向带鉴权的本地网关），那就该发出去。
  const key = provider && provider.apiKey;
  const field = resolveAuthField(provider);
  /* authField='query' 时这里**一个鉴权头都不发**：Key 已经在 URL 上了（见 withQueryAuth）。
     两个地方都发的话，那些"只认查询串"的中转会把多出来的头当成坏凭据直接拒绝 ——
     这是设置页里那个选项唯一的作用，必须真的生效。 */
  if (key && field !== 'query') {
    // '' / 'auth_header' / 认不得的值 ⇒ 该格式的默认（Bearer）
    if (field === 'api_key_header') setHeader(headers, 'api-key', key);
    else headers.Authorization = `Bearer ${key}`;
  }
  // 少数网关要额外头（如 OpenRouter 的 HTTP-Referer / X-Title）
  if (provider && provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  // proxyHeader / userAgent 永远压在上面所有来源之上（用户的值赢）
  return applyHeaderOverrides(headers, provider, opts.warn);
}

/**
 * @param {object} o
 * @param {string} o.model
 * @param {Array}  o.messages  已由 normalizeMessages 处理（system 已并入）
 * @param {string} o.system    已并入 messages，此处置空
 */
function buildBody(o) {
  const body = {
    model: o.model,
    messages: o.messages,
  };
  if (Number.isFinite(o.temperature)) body.temperature = o.temperature;
  if (Number.isFinite(o.maxTokens)) body.max_tokens = o.maxTokens;
  if (o.stream) {
    body.stream = true;
    // 流式默认不回 usage，要显式要；不支持该字段的端点会在 400 时被降级掉
    body.stream_options = { include_usage: true };
  }
  if (o.json) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * 归一化消息：校验角色、丢弃空内容、把 system 提到最前。
 * OpenAI 允许连续同角色，所以只做最基本处理。
 */
function normalizeMessages({ system, messages }) {
  const out = [];
  const sys = typeof system === 'string' ? system.trim() : '';
  if (sys) out.push({ role: 'system', content: sys });
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const content = contentToText(m.content);
    if (!content.trim()) continue; // 只有空白的消息是噪声，丢掉
    out.push({ role, content });
  }
  return { system: null, messages: out };
}

/** 内容可能是 string，也可能是 [{type:'text',text}] 片段数组 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

function defaultProbeModel() {
  return 'gpt-4o-mini';
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/**
 * 解析一条流事件的载荷。返回 null 表示这条事件与正文无关。
 * -> { delta?, reasoning?, usage?:{in?,out?}, finishReason? }
 */
function parseStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  if (obj.usage && typeof obj.usage === 'object') {
    out.usage = {
      in: num(obj.usage.prompt_tokens, obj.usage.input_tokens),
      out: num(obj.usage.completion_tokens, obj.usage.output_tokens),
    };
  }
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice && typeof choice === 'object') {
    const d = choice.delta || choice.message || {};
    const text = contentToText(d.content);
    if (text) out.delta = text;
    // DeepSeek-R1 一类的思维链字段：不并进正文，单独给上层
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      out.reasoning = d.reasoning_content;
    }
    const fr = choice.finish_reason || choice.stop_reason;
    if (fr) out.finishReason = fr;
  }
  return Object.keys(out).length ? out : null;
}

/** 200 的流里内嵌错误（有些网关这么干） */
function streamError(obj) {
  if (obj && typeof obj === 'object' && obj.error) {
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.error.message === 'string') return obj.error.message;
    try {
      return JSON.stringify(obj.error);
    } catch {
      return '未知错误';
    }
  }
  return null;
}

function parseResponse(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) {
    // 少数端点直接回 {content: '...'}
    const loose = contentToText(data && data.content);
    return {
      text: loose,
      usage: { in: undefined, out: undefined },
      finishReason: data && data.stop_reason,
    };
  }
  const msg = choice.message || {};
  return {
    text: contentToText(msg.content),
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
    usage: {
      in: num(data && data.usage && data.usage.prompt_tokens, data && data.usage && data.usage.input_tokens),
      out: num(data && data.usage && data.usage.completion_tokens, data && data.usage && data.usage.output_tokens),
    },
    finishReason: choice.finish_reason || choice.stop_reason,
  };
}

/** GET /models 的形状五花八门，全兜一遍 */
function parseModels(data) {
  const pick = (arr) =>
    arr
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model)))
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
  if (Array.isArray(data)) return pick(data);
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data)) return pick(data.data);
  if (Array.isArray(data.models)) return pick(data.models);
  if (data.data && Array.isArray(data.data.models)) return pick(data.data.models);
  return [];
}

function num(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON 模式
// ---------------------------------------------------------------------------

/**
 * 该 provider 是否支持 `response_format: {type:'json_object'}`。
 *
 * 优先级（任何"不支持"的证据都压过"支持"）：
 *   1. 预设表里写死 jsonMode:false（如 Ollama / LM Studio）
 *   2. provider 上显式 supportsJsonMode:false（用户在设置页关掉）
 *   3. 运行时黑名单 —— 这个 base+model 刚刚因为 response_format 被 400 过（经验事实最硬）
 *   4. provider 上显式 supportsJsonMode:true
 *   5. 预设表里写死 jsonMode:true
 *   6. 本机端点默认不发
 *   7. 其余默认发
 *
 * 第 7 条默认"发"是安全的：真不支持时 400 会自动降级（见 degradations），
 * 并把这条经验记进黑名单，后续同一个 base+model 的调用不会再白撞一次。
 */
function supportsJsonMode(provider = {}, model = '') {
  const preset = provider && provider.id ? getPreset(provider.id) : null;
  if (preset && preset.jsonMode === false) return false;
  if (provider && provider.supportsJsonMode === false) return false;
  if (isJsonModeBlocked(provider, model)) return false;
  if (provider && provider.supportsJsonMode === true) return true;
  if (preset && preset.jsonMode === true) return true;
  const base = String((provider && provider.baseUrl) || '');
  if (LOCAL_HOST.test(base.replace(/^https?:\/\//i, ''))) return false; // Ollama / LM Studio
  return true;
}

/** 运行时记住"这个端点不吃 response_format"，避免每次调用都先撞一次 400 */
const jsonModeBlocklist = new Set();

function jsonModeKey(provider, model) {
  let base = '';
  try {
    /* fullUrl 时不能走 normalizeBase：它会剥掉端点后缀再补 /v1，于是
       `https://gw/a/chat/completions` 和 `https://gw/v1` 会算出同一个键 ——
       一个端点因为 response_format 被 400 之后，另一个也被连坐拉黑，
       而后者的用户只会看到"我的 JSON 模式莫名其妙不发了"。 */
    base =
      provider && provider.fullUrl === true
        ? String((provider && provider.baseUrl) || '').trim()
        : normalizeBase(provider && provider.baseUrl);
  } catch {
    base = String((provider && provider.baseUrl) || '');
  }
  return `${base}|${model || ''}`;
}

function isJsonModeBlocked(provider, model = '') {
  return jsonModeBlocklist.has(jsonModeKey(provider, model));
}

function blockJsonMode(provider, model = '') {
  jsonModeBlocklist.add(jsonModeKey(provider, model));
}

// ---------------------------------------------------------------------------
// 400 参数降级表
// ---------------------------------------------------------------------------

/**
 * 只在 HTTP 400 且 providerMessage 点到某个已知字段时才降级，每个字段只降一次。
 * 国内兼容端点最常见的三种"字段不认识"：
 */
const degradations = [
  {
    field: 'response_format',
    test: (msg, body) => !!body.response_format && /response_format|json_object|response format/i.test(msg),
    label: '去掉 response_format（该端点不支持 JSON 模式，改用提示词约束）',
    fix: (body) => {
      const next = { ...body };
      delete next.response_format;
      return next;
    },
    onDegraded: (provider, model) => blockJsonMode(provider, model),
  },
  {
    field: 'stream_options',
    test: (msg, body) => !!body.stream_options && /stream_options|stream options|include_usage/i.test(msg),
    label: '去掉 stream_options（该端点不支持流式用量统计，usage 将不准确）',
    fix: (body) => {
      const next = { ...body };
      delete next.stream_options;
      return next;
    },
  },
  {
    field: 'max_tokens',
    test: (msg, body) => Number.isFinite(body.max_tokens) && /max_completion_tokens/i.test(msg),
    label: '改用 max_completion_tokens（该模型不再接受 max_tokens）',
    fix: (body) => {
      const next = { ...body };
      next.max_completion_tokens = next.max_tokens;
      delete next.max_tokens;
      return next;
    },
  },
  {
    /* 「这个模型最多支持 N 个输出 token」——必须能降下来，否则整条链路会卡死：
       流水线给 bank 阶段 16000，而只支持 8192 的模型会 400；更糟的是
       `explainEmptyText` 在"空正文"时会把上限抬到 64000，下一轮**必然** 400。
       以前没有这条降级，症状是任务彻底失败，而报错只有厂商原文、没有"我帮你降了"。 */
    field: 'max_tokens_too_large',
    test: (msg, body) =>
      Number.isFinite(body.max_tokens) &&
      /(max_?tokens?|completion tokens).{0,60}?(too large|exceed|at most|max(imum)?\s*(is|of)?\s*\d|大于|超过|上限)/i.test(msg),
    label: '把输出上限降到该模型允许的值',
    fix: (body, msg) => {
      const nums = String(msg || '').match(/\d{3,6}/g) || [];
      const caps = nums.map(Number).filter((n) => n >= 256 && n < body.max_tokens).sort((a, b) => b - a);
      const next = { ...body };
      next.max_tokens = caps.length ? caps[0] : Math.min(body.max_tokens, 4096);
      return next;
    },
  },
];

module.exports = {
  format: 'openai',
  chatUrl,
  modelsUrl,
  normalizeBase,
  normalizeFullUrl,
  endpointUrl,
  joinUrl,
  /* 下面这组是"请求装饰"，与协议无关，anthropic.js 直接复用（它已经有 openai 依赖）：
     两处各写一份的下场是"其中一处忘了改"——这个仓库栽过好几次。 */
  resolveAuthField,
  withQueryAuth,
  applyHeaderOverrides,
  applyProxyBody,
  setHeader,
  parseJsonOverride,
  buildHeaders,
  buildBody,
  normalizeMessages,
  parseStreamEvent,
  streamError,
  parseResponse,
  parseModels,
  defaultProbeModel,
  supportsJsonMode,
  isJsonModeBlocked,
  blockJsonMode,
  jsonModeBlocklist,
  degradations,
  isLocalBase: (baseUrl) => LOCAL_HOST.test(String(baseUrl || '').replace(/^https?:\/\//i, '')),
};

/*__ISG_BUNDLE_END__*/};
  factories["llm-anthropic"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';

/**
 * Anthropic（Messages API）协议适配器。
 * ---------------------------------------------------------------------------
 * 与 openai.js 同形，由 index.js 统一驱动。
 *
 * 与 OpenAI 的关键差异：
 *   - 端点是 POST {base}/v1/messages
 *   - 认证头是 x-api-key（不是 Authorization: Bearer）；第三方 Anthropic 兼容网关
 *     两种都认，所以非官方域名会同时带上 Bearer（见 authStyle）
 *   - system 是**顶层字段**，不是 messages 里的一条
 *   - max_tokens **必填**
 *   - 必须带 anthropic-version: 2023-06-01
 *   - 不支持 response_format，JSON 只能靠提示词约束
 *   - 流式增量在 content_block_delta 事件的 delta.text
 *
 * 依赖方向： anthropic.js -> openai.js（只用它的 normalizeBase/joinUrl 字符串工具）
 */

const openai = require('./openai');

const CHAT_PATH = 'messages';
/** 官方要求必带的版本头 */
const API_VERSION = '2023-06-01';
/** max_tokens 必填，调用方没给时的兜底 */
const DEFAULT_MAX_TOKENS = 4096;
/** Anthropic 的采样温度上限是 1 */
const MAX_TEMPERATURE = 1;
/** 官方域名：只走 x-api-key，避免同时带 Bearer 被拒 */
const OFFICIAL_HOST = /(^|\.)anthropic\.com$/i;

function chatUrl(baseUrl, opts) {
  // fullUrl 的处理与 openai 完全同一段代码（见 openai.endpointUrl）：
  // 两边各写一份的话，迟早有一边漏了 fullUrl，而症状是"只有某一家中转不行"
  return openai.endpointUrl(baseUrl, CHAT_PATH, opts);
}

/** Anthropic 格式没有单独的 models 探测需求，testConnection 直接打 messages */
function modelsUrl() {
  return null;
}

function isOfficialHost(baseUrl) {
  try {
    const host = new URL(openai.normalizeBase(baseUrl)).hostname;
    return OFFICIAL_HOST.test(host);
  } catch {
    return false;
  }
}

/**
 * 认证方式（**只在用户没显式指定 authField 时才算数**）：
 *   'x-api-key'  只发 x-api-key（官方域名默认）
 *   'bearer'     只发 Authorization: Bearer（某些只认 OpenAI 风格头的网关）
 *   'both'       两个都发（第三方 Anthropic 兼容网关的默认，最大化兼容）
 * 可用 provider.authStyle 显式覆盖。
 */
function resolveAuthStyle(provider) {
  const want = provider && provider.authStyle;
  if (want === 'x-api-key' || want === 'bearer' || want === 'both') return want;
  return isOfficialHost(provider && provider.baseUrl) ? 'x-api-key' : 'both';
}

function buildHeaders(provider, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': API_VERSION,
  };
  const key = provider && provider.apiKey;
  const field = openai.resolveAuthField(provider);
  /* authField='query' ⇒ 一个鉴权头都不发（Key 在 URL 上，见 withQueryAuth） */
  if (key && field !== 'query') {
    if (field) {
      /* 用户显式选了 Key 的落点 ⇒ 完全照他说的来，**不再**叠加 authStyle 的"两个都发"。
         显式选择的意义就是"我知道这个网关要哪个"；再顺手多塞一个头，
         恰好是那些对凭据挑剔的网关会拒的形态（而且拒绝理由只说"鉴权失败"）。
         'api_key_header' 落在 x-api-key —— 与默认同址，但此时是**只发它**。 */
      if (field === 'auth_header') headers.Authorization = `Bearer ${key}`;
      else headers['x-api-key'] = key;
    } else {
      const style = resolveAuthStyle(provider);
      if (style === 'x-api-key' || style === 'both') headers['x-api-key'] = key;
      if (style === 'bearer' || style === 'both') headers.Authorization = `Bearer ${key}`;
    }
  }
  if (provider && provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  // proxyHeader / userAgent 永远压在上面所有来源之上（用户的值赢，包括换掉整条鉴权头）
  return openai.applyHeaderOverrides(headers, provider, opts.warn);
}

/**
 * @param {object} o
 * @param {string} o.system    顶层字段
 * @param {Array}  o.messages  只有 user / assistant
 */
function buildBody(o) {
  const body = {
    model: o.model,
    messages: o.messages,
    // 必填：缺了会直接 400
    max_tokens: Number.isFinite(o.maxTokens) && o.maxTokens > 0 ? o.maxTokens : DEFAULT_MAX_TOKENS,
  };
  const sys = typeof o.system === 'string' ? o.system.trim() : '';
  if (sys) body.system = sys;
  if (Number.isFinite(o.temperature)) {
    body.temperature = Math.min(Math.max(o.temperature, 0), MAX_TEMPERATURE);
  }
  if (o.stream) body.stream = true;
  // 注意：这里**不**放 response_format —— Anthropic 不支持，发了就是 400
  return body;
}

/**
 * 归一化消息：
 *   - 只允许 user / assistant（role 不是这两个的一律降级成 user）
 *   - 连续同角色合并成一跳
 *   - 首条必须是 user，否则补一条占位（Anthropic 硬要求）
 */
function normalizeMessages({ system, messages }) {
  const merged = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = contentToText(m.content);
    if (!content.trim()) continue; // 只有空白的消息是噪声，丢掉
    const prev = merged[merged.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${content}`;
    else merged.push({ role, content });
  }
  if (merged.length && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '（继续）' });
  }
  const sys = typeof system === 'string' ? system.trim() : '';
  return { system: sys || null, messages: merged };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

function defaultProbeModel() {
  // 最便宜的当前模型，仅用于 ping
  return 'claude-haiku-5-5';
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/**
 * 解析一条流事件。事件类型（官方 SSE）：
 *   message_start        -> usage.input_tokens
 *   content_block_start  -> 忽略
 *   content_block_delta  -> delta.text（text_delta）/ delta.thinking（thinking_delta）
 *   content_block_stop   -> 忽略
 *   message_delta        -> usage.output_tokens（累计值）、delta.stop_reason
 *   message_stop / ping  -> 忽略
 *   error                -> 由 streamError 拦下
 */
function parseStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  switch (obj.type) {
    case 'message_start': {
      const usage = obj.message && obj.message.usage;
      if (usage) out.usage = { in: num(usage.input_tokens), out: num(usage.output_tokens) };
      break;
    }
    case 'content_block_delta': {
      const d = obj.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string') out.delta = d.text;
      else if (typeof d.text === 'string' && d.text) out.delta = d.text;
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') out.reasoning = d.thinking;
      break;
    }
    case 'message_delta': {
      const usage = obj.usage;
      if (usage) out.usage = { in: num(usage.input_tokens), out: num(usage.output_tokens) };
      const fr = obj.delta && obj.delta.stop_reason;
      if (fr) out.finishReason = fr;
      break;
    }
    default:
      return null; // ping / content_block_start / content_block_stop / message_stop
  }
  return Object.keys(out).length ? out : null;
}

function streamError(obj) {
  if (obj && obj.type === 'error') {
    const e = obj.error || {};
    return typeof e.message === 'string' ? e.message : JSON.stringify(e);
  }
  return null;
}

function parseResponse(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const thinking = blocks
    .filter((b) => b && b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking)
    .join('');
  const usage = (data && data.usage) || {};
  return {
    text,
    reasoning: thinking || undefined,
    usage: { in: num(usage.input_tokens), out: num(usage.output_tokens) },
    finishReason: data && data.stop_reason,
  };
}

/** Anthropic 的 GET /v1/models 形状，测试连接暂不用，留着给设置页拉列表 */
function parseModels(data) {
  const arr = data && Array.isArray(data.data) ? data.data : [];
  return arr.map((m) => m && m.id).filter((id) => typeof id === 'string' && id.trim());
}

function num(v) {
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// 参数降级
// ---------------------------------------------------------------------------

/**
 * Anthropic 官方不吃 response_format，所以 supportsJsonMode 恒为 false，
 * 这里只需要处理第三方网关可能不认的字段。
 */
function supportsJsonMode() {
  return false;
}

const degradations = [
  {
    field: 'temperature',
    test: (msg, body) => Number.isFinite(body.temperature) && /temperature/i.test(msg),
    label: '去掉 temperature（该端点不接受温度参数）',
    fix: (body) => {
      const next = { ...body };
      delete next.temperature;
      return next;
    },
  },
];

module.exports = {
  format: 'anthropic',
  chatUrl,
  modelsUrl,
  buildHeaders,
  buildBody,
  normalizeMessages,
  parseStreamEvent,
  streamError,
  parseResponse,
  parseModels,
  defaultProbeModel,
  supportsJsonMode,
  isJsonModeBlocked: () => false,
  resolveAuthStyle,
  isOfficialHost,
  degradations,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
  isLocalBase: openai.isLocalBase,
};

/*__ISG_BUNDLE_END__*/};
  factories["llm-index"] = function (module, exports, require, shims) {
  var Buffer = shims.Buffer;
  var process = shims.process;
  var __dirname = shims.__dirname;
  var fetch = shims.fetch;
'use strict';

/**
 * 大模型接入层 · 统一入口（架构文档 §3.3 契约）
 * ---------------------------------------------------------------------------
 * 对外：
 *   await chat({ provider, model, system, messages, temperature, maxTokens,
 *                json, onDelta, signal, stream, timeoutMs, retryDelays, onRetry })
 *     -> { text, usage:{ in, out, reported }, raw, data?, jsonError?, degraded, ms }
 *   await testConnection(providerCfg, { timeoutMs })
 *     -> { ok, models?, error?, latencyMs }
 *
 * 自测用辅助（导出）：joinUrl / parseJsonLoose / maskKey / anySignal / backoffDelay
 *
 * 职责划分（不引入任何第三方依赖，只用内置 fetch / AbortController / TextDecoder）：
 *   本文件  = HTTP 传输、超时、重试退避、SSE 分帧、错误归一化、JSON 容错解析、key 打码
 *   openai.js / anthropic.js = 协议差异（URL 归一化、请求头、请求体、流事件、响应解析）
 *
 * 依赖方向： index.js -> openai.js, anthropic.js, ../providers.js ； anthropic.js -> openai.js
 *          （无环）
 */

const { getPreset } = require('../providers');
const openai = require('./openai');
const anthropic = require('./anthropic');

const ADAPTERS = { openai, anthropic };

/** 单次请求默认超时（180s，架构 §6 的"不许卡死 UI"） */
const DEFAULT_TIMEOUT_MS = 180_000;
/** 测试连接的超时（10s，必须短） */
const TEST_TIMEOUT_MS = 10_000;
/** 指数退避重试延迟：最多重试 3 次 */
const RETRY_DELAYS = [1000, 3000, 9000];
/** 抖动比例 ±20% */
const JITTER_RATIO = 0.2;
/** 值得重试的 HTTP 状态（529 = Anthropic 的 overloaded，属于同一类瞬时故障） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
/** 429 带 Retry-After 时的等待上限 */
const MAX_RETRY_AFTER_MS = 30_000;
/** 错误体保留上限（进 UI / 日志） */
const MAX_ERROR_BODY_CHARS = 4000;
/* 一个"被切断事件"最多攒多少字节（多行拼接后的 pending）。
   ⚠️ 注意它**不是**单行上限 —— 单行的上限是下面的 MAX_LINE_CHARS。
   这条注释以前写成"SSE 单行缓冲上限"，与实际作用范围不符。 */
const MAX_PENDING_SSE_CHARS = 1 << 20;
/** 未出现换行符的累计字节上限：超过就丢弃并计数，防止"永不发换行"的响应撑爆内存 */
const MAX_LINE_CHARS = 4 << 20;
/* 一个被切断的 SSE 事件最多攒几行。
   以前只有字节上限（1MB），于是一条坏行能把后面所有事件拖着走很久；
   4 行足够覆盖真实的多行 JSON（服务端按 TCP 分片最多切出两三行），
   同时保证坏 pending 不会变成雪球。 */
const MAX_PENDING_SSE_LINES = 4;
/** 流式事件保留上限（raw.events） */
const MAX_STREAM_EVENTS = 20_000;
/** 解析失败时回灌给模型的原文前后片段长度 */
const RAW_PREVIEW_CHARS = 200;
/** 这些网络错误码重试也没用（端口没人监听 / URL 就是错的） */
const FATAL_NET_CODES = new Set(['ECONNREFUSED', 'ERR_INVALID_URL', 'ERR_UNESCAPED_CHARACTERS']);

// ---------------------------------------------------------------------------
// 错误对象
// ---------------------------------------------------------------------------

/**
 * 归一化后的错误。契约要求带 { status, providerMessage, retryable, url }。
 */
class LlmError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = opts.status == null ? null : opts.status;
    this.providerMessage = opts.providerMessage || '';
    this.retryable = !!opts.retryable;
    this.url = opts.url || '';
    this.code = opts.code || null;
    this.body = opts.body || '';
    this.retryAfterMs = opts.retryAfterMs || 0;
    this.attempts = opts.attempts || 1;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
  /** 给人看的一行摘要（不含 key）。带上 HTTP 状态，但优先说人话。 */
  get summary() {
    if (this.status) {
      return this.providerMessage ? `HTTP ${this.status} · ${this.providerMessage}` : `HTTP ${this.status}`;
    }
    return this.providerMessage || this.message;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * API Key 打码：只留前 4 后 4。长度 <= 8 时全遮（否则等于没遮）。
 */
function maskKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  if (!s) return '(未设置)';
  /* 短 Key **整体遮住**：以前是 `length <= 8` 才全遮，于是 9 个字符的 Key 会显示成
     `abcd…fghi` —— 9 个里露出 8 个，等于没遮。而短 token 在自定义网关/本机网关上并不罕见。
     16 是常见的真实 Key 长度下限（`sk-` + 十几个字符），比它短的一律不给任何提示。 */
  if (s.length < 16) return '********';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * 造一个"把 key 洗掉"的函数。任何要进 UI / 日志 / 错误信息的字符串都要过它。
 * 除了精确匹配真实 key，还兜底拦 sk-xxx / Bearer xxx 形态。
 */
function makeScrubber(apiKey) {
  const k = typeof apiKey === 'string' ? apiKey.trim() : '';
  const masked = maskKey(k);
  const looksLikeKey = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;
  return (input) => {
    if (typeof input !== 'string' || !input) return input || '';
    let out = input;
    /* 门槛从 6 降到 4：短 Key 以前**一次都不替换**，于是它会原样出现在
       `job.error.message` 里（进而进 UI 与落盘历史）。代价是"4 个字符的串"可能误伤正文，
       但那只是显示难看；漏 Key 是实打实的损失。*/
    if (k.length >= 4) out = out.split(k).join(masked);
    out = out.replace(looksLikeKey, (m) =>
      m.startsWith('Bearer') ? `Bearer ${maskKey(m.slice(7).trim())}` : maskKey(m)
    );
    return out;
  };
}

/**
 * 把多个 AbortSignal 合成一个。任一 abort，合成信号 abort。
 * 优先用内置 AbortSignal.any（Node 20.3+），否则手动合并。
 */
function anySignal(signals) {
  const list = (Array.isArray(signals) ? signals : [signals]).filter(
    (s) => s && typeof s.addEventListener === 'function'
  );
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const ctrl = new AbortController();
  const onAbort = (ev) => {
    cleanup();
    const target = ev && 'target' in ev ? ev.target : ev;
    ctrl.abort(target && target.reason !== undefined ? target.reason : undefined);
  };
  const cleanup = () => {
    for (const s of list) s.removeEventListener('abort', onAbort);
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort(s);
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
}

/** 第 attempt 次重试（0 起）要等多久；rand 注入便于测试。 */
function backoffDelay(attempt, rand = Math.random, delays = RETRY_DELAYS) {
  const base = delays[Math.min(attempt, delays.length - 1)] || delays[delays.length - 1] || 1000;
  const jitter = 1 + (rand() * 2 - 1) * JITTER_RATIO;
  return Math.max(0, Math.round(base * jitter));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortErr = () =>
      new LlmError('请求已取消', { code: 'EABORTED', retryable: false });
    if (signal && signal.aborted) return reject(abortErr());
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(abortErr());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 本机端点（Ollama / LM Studio）：允许没有 API Key */
function isLocalBase(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?(\/|$)/i.test(
    String(baseUrl || '').trim()
  );
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ---------------------------------------------------------------------------
// 错误归一化
// ---------------------------------------------------------------------------

/**
 * 从响应体里尽力抠出人话。两家的错误结构不同（还有各种网关），全部兜一遍：
 *   OpenAI      { error: { message, type, code } }
 *   Anthropic   { type:'error', error: { type, message } }
 *   杂牌网关     { message } / { msg } / { detail } / { error: "字符串" } / HTML
 */
function extractProviderMessage(parsed, rawText) {
  if (isPlainObject(parsed)) {
    const candidates = [
      isPlainObject(parsed.error) ? parsed.error.message : null,
      isPlainObject(parsed.error) && isPlainObject(parsed.error.error) ? parsed.error.error.message : null,
      isPlainObject(parsed.error) ? parsed.error.msg : null,
      typeof parsed.error === 'string' ? parsed.error : null,
      parsed.message,
      parsed.msg,
      typeof parsed.detail === 'string' ? parsed.detail : null,
      parsed.error_description,
      isPlainObject(parsed.response) && isPlainObject(parsed.response.error)
        ? parsed.response.error.message
        : null,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return truncate(c.trim(), 600);
    }
    // 结构陌生：别把信息丢了，序列化出来
    for (const key of ['error', 'detail']) {
      if (parsed[key] && typeof parsed[key] === 'object') {
        try {
          const s = JSON.stringify(parsed[key]);
          if (s && s !== '{}' && s.length <= 600) return s;
        } catch {
          /* 循环引用等，忽略 */
        }
      }
    }
  }
  const plain = String(rawText || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(plain, 400);
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 同 parseMaybeJson，但**把"成没成"单独带出来**。
 *
 * 为什么必须要它：`JSON.parse('null')`、`JSON.parse('0')`、`JSON.parse('""')` 都是**合法**的，
 * 结果却是假值。用 `if (!obj)` 判断"解析失败"会把它们一起误判——
 * 流式解析里这个误判的代价是**整条流被静默吞掉**（见 handleData 的说明）。
 */
function parseJsonChecked(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, value: null };
  }
}

function parseRetryAfter(res) {
  const h = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(h);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return 0;
}

async function buildHttpError(res, { url, scrub }) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* 读不出来就算了 */
  }
  const providerMessage = scrub(extractProviderMessage(parseMaybeJson(text), text));
  const status = res.status;
  /* 429 要分开看：**限流**该重试，**余额/配额耗尽**重试一万次也没用。
     以前只看状态码，于是"欠费"会被退避重试 4 次（~13s），
     而且上层的 askJson 还会把整个调用再重来若干轮 —— 一个注定失败的阶段能耗掉十几次请求。
     判据是错误体里的关键词（两家措辞不同，涵盖中英文）。 */
  const quotaExhausted =
    status === 429 &&
    /insufficient_quota|quota|credit balance|billing|exceeded your current quota|余额|欠费|配额|充值/i.test(
      String(providerMessage || '')
    );
  const retryable = RETRYABLE_STATUS.has(status) && !quotaExhausted;
  const label = status === 401 || status === 403 ? '鉴权失败' : status === 404 ? '端点不存在' : '请求被拒绝';
  const message = scrub(
    `HTTP ${status}（${label}）${providerMessage ? `：${providerMessage}` : ''}`
  );
  return new LlmError(message, {
    status,
    providerMessage,
    retryable,
    /* url 也要洗（与 buildNetworkError 同理）：authField:'query' 时 Key 就在查询串里，
       而 err.url 会随 err 一起进任务日志与落盘历史。scrub 对不含 Key 的 URL 是恒等变换。 */
    url: typeof scrub === 'function' ? scrub(url) : url,
    code: 'EHTTP',
    body: scrub(truncate(text, MAX_ERROR_BODY_CHARS)),
    retryAfterMs: parseRetryAfter(res),
  });
}

function buildNetworkError(err, { url, timeoutMs, externalSignal, scrub }) {
  /* ⚠️ url 也必须过 scrubber。
     它是**唯一**没洗过的字段，而 Key 完全可以写在 Base URL 的 userinfo 里
     （`https://sk-xxx@gateway/v1`）—— 那种配置下 `JSON.stringify(err)` 会带上明文 Key。
     当前 jobs.fail() 只把 message+stack 交给界面，所以暂时漏不出去；
     但只要将来有人把 err 整体序列化或打进日志，Key 就出去了。这条注释就是那道提醒。 */
  const safeUrl = typeof scrub === 'function' ? scrub(url) : url;
  if (externalSignal && externalSignal.aborted) {
    return new LlmError('请求已取消', {
      code: 'EABORTED',
      retryable: false,
      url: safeUrl,
      cause: err,
    });
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    // 超时/中止不重试：180s × 4 次会把 UI 卡死；由调用方决定是否重开
    // ⚠️ 报出来的秒数必须是**用户实际配的**那个。曾经这里一律写 180 秒
    //    （调用方传 timeoutMs: 0，被 `|| DEFAULT_TIMEOUT_MS` 兜到 180000），
    //    用户配了 30s 却看到"180 秒无响应"，排查时会被带到错的地方去。
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
    const pretty = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`;
    return new LlmError(`请求超时（${pretty}无响应）`, {
      code: 'ETIMEOUT',
      retryable: false,
      url: safeUrl,
      cause: err,
    });
  }
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const detail = scrub((err && err.message) || String(err));
  return new LlmError(`网络请求失败：${detail}${code ? `（${code}）` : ''}`, {
    code: code || 'ENETWORK',
    retryable: !FATAL_NET_CODES.has(code),
    url: safeUrl,
    cause: err,
  });
}

// ---------------------------------------------------------------------------
// JSON 容错解析
// ---------------------------------------------------------------------------

/** 剥 ``` 围栏：优先取第一个围栏块的内容；围栏没闭合（流被截断）也尽量取。 */
function stripCodeFence(src) {
  const s = String(src);
  if (!s.includes('```')) return s;
  /* 只认"围栏**包住整段**"这种形态：整段以 ``` 开头。
     以前是"在整段里找第一对 ```"，于是正文中间出现围栏（代码/公式示例）时会把
     两段文字之间的内容当 JSON —— 要么解析失败，要么**解析出毫不相干的东西**。
     （`parseJsonLoose` 现在已经先试原文，这里是第二道。） */
  if (!/^\s*```/.test(s)) return s;
  const closed = s.match(/^\s*```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```[ \t]*$/);
  if (closed && closed[1] !== undefined) return closed[1];
  const open = s.match(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*)$/);
  if (open && open[1] !== undefined) return open[1];
  return s;
}

/** 从首个 { 或 [ 截到与之配对（考虑字符串与转义）的收尾。找不到返回 null。 */
function sliceBalanced(src) {
  const s = String(src);
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 去尾逗号（等价于 /,\s*[}\]]/，但跳过字符串内部，避免"a,}b"这种内容被误伤） */
function stripTrailingCommas(src) {
  const s = String(src);
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // 丢掉这个逗号
    }
    out += ch;
  }
  return out;
}

/**
 * 容错解析模型吐出的 JSON。步骤（架构 §3.3）：
 *   剥 ```json 围栏 → 截取首个 { / [ 到配对的收尾 → 去尾逗号 → JSON.parse
 * 失败时抛错，并带上原文前、后各 200 字（上层可原样回灌给模型）。
 */
function parseJsonLoose(text) {
  const original = String(text == null ? '' : text);
  const steps = [];

  /* ⚠️ ① 先试**原文**，严格解析成功就直接返回。
     这一步是后加的，但它是最重要的一步：以前**无条件**先剥围栏，于是
     "合法 JSON 里某个字符串值本身含 ``` 围栏"会被改坏 —— 而本应用生成的正是
     含代码块/公式示例的 HTML，属于高频形态。实测（test/_audit/v8/f-json.js）：
       {"blocks":[{"html":"<pre><code>```c\nint main(){}\n```</code></pre>"}]}
     原文完全合法，剥围栏之后返回的却是一个**空对象 {}** ——
     上层拿到的是错数据，而它未必通不过后面的校验（比直接报错更危险）。 */
  try {
    return JSON.parse(original.trim());
  } catch (e) {
    /* 原文不是合法 JSON，落回下面的宽松解析 */
  }

  try {
    let s = stripCodeFence(original);
    steps.push('剥围栏');
    const balanced = sliceBalanced(s);
    if (balanced != null) {
      s = balanced;
      steps.push('截取括号范围');
    }
    s = stripTrailingCommas(s);
    steps.push('去尾逗号');
    const value = JSON.parse(s.trim());
    return value;
  } catch (err) {
    // 前后各取 RAW_PREVIEW_CHARS 个字符（不加省略号，长度严格等于 RAW_PREVIEW_CHARS，
    // 上层可以直接拿去做回灌提示词，不用担心多一个字符）
    const head = original.slice(0, RAW_PREVIEW_CHARS);
    const tail = original.length > RAW_PREVIEW_CHARS ? original.slice(-RAW_PREVIEW_CHARS) : '';
    const e = new Error(
      `JSON 解析失败：${err.message}\n` +
        `--- 模型原文开头（≤${RAW_PREVIEW_CHARS} 字）---\n${head}\n` +
        `--- 模型原文结尾（≤${RAW_PREVIEW_CHARS} 字）---\n${tail}`
    );
    e.name = 'JsonParseError';
    e.code = 'EJSONPARSE';
    e.raw = original;
    e.head = head;
    e.tail = tail;
    e.steps = steps;
    e.cause = err;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchOnce({ url, method, headers, body, timeoutMs, signal, scrub }) {
  const timeoutSignal =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const combined = anySignal([timeoutSignal, signal]);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: combined,
      redirect: 'follow',
    });
  } catch (err) {
    throw buildNetworkError(err, { url, timeoutMs, externalSignal: signal, scrub });
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * 逐行消费 SSE 流。
 * - 用 buffer 按 '\n' 切，切不出完整行的尾巴留在 buffer 里跨 chunk 拼接（半行保护）
 * - 支持 `data: x` / `data:x` / `[DONE]` / `: comment`
 * - 单行 JSON 解析失败时，先当"被拆成多行 data: 的同一个事件"合并重试
 * 返回 { text, reasoning, usage, finishReason, events, skipped }
 */
async function consumeSse(res, { onDelta, adapter, scrub, signal, ndjson, timeoutMs }) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    throw new LlmError('响应没有可读的流（该端点可能不支持 stream:true）', {
      code: 'ENOSTREAM',
      retryable: false,
      /* res.url 是 fetch 记下的**最终请求地址**，authField:'query' 时它带着 Key，
         而这里的错误会进任务日志 —— 必须洗（scrub 对无 Key 的 URL 是恒等变换）。 */
      url: scrub(res.url),
    });
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pending = '';
  let pendingLines = 0; // 已经为「同一个被切断的事件」攒了几行（见 handleData 的说明）
  let text = '';
  let reasoning = '';
  const usage = { in: 0, out: 0, reported: false };
  let finishReason = null;
  let done = false;
  const events = [];
  let skipped = 0;

  const applyEvent = (obj) => {
    if (events.length < MAX_STREAM_EVENTS) events.push(obj);
    const errText = adapter.streamError ? adapter.streamError(obj) : null;
    if (errText) {
      throw new LlmError(scrub(`模型流内错误：${errText}`), {
        code: 'ESTREAM',
        retryable: false,
        url: scrub(res.url), // 同 ENOSTREAM：res.url 可能带着查询串里的 Key
        providerMessage: scrub(errText),
      });
    }
    const ev = adapter.parseStreamEvent(obj);
    if (!ev) return;
    if (ev.delta) {
      text += ev.delta;
      if (typeof onDelta === 'function') onDelta(ev.delta);
    }
    if (ev.reasoning) reasoning += ev.reasoning;
    if (ev.usage) {
      if (Number.isFinite(ev.usage.in)) usage.in = ev.usage.in;
      if (Number.isFinite(ev.usage.out)) usage.out = ev.usage.out;
      usage.reported = true;
    }
    if (ev.finishReason) finishReason = ev.finishReason;
  };

  const handleData = (rawPayload) => {
    const payload = rawPayload.trim();
    if (!payload) return;
    if (pending === '' && (payload === '[DONE]' || payload === 'DONE')) {
      done = true;
      return;
    }
    const joined = pending ? pending + payload : payload;
    const got = parseJsonChecked(joined);

    if (!got.ok) {
      /* ⚠️ 这一段修过一个「整条流被静默吞掉」的 bug。旧写法是：
           const obj = parseMaybeJson(candidate); if (!obj) { pending = candidate; return; }
         三个问题叠在一起：
           ① `JSON.parse('null' | '0' | '""')` 是**合法**结果（假值），却被 `!obj` 当成解析失败；
           ② 只要有一行进了 pending，**后面每一条正常事件都会被拼进这个坏串**（pending + payload）
              继续失败 —— 于是后续所有 delta、finish_reason、[DONE] 全部丢失；
           ③ 要累计到 1MB 才清空，而 `skippedEvents` 全仓没有任何调用方读它。
         症状是：模型答到一半就没了，没有异常、没有 finish_reason，**看起来像模型的问题**。
         （实测复现见 test/_audit/v8/b-sse.js：一条 `data: 0` 保活行之后，3 条正常事件全被吞。）
         现在的规则：
           · 上一轮攒了 pending 时，先把**这一行单独**试一次 —— 坏的 pending 拖不垮后面的流；
           · 只有"看起来就是一段被切断的 JSON"（以 { 或 [ 开头）才继续攒；
           · 最多攒 4 行（MAX_PENDING_SSE_LINES），不会再出现 1MB 级的雪球。 */
      /* ⚠️ 只有**单独解析出对象**才算"这条是真事件、前面攒的是坏 pending"。
         曾经写成 `if (solo.ok)` —— 只要本行单独能解析就清掉 pending，于是
         「一条被切成 ≥3 段的 JSON，而中间那一段本身恰好是个合法标量」会把**整条事件丢掉**：
            data: {"choices":[{"delta":{"content:     ← 攒成 pending
            data: 12                                  ← 单独能 parse（标量）→ 清空 pending ✗
            data: 34}}]}                              ← 单独 parse 不了 → 也丢
         实测（本仓 test/_audit/v8/b-sse.js 的三段用例）：text 变成空串，skipped 只记 2。
         旧写法（每行都往 pending 上拼）在三段情形下反而能拼成合法 JSON —— 也就是说这是
         "修上一版 bug 时引入的回归"。标量一律**不**走这条捷径，落回下面的继续攒。 */
      if (pending) {
        const solo = parseJsonChecked(payload);
        if (solo.ok && solo.value && typeof solo.value === 'object') {
          pending = '';
          pendingLines = 0;
          applyEvent(solo.value);
          return;
        }
      }
      const canGrow =
        !done &&
        pendingLines < MAX_PENDING_SSE_LINES &&
        joined.length < MAX_PENDING_SSE_CHARS &&
        /^[[{]/.test(joined);
      if (canGrow) {
        pending = joined;
        pendingLines++;
        return;
      }
      skipped++;
      pending = '';
      pendingLines = 0;
      return;
    }

    pending = '';
    pendingLines = 0;
    // 标量不是事件（`data: 0` 这类保活行）——解析成功但没内容，跳过，不喂给 applyEvent
    if (!got.value || typeof got.value !== 'object') {
      skipped++;
      return;
    }
    applyEvent(got.value);
  };

  const handleLine = (line) => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!clean || clean.startsWith(':')) return; // 空行 / 注释 / keep-alive
    if (!clean.startsWith('data:')) {
      /* ndjson：一行一条**裸 JSON**，没有 `data:` 前缀。
         ⚠️ 这一支以前是缺的：`chat()` 把 `application/x-ndjson` 列进了 content-type 白名单
         （当时那行的意图是"这是流、别当一次性 JSON 读"），但下面的解析只认 `data:` 前缀，
         于是 ndjson 网关的**每一个正常事件都被丢掉** → 每次调用 text 都是 `""`，
         而上层 explainEmptyText 会把它当成"模型返回了空正文"，去怀疑推理型模型吃光了输出预算、
         甚至把 maxTokens 一路抬到 64000 —— 真原因（网关格式）永远查不出来。
         只收 `{` / `[` 开头的行，不会把 SSE 的 event:/id:/retry: 误当数据。 */
      if (ndjson && /^[[{]/.test(clean)) handleData(clean);
      return;
    }
    handleData(clean.slice(5));
  };

  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      /* 单行缓冲的上限。
         ⚠️ `MAX_PENDING_SSE_CHARS` 的注释一直写着"SSE **单行**缓冲上限"，但它实际只作用在
         `pending`（被切断事件的多行拼接）上，`buffer` 本身没有任何上限 ——
         一个**永远不发换行**的响应能让它一直涨下去。正常流里一条 delta 只有几十字节，
         4MB 已经远超任何合理单行，触到就说明对端在发畸形东西。 */
      if (buffer.length > MAX_LINE_CHARS) {
        skipped++;
        buffer = '';
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) {
      buffer += decoder.decode(); // flush 掉解码器里剩下的半个多字节字符
      if (buffer.length) handleLine(buffer); // 最后一段（没有换行结尾）别丢
      if (pending) {
        const got = parseJsonChecked(pending);
        pending = '';
        pendingLines = 0;
        // 用 parseJsonChecked 而不是 `if (obj)`：`JSON.parse('null')` 这种合法假值不该被当成失败
        if (got.ok && got.value && typeof got.value === 'object') applyEvent(got.value);
        else skipped++;
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // buildNetworkError 内部会洗 url（res.url 可能带查询串里的 Key）
    throw buildNetworkError(err, { url: res.url, timeoutMs, externalSignal: signal, scrub });
  } finally {
    try {
      if (typeof reader.cancel === 'function') await reader.cancel();
    } catch {
      /* 关流失败无所谓 */
    }
  }

  return { text, reasoning, usage, finishReason, events, skipped };
}

// ---------------------------------------------------------------------------
// 适配器解析
// ---------------------------------------------------------------------------

function resolveFormat(provider) {
  if (provider && (provider.format === 'openai' || provider.format === 'anthropic')) {
    return provider.format;
  }
  const preset = provider && provider.id ? getPreset(provider.id) : null;
  if (preset && (preset.format === 'openai' || preset.format === 'anthropic')) {
    return preset.format;
  }
  return 'openai'; // 大多数兼容端点是 OpenAI 形态
}

/**
 * 把"用户配的那些请求覆盖项"（fullUrl / authField / userAgent / proxyHeader / proxyBody）
 * 落到真正要发出去的那份 url / headers / body 上。
 *
 * 为什么必须收成一个函数、并且 chat 与 testConnection **共用**：
 * 只在 chat 里生效时的症状正是这个仓库最讨厌的假修复 ——
 * 「测试连接」能过（它自己拼了一套请求），真生成却过不了（另一套）。
 * 反过来也一样：如果只在测试连接里生效，用户会看到"配置没问题"而任务一直失败。
 *
 * warn(field, message) 可选，用来把"这段覆盖没生效"告诉上层；它**只**收到字段名与
 * 固定措辞，绝不带上覆盖内容（那里面可能有 Key）。
 */
function buildRequest(adapter, provider, o) {
  const headers = adapter.buildHeaders(provider, { warn: o.warn });
  const url = adapter.chatUrl(provider.baseUrl, { fullUrl: provider.fullUrl === true });
  const body = adapter.buildBody({
    model: o.model,
    system: o.system,
    messages: o.messages,
    temperature: o.temperature,
    maxTokens: o.maxTokens,
    json: o.json,
    stream: o.stream,
  });
  return {
    // authField:'query' 时 Key 就在这个 URL 上 —— 之后凡是要进日志/错误的副本都得先洗（safeUrl）
    url: openai.withQueryAuth(url, provider),
    headers,
    body: openai.applyProxyBody(body, provider, o.warn),
  };
}

function assertProvider(provider) {
  if (!isPlainObject(provider)) {
    throw new LlmError('provider 参数缺失（需要 { id, format, baseUrl, apiKey }）', {
      code: 'ECONFIG',
      retryable: false,
    });
  }
  if (!provider.baseUrl || !String(provider.baseUrl).trim()) {
    throw new LlmError('未配置 Base URL', { code: 'ECONFIG', retryable: false });
  }
  if (!provider.apiKey && !isLocalBase(provider.baseUrl)) {
    throw new LlmError('未配置 API Key', { code: 'ECONFIG', retryable: false });
  }
}

// ---------------------------------------------------------------------------
// chat()
// ---------------------------------------------------------------------------

/**
 * 统一对话入口。
 *
 * @param {object}  o
 * @param {object}  o.provider     { id, format, baseUrl, apiKey }
 *   可选（1.4.0 起设置页会带过来，全部**真的**作用到请求上，见 buildRequest）：
 *   `fullUrl` / `authField` / `userAgent` / `proxyHeader` / `proxyBody`
 * @param {string}  o.model
 * @param {string} [o.system]
 * @param {Array}   o.messages     [{ role:'user'|'assistant', content:string }]
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {boolean}[o.json]        true = 要求 JSON 输出（OpenAI 侧带 response_format）
 * @param {Function}[o.onDelta]    流式增量回调 (text) => void
 * @param {AbortSignal}[o.signal]  外部取消信号
 * @param {boolean}[o.stream]      默认：给了 onDelta 就流式
 * @param {number} [o.timeoutMs]   默认 180s
 * @param {number[]}[o.retryDelays] 默认 [1000,3000,9000]
 * @param {Function}[o.onRetry]    ({ attempt, delayMs, error }) => void
 * @returns {Promise<{text, usage, raw, data?, jsonError?, degraded, ms}>}
 *   注意：json:true 时解析失败**不抛错**——`data` 为 undefined、`jsonError` 带原文，
 *   便于 pipeline 的 repair 阶段原样回灌给模型（架构 §6.4 不吞异常）。
 */
async function chat(o = {}) {
  const {
    provider,
    model,
    system,
    messages,
    temperature,
    maxTokens,
    json = false,
    onDelta,
    signal,
    stream,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelays = RETRY_DELAYS,
    onRetry,
  } = o;

  assertProvider(provider);
  if (!model || !String(model).trim()) {
    throw new LlmError('未指定模型 ID', { code: 'ECONFIG', retryable: false });
  }

  const adapter = ADAPTERS[resolveFormat(provider)];
  const scrub = makeScrubber(provider.apiKey);
  const useStream = stream === undefined ? typeof onDelta === 'function' : !!stream;
  const norm = adapter.normalizeMessages({ system, messages });
  const wantJson = !!json && !!adapter.supportsJsonMode(provider, model);

  const degraded = [];
  /* 覆盖项写坏了（JSON 语法错）不当成致命错误：它是"锦上添花"的配置，
     为了它把整个生成任务打死不值得。但**必须留下痕迹**，否则用户会以为
     自己的覆盖生效了 —— degraded 进调用结果，控制台给"任务日志之外"的排查留一份。 */
  const warnConfig = (field, message) => {
    degraded.push({ field, label: message });
    console.warn(`[llm] ${message}`);
  };

  const req = buildRequest(adapter, provider, {
    model: String(model).trim(),
    system: norm.system,
    messages: norm.messages,
    temperature,
    maxTokens,
    json: wantJson,
    stream: useStream,
    warn: warnConfig,
  });
  const url = req.url;
  const headers = req.headers;
  /* ⚠️ 进错误 / 回调 / 日志的那一份 URL 必须是**洗过**的：
     authField:'query' 把 Key 拼在查询串里，而 err.url、onRetry 的 url 都会被上层写进
     任务日志（界面 + 落盘历史）。不洗就等于"设置页勾了 Key 放查询串，Key 就跟着报错文案到处跑"。
     scrub 对不含 Key 的 URL 是恒等变换，所以既有配置的报文一个字都不会变。 */
  const safeUrl = scrub(url);

  let body = req.body;
  const triedFixes = new Set();
  const maxRetries = Number.isFinite(o.maxRetries) ? o.maxRetries : retryDelays.length;
  let retries = 0;
  let attempts = 0;
  const t0 = Date.now();

  for (;;) {
    attempts++;
    let emitted = 0;
    try {
      const res = await fetchOnce({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        scrub,
      });

      if (!res.ok) {
        const err = await buildHttpError(res, { url: safeUrl, scrub });
        err.attempts = attempts;
        throw err;
      }

      const ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';

      // 端点无视 stream:true 直接回了 JSON —— 当成一次性响应处理，别把它当 SSE 解析
      if (useStream && !/text\/event-stream|application\/x-ndjson/i.test(ctype)) {
        const data = await readJsonSafely(res, safeUrl, scrub);
        const parsed = adapter.parseResponse(data);
        assertNotRefusal(parsed, safeUrl);
        if (parsed.text) {
          emitted = parsed.text.length;
          if (typeof onDelta === 'function') onDelta(parsed.text);
        }
        const out = {
          text: parsed.text,
          usage: normalizeUsage(parsed.usage),
          raw: data,
          degraded,
          ms: Date.now() - t0,
          streamed: false,
        };
        if (parsed.reasoning) out.reasoning = parsed.reasoning;
        return finishJson(out, json, originalText(out));
      }

      if (useStream) {
        const r = await consumeSse(res, {
          // 有些网关按 ndjson 回（一行一条裸 JSON，**没有** `data:` 前缀）。
          // 见 handleLine 里的说明：光把它列进 content-type 白名单是不够的。
          ndjson: /application\/x-ndjson/i.test(ctype),
          onDelta: (d) => {
            emitted += d.length;
            if (typeof onDelta === 'function') onDelta(d);
          },
          adapter,
          scrub,
          signal,
          timeoutMs,   // 只为了超时报错里能写出用户实际配的秒数（见 buildNetworkError）
        });
        assertNotRefusal({ finishReason: r.finishReason, text: r.text }, safeUrl);
        const out = {
          text: r.text,
          usage: normalizeUsage(r.usage),
          raw: {
            streamed: true,
            events: r.events,
            finishReason: r.finishReason,
            skippedEvents: r.skipped,
          },
          degraded,
          ms: Date.now() - t0,
          streamed: true,
        };
        if (r.reasoning) out.reasoning = r.reasoning;
        if (r.finishReason) out.finishReason = r.finishReason;
        return finishJson(out, json, r.text);
      }

      // 非流式
      const data = await readJsonSafely(res, safeUrl, scrub);
      const parsed = adapter.parseResponse(data);
      assertNotRefusal(parsed, safeUrl);
      const out = {
        text: parsed.text,
        usage: normalizeUsage(parsed.usage),
        raw: data,
        degraded,
        ms: Date.now() - t0,
        streamed: false,
      };
      if (parsed.reasoning) out.reasoning = parsed.reasoning;
      if (parsed.finishReason) out.finishReason = parsed.finishReason;
      return finishJson(out, json, parsed.text);
    } catch (err) {
      if (!(err instanceof LlmError)) {
        // 这里挂的是 safeUrl：任何抛给上层的异常字段都不许带 Key（见 url 的说明）
        throw Object.assign(err, { attempts, url: safeUrl });
      }
      err.attempts = attempts;
      if (err.code === 'EABORTED') throw err;

      // ① 参数降级：只在 400 且错误信息点到某个已知字段时才做，每个字段只降一次
      const fix = err.status === 400 ? pickBodyFix(adapter, err, body, triedFixes) : null;
      if (fix) {
        triedFixes.add(fix.field);
        body = fix.fix(body, err.providerMessage || err.message || '');
        degraded.push({ field: fix.field, label: fix.label, providerMessage: err.providerMessage });
        // 让适配器把这条经验记下来（例如 openai 会把该 base+model 拉黑，
        // 后续调用不再白撞一次 400 —— 一个生成任务会调模型 N 次，这个差别很实在）
        if (typeof fix.onDegraded === 'function') fix.onDegraded(provider, model);
        continue;
      }

      // ② 状态码重试；流已经吐过字了就不能重试（否则前端会看到重复内容）
      const canRetry = err.retryable && retries < maxRetries && emitted === 0;
      if (!canRetry) throw err;

      const delay = Math.max(
        err.retryAfterMs || 0,
        backoffDelay(retries, Math.random, retryDelays)
      );
      retries++;
      if (typeof onRetry === 'function') {
        // 同上：回调的 url 会被调用方写进日志，必须是洗过的
        onRetry({ attempt: retries, delayMs: delay, error: err, url: safeUrl });
      }
      await sleep(delay, signal);
    }
  }
}

/** 400 时按已知字段降级（response_format / stream_options / max_tokens 改名） */
function pickBodyFix(adapter, err, body, triedFixes) {
  const list = adapter.degradations || [];
  const msg = `${err.providerMessage || ''} ${err.body || ''}`;
  for (const d of list) {
    if (triedFixes.has(d.field)) continue;
    if (!d.test(msg, body)) continue;
    return d;
  }
  return null;
}

function normalizeUsage(u) {
  const src = u || {};
  return {
    in: Number.isFinite(src.in) ? src.in : 0,
    out: Number.isFinite(src.out) ? src.out : 0,
    reported: !!(src.reported || Number.isFinite(src.in) || Number.isFinite(src.out)),
  };
}

function originalText(out) {
  return out.text;
}

/**
 * 新版 Claude 会以 HTTP 200 + stop_reason=refusal 拒答。
 * 这时候 text 是空的，如果放过去，上层只会看到"JSON 解析失败"这种误导性的报错
 * （架构 §6.2：不许静默产出半成品）。直接抛一个说人话的错误。
 */
function assertNotRefusal(parsed, url) {
  if (parsed && parsed.finishReason === 'refusal' && !String(parsed.text || '').trim()) {
    throw new LlmError(
      '模型拒答了本次请求（stop_reason=refusal），没有返回任何内容。请调整提示词，或换一个模型重试。',
      { code: 'EREFUSAL', status: 200, retryable: false, url }
    );
  }
}

/** json:true 时顺手解析，失败只记录不抛（原文在 jsonError.raw 里，可直接回灌） */
function finishJson(out, json, text) {
  if (json) {
    try {
      out.data = parseJsonLoose(text);
    } catch (e) {
      out.jsonError = {
        message: e.message,
        raw: e.raw,
        head: e.head,
        tail: e.tail,
      };
    }
  }
  return out;
}

async function readJsonSafely(res, url, scrub) {
  /* url 由调用方给，可能是 safeUrl 也可能没洗过，这里统一洗一遍再挂到错误上：
     这个函数会把 url 写进**四个**错误对象，任何一处漏洗都等于把查询串里的 Key 交出去
     （scrub 对不含 Key 的 URL 是恒等变换，所以既有的 err.url 断言不受影响）。 */
  const safeUrl = typeof scrub === 'function' ? scrub(url) : url;
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    throw buildNetworkError(err, { url: safeUrl, timeoutMs: 0, scrub });
  }
  if (!text.trim()) {
    throw new LlmError('响应体为空', {
      code: 'EEMPTY',
      status: res.status,
      retryable: res.status >= 500,
      url: safeUrl,
    });
  }
  const data = parseMaybeJson(text);
  if (data == null) {
    throw new LlmError(scrub(`响应不是合法 JSON：${truncate(text, 300)}`), {
      code: 'EBADJSON',
      status: res.status,
      retryable: false,
      url: safeUrl,
      body: scrub(truncate(text, MAX_ERROR_BODY_CHARS)),
    });
  }
  if (isPlainObject(data) && data.error) {
    const providerMessage = scrub(extractProviderMessage(data, text));
    throw new LlmError(scrub(`模型返回错误：${providerMessage}`), {
      code: 'EPROVIDER',
      status: res.status,
      providerMessage,
      retryable: false,
      url: safeUrl,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// testConnection()
// ---------------------------------------------------------------------------

/**
 * 测试连接。**绝不抛错**，永远返回 { ok, models?, error?, latencyMs }。
 *
 * OpenAI 兼容：先 GET {base}/models（不带 /v1 的会补上）；
 *             非 2xx 或拿到不可用的列表，再退化成一次 max_tokens:1 的最小 chat/completions。
 * Anthropic ：直接做一次 max_tokens:1 的最小 messages 调用。
 * 默认 10s 超时保护，且不重试（UI 不能被卡住）。
 */
async function testConnection(providerCfg, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TEST_TIMEOUT_MS;
  const t0 = Date.now();
  const done = (patch) => ({ latencyMs: Date.now() - t0, ...patch });

  let adapter;
  let scrub;
  try {
    assertProvider(providerCfg);
    adapter = ADAPTERS[resolveFormat(providerCfg)];
    scrub = makeScrubber(providerCfg.apiKey);
  } catch (err) {
    return done({ ok: false, models: [], error: describe(err) });
  }

  const provider = {
    ...providerCfg,
    // 本地端点没 key 也能测；别让 buildHeaders 拼出 Authorization: Bearer undefined
    apiKey: providerCfg.apiKey || 'local-not-needed',
  };

  const probe = async (label, fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, label, error: describe(err) };
    }
  };

  const failures = [];
  /* 覆盖项写坏了（proxyHeader/proxyBody 不是合法 JSON）时，用户**必须**能看见，
     否则他会对着一个"测试连接失败"反复改地址 —— 而真正被忽略的是这两段设置。
     走既有的 error 通道：成功时只在控制台留一份，失败时并进那句人话里。 */
  const notes = [];
  const warnedFields = new Set();
  const warnConfig = (field, message) => {
    /* 同一个字段只报一次：这条路上 buildHeaders 会被调到两次（/models 探测一次、
       探针 chat 一次），而两处读的是同一份配置 —— 不去重的话用户会在
       "测试连接失败"那句话里看到同一条警告重复两遍，像是出了两个问题。 */
    if (warnedFields.has(field)) return;
    warnedFields.add(field);
    notes.push(message);
    console.warn(`[llm] ${message}`);
  };
  let ids = [];

  if (adapter.format === 'anthropic') {
    const r = await probe('messages', () =>
      minimalChat(adapter, provider, timeoutMs, warnConfig)
    );
    if (r.ok) return done({ ok: true, models: [] });
    failures.push(`messages: ${r.error}`);
  } else {
    /* fullUrl 时 baseUrl 指向的是一个**完整端点**（如 `…/v1/chat/completions?key=x`），
       拿它去拼 /models 只会得到一个不存在的地址（`…/chat/completions/models`）：
       白白多一次必然失败的探测，还会把它的 404 混进最后的报错里，
       让人以为"地址配错了"—— 而地址恰恰是对的。直接跳到真端点探测。 */
    const modelsUrl =
      provider.fullUrl === true
        ? null
        : openai.withQueryAuth(adapter.modelsUrl(provider.baseUrl), provider);
    if (modelsUrl) {
      const r = await probe('models', async () => {
        const res = await fetchOnce({
          url: modelsUrl,
          method: 'GET',
          // 与 chat 完全同一套头（含 authField / userAgent / proxyHeader）：
          // 探测用一套、真调用用另一套，就是"测试连接能过、真生成过不了"的由来
          headers: adapter.buildHeaders(provider, { warn: warnConfig }),
          timeoutMs,
          scrub,
        });
        if (!res.ok) throw await buildHttpError(res, { url: modelsUrl, scrub });
        const data = await readJsonSafely(res, modelsUrl, scrub);
        const list = adapter.parseModels(data);
        if (!list.length) throw new LlmError('模型列表为空或格式不认识', { url: modelsUrl });
        return list;
      });
      if (r.ok) {
        ids = r.value;
        return done({ ok: true, models: ids });
      }
      failures.push(`GET /models: ${r.error}`);
    }
    const r2 = await probe('chat', () => minimalChat(adapter, provider, timeoutMs, warnConfig));
    if (r2.ok) return done({ ok: true, models: ids });
    failures.push(`chat/completions: ${r2.error}`);
  }

  return done({
    ok: false,
    models: [],
    error: [...notes, failures.join('；') || '未知错误'].join('；'),
  });
}

/**
 * 从 provider.models 里取第一个模型的 **id**（字符串），没有就返回 ''。
 *
 * ⚠️ 1.4.0 起这一步的形状变了：`store.providerConfig().models` 是**对象数组**
 * （`{id, name, contextLimit, maxOutput, vision}`），从前是字符串数组。
 * 还照老样子写 `models[0]` 的话，会把**一整个对象**当成模型名发出去 ——
 * 端点收到的 `model` 是 `[object Object]`（JSON 里干脆就是个对象），回 404「模型不存在」，
 * 而用户手里明明填着正确的模型名，只会觉得是工具坏了。
 * 这条路径平时碰不到：只有 `GET /models` 不可用、退化到 chat 探针时才走到。
 * 老形状（字符串数组）也要继续认：导入的旧设置、.env、手写配置都还可能给字符串。
 * 容忍规则与 `pipeline/index.js` 的 `modelCfgOf` 保持一致。
 */
function firstModelId(list) {
  if (!Array.isArray(list)) return '';
  for (const m of list) {
    if (typeof m === 'string' && m.trim()) return m.trim();
    if (m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim()) return m.id.trim();
  }
  return '';
}

/** 一次 max_tokens:1 的最小调用，只验信道与凭据，不计较内容 */
async function minimalChat(adapter, provider, timeoutMs, warn) {
  const scrub = makeScrubber(provider.apiKey);
  const norm = adapter.normalizeMessages({
    system: 'ping',
    messages: [{ role: 'user', content: 'ping' }],
  });
  /* ⚠️ 必须走 buildRequest（= 与 chat() 同一条路）：探测要是用了另一套 URL/头/体，
     "测试连接"通过的配置在真生成时可能因为同一处差异直接 401/400 —— 而用户已经
     被那个绿色的"连接正常"骗过一次了。 */
  const req = buildRequest(adapter, provider, {
    /* 探针模型要优先用**用户自己配的**，最后才轮到写死的兜底。
       以前只写 `provider.model || defaultProbeModel()`，而 `store.providerConfig()` 返回的对象里
       **没有 `model` 字段**（只有 `models` 数组），所以永远落到写死的 `gpt-4o-mini`。
       后果：当 `GET /models` 不可用、退化到 chat 探针时，会拿着 `gpt-4o-mini` 去问一个只认自家模型的端点
       → 404 → 用户看到"模型 `gpt-4o-mini` 不存在"——一个他**从没输入过**的模型名，
       而他的配置其实完全正确。
       （`provider.models` 的形状有两种，取 id 的活儿交给 firstModelId，
         别在这里直接下标取 —— 见那个函数上的说明。） */
    model: provider.model || firstModelId(provider.models) || adapter.defaultProbeModel(provider),
    system: norm.system,
    messages: norm.messages,
    maxTokens: 1,
    temperature: 0,
    json: false,
    stream: false,
    warn, // proxyHeader/proxyBody 写坏了要能说出来（这条路的调用方负责展示）
  });
  const url = req.url;
  const res = await fetchOnce({
    url,
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    timeoutMs,
    scrub,
  });
  // buildHttpError / buildNetworkError 内部都洗 url（authField:'query' 时它带 Key）
  if (!res.ok) throw await buildHttpError(res, { url, scrub });
  await readJsonSafely(res, url, scrub); // 顺带确认响应体可解析
  return true;
}

function describe(err) {
  if (err instanceof LlmError) return err.summary;
  return (err && err.message) || String(err);
}

module.exports = {
  // 契约
  chat,
  testConnection,
  // 自测 / 上层复用
  parseJsonLoose,
  joinUrl: openai.joinUrl,
  normalizeBase: openai.normalizeBase,
  // 请求覆盖项的几个纯函数（自测/审计直接调，不必再伪造一次请求）
  normalizeFullUrl: openai.normalizeFullUrl,
  withQueryAuth: openai.withQueryAuth,
  applyProxyBody: openai.applyProxyBody,
  applyHeaderOverrides: openai.applyHeaderOverrides,
  maskKey,
  makeScrubber,
  anySignal,
  backoffDelay,
  isLocalBase,
  LlmError,
  adapters: ADAPTERS,
  resolveFormat,
  // 常量
  DEFAULT_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
  RETRY_DELAYS,
  RETRYABLE_STATUS,
};

/*__ISG_BUNDLE_END__*/};
  global.__isgLogic = {
    require: require,
    setEnv: function (e) { shims.setEnv(e); },
    setJobId: function (id) { shims.setJobId(id); },
    cancelJob: function (id) { var j = require('jobs'); if (j && j._cancelLocal) j._cancelLocal(id); },
    env: function () { return currentEnv; },
    version: ["bank.js:88004fc22eda","assemble.js:198df91bf4b9","prompts.js:8a8bd525839b","sources.js:3e37152aefc8","chapters.js:e87b49cfbfe8","revive.js:b040dceb2782","book.js:b4e66cc3d6ec","pipeline.js:168511e8acad","providers.js:a5e3ed0caab8","llm-openai.js:dd071cf76bfc","llm-anthropic.js:fab244b50d0f","llm-index.js:1f58eb954195"]
  };
})(typeof window !== 'undefined' ? window : this);
