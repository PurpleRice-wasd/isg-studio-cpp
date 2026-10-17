/* 结果：内嵌预览 + 校验报告 + 打开/定位/复制/重新生成 */
(function () {
  'use strict';

  var root = null, ctx = null, el, icon;
  var frame, note;

  /* 兜底清单（与 skill 的 references/build-and-verify.md 对齐）。
     主进程真跑出来的报告是几十项，而且**项目数不固定**（探针版本一变就变），
     所以这里只在下述用途上：报告项比这份清单还少时，把没出现的项补成"没测到"，
     别让用户以为漏项。界面上不要写死"十一项"这种数字。 */
  var CANON = [
    {
      key: 'bank', label: '题库条目数与题卡总数一致', alias: ['bank', 'count', '条目', '题量', '题库'],
      fix: '某个单元的题库 JSON 没拼进页面。回工作台用同样的选项重跑一次；如果每次都差同样的数量，把运行页的日志复制出来给开发者。'
    },
    {
      key: 'missing', label: '缺卡 = 0（每道题都有卡片）', alias: ['missing', '缺卡', '卡片'],
      fix: '题库里有题、页面上找不到对应卡片，属于拼装锚点对不上。重跑一次通常能好；连续失败请把这一条的原文发出来。'
    },
    {
      key: 'answer', label: '自动作答后判错 = 0、抛错 = 0', alias: ['answer', '作答', '判错', 'auto'],
      fix: '按题库里的正确答案做一遍却判成错，通常是答案字段写错了（多选当单选、索引越界）。重跑一次换一批题；老是这样就把日志发出来。'
    },
    {
      key: 'tolerance', label: '写法容错（带单位、科学计数法都判对）', alias: ['toler', '容错', '写法', 'unit', 'sci', '单位'],
      fix: '填数题对写法太严格（比如必须一模一样）。这属于题目生成口径的问题，重跑一般能换一批更宽松的题。'
    },
    {
      key: 'progress', label: '进度与计数一致', alias: ['progress', '进度', 'cnt', '计数'],
      fix: '顶部「已作答」和各关计数跟卡片数对不上，多半是某个单元的卡片没渲染出来。重跑；持续出现请报告。'
    },
    {
      key: 'retry', label: '「重做本题」能把卡片复位', alias: ['retry', '重做', 'reset', '复位'],
      fix: '这是页面引擎本身的行为，重跑不能解决。请把这一条连同任务号报告给开发者。'
    },
    {
      key: 'script', label: '脚本错误 = 无', alias: ['script', '脚本', 'console', 'error'],
      fix: '页面里有 JS 报错，通常某个演示或陪练脚本崩了（崩了不影响其他题，但那个演示会不动）。重跑一次；还报错就把下面的错误原文复制出来。'
    },
    {
      key: 'demo', label: '演示读数正确、SVG 无越界', alias: ['demo', '演示', 'svg', '越界'],
      fix: '滑块读数跟公式对不上，或者图形跑出了画布。可以回结果页打开页面拖一下看看；重跑会换一份演示代码。'
    },
    {
      key: 'pet', label: '陪练形象符合预期', alias: ['pet', '陪练', '形象'],
      fix: '没放图时右下角本来就该空着。想让陪练出现：把 pet.png / pet.jpg 放到输出目录，或者重跑时选「内置大肥鱼」。'
    },
    {
      key: 'lines', label: '陪练台词覆盖（改过才看）', alias: ['line', '台词'],
      fix: '只有你改过台词才需要看这一条。没改过的话，这一项显示什么都可以忽略。'
    },
    {
      key: 'shot', label: '浅色 / 深色截图人眼检查', alias: ['shot', '截图', 'screenshot'],
      fix: '这一条要人眼看：有没有叠字、压线、被裁切，陪练有没有被裁、气泡有没有出屏。点「打开页面」，把系统切成浅色和深色各看一遍。'
    }
  ];

  function norm(s) { return String(s || '').toLowerCase().replace(/[\s_\-()（）【】\[\]:：=]/g, ''); }

  function findAdvice(item, index) {
    var nk = norm(item.key), nl = norm(item.label);
    for (var i = 0; i < CANON.length; i++) {
      var c = CANON[i];
      for (var j = 0; j < c.alias.length; j++) {
        var a = norm(c.alias[j]);
        if (nk && nk.indexOf(a) >= 0) return c;
        if (nl && nl.indexOf(a) >= 0) return c;
      }
    }
    return CANON[index] || null;
  }

  function report() {
    var s = ctx.state;
    if (s.report) return s.report;
    var j = s.job;
    if (j && j.result && j.result.report) return j.result.report;
    return null;
  }
  /* 独立审题的结论（主要是"有人怀疑、但没到两人独立确认"的那些题）。
     ⚠️ 报告里没有 audit 时**必须**往任务快照上回落：上面那个「重新校验」按钮
     只重跑探针、不含审题，它返回的 report 天然没有 audit —— 少了这层回落，
     用户点一次「重新校验」，这块提示就凭空消失（而它在报告里本来就是刚补上的）。 */
  function audit() {
    var r = report();
    if (r && r.audit) return r.audit;
    var j = ctx.state.job;
    var cands = [j && j.result, j && j.raw, j];
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] && cands[i].audit) return cands[i].audit;
    }
    return null;
  }
  function htmlFile() {
    // 多份产出时，用户可能正在看其中**不是第一份**的那一份 —— 那一个优先
    if (previewPath) return previewPath;
    var s = ctx.state;
    if (s.htmlPath) return s.htmlPath;
    var j = s.job;
    if (j && j.result) return j.result.htmlPath || (j.result.files && j.result.files.html) || null;
    return j && j.htmlPath ? j.htmlPath : null;
  }
  function fileTitle(p) { return String(p || '').replace(/^.*[\\/]/, ''); }

  /* ---------- 这次到底产出了几份页面 ----------
   *
   * 「每章一份 HTML」那一路上这是**必须**有的：一次点下去会写出好几个文件，
   * 而结果页默认只预览第一份 —— 没有这张清单，用户根本不知道另外几份存在、叫什么、在哪。
   * 数据来自任务快照的 `outputs`（pipeline 每落盘一份就往里 push 一条）。
   */
  var previewPath = null;      // 当前正在预览的那一份（多份时用户会切）

  function outputsOf() {
    var s = fullSnap();
    var list = (s && Array.isArray(s.outputs)) ? s.outputs : [];
    return list.filter(function (o) { return o && o.htmlPath; });
  }

  function chLabelOf(o) {
    var ch = (o && o.chapter) || {};
    var no = String(ch.no || '');
    var t = String(ch.title || '');
    return (no ? '第 ' + no + ' 章' : '（没填章号）') + (t ? ' · ' + t : '');
  }

  function buildOutputs(list) {
    var rows = list.map(function (o) {
      var here = htmlFile() === o.htmlPath;
      return el('div', { class: 'src-item', dataset: { out: o.htmlPath } }, [
        el('div', { class: 'filecard' }, [
          el('span', { class: 'fc-icon' }, icon('file')),
          el('div', { class: 'fc-body' }, [
            el('div', { class: 'fc-name', text: chLabelOf(o) + (o.chapters > 1 ? '（' + o.chapters + ' 章合一）' : '') }),
            el('div', { class: 'fc-meta' }, [
              el('span', { class: 'mono', style: 'min-width:0;max-width:100%;word-break:break-all', text: o.htmlPath }),
              o.chapterFile ? el('span', { class: 'pill ok', text: '可再并进一册' })
                : el('span', { class: 'pill warn', title: '没有结构数据，以后只能从页面反推', text: '不能精确合并' })
            ])
          ]),
          el('div', { class: 'fc-actions' }, [
            here
              ? el('button', { class: 'btn sm', type: 'button', disabled: true, text: '正在看' })
              : el('button', {
                class: 'btn sm primary', type: 'button', text: '看这一份',
                'aria-label': '在下面预览 ' + chLabelOf(o),
                on: {
                  click: function () {
                    previewPath = o.htmlPath;
                    root.innerHTML = '';
                    renderBody();
                  }
                }
              }),
            el('button', {
              class: 'btn sm', type: 'button', text: '打开',
              on: { click: function () { ctx.call('openPath', o.htmlPath); } }
            })
          ])
        ])
      ]);
    });

    return el('div', { class: 'card', dataset: { outputs: String(list.length) } }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: '这次产出了 ' + list.length + ' 份页面' }),
        el('div', { class: 'right' }, [el('span', { class: 'hint', text: '你选了「每章一份 HTML」，所以没有合并' })])
      ])
    ].concat(rows));
  }

  /* ---------- 「带上一章」：这一册现在有几章 ----------
   *
   * 数从哪里来：**任务快照**里的 `carry`（`gen:start` 把带过来的章挂在任务上）+ 1（这次新生成的那一章）。
   *
   * ⚠️ 结果页第一次渲染时手上**通常没有**它：任务跑完是 `job:event` 推过来的，事件里只有状态，
   *    没有 carry。所以这里按需回头问一次主进程（getJob）。
   * ⚠️ 判据必须是"**整份**快照"（带 sources 数组的那份）：`listJobs` 的历史摘要里既没有 sources
   *    也没有 carry，拿它当"这次没带章节"是错的 —— 那会在一册的结果页上挂出"把这一章并进一册？"，
   *    而它明明已经是一册了。
   * 拿不准（既没有快照、也没问回来）时**什么都不说**：宁可少一句话，也不许说错。
   */
  var jobSnap = null;      // 按需取回的整份任务快照
  var snapAsked = false;

  function fullSnap() {
    var cands = [jobSnap, ctx.state.job && ctx.state.job.raw, ctx.state.job];
    for (var i = 0; i < cands.length; i++) {
      var x = cands[i];
      if (x && Array.isArray(x.sources)) return x;
    }
    return null;
  }
  /** 带过来的章数（0 = 这次没合并）。拿不准 → null。 */
  function carriedChapters() {
    var s = fullSnap();
    if (!s) return null;
    return Array.isArray(s.carry) ? s.carry.length : 0;
  }
  function askSnapshot() {
    if (snapAsked) return;
    var j = ctx.state.job;
    var id = (j && j.id) || ctx.state.jobId;
    if (!id) return;
    if (!j || j.status !== 'done') return;        // 还没跑完 / 没有任务：这会儿问也问不出结果
    snapAsked = true;
    ctx.safe('读取任务', function () { return window.isg.getJob(id); }, { quiet: true }).then(function (res) {
      /* ⚠️ 回来的时候用户可能已经切走了（unmount 会把 root 置空）——
         这里不看住就会往一个已经拆掉的页面上写，或者对 null 取属性抛一个没人管的 Promise 错。 */
      if (!root || ctx.route() !== 'result') return;
      if (!res.ok || !res.data || !Array.isArray(res.data.sources)) return;
      jobSnap = res.data;
      root.innerHTML = '';
      renderBody();
    });
  }

  /** 这一册现在有几章（合并了才显示）。 */
  function bookBanner(n) {
    return el('div', { class: 'banner ok', style: 'margin-bottom:14px' }, [
      icon('book'),
      el('div', { class: 'bt' }, [
        el('b', { text: '这一册现在有 ' + (n + 1) + ' 章' }),
        el('div', {
          text: '以前生成的 ' + n + ' 章排在新章前面，都在这一个文件里。'
            + '册的存盘键沿用了带过来的那一章，所以以前做过的题在这个文件里还是同一份进度。'
        }),
        /* 说清"进度在哪儿"这件事的边界（合约 §7.5）：同源策略下换一种打开方式就看不到，
           那不是丢了、也不是本应用缺一段同步代码。宁可不厌其烦，也别让人以为进度被清零了。 */
        el('div', {
          class: 'hint',
          text: '注意：进度存在浏览器本地。换一种打开方式（应用内预览 / 双击文件 / 本地服务器）打开时，看到的不是同一份进度 —— 这是浏览器的同源策略，不是丢了。'
        })
      ])
    ]);
  }

  /**
   * 「把这一章并进一册？」—— 只在**这次没有合并**时出现。
   *
   * ⚠️ 后端还没有"事后合并"这条通道：合并只发生在**生成的时候**（`gen:start` 的 `carry`）。
   * 所以这个入口把人送回工作台、并把选择器打开，让他带着同样的材料再生成一次 ——
   * 文案必须如实说清这一步，别让人以为点一下就把两份文件合好了。
   */
  function mergeEntryBanner() {
    return el('div', { class: 'banner info', style: 'margin-bottom:14px' }, [
      icon('book'),
      el('div', { class: 'bt' }, [
        el('b', { text: '把这一章并进一册？' }),
        el('div', {
          text: '一册 = 以前生成过的几章 + 这一章，合成一个文件；以前那几章各自单独的文件不会被覆盖，'
            + '这一章自己这份也还在。以后再加一章，就继续往上并。'
        }),
        el('div', {
          class: 'hint',
          text: '做法：回工作台把以前的章节选上，再点一次「开始生成」——同样的材料会再跑一遍，这次带上它们。'
            + '还不能在这一页直接合并（合并发生在生成的时候）。'
        }),
        el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn sm primary', type: 'button', text: '去工作台选章节',
            on: {
              click: function () {
                /* carryOpen 让工作台挂载时直接把「从以前生成的章节里挑」那个列表展开：
                   用户从这一页过去，要看的就是那个列表，不该还要自己再找一次按钮。 */
                ctx.state.carryOpen = true;
                ctx.go('#workbench');
              }
            }
          })
        ])
      ])
    ]);
  }

  /**
   * 预览地址一律走主进程的 isg:// 协议（previewUrl），不自己拼 file://：
   * file:// 在 Chromium 里是 opaque origin —— 页面存不了做题进度、相对路径的陪练图时灵时不灵。
   */
  function loadPreview(path) {
    if (!frame) return;
    frame.setAttribute('src', 'about:blank');
    if (note) { note.hidden = false; note.className = 'hint preview-note'; note.textContent = '正在准备预览…'; }
    ctx.call('previewUrl', path).then(function (res) {
      // app:previewUrl 回 {url}；信封已经在 ctx.call（app.js 的 safe）那一处拆掉了，
      // 这里 res.data 就是载荷本身，不用再认第二层。
      var d = res.ok ? res.data : null;
      var url = (d && (typeof d === 'string' ? d : (d.url || d.href))) || '';
      var why = res.error || { message: '主进程没有返回可用的预览地址' };
      if (!url) {
        if (frame) frame.hidden = true;
        if (note) {
          note.hidden = false;
          note.className = 'banner warn preview-note';
          note.innerHTML = '';
          note.appendChild(icon('alert'));
          note.appendChild(el('div', { class: 'bt' }, [
            el('b', { text: '预览没能打开' }),
            el('div', { text: '主进程没有放行这个文件所在的目录（isg:// 只映射输出目录）。文件本身是好的，可以用「打开页面」直接看。' }),
            el('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, [
              el('button', { class: 'btn sm', type: 'button', text: '重试预览', on: { click: function () { loadPreview(path); } } }),
              el('button', { class: 'btn sm', type: 'button', text: '用系统程序打开', on: { click: openFile } }),
              ctx.detailButton(why)
            ])
          ]));
        }
        return;
      }
      if (frame) { frame.hidden = false; frame.setAttribute('src', url); }
      if (note) { note.hidden = true; note.className = 'hint preview-note'; }
    });
  }

  /* ---------- 校验报告 ---------- */

  function badge(ok) {
    if (ok === true) return el('span', { class: 'vi-badge' }, [icon('check', 11)]);
    if (ok === false) return el('span', { class: 'vi-badge' }, [icon('x', 11)]);
    return el('span', { class: 'vi-badge', text: '–' });
  }

  function verifyItem(item, index) {
    var ok = item.ok === true ? true : item.ok === false ? false : null;
    var advice = ok === false ? findAdvice(item, index) : null;
    var kids = [
      el('div', { class: 'vi-head' }, [
        badge(ok),
        el('div', { style: 'min-width:0;flex:1 1 auto' }, [
          el('div', { class: 'vi-label', text: item.label || (advice && advice.label) || ('第 ' + (index + 1) + ' 项') }),
          item.raw ? el('div', { class: 'vi-raw', text: String(item.raw) }) : null,
          item.note ? el('div', { class: 'hint', style: 'margin-top:3px', text: String(item.note) }) : null
        ]),
        /* 「降级交付」是**第三类**结果（既不是通过、也不是没通过，更不是"没测到"）：
           那一段讲解的问题由拼装器处理掉了，是我们没再重试直接交付的。见 pipeline 的 prose-downgrade。 */
        ok === null
          ? (item.key === 'prose-downgrade'
            ? el('span', { class: 'pill gold', text: '降级交付' })
            : el('span', { class: 'pill', text: '没测到' }))
          : null
      ])
    ];
    if (advice) {
      kids.push(el('div', { class: 'vi-fix' }, [
        el('b', { text: '怎么办：' }),
        el('span', { text: advice.fix })
      ]));
    }
    return el('div', { class: 'verify-item', dataset: { ok: ok === null ? 'null' : String(ok) } }, kids);
  }

  /* 「有人怀疑、但没被确认的题」。
     这些题**没有触发任何自动改动**——多位审题人交叉检验时，只有两个独立的人都报
     同一题才会重出；只被少数人报出的够不上这个门槛，原样保留、交给人看。

     措辞上只能写成"有人怀疑"，绝不能写成"答案错了"：
     审题最大的风险就是误报，写成断言会把用户骗去改本来正确的答案，
     而这块提示存在的全部意义恰恰是防止那种改动。所以：
       · 用「未确认」标签，不用红叉、不混进"没通过"的计数；
       · 明确说"不一定是错的，那位审题人可能自己看走眼"；
       · 他给的改法标注为"没有采用"。 */
  function buildAuditBlock(a) {
    if (!a) return null;
    var suspect = (a.suspect || []).filter(function (s) { return s && s.id; });
    var high = Number(a.high) || 0;
    if (!suspect.length && !high) return null;

    var head = el('div', {}, [
      el('div', { class: 'vi-label', style: 'margin-bottom:4px', text: '有人怀疑、但没被确认的题（' + suspect.length + ' 处，页面里的答案没有改动）' }),
      el('div', { class: 'hint', text: '多位审题人各自独立重算时，只有两个人都报同一题才会自动重出；下面这些只被少数人报出，够不上这个门槛，所以答案保持原样。它们不一定是错的——那位审题人自己也可能是看走眼了，要不要改由你定。' })
    ]);
    if (high) {
      head.appendChild(el('div', { class: 'hint', style: 'margin-top:4px', text: '另有 ' + high + ' 处被两位以上审题人一致确认，已经按审题意见重出过，不在上面的清单里。' }));
    }

    var rows = suspect.map(function (s) {
      var by = (s.by && s.by.length) ? s.by.join('、') : String(s.n || 1);
      var kids = [
        el('div', { class: 'vi-head' }, [
          el('span', { class: 'pill gold', text: '未确认' }),
          el('div', { style: 'min-width:0;flex:1 1 auto' }, [
            el('div', { class: 'vi-label', text: (s.unit ? '「' + s.unit + '」' : '') + '第 ' + s.id + ' 题' }),
            s.stem ? el('div', { class: 'vi-raw', text: s.stem }) : null,
            el('div', { class: 'vi-raw', style: 'margin-top:3px', text: '第 ' + by + ' 位审题人（共 ' + (s.of || 1) + ' 位）怀疑：' + (s.detail || '（没说清楚怀疑什么）') }),
            s.suggest ? el('div', { class: 'hint', style: 'margin-top:3px', text: '他给的改法是「' + s.suggest + '」——没有采用；不认同就不用管它。' }) : null
          ])
        ])
      ];
      return el('div', { class: 'verify-item', dataset: { ok: 'null' } }, kids);
    });

    return el('div', { style: 'margin-top:16px' }, [
      head,
      rows.length ? el('div', { class: 'verify-list', style: 'margin-top:8px' }, rows) : null
    ]);
  }

  function buildReport() {
    var box = el('div', { class: 'card' });
    var r = report();
    var items = (r && Array.isArray(r.items)) ? r.items : null;

    box.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: '校验报告' }),
      el('div', { class: 'right' }, [
        el('button', {
          class: 'btn sm', type: 'button', disabled: !htmlFile(),
          on: {
            click: function () {
              var p = htmlFile();
              if (!p) return;
              ctx.call('verifyHtml', p, ['verify', 'demo', 'pet']).then(function (res) {
                if (!res.ok || !res.data) return;
                ctx.state.report = res.data;
                root.innerHTML = '';
                renderBody();
                ctx.toast('重新校验完成', 'ok');
              });
            }
          }
        }, [icon('refresh'), el('span', { text: '重新校验' })])
      ])
    ]));

    if (!r || !items) {
      box.appendChild(ctx.emptyState({
        icon: 'checkSquare', title: '还没有校验报告',
        text: '生成完成时会自动跑一次隐藏窗口校验，结果会显示在这里。如果你手上已经有生成好的 HTML，也可以点上面「重新校验」。'
      }));
      // 校验没跑起来（报告是空的）不代表审题没结论——那部分信息更要露出来，不能跟着报告一起消失
      var auEmpty = buildAuditBlock(audit());
      if (auEmpty) box.appendChild(auEmpty);
      return box;
    }

    var pass = items.filter(function (i) { return i.ok === true; }).length;
    var fail = items.filter(function (i) { return i.ok === false; }).length;
    /* 「降级交付」不混进这两个数字里：它既不是通过也不是没通过，
       更不是"没测到"（用户最该看到的是"这一段没重试过、但页面里没有那些东西"）。 */
    var downgraded = items.filter(function (i) { return i.key === 'prose-downgrade'; }).length;
    var unknown = items.length - pass - fail - downgraded;

    var au = audit();
    var suspects = (au && au.suspect) ? au.suspect.filter(function (s) { return s && s.id; }).length : 0;

    box.appendChild(el('div', { class: 'verify-summary' }, [
      el('span', { class: 'pill ' + (fail ? 'warn' : 'ok') }, [
        el('span', { class: 'dot' }),
        el('span', { text: fail ? (fail + ' 项没通过') : '全部通过' })
      ]),
      /* 它是**第三类**结果：既不是"通过"也不是"没通过"。
         所以用中性的金色标签，别塞进 fail 的计数里——那会把"有人怀疑"读成"已确认的错误"。 */
      suspects ? el('span', { class: 'pill gold', text: suspects + ' 处存疑待你判断' }) : null,
      downgraded ? el('span', { class: 'pill gold', text: downgraded + ' 段讲解降级交付' }) : null,
      el('span', { class: 'hint', text: '通过 ' + pass + ' · 没通过 ' + fail + (unknown ? ' · 没测到 ' + unknown : '') }),
      r.durationMs ? el('span', { class: 'hint', text: '耗时 ' + r.durationMs + ' ms' }) : null,
      r.title ? el('span', { class: 'hint mono', text: ctx.clip(r.title, 60) }) : null
    ]));

    var list = el('div', { class: 'verify-list' });
    items.forEach(function (it, i) { list.appendChild(verifyItem(it, i)); });

    // 报告项比兜底清单还少时，把没出现的补齐，别让用户以为"漏项"
    if (items.length < CANON.length) {
      var used = {};
      items.forEach(function (it, i) { var a = findAdvice(it, i); if (a) used[a.key] = true; });
      CANON.forEach(function (c, i) {
        if (used[c.key]) return;
        list.appendChild(verifyItem({ key: c.key, label: c.label, ok: null, raw: '这次没有这一项的探测结果' }, i));
      });
    }
    box.appendChild(list);

    var auBlock = buildAuditBlock(au);
    if (auBlock) box.appendChild(auBlock);

    if (r.consoleErrors && r.consoleErrors.length) {
      var pre = el('pre', { text: r.consoleErrors.join('\n') });
      box.appendChild(el('details', { style: 'margin-top:12px' }, [
        el('summary', { style: 'cursor:pointer;font-size:12.5px;color:var(--ink-2)', text: '页面里的脚本错误原文（' + r.consoleErrors.length + ' 条）' }),
        pre
      ]));
    }
    return box;
  }

  /* ---------- 这次的预估费用 ----------
   *
   * 单价是**用户自己在设置里填的**（`providers.<id>.billing`），这个应用不知道任何一家的真实价目表
   * —— 所以这里从头到尾只说"预估"，并且把**算式与用量**一并摆出来，让用户自己能核对。
   * 没填单价（或没开）时**什么都不显示**：一个"¥0.00"比不显示更糟，用户会以为真的不花钱。
   *
   * ⚠️ 只统计 `job.usage`（主进程在 askJson 那一层累加，**重试那几轮也算**）。
   * 有几次调用提供商没返回用量时如实说出来 —— 假装总数是准的，比不显示更坏。
   */
  function billingOf() {
    var s = ctx.state.settings;
    if (!s || !s.active || !s.providers) return null;
    var p = s.providers[s.active.provider];
    var b = p && p.billing;
    if (!b || !b.enabled) return null;
    var inP = Number(b.inputPerM) || 0;
    var outP = Number(b.outputPerM) || 0;
    if (inP <= 0 && outP <= 0) return null;
    return { in: inP, out: outP, cur: b.currency || 'CNY' };
  }

  function buildCost() {
    var bill = billingOf();
    var snap = fullSnap();
    var u = snap && snap.usage;
    if (!bill || !u || !u.calls) return null;

    var cost = (u.in / 1e6) * bill.in + (u.out / 1e6) * bill.out;
    var money = (bill.cur === 'CNY' ? '¥' : (bill.cur === 'USD' ? '$' : bill.cur + ' '))
      + cost.toFixed(cost < 0.01 ? 4 : 2);

    return el('div', { class: 'card', dataset: { cost: '1' } }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: '这次的预估费用' }),
        el('div', { class: 'right' }, [el('span', { class: 'hint', text: money })])
      ]),
      el('div', { class: 'hint', text:
        '按你在设置里为这家提供商填的单价算的（输入 ' + bill.in + ' / 输出 ' + bill.out
        + ' 每百万 token，单位 ' + bill.cur + '）。这只是预估：以服务商的实际账单为准，'
        + '而且它只算这一台机器上这一次任务的用量。' }),
      el('div', { class: 'hint', style: 'margin-top:6px', text:
        '用量：输入 ' + u.in.toLocaleString() + ' token，输出 ' + u.out.toLocaleString()
        + ' token，共 ' + u.calls + ' 次调用'
        + (u.unreported ? ('（其中 ' + u.unreported + ' 次服务商没有返回用量，没算进总数）') : '') })
    ]);
  }

  /* ---------- 预览 ---------- */

  function buildPreview() {
    var p = htmlFile();
    var bar = el('div', { class: 'preview-bar' }, [
      el('span', { class: 'path', title: p || '', text: p || '还没有生成文件' }),
      el('div', { class: 'right' }, [
        el('button', {
          class: 'btn sm ghost', type: 'button', 'aria-label': '刷新预览',
          disabled: !p,
          on: { click: function () { loadPreview(p); } }
        }, [icon('refresh')]),
        el('button', {
          class: 'btn sm', type: 'button', text: '打开页面', disabled: !p,
          on: { click: function () { openFile(); } }
        })
      ])
    ]);

    /* sandbox 只留这两项：
     *   allow-scripts       —— 生成页的判分引擎、演示、陪练都要跑；
     *   allow-same-origin   —— 生成页用 localStorage 存做题进度，去掉它进度就存不住。
     * 明确**不给**的三项（都是安全审计实测能被模型产出的页面利用的路）：
     *   allow-popups   —— window.open() 会被主进程交给系统浏览器，不受页面 CSP 约束；
     *   allow-downloads—— 不需要用户手势就能往下载目录里塞任意文件名/扩展名；
     *   allow-modals   —— 可以拿 alert/confirm 做社工。
     * iframe 是 isg://local、父页是 file://（跨源），父页读不到它的 DOM，
     * preload 也不进子帧，所以生成页拿不到 window.isg。 */
    frame = el('iframe', {
      title: '生成的学习页预览',
      src: 'about:blank',
      sandbox: 'allow-scripts allow-same-origin'
    });
    note = el('div', { class: 'hint preview-note', text: '正在准备预览…' });

    if (!p) {
      frame.hidden = true;
      note.hidden = true;
    }

    var box = el('div', { class: 'preview-frame' }, [bar, note, frame]);
    if (p) loadPreview(p);
    return box;
  }

  /* ---------- 操作 ---------- */

  function openFile() {
    var p = htmlFile();
    if (!p) { ctx.toast('还没有生成文件', 'warn'); return; }
    ctx.call('openPath', p);
  }
  function reveal() {
    var p = htmlFile();
    if (!p) { ctx.toast('还没有生成文件', 'warn'); return; }
    ctx.call('revealPath', p);
  }

  function actionBar() {
    var p = htmlFile();
    return el('div', { class: 'sticky-foot' }, [
      el('button', { class: 'btn primary', type: 'button', disabled: !p, on: { click: openFile } },
        [icon('external'), el('span', { text: '打开页面' })]),
      el('button', { class: 'btn', type: 'button', disabled: !p, on: { click: reveal } },
        [icon('folder'), el('span', { text: '在文件夹中显示' })]),
      el('button', {
        class: 'btn', type: 'button', disabled: !p,
        on: { click: function () { ctx.copy(p, '路径已复制'); } }
      }, [icon('copy'), el('span', { text: '复制路径' })]),
      el('button', {
        class: 'btn', type: 'button',
        on: {
          click: function () {
            ctx.confirm('重新生成这一章？',
              '会用同样的课件和同样的选项再跑一次，输出目录里的同名文件会被覆盖。',
              '重新生成').then(function (ok) {
                if (!ok) return;
                ctx.startGeneration();
              });
          }
        }
      }, [icon('refresh'), el('span', { text: '重新生成这一章' })]),
      ctx.state.job && ctx.state.job.id
        ? el('span', { class: 'hint mono', style: 'margin-left:auto', text: '任务号 ' + ctx.state.job.id })
        : null
    ]);
  }

  /* ---------- 组装 ---------- */

  function renderBody() {
    var s = ctx.state;
    var p = htmlFile();
    var j = s.job;

    root.appendChild(ctx.pageHead({
      title: '结果',
      sub: p ? ('生成文件：' + fileTitle(p)) : '生成的页面、校验报告都在这里',
      actions: [
        el('button', {
          class: 'btn sm ghost', type: 'button', text: '回到运行',
          on: { click: function () { ctx.go('#run'); } }
        })
      ]
    }));

    if (!p) {
      var failed = j && j.status === 'error';
      var going = j && (j.status === 'running' || j.status === 'pending');
      root.appendChild(ctx.emptyState({
        icon: failed ? 'alert' : going ? 'clock' : 'layers',
        title: failed ? '这一次没有生成出文件' : going ? '正在生成中' : '还没有生成结果',
        text: failed
          ? '任务在中间某一步失败了，运行页里有失败原因和当时的日志。'
          : going
            ? '任务还在跑，跑完这里会自动出现可以预览的页面和校验报告。'
            : '去工作台选一份课件、点「开始生成」，跑完这里就会出现可以预览的页面和校验报告。',
        action: el('button', {
          class: 'btn primary', type: 'button',
          text: failed ? '去看失败原因' : going ? '去看进度' : '去工作台',
          on: { click: function () { ctx.go(failed || going ? '#run' : '#workbench'); } }
        })
      }));
      /* 跑砸 / 取消之后：给一个「清理本次产生的临时文件」的入口（先列清单、确认了才删）。
         没有页面可看的时候，这才是这一页真正能做的事。 */
      if (j && j.id && (j.status === 'error' || j.status === 'cancelled')) {
        root.appendChild(el('div', { class: 'sticky-foot' }, [
          el('button', {
            class: 'btn', type: 'button', text: '清理这次产生的临时文件',
            on: { click: function () { ctx.runCleanup(j.id); } }
          })
        ]));
      }
      if (j && j.id) root.appendChild(actionBar());
      return;
    }

    /* 「这次产出了几份页面」。只有多份时才出现（单份时那一份就是下面预览里的这一份，
       再列一遍是啰嗦）。放在最上面：对"每章一份"那条路来说，**先告诉用户有几个文件**
       比"看第一份长什么样"重要得多 —— 否则另外几份他根本不知道存在。 */
    var outs = outputsOf();
    if (outs.length > 1) root.appendChild(buildOutputs(outs));
    var cost = buildCost();
    if (cost) root.appendChild(cost);

    var layout = el('div', { class: 'result-layout' }, [
      buildPreview(),
      buildReport()
    ]);
    /* 合并状态的两句话：这一册现在有几章 / 要不要把它并进一册。
       放在最上面（预览之前）：它说的是"这一份到底是什么"，比"页面长什么样"更靠前。 */
    var n = carriedChapters();
    if (n !== null && n > 0) root.appendChild(bookBanner(n));
    else if (n === 0) root.appendChild(mergeEntryBanner());
    root.appendChild(layout);
    root.appendChild(actionBar());
    askSnapshot();          // 手上没有整份快照时补问一次（拿不准就什么都不显示）
  }

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    frame = null; note = null;
    jobSnap = null; snapAsked = false;
    renderBody();
  }
  function unmount() {
    root = null; ctx = null; frame = null; note = null; jobSnap = null; snapAsked = false;
    // 「正在看哪一份」是**这一页的**临时状态：离开结果页再回来，应该回到第一份
    previewPath = null;
  }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.result = { mount: mount, unmount: unmount };
})();
