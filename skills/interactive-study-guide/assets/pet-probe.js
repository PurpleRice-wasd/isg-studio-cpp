/* 陪练探针 —— 查「有图才出现」这件事本身，以及拖动 / 双击换模式 / 右键菜单 / 顶部开关。
 *
 * ⚠️ 别手工往页面里贴！用 assets/inject-probe.py：
 *      python inject-probe.py 被测页.html verify-probe.js pet-probe.js
 *   注入器会把它包好 script 标签插到 </body> 前，并输出到**同目录**（相对路径的图片才认得到）。
 *   然后跑无头浏览器，从 title 里读结果：
 *      msedge --headless=new --disable-gpu --no-sandbox --user-data-dir=<新目录> \
 *             --virtual-time-budget=22000 --dump-dom "file:///…/_probe_被测页.html" | grep '<title>'
 *
 * 两种页面都要跑：
 *   · **同目录没有图片**的页面 → 期望「形象=不显示」「占位=0px」「开关=没放图」，点开关只冒一句放图提示；
 *   · **同目录有 pet.png / pet.jpg** 的页面 → 期望「形象=显示」「开关=开」，拖动/双击/右键都要有反应。
 *
 * ⚠️ 维护提醒：本文件会被整段塞进一个 script 标签里，正文里**绝不能出现 script 的开/闭标签**
 *    （注释里举例也不行）——解析器会提前关闭脚本，整段探针变成页面上的可见文字。提到标签时用 ⟨⟩。
 * ⚠️ 图片是**异步**加载的：形象「还没出来」和「确定没有图」是两回事。判断"确定没有"只能看引擎
 *    自己给的信号——顶部开关变成「没放图」（它试完全部候选名之后才会这么写）。别用固定延时。
 */
