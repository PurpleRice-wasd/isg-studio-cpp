'use strict';
/* 渲染层与宿主之间**唯一**的桥。
 *
 * 这是 C++ 工程新增的文件（oracle 里没有对应物）—— oracle 的对应物是 Electron 的
 * `preload.js`（contextBridge）+ `ipcRenderer`。两边要对外**长得一模一样**：
 * `window.isg` 上挂着同样那 31 个方法，每个都返回一个 Promise，**resolve 出来的是
 * 宿主给的 `{ok,data}` / `{ok:false,error}` 信封**（不是 reject —— 见 ipc.js 顶部：
 * 错误跨边界之后只剩 message，code/detail 全丢，所以错误一律走正常返回）。
 *
 * 为什么不把 ipcRenderer 那一套照搬过来：WebView2 里没有 contextBridge，也没有
 * 同步的 ipcRenderer.invoke。可用的只有 `chrome.webview.postMessage`（异步）与
 * 宿主注入的 host object（要做 IDispatch，且拿不到 File → 路径的映射）。
 * 所以这里自己做一张**请求/响应编号表** —— 而且**只做这一份**（纲领 §4.3：
 * "这一跳只允许有一个实现，不许各视图自己拼接"）。
 *
 * ⚠️ 一句话的规矩：**这里只做转发，不做判断**。
 * 白名单（http/https、可打开的文件类型、放行目录）全在宿主侧 —— 页面侧的判断
 * 一旦被绕过（模型产出的页面也跑在同一个 webview 里）就等于没有。
 */
