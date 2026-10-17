/* 运行：7 步进度、实时日志、模型流式输出、取消 */
(function () {
  'use strict';

  var root = null, ctx = null, el, icon;
  var unsub = null;
  var stepperBox, stageNoteBox, statusBox, logsBox, streamBox, footBox, barBox;
  var askBox;
  var askBusy = false;          // 正在把回答发给主进程（挡住连点两下）
  var logEl, streamEl;
  /** 流式输出那个**长期存在**的文本节点（每个片段往里追加，而不是新建节点）。 */
  var streamTextNode = null;
  var autoScroll = true;
  var logsOpen = true, streamOpen = true;

  /* 日志列表的 DOM 上限。
     ⚠️ 这里曾经只有**引用没有定义**：上个会话的修复补丁把 `while (… > LOG_DOM_MAX)` 与
     `scheduleScrollBottom(logEl)` 两行插进了 onEvent，却没把这两个标识符写出来。
     后果是双重的，而且都很安静：
       · `childElementCount > undefined` 恒为 false → 那个 while **一次都不执行**，
         "封顶"是假的，DOM 照样随日志线性增长（实测灌 1 万条：工作集 106 → 879 MB）；
       · `scheduleScrollBottom` 未定义 → **每条日志都抛一次 ReferenceError**，
         被 app.js 的 try/catch 吞成一句 console.error，界面上完全看不出来。
     教训：这类"修复只落了调用点、没落定义"的问题，光跑测试是发现不了的 ——
     现有测试只驱动数据、不检查 DOM 节点数。 */
  var LOG_DOM_MAX = 800;
  /** 滚到底部的节流版：把一帧内的多次调用合并成一次。
   *  以前每条日志都同步 `scrollTop = scrollHeight`，在越来越长的容器上反复触发同步布局，
   *  整段日志灌入是 O(n²) —— 那是内存数字背后真正的放大因素。 */
  var scrollPending = 0;
  /* 一帧内可能有好几个容器都要滚到底（日志 + 流式输出）。
     ⚠️ 以前这里只记住**第一个**传进来的节点、后面的直接丢掉：两个容器同时更新时，
     其中一个就再也不自动滚到底了。现在按帧收集，一帧结束时一起滚。 */
  var scrollWanted = null;
  function scheduleScrollBottom(node) {
    if (!node) return;
    if (!autoScroll) return;
    if (!scrollWanted) scrollWanted = [];
    if (scrollWanted.indexOf(node) < 0) scrollWanted.push(node);
    if (scrollPending) return;
    scrollPending = requestAnimationFrame(function () {
      scrollPending = 0;
      var list = scrollWanted || [];
      scrollWanted = null;
      list.forEach(function (n) { scrollBottom(n); });
    });
  }

  function job() { return ctx.state.job; }

  function statusText(j) {
    if (!j) return { text: '没有任务', cls: '' };
    switch (j.status) {
      case 'running': return { text: '进行中', cls: 'field' };
      case 'done': return { text: '已完成', cls: 'ok' };
      case 'error': return { text: '失败', cls: 'warn' };
      case 'cancelled': return { text: '已取消', cls: '' };
      default: return { text: '排队中', cls: '' };
    }
  }

  function scrollBottom(node, force) {
    if (!node) return;
    if (!autoScroll && !force) return;
    node.scrollTop = node.scrollHeight;
  }

  function logLine(entry) {
    var level = entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : entry.level === 'ok' ? 'ok' : '';
    return el('span', { class: 'ln ' + level }, [
      el('span', { class: 't', text: ctx.fmtTime(entry.ts || Date.now()) }),
      el('span', { text: entry.message === undefined ? '' : String(entry.message) })
    ]);
  }

  /* ---------- 步骤条 ---------- */

  function stepNode(stage, i) {
    var j = job();
    var status = stage.status || 'pending';
    var mark;
    if (status === 'done') mark = el('span', { class: 'st-mark' }, [icon('check', 13)]);
    else if (status === 'error') mark = el('span', { class: 'st-mark' }, [icon('alert', 13)]);
    else if (status === 'running') mark = el('span', { class: 'st-mark' }, [ctx.spinner()]);
    else if (status === 'skip') mark = el('span', { class: 'st-mark', text: '–' });
    else mark = el('span', { class: 'st-mark', text: String(i + 1) });

    var sub = '';
    if (j && j.sub && j.sub.key === stage.key && j.sub.total) sub = j.sub.done + '/' + j.sub.total;
    else if (j && j.sub && j.sub.key === stage.key && j.sub.done) sub = String(j.sub.done);

    return el('div', { class: 'step', dataset: { key: stage.key, status: status }, title: stage.note || stage.label }, [
      mark,
      el('span', { class: 'st-label', text: stage.label }),
      sub ? el('span', { class: 'st-sub', text: sub }) : null
    ]);
  }

  /* 上一次画出来的样子。**没变就一个节点都不碰** —— 这一条同时解决两个问题：
       · 转圈图标是新建的 SVG，CSS 动画会从 0 度重来。频繁重画 = 看着像在抽动，
         而不是在匀速转；（用户报的就是这个）
       · 每秒几百次的 DOM 重建会真的把页面卡住。
     签名要把**所有会影响这张图的东西**都算进去：每个步骤的状态与说明、
     当前任务状态、以及"第几步"那个 `sub`。漏了任何一项，就会出现"数据变了界面不动"。 */
  var stepperSig = '';

  function renderStepper() {
    if (!stepperBox) return;
    var j = job();
    var stages = (j && j.stages && j.stages.length) ? j.stages : ctx.blankJob().stages;
    var sig = stages.map(function (s) {
      return s.key + ':' + (s.status || '') + ':' + (s.note || '') + ':' + (s.label || '');
    }).join('|') + '#' + ((j && j.status) || '') + '#' + ((j && j.sub && j.sub.key) || '')
      + '#' + ((j && j.sub && j.sub.done) || 0) + '#' + ((j && j.sub && j.sub.total) || 0)
      + '#' + ((j && j.ghost) || '')
      + '#' + (j && j.chapterNow ? (j.chapterNow.index + '/' + j.chapterNow.total + '/' + (j.chapterNow.no || '')) : '');
    if (sig === stepperSig) return;
    stepperSig = sig;
    stepperBox.innerHTML = '';
    stages.forEach(function (s, i) { stepperBox.appendChild(stepNode(s, i)); });

    // 总体进度条
    if (barBox) {
      barBox.innerHTML = '';
      var total = stages.length;
      var done = stages.filter(function (s) { return s.status === 'done' || s.status === 'skip'; }).length;
      var running = stages.some(function (s) { return s.status === 'running'; });
      /* 一册多章时，**每一个阶段都会再跑一遍**（第二章从"抽取/分析已完成、规划重新开始"起算），
         于是 `done` 会从 8/8 掉回 2/8 —— 不解释的话，用户看到的就是"进度倒退了"，
         而页面上没有任何东西能说明这是在跑下一章。
         所以多章时进度条按**整册**算：`(已完成章数 + 本章完成比例) / 总章数`，
         它是单调的；文字里点明"第几章"，本章内部的 8 步仍然照常显示。 */
      var chap = j && j.chapterNow;
      var multi = !!(chap && Number(chap.total) > 1);
      var pct;
      if (multi) {
        pct = Math.round(((Number(chap.index) - 1) + (total ? done / total : 0)) / Number(chap.total) * 100);
      } else {
        pct = total ? Math.round((done / total) * 100) : 0;
      }
      if (j && j.status === 'done') pct = 100;
      if (j && (j.status === 'running' || j.status === 'done')) {
        barBox.appendChild(el('div', { class: 'progressbar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': '总进度' }, [
          el('i', { style: 'width:' + pct + '%' })
        ]));
        var runLabel = running ? ((stages.filter(function (s) { return s.status === 'running'; })[0] || {}).label || '') : '';
        var line;
        if (j.status === 'done') {
          line = '全部完成（' + done + '/' + total + '）' + (multi ? '，共 ' + chap.total + ' 章' : '');
        } else {
          line = (multi ? '第 ' + chap.index + '/' + chap.total + ' 章 · ' : '')
            + '进度 ' + done + '/' + total
            + (running ? '，正在跑「' + runLabel + '」' : '');
        }
        barBox.appendChild(el('div', { class: 'hint', style: 'margin-top:5px' }, line));
      }
    }

    // 失败原因
    if (stageNoteBox) {
      stageNoteBox.innerHTML = '';
      var bad = stages.filter(function (s) { return s.status === 'error'; });
      if (bad.length) {
        bad.forEach(function (s) {
          stageNoteBox.appendChild(el('div', { class: 'step-note' }, [
            icon('alert'),
            el('span', {}, [
              el('b', { text: '「' + s.label + '」这一步失败了：' }),
              el('span', { text: s.note || '主进程没有给出具体原因。' })
            ])
          ]));
        });
      }
      // "幽灵任务"：界面上显示在进行中，主进程那边根本没有这个任务。
      // 以前它会被无限渲染成"进行中…进度 0/7"，用户只能干等。
      if (j && j.ghost) {
        stageNoteBox.appendChild(el('div', { class: 'step-note' }, [
          icon('alert'),
          el('span', {}, [
            el('b', { text: '这个任务没有真的开始：' }),
            el('span', { text: j.ghost }),
            el('div', { class: 'hint', style: 'margin-top:6px', text: '最常见的原因是还没选模型：去「设置」启用一家提供商、填好 API Key，并选中一个默认模型，再回工作台点一次「开始生成」。' }),
            el('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, [
              el('button', {
                class: 'btn sm primary', type: 'button', text: '去设置',
                on: { click: function () { ctx.go('#settings'); } }
              }),
              el('button', {
                class: 'btn sm', type: 'button', text: '回工作台重来',
                on: { click: function () { ctx.go('#workbench'); } }
              })
            ])
          ])
        ]));
      }
      if (j && !j.ghost && j.status === 'error' && j.error && j.error.message) {
        var msg = String(j.error.message);
        var looksAuth = /401|403|unauthor|api.?key|invalid[_ ]?key|认证|密钥/i.test(msg);
        var note = el('div', { class: 'step-note' }, [
          icon('alert'),
          el('span', {}, [
            el('b', { text: '任务没能跑完：' }),
            el('span', { text: ctx.clip(msg, 400) }),
            el('div', { class: 'hint', style: 'margin-top:6px', text: looksAuth
              ? '看起来是密钥或权限的问题：去「设置」里检查 API Key、Base URL 和 API 格式是否匹配。'
              : '可以先重试一次；如果每次都停在同一步，把下面的日志复制出来发给开发者。' }),
            el('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, [
              looksAuth ? el('button', {
                class: 'btn sm primary', type: 'button', text: '去设置',
                on: { click: function () { ctx.go('#settings'); } }
              }) : el('button', {
                class: 'btn sm primary', type: 'button', text: '改选项后重试',
                on: { click: function () { ctx.go('#workbench'); } }
              }),
              ctx.detailButton(j.error)
            ])
          ])
        ]);
        stageNoteBox.appendChild(note);
      }
    }
  }

  /* ---------- 状态区 / 底部 ---------- */

  function renderStatus() {
    if (!statusBox) return;
    var j = job();
    statusBox.innerHTML = '';
    if (!j) return;
    var st = statusText(j);
    statusBox.appendChild(el('span', { class: 'pill ' + st.cls }, [
      j.status === 'running' ? el('span', { class: 'live-dot' }) : el('span', { class: 'dot' }),
      el('span', { text: st.text })
    ]));
    if (j.id) statusBox.appendChild(el('span', { class: 'hint mono', text: '任务号 ' + j.id }));
    if (j.startedAt) statusBox.appendChild(el('span', { class: 'hint', text: '开始于 ' + ctx.fmtDateTime(j.startedAt) }));
  }

  /* ---------- 中途提问 ----------
   *
   * 流水线跑到一半会停下来问用户一句话（例："这两章关联很大，要不要让它们互相照应"）。
   * 这是**任务真的停在那里等你**，不是通知类的东西：
   *   · 不回就不往下走（主进程有 10 分钟超时兜底，超时按默认值继续并记一条日志）；
   *   · 所以它必须显眼、必须在最上面，而不是混在日志流里。
   * 数据来自任务快照的 `ask` 字段（主进程也进快照），所以切页面回来、刷新一次都还在。
   */
  function answerAsk(ask, value) {
    var j = job();
    if (!j || !j.id || askBusy) return;
    askBusy = true;
    renderAsk();
    ctx.call('answerGeneration', j.id, ask.id, value).then(function (res) {
      askBusy = false;
      if (res && res.ok && res.data !== false) {
        // 立刻把问题收掉：主进程还会推一条事件，但用户点了按钮就该当场有反应
        j.ask = null;
        ctx.toast(value === 'linked' ? '好，按「关联生成」继续' : '好，按「简单缝合」继续', 'ok');
      } else if (res && res.ok && res.data === false) {
        /* 返回 false = 主进程不认这个回答（问题已经过期，或者值不在选项里）。
           这**不是**错误，如实说一句，并把本地那个问题收掉，免得用户一直点。 */
        j.ask = null;
        ctx.toast('这个问题已经不需要回答了（任务那边已经继续了）', 'info');
      }
      renderAsk();
    }).catch(function () {
      askBusy = false;
      renderAsk();
    });
  }

  function renderAsk() {
    if (!askBox) return;
    askBox.innerHTML = '';
    var j = job();
    var ask = j && j.ask;
    if (!ask || !ask.id) return;

    var opts = Array.isArray(ask.options) ? ask.options : [];
    askBox.appendChild(el('div', { class: 'card ask-card', role: 'alertdialog', dataset: { ask: ask.id } }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: ask.title || '需要你定一下' }),
        el('div', { class: 'right' }, [el('span', { class: 'hint', text: '任务停在这里等你' })])
      ]),
      ask.message ? el('p', { class: 'hint', style: 'margin:4px 0 10px', text: ask.message }) : null,
      el('div', { class: 'ask-opts' }, opts.map(function (o) {
        var primary = String(o.value) === String(ask.default);
        return el('button', {
          class: 'ask-opt' + (primary ? ' primary' : ''),
          type: 'button',
          disabled: askBusy,
          'aria-label': o.label,
          on: { click: function () { answerAsk(ask, o.value); } }
        }, [
          el('b', { text: o.label }),
          o.detail ? el('small', { text: o.detail }) : null,
          primary ? el('span', { class: 'pill', text: '默认' }) : null
        ]);
      })),
      el('p', { class: 'hint', style: 'margin:8px 0 0', text:
        '不回答的话，十分钟后会自动按默认那一项继续。也可以直接取消这个任务。' })
    ]));
  }

  function renderFoot() {
    if (!footBox) return;
    var j = job();
    footBox.innerHTML = '';
    if (!j) return;

    var left = el('div', { class: 'left' }, [
      el('div', { class: 'hint', text: j.status === 'done'
        ? '页面已经生成好了，建议看一眼校验报告再拿去用。'
        : j.status === 'error' ? '任务中断了。日志里有每一步的原文；本次在输出目录里留下的文件可以点右边「清理」删掉。'
          : j.status === 'cancelled' ? '任务已取消，已经写出的半成品不会进入结果页；需要的话可以点右边「清理」删掉。'
            : '生成过程中可以随时取消；已经写出去的文件不会自动删掉。' })
    ]);
    var right = el('div', { class: 'right' });

    if (j.status === 'running') {
      /* 按钮文案跟着设置里那份"取消默认"走：还问就写「取消任务」，不问就直接写它要做的事。
         这样用户不必点开才知道会保留还是清除。 */
      var pref = cancelPref();
      var cancelLabel = pref.ask ? '取消任务' : (pref.policy === 'clear' ? '取消并清除' : '取消并保留');
      right.appendChild(el('button', {
        class: 'btn danger', type: 'button', title: pref.ask ? '点一下会问你要保留还是清除本次产生的文件' : '',
        on: { click: cancel }
      }, [icon('x'), el('span', { text: cancelLabel })]));
    }
    if (j.status === 'done') {
      right.appendChild(el('button', {
        class: 'btn primary', type: 'button', text: '查看结果',
        on: { click: function () { ctx.go('#result'); } }
      }));
    }
    if ((j.status === 'error' || j.status === 'cancelled') && j.id) {
      // 清理入口：先列清单、确认了才删（见 app.js 的 runCleanup）
      right.appendChild(el('button', {
        class: 'btn', type: 'button', text: '清理这次产生的临时文件',
        on: { click: function () { ctx.runCleanup(j.id); } }
      }));
      right.appendChild(el('button', {
        class: 'btn', type: 'button', text: '回工作台重来',
        on: { click: function () { ctx.go('#workbench'); } }
      }));
    }
    if (!right.children.length) {
      right.appendChild(el('button', {
        class: 'btn', type: 'button', text: '去工作台',
        on: { click: function () { ctx.go('#workbench'); } }
      }));
    }
    footBox.appendChild(left);
    footBox.appendChild(right);
  }

  /* ---------- 幽灵任务检查 ---------- */

  /** 把"其实没建成任务"这件事摆到明面上，别让进度条永远转下去。 */
  function markGhost(why) {
    var j = job();
    if (!j || j.ghost) return;
    j.ghost = why;
    j.status = 'error';
    j.error = { message: why, stack: '' };
    j.stages.forEach(function (s) { if (s.status === 'running') s.status = 'error'; });
  }

  /**
   * 只在本地说"在跑"的时候去主进程对一次账：
   *   · 连任务号都没有 → 肯定没建成；
   *   · 有任务号但 getJob 查无此任务 → 也没建成（主进程启动前就失败了）。
   * 查帐失败（读不到）不当回事——那可能只是主进程忙，不要吓用户。
   */
  function verifyJobExists() {
    var j = job();
    if (!j || j.ghost) return;
    if (j.status !== 'running' && j.status !== 'pending') return;
    if (!j.id) { markGhost('这次「开始生成」没有拿到任务号'); renderStepper(); renderFoot(); return; }
    ctx.call('getJob', j.id).then(function (res) {
      if (!root || !res.ok) return;
      if (!res.data) {
        markGhost('主进程里查不到任务 ' + j.id + '（它没有真的建起来）');
        renderAll();
      }
    });
  }

  /* ---------- 取消 ----------
   *
   * 用户定的两条：
   *   ① 取消时**每次都先弹窗问**（保留半成品 / 清除本次产生的文件），窗口里带一个
   *      「以后都这样，不再问我」——勾了就把选择存进设置，之后直接按存的来。
   *   ② 选了清除时**先列清单再删**；清单为空就跳过那一层，只说一句"这次没有产生临时文件"。
   * 于是取消这条路上最多两层弹窗（先问保留还是清除、选了清除再列清单），这是可以接受的，
   * 但第二层**只在真有东西要删时**才出现。
   */

  /** 设置里那份"取消默认怎么办"：ask = 还问不问；policy = 直接按哪个来。 */
  function cancelPref() {
    var g = (ctx.state.settings && ctx.state.settings.generation) || {};
    return { ask: g.onCancelAsk !== false, policy: g.onCancel === 'clear' ? 'clear' : 'keep' };
  }

  /** 真正把取消请求发下去（policy 决定主进程收尾时留还是删）。 */
  function applyCancel(j, policy) {
    if (!j || !j.id) return;
    ctx.call('cancelGeneration', j.id, { policy: policy }).then(function (res) {
      if (!res.ok) return;
      if (j) j.status = 'cancelled';
      renderStatus(); renderStepper(); renderFoot();
      ctx.toast(policy === 'clear' ? '已请求取消，收尾后会清除本次产生的文件'
        : '已请求取消', 'info');
    });
  }

  /** 第二层：把要删的清单摆出来，确认了才按"清除"取消。 */
  function confirmClearThenCancel(j, files, totalBytes) {
    ctx.modal({
      title: '确认删掉这 ' + files.length + ' 个文件？',
      body: ctx.cleanupList(files, totalBytes),
      actions: [
        { label: '不删了，只取消任务', onClick: function () { applyCancel(j, 'keep'); } },
        { label: '删掉这些文件', kind: 'danger', onClick: function () { applyCancel(j, 'clear'); } }
      ]
    });
  }

  /** 第一层：保留（默认）/ 清除 + 「以后都这样」勾选框。 */
  function openCancelDialog(j, files, totalBytes) {
    var choice = 'keep';               // 安全侧：默认选中「保留」
    var remember = false;

    var body = el('div', {});
    body.appendChild(el('div', { class: 'hint' }, [
      el('span', { text: '已经跑完的步骤不会回滚，半成品不会进入结果页。' }),
      el('div', { style: 'margin-top:4px', text: ctx.cancelWhatText(files, totalBytes) })
    ]));

    function opt(val, title, desc) {
      var input = el('input', {
        type: 'radio', name: 'cancel-policy', value: val, checked: val === 'keep',
        on: { change: function () { if (input.checked) choice = val; } }
      });
      return el('label', { class: 'radio-card', style: 'flex:1 1 190px' }, [
        input, el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
      ]);
    }
    body.appendChild(el('div', { class: 'field', style: 'margin-top:10px' }, [
      el('span', { class: 'lbl', text: '停下来的同时' }),
      el('div', { class: 'radio-cards', style: 'flex-direction:row;flex-wrap:wrap' }, [
        opt('keep', '保留（默认）', '半成品页面留着，你自己看完再处理。'),
        opt('clear', '清除', '自动删掉本次产生的临时件与半成品。')
      ])
    ]));

    var cb = el('input', {
      type: 'checkbox',
      on: { change: function () { remember = cb.checked; } }
    });
    body.appendChild(el('label', { class: 'checkline' }, [
      cb,
      el('span', { class: 't' }, [
        el('b', { text: '以后都这样，不再问我' }),
        el('small', { text: '勾了之后，取消时直接就按上面这个来；想恢复成每次都问，去「设置 → 取消任务时」改回来。' })
      ])
    ]));

    ctx.modal({
      title: '取消这个任务？',
      body: body,
      actions: [
        { label: '先不取消' },
        {
          label: '继续取消', kind: 'primary',
          onClick: function () {
            /* 勾了"不再问我"：把这次的选择存进设置（onCancel + onCancelAsk:false）。
               存失败也不拦着取消 —— 用户的意图是"停下来"，设置没存上不该耽误它。 */
            if (remember) {
              ctx.call('saveSettings', { generation: { onCancel: choice, onCancelAsk: false } }).then(function (r) {
                if (r && r.ok) ctx.state.settings = r.data || ctx.state.settings;
              });
            }
            if (choice !== 'clear') { applyCancel(j, 'keep'); return; }
            if (!files.length) {                       // 没东西可删：跳过第二层
              ctx.toast('这次没有产生临时文件', 'info');
              applyCancel(j, 'clear');
              return;
            }
            confirmClearThenCancel(j, files, totalBytes);
          }
        }
      ]
    });
  }

  function cancel() {
    var j = job();
    if (!j || !j.id) { ctx.toast('没有正在跑的任务', 'warn'); return; }
    var pref = cancelPref();
    /* 已经说过"不再问我"且选的是**保留** —— 立刻照做，一层弹窗都不弹。
       ⚠️ 但选的是**清除**时**不能**这样直接走：删之前必须先把清单列出来给用户确认
       （这是不变的规矩，"不再问我"免掉的只是"保留还是清除"那一问）。 */
    if (!pref.ask && pref.policy !== 'clear') { applyCancel(j, 'keep'); return; }
    // 先只读地扫一次，好把"这次已经产生了什么"摆出来（此刻还没取消，删是不会发生的）
    ctx.call('scanCleanup', j.id).then(function (res) {
      var d = (res && res.ok && res.data) || {};
      var files = Array.isArray(d.files) ? d.files : [];
      if (pref.ask) { openCancelDialog(j, files, d.totalBytes || 0); return; }
      // 不再问我 + 默认清除：跳过第一层，但仍要过"清单确认"这一层（清单空就直说一句）
      if (!files.length) { ctx.toast('这次没有产生临时文件', 'info'); applyCancel(j, 'clear'); return; }
      confirmClearThenCancel(j, files, d.totalBytes || 0);
    });
  }

  /* ---------- 日志 / 流 ---------- */

  function panel(opts) {
    var body = el('pre', { class: 'console ' + opts.cls, 'aria-label': opts.label });
    opts.holder(body);
    var toggleLabel = el('span', { text: '收起' });
    var toggle = el('button', {
      class: 'btn sm ghost', type: 'button', 'aria-expanded': 'true',
      'aria-label': '折叠或展开' + opts.title,
      on: {
        click: function () {
          var open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
          body.hidden = open;
          toggleLabel.textContent = open ? '展开' : '收起';
        }
      }
    }, [icon('chevron'), toggleLabel]);
    var right = el('div', { class: 'right' });
    right.appendChild(el('button', {
      class: 'btn sm ghost', type: 'button', text: '复制',
      on: {
        click: function () { ctx.copy(body.textContent || '（还没有内容）', '日志已复制'); }
      }
    }));
    if (opts.extra) right.appendChild(opts.extra);
    right.appendChild(toggle);

    return el('div', { class: 'card' }, [
      el('div', { class: 'panel-head' }, [
        el('h2', { style: 'font-size:14.5px;font-weight:650', text: opts.title }),
        opts.note ? el('span', { class: 'hint', text: opts.note }) : null,
        right
      ]),
      body
    ]);
  }

  function renderLogsFull() {
    if (!logEl) return;
    var j = job();
    logEl.innerHTML = '';
    var lines = (j && j.log) || [];
    if (!lines.length) {
      logEl.appendChild(el('span', { class: 'ln', text: '（还没有日志）' }));
    } else {
      lines.forEach(function (l) { logEl.appendChild(logLine(l)); });
    }
    scrollBottom(logEl, true);
  }

  function renderStreamFull() {
    if (!streamEl) return;
    var j = job();
    var txt = (j && j.out) || '';
    streamEl.textContent = txt || '（模型还没开始输出。选了「生成内容」阶段后，这里会实时滚动模型的输出。）';
    scrollBottom(streamEl, true);
  }

  /* ---------- 组装 ---------- */

  function build() {
    var s = ctx.state;
    var j = job();

    root.appendChild(ctx.pageHead({
      title: '运行',
      sub: j && j.id ? ('正在跟踪任务 ' + j.id) : '生成过程中的每一步都在这里',
      actions: [
        el('button', {
          class: 'btn sm', type: 'button',
          disabled: !j || !j.id,
          on: {
            click: function () {
              if (!ctx.state.jobId) return;
              ctx.call('getJob', ctx.state.jobId).then(function (res) {
                if (!res.ok) return;
                if (!res.data) {
                  markGhost('主进程里查不到任务 ' + ctx.state.jobId + '（它没有真的建起来）');
                  renderAll();
                  ctx.toast('主进程里没有这个任务', 'warn');
                  return;
                }
                var m = ctx.mergeJob(res.data);
                if (m) {
                  // 主进程可能只回部分字段，本地的日志/流式输出更全，做一次并集
                  var old = ctx.state.job;
                  if (old) {
                    if (!m.log.length && old.log.length) m.log = old.log;
                    if (!m.out && old.out) m.out = old.out;
                    if (!m.result && old.result) m.result = old.result;
                  }
                  ctx.state.job = m;
                }
                renderAll();
                ctx.toast('已刷新任务状态', 'ok');
              });
            }
          }
        }, [icon('refresh'), el('span', { text: '刷新' })])
      ]
    }));

    statusBox = el('div', { class: 'card-head', style: 'margin-bottom:12px' });
    root.appendChild(statusBox);

    var stepCard = el('div', { class: 'card' }, []);
    stepCard.appendChild(el('div', { class: 'card-head' }, [el('h2', { text: '进度' }),
    el('div', { class: 'right' }, [el('span', { class: 'hint', text: '抽取 → 规划 → 内容 → 演示 → 拼装 → 校验 → 修复' })])]));
    stepperBox = el('div', { class: 'stepper' });
    barBox = el('div', {});
    stageNoteBox = el('div', {});
    stepCard.appendChild(stepperBox);
    stepCard.appendChild(barBox);
    stepCard.appendChild(stageNoteBox);
    root.appendChild(stepCard);

    /* 中途提问放在进度卡**下面、日志上面**：它是"任务停住了"的信号，比日志重要得多，
       但它出现得晚（跑到分析之后才可能问），所以不该占着页面最上面那块位置空等。 */
    askBox = el('div', {});
    root.appendChild(askBox);

    if (!j || !j.id) {
      root.appendChild(ctx.emptyState({
        icon: 'play', title: '还没跑过任务',
        text: '先去工作台选一份课件，点「开始生成」。跑起来以后这里会显示七步进度、实时日志和模型的流式输出。',
        action: el('button', { class: 'btn primary', type: 'button', text: '去工作台', on: { click: function () { ctx.go('#workbench'); } } })
      }));
      footBox = el('div', { class: 'sticky-foot' });
      root.appendChild(footBox);
      renderStepper(); renderStatus(); renderFoot();
      return;
    }

    root.appendChild(panel({
      title: '实时日志', cls: 'logs', label: '实时日志',
      note: '每一步在做什么、失败在哪一步',
      extra: (function () {
        var cb = el('input', {
          type: 'checkbox', 'aria-label': '自动滚动到最新日志',
          on: { change: function () { autoScroll = cb.checked; if (cb.checked) scrollBottom(logEl, true); } }
        });
        cb.checked = autoScroll;
        return el('label', { class: 'checkline', style: 'padding:0;gap:6px' }, [
          cb, el('span', { class: 't' }, [el('small', { text: '自动滚到底' })])
        ]);
      })(),
      holder: function (node) { logEl = node; }
    }));

    root.appendChild(panel({
      title: '模型输出', cls: 'stream', label: '模型流式输出',
      note: (j.outStage ? '当前阶段：' + j.outStage : '模型正在写的内容会实时出现在这里'),
      holder: function (node) { streamEl = node; }
    }));

    footBox = el('div', { class: 'sticky-foot' });
    root.appendChild(footBox);

    // 闭包绑**这个节点**，别去读模块级的 logEl / root。
    // 离开运行页时 unmount() 会把 logEl、root 都置空，而脱离文档的日志框仍会补发一次
    // scroll 事件（scrollBottom 刚改过它的 scrollTop）——回调在那时读 logEl.scrollHeight
    // 就是 "Cannot read properties of null"，在渲染进程里冒成一条没人处理的错误。
    // 改成闭包内的常量后，行为完全不变，只是不再读已经变成 null 的全局引用。
    if (logEl) {
      var logBox = logEl;
      logBox.addEventListener('scroll', function () {
        var atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 24;
        if (!atBottom && autoScroll) {
          autoScroll = false;
          var cb = root && root.querySelector('.checkline input');
          if (cb) cb.checked = false;
        }
      });
    }

    renderAll();
    checkOnMount();
  }

  function renderAll() {
    renderStatus(); renderStepper(); renderAsk(); renderFoot(); renderLogsFull(); renderStreamFull();
  }

  /** 进入运行页时先跟主进程对一次账（防止"幽灵任务"一直转） */
  function checkOnMount() {
    verifyJobExists();
  }

  /* ---------- 事件 ---------- */

  function onEvent(ev) {
    if (!root) return;
    if (ev && ev.type === 'restore') { renderAll(); checkOnMount(); return; }
    var t = String((ev && ev.type) || '').toLowerCase();

    /* 中途提问：把问题记到本地任务上再画。**不能只画不记** ——
       用户答完之后主进程会把 `ask` 置空并推一条 `ask`（无 ask 字段）过来，那时得知道要收掉。 */
    if (t === 'ask') {
      var aj = job();
      if (aj) {
        aj.ask = ev.ask || null;
        if (ev.ask) askBusy = false;      // 新问题来了，之前那次的忙碌状态作废
      }
      askBusy = false;
      renderAsk();
      // 问题在日志区上方，滚到底的自动滚动不该把它推出视野 —— 所以这里不动滚动
      return;
    }

    if (t === 'log' || t === 'message') {
      var j = job();
      var last = j && j.log && j.log.length ? j.log[j.log.length - 1] : null;
      if (logEl && last) {
        if (logEl.firstChild && logEl.firstChild.nodeType === 1 && logEl.firstChild.textContent.indexOf('还没有日志') >= 0) {
          logEl.innerHTML = '';
        }
        logEl.appendChild(logLine(last));
        /* ⚠️ 这张列表必须**自己封顶**。主进程侧是封了顶的（jobs.js 的 MAX_LOG=2000，
           app.js 的 LOG_CAP=1500 管的是模型数组），但 DOM 这条路径以前只加不减 ——
           实测：灌 1 万条日志，渲染进程工作集 106 → **879 MB**（1.5 万条 → 1136 MB），
           随行数完美线性，而同一条 IPC 走在不显示日志的页面上是**零增长**（对照实验）。
           放大因素是 `scrollBottom()`：每条日志都在越来越长的容器上强迫同步布局（O(n²)）。
           留 800 行足够看，超出就把最早的丢掉。 */
        while (logEl.childElementCount > LOG_DOM_MAX) logEl.removeChild(logEl.firstElementChild);
        scheduleScrollBottom(logEl);
      }
      return;
    }
    if (t === 'delta' || t === 'chunk' || t === 'stream') {
      /* ⚠️ 这一支是**每个流式片段**都会走的（一次生成几千条，走 IPC 过来）。
         以前它做两件很贵的事：
           ① `renderStepper()` —— 把 8 个步骤节点连同里面的转圈 SVG **全部重建一遍**。
              重建出来的 SVG 是一个新元素，CSS 动画从 0 度重新开始 —— 于是「转圈」
              变成每来一个片段就甩回去一次，看起来就是**鬼畜地抽动**而不是丝滑地转。
              同时每秒几百次地重建 DOM，页面真的会卡住。
           ② `scrollBottom(streamEl)` 直接调用 —— 每来一个片段强制同步布局，
              文本越长越贵（O(n²)），跟日志那边当初的毛病一模一样。
          现在：转圈交给**步骤条自己**（只在状态真的变了时才重建，见 renderStepper 的签名判断），
          滚动走按帧合并的 scheduleScrollBottom。这里只负责把新文本接上去。 */
      if (streamEl) {
        var jj = job();
        var txt = (jj && jj.out) || '';
        var cur = streamEl.textContent || '';
        if (txt.length >= cur.length && txt.slice(0, cur.length) === cur) {
          /* 追加到一个**长期存在的文本节点**上，而不是每个片段新建一个：
             一次生成几千个文本节点，光是 GC 就够卡一下。 */
          if (!streamTextNode || streamTextNode.parentNode !== streamEl) {
            streamTextNode = document.createTextNode('');
            streamEl.appendChild(streamTextNode);
          }
          streamTextNode.data += txt.slice(cur.length);
        } else {
          streamTextNode = document.createTextNode(txt);
          streamEl.textContent = '';
          streamEl.appendChild(streamTextNode);
        }
        scheduleScrollBottom(streamEl);
      }
      return;
    }
    renderStatus(); renderStepper(); renderFoot();
    // 只有真的跑完才跳结果页：失败的任务也有 done 事件（status:'failed'），
    // 旧写法见 done 就跳，用户会被送到一个空结果页，而失败原文留在运行页没人看。
    if (t === 'done') {
      renderStreamFull();
      setTimeout(function () {
        if (!ctx || ctx.route() !== 'run') return;
        var jj = ctx.state.job;
        if (jj && jj.status === 'done' && !jj.error) ctx.go('#result');
      }, 900);
    }
  }

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    autoScroll = true;
    build();
    unsub = ctx.on('job:event', onEvent);
  }
  function unmount() {
    if (unsub) { try { unsub(); } catch (e) { } unsub = null; }
    // 取消还没触发的那一帧滚动：它闭包持着 logEl，卸载后再跑就是操作已脱离文档的节点
    if (scrollPending) { try { cancelAnimationFrame(scrollPending); } catch (e) { } scrollPending = 0; }
    root = null; ctx = null;
    logEl = streamEl = null;
    streamTextNode = null;
    /* ⚠️ 签名也要清掉：它记的是"上一次画出来的样子"，而节点已经随视图一起没了。
       留着的话，下次进运行页如果状态恰好与签名相同，就会**整页空白**（一步都不画）。 */
    stepperSig = '';
    stepperBox = stageNoteBox = statusBox = footBox = barBox = askBox = null;
    askBusy = false;
  }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.run = { mount: mount, unmount: unmount };
})();