(function () {
  var out = [];
  function P(s) { out.push(s); }
  function flush(tag) {
    document.title += ' ；【' + (tag || '陪练') + '】' + out.join(' ；');
    out = [];
  }

  var pet = document.getElementById('pet'),
      bubble = document.getElementById('petBubble'),
      fig = document.getElementById('petFig'),
      toggle = document.getElementById('petToggle');
  if (!pet || !bubble || !fig || !toggle) {
    /* 页面可以整块不要陪练（或把这块挪到引擎脚本之后）。这时要回答两个问题：
       ① 引擎有没有被连累（题目/进度还在不在）；② 顶部那个开关是不是变成了死键。 */
    P('陪练块不完整：' + (pet ? '' : '缺#pet ') + (bubble ? '' : '缺#petBubble ')
      + (fig ? '' : '缺#petFig ') + (toggle ? '' : '缺#petToggle '));
    var banks = document.querySelectorAll('script[data-bank]').length;
    P('题库段=' + banks + ' 题卡=' + document.querySelectorAll('.q,.grp').length
      + ' 顶部进度=' + (function () { var d = document.getElementById('s-done'), t = document.getElementById('s-total');
          return (d ? d.textContent : '?') + '/' + (t ? t.textContent : '?'); })()
      + ' 结算条=' + document.querySelectorAll('#r-bars .r').length + '条');
    if (toggle) {
      var before = toggle.textContent;
      toggle.click();
      P('开关：文案=' + toggle.textContent.replace(/\s+/g, '') + ' 点击后=' +
        (toggle.textContent === before ? '毫无反应（死键——没有陪练块时应该把它隐藏掉）' : '有反应'));
      P('开关是否被隐藏=' + (toggle.style.display === 'none' ? '是（对）' : '否'));
    }
    flush('陪练·残缺');
    return;
  }

  function shown(el) { return !!(el && el.offsetWidth > 0 && getComputedStyle(el).display !== 'none'); }
  function noImg() { return /没放图/.test(toggle.textContent); }
  function store() {                     /* 存盘键每章都不同，从 localStorage 里反查 */
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i), v = null;
        try { v = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { }
        if (v && v.ui && ('petMode' in v.ui)) return { k: k, v: v };
      }
    } catch (e) { }
    return null;
  }
  function ev(node, type, x, y, touch) {
    var d = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 };
    if (window.PointerEvent) {
      d.pointerType = touch ? 'touch' : 'mouse';
      node.dispatchEvent(new PointerEvent(type, d));
    } else {
      var e = document.createEvent('MouseEvents');
      e.initMouseEvent(type.replace('pointer', 'mouse'), true, true, window, 0, x, y, x, y, false, false, false, false, 0, null);
      node.dispatchEvent(e);
    }
  }
  function down(x, y, touch) { ev(fig, 'pointerdown', x, y, touch); }
  function move(x, y) { ev(document, 'pointermove', x, y); }
  function up(x, y) { ev(document, 'pointerup', x, y); }

  /* ---- 先等图片那边定性：形象出来了，或者引擎明确说"没放图" ---- */
  var tries = 0;
  (function wait() {
    if (fig.classList.contains('hasimg') || noImg() || tries >= 48) return after();
    tries++;
    setTimeout(wait, 250);
  })();

  function after() {
    var img = fig.classList.contains('hasimg') && shown(fig);
    var isFish = fig.classList.contains('kind-fish'), isPhoto = fig.classList.contains('kind-image');
    P('等了' + (tries + 1) + '轮：' + (img ? ('形象已显示(' + (isFish ? '内置大肥鱼' : (isPhoto ? '同目录图片' : '类型不明')) + ')')
                                          : (noImg() ? '没有形象，不显示（期望如此）' : '既没出来也没说没有，异常')));
    P('开关文案=' + toggle.textContent.replace(/\s+/g, ''));
    P('调试接口=' + (window.__PET__ ? ('有，art=' + window.__PET__.art() + ' hasImg=' + window.__PET__.hasImg()) : '没有（异常）'));

    if (!img) {
      /* 没图状态：右下角必须干干净净，只剩顶部那个开关当入口 */
      P('形象占位=' + (fig.getBoundingClientRect().width || 0) + 'px（要 0）'
        + ' display=' + getComputedStyle(fig).display + '（要 none）');
      toggle.click();
      P('点开关后气泡=' + (bubble.classList.contains('on') ? ('冒了：' + bubble.textContent.slice(0, 20)) : '没冒（异常）'));
      var btns = [];
      Array.prototype.forEach.call(bubble.querySelectorAll('button'), function (b) { btns.push(b.textContent.trim()); });
      P('气泡里的按钮=' + (btns.join('/') || '没有（异常）'));
      var fb = bubble.querySelector('button[data-pet="fish"]');
      if (fb) {
        fb.click();
        var fi = fig.querySelector('img.fish-front');
        P('点「用内置的大肥鱼」：形象=' + (shown(fig) ? '显示' : '不显示（异常）')
          + ' kind-fish=' + fig.classList.contains('kind-fish')
          + ' 内置图=' + (fi ? ((fi.naturalWidth ? (fi.naturalWidth + '×' + fi.naturalHeight + 'px ') : '')
              + (fi.src.indexOf('data:image/png') === 0 ? ('已内嵌' + Math.round(fi.src.length * 3 / 4 / 1024) + 'KB') : '外部文件'))
            : '没有（异常）')
          + ' 开关=' + toggle.textContent.replace(/\s+/g, ''));
        var rf = fig.getBoundingClientRect();
        down(rf.left + rf.width / 2, rf.top + rf.height / 2, true);
        move(rf.left + rf.width / 2 - 100, rf.top + rf.height / 2 - 60);
        P('拖动中 侧面图可见=' + (function () {
          var s = fig.querySelector('img.fish-side');
          return s && getComputedStyle(s).display !== 'none' && !fig.classList.contains('faceL') ? '是' : (fig.classList.contains('moving') ? '是(镜像)' : '否');
        })() + ' moving=' + fig.classList.contains('moving'));
        up(rf.left + rf.width / 2 - 100, rf.top + rf.height / 2 - 60);
        var rf2 = fig.getBoundingClientRect();
        P('内置形象拖动位移=左' + Math.round(rf.left - rf2.left) + 'px/上' + Math.round(rf.top - rf2.top) + 'px'
          + ' 松手后 moving=' + fig.classList.contains('moving') + '（要 false）'
          + ' 存盘=' + (function () { var s = store(); return s && s.v.ui.petPos ? '有' : '无'; })());
      } else { P('气泡里没有「用内置大肥鱼」按钮（异常）'); }
      flush('陪练·无图');
      return;
    }

    /* ---- 有图：先把陪练确保是开着的，否则拖不动 ---- */
    if (/：关/.test(toggle.textContent)) toggle.click();
    P('打开后开关=' + toggle.textContent.replace(/\s+/g, '') + ' 形象=' + (shown(fig) ? '显示' : '不显示（异常）'));

    /* ---- 拖动：形象要跟着走，位置要存下来 ---- */
    var r0 = fig.getBoundingClientRect();
    var sx = r0.left + r0.width / 2, sy = r0.top + r0.height / 2;
    down(sx, sy); move(sx - 130, sy - 90); up(sx - 130, sy - 90);
    var r1 = fig.getBoundingClientRect();
    var st = store();
    P('拖动：位移=左' + Math.round(r0.left - r1.left) + 'px/上' + Math.round(r0.top - r1.top) + 'px'
      + ' 存盘=' + (st && st.v.ui.petPos ? ('有' + JSON.stringify(st.v.ui.petPos)) : '无（异常）'));

    /* ---- 单击只说话、双击换模式 ---- */
    var mode0 = (store() || { v: { ui: {} } }).v.ui.petMode;
    down(r1.left + 8, r1.top + 8); up(r1.left + 8, r1.top + 8);
    var oneShot = bubble.classList.contains('on');
    var r2 = fig.getBoundingClientRect();
    down(r2.left + 8, r2.top + 8); up(r2.left + 8, r2.top + 8);
    down(r2.left + 8, r2.top + 8); up(r2.left + 8, r2.top + 8);
    var mode1 = (store() || { v: { ui: {} } }).v.ui.petMode;
    P('单击冒泡=' + (oneShot ? '是' : '否（异常）') + ' 双击换模式=' + (mode0 || '?') + '→' + (mode1 || '?')
      + ' 气泡=' + bubble.textContent.slice(0, 12));

    /* ---- 右键菜单：弹出、切大小、回右下角、藏起来再召回 ---- */
    fig.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    var menu = pet.querySelector('.petmenu');
    P('右键菜单=' + ((pet.classList.contains('menuon') && menu) ? ('弹出，' + menu.querySelectorAll('button').length + '个按钮') : '没弹出（异常）'));
    if (!menu) { flush('陪练·有图'); return; }
    P('菜单项=' + (function () {
      var a = [];
      Array.prototype.forEach.call(menu.querySelectorAll('button'), function (b) { a.push(b.textContent.trim()); });
      return a.join('/');
    })());
    var big = menu.querySelector('button[data-s="1.25"]');
    if (big) big.click();
    P('点「大」后 --petk=' + (pet.style.getPropertyValue('--petk') || '(空，异常)'));
    var home = menu.querySelector('button[data-a="home"]');
    if (home) home.click();
    P('点「回到右下角」：内联 right=' + (pet.style.right || '(空=回落默认)') + ' bottom=' + (pet.style.bottom || '(空=回落默认)')
      + ' 存盘位置=' + (function () { var s = store(); return s && s.v.ui.petPos ? '仍在（异常）' : '已清'; })());
    /* ---- 形象切换：图片 ↔ 内置大肥鱼 ---- */
    var fishBtn = menu.querySelector('button[data-art="fish"]'), imgBtn = menu.querySelector('button[data-art="image"]');
    P('菜单形象项=鱼' + (fishBtn ? '有' : '无') + '/图片' + (imgBtn ? '有' : '无'));
    if (fishBtn) {
      fishBtn.click();
      P('切内置大肥鱼：kind-fish=' + fig.classList.contains('kind-fish') + ' 形象=' + (shown(fig) ? '显示' : '不显示（异常）')
        + ' 图=' + (function () {
            var i = fig.querySelector('img.fish-front');
            if (!i) return '没有';
            return (i.naturalWidth ? (i.naturalWidth + '×' + i.naturalHeight + 'px ') : '')
                 + (i.src.indexOf('data:image/png') === 0 ? ('已内嵌' + Math.round(i.src.length * 3 / 4 / 1024) + 'KB') : '外部');
          })()
        + ' 背景=' + (function () { var b = document.getElementById('bgimg'); return b && b.classList.contains('on') ? '启用' : '未启用'; })());
    }
    if (imgBtn) {
      imgBtn.click();
      P('切回我放的图片：kind-image=' + fig.classList.contains('kind-image') + ' 形象=' + (shown(fig) ? '显示' : '不显示（异常）')
        + ' src=' + (function () { var i = fig.querySelector('img'); return i ? i.src.split('/').pop() : '没有'; })());
    }
    fig.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    var hide = menu.querySelector('button[data-a="hide"]');
    if (hide) hide.click();
    P('藏起来后形象=' + (shown(fig) ? '还显示（异常）' : '已隐藏') + ' 开关=' + toggle.textContent.replace(/\s+/g, ''));
    toggle.click();
    P('点开关召回=' + (shown(fig) ? '回来了' : '没回来（异常）'));
    flush('陪练·有图');

    /* ---- 台词：读引擎真正在用的那套（用 __PET__.lines），证明用户上传的文本认出来了 ---- */
    var L = (window.__PET__ && window.__PET__.lines) || {};
    function first(k) { var a = L[k]; return (a instanceof Array ? a[0] : a) || '(缺)'; }
    P('在用台词 right=' + String(first('right')).slice(0, 16)
      + ' empty=' + String(first('empty')).slice(0, 16)
      + ' hint=' + String(first('hint')).slice(0, 16)
      + ' 内联块=' + document.querySelectorAll('script[data-petlines]').length + '个'
      + ' 外部文件=' + (window.PET_LINES || window.PET_LINES_TEXT ? '有' : '无'));

    /* ---- 跟随模式：rAF 驱动的，慢一点单独看（鼠标移到左上角，形象该跟过去） ---- */
    var menu2 = pet.querySelector('.petmenu');
    if (menu2) {
      fig.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      var fol = menu2.querySelector('button[data-m="follow"]');
      if (fol) fol.click();
    }
    var before = fig.getBoundingClientRect();
    ev(document, 'mousemove', 30, 30);
    setTimeout(function () {
      var after2 = fig.getBoundingClientRect();
      out.push('跟随模式：鼠标移到左上角后形象位移=' + Math.round(Math.abs(after2.left - before.left)) + 'px'
        + '/上' + Math.round(Math.abs(after2.top - before.top)) + 'px（要 >0）');
      flush('陪练·跟随');
    }, 1200);
  }
})();
