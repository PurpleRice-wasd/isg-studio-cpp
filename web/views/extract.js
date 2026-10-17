/* 抽取预览：分页看文字、可疑页标红、当场改，改完带着改后的文本去生成。
 *
 * ⚠️ 多来源之后这里**必须按来源分组**渲染。原因是页号：四份材料的"第 3 页"都是第 3 页，
 * 拉平成一串列表用户根本分不清正在改的是哪一份（更糟的是改错了还看不出来——文字都是对的，
 * 只是属于另一份材料）。所以每份来源一个小标题，页号只在自己那一组里连续。
 */
(function () {
  'use strict';

  var root = null, ctx = null, el, icon;
  var listBox, headBox, footBox, noticeBox;
  var PAGE_CHUNK = 40;

  function editedCount() { return ctx.anyEditedCount(); }

  function suspectReason(p) {
    var q = p.quality || {};
    var chars = typeof q.chars === 'number' ? q.chars : (p.text || '').length;
    if (!chars) {
      return '这一页一个字都没抽到。多半是扫描图片或整页图形（课件里很常见）——可以把这页的要点手打进下面的框里，或者直接留空跳过。';
    }
    if (typeof q.cjkRatio === 'number' && q.cjkRatio < 0.2) {
      return '抽出来的文字里中文只占 ' + Math.round(q.cjkRatio * 100) + '%，很可能是 PDF 没嵌字体、抽出的是乱码。建议对着原课件把这页改一遍，或删掉重打。';
    }
    return '系统把这一页标成了可疑（共 ' + chars + ' 字）。建议看一眼有没有串行、丢字、公式变成乱码。';
  }

  /* 修订的键是 **`${来源id}:${页号}`**。
     以前是裸页号 —— 多来源下页号必然重复，主进程按 `${sourceId}:${index}` 查表，
     发过去的裸 index 会被当成"主来源的某一页"。键在这里拼一次，只此一处。 */
  function editKey(sourceId, index) { return sourceId + ':' + index; }

  function putEdit(sourceId, index, text, original) {
    var s = ctx.state;
    s.extractEdits = s.extractEdits || {};
    var k = editKey(sourceId, index);
    if (text === original) delete s.extractEdits[k];
    else s.extractEdits[k] = text;
  }

  /** 还原某一份材料的全部修订（只动它自己的键，别的来源不受影响）。 */
  function revertSource(sourceId) {
    var s = ctx.state;
    Object.keys(s.extractEdits || {}).forEach(function (k) {
      if (k.indexOf(sourceId + ':') === 0) delete s.extractEdits[k];
    });
  }

  function buildPageItem(src, page, orderNo) {
    var s = ctx.state;
    var idx = page.index;
    var key = editKey(src.id, idx);
    var original = typeof page.text === 'string' ? page.text : '';
    var current = Object.prototype.hasOwnProperty.call(s.extractEdits || {}, key) ? s.extractEdits[key] : original;
    var suspect = !!(page.quality && page.quality.suspect);

    var reason = suspect ? suspectReason(page) : '';
    var warns = (src.extract && src.extract.warnings || []).filter(function (w) {
      return w && w.page === idx && w.message && w.level !== 'info';
    }).map(function (w) { return w.message; });
    if (warns.length) reason = (reason ? reason + ' ' : '') + '（' + warns.join('；') + '）';

    var ta = el('textarea', {
      spellcheck: 'false',
      'aria-label': '第 ' + idx + ' 页的文本，可以直接修改',
      on: {
        input: function () {
          putEdit(src.id, idx, ta.value, original);
          item.classList.toggle('edited', ta.value !== original);
          stat.textContent = ta.value.length + ' 字';
          editedPill.hidden = (ta.value === original);
          refreshFoot();
        }
      }
    });
    ta.value = current;

    var stat = el('span', { class: 'mono', style: 'color:var(--ink-3);font-size:11.5px', text: String(current).length + ' 字' });
    var editedPill = el('span', { class: 'pill info', text: '已修改', hidden: current === original });

    var head = el('div', { class: 'pi-head' }, [
      el('span', { class: 'pi-no', text: '第 ' + (idx || orderNo) + ' 页' }),
      page.title ? el('span', { class: 'pi-title', title: page.title, text: page.title }) : null,
      stat,
      suspect ? el('span', { class: 'pill warn', text: '可疑' }) : null,
      editedPill,
      el('div', { class: 'right' }, [
        el('button', {
          class: 'btn sm ghost', type: 'button', text: '还原',
          'aria-label': '把第 ' + idx + ' 页还原成抽取原文',
          hidden: current === original,
          on: {
            click: function () {
              ta.value = original;
              putEdit(src.id, idx, original, original);
              item.classList.remove('edited');
              stat.textContent = original.length + ' 字';
              editedPill.hidden = true;
              revertBtn.hidden = true;
              refreshFoot();
            }
          }
        })
      ])
    ]);
    var revertBtn = head.querySelector('.right .btn');

    var item = el('div', { class: 'pageitem' + (suspect ? ' suspect' : '') + (current !== original ? ' edited' : '') }, [
      head,
      el('div', { class: 'pi-body' }, [ta]),
      reason ? el('div', { class: 'pi-reason' }, [icon('alert'), el('span', { text: reason })]) : null
    ]);
    return item;
  }

  /** 一份来源一组的标题：角色 + 文件名 + 页数 + 已改几页 + 「还原这一份」。 */
  function buildGroupHead(src, pages) {
    var n = ctx.editedCountOf(src.id);
    var right = el('div', { class: 'right' }, [
      n ? el('button', {
        class: 'btn sm ghost', type: 'button', text: '还原这一份',
        on: {
          click: function () {
            revertSource(src.id);
            renderAll();
            ctx.toast('已还原「' + (src.fileName || '这一份') + '」的 ' + n + ' 处修改', 'info');
          }
        }
      }) : null,
      el('button', {
        class: 'btn sm ghost', type: 'button', 'aria-label': '重新抽取这一份材料',
        on: { click: function () { reloadOne(src); } }
      }, [icon('refresh'), el('span', { text: '重读' })])
    ]);

    return el('div', { class: 'card-head src-group-head' }, [
      el('span', { class: 'pill field', text: ctx.ROLE_LABEL[src.role] || src.role }),
      el('b', { class: 'sg-name', title: src.filePath, text: src.fileName || ctx.baseName(src.filePath) }),
      el('span', { class: 'hint', text: pages.length + ' 页' + (n ? ' · 已改 ' + n + ' 页' : '') }),
      right
    ]);
  }

  /** 一份来源的分页列表（自己管自己的「继续显示」）。 */
  function buildGroup(src) {
    var group = el('div', { class: 'card src-group', dataset: { src: src.id } });
    var pages = (src.extract && src.extract.pages) || [];
    group.appendChild(buildGroupHead(src, pages));

    if (src.extractError) {
      group.appendChild(el('div', { class: 'banner warn', style: 'margin:0' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这份材料没读出来' }),
          el('div', { text: '可以重试一次；如果一直失败，换一份文件或先转成 PDF 试试。' }),
          el('div', { class: 'hint mono', text: ctx.clip((src.extractError && src.extractError.message) || String(src.extractError), 240) }),
          el('div', { style: 'margin-top:8px;display:flex;gap:8px' }, [
            el('button', {
              class: 'btn sm primary', type: 'button', text: '重新读一次',
              on: { click: function () { reloadOne(src); } }
            }),
            ctx.detailButton(src.extractError)
          ])
        ])
      ]));
      return group;
    }

    /* 疑似扫描件：横幅照挂，但**下面照样把抽出来的页列出来** ——
       "六成以上整页没文字"不等于一个字都没有，剩下那几页里的文字往往正是最有用的那点。
       提前 return 会让用户以为这一份彻底空了。 */
    var diag = (src.extract && src.extract.diagnosis) || null;
    if (diag && diag.likely) {
      group.appendChild(el('div', { class: 'banner warn', style: 'margin:0 0 12px' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这一份多半是扫描件，下面这些页很可能一个字都没抽到' }),
          el('div', { text: diag.reason || '' }),
          (diag.suggestions && diag.suggestions.length)
            ? el('div', { class: 'hint', text: '可以：' + diag.suggestions.join('；') })
            : null
        ])
      ]));
    }

    if (src.extractLoading && !src.extract) {
      group.appendChild(el('div', { class: 'empty' }, [ctx.spinner('lg'), el('b', { text: '正在读这份材料…' }),
      el('p', { text: '大文件（几十兆的 PDF）会慢一点，请稍等。' })]));
      return group;
    }
    if (!src.extract) {
      group.appendChild(el('div', { class: 'empty' }, [el('b', { text: '还没读' }),
      el('p', { text: '点右上角的「重读」读一次。' })]));
      return group;
    }
    if (!pages.length) {
      group.appendChild(ctx.emptyState({
        icon: 'file', title: '这份材料里没抽到文字',
        text: '可能是纯图片的扫描件。可以换一份带文字的材料，或者先在别处把文字整理成 .md / .txt 再拖进来。'
      }));
      return group;
    }

    var wrap = el('div', { class: 'page-list' });
    var shown = 0;
    var moreBtn = el('button', {
      class: 'btn block', type: 'button',
      on: { click: function () { appendChunk(); } }
    });
    function appendChunk() {
      var end = Math.min(shown + PAGE_CHUNK, pages.length);
      for (var i = shown; i < end; i++) wrap.appendChild(buildPageItem(src, pages[i], i + 1));
      shown = end;
      if (shown < pages.length) {
        moreBtn.textContent = '继续显示（还有 ' + (pages.length - shown) + ' 页）';
        if (!moreBtn.parentNode) wrap.appendChild(moreBtn);
      } else if (moreBtn.parentNode) {
        moreBtn.parentNode.removeChild(moreBtn);
      }
    }
    appendChunk();
    group.appendChild(wrap);
    return group;
  }

  function renderNotice() {
    if (!noticeBox) return;
    noticeBox.innerHTML = '';
    var s = ctx.state;
    if (!s.sources.length) return;

    var suspect = 0, warns = [];
    s.sources.forEach(function (src) {
      var ex = src.extract || {};
      warns = warns.concat((ex.warnings || []).filter(function (w) { return w && w.message; }).map(function (w) {
        // 提示里必须带上是哪一份：多来源下"第 3 页"没有意义
        return { src: src, w: w };
      }));
      suspect += (ex.pages || []).filter(function (p) { return p.quality && p.quality.suspect; }).length;
    });

    if (suspect) {
      noticeBox.appendChild(el('div', { class: 'banner warn' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '有 ' + suspect + ' 页的文字可能不对' }),
          el('div', { text: '这些页已经标红。抽歪了不要紧，直接在框里改，改完的版本会带进生成。' })
        ])
      ]));
    }
    if (warns.length) {
      var box = el('div', { class: 'banner info' }, [
        icon('info'),
        el('div', { class: 'bt' }, [el('b', { text: '读取时记下的 ' + warns.length + ' 条提示' })])
      ]);
      warns.slice(0, 8).forEach(function (it) {
        box.querySelector('.bt').appendChild(el('div', {
          class: 'hint',
          text: '[' + (it.src.fileName || it.src.id) + '] ' + (it.w.page ? '第 ' + it.w.page + ' 页：' : '') + it.w.message
        }));
      });
      noticeBox.appendChild(box);
    }
  }

  function renderList() {
    var s = ctx.state;
    listBox.innerHTML = '';

    if (!s.sources.length) {
      listBox.appendChild(ctx.emptyState({
        icon: 'file', title: '还没有材料',
        text: '先在工作台拖一份 PPT / PDF / 文本进来，这里就会按材料分开显示抽出来的每一页文字。',
        action: el('button', { class: 'btn primary', type: 'button', text: '去工作台加材料', on: { click: function () { ctx.go('#workbench'); } } })
      }));
      return;
    }

    s.sources.forEach(function (src) { listBox.appendChild(buildGroup(src)); });

    /* 从工作台某一行点「抽取预览」进来时，直接滚到那一份 —— 四份材料几十页，
       不滚的话用户得自己找。滚动是"顺手做的事"，找不到元素就算了，不能因此报错。 */
    var focus = s.extractFocus;
    if (focus) {
      s.extractFocus = null;
      var node = listBox.querySelector('.src-group[data-src="' + focus + '"]');
      if (node && typeof node.scrollIntoView === 'function') {
        try { node.scrollIntoView({ block: 'start' }); node.classList.add('flash'); } catch (e) { }
      }
    }
  }

  function renderAll() { renderList(); renderNotice(); refreshFoot(); }

  function refreshFoot() {
    if (!footBox) return;
    var s = ctx.state;
    var n = editedCount();
    footBox.innerHTML = '';

    // 每份各改了几页：多来源下只说总数，用户没法判断"改的是哪一份要不要紧"
    var per = s.sources.filter(function (src) { return ctx.editedCountOf(src.id) > 0; })
      .map(function (src) { return (ctx.ROLE_LABEL[src.role] || src.role) + ' ' + ctx.editedCountOf(src.id); });

    footBox.appendChild(el('div', { class: 'left' }, [
      el('div', {
        class: 'hint',
        text: n ? ('已改 ' + n + ' 页（' + per.join(' · ') + '），生成时会用改后的文本')
          : (s.sources.length ? '没改过，生成时用抽取原文' : '清单里还没有材料')
      }),
      (s.sources.length ? el('div', {
        class: 'hint mono', title: s.sources.map(function (x) { return x.filePath; }).join('\n'),
        text: s.sources.map(function (x) { return x.fileName; }).join(' · ')
      }) : null)
    ]));
    footBox.appendChild(el('div', { class: 'right' }, [
      n ? el('button', {
        class: 'btn ghost', type: 'button', text: '全部还原',
        on: {
          click: function () {
            ctx.confirm('全部还原？',
              '会把 ' + s.sources.length + ' 份材料里所有改过的页都改回抽取原文，你的修改会丢掉（各份材料互不影响）。',
              '还原').then(function (ok) {
                if (!ok) return;
                ctx.state.extractEdits = {};
                renderAll();
                ctx.toast('已全部还原', 'info');
              });
          }
        }
      }) : null,
      el('button', {
        class: 'btn', type: 'button', text: '返回工作台',
        on: { click: function () { ctx.go('#workbench'); } }
      }),
      el('button', {
        class: 'btn primary', type: 'button', text: '用这些文本去生成',
        disabled: !s.sources.length || s.sources.every(function (src) { return !!src.extractError; }),
        on: { click: function () { ctx.go('#workbench'); } }
      })
    ]));
  }

  function reloadOne(src) {
    ctx.reloadSourceExtract(src.id).then(renderAll);
  }

  function load(force) {
    renderList();
    ctx.loadExtract(null, force).then(function () { renderAll(); });
  }

  function build() {
    var s = ctx.state;
    var total = s.sources.reduce(function (n, src) {
      return n + ((src.extract && src.extract.meta && src.extract.meta.pageCount) || 0);
    }, 0);
    var sub = s.sources.length
      ? (s.sources.length + ' 份材料' + (total ? ' · 共 ' + total + ' 页' : '') + ' · 按材料分开列，页号互不相干')
      : '看看大模型会读到的文字，可疑的地方当场改';

    root.appendChild(ctx.pageHead({
      title: '抽取预览',
      sub: sub,
      actions: [
        el('button', {
          class: 'btn sm', type: 'button',
          disabled: !s.sources.length,
          on: { click: function () { load(true); } }
        }, [icon('refresh'), el('span', { text: '全部重读' })])
      ]
    }));

    noticeBox = el('div', {});
    root.appendChild(noticeBox);
    listBox = el('div', {});
    root.appendChild(listBox);
    footBox = el('div', { class: 'sticky-foot' });
    root.appendChild(footBox);

    // 有哪一份还没读过（也没报错）就先读它；都读过了就直接画
    var need = s.sources.some(function (src) { return !src.extract && !src.extractError; });
    if (need) load(false);
    else renderAll();
  }

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    build();
  }
  function unmount() { root = null; ctx = null; listBox = headBox = footBox = noticeBox = null; }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.extract = { mount: mount, unmount: unmount };
})();
