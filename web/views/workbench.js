/* 工作台：选课件 → 填元信息 → 调生成选项 → 开始生成 */
(function () {
  'use strict';

  var root = null, ctx = null;
  var el, icon;
  var fileArea, fileHead, startArea;
  var startError = null;         // 上一次「开始生成」为什么没开始（主进程的信封 error）

  /* ---------- 小工具 ---------- */

  function baseName(p) { return String(p || '').replace(/^.*[\\/]/, ''); }

  /**
   * 有没有"能用的"提供商 = 启用 && 填了 Key。
   *
   * 形状以 store.getPublicSettings() 为准：`providers` 是**以 id 为键的对象 map**，
   * "有没有 Key"是 provider 级的扁字段 `hasKey`（没有 apiKey 子对象）。
   * （旧写法按数组 + p.apiKey.hasKey 判断，于是永远返回 false —— 按钮永远是灰的。）
   */
  function providerReady(s) {
    if (!s) return null;                       // 读不到设置 → 不做判断
    var raw = s.providers;
    var list = Array.isArray(raw) ? raw
      : (raw && typeof raw === 'object') ? Object.keys(raw).map(function (id) {
        var p = raw[id] || {};
        return Object.assign({ id: id }, p);
      })
        : (Array.isArray(s.presets) ? s.presets : null);
    if (!list) {
      if (typeof s.hasKey === 'boolean') return s.hasKey;
      return null;                             // 形状认不出来 → 不下结论，别拦着用户
    }
    if (!list.length) return false;
    return list.some(function (p) {
      if (!p || p.enabled === false) return false;
      if (typeof p.hasKey === 'boolean') return p.hasKey;      // store 的形状
      var k = p.apiKey;                                        // 老形状，兼容着
      return (k === true) || (typeof k === 'string' && k.length > 0) ||
        (k && typeof k === 'object' && k.hasKey === true);
    });
  }

  function field(labelText, control, hintText, id) {
    return el('div', { class: 'field' }, [
      el('label', { text: labelText, for: id || null }),
      control,
      hintText ? el('div', { class: 'hint', text: hintText }) : null
    ]);
  }

  /** 数值滑块 + 读数（键盘可达：range 本身 ←/→ 可调） */
  function rangeField(labelText, min, max, step, value, hintText, onChange) {
    var out = el('span', { class: 'range-val', text: String(value) });
    var input = el('input', {
      type: 'range', min: min, max: max, step: step, value: value,
      'aria-label': labelText,
      on: {
        input: function () { out.textContent = String(input.value); },
        change: function () { onChange(Number(input.value)); }
      }
    });
    var wrap = el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: labelText }),
      el('div', { class: 'range-row' }, [input, out]),
      el('div', { class: 'range-scale' }, [el('span', { text: String(min) }), el('span', { text: String(max) })]),
      hintText ? el('div', { class: 'hint', text: hintText }) : null
    ]);
    return wrap;
  }

  /* ---------- 材料清单 ----------
   *
   * 以前这里是「单张卡片 / 单个拖拽区」二选一。多来源之后要能同时看到好几份材料，
   * 所以改成清单：一行一份，**角色下拉 + 文件名 + 操作**。角色（课件/课本/习题/历年真题）
   * 决定这份材料在提示词里怎么被用，同名角色可以有多份。
   */

  function buildDropzone() {
    var dz = el('div', {
      class: 'dropzone', role: 'button', tabindex: '0',
      'aria-label': '选择材料文件，支持 pptx、pdf、txt、md',
      on: {
        click: function () { pick(); },
        keydown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        }
      }
    }, [
      el('span', { class: 'dz-icon' }, icon('upload')),
      el('b', { text: '把材料拖到这里' }),
      el('span', { class: 'sub', text: '整窗任意位置松手都算数（一次拖几份就加几份），也可以点这里选择文件' }),
      el('span', { class: 'types', text: '.pptx · .ppsx · .pdf · .txt · .md' })
    ]);
    return dz;
  }

  /** 一份都没有时，灰着列出四个角色到底是干什么的 —— 让用户知道可以往里放什么。 */
  function buildRoleGuide() {
    return el('div', { class: 'role-guide' }, [
      el('div', { class: 'rg-title', text: '可以放这些（最少一份就够；加进来之后角色随时能改）' })
    ].concat(ctx.ROLES.map(function (r) {
      return el('div', { class: 'rg-row' }, [
        el('span', { class: 'pill', text: ctx.ROLE_LABEL[r] }),
        el('span', { text: ctx.ROLE_HINT[r] })
      ]);
    })));
  }

  /** 「添加材料」按钮。选文件对话框支持**多选**，一次挑完几份真题不用点好几轮。 */
  function buildAddRow() {
    return el('div', { class: 'src-add' }, [
      el('button', {
        class: 'btn', type: 'button',
        on: { click: function () { pick(); } }
      }, [icon('plus'), el('span', { text: '添加材料' })]),
      el('span', { class: 'hint', text: '可以一次选多份（按 Ctrl / Shift 多选）；也可以直接把文件拖进窗口' })
    ]);
  }

  function pick() {
    ctx.call('pickFile').then(function (res) {
      // `dialog:pickFile` 现在**恒定回数组**（取消时是空数组），所以判长度就够了
      if (!res.ok || !Array.isArray(res.data) || !res.data.length) return;
      addPaths(res.data);
    });
  }

  /**
   * 把一批路径加进清单。
   *
   * 一次选回来好几份时**逐个**加：`addSource` 只管一份（它要分配 id、登记放行、建行），
   * 所以这里只负责循环与刷新，不把逻辑塞进它里面。
   * 抽文本**只抽新加进来的这几份**——清单里别的材料可能早就读好了，没必要重抽一遍大 PDF。
   */
  function addPaths(paths) {
    var added = [];
    paths.forEach(function (p) {
      var src = ctx.addSource(ctx.DEFAULT_ROLE, p, { name: baseName(p) });
      if (src) added.push(src);
    });
    refreshSources();
    refreshStartArea();
    added.forEach(function (src) {
      ctx.loadExtract(src.id).then(function () { refreshSources(); });
    });
  }

  function roleSelect(src) {
    var sel = el('select', {
      'aria-label': '这份材料的角色',
      on: {
        change: function () {
          ctx.setSourceRole(src.id, sel.value);
          refreshSources();          // 角色写在行上（提示语、页脚的称呼都跟着变）
          refreshStartArea();
        }
      }
    });
    ctx.ROLES.forEach(function (r) {
      sel.appendChild(el('option', { value: r, text: ctx.ROLE_LABEL[r] }));
    });
    sel.value = src.role;            // 用 value 选而不是给 option 加 selected 属性：重画时更稳
    return el('span', { class: 'select-wrap src-role', title: ctx.ROLE_HINT[src.role] || '' }, [sel]);
  }

  /** 这份材料的诊断横幅：抽取失败 / 疑似扫描件。两者都只影响**这一份**。 */
  function buildRowNotes(src) {
    var kids = [];
    var ex = src.extract || {};
    var diag = ex.diagnosis;

    if (src.extractError) {
      kids.push(el('div', { class: 'banner warn', style: 'margin:10px 0 0' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这份材料没读出来' }),
          el('div', { text: '可能是文件损坏、加密，或格式不支持。可以重试一次，或者把它从清单里去掉、换一份。' }),
          el('div', { class: 'hint mono', text: ctx.clip((src.extractError && src.extractError.message) || String(src.extractError), 220) }),
          el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, [
            el('button', {
              class: 'btn sm', type: 'button', text: '重新读一次',
              on: {
                click: function () {
                  refreshSources();
                  ctx.reloadSourceExtract(src.id).then(function () { refreshSources(); });
                }
              }
            }),
            ctx.detailButton(src.extractError)
          ])
        ])
      ]));
    } else if (diag && diag.likely) {
      /* 「疑似扫描件」= 整页没有文字层 / 整页只有图，占到六成（主进程 diagnoseScanned）。
         这一轮**不做 OCR**：现在说清楚，比等到生成跑到一半才失败强得多。 */
      kids.push(el('div', { class: 'banner warn', style: 'margin:10px 0 0' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这份材料多半是扫描件，抽不到文字' }),
          el('div', { text: diag.reason || '整页都是图片，没有可复制的文字层。' }),
          (diag.suggestions && diag.suggestions.length)
            ? el('div', { class: 'hint', text: '可以：' + diag.suggestions.join('；') })
            : null
        ])
      ]));
    } else if (src.extract) {
      var n = ctx.editedCountOf(src.id);
      kids.push(el('div', { class: 'hint', style: 'margin-top:10px' }, [
        el('span', {
          text: n ? ('你手动改过 ' + n + ' 页的文本，生成时会带上改后的版本。')
            : '生成前建议扫一眼抽取出来的文字，PDF 抽歪了可以当场改。'
        })
      ]));
    }
    return kids;
  }

  /**
   * 「这份材料属于第几章」。
   *
   * 只在**清单里不止一份材料**时才出现：一份材料时"哪一章"由下面「这一章是什么」那张卡
   * 上的「章号」决定，再多一个输入框只会让人以为两个地方要填两遍。
   * 两份及以上时它才有意义 —— 第 13 章的课本 + 课件是一章的两份来源，第 14 章那份是另一章。
   */
  function chapterInput(src) {
    var input = el('input', {
      type: 'text', class: 'ch-no', value: src.chapterNo || '',
      placeholder: '跟随',
      'aria-label': '「' + (src.fileName || '') + '」属于第几章',
      title: '留空 = 与「这一章是什么」里填的章号相同',
      on: {
        input: function () { ctx.setSourceChapter(src.id, input.value); },
        change: function () { ctx.setSourceChapter(src.id, input.value); refreshStartArea(); }
      }
    });
    return el('span', { class: 'ch-pick', title: '留空 = 与「这一章是什么」里填的章号相同' },
      [el('span', { class: 'ch-lbl', text: '第' }), input, el('span', { class: 'ch-lbl', text: '章' })]);
  }

  function buildSourceRow(src) {
    var meta = [];
    if (src.fileKind) meta.push(el('span', { class: 'pill field', text: String(src.fileKind).toUpperCase() }));
    if (typeof src.fileSize === 'number') meta.push(el('span', { text: ctx.fmtBytes(src.fileSize) }));
    var ex = src.extract;
    if (ex && ex.meta && ex.meta.pageCount) {
      meta.push(el('span', { text: ex.meta.pageCount + ' 页' }));
    } else if (src.extractLoading) {
      meta.push(el('span', { class: 'pill info' }, [ctx.spinner(), el('span', { text: '正在读页数…' })]));
    }
    if (ex && ex.diagnosis && ex.diagnosis.likely) {
      meta.push(el('span', { class: 'pill warn', title: ex.diagnosis.reason || '', text: '疑似扫描件' }));
    }
    if (ex && ex.warnings && ex.warnings.length) {
      var suspect = (ex.pages || []).filter(function (p) { return p.quality && p.quality.suspect; });
      if (suspect.length) meta.push(el('span', { class: 'pill warn', text: '有 ' + suspect.length + ' 页需要看看' }));
    }
    var edited = ctx.editedCountOf(src.id);
    if (edited) meta.push(el('span', { class: 'pill info', text: '已改 ' + edited + ' 页' }));

    var actions = el('div', { class: 'fc-actions' }, [
      el('button', {
        class: 'btn sm', type: 'button', text: '抽取预览',
        'aria-label': '查看并修改「' + src.fileName + '」抽取出来的文字',
        on: {
          click: function () {
            /* 抽取预览会按来源分组，页号在多来源下是重复的。
               记下要看的是哪一份，那边渲染完直接滚过去，省得用户在几十页里找。 */
            ctx.state.extractFocus = src.id;
            ctx.go('#extract');
          }
        }
      }),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': '把这份材料从清单里去掉',
        title: '移除',
        on: {
          click: function () {
            ctx.removeSource(src.id);
            refreshSources(); refreshStartArea();
          }
        }
      }, icon('x'))
    ]);

    /* 章的归属放在**行内**（角色下拉的右边、文件名之前），而不是收进"分章"卡片里：
       它和角色一样是"这一份是什么"的一部分，改的入口要就在那一行上。
       只有清单里不止一份材料时才画 —— 一份材料时它没有第二种可能（见 chapterInput）。 */
    var multi = ctx.state.sources.length > 1;

    return el('div', { class: 'src-item', dataset: { role: src.role, id: src.id } }, [
      el('div', { class: 'filecard' }, [
        el('span', { class: 'fc-icon' }, icon('file')),
        roleSelect(src),
        multi ? chapterInput(src) : null,
        el('div', { class: 'fc-body' }, [
          el('div', { class: 'fc-name', title: src.filePath, text: src.fileName || baseName(src.filePath) }),
          el('div', { class: 'fc-meta' }, meta.length ? meta : [el('span', { text: '已加入' })])
        ]),
        actions
      ])
    ].concat(buildRowNotes(src)));
  }

  function refreshSources() {
    if (!fileArea || !root) return;
    var s = ctx.state;
    fileArea.innerHTML = '';
    if (!s.sources.length) {
      fileArea.appendChild(buildDropzone());
      fileArea.appendChild(buildRoleGuide());
      return;
    }
    s.sources.forEach(function (src) { fileArea.appendChild(buildSourceRow(src)); });
    fileArea.appendChild(buildAddRow());
    if (fileHead) {
      fileHead.textContent = '材料 · ' + s.sources.length + ' 份';
    }
  }


  /* ---------- 这次怎么出（一册 / 每章一份） ----------
   *
   * 先选产出形态，再谈别的。用户的原话是"导入时先选：生成总 HTML / 分开生成 HTML"，
   * 而它确实该在最前面：它决定"点下去会得到几个文件"，比"这一章叫什么"更靠前。
   *
   * ⚠️ 下面这段只做**显示**用的粗算（数几个不同的章号），**判据不在这里**：
   * 权威分组在 `pipeline/chapters.js`（那边有单测），主进程还会在开跑之前硬拦
   * "一部分材料填了章号、一部分没填"。这里重复一份完整规则迟早会走散 ——
   * 而走散的表现是"界面说 2 章、实际出来 1 章"，用户没有任何办法看出来。
   */

  /** 有效章号：这份材料自己填的，否则跟「这一章是什么」里那个。空串就是"没分章"。 */
  function effNo(src) {
    var own = String((src && src.chapterNo) || '').trim();
    if (own) return own;
    return String((ctx.state.options && ctx.state.options.chapterNo) || '').trim();
  }

  /**
   * `{ nos:['13','14'], missing:2, total:3 }`
   *
   * `nos` **排过序**，顺序与主进程最终产出的章序一致（两边都像数字就按数值比，否则按字符串）。
   * 为什么这里要跟着排：用户在这张卡上看到的"第 13 章 / 第 14 章"就是他期待的顺序，
   * 显示成加入顺序（先拖了课本就先写 14）而产物是 13 在前，看上去就像章序错了。
   * ⚠️ 规则以 `pipeline/chapters.js` 的 `compareChapterNo` 为准，这里只是**显示**用的同一条。
   */
  function chapterSummary() {
    var list = ctx.state.sources || [];
    var nos = [];
    var missing = 0;
    list.forEach(function (s) {
      var no = effNo(s);
      if (!no) { missing++; return; }
      if (nos.indexOf(no) < 0) nos.push(no);
    });
    var numOf = function (x) { return /^\d+$/.test(String(x).trim()) ? Number(String(x).trim()) : null; };
    nos.sort(function (a, b) {
      var na = numOf(a), nb = numOf(b);
      if (na !== null && nb !== null && na !== nb) return na - nb;
      return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
    });
    return { nos: nos, missing: missing, total: list.length };
  }

  function modeCard(value, title, desc, disabled) {
    var input = el('input', {
      type: 'radio', name: 'wb-mode', value: value,
      checked: (ctx.state.mode || 'book') === value,
      disabled: !!disabled,
      on: { change: function () { if (input.checked) { ctx.setMode(value); refreshMode(); refreshCarry(); refreshStartArea(); } } }
    });
    return el('label', { class: 'radio-card' + (disabled ? ' disabled' : '') }, [
      input,
      el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
    ]);
  }

  function buildPlanCard() {
    var s = chapterSummary();
    var n = s.nos.length || 1;
    var kids = [];

    kids.push(el('div', { class: 'card-head' }, [
      el('h2', { text: '这次怎么出' }),
      el('div', { class: 'right' }, [
        el('span', {
          class: 'hint',
          // 一句话总账：用户在点之前就知道"会拿到几个文件、跑几轮"
          text: n > 1 ? ('会分成 ' + n + ' 章，按下面的选择产出') : '这一次只有一章'
        })
      ])
    ]));

    if (s.missing && s.missing < s.total) {
      /* 混着填是**当场说清**的一类错误：主进程会拦，但等到点"开始生成"才被拦，
         用户已经以为配置好了。这里提前把"是哪几份没填"指出来。 */
      kids.push(el('div', { class: 'banner warn', style: 'margin-bottom:10px' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '有 ' + s.missing + ' 份材料没填章号' }),
          el('div', { text: '要么每份都填上它属于哪一章，要么全都留空（全都留空就是只生成一章）。' +
            '混着填没法判断"没填的那几份"该并进哪一章，所以不能开始生成。' })
        ])
      ]));
    }

    kids.push(el('div', { class: 'radio-cards row' }, [
      modeCard('book', '合成一册', n > 1
        ? ('这几章缝成一份 HTML（一个文件，一个进度条，一个结算区）。')
        : '所有材料缝成一份 HTML。这就是一直以来的做法。'),
      modeCard('separate', '每章一份 HTML', '每章各自一个文件，互不引用。适合"这周只发这一章给同学"。')
    ]));

    if (n > 1) {
      var list = el('div', { class: 'ch-list', style: 'margin-top:10px' });
      s.nos.forEach(function (no) {
        var names = (ctx.state.sources || []).filter(function (x) { return effNo(x) === no; })
          .map(function (x) { return ctx.ROLE_LABEL[x.role] || x.role; });
        list.appendChild(el('div', { class: 'ch-row' }, [
          el('span', { class: 'pill', text: '第 ' + no + ' 章' }),
          el('span', { class: 'hint', text: names.join(' + ') + '（' + names.length + ' 份材料）' })
        ]));
      });
      kids.push(el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '章与材料的对应' }),
        list
      ]));
    }

    /* 成本要说清楚（这个应用一贯这么做）。它不是一个可以藏起来的细节：
       多一章就意味着**多一整轮**模型调用，而用户对"点了要等多久、花多少钱"是有直觉预期的。 */
    kids.push(el('p', {
      class: 'hint', style: 'margin:8px 0 0',
      text: n > 1
        ? ('⚠️ 每一章都要单独跑一遍：切单元、每个单元的讲解与题库、演示。'
          + '所以 ' + n + ' 章大致就是 ' + n + ' 倍的调用次数与等待时间'
          + ((ctx.state.options.auditors > 0) ? '（审题那几次也按章算）' : '')
          + '；串行执行，一章跑完再跑下一章。')
        : '每一章都要单独跑一遍（切单元、逐单元讲解与题库、演示），所以多一章就大致多一倍等待时间。'
    }));

    return el('div', { class: 'card', id: 'wb-plan' }, kids);
  }

  var planArea = null;

  function refreshMode() {
    if (!planArea) return;
    planArea.innerHTML = '';
    planArea.appendChild(buildPlanCard());
  }

  /* ---------- 带上以前的章节（可选） ----------
   *
   * 课是一节一节上的：这次的课件常常只有今天讲的那一章。把**以前生成过的页面**带上，
   * 它们会排在新章前面，和今天这一章**合成一册**（同一个文件）；以后再加一章就继续往上并。
   *
   * 三条纪律：
   *   1. 能不能带**不靠文件名猜**，一律先问主进程（`book:inspect`）。
   *      有 blocker 就不许加入，并把**是哪一条**摆在脸上；有 warn 可以加，但警告挂在那一行上。
   *      理由：合并的两条失败模式都很安静——留到"生成到一半"才发现不能用，用户已经白等十几分钟；
   *      而结构对不上却硬合，产出的是一册串了单元的复习书，几周后才发现。
   *   2. 三种状态三种说法（数据完整 / 只有页面 / 用不了）。**全都用一个灰徽标是信息丢失**：
   *      "只有页面"那条路会丢结构信息（见下面的显式警告），用户有权在动手之前知道。
   *   3. 排序只用「上移 / 下移」。**不做拖拽**：这个仓库里没有拖拽排序的先例，
   *      而拖拽要多背触屏、键盘、落点计算一堆边界，换来的只是少点两下。
   */
  var carryArea = null;            // 整张卡片挂在这里（重画只重画它，不动别处）
  var carryBusyKey = '';           // 正在 `book:inspect` 的那一项（那一行的按钮转圈）
  var carryError = null;           // 上一次「加入」为什么没加成（{label, message, hint, problems}）
  var hist = { open: false, loading: false, loaded: false, items: null, error: null };
  var offCarry = null;

  /** 已选了几章。0 就是"不带"，和以前一样。 */
  function carried() { return ctx.state.carry.length; }

  /** 这一次会生成几章（至少 1）。 */
  function chapterCount() { return chapterSummary().nos.length || 1; }

  /** 「第 13 章 · 磁介质」——章号缺失时只写标题，绝不显示"第 章"。 */
  function chLabel(it) {
    var ch = (it && it.chapter) || {};
    var no = String(ch.no || '');
    var t = String(ch.title || '') || (it && (it.fileName || it.label)) || '';
    return (no ? '第 ' + no + ' 章 · ' : '') + (t || '未命名的一章');
  }

  /**
   * 三种状态的**说法**。`mergeStatus` 是主进程算的（jobs.js 的 describe），
   * `mergeHint` 是它现成的一句话 —— 界面上不自己编第二套判据，免得两边说的不一样。
   */
  function mergeState(e) {
    if (e.canMerge && e.exactMerge) {
      return { key: 'exact', cls: 'ok', label: '数据完整', note: '有生成时的结构化数据，能准确合并' };
    }
    if (e.canMerge) {
      return { key: 'html', cls: 'warn', label: '只有页面', note: '从页面反推，可能不准' };
    }
    var ms = String(e.mergeStatus || '');
    if (ms === 'missing') return { key: 'missing', cls: 'field', label: '文件不在了', note: '页面被删掉或挪走了，用不了' };
    if (ms === 'unfinished') return { key: 'unfinished', cls: 'field', label: '还没产出', note: '那次任务还没生成出页面' };
    return { key: 'none', cls: 'field', label: '用不了', note: '这一份现在不能合并' };
  }

  /* ---------- 列表行（从以前生成的章节里挑） ---------- */

  function historyRow(e) {
    var st = mergeState(e);
    var key = 'history:' + e.id;
    var used = ctx.hasCarry(key);
    var busy = carryBusyKey === key;
    var usable = !!e.canMerge;

    var meta = [el('span', { class: 'pill ' + st.cls, title: e.mergeHint || st.note, text: st.label })];
    meta.push(el('span', { class: st.key === 'exact' ? 'hint' : '', text: st.note }));
    /* 文件名可能很长（`ch13-磁介质-讲练一体.html`），而这一行在窄屏下只剩两百多像素：
       不许它把行撑宽（撑出去整页就会横向滚动），所以让它自己折断/省略。 */
    if (e.fileName) meta.push(el('span', { class: 'mono', style: 'min-width:0;max-width:100%;word-break:break-all', text: e.fileName }));
    if (e.createdAt) meta.push(el('span', { text: ctx.fmtDateTime(e.createdAt) }));

    var btn;
    if (busy) {
      btn = el('button', { class: 'btn sm', type: 'button', disabled: true }, [ctx.spinner(), el('span', { text: '检查中…' })]);
    } else if (used) {
      btn = el('button', { class: 'btn sm', type: 'button', disabled: true, text: '已加入' });
    } else if (!usable) {
      // 置灰不可点，并把**为什么**写在按钮上（别让用户点了半天没反应）
      btn = el('button', { class: 'btn sm', type: 'button', disabled: true, title: e.mergeHint || st.note, text: '用不了' });
    } else {
      btn = el('button', {
        class: 'btn sm primary', type: 'button', text: '加入',
        'aria-label': '把「' + chLabel(e) + '」加进这一册',
        on: { click: function () { addFromDesc({ kind: 'history', id: e.id }, e); } }
      });
    }

    return el('div', {
      class: 'src-item carry-row',
      dataset: { merge: st.key, id: e.id, can: usable ? '1' : '0' }
    }, [
      el('div', { class: 'filecard' }, [
        el('span', { class: 'fc-icon' }, icon('book')),
        el('div', { class: 'fc-body' }, [
          el('div', { class: 'fc-name', title: e.htmlPath || '', text: chLabel(e) }),
          el('div', { class: 'fc-meta' }, meta)
        ]),
        el('div', { class: 'fc-actions' }, [btn])
      ])
    ]);
  }

  function buildHistoryPanel() {
    var panel = el('div', {
      class: 'carry-panel',
      style: 'margin-top:12px;padding-top:12px;border-top:1px dashed var(--rule)'
    });

    if (hist.loading) {
      panel.appendChild(el('div', { class: 'hint' }, [ctx.spinner(), el('span', { text: '正在读取以前生成的章节…' })]));
      return panel;
    }
    if (hist.error) {
      panel.appendChild(el('div', { class: 'banner warn' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '列不出来' }),
          el('div', { text: (hist.error && hist.error.message) || '主进程没有说明原因。' }),
          el('div', { style: 'margin-top:6px;display:flex;gap:8px;flex-wrap:wrap' }, [
            el('button', {
              class: 'btn sm', type: 'button', text: '重试',
              on: { click: function () { hist.loaded = false; loadHistoryList(); } }
            }),
            ctx.detailButton(hist.error)
          ])
        ])
      ]));
      return panel;
    }
    var items = hist.items || [];
    if (!items.length) {
      panel.appendChild(el('div', { class: 'hint', text: '还没有生成过别的章节 —— 这一章生成完之后，它就会出现在这里，下次可以带上它。' }));
      return panel;
    }

    var usable = items.filter(function (e) { return e.canMerge; }).length;
    panel.appendChild(el('div', {
      class: 'hint',
      style: 'margin-bottom:8px',
      // 不可用的也照列（灰着 + 写清为什么）：直接藏掉的话，用户会以为"我的那一章丢了"
      text: '按生成时间从新到旧，共 ' + items.length + ' 条（' + usable + ' 条能带；灰着的用不了，原因写在那一行里）'
    }));
    items.forEach(function (e) { panel.appendChild(historyRow(e)); });
    return panel;
  }

  /* ---------- 已选区 ---------- */

  function selectedRow(item, idx, total) {
    var key = ctx.carryKeyOf(item);
    var exact = !!item.exactMerge;
    var warns = (item.problems || []).filter(function (p) { return p && p.level === 'warn'; });

    function mvBtn(text, delta, disabled) {
      return el('button', {
        class: 'btn sm', type: 'button', text: text, disabled: disabled,
        'aria-label': '把「' + chLabel(item) + '」' + text + '一位',
        on: { click: function () { ctx.moveCarry(key, delta); } }
      });
    }

    var kids = [
      el('div', { class: 'filecard' }, [
        el('span', { class: 'fc-icon' }, icon(exact ? 'book' : 'alert')),
        el('div', { class: 'fc-body' }, [
          el('div', { class: 'fc-name', text: (idx + 1) + '. ' + chLabel(item) }),
          el('div', { class: 'fc-meta' }, [
            el('span', { class: 'pill ' + (exact ? 'ok' : 'warn'), text: exact ? '数据完整' : '只有页面' }),
            el('span', { text: exact ? '能准确合并' : '从页面反推，可能不准' }),
            el('span', { class: 'mono', style: 'min-width:0;max-width:100%;word-break:break-all', text: item.fileName || item.label || '' })
          ])
        ]),
        el('div', { class: 'fc-actions', style: 'flex-wrap:wrap' }, [
          mvBtn('上移', -1, idx === 0),
          mvBtn('下移', +1, idx === total - 1),
          el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': '把「' + chLabel(item) + '」从这一册里去掉', title: '移除',
            on: { click: function () { ctx.removeCarry(key); } }
          }, icon('x'))
        ])
      ])
    ];

    /* `book:inspect` 报出来的"注意"**挂在这一行上**（不是收进一个总提示里）：
       用户要能一眼看出是哪一章、哪一处对不上。 */
    if (warns.length) {
      kids.push(el('div', { class: 'banner warn', style: 'margin-top:8px' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这一章有 ' + warns.length + ' 处要注意' })
        ].concat(warns.slice(0, 5).map(function (p) {
          return el('div', { text: p.message + (p.hint ? '（建议：' + p.hint + '）' : '') });
        }), warns.length > 5 ? [el('div', { class: 'hint', text: '另有 ' + (warns.length - 5) + ' 处同类问题。' })] : []))
      ]));
    }

    return el('div', { class: 'carry-sel', dataset: { key: key, exact: exact ? '1' : '0' } }, kids);
  }

  /**
   * 「只有页面」的显式警告。
   *
   * 这一条**不能做成一句淡淡的提示**：反推这条路是用户唯一能用的（别人给的页面、
   * 本功能上线前生成的页面都没有旁挂数据），而它有两个已知盲区（见 pipeline/revive.js 顶部）——
   * 盲区本身不吓人，吓人的是"用户以为和精确合并一样"。
   * 所以：说清盲区是什么、建议怎么自查，并且**点名是哪几章**。
   */
  function htmlOnlyWarning(items) {
    var risky = items.filter(function (x) { return !x.exactMerge; });
    if (!risky.length) return null;
    return el('div', { class: 'banner warn', style: 'margin-top:12px', dataset: { carry: 'htmlwarn' } }, [
      icon('alert'),
      el('div', { class: 'bt' }, [
        el('b', { text: '有 ' + risky.length + ' 章没有结构数据，只能「从页面反推」——合出来的东西可能和原来不完全一样' }),
        el('div', { style: 'margin-top:2px', text: '反推有两个已知盲区：' }),
        el('div', { text: '1）单元导语可能重复一次：成品页里那段导语和正文里长得一模一样，分不出哪个是哪个，于是两段都进了新页面。' }),
        el('div', { text: '2）演示可能接错：页面里某段 DOM 被动过（删过、改过），演示的代码就对不上它该待的那一节了 —— 拖起来是好的，但和那一节的内容对不上。' }),
        el('div', {
          style: 'margin-top:4px',
          text: '建议：合成之后把这几章逐页点一遍（对着以前生成的那一份看），确认导语没重复、每个演示都还跟得上那一节。'
        }),
        el('div', { class: 'hint', style: 'margin-top:4px', text: '分别是：' + risky.map(chLabel).join('、') })
      ])
    ]);
  }

  /* ---------- 加入 / 移除 ---------- */

  /* ---------- 连续性：这次的章接不接得上以前那些 ----------
   *
   * 判据在**主进程**（`pipeline/chapters.js` 的 `judgeContinuity`，有单测）。
   * 界面自己再实现一遍是不行的：两边走散的表现是"界面说接得上、实际没缝"，
   * 而用户没有任何办法看出来。
   *
   * 它决定的是**界面主动做什么**，不是产出形态 —— 产出形态始终由用户选。
   * 接得上就把"一次带上全部"摆在最显眼处（那正是"从头缝到尾"）；接不上就一个字都不说，
   * 让用户自己按需挑（"不硬拼，各章各自独立"）。
   */
  var cont = { token: 0, loaded: false, verdict: null, error: null };

  function loadContinuity() {
    var nos = chapterSummary().nos;
    var my = ++cont.token;                      // 慢请求回来时章号可能已经变了，认 token
    if (nos.length < 1) { cont.loaded = true; cont.verdict = null; return; }
    ctx.call('bookContinuity', { chapterNos: nos }).then(function (res) {
      if (my !== cont.token) return;            // 过期的那一次丢掉（否则会上一条错的横幅）
      cont.loaded = true;
      cont.verdict = res.ok ? (res.data || null) : null;
      cont.error = res.ok ? null : (res.error || null);
      refreshCarry();
    });
  }

  /** 已有章号 → 历史列表里那一条（拿它才能拼出 `{kind:'history', id}`）。 */
  function historyByNo(no) {
    var items = hist.items || [];
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      if (String((e.chapter && e.chapter.no) || '') === String(no) && e.canMerge) return e;
    }
    return null;
  }

  /**
   * 「把以前那 N 章都带上」。
   *
   * **逐个串行**而不是并发：`addFromDesc` 一次只允许检查一份（`carryBusyKey` 挡着），
   * 而且每一次都要真去读那一章的旁挂数据 —— 并发发十二条只会让主进程同时读十二份大文件。
   */
  function carryAll(list) {
    var seq = Promise.resolve();
    var added = 0;
    list.forEach(function (e) {
      seq = seq.then(function () {
        if (ctx.hasCarry('history:' + e.id)) return null;
        added++;
        return addFromDesc({ kind: 'history', id: e.id }, e);
      });
    });
    return seq.then(function () {
      refreshCarry();
      ctx.toast(added ? ('把 ' + added + ' 章都带上了') : '这些章已经在已选区里了', added ? 'ok' : 'info');
    });
  }

  /**
   * 「接得上」横幅。**只在真的接得上时出现**。
   *
   * 措辞里点名"是哪几章"，因为这决定了用户要不要信它：一条泛泛的"可以合并成一册"
   * 帮不了任何忙，而"你已经生成过第 1–12 章，这次的 13、14 能接着缝"是一句可核对的话。
   */
  function continuityBanner() {
    var v = cont.verdict;
    if (!v || !v.continuous) return null;
    var known = [];
    for (var n = v.knownMin; n <= v.knownMax; n++) {
      if (historyByNo(String(n))) known.push(historyByNo(String(n)));
    }
    // 章号对得上、但历史里的那些条现在**用不了**（页面被删/挪走）时，不吹这个牛
    if (known.length !== (v.knownMax - v.knownMin + 1)) return null;

    return el('div', { class: 'banner ok', style: 'margin-top:12px', dataset: { carry: 'continuity' } }, [
      icon('check'),
      el('div', { class: 'bt' }, [
        el('b', { text: '接得上：你已经生成过第 ' + v.knownMin + '–' + v.knownMax + ' 章，这次的 '
          + (v.pendingNos || []).join('、') + ' 章能接着往下缝' }),
        // ⚠️ 这里是纯文本节点，不许写 Markdown 强调标记（`**连续**` 会连着星号一起显示出来）
        el('div', { text: '把以前那些章一起带上，产出的就是一本连续的册子（目录、关卡号、进度都接着上一册走）。'
          + '不带的话，这次这几章会自成一份册子，和以前那些没有关系。' }),
        el('div', { style: 'margin-top:8px;display:flex;gap:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn sm primary', type: 'button',
            text: '把第 ' + v.knownMin + '–' + v.knownMax + ' 章都带上',
            on: { click: function () { carryAll(known); } }
          }),
          cont.loading ? el('span', { class: 'hint' }, [ctx.spinner(), el('span', { text: '检查中…' })]) : null
        ])
      ])
    ]);
  }

  /** 加入之前先问主进程"这一份能不能用"。**唯一的判据**，不看文件名、不看扩展名。 */
  function addFromDesc(desc, meta) {
    var key = desc.kind === 'file'
      ? ('file:' + String(desc.path || '').replace(/\\/g, '/').toLowerCase())
      : ('history:' + desc.id);
    /* ⚠️ 每一条提前返回都必须是 **Promise**：`carryAll` 靠串行链（`seq.then`）来一份一份加，
       中间返回 `undefined` 会让整条链在那里断掉 —— 后面那几章**一份都不会被加进来**，
       而界面看上去只是"少带了几章"，没有任何报错。 */
    if (ctx.hasCarry(key)) { ctx.toast('这一章已经在已选区里了', 'info'); return Promise.resolve(null); }
    if (carryBusyKey) { ctx.toast('正在检查上一份，等它出结果再点', 'info'); return Promise.resolve(null); }
    carryBusyKey = key;
    carryError = null;
    refreshCarry();

    return ctx.call('inspectBookChapter', desc).then(function (res) {
      carryBusyKey = '';
      var label = (meta && (meta.fileName || meta.label)) || desc.path || desc.id;

      if (!res.ok) {
        // 信封级失败（BAD_ARG / NOT_FOUND / NOT_ALLOWED / NOT_FILE）：主进程已经说了人话
        carryError = {
          label: label,
          message: (res.error && res.error.message) || '主进程没有说明原因',
          hint: (res.error && res.error.detail) || '',
          problems: []
        };
        refreshCarry();
        return;
      }

      var d = res.data || {};
      var problems = Array.isArray(d.problems) ? d.problems : [];
      var blockers = problems.filter(function (p) { return p && p.level === 'blocker'; });

      /* 不能加入时**当场说清是哪一条**。这里刻意不做成一句"这一章不能用"：
         用户手上往往还有别的一份备份，知道"是哪里对不上"才换得动。 */
      if (d.ok === false || d.canCarry === false || blockers.length) {
        var first = blockers[0] || problems[0] || null;
        carryError = {
          label: label,
          message: (first && first.message) || '这一份的结构跟本工具的页面完全对不上',
          hint: (first && first.hint) || '',
          problems: problems
        };
        refreshCarry();
        return;
      }

      var ch = d.chapter || {};
      ctx.addCarry({
        kind: desc.kind,
        id: desc.id,
        path: desc.path,
        label: label,
        fileName: (meta && (meta.fileName || meta.label)) || baseName(desc.path || ''),
        createdAt: (meta && meta.createdAt) || 0,
        chapter: {               // 章号/标题以 inspect 的答复为准（列表里的那份可能来自任务摘要）
          no: ch.no || (meta && meta.chapter && meta.chapter.no) || '',
          title: ch.title || (meta && meta.chapter && meta.chapter.title) || '',
          subject: ch.subject || (meta && meta.chapter && meta.chapter.subject) || '',
          intro: ch.intro || (meta && meta.chapter && meta.chapter.intro) || ''
        },
        /* `from` 是主进程给的：`sidecar` = 读了旁挂数据（精确），`revive` = 从页面反推。
           界面上的"数据完整 / 只有页面"就是按它分的（不是按 mergeStatus 猜的）。 */
        mergeStatus: d.from === 'revive' ? 'html' : 'chapter',
        exactMerge: d.from !== 'revive',
        from: d.from || '',
        problems: problems.filter(function (p) { return p && p.level === 'warn'; })
      });
      refreshCarry();
    });
  }

  /** 「选一个 HTML 文件…」：别人给的、或本功能上线前生成的页面都走这里（没有旁挂数据）。 */
  function pickBookHtml() {
    ctx.call('pickBookFile').then(function (res) {
      if (!res.ok) return;                        // 失败已经在 ctx.call 里提示过
      var p = res.data;
      if (!p || typeof p !== 'string') return;     // 取消
      addFromDesc({ kind: 'file', path: p }, { fileName: baseName(p), label: baseName(p) });
    });
  }

  function loadHistoryList() {
    hist.loading = true;
    hist.error = null;
    refreshCarry();
    ctx.call('listBookChapters').then(function (res) {
      hist.loading = false;
      if (res.ok) {
        hist.items = Array.isArray(res.data) ? res.data : [];
        hist.loaded = true;
        // 有了"以前生成过哪些章"才谈得上连续性（见 loadContinuity）
        loadContinuity();
      } else {
        hist.items = null;
        hist.error = res.error || { message: '主进程没有说明原因' };
      }
      refreshCarry();
    });
  }

  function toggleHistory() {
    if (hist.open) { hist.open = false; refreshCarry(); return; }
    hist.open = true;
    if (hist.loaded || hist.loading) { refreshCarry(); return; }
    loadHistoryList();
  }

  /* ---------- 卡片 ---------- */

  function carryErrorBlock() {
    if (!carryError) return null;
    return el('div', { class: 'banner warn carry-err', role: 'alert', style: 'margin-top:12px' }, [
      icon('alert'),
      el('div', { class: 'bt' }, [
        el('b', { text: '「' + carryError.label + '」没能加进来' }),
        el('div', { text: carryError.message }),
        carryError.hint ? el('div', { class: 'hint', text: '建议：' + carryError.hint }) : null,
        (carryError.problems || []).length > 1
          ? el('div', { class: 'hint', text: '这一份一共 ' + carryError.problems.length + ' 处对不上。' })
          : null,
        el('div', { class: 'hint', text: '它没有被加进已选区 —— 这一册里不会有它。' }),
        el('div', { style: 'margin-top:6px' }, [
          el('button', {
            class: 'btn sm', type: 'button', text: '知道了',
            on: { click: function () { carryError = null; refreshCarry(); } }
          })
        ])
      ])
    ]);
  }

  function bookTitleField() {
    var input = el('input', {
      type: 'text', id: 'wb-booktitle', value: ctx.state.bookTitle || '',
      // 留空时主进程会用第一章的标题顶上（bookOutName 的 fallback），所以**不替用户预填**：
      // 预填一个就等于把"自动"变成"钉死"，用户改了一次就再也回不到自动那一步了。
      placeholder: '留空 = 用第一章的标题',
      'aria-label': '一册的名字',
      on: { input: function () { ctx.state.bookTitle = input.value.trim(); } }
    });
    return field('一册的名字（可选）', input,
      '决定合成后那一册的页头标题与文件名。不带章节时用不到它。');
  }

  function buildCarryCard() {
    var s = ctx.state;
    var n = s.carry.length;

    /* 「每章一份」时这一整张卡没有意义：分开生成的定义就是"每章各自独立"，
       没有"哪几章缝在一起"这回事。但**不能把卡直接藏掉** —— 藏掉的话用户会以为
       "这个功能没了"。所以留一张卡，说清楚为什么这次用不上。 */
    if ((s.mode || 'book') === 'separate') {
      return el('div', { class: 'card', id: 'wb-carry' }, [
        el('div', { class: 'card-head' }, [el('h2', { text: '带上以前的章节（可选）' })]),
        el('div', { class: 'hint', text: '你选了「每章一份 HTML」，所以这一次不做任何合并：'
          + '每章各出一个独立文件，以前生成的那些章原样留在原处、不会被动。' }),
        n ? el('div', { class: 'banner warn', style: 'margin-top:10px' }, [
          icon('alert'),
          el('div', { class: 'bt' }, [
            el('b', { text: '已选的 ' + n + ' 章这次不会被带进去' }),
            el('div', { text: '它们还留在下面的已选区里 —— 改回「合成一册」就会重新生效。' })
          ])
        ]) : null
      ]);
    }

    var kids = [];

    kids.push(el('div', { class: 'card-head' }, [
      el('h2', { text: '带上以前的章节（可选）' }),
      el('div', { class: 'right' }, [
        el('span', {
          class: 'hint', dataset: { carry: 'count' },
          /* 顶部一句总账：用户随时知道"点下去会得到几章的书"。
             ⚠️ 这次的章数**不是 1** —— 多章之后这里必须用实际章数。
             以前写死 `n + 1` 时，"第 13、14 两章 + 带上 12 章"会显示成"包含 13 章"，
             而底部那句总账写的是 14 章：同一张卡上两个数，用户只会信错的那一个。 */
          text: '这一册将包含 ' + (n + chapterCount()) + ' 章'
            + (n ? '' : '（就是这次生成的' + (chapterCount() > 1 ? '这几章' : '这一章') + '）')
        })
      ])
    ]));

    kids.push(el('div', {
      class: 'hint',
      text: '把以前生成过的页面带上，它们会排在新章前面，和这次这几章合成一册（一个文件）；不带就是各章各自独立，和以前一样。'
    }));

    // 「接得上」——只有真的接得上时才出现（判据在主进程，见 continuityBanner）
    var cb = continuityBanner();
    if (cb) kids.push(cb);

    if (n) {
      var list = el('div', { class: 'carry-list', style: 'margin-top:12px', dataset: { carry: 'selected' } });
      s.carry.forEach(function (it, i) { list.appendChild(selectedRow(it, i, n)); });
      kids.push(el('div', { class: 'field', style: 'margin-top:12px' }, [
        el('span', { class: 'lbl', text: '已选 ' + n + ' 章（排在新章前面，按这个顺序）' }),
        list
      ]));
      kids.push(htmlOnlyWarning(s.carry));
    }

    var err = carryErrorBlock();
    if (err) kids.push(err);

    kids.push(el('div', { class: 'src-add', style: 'margin-top:12px' }, [
      el('button', {
        class: 'btn', type: 'button',
        'aria-expanded': hist.open ? 'true' : 'false',
        on: { click: toggleHistory }
      }, [icon('clock'), el('span', { text: '从以前生成的章节里挑' })]),
      el('button', {
        class: 'btn', type: 'button',
        on: { click: pickBookHtml }
      }, [icon('file'), el('span', { text: '选一个 HTML 文件…' })]),
      el('span', {
        class: 'hint',
        text: '别人发给你的页面（或早期版本生成的）没有结构数据，也能带，只是会走"从页面反推"。'
      }),
      // 「选一个 HTML 文件…」那条路没有行可以转圈，就把"正在检查"写在这里 ——
      // 点击之后到出结果之间有几百毫秒，界面上什么都不动会被当成"点了没反应"。
      carryBusyKey ? el('span', { class: 'hint' }, [ctx.spinner(), el('span', { text: '正在检查这一份能不能带…' })]) : null
    ]));
    if (hist.open) kids.push(buildHistoryPanel());

    kids.push(el('div', { class: 'divider' }));
    kids.push(bookTitleField());

    return el('div', { class: 'card', id: 'wb-carry' }, kids);
  }

  function refreshCarry() {
    if (!carryArea) return;
    carryArea.innerHTML = '';
    carryArea.appendChild(buildCarryCard());
  }



  function metaSection() {
    var o = ctx.state.options;

    var subject = el('input', {
      type: 'text', id: 'wb-subject', value: o.subject || '', placeholder: '例如：大学物理',
      on: { input: function () { o.subject = subject.value.trim(); } }
    });
    var chapterNo = el('input', {
      type: 'text', id: 'wb-no', value: o.chapterNo || '', placeholder: '例如：13',
      on: { input: function () { o.chapterNo = chapterNo.value.trim(); } }
    });
    var title = el('input', {
      type: 'text', id: 'wb-title', value: o.chapterTitle || '', placeholder: '留空则从课件里自动推断',
      on: { input: function () { o.chapterTitle = title.value.trim(); } }
    });

    var multi = ctx.state.sources.length > 1;

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: '这一章是什么' }),
        el('div', { class: 'right' }, [el('span', { class: 'hint', text: '都可以留空，留空时自动判断' })])
      ]),
      el('div', { class: 'grid3' }, [
        field('学科', subject, null, 'wb-subject'),
        /* 多份材料时这个框是**默认值**：材料行上单独填了章号的按它自己那份算，
           没填的才落到这里。一份材料时它就是唯一的那一章。 */
        field('章号', chapterNo, multi ? '材料行上没单独填章号的，都用这个（也就是"这一章"）' : null, 'wb-no'),
        field('章标题', title, multi ? '多章时留空 = 每章各自从材料里推断' : null, 'wb-title')
      ])
    ]);
  }

  function optionsSection() {
    var o = ctx.state.options;

    var units = rangeField('单元数', 5, 7, 1, o.units, '把这一章切成几个讲练单元，默认 6',
      function (v) { o.units = v; });
    var quiz = rangeField('作答点目标数', 40, 90, 5, o.quizTarget, '整页大约要练多少次，默认 65',
      function (v) { o.quizTarget = v; });
    var demos = rangeField('演示数', 0, 3, 1, o.demos, '可拖动、可改参数的交互演示，默认 2；填 0 就是不要',
      function (v) { o.demos = v; });

    function petCard(value, title, desc) {
      var input = el('input', {
        type: 'radio', name: 'wb-pet', value: value,
        checked: o.pet === value,
        on: { change: function () { if (input.checked) o.pet = value; } }
      });
      return el('label', { class: 'radio-card' }, [
        input,
        el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
      ]);
    }

    var outInput = el('input', {
      type: 'text', id: 'wb-out', value: o.outputDir || '',
      placeholder: ctx.state.lastOutputDir || '留空 = 和课件放在同一个文件夹',
      'aria-label': '输出目录',
      on: { input: function () { o.outputDir = outInput.value.trim(); } }
    });

    /* 题目审校：0–3 位"审题人"。
       应用没有子代理机制，但这件事本质上就是交叉检验——N 个**互不可见**的模型调用，
       各自从头独立重算一遍。所以每个档位的说明都写清"多花几次调用、换来什么"，
       让用户自己权衡；多人时的门槛（要两人报同一题才改）也写在下面那行小字里。 */
    function auditCard(value, title, desc) {
      var input = el('input', {
        type: 'radio', name: 'wb-audit', value: String(value),
        checked: Number(o.auditors) === value,
        on: { change: function () { if (input.checked) o.auditors = value; } }
      });
      return el('label', { class: 'radio-card' }, [
        input,
        el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
      ]);
    }

    function langCard(value, title, desc) {
      var input = el('input', {
        type: 'radio', name: 'wb-lang', value: value,
        checked: o.language === value,
        on: { change: function () { if (input.checked) o.language = value; } }
      });
      return el('label', { class: 'radio-card' }, [
        input,
        el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
      ]);
    }

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '生成选项' })]),
      el('div', { class: 'grid3' }, [units, quiz, demos]),
      el('div', { class: 'divider' }),
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '题目审校（子代理）' }),
        el('div', { class: 'radio-cards row' }, [
          auditCard(0, '不审校', '最省一次调用。但答案对不对没人独立复核——数值题算错一位不会被发现'),
          auditCard(1, '1 位审题', '另起一次调用独立重算。拦得住明显的算错，只多一次调用（推荐）'),
          auditCard(2, '2 位审题', '两位互不可见地各算一遍；两人都报同一题才改，误报更少'),
          auditCard(3, '3 位审题', '同上，覆盖面更广；多花三次调用')
        ]),
        el('p', {
          class: 'hint', style: 'margin:8px 0 0',
          text: '审题 = 再叫一次模型，只给它题库和素材、不给推导过程，让它自己从头重算。' +
            '多人时各自独立、不共享结论；只被少数人报出的问题会记进校验报告，但不自动改' +
            '（误报会让出题人把本来对的改成错的）。作答点少于 8 个的小节会自动跳过。'
        })
      ]),
      el('div', { class: 'divider' }),
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '内容语言' }),
        el('div', { class: 'radio-cards row' }, [
          langCard('zh-CN', '简体中文', '默认。课件原文是英文也译成中文写，术语可中英并排标注一次'),
          langCard('follow', '跟随课件语言', '课件是英文就用英文写。适合外文教材原样出版')
        ])
      ]),
      el('div', { class: 'divider' }),
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '陪练形象' }),
        el('div', { class: 'radio-cards row' }, [
          petCard('none', '不要陪练', '右下角空着，什么也不显示'),
          petCard('fish', '内置「大肥鱼」', '用包里的素材，不用带图文件（第三方 MIT 素材）'),
          petCard('own', '用我自己放的图', '把 pet.png / pet.jpg 放进输出目录，页面会自动认')
        ])
      ]),
      el('div', { class: 'divider' }),
      field('输出目录', el('div', { class: 'input-row' }, [
        outInput,
        el('button', {
          class: 'btn', type: 'button', text: '选择目录', 'aria-label': '选择输出目录',
          on: {
            click: function () {
              ctx.call('pickOutputDir').then(function (res) {
                if (!res.ok || !res.data) return;
                o.outputDir = res.data;
                ctx.state.lastOutputDir = res.data;
                outInput.value = res.data;
              });
            }
          }
        })
      ]), '生成的 HTML 会写到这个目录；留空就和课件放一起。跑完只有一个文件，双击就能用，不需要联网。')
    ]);
  }

  /* ---------- 开始生成 ---------- */

  /** 失败之后得告诉用户"怎么办"，别只是把按钮变回去 */
  function startHelp(code) {
    if (code === 'NO_MODEL') return '去「设置」启用一家提供商、填好 API Key，并选中一个默认模型，再回来点「开始生成」。';
    if (code === 'NOT_FOUND') return '课件文件可能被移走或改名了，重新选一份就能继续。';
    if (code === 'BAD_ARG') return '这次请求没带上课件，重新选一份课件再试。';
    /* 要带的那一章读不出来时不会再静默跳过（少一章的册子要到复习时才发现），
       所以这里得说清"怎么办"：主进程的 message 已经写明是哪一份、为什么。 */
    if (code === 'CARRY_UNUSABLE') return '把要带的那一章去掉再试；它可能被挪走删掉了，或者不是这个工具生成的页面。也可以用「选一个 HTML 文件…」把它重新选一次。';
    return '可以先重试一次；每次都失败就把下面的详情发给开发者。';
  }

  function buildStartArea() {
    var s = ctx.state;
    var ready = providerReady(s.settings);
    var noKey = (ready === false);
    var kids = [];

    if (startError) {
      kids.push(el('div', { class: 'banner warn', style: 'margin-bottom:10px' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '没能开始生成' }),
          el('div', { text: startError.message || '主进程没有说明原因。' }),
          el('div', { class: 'hint', style: 'margin-top:4px', text: startHelp(startError.code) }),
          el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' }, [
            startError.code === 'NO_MODEL'
              ? el('button', {
                class: 'btn sm primary', type: 'button', text: '去设置',
                on: { click: function () { ctx.go('#settings'); } }
              })
              : el('button', {
                class: 'btn sm', type: 'button', text: '再试一次',
                on: { click: function () { start(); } }
              }),
            ctx.detailButton(startError)
          ])
        ])
      ]));
    }

    if (noKey) {
      kids.push(el('div', { class: 'banner warn', style: 'margin-bottom:10px' }, [
        icon('key'),
        el('div', { class: 'bt' }, [
          el('b', { text: '还没配大模型，不能开始' }),
          el('div', { text: '这个工具不内置模型，用的是你自己的 API Key。填好以后就能生成了。' }),
          el('div', { style: 'margin-top:6px' }, [
            el('button', {
              class: 'btn sm primary', type: 'button', text: '去设置',
              on: { click: function () { ctx.go('#settings'); } }
            })
          ])
        ])
      ]));
    } else if (s.settingsError) {
      kids.push(el('div', { class: 'banner info', style: 'margin-bottom:10px' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '读不到设置，无法确认模型是否配好' }),
          el('div', { text: '还是可以点开始；如果主进程报错，错误原文会显示在运行页。' }),
          ctx.detailButton(s.settingsError)
        ])
      ]));
    }

    var startBtn = el('button', {
      class: 'btn primary lg', type: 'button',
      disabled: !s.sources.length || noKey,       // 可点的条件：**至少一份材料**（以前是"选过课件"）
      on: { click: start }
    }, [icon('wand'), el('span', { text: '开始生成' })]);

    var left = el('div', { class: 'left' }, [
      el('div', {
        class: 'hint',
        // 一份就把文件名写出来；多份写份数，别把四个文件名挤在页脚里（放不下也不会有人看）
        title: s.sources.map(function (x) { return ctx.ROLE_LABEL[x.role] + '：' + x.fileName; }).join('\n'),
        text: s.sources.length === 0 ? '还没加材料 —— 先拖一份 PPT 或 PDF 进来'
          : s.sources.length === 1 ? ('材料：' + (s.sources[0].fileName || baseName(s.sources[0].filePath)))
            : (s.sources.length + ' 份材料')
      }),
      /* 底部这句要如实说出"会得到几个文件"。三种形态三种说法：
           · 分开生成    —— 出 N 个文件
           · 带上了老章  —— 出 1 个文件（那一册）
           · 单章        —— 出 1 个文件
         ⚠️ 措辞不能说"并保留这一章单独的文件"：这一次只会写出**一个文件**（那一册）；
         留下的是**以前那些章各自单独的文件**（一册的文件名和单章的名字是分开的，
         不会互相覆盖，见 pipeline 的 bookOutName）。 */
      (function () {
        var sum = chapterSummary();
        var n = sum.nos.length || 1;
        if ((s.mode || 'book') === 'separate' && n > 1) {
          return el('div', { class: 'hint', text: '本次会产出 ' + n + ' 个文件：每章一份 HTML，各自独立' });
        }
        if (s.carry.length) {
          return el('div', {
            class: 'hint',
            text: '本次会产出 ' + (s.carry.length + n) + ' 章合一的一册（1 个文件）；'
              + '以前那 ' + s.carry.length + ' 章单独的页面文件都还在，不会被覆盖'
          });
        }
        return n > 1 ? el('div', { class: 'hint', text: '本次会产出 ' + n + ' 章合一的一册（1 个文件）' }) : null;
      })()
    ]);

    kids.push(el('div', { class: 'sticky-foot' }, [left, el('div', { class: 'right' }, [startBtn])]));
    return el('div', {}, kids);
  }

  function refreshStartArea() {
    if (!startArea || !root) return;
    startArea.innerHTML = '';
    startArea.appendChild(buildStartArea());
  }

  function start() {
    var s = ctx.state;
    if (!s.sources.length) { ctx.toast('先加一份材料', 'warn'); return; }

    var btn = root.querySelector('.sticky-foot .btn.primary');
    if (btn) {
      btn.disabled = true;
      var lbl = btn.querySelector('span');
      if (lbl) lbl.textContent = '正在启动…';
    }
    ctx.startGeneration().then(function (res) {
      if (!res || !res.ok) {
        // 失败就是失败：不跳运行页、不弹"已开始生成"，把主进程给的原因原样摆出来。
        // （信封已经在 ctx.call 里拆好了，res.error 就是 {code,message,detail}）
        startError = (res && res.error) || { code: '', message: '主进程没有说明原因。' };
        /* ⚠️ 这里**只**刷新横幅，不再叠一条 toast。
           上面那句 `refreshStartArea()` 渲染出来的横幅就在按钮正上方，带着主进程的原始原因、
           一句「怎么办」（`startHelp`）和一个「去设置」按钮——比一句 100 字截断的 toast
           信息更全、也不会自己消失。再弹一条等于同一件事说两遍。
           （这正是 `startGeneration` 走 `callQuiet` 的原因，见 CHANGELOG 与 app.js 里那个函数的注释；
             以前横幅和 toast 都发，代码和自己的说明对不上。） */
        refreshStartArea();
        return;
      }
      startError = null;
      refreshStartArea();
      ctx.toast('已开始生成', 'ok');
    });
  }

  /* ---------- 生命周期 ---------- */

  function build() {
    root.appendChild(ctx.pageHead({
      title: '工作台',
      // 多来源之后不再只是"课件"——课本、习题、历年真题都能喂进来
      sub: '把课件、课本、习题或历年真题交给大模型，生成一个能讲、能练、能存档的单文件学习页',
      actions: [
        el('button', {
          class: 'btn sm ghost', type: 'button', text: '关于这个工具',
          on: { click: function () { ctx.go('#about'); } }
        })
      ]
    }));

    fileArea = el('div', { class: 'card' }, []);
    fileHead = el('h2', { text: '材料' });
    root.appendChild(el('div', { class: 'card-head', style: 'margin:0 0 10px' }, [fileHead]));
    root.appendChild(fileArea);
    refreshSources();

    /* 「这次怎么出」紧跟材料之后：材料标好章号，"分成几章"才有得看。
       它又排在「带上以前的章节」之前 —— 先定产出形态，再谈要不要并。 */
    planArea = el('div', {});
    root.appendChild(planArea);
    refreshMode();

    /* 后台把"以前生成过哪些章"拉回来 —— 连续性判断要用它。
       为什么不等用户点开历史面板：**"接得上"那条横幅正是最该主动说的一句话**
       （用户的原话是"连续就从头缝到尾"），要他去点一下才告诉他，等于没说。
       这一步不挡渲染（拉回来再重画那张卡），所以最坏情况只是横幅晚几百毫秒出现。 */
    if (!hist.loaded && !hist.loading) loadHistoryList();

    /* 「带上以前的章节」放在**元信息之前**：它决定的是"这次产出的是什么"（一章还是一册），
       比"这一章叫什么"更靠前；而它跟材料清单放一起也说得通——两者都是"这次拿什么去生成"。 */
    carryArea = el('div', {});
    root.appendChild(carryArea);
    refreshCarry();
    /* 结果页的「把这章并进一册？」入口跳过来时，直接把选择器展开、顺手把列表拉回来，
       省得用户到了工作台还要自己找那个按钮。 */
    if (ctx.state.carryOpen) {
      ctx.state.carryOpen = false;
      hist.open = true;
      if (!hist.loaded) loadHistoryList(); else refreshCarry();
    }

    root.appendChild(metaSection());
    root.appendChild(optionsSection());

    startArea = el('div', {});
    root.appendChild(startArea);
    refreshStartArea();
  }

  var offSources = null;

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    /* 材料清单只在**这一处**是权威的渲染，但改它的入口有四个（拖拽 / 选文件 /
       拖到图标上打开 / 移除）。与其让每个入口都记得回来喊一声，不如订阅清单本身：
       app.js 的 addSource/removeSource/setSourceRole 改完就会 emit('sources')。
       （之前这个 emit 发了没人听 —— 于是"拖进来一份，清单却要切页面才刷新"。） */
    if (offSources) { try { offSources(); } catch (e) { } }
    offSources = ctx.on('sources', function () {
      refreshSources();
      // 章号是材料行上的字段，改了它「这次会分成几章」跟着变
      refreshMode();
      // 也变得起"接不接得上"：历史那边已经读回来了才重算（没读回来就等它读完自己算）
      if (hist.loaded) loadContinuity();
      refreshStartArea();
    });
    /* 已选区同理：改动它的入口有好几个（加入 / 移除 / 上移 / 下移 / 结果页那边清掉），
       订阅它自己的事件，就不会出现"state 变了、界面上还挂着旧的一行"。 */
    if (offCarry) { try { offCarry(); } catch (e) { } }
    offCarry = ctx.on('carry', function () {
      refreshCarry();
      refreshStartArea();       // 底部那句"本次会产出 N 章合一的一册"跟着变
    });
    build();
  }
  function unmount() {
    if (offSources) { try { offSources(); } catch (e) { } }
    offSources = null;
    if (offCarry) { try { offCarry(); } catch (e) { } }
    offCarry = null;
    root = null; ctx = null; startError = null;
    /* 这些是**视图级**的临时状态，不该活过一次卸载：
       带着"上一次打开的那个列表 / 那条红色报错"回到工作台，用户会以为刚才那一下出事了。 */
    carryArea = null;
    planArea = null;
    carryBusyKey = '';
    carryError = null;
    hist = { open: false, loading: false, loaded: false, items: null, error: null };
    cont = { token: cont.token + 1, loaded: false, verdict: null, error: null };  // token+1：作废还在飞的那一次
  }

  /* 有新文件进来（拖拽 / 拖到图标上打开）时调用：先把清单画出来，再补上抽取结果。
     只取**还没读过**的那些（loadExtract 内部会跳过已有结果的），
     所以从外面又拖进来一份时，已经读好的几份不会白重抽一遍。 */
  function onDropFile() {
    refreshSources();
    refreshStartArea();
    ctx.loadExtract().then(function () { refreshSources(); });
  }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.workbench = { mount: mount, unmount: unmount, onDropFile: onDropFile };
})();