(function () {
  // 幂等：万一这份脚本被加载了两次（宿主注入 + 页面 <script>），第二次直接退出。
  // 不这么写的话，第二次 defineProperty 一个不可配置的属性会抛错，而那会连带
  // 把后面所有脚本的行都打断。
  if (window.isg) return;

  var bridge = window.chrome && window.chrome.webview;
  if (!bridge) {
    // 宿主没接上时**要说出来**：页面里所有按钮都会失败，而失败若无声，
    // 用户看到的是"点了没反应"，查起来比报错难十倍。
    window.__isgBridgeError = '这个页面不是在工作台里打开的（没有 chrome.webview）';
    return;
  }

  var MAGIC = 1;
  var nextId = 1;
  var pending = {};          // id → {resolve, reject}
  var listeners = [];        // job:event 的订阅者

  function post(obj) {
    bridge.postMessage(JSON.stringify(obj));
  }

  /** 一次 invoke。**永不 reject** —— 失败以 `{ok:false,error}` 的形式 resolve。 */
  function invoke(channel, args) {
    return new Promise(function (resolve) {
      var id = nextId++;
      pending[id] = { resolve: resolve, channel: channel };
      try {
        post({ __isg: MAGIC, kind: 'invoke', id: id, channel: channel, args: args || [] });
      } catch (e) {
        delete pending[id];
        resolve({ ok: false, error: { code: 'POST_FAILED', message: String(e && e.message || e) } });
      }
    });
  }

  /** 一次成功回包的统一出口（普通与分块共用）。 */
  function finishOk(p, data) {
    /* 设置变了 → 流水线预热的那份 skill/契约/provider 快照就过期了。
       不失效的话，用户改完 Base URL / Key 再点「测试连接」或「开始生成」，
       用的仍是**上一次**的配置（症状是"设置改了没用，重启才好"）。 */
    if ((p.channel === 'settings:save' || p.channel === 'settings:import')
        && typeof window.__isgPipelineInvalidate === 'function') {
      try { window.__isgPipelineInvalidate(); } catch (e) {}
    }
    p.resolve({ ok: true, data: data === undefined ? null : data });
  }

  bridge.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (e) { return; }
    }
    if (!msg || msg.__isg !== MAGIC) return;

    if (msg.kind === 'reply') {
      var p = pending[msg.id];
      if (!p) return;                     // 已经超时或被丢弃的请求
      /* 大结果（抽取结果、任务快照、模型列表的极端情况）分块传：
         单条 WebView2 消息有大小限制（实测 161 KB 收不到），超过时**静默丢失**，
         Promise 永远不 settle。C++ 侧在超过 48 KB 时发 chunked 头 + 若干块 + end。 */
      if (msg.ok && msg.chunked) {
        p.chunks = [];
        return;
      }
      delete pending[msg.id];
      if (msg.ok) {
        finishOk(p, msg.data === undefined ? null : msg.data);
      } else {
        p.resolve({ ok: false, error: msg.error || { message: '宿主返回了失败信封，但没带原因' } });
      }
      return;
    }
    if (msg.kind === 'reply-chunk') {
      var pc = pending[msg.id];
      if (pc && pc.chunks) pc.chunks.push(String(msg.data || ''));
      return;
    }
    if (msg.kind === 'reply-end') {
      var pe = pending[msg.id];
      if (!pe || !pe.chunks) return;
      var chunks = pe.chunks;
      delete pending[msg.id];
      try {
        var dec = new TextDecoder('utf-8');
        var text = '';
        for (var ci = 0; ci < chunks.length; ci++) {
          var bin = atob(chunks[ci]);
          var u8 = new Uint8Array(bin.length);
          for (var bi = 0; bi < bin.length; bi++) u8[bi] = bin.charCodeAt(bi);
          text += dec.decode(u8, { stream: true });
        }
        text += dec.decode();
        finishOk(pe, JSON.parse(text));
      } catch (e) {
        pe.resolve({ ok: false, error: { code: 'BAD_CHUNK', message: '分块回包拼不起来：' + (e && e.message) } });
      }
      return;
    }

    if (msg.kind === 'event') {
      // 回调**拿不到事件对象**（那上面有 sender 之类的能力），只拿 payload；
      // 一个订阅者抛错不能影响其它订阅者。
      listeners.slice().forEach(function (l) {
        if (l.name !== msg.name) return;
        try { l.cb(msg.payload); } catch (e) { console.error('[isg] 事件回调抛错：', e); }
      });
    }
  });

  /* ---------------- 拖拽：File → 真实磁盘路径 ----------------
   *
   * ⚠️ 与 Electron 的 `webUtils.getPathForFile` **不同，这里是异步的**。
   * 原因：WebView2 里唯一能拿到路径的口子是"页面在 drop 事件处理过程中 postMessage，
   * 宿主从这条消息的 AdditionalObjects 里取 ICoreWebView2File"—— 那是一次往返，
   * 没有同步 API。所以渲染层的 acceptFile 里那一处改成了能接受 Promise
   * （见 tools/web-patches.json 的第 2、3 处补丁）。
   *
   * 宿主回的是**这次拖进来的全部路径**（它没有"哪个 File 对应哪个路径"的信息），
   * 所以按文件名配一次；同名多个时取第一个。拿不到就返回空串，由渲染层给出人话提示。
   */
  /** 一次"桥自己的方法"调用（kind='api'）——**不是** IPC 通道，所以不走通道表。 */
  function apiCall(name, args) {
    return new Promise(function (resolve) {
      var id = nextId++;
      pending[id] = { resolve: resolve, channel: null };
      try {
        post({ __isg: MAGIC, kind: 'api', id: id, name: name, args: args || [] });
      } catch (e) {
        delete pending[id];
        resolve({ ok: false, error: { code: 'POST_FAILED', message: String(e && e.message || e) } });
      }
    });
  }

  function pathForFile(file) {
    var wanted = (file && file.name) ? String(file.name) : '';
    return Promise.resolve(
      apiCall('pathForFile', []).then(function (res) {
        var list = (res && res.ok && Array.isArray(res.data)) ? res.data : [];
        if (!list.length) return '';
        if (!wanted) return list[0];
        for (var i = 0; i < list.length; i++) {
          var p = String(list[i]);
          var base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
          if (base === wanted) return p;
        }
        // 名字对不上（改了名、或者拖的是虚拟文件）：只有一个候选时仍然当它是它
        return list.length === 1 ? list[0] : '';
      })
    );
  }

  /** 订阅任务事件，返回取消订阅函数。
   *  ⚠️ **必须同步返回**（渲染层是 `call('onJobEvent', cb)` 直接当值用的），
   *  所以这里不能用 Promise。 */
  function onJobEvent(cb) {
    if (typeof cb !== 'function') return function () {};
    var entry = { name: 'job:event', cb: cb };
    listeners.push(entry);
    return function off() {
      var i = listeners.indexOf(entry);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* 通道名写死在这里（与宿主侧 src/bridge/channels.h 一一对应）。
     页面改不了、也不用去猜 —— 打错一个名字宿主会明确回 UNKNOWN_CHANNEL，
     而不是静默失败。 */
  var isg = {
    /* ---- 应用 ---- */
    appInfo: function () { return invoke('app:info'); },
    openPath: function (p) { return invoke('app:openPath', [p]); },
    openExternal: function (url) { return invoke('app:openExternal', [url]); },
    revealPath: function (p) { return invoke('app:revealPath', [p]); },
    previewUrl: function (p) { return invoke('app:previewUrl', [p]); },
    registerPath: function (p) { return invoke('app:registerPath', [p]); },
    takePendingFile: function () { return invoke('app:takePendingFile'); },

    /* ---- 选文件 ---- */
    pickFile: function () { return invoke('dialog:pickFile'); },
    pickOutputDir: function () { return invoke('dialog:pickOutputDir'); },
    pickImage: function () { return invoke('dialog:pickImage'); },

    /* ---- 背景图 ---- */
    backgroundInfo: function () { return invoke('bg:info'); },
    importBackground: function () { return invoke('bg:import'); },
    clearBackground: function () { return invoke('bg:clear'); },

    /* ---- 设置 ---- */
    getSettings: function () { return invoke('settings:get'); },
    saveSettings: function (patch) { return invoke('settings:save', [patch]); },
    testConnection: function (providerId) { return invoke('settings:test', [providerId]); },
    exportSettings: function () { return invoke('settings:export'); },
    importSettings: function () { return invoke('settings:import'); },

    /* ---- 生成 ---- */
    startGeneration: function (input) { return invoke('gen:start', [input]); },
    cancelGeneration: function (jobId, opts) { return invoke('gen:cancel', [jobId, opts]); },
    answerGeneration: function (jobId, askId, value) {
      return invoke('gen:answer', [{ jobId: jobId, askId: askId, value: value }]);
    },
    getJob: function (jobId) { return invoke('gen:get', [jobId]); },
    listJobs: function () { return invoke('gen:list'); },

    /* ---- 收尾 ---- */
    scanCleanup: function (jobId) { return invoke('run:scanCleanup', [jobId]); },
    doCleanup: function (arg) { return invoke('run:doCleanup', [arg]); },

    /* ---- 带上一章 ---- */
    listBookChapters: function () { return invoke('book:list'); },
    pickBookFile: function () { return invoke('book:pickFile'); },
    inspectBookChapter: function (desc) { return invoke('book:inspect', [desc]); },
    bookContinuity: function (arg) { return invoke('book:continuity', [arg]); },

    /* ---- 抽取与校验 ---- */
    previewExtract: function (filePath) { return invoke('extract:preview', [filePath]); },
    verifyHtml: function (htmlPath, probes) {
      /* 宿主只回**原始读数**（title / DOM 快照 / 错误表）；报告的形状与口径在
         probe-parse.js 里（那一份是从 oracle runner.js 逐函数搬来的）。
         解析放在页面侧，宿主与页面就只有一个"什么叫通过"的实现。 */
      return invoke('verify:run', [{ htmlPath: htmlPath, probes: probes }]).then(function (res) {
        if (!res || !res.ok || !res.data) return res;
        var parser = window.__isgProbeParse;
        if (!parser) {
          return { ok: false, error: { code: 'NO_PARSER', message: 'probe-parse.js 没加载，校验报告没法解析' } };
        }
        return { ok: true, data: parser.buildReport(res.data) };
      });
    },

    /* ---- 桥自己的两个方法（**不是** IPC 通道）---- */
    pathForFile: pathForFile,
    onJobEvent: onJobEvent
  };

  /* 宿主内部通道（**不属于 31 个 window.isg 通道**）。
     只给同目录的 pipeline-host.js 用：预热 skill/契约、分块取任务快照、测试连接等。
     它不做任何页面可见的能力扩展 —— 通道表仍然是那 31 条，这一层只是宿主 ↔ 页面的内部往返。
     为什么不放进 `isg`：那 31 条是对渲染层的契约，也是 phase1-verify 的判据；
     把内部通道混进去会让"通道数是 31"这个数失去意义。 */
  Object.defineProperty(window, '__isgHost', {
    value: {
      invoke: function (channel, args) { return invoke(channel, args || []); },
      post: function (obj) { post(obj); },
      reply: function (id, ok, dataOrError) {
        var msg = { __isg: MAGIC, kind: 'host-reply', id: id, ok: !!ok };
        if (ok) msg.data = dataOrError === undefined ? null : dataOrError;
        else msg.error = dataOrError || { code: 'PAGE_ERROR', message: '页面没有说明原因' };
        post(msg);
      }
    },
    writable: false,
    configurable: false
  });

  Object.defineProperty(window, 'isg', { value: isg, writable: false, configurable: false });
})();
