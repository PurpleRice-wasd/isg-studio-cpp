/* ============================================================
   app.js —— 只做四件事：
   1) 状态容器  2) 视图路由(location.hash)  3) job:event 订阅与分发
   4) 通用工具(el / fmtBytes / toast / icon / modal / copy)
   具体界面一律在 views/*.js。
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 通用工具 ---------------- */

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return; }
    if (children instanceof Node) { node.appendChild(children); return; }
    node.appendChild(document.createTextNode(String(children)));
  }

  /** el('div',{class:'x',on:{click:fn}}, [孩子…]) */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { for (var d in v) node.dataset[d] = v[d]; }
        else if (k === 'style') {
          if (typeof v === 'string') node.setAttribute('style', v);
          else for (var s in v) node.style[s] = v[s];
        }
        else if (k === 'on') { for (var e in v) if (typeof v[e] === 'function') node.addEventListener(e, v[e]); }
        else if (k === 'for') node.htmlFor = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  var ICONS = {
    grid: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
    play: ['M8 5v14l11-7z'],
    check: ['M4 12.5l5 5L20 6.5'],
    checkSquare: ['M4 4h16v16H4z', 'M8 12.5l2.5 2.5L16 9.5'],
    sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5'],
    info: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 16.5v-4.8M12 8h.01'],
    file: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
    folder: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
    upload: ['M12 16V4M7 9l5-5 5 5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2'],
    eye: ['M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
    eyeOff: ['M3 3l18 18', 'M10.6 6.2A9.6 9.6 0 0112 6c6.4 0 10 6 10 6a17 17 0 01-2.9 3.6M6.7 7.5A17 17 0 002 12s3.6 6 10 6a9.9 9.9 0 004.3-.9M9.9 9.9a3 3 0 004.2 4.2'],
    plus: ['M12 5v14M5 12h14'],
    trash: ['M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a1 1 0 001 .9h7.2a1 1 0 001-.9L17.5 7'],
    refresh: ['M20.5 12a8.5 8.5 0 11-2.6-6.1M21 3.5V9h-5.5'],
    copy: ['M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1z', 'M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1'],
    x: ['M5 5l14 14M19 5L5 19'],
    alert: ['M12 3l9.5 17.2H2.5z', 'M12 9.5v4.4M12 17h.01'],
    chevron: ['M6 9l6 6 6-6'],
    external: ['M14 4h6v6M20 4l-8.5 8.5M18 14.5V19a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h4.5'],
    image: ['M4 5h16v14H4z', 'M4 16l4.5-4.5 4 4 3-3L20 16', 'M9 9.5a1 1 0 100-2 1 1 0 000 2z'],
    layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
    wand: ['M15 4V2M15 22v-2M4.9 4.9L6.3 6.3M19.8 19.8l1.4 1.4M4 15H2M22 15h-2M4.9 19.8l1.4-1.4M19.8 4.9L21.2 3.5', 'M12 13l4-8 4 8-8 4-4 8-4-8 8-4z'],
    key: ['M21 2l-9.6 9.6', 'M15.5 7.5l3 3', 'M10.7 12.4a4.6 4.6 0 10-3.3 7.6 4.6 4.6 0 003.3-7.6z'],
    book: ['M4 4h6a3 3 0 013 3v13a2.5 2.5 0 00-2.5-2.5H4z', 'M20 4h-6a3 3 0 00-3 3v13a2.5 2.5 0 012.5-2.5H20z'],
    download: ['M12 4v12M7 11l5 5 5-5M4 19h16'],
    dot: ['M8 5v14l11-7z'],
    clock: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 7.5V12l3 2']
  };
  var FILLED = { play: true, dot: true };

  function icon(name, size) {
    var paths = ICONS[name] || ICONS.info;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
    if (FILLED[name]) { svg.setAttribute('fill', 'currentColor'); svg.setAttribute('stroke', 'none'); }
    else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.8');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    paths.forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  function fmtTime(ts) {
    var d = ts ? new Date(ts) : new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDateTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function textOf(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    var s = err.message || String(err);
    if (err.stack) s += '\n\n' + err.stack;
    return s;
  }

  function clip(s, n) {
    s = String(s === undefined || s === null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function copyText(text) {
    return new Promise(function (resolve) {
      var s = String(text === undefined || text === null ? '' : text);
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = s;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          resolve(!!ok);
        } catch (e) { resolve(false); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(s).then(function () { resolve(true); }, fallback);
        } else fallback();
      } catch (e) { fallback(); }
    });
  }

  /* ---------------- 状态容器 ---------------- */

  var SUPPORTED_EXT = ['.pptx', '.ppsx', '.pdf', '.txt', '.md', '.markdown'];

  /* 材料的角色。
     ⚠️ `ROLES` 里这四个字符串是**跨进程的字段值**——它原样进 `sources[].role`，
     主进程 `pipeline/sources.js` 拿它做白名单校验，认不出就当场 BAD_ARG 打回整单。
     所以**界面上的中文标签和它必须分开存**：改文案时改 ROLE_LABEL，
     千万别顺手把 role 也改成「课件」（同一个角色可以有多份，历年真题通常好几份，
     但四份材料不能都是同一个 role 里的同一件事——角色错了，融合时的权重也错了）。 */
  var ROLES = ['courseware', 'textbook', 'exercises', 'exampaper'];
  var ROLE_LABEL = { courseware: '课件', textbook: '课本', exercises: '习题', exampaper: '历年真题' };
  var ROLE_HINT = {
    courseware: '老师上课用的 PPT / 讲义，这一章讲什么以它为准',
    textbook: '教材，用来补细节、对术语、定范围（整本太大时，建议先裁成这一章的 PDF）',
    exercises: '课后题、练习册，用来出题和校准难度',
    exampaper: '往年卷子，用来对题型和考法。几份可以一起放进来'
  };
  // 新材料的默认角色。拖进来的第一份通常就是课件；选错了在清单里改一下即可。
  var DEFAULT_ROLE = 'courseware';
  var STAGE_DEFS = [
    { key: 'extract', label: '抽取' },
    // 多来源才有这一步（每份材料各一次独立分析）；单来源时后端会把它标成 skipped
    { key: 'analyze', label: '逐来源分析' },
    { key: 'plan', label: '规划' },
    { key: 'content', label: '生成内容' },
    { key: 'demo', label: '生成演示' },
    { key: 'assemble', label: '拼装' },
    { key: 'verify', label: '校验' },
    { key: 'repair', label: '修复' }
  ];
  var LOG_CAP = 1500;

  function defaultOptions() {
    return {
      units: 6,
      quizTarget: 65,
      demos: 2,
      // 默认启用陪练（内置大肥鱼）。用户已明确：陪练「到处都在」，每页都默认开，
      // 不要做「逐页问要不要」的配置——那这个默认值就不该是 none。
      pet: 'fish',          // none | fish | own
      // 题目审校人数 0–3：0 关掉；1 一位审题人独立重算；2–3 是交叉检验（互不可见）。
      // 默认 1——比"完全不查"安全，又只多花一次调用。
      auditors: 1,
      // 生成内容的语言。默认简体中文（这套材料是给中文学生看的，而课件原文可能是英文）。
      language: 'zh-CN',    // zh-CN | follow（跟随课件语言）
      outputDir: '',
      subject: '',
      chapterNo: '',
      chapterTitle: ''
    };
  }

  var state = {
    route: 'workbench',
    /* 材料清单。以前这里是**单槽**（filePath/fileName/fileSize/fileKind/extract/…），
       一份课件一套字段；多来源之后一份材料一套字段，只能挪进数组里。
       每项：{id, role, filePath, fileName, fileSize, fileKind, extract, extractError, extractLoading}。
       ⚠️ `id` 不是装饰：`extractEdits` 的键要用它做命名空间（页号在多来源下必然重复），
       发给主进程的 `editedPages[].sourceId` 也用它。**加了就不能再改**。 */
    sources: [],
    extractEdits: {},          // `${sourceId}:${pageIndex}` -> 用户改过的文本
    /* 「这次怎么出」：把所有章合成**一份** HTML，还是**每章一份**。
       ⚠️ 它是**显式字段**，即使等于默认值也照发 —— 见 HANDOFF 里那条教训：
       "界面到底发没发它"在排查时看不出来，是接缝 bug 的温床。 */
    mode: 'book',              // book | separate
    /* 「带上以前的章节（可选）」的已选区。课是一节一节上的：这次只讲今天这一章，
       但可以把以前生成过的页面一起带上，让它们和今天这一章**合成一册**。
       数组顺序 = 新页面里的章顺序（以前的老章在前，这次新生成的接在最后）。
       每项形状见 carryDesc 上面那段注释。 */
    carry: [],
    /* 一册的名字。留空 → 主进程退回用第一章的标题（见 pipeline 的 bookOutName），
       所以界面**不要**替用户填默认值：填了就等于把"自动"变成"钉死"。
       它同时决定页头标题与输出文件名。 */
    bookTitle: '',
    carryOpen: false,          // 结果页的「并进一册」入口 → 回到工作台时把选择器直接展开
    options: defaultOptions(),
    jobId: null,
    job: null,
    htmlPath: null,
    report: null,
    settings: null,
    settingsLoaded: false,
    settingsError: null,
    appInfo: null,
    theme: 'auto',
    lastOutputDir: ''
  };

  function blankJob(id) {
    return {
      id: id || '',
      title: '',
      status: 'pending',      // pending|running|done|error|cancelled
      stages: STAGE_DEFS.map(function (d) { return { key: d.key, label: d.label, status: 'pending', note: '' }; }),
      log: [],
      out: '',
      sub: { key: null, done: 0, total: 0 },
      /* 「现在跑到第几章」（一册多章时才有；`{index,total,no}`）。单章时恒为 null，
         运行页据此**一个字的文案都不变**。 */
      chapterNow: null,
      error: null,
      result: null,
      startedAt: null,
      /* 中途提问（流水线跑到一半要问用户一句，例如"这两章关联很大，要不要关联生成"）。
         形状 `{id, title, message, options:[{value,label,detail}], default}`；没有待答问题时是 null。
         它进任务快照（主进程那边也进），所以刷新/切页面回来还看得到那个问题。 */
      ask: null
    };
  }

  function stageOf(job, key, label) {
    for (var i = 0; i < job.stages.length; i++) if (job.stages[i].key === key) return job.stages[i];
    var s = { key: key, label: label || key, status: 'pending', note: '' };
    job.stages.push(s);
    return s;
  }

  function normStatus(s) {
    s = String(s || '').toLowerCase();
    if (s === 'done' || s === 'ok' || s === 'success' || s === 'complete' || s === 'completed' || s === 'finish' || s === 'finished') return 'done';
    if (s === 'running' || s === 'start' || s === 'started' || s === 'active' || s === 'progress') return 'running';
    if (s === 'error' || s === 'failed' || s === 'fail' || s === 'exception') return 'error';
    if (s === 'skip' || s === 'skipped' || s === 'cancel' || s === 'cancelled') return 'skip';
    return s || 'pending';
  }

  /** 把主进程给的原始 job 合并进本地模型（字段名容错） */
  function mergeJob(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var job = blankJob(raw.id || raw.jobId);
    job.raw = raw;
    job.title = raw.title || (raw.options && (raw.options.chapterTitle || raw.options.title)) || raw.fileName || '';
    job.startedAt = raw.startedAt || raw.createdAt || null;
    var st = String(raw.status || '').toLowerCase();
    if (st === 'done' || st === 'completed' || st === 'success' || (!st && raw.result && (raw.result.htmlPath || raw.htmlPath))) job.status = 'done';
    else if (st === 'error' || st === 'failed') job.status = 'error';
    else if (st === 'cancelled' || st === 'canceled') job.status = 'cancelled';
    else if (st === 'running' || st === 'active' || st === 'progress') job.status = 'running';
    else job.status = 'pending';
    if (raw.stages) {
      var src = Array.isArray(raw.stages) ? raw.stages : Object.keys(raw.stages).map(function (k) {
        var v = raw.stages[k];
        return (v && typeof v === 'object') ? Object.assign({ key: k }, v) : { key: k, status: v };
      });
      src.forEach(function (s) {
        if (!s || !s.key) return;
        var mine = stageOf(job, s.key, s.label);
        if (s.label) mine.label = s.label;
        if (s.status) mine.status = normStatus(s.status);
        if (s.note || s.detail) mine.note = s.note || s.detail;
      });
    }
    // 快照里的日志字段叫 logs（jobs.js），事件里的叫 log —— 两种都认
    var rawLogs = Array.isArray(raw.logs) ? raw.logs : (Array.isArray(raw.log) ? raw.log : null);
    if (rawLogs) {
      job.log = rawLogs.map(function (l) {
        if (typeof l === 'string') return { level: 'info', message: l, ts: null };
        return {
          level: l.level || 'info',
          message: l.message === undefined || l.message === null ? (l.text || '') : String(l.message),
          ts: l.ts || l.at || l.time || null,
          detail: l.detail
        };
      }).slice(-LOG_CAP);
    }
    /* 中途提问：快照里叫 `ask`（jobs.js 的 snapshot 会带上它）。
       必须是 `hasOwnProperty` 而不是真值判断 —— 用户答完之后主进程把 `ask` 置回 `null`，
       那时得**把本地那份也清掉**，否则界面上那个问题会一直挂着、点第二次就没反应了。 */
    if (Object.prototype.hasOwnProperty.call(raw, 'ask')) job.ask = raw.ask || null;
    if (raw.error) job.error = { message: (raw.error && raw.error.message) || String(raw.error), stack: raw.error && raw.error.stack };
    if (raw.result) job.result = raw.result;
    // 快照把产物摊在顶层（htmlPath / report / outputDir），result 里也要有一份
    var extra = {};
    if (raw.htmlPath) extra.htmlPath = raw.htmlPath;
    if (raw.report) extra.report = raw.report;
    if (raw.outputDir) extra.outputDir = raw.outputDir;
    if (Object.keys(extra).length) job.result = Object.assign({}, job.result || {}, extra);
    if (job.status === 'done') {
      job.stages.forEach(function (s) { if (s.status === 'pending') s.status = 'skip'; });
    }
    return job;
  }

  function applyJobEvent(job, ev) {
    if (!job || !ev) return;
    var t = String(ev.type || ev.kind || '').toLowerCase();

    if (t === 'stage' || t === 'step' || t === 'phase') {
      var s = stageOf(job, ev.key || ev.stage || ev.name, ev.label);
      if (ev.label) s.label = ev.label;
      s.status = normStatus(ev.status || ev.state);
      if (ev.note || ev.detail || ev.message) s.note = ev.note || ev.detail || ev.message;
      if (typeof ev.index === 'number' && typeof ev.total === 'number') {
        job.sub = { key: s.key, done: ev.index, total: ev.total };
      } else if (typeof ev.done === 'number' && typeof ev.total === 'number') {
        job.sub = { key: s.key, done: ev.done, total: ev.total };
      }
      /* 「现在跑到第几章」（一册多章时主进程才会带）。运行页靠它把"第二章又从 0 开始"
         解释清楚，并把进度条按整册算（否则计数从 4/4 跳回 0/4，看着就是进度倒退）。 */
      if (ev.chapter && typeof ev.chapter === 'object') {
        job.chapterNow = { index: Number(ev.chapter.index) || 1, total: Number(ev.chapter.total) || 1, no: String(ev.chapter.no || '') };
      }
      if (s.status === 'error') { job.status = 'error'; job.error = job.error || { message: s.note || (s.label + '阶段失败') }; }
      else if (s.status === 'running') job.status = 'running';
      return;
    }
    if (t === 'sub' || t === 'progress' || t === 'unit' || t === 'subprogress') {
      job.sub = {
        key: ev.key || ev.stage || 'content',
        done: typeof ev.done === 'number' ? ev.done : (typeof ev.index === 'number' ? ev.index : job.sub.done),
        total: typeof ev.total === 'number' ? ev.total : job.sub.total
      };
      return;
    }
    if (t === 'log' || t === 'message') {
      // jobs.js 广播的是 {type:'log', entry:{at,level,message}}；老写法直接读 ev.message
      // 会拿到 undefined —— 那样运行页每一行日志都是空白。
      var entry = (ev.entry && typeof ev.entry === 'object') ? ev.entry : ev;
      var msg = entry.message !== undefined && entry.message !== null ? String(entry.message)
        : (ev.text !== undefined && ev.text !== null ? String(ev.text) : '');
      job.log.push({ level: entry.level || ev.level || 'info', message: msg, ts: entry.at || entry.ts || ev.ts || Date.now() });
      if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
      return;
    }
    if (t === 'delta' || t === 'chunk' || t === 'stream') {
      var piece = (ev.text !== undefined) ? ev.text : (ev.delta !== undefined ? ev.delta : ev.content);
      if (piece) {
        job.out += String(piece);
        if (job.out.length > 300000) job.out = '(…已截断前段…)\n' + job.out.slice(-200000);
      }
      if (ev.stage) job.outStage = ev.stage;
      return;
    }
    if (t === 'done' || t === 'complete' || t === 'finished') {
      // jobs.js 的 fail() 发的也是 {type:'done', status:'failed', error}：
      // 不看 ev.status 就会把"失败"显示成"已完成"再跳去空结果页。
      var endStatus = String(ev.status || '').toLowerCase();
      if (endStatus === 'failed' || endStatus === 'fail' || endStatus === 'error') {
        job.status = 'error';
        job.error = {
          message: (ev.error && ev.error.message) || ev.message || '任务失败了，主进程没有给出原因',
          stack: (ev.error && ev.error.stack) || ev.stack || '',
          stage: ev.key || ev.stage || ''
        };
        // 主进程报错时往往来不及把当前阶段标成 failed，在这里补上，别留一个转不停的圈
        job.stages.forEach(function (x) { if (x.status === 'running') x.status = 'error'; });
        if (job.error.stage) stageOf(job, job.error.stage).status = 'error';
        return;
      }
      if (endStatus === 'canceled' || endStatus === 'cancelled') {
        job.status = 'cancelled';
        job.stages.forEach(function (x) { if (x.status === 'running') x.status = 'pending'; });
        return;
      }
      job.status = 'done';
      if (ev.result && typeof ev.result === 'object') job.result = ev.result;
      var donePatch = {};
      if (ev.htmlPath) donePatch.htmlPath = ev.htmlPath;
      if (ev.report) donePatch.report = ev.report;         // jobs.finish 把报告放在事件顶层
      if (Object.keys(donePatch).length) job.result = Object.assign({}, job.result || {}, donePatch);
      job.stages.forEach(function (x) { if (x.status === 'pending' || x.status === 'running') x.status = 'done'; });
      if (!job.sub.total) job.sub = { key: null, done: 0, total: 0 };
      return;
    }
    if (t === 'error' || t === 'fail' || t === 'failed') {
      job.status = 'error';
      job.error = {
        message: ev.message || (ev.error && ev.error.message) || '任务失败',
        stack: ev.stack || (ev.error && ev.error.stack) || '',
        stage: ev.key || ev.stage || ''
      };
      if (job.error.stage) stageOf(job, job.error.stage).status = 'error';
      return;
    }
    if (t === 'cancel' || t === 'cancelled' || t === 'canceled') {
      job.status = 'cancelled';
      job.stages.forEach(function (x) { if (x.status === 'running') x.status = 'pending'; });
      return;
    }
    if (t === 'status') { job.status = normStatus(ev.status); return; }
    if (t === 'result') { job.result = ev.result || ev; job.htmlPath = ev.htmlPath || (ev.result && ev.result.htmlPath); return; }
  }

  function jobOutputDir(job) {
    if (!job) return '';
    var r = job.result || {};
    return r.outputDir || r.dir || (r.htmlPath ? String(r.htmlPath).replace(/[\\/][^\\/]*$/, '') : '') || '';
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme(mode) {
    state.theme = (mode === 'light' || mode === 'dark') ? mode : 'auto';
    var root = document.documentElement;
    if (state.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);
    try { localStorage.setItem('isg.theme', state.theme); } catch (e) { /* 无 localStorage 也能跑 */ }
    var label = document.getElementById('themeLabel');
    if (label) label.textContent = state.theme === 'auto' ? '跟随系统' : (state.theme === 'light' ? '浅色' : '深色');
    var btn = document.getElementById('themeBtn');
    if (btn) btn.setAttribute('aria-label', '切换深浅色，当前：' + (state.theme === 'auto' ? '跟随系统' : state.theme === 'light' ? '浅色' : '深色'));
    emit('theme', state.theme);
  }
  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    applyTheme(order[(order.indexOf(state.theme) + 1) % order.length]);
    /* ⚠️ 侧栏按钮**必须落盘**，否则这个选择活不过一次重启。
       设置文件里的 `theme` 才是持久化的那一份（设置页的主题单选写的就是它），
       启动时 `getSettings()` 回来会无条件 `applyTheme(settings.theme)` ——
       只写 localStorage 的话，用户点成深色、下次打开又变回"跟随系统"。
       这里保持和设置页同一条保存路径（深合并，不会碰到还在草稿里的 provider 编辑）。 */
    var patch = { theme: state.theme };
    state.settings = Object.assign({}, state.settings, patch);
    call('saveSettings', patch).then(function (res) {
      if (res && res.ok && res.data) { state.settings = res.data; }
    });
  }
  function loadTheme() {
    var t = 'auto';
    try { t = localStorage.getItem('isg.theme') || 'auto'; } catch (e) { }
    applyTheme(t);
  }

  /* ---------------- 自定义背景图 ----------------
   *
   * 三个字段各有来源，**两条 IPC 谁先回来都不许覆盖对方**：
   *   · file / url / bytes ← backgroundInfo()（也可以由导入、移除的结果直接给）
   *   · scrim / blur       ← getSettings().ui.bgScrim / bgBlur
   * 所以 bgApply 是**合并**语义：只覆盖显式传进来的字段，其余保持原样。
   * 启动时 getSettings 和 backgroundInfo 是并发的，先到的那个不会把后到的冲掉。
   *
   * 另外：这一层是 app.js 建出来的，不在 index.html 里。这样 test/ui-preview.html
   * （另一份手写的 HTML）不用跟着改也能预览到同样的效果。
   */
  var BG_DEFAULT_SCRIM = 35, BG_DEFAULT_BLUR = 6;
  var bgState = { file: '', url: '', bytes: 0, scrim: BG_DEFAULT_SCRIM, blur: BG_DEFAULT_BLUR };
  var bgSeq = 0;                                  // 换图时让 URL 变一下，免得浏览器留着旧的解码结果

  function bgLayer() {
    var layer = document.getElementById('bgLayer');
    if (layer) return layer;
    layer = el('div', { class: 'bg-layer', id: 'bgLayer', 'aria-hidden': 'true' });
    layer.appendChild(el('div', { class: 'bg-img' }));
    layer.appendChild(el('div', { class: 'bg-scrim' }));
    if (document.body) document.body.insertBefore(layer, document.body.firstChild);
    return layer;
  }

  function clampInt(v, lo, hi, dv) {
    var n = Number(v);
    if (!isFinite(n)) return dv;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  /** 合并式应用：patch 里出现过的字段才动。返回当前完整状态。 */
  function bgApply(patch) {
    patch = patch || {};
    if (patch.file !== undefined) bgState.file = String(patch.file || '');
    if (patch.url !== undefined) { bgState.url = String(patch.url || ''); bgSeq++; }
    if (patch.bytes !== undefined) bgState.bytes = Number(patch.bytes) || 0;
    if (patch.scrim !== undefined) bgState.scrim = clampInt(patch.scrim, 0, 90, BG_DEFAULT_SCRIM);
    if (patch.blur !== undefined) bgState.blur = clampInt(patch.blur, 0, 24, BG_DEFAULT_BLUR);

    var d = document.documentElement;
    var layer = bgLayer();
    d.style.setProperty('--bg-blur', bgState.blur + 'px');
    d.style.setProperty('--bg-scrim', String(bgState.scrim));
    var on = !!bgState.url;
    if (on) {
      // JSON.stringify 出来的双引号字符串正好也是合法的 CSS 字符串，省得自己转义
      var url = bgState.url + (bgState.url.indexOf('?') < 0 ? '?' : '&') + 'v=' + bgSeq;
      layer.firstChild.style.backgroundImage = 'url(' + JSON.stringify(url) + ')';
      layer.hidden = false;
      d.setAttribute('data-bg', '1');
    } else {
      layer.firstChild.style.backgroundImage = 'none';
      layer.hidden = true;
      d.removeAttribute('data-bg');
    }
    emit('background', bgState);
    return bgState;
  }

  /** 问一次主进程当前背景图，并应用。设置页每次挂载也调它。 */
  function bgRefresh() {
    return call('backgroundInfo').then(function (res) {
      var d = (res.ok && res.data) || null;
      return bgApply(d
        ? { file: d.file || '', url: d.url || '', bytes: d.bytes || 0 }
        : { file: '', url: '', bytes: 0 });       // 问不到就当没有：宁可没背景，也不要半张图
    });
  }

  /* ---------------- toast / modal / 错误详情 ---------------- */

  var toastRoot = null;
  function toast(message, kind, detail) {
    if (!toastRoot) toastRoot = document.getElementById('toasts');
    if (!toastRoot) return;
    kind = kind || 'info';
    var iconName = kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info';
    var body = el('div', { class: 'ttext' }, [el('span', { text: String(message === undefined ? '' : message) })]);
    if (detail) {
      body.appendChild(el('div', { class: 'tt-actions' }, [
        el('button', {
          class: 'btn sm ghost', type: 'button', text: '查看详情',
          on: { click: function () { showDetail('出错详情', detail); } }
        })
      ]));
    }
    var node = el('div', { class: 'toast ' + kind, role: 'alert' }, [
      el('span', { class: 'ticon' }, icon(iconName)),
      body,
      el('button', {
        class: 'icon-btn close', type: 'button', 'aria-label': '关闭提示',
        on: { click: function () { node.remove(); } }
      }, icon('x'))
    ]);
    toastRoot.appendChild(node);
    var ttl = kind === 'error' ? 9000 : kind === 'warn' ? 6500 : 4000;
    setTimeout(function () { node.remove(); }, ttl);
  }

  var modalStack = [];
  function modal(opts) {
    var root = document.getElementById('modalRoot');
    if (!root) return function () { };
    opts = opts || {};
    var bodyEl = el('div', { class: 'modal-body' }, []);
    if (opts.body instanceof Node) bodyEl.appendChild(opts.body);
    else if (typeof opts.body === 'string') bodyEl.appendChild(el('div', { text: opts.body }));
    else if (Array.isArray(opts.body)) opts.body.forEach(function (b) { append(bodyEl, b); });

    var foot = el('div', { class: 'modal-foot' });
    (opts.actions || []).forEach(function (a) {
      foot.appendChild(el('button', {
        class: 'btn ' + (a.kind || ''), type: 'button', text: a.label,
        on: { click: function () { if (!a.onClick || a.onClick() !== false) close(); } }
      }));
    });
    if (!opts.actions || !opts.actions.length) {
      foot.appendChild(el('button', { class: 'btn', type: 'button', text: '关闭', on: { click: function () { close(); } } }));
    }
    var box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || '对话框' }, [
      opts.title ? el('h2', { text: opts.title }) : null, bodyEl, foot
    ]);
    var mask = el('div', { class: 'modal-mask', on: { click: function (e) { if (e.target === mask && opts.dismissable !== false) close(); } } }, [box]);
    root.appendChild(mask);
    modalStack.push(close);
    var first = box.querySelector('button');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) { } }, 0);

    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      var i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      if (opts.onClose) { try { opts.onClose(); } catch (e) { } }
    }
    return close;
  }

  /**
   * 把"详情"摊成人能读的文字。
   * 主进程的错误现在是一个对象 `{code,message,detail}`（信封里的 error），
   * 直接 String() 出来就是 "[object Object]" —— 界面上永远不许出现那种东西。
   */
  function detailText(detail) {
    if (detail === undefined || detail === null) return '（没有更多信息）';
    if (typeof detail === 'string') return detail;
    if (detail instanceof Error) return textOf(detail);
    if (typeof detail.text === 'string') return detail.text;
    if (detail.message) {
      var head = (detail.code ? '[' + detail.code + '] ' : '') + String(detail.message);
      if (detail.stack) head += '\n\n' + String(detail.stack);
      if (detail.detail) head += '\n\n' + String(detail.detail);
      return head;
    }
    try { return JSON.stringify(detail, null, 2); } catch (e) { return String(detail); }
  }

  function showDetail(title, detail) {
    var pre = el('pre', { text: detailText(detail) });
    var actions = [
      {
        label: '复制', onClick: function () {
          copyText(pre.textContent).then(function (ok) { toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中', ok ? 'ok' : 'warn'); });
        }
      },
      { label: '关闭', kind: 'primary' }
    ];
    modal({ title: title || '详情', body: [pre], actions: actions });
  }

  /* ---------------- 「跑砸之后的收尾」共用的一段界面 ----------------
   *
   * 两个视图（运行页 / 结果页）都要给一个「清理这次产生的临时文件」入口，取消时也要复用
   * 同一张清单，所以这层放在 app.js，视图只管调 ctx.runCleanup(jobId)。
   *
   * 铁律（用户定的）：**删除前必须先把清单列出来给用户确认**（路径 + 大小 + 一句话）。
   * 所以流程永远两步：scanCleanup（只读）→ 弹清单 → doCleanup（带用户确认过的那些路径）。
   */

  var CLEANUP_KIND_LABEL = {
    artifact: '产物',
    probe: '探针副本',
    log: '失败日志',
    pet: '陪练图'
  };

  /** 把 files 按 kind 数一数，拼成一句人话（弹窗第一层的"已经产生了什么"）。 */
  function cleanupSummary(files) {
    var c = {};
    (files || []).forEach(function (f) { c[f.kind] = (c[f.kind] || 0) + 1; });
    var unit = { artifact: '份页面', probe: '个探针副本', log: '份失败日志', pet: '张陪练图' };
    var parts = Object.keys(c).map(function (k) { return c[k] + ' ' + (unit[k] || '个文件'); });
    return parts.join('、');
  }

  /** 一份"这次产生了什么"的清单（给人看的：路径 + 大小 + 一句话）。空清单也照画。 */
  function cleanupList(files, totalBytes) {
    var box = el('div', {});
    if (!files || !files.length) {
      box.appendChild(el('div', { class: 'hint', text: '这次没有产生临时文件。' }));
      return box;
    }
    box.appendChild(el('div', { class: 'hint', text: '下面这些是本次任务在输出目录里留下的文件，共 '
      + files.length + ' 个、' + fmtBytes(totalBytes || 0) + '。确认后才会删。' }));
    var list = el('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:8px' });
    files.forEach(function (f) {
      list.appendChild(el('div', { style: 'border:1px solid var(--line,#e5e5e5);border-radius:8px;padding:8px 10px;min-width:0' }, [
        el('div', { class: 'mono', title: f.path, style: 'word-break:break-all;font-size:12px', text: f.path }),
        el('div', { style: 'margin-top:4px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap' }, [
          el('span', { class: 'pill', text: CLEANUP_KIND_LABEL[f.kind] || '文件' }),
          el('span', { class: 'hint', text: fmtBytes(f.bytes) + ' · ' + (f.what || '') })
        ])
      ]));
    });
    box.appendChild(list);
    return box;
  }

  /** 真正执行删除（带用户确认过的 paths）。回报"删了几个、哪几个没删掉/为什么"。 */
  function doCleanup(jobId, files) {
    return call('doCleanup', { jobId: jobId, paths: files.map(function (f) { return f.path; }) }).then(function (res) {
      if (!res.ok) return false;
      var d = res.data || {};
      var removed = (d.removed || []).length;
      var failed = d.failed || [];
      if (failed.length) {
        toast('删掉了 ' + removed + ' 个；有 ' + failed.length + ' 个没删掉', 'warn',
          { text: failed.map(function (f) { return f.path + '：' + f.reason; }).join('\n') });
      } else {
        toast('已删掉 ' + removed + ' 个文件', 'ok');
      }
      return true;
    });
  }

  /**
   * 完整的清理流程：扫描 → 弹清单 → 用户确认 → 删除。
   * 清单为空时**直接跳过**，只说一句"这次没有产生临时文件"，不让用户白点一次。
   */
  function runCleanup(jobId) {
    if (!jobId) { toast('没有可清理的任务', 'warn'); return Promise.resolve(false); }
    return call('scanCleanup', jobId).then(function (res) {
      if (!res.ok) return false;
      var d = res.data || {};
      var files = Array.isArray(d.files) ? d.files : [];
      if (!files.length) { toast('这次没有产生临时文件', 'info'); return false; }
      return new Promise(function (resolve) {
        var settled = false;
        modal({
          title: '清理这次产生的临时文件？',
          body: cleanupList(files, d.totalBytes || 0),
          onClose: function () { if (!settled) { settled = true; resolve(false); } },
          actions: [
            { label: '不删了', onClick: function () { settled = true; resolve(false); } },
            {
              label: '删掉这些文件', kind: 'danger',
              onClick: function () { settled = true; doCleanup(jobId, files).then(resolve); }
            }
          ]
        });
      });
    });
  }

  /** 取消时的"这次已经产生了什么"摘要 + 那份清单，两层弹窗共用（见 views/run.js）。 */
  function cancelWhatText(files, totalBytes) {
    if (!files || !files.length) return '这次还没有产生任何文件。';
    return '这次已经产生了 ' + files.length + ' 个文件（' + fmtBytes(totalBytes || 0) + '）：'
      + cleanupSummary(files) + '。';
  }

  function confirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      modal({
        title: title,
        body: message,
        onClose: function () { if (!done) resolve(false); },
        actions: [
          { label: '取消', onClick: function () { done = true; resolve(false); } },
          { label: okLabel || '确定', kind: 'danger', onClick: function () { done = true; resolve(true); } }
        ]
      });
    });
  }

  /* ---------------- window.isg 安全调用 ---------------- */

  var CALL_LABELS = {
    appInfo: '读取应用信息',
    openPath: '用系统程序打开',
    openExternal: '在浏览器里打开',
    revealPath: '在文件夹中显示',
    pickFile: '选择材料文件',
    pickOutputDir: '选择输出目录',
    pathForFile: '读取拖入文件的路径',
    registerPath: '登记拖入的文件',
    getSettings: '读取设置',
    saveSettings: '保存设置',
    backgroundInfo: '读取背景图',
    importBackground: '导入背景图',
    clearBackground: '移除背景图',
    testConnection: '测试连接',
    exportSettings: '导出配置',
    importSettings: '导入配置',
    startGeneration: '开始生成',
    cancelGeneration: '取消任务',
    getJob: '读取任务',
    listJobs: '读取任务列表',
    scanCleanup: '列出本次产生的文件',
    doCleanup: '清除本次产生的文件',
    listBookChapters: '读取以前的章节',
    pickBookFile: '选择以前的页面',
    bookContinuity: '判断新旧章接不接得上',
    inspectBookChapter: '检查这一章能不能带',
    onJobEvent: '订阅任务事件',
    previewExtract: '读取课件内容',
    verifyHtml: '校验页面'
  };

  /**
   * 主进程信封 `{ok,data,error}` → 本地结果 `{ok,data,error}`。
   *
   * **拆信封只在这一处做**：ipc.js 的每个 handler 都返回信封（刻意如此，见该文件顶部
   * 注释：ipcMain.handle 抛的错过 IPC 之后只剩 message），所以 views/*.js 里的
   * `res.data` 必须是**真载荷**，不能是信封本身。
   * 不是信封的（预览页的 mock、同步返回的 pathForFile）原样当载荷。
   */
  function unwrapEnvelope(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (typeof d.ok !== 'boolean') return null;
    var hasData = Object.prototype.hasOwnProperty.call(d, 'data');
    var hasError = Object.prototype.hasOwnProperty.call(d, 'error');
    if (!hasData && !hasError) return null;                    // 只是"长得像"，其实是载荷
    if (d.ok) return { ok: true, data: (hasData && d.data !== undefined) ? d.data : null, error: null };
    return {
      ok: false, data: null,
      error: d.error || { message: '主进程返回了失败信封，但没带原因' }
    };
  }

  /**
   * 包装一次 `window.isg.*` 调用：拆信封、把任何失败**变成可见的提示**、绝不抛给调用方。
   *
   * ⚠️ 这里有一条踩过的坑：**主进程的所有错误都是"正常返回 `{ok:false,error}`"**，
   * 而不是 reject（那是刻意的，见 ipc.js 顶部：Electron 的 IPC 抛错会丢掉 code/detail）。
   * 所以"只在 reject 时弹提示"等于**绝大多数失败都不吭声**——实测踩到过：
   * 导入一张不支持的背景图，主进程把四种拒绝理由都写清楚了，界面上一个字都没有，
   * 用户看到的就是"点了按钮，转了个圈，什么都没发生"。整页里凡依赖这句假设的地方都静默。
   *
   * 现在：信封里 `ok:false` 也走 fail()。调用方自己有更好的话术时用 `quiet`。
   */
  function safe(label, fn, opts) {
    var quiet = !!(opts && opts.quiet);
    return new Promise(function (resolve) {
      var p;
      try { p = fn(); }
      catch (e) { if (!quiet) fail(label, e); return resolve({ ok: false, error: e, data: null }); }
      if (!p || typeof p.then !== 'function') {
        var r0 = unwrapEnvelope(p) || { ok: true, data: p === undefined ? null : p };
        if (r0.ok === false && !quiet) fail(label, r0.error || new Error('主进程返回了失败信封'));
        return resolve(r0);
      }
      p.then(function (d) {
        var r = unwrapEnvelope(d) || { ok: true, data: d === undefined ? null : d };
        if (r.ok === false && !quiet) fail(label, r.error || new Error('主进程返回了失败信封'));
        resolve(r);
      }, function (e) {
        if (!quiet) fail(label, e);
        resolve({ ok: false, error: e, data: null });
      });
    });
    function fail(lbl, e) {
      var msg = (e && e.message) ? e.message : String(e);
      toast('「' + lbl + '」失败：' + clip(msg, 120), 'error', { text: textOf(e), label: lbl });
    }
  }

  function isgApi() {
    var api = window.isg;
    if (!api) throw new Error('window.isg 不可用：渲染进程没有拿到 preload 桥（请检查窗口是否以 contextIsolation 正常加载）');
    return api;
  }

  /** 一切 window.isg 调用都走这里：方法不存在 / 抛错 / reject 都不会让 UI 卡死 */
  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return safe(CALL_LABELS[method] || method, function () {
      var api = isgApi();
      if (typeof api[method] !== 'function') throw new Error('主进程没有暴露 window.isg.' + method + '()');
      return api[method].apply(api, args);
    });
  }

  /**
   * 同 call()，但**失败时不自动弹提示**——给"调用方自己有更好的话术"的地方用。
   * 目前只有「开始生成」一处：它在工作台底部有自己的失败横幅（带"去设置"的引导），
   * 再叠一条通用 toast 就是同一件事说两遍。
   */
  function callQuiet(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return safe(CALL_LABELS[method] || method, function () {
      var api = isgApi();
      if (typeof api[method] !== 'function') throw new Error('主进程没有暴露 window.isg.' + method + '()');
      return api[method].apply(api, args);
    }, { quiet: true });
  }
  function callSync(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      var api = isgApi();
      if (typeof api[method] !== 'function') throw new Error('主进程没有暴露 window.isg.' + method + '()');
      return api[method].apply(api, args);
    } catch (e) {
      toast('「' + (CALL_LABELS[method] || method) + '」失败：' + clip(e && e.message, 140), 'error', { text: textOf(e) });
      return null;
    }
  }

  /* ---------------- 事件总线 ---------------- */

  var bus = {};
  function on(name, cb) {
    (bus[name] = bus[name] || []).push(cb);
    return function off() {
      var a = bus[name] || [], i = a.indexOf(cb);
      if (i >= 0) a.splice(i, 1);
    };
  }
  function emit(name, payload) {
    (bus[name] || []).slice().forEach(function (cb) {
      try { cb(payload); } catch (e) { console.error('[isg] 视图事件处理出错', name, e); }
    });
  }

  /* ---------------- 常驻提示：API Key 没有加密 ----------------
   *
   * 设置页顶部那条 banner 只有进设置页才看得到，用户不进设置页就永远不知道
   * Key 在这台机器上是明文（可逆编码）存的。这条挂在侧栏底部，任何视图都看得见。
   * 节点由这里创建（index.html / ui-preview 都不用改），只在真的明文时才出现。
   */
  function renderKeyStorageNotice(storage) {
    var foot = document.querySelector('.nav-foot');
    if (!foot) return;                                  // 预览页没有侧栏也不该报错
    var box = document.getElementById('keyWarn');
    if (storage !== 'plaintext') { if (box) box.remove(); return; }
    if (box) return;
    box = el('div', { class: 'nav-warn', id: 'keyWarn', role: 'status' }, [
      icon('key'),
      el('div', { class: 'nw-text' }, [
        el('b', { text: 'API Key 未加密' }),
        el('small', { text: '这台机器的系统加密不可用，Key 以明文存在配置文件里。共用电脑请当心，或者用完清掉。' })
      ]),
      el('button', {
        class: 'btn sm', type: 'button', text: '去设置',
        on: { click: function () { go('#settings'); } }
      })
    ]);
    foot.insertBefore(box, foot.firstChild);
  }

  /* ---------------- 路由 ---------------- */

  var views = window.ISGViews || {};
  var rootEl = null;
  var current = null;

  function route() {
    var h = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return views[h] ? h : 'workbench';
  }
  function go(hash) {
    var target = '#' + String(hash).replace(/^#/, '');
    if (location.hash === target) { render(); return; }
    location.hash = target;
  }

  function render() {
    var name = route();
    if (current && current.def && typeof current.def.unmount === 'function') {
      try { current.def.unmount(); } catch (e) { console.error('[isg] unmount 出错', e); }
    }
    current = null;
    if (!rootEl) rootEl = document.getElementById('viewRoot');
    rootEl.innerHTML = '';
    rootEl.scrollTop = 0;
    var page = el('div', { class: 'page' });
    rootEl.appendChild(page);
    state.route = name;
    current = { name: name, def: views[name] };
    try {
      views[name].mount(page, ctx);
    } catch (e) {
      console.error('[isg] 视图挂载失败', name, e);
      page.appendChild(el('div', { class: 'banner warn' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这个页面渲染失败了' }),
          el('div', { text: '界面代码出错了，不影响已生成的文件。可以把下面的原文发给开发者。' }),
          el('div', { class: 'hint mono', text: clip(textOf(e), 400) })
        ])
      ]));
      toast('「' + name + '」页面渲染失败', 'error', { text: textOf(e) });
    }
    Array.prototype.forEach.call(document.querySelectorAll('.navitem'), function (a) {
      if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  /* ---------------- 任务事件订阅 ---------------- */

  var unsubscribe = null;
  function subscribeJobEvents() {
    var r = call('onJobEvent', function (ev) { handleJobEvent(ev); });
    r.then(function (res) {
      if (res.ok && typeof res.data === 'function') unsubscribe = res.data;
      else if (res.ok === false) { /* 已在 safe 里 toast 过 */ }
    });
  }

  function handleJobEvent(ev) {
    if (!ev || typeof ev !== 'object') return;

    /* 「拖到图标上打开」也在 job:event 这条通道上，但它**不是任务事件**：
       没有 jobId，掉进下面的状态机会凭空建出一个空任务，界面上就会莫名多出一个"任务"。
       所以先摘出来处理完再返回。 */
    if (String(ev.type || '').toLowerCase() === 'file-dropped') {
      adoptIncomingPath(ev.filePath);
      return;
    }

    var id = ev.jobId || ev.id || null;
    var relevant = (!state.jobId || !id || id === state.jobId);
    if (!relevant) return;                        // 别的任务的事件，忽略
    if (id && !state.jobId) state.jobId = id;
    if (!state.job) state.job = blankJob(state.jobId);
    if (id) state.job.id = id;

    var type = String(ev.type || '').toLowerCase();
    applyJobEvent(state.job, ev);

    if (state.job.status === 'done' && state.job.result) {
      var r = state.job.result;
      if (r.htmlPath) state.htmlPath = r.htmlPath;
      if (r.report) state.report = r.report;
    }
    emit('job:event', ev);

    // 侧栏「运行」上的小圆点
    var dot = document.querySelector('.navitem[data-route="run"] .navdot');
    if (dot) dot.hidden = !(state.job && state.job.status === 'running');

    // 提示按**任务真实状态**走，不按事件名走：done 事件也可能是"失败"或"取消"
    var finished = (type === 'done' || type === 'complete' || type === 'finished' ||
      type === 'error' || type === 'fail' || type === 'failed');
    if (state.route !== 'run' && finished) {
      if (state.job.status === 'done') toast('生成完成，可以看结果了', 'ok');
      else if (state.job.status === 'error') {
        toast('任务失败：' + clip(state.job.error && state.job.error.message, 100), 'error', state.job.error);
      } else if (state.job.status === 'cancelled') toast('任务已取消', 'info');
    }
  }

  /** 断线重连：进入应用时把最近一个任务拉回来 */
  function restoreLastJob() {
    call('listJobs').then(function (res) {
      if (!res.ok || !Array.isArray(res.data) || !res.data.length) return;
      var sorted = res.data.slice().sort(function (a, b) {
        return (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0);
      });
      var latest = sorted[0];
      var id = latest && (latest.id || latest.jobId);
      if (!id) return;
      var m = mergeJob(latest);
      if (m) { state.job = m; state.jobId = m.id; }
      call('getJob', id).then(function (r2) {
        if (r2.ok && r2.data) {
          var full = mergeJob(r2.data) || m;
          state.job = full;
          state.jobId = full.id;
        }
        var j = state.job;
        if (j && j.result) {
          if (j.result.htmlPath) state.htmlPath = j.result.htmlPath;
          if (j.result.report) state.report = j.result.report;
        }
        var dot = document.querySelector('.navitem[data-route="run"] .navdot');
        if (dot) dot.hidden = !(j && j.status === 'running');
        emit('job:event', { type: 'restore' });
        if (state.route === 'run' || state.route === 'result') render();
      });
    });
  }

  /* ---------------- 拖拽（整窗接收） ---------------- */

  var dragDepth = 0;
  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }
  function showDrag(on) {
    document.documentElement.dataset.dragging = on ? '1' : '0';
    var ov = document.getElementById('dropOverlay');
    if (ov) ov.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  function extOf(name) {
    var m = /(\.[a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  /**
   * 拖进来的**多个**文件。以前这里是 `acceptFile(files[0])` —— 硬编码只吃第一个，
   * 多选一堆文件拖进来，界面上只会出现一份，其余**静默消失**（用户以为都加上了）。
   * 所以现在逐个加：支持的一次收下，不支持的攒起来**一次**说清楚（逐个弹会刷屏）。
   */
  function acceptFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) { toast('没有拿到文件', 'warn'); return; }
    var ok = [], bad = [];
    list.forEach(function (f) {
      var ext = extOf(f && f.name);
      if (SUPPORTED_EXT.indexOf(ext) < 0) bad.push((f && f.name) || '(无名)');
      else ok.push(f);
    });
    if (bad.length) {
      toast('不支持的文件类型：' + clip(bad.join('、'), 140) + '（支持 .pptx / .pdf / .txt / .md）', 'warn');
    }
    if (ok.length > 1) toast('一次加了 ' + ok.length + ' 份材料，记得在清单里给每份选好角色', 'info');
    ok.forEach(function (f) { acceptFile(f); });
  }

  function acceptFile(file) {
    if (!file) return;
    var ext = extOf(file.name);
    if (SUPPORTED_EXT.indexOf(ext) < 0) {
      toast('不支持的文件类型：' + (ext || '未知') + '（支持 .pptx / .pdf / .txt / .md）', 'warn');
      return;
    }
    // ⚠️ 本工程改动（tools/web-patches.json / docs/phase1-design.md）：
    // 宿主侧的桥走 postMessage，拖拽取路径**必然**是一次异步往返
    // （WebView2 里没有 Electron 的 webUtils.getPathForFile 那种同步 API）。
    // Promise.resolve 让同步字符串与 Promise 两种返回走同一条路，其余逻辑一行不改。
    Promise.resolve(callSync('pathForFile', file)).then(function (p) {
    if (!p) {
      toast('拿不到这个文件的真实路径', 'error', { text: '拖拽进来的文件需要通过 window.isg.pathForFile(file) 取路径，主进程没有返回结果。可以改用「点击选择文件」。' });
      return;
    }
    // 拖拽**不经文件对话框**，所以主进程不会顺手放行这个路径（选择对话框会自己登记）。
    // 不登记就往下走的话，后面 extract:preview / app:previewUrl 会被 NOT_ALLOWED 挡掉，
    // 表现是"选好了课件但一直读不出内容"。这里先显式登记，拿不到放行就不当成已选材料。
    call('registerPath', p).then(function (r) {
      if (!r.ok) {
        toast('这份文件不能用：' + clip((r.error && r.error.message) || '主进程没有说明原因', 160), 'warn', r.error);
        return;
      }
      addSource(DEFAULT_ROLE, p, { name: file.name, size: file.size });
      afterSourcesChanged();
    });
    });   // ← 关掉上面那个 Promise.resolve(...).then（本工程改动）
  }

  /* ---------------- 材料清单 ----------------
   *
   * 一份材料 = 一个 id + 一个角色 + 一个文件。**同名角色可以有多份**（历年真题通常好几份）。
   */

  var sourceSeq = 0;
  /* 每份来源各有一条"正在抽取"的请求（键是 sourceId）。
     同一份并发两次没必要——大 PDF 抽一次要好几秒，白抽。
     放在这里而不是 loadExtract 旁边：removeSource 也要清它。 */
  var extractInflight = {};
  function nextSourceId() { return 's' + (++sourceSeq); }
  function findSource(id) {
    for (var i = 0; i < state.sources.length; i++) if (state.sources[i].id === id) return state.sources[i];
    return null;
  }
  /** Windows 下同一个文件可能写成 `C:\a\b.pdf` / `c:/a/b.pdf`，去重前先归一。 */
  function samePath(a, b) {
    return String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase();
  }
  function findSourceByPath(p) {
    for (var i = 0; i < state.sources.length; i++) if (samePath(state.sources[i].filePath, p)) return state.sources[i];
    return null;
  }

  /**
   * 加一份材料。返回新加的（或已存在的那一份）。
   *
   * 同一个文件重复加会被挡掉：抽取结果完全一样，清单里多一行只会让人以为"两份材料"，
   * 而角色还得分两次改。真要用同一个文件担两个角色，那是材料本身的问题，不该靠加两遍解决。
   */
  function addSource(role, filePath, meta) {
    if (!filePath || typeof filePath !== 'string') return null;
    var dup = findSourceByPath(filePath);
    if (dup) {
      toast('这份材料已经在清单里了：' + dup.fileName, 'info');
      return dup;
    }
    var name = (meta && meta.name) || String(filePath).replace(/^.*[\\/]/, '');
    var src = {
      id: nextSourceId(),
      role: ROLES.indexOf(role) >= 0 ? role : DEFAULT_ROLE,
      filePath: filePath,
      fileName: name,
      fileSize: (meta && typeof meta.size === 'number') ? meta.size : null,
      fileKind: extOf(name).replace('.', ''),
      /* 「这份材料属于第几章」。留空 = 跟「这一章的章号」（工作台那张卡上填的那个）走。
         它与 `role` 是**两个独立维度**：第 13 章的课本 + 课件是同一章的两份来源，
         而第 13 章与第 14 章是两章。分组在主进程（`pipeline/chapters.js`）做。 */
      chapterNo: '',
      extract: null,
      extractError: null,
      extractLoading: false
    };
    state.sources.push(src);
    emit('sources', state.sources);
    return src;
  }

  function removeSource(id) {
    for (var i = 0; i < state.sources.length; i++) {
      if (state.sources[i].id !== id) continue;
      var gone = state.sources.splice(i, 1)[0];
      delete extractInflight[id];
      /* 这一份的逐页修改要跟着一起扔掉。留着的话：移除材料 → 又拖进同一个文件（拿到新 id），
         那些改过的页再也对不上任何来源，却会被发进 editedPages（主进程按 `${id}:${index}` 查不到，
         于是静默丢掉——用户"改了半天没生效"就是这么来的）。 */
      Object.keys(state.extractEdits || {}).forEach(function (k) {
        if (k.indexOf(id + ':') === 0) delete state.extractEdits[k];
      });
      emit('sources', state.sources);
      return gone;
    }
    return null;
  }

  /** 角色随时可改：改完立刻生效（它就是发出去的那个 role），不需要重新选文件。 */
  function setSourceRole(id, role) {
    var src = findSource(id);
    if (!src || ROLES.indexOf(role) < 0) return null;
    if (src.role === role) return src;
    src.role = role;
    emit('sources', state.sources);
    return src;
  }

  /** 这份材料属于第几章。空串 = 跟随「这一章的章号」。 */
  function setSourceChapter(id, no) {
    var src = findSource(id);
    if (!src) return null;
    var v = String(no == null ? '' : no).trim();
    if (src.chapterNo === v) return src;
    src.chapterNo = v;
    emit('sources', state.sources);
    return src;
  }

  /** 「这次怎么出」：book（合成一册）| separate（每章一份）。 */
  function setMode(m) {
    var v = m === 'separate' ? 'separate' : 'book';
    if (state.mode === v) return v;
    state.mode = v;
    emit('mode', v);
    return v;
  }

  /** 改了清单之后要做的两件事：让当前视图重画、把还没读过的材料读一遍。 */
  function afterSourcesChanged() {
    if (state.route !== 'workbench' && state.route !== 'extract') { go('#workbench'); return; }
    if (current && typeof current.def.onDropFile === 'function') {
      try { current.def.onDropFile(); } catch (e) { console.error(e); }
    }
  }

  /** 「重新读一次」：清掉上一次的错误横幅再重抽（错误不清的话横幅会一直挂着）。 */
  function reloadSourceExtract(id, force) {
    var src = findSource(id);
    if (!src) return Promise.resolve(null);
    src.extractError = null;
    return loadExtract(id, force !== false);
  }

  /** 这份材料被用户改过几页（按 id 前缀数，不能拿 extractEdits 的总数充数）。 */
  function editedCountOf(id) {
    var n = 0;
    Object.keys(state.extractEdits || {}).forEach(function (k) {
      if (k.indexOf(id + ':') === 0) n++;
    });
    return n;
  }

  function anyEditedCount() { return Object.keys(state.extractEdits || {}).length; }

  /* 「把课件拖到 exe 图标上 / 双击关联文件 / `ISG-Studio.exe 课件.pptx`」——
     主进程从 argv、open-file 拿到路径后，走**两条路**送进来（见 src/main/pending.js）：
       · pending 队列 —— 首启时事件比监听器先到，只能靠渲染层回头 take()；
       · job:event 推送 —— 程序已经在跑、又拖进来一个文件的情况。
     两条路都汇到这里，做和窗口内拖拽同一件事：**加进材料清单** + 切到工作台。
     路径的放行已由主进程做过（openIncoming 里 allow，取件通道里也 allow 一次），
     所以这里**不再**走 registerPath。

     ⚠️ 这里**不再清空清单**：从外部拖进来的第二份材料应该是「再加一份」，
     而不是把用户已经排好的四份材料全冲掉。 */
  function adoptIncomingPath(p) {
    if (!p || typeof p !== 'string') return;
    var name = p.replace(/^.*[\\/]/, '');
    var ext = extOf(name);
    if (SUPPORTED_EXT.indexOf(ext) < 0) {
      toast('这个文件类型打不开：' + name, 'warn');
      return;
    }
    if (findSourceByPath(p)) { toast('这份材料已经在清单里了：' + name, 'info'); afterSourcesChanged(); return; }
    addSource(DEFAULT_ROLE, p);
    toast('已加入材料：' + name + '（角色默认是「课件」，可在清单里改）', 'ok');
    afterSourcesChanged();
  }

  function initDragAndDrop() {
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showDrag(true);
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();                    // 不 preventDefault 浏览器就会拒绝 drop
      try { e.dataTransfer.dropEffect = 'copy'; } catch (err) { }
      showDrag(true);
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && (!e.relatedTarget || e.relatedTarget === window)) showDrag(false);
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      showDrag(false);
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) { toast('没有拿到文件', 'warn'); return; }
      acceptFiles(files);              // 拖进来的**每一份**都收，不再只吃第一个
    });
    window.addEventListener('dragend', function () { dragDepth = 0; showDrag(false); });
  }

  /* ---------------- 「带上一章」的已选区 ----------------
   *
   * 一册 = 以前生成的 N 章 + 这次新生成的 1 章。这一层只管**已选中的那几章**，
   * 两个入口（从历史里挑 / 选一个 HTML 文件）拿到的东西形状并不一样，
   * 所以在**加进来的时候**就归一成同一个形状，发出去时只映射一次。
   *
   * ⚠️ 发出去的 desc 是**跨进程契约**：`{kind:'history', id}` 或 `{kind:'file', path}`，
   * 主进程 `resolveCarryDesc()` 只认这两个 kind 和这两个字段名，认不出就 BAD_ARG 打回整单。
   * 这类"字段名对不上"的故障在界面上和"我根本没选"长得**一模一样**（用户以为带上了，
   * 生成出来的却还是一章），所以映射只许有 `carryDesc()` 一处。
   *
   * 每项的形状（界面自己的形状，不进 IPC）：
   *   {kind:'history'|'file', id, path, label, fileName, createdAt,
   *    chapter:{no,title,subject,intro}, mergeStatus, exactMerge, from, problems:[]}
   */

  /** 去重用的一把键。Windows 下同一个文件可能写成 `C:\a\b.html` / `c:/a/b.html`，先归一。 */
  function carryKeyOf(item) {
    if (!item) return '';
    return item.kind === 'file'
      ? ('file:' + String(item.path || '').replace(/\\/g, '/').toLowerCase())
      : ('history:' + String(item.id || ''));
  }
  function findCarry(key) {
    for (var i = 0; i < state.carry.length; i++) if (carryKeyOf(state.carry[i]) === key) return state.carry[i];
    return null;
  }
  function hasCarry(key) { return !!findCarry(key); }

  /**
   * 界面形状 → 主进程认的 desc。**只此一处**。
   * 多余的字段一个都不发：`book:inspect` / `gen:start` 收到的就是"哪一份"这一个信息。
   */
  function carryDesc(item) {
    return (item && item.kind === 'file')
      ? { kind: 'file', path: item.path }
      : { kind: 'history', id: item ? item.id : '' };
  }

  /**
   * 把一章加进已选区。同一份加两遍会被挡掉（返回已经那一项）——
   * 同一章进两遍会在新页面里变成两份同样的单元，而且用户看不出来哪份是哪份。
   */
  function addCarry(item) {
    if (!item) return null;
    if (item.kind === 'file' ? !item.path : !item.id) return null;
    var dup = findCarry(carryKeyOf(item));
    if (dup) return dup;
    state.carry.push(item);
    emit('carry', state.carry);
    return item;
  }

  function removeCarry(key) {
    for (var i = 0; i < state.carry.length; i++) {
      if (carryKeyOf(state.carry[i]) !== key) continue;
      var gone = state.carry.splice(i, 1)[0];
      emit('carry', state.carry);
      return gone;
    }
    return null;
  }

  /** 上移 / 下移一格。**不做拖拽**：这个仓库里没有拖拽排序的先例，两个按钮更稳、也键盘可达。 */
  function moveCarry(key, delta) {
    var i = -1;
    for (var k = 0; k < state.carry.length; k++) if (carryKeyOf(state.carry[k]) === key) { i = k; break; }
    if (i < 0) return false;
    var j = i + (delta < 0 ? -1 : 1);
    if (j < 0 || j >= state.carry.length) return false;    // 到头了就什么也不做（按钮那边也会灰掉）
    var tmp = state.carry[i];
    state.carry[i] = state.carry[j];
    state.carry[j] = tmp;
    emit('carry', state.carry);
    return true;
  }

  /* ---------------- 生成：选项打包 + 启动（工作台与结果页共用） ---------------- */

  function buildGenerationOptions() {
    var o = state.options;
    var opts = {
      units: o.units,
      quizTarget: o.quizTarget,
      demos: o.demos,
      pet: o.pet,
      outputDir: o.outputDir || '',
      subject: o.subject || '',
      chapterNo: o.chapterNo || '',
      chapterTitle: o.chapterTitle || '',
      auditors: o.auditors,
      language: o.language,
      /* 一册的名字。带上以前的章节时才用得上（流水线按它定页头标题与输出文件名），
         不带时主进程根本不看它。**照样每次都发**：少发一个字段，
         "界面到底有没有把它传下去"就变成只能靠猜的事（quizTarget/points 那次就是这么坏的）。 */
      bookTitle: state.bookTitle || ''
    };
    // 以前这里还发过 options.petArt（对齐 skill 里 PAGE.ui.petArt 的键名）——
    // 主进程从头到尾没人读它，是个死字段，已删掉。陪练形象只由 options.pet 决定。
    /* 逐页修订：键是 `${sourceId}:${index}`，发出去的形状必须是 `{sourceId, index, text}`。
       ⚠️ 主进程按 `${sourceId}:${index}` 查表（pipeline/index.js 的抽取段），
       只发裸 `index` 的旧形状会被当成"主来源的某一页"——多来源下页号必然重复，
       于是"改了课本第 3 页"会悄悄改到课件第 3 页。字段名一个都不能少。 */
    var edits = [];
    Object.keys(state.extractEdits || {}).forEach(function (k) {
      if (typeof state.extractEdits[k] !== 'string') return;
      var i = k.indexOf(':');
      if (i < 0) return;
      var sid = k.slice(0, i), idx = Number(k.slice(i + 1));
      if (!sid || !isFinite(idx)) return;
      edits.push({ sourceId: sid, index: idx, text: state.extractEdits[k] });
    });
    if (edits.length) opts.editedPages = edits;
    return opts;
  }

  /** 发给主进程的材料清单：只带后端认的那几个字段（id/role/filePath/fileName/label/scope）。 */
  function sourcesPayload() {
    return state.sources.map(function (s) {
      return {
        id: s.id,                       // 必须带上：editedPages 靠它归位
        role: s.role,
        filePath: s.filePath,
        fileName: s.fileName,
        // label 是日志与提示词里这份材料的称呼（prompts.labelOf：label || fileName || id）
        label: s.fileName,
        scope: s.scope || null,
        // 「这份材料属于第几章」。⚠️ 字段名**必须**与 pipeline/chapters.js 里读的那个一致
        // （那边是 `src.chapterNo`）；错了的表现是"章号填了没用，全挤成一章"，而且不报错。
        chapterNo: s.chapterNo || ''
      };
    });
  }

  function startGeneration() {
    if (!state.sources.length) {
      toast('先加一份材料', 'warn');
      return Promise.resolve({ ok: false });
    }
    var payload = {
      sources: sourcesPayload(),
      options: buildGenerationOptions(),
      /* ⚠️ `mode` **照发，即使它就是默认值**。这与下面 `carry` 的取舍正好相反，
         因为两者性质不同：carry 空数组与"没发"语义等价、分不出来；而 mode 是一个
         **用户看得见的显式选项**，"发了 book"与"没发（主进程按缺省当 book）"在排查时
         必须能区分开 —— 将来缺省值一变，没发的那种调用会静默改变行为。 */
      mode: state.mode === 'separate' ? 'separate' : 'book',
    };
    /* 要带上以前生成的章节时，`carry` 是**顶层字段**（不是 options 里的），
       形状 `[{kind:'history', id} | {kind:'file', path}]` —— 见 carryDesc() 那段注释。
       ⚠️ 没选章节时**不发这个字段**：空数组在语义上也是"没说要带"，但发一个空数组会让
       "界面到底发没发它"在排查时看不出来（真的漏发时，两边都长得一样）。
       ⚠️ 分开生成时**一律不发**：每章各自独立，没有"一册"可言（主进程也会拒）。 */
    if (state.carry.length && payload.mode !== 'separate') payload.carry = state.carry.map(carryDesc);
    return callQuiet('startGeneration', payload).then(function (res) {
      if (!res.ok) return res;
      var id = res.data && (res.data.jobId || res.data.id);
      state.jobId = id || null;
      state.job = blankJob(id);
      state.job.status = 'running';
      state.job.startedAt = Date.now();
      state.job.title = state.options.chapterTitle ||
        (state.sources[0] ? state.sources[0].fileName : '');
      state.htmlPath = null;
      state.report = null;
      emit('job:event', { type: 'restore' });
      var dot = document.querySelector('.navitem[data-route="run"] .navdot');
      if (dot) dot.hidden = false;
      go('#run');
      return res;
    });
  }

  /* ---------------- 抽取缓存（工作台与抽取预览共用同一份请求） ---------------- */

  function loadOneExtract(src, force) {
    if (!force && src.extract) return Promise.resolve({ ok: true, data: src.extract });
    if (!force && extractInflight[src.id]) return extractInflight[src.id];

    src.extractLoading = true;
    src.extractError = null;
    emit('extract', { id: src.id, loading: true });
    var p = call('previewExtract', src.filePath).then(function (res) {
      delete extractInflight[src.id];
      /* 回来时这份材料可能已经被移除了（用户手快）。往一个已删掉的对象上写没人看得见，
         但更糟的是 extractEdits 的命名空间已经清过一遍——所以先确认它还在清单里。 */
      if (findSource(src.id) !== src) return res;
      src.extractLoading = false;
      if (res.ok && res.data) {
        src.extract = res.data;
        var m = res.data.meta || {};
        if (m.fileName) src.fileName = m.fileName;
        if (typeof m.sizeBytes === 'number') src.fileSize = m.sizeBytes;
        if (res.data.kind) src.fileKind = res.data.kind;
        src.extractError = null;
      } else {
        src.extractError = res.error || new Error('抽取失败');
        src.extract = null;
      }
      emit('extract', { id: src.id, loading: false, error: src.extractError, data: src.extract });
      return res;
    });
    extractInflight[src.id] = p;
    return p;
  }

  /**
   * 取抽取结果。
   *   `loadExtract()`          —— 清单里**每一份**都取（没读过的才真的发请求），并发
   *   `loadExtract('s2')`      —— 只取那一份
   *   `loadExtract('s2', true)`—— 强制重取（「重新读一次」）
   *
   * 返回 `{ok, data:[每份的结果]}`。调用方一般只 `then(重画)` 不看返回值——
   * 每份的来源对象自己带着 extract / extractError / extractLoading，那才是界面读的地方。
   */
  function loadExtract(id, force) {
    var list = id ? [findSource(id)] : state.sources.slice();
    list = list.filter(Boolean);
    if (!list.length) {
      return Promise.resolve({ ok: false, data: [], error: new Error('还没有选择任何材料') });
    }
    return Promise.all(list.map(function (s) { return loadOneExtract(s, force); }))
      .then(function (rs) {
        return { ok: rs.every(function (r) { return r.ok; }), data: rs };
      });
  }

  /* ---------------- 页面头部助手 ---------------- */

  function pageHead(opts) {
    opts = opts || {};
    var actions = el('div', { class: 'head-actions' });
    (opts.actions || []).forEach(function (a) { if (a) actions.appendChild(a); });
    return el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: opts.title || '' }),
        opts.sub ? el('div', { class: 'sub', text: opts.sub }) : null
      ]),
      actions.children.length ? actions : null
    ]);
  }

  function spinner(size) {
    return el('span', { class: 'spinner' + (size ? ' ' + size : ''), 'aria-hidden': 'true' });
  }

  function emptyState(opts) {
    opts = opts || {};
    var kids = [icon(opts.icon || 'layers'), el('b', { text: opts.title || '这里还没有内容' })];
    if (opts.text) kids.push(el('p', { text: opts.text }));
    if (opts.action) kids.push(opts.action);
    return el('div', { class: 'empty' }, kids);
  }

  /** 返回一个「可展开详情」的按钮，用于把原始错误贴出来 */
  function detailButton(detail) {
    return el('button', {
      class: 'btn sm ghost', type: 'button', text: '查看技术详情',
      on: { click: function () { showDetail('技术详情', detail); } }
    });
  }

  /* ---------------- ctx ---------------- */

  var ctx = {
    state: state,
    el: el,
    icon: icon,
    fmtBytes: fmtBytes,
    fmtTime: fmtTime,
    fmtDateTime: fmtDateTime,
    clip: clip,
    copy: function (text, label) {
      return copyText(text).then(function (ok) {
        toast(ok ? (label || '已复制到剪贴板') : '复制被系统拒绝了，请手动选中复制', ok ? 'ok' : 'warn');
        return ok;
      });
    },
    call: call,
    callSync: callSync,
    safe: safe,
    toast: toast,
    modal: modal,
    showDetail: showDetail,
    detailText: detailText,
    confirm: confirmDialog,
    /* 跑砸 / 取消之后的收尾：清单、删除、以及取消弹窗要用的摘要文案。
       两个视图共用同一份实现，免得"清单"在两处慢慢长歪（其中一处漏了 size 或路径都是静默失效）。 */
    runCleanup: runCleanup,
    cleanupList: cleanupList,
    cancelWhatText: cancelWhatText,
    go: go,
    route: route,
    on: on,
    emit: emit,
    pageHead: pageHead,
    spinner: spinner,
    emptyState: emptyState,
    detailButton: detailButton,
    applyTheme: applyTheme,
    /* 背景图：设置页拖滑块要实时预览（bgApply 只改 CSS 变量），松手再自己存 */
    bgState: bgState,
    bgApply: bgApply,
    bgRefresh: bgRefresh,
    SUPPORTED_EXT: SUPPORTED_EXT,
    ROLES: ROLES,
    ROLE_LABEL: ROLE_LABEL,
    ROLE_HINT: ROLE_HINT,
    DEFAULT_ROLE: DEFAULT_ROLE,
    STAGE_DEFS: STAGE_DEFS,
    blankJob: blankJob,
    normStatus: normStatus,
    stageOf: stageOf,
    jobOutputDir: jobOutputDir,
    /* 材料清单：视图只读 state.sources，一切增删改都走这几个方法
       （这样"移除时要清掉它的 editedPages 键"这类规矩只有一处实现）。 */
    addSource: addSource,
    removeSource: removeSource,
    setSourceRole: setSourceRole,
    setSourceChapter: setSourceChapter,
    setMode: setMode,
    findSource: findSource,
    /* 「带上一章」的已选区：视图只读 state.carry，增删改都走这几个方法
       （顺序即页面里的章序；界面形状 → desc 的映射也只有 carryDesc 一处）。 */
    addCarry: addCarry,
    removeCarry: removeCarry,
    moveCarry: moveCarry,
    hasCarry: hasCarry,
    carryKeyOf: carryKeyOf,
    carryDesc: carryDesc,
    reloadSourceExtract: reloadSourceExtract,
    editedCountOf: editedCountOf,
    anyEditedCount: anyEditedCount,
    sourcesPayload: sourcesPayload,
    mergeJob: mergeJob,
    startGeneration: startGeneration,
    buildGenerationOptions: buildGenerationOptions,
    loadExtract: loadExtract,
    baseName: function (p) { return String(p || '').replace(/^.*[\\/]/, ''); }
  };
  window.ISGCtx = ctx;

  /* ---------------- 启动 ---------------- */

  function boot() {
    loadTheme();
    var tb = document.getElementById('themeBtn');
    if (tb) tb.addEventListener('click', cycleTheme);

    initDragAndDrop();
    // 设置一回来就检查一次（Key 是否加密），之后每次 settings 变化也跟着更新
    on('settings', function (s) { renderKeyStorageNotice(s && s.keyStorage); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalStack.length) {
        e.preventDefault();
        modalStack[modalStack.length - 1]();
      }
    });

    window.addEventListener('hashchange', render);
    if (!location.hash) location.hash = '#workbench';
    render();

    // 应用信息（版本号、skill 目录）
    call('appInfo').then(function (res) {
      if (!res.ok) return;
      state.appInfo = res.data || {};
      var v = document.getElementById('navVersion');
      if (v) v.textContent = 'v' + (state.appInfo.version || '—');
      emit('appinfo', state.appInfo);
      if (state.route === 'about') render();     // 关于页开在信息回来之前，得让它重挂一次
    });

    // 背景图（整窗图层 + 明暗/虚化）。和下面的 getSettings 是并发的：
    // 两边都只往 bgApply 里塞自己那几个字段，谁先回来都不会把对方清掉。
    bgRefresh();

    // 设置（判断模型有没有配好）
    call('getSettings').then(function (res) {
      state.settingsLoaded = true;
      if (res.ok) { state.settings = res.data; state.settingsError = null; }
      else state.settingsError = res.error;
      if (state.settings && state.settings.theme) applyTheme(state.settings.theme);
      var ui = (state.settings && state.settings.ui) || {};
      bgApply({ scrim: ui.bgScrim, blur: ui.bgBlur });   // 有背景图时才看得出效果；没图时也不影响
      renderKeyStorageNotice(state.settings && state.settings.keyStorage);
      emit('settings', state.settings);
      if (state.route === 'workbench') render();
      if (state.route === 'settings') render();
    });

    restoreLastJob();

    window.addEventListener('beforeunload', function () {
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (e) { }
    });
    subscribeJobEvents();

    /* 首启那一路（拖到图标上 / 双击关联文件）事件会比这一句更早发出，
       只订阅是接不到的 —— 所以订阅好之后主动向主进程取一次待打开的文件。 */
    call('takePendingFile').then(function (res) {
      if (res && res.ok && res.data) adoptIncomingPath(res.data);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
