/* 校验探针 —— 把题库里的正确答案自动答一遍，检查判分、统计、陪练与报错。
 *
 * ⚠️ 别手工往页面里贴！用 assets/inject-probe.py：
 *      python inject-probe.py 被测页.html
 *   它会在 head 插错误收集器、把本文件包好 script 标签插到 body 末尾，并输出到**同目录**
 *   （同目录是必须的：否则相对路径的图片加载失败，陪练/背景会被误报成"没有"）。
 *   然后跑无头浏览器，从 title 里读结果：
 *      msedge --headless=new --disable-gpu --no-sandbox --user-data-dir=<新目录> \
 *             --virtual-time-budget=16000 --dump-dom "file:///…/_probe_被测页.html" | grep '<title>'
 *   期望：缺卡=0、自动作答后判错=0、进度=总数/总数、脚本错误=无。
 *
 * ⚠️ 维护提醒：本文件会被整段塞进一个 script 标签里，所以正文里**绝不能出现 script 的开/闭标签**
 *    （哪怕是注释里举例也不行）——HTML 解析器见到结束标签就提前关闭脚本，整段探针会变成
 *    页面上的可见文字且完全不执行。需要提到标签时用 ⟨⟩ 代替尖括号。
 */
(function () {
  var out = [];
  function P(s) { out.push(s); }

  try {
    /* 1. 题库能不能全部解析（JSON 尾逗号之类的错误在这里现形） */
    var bank = [];
    Array.prototype.forEach.call(document.querySelectorAll('script[data-bank]'), function (s) {
      try { bank = bank.concat(JSON.parse(s.textContent)); }
      catch (e) { P('题库解析失败:' + s.id + '(' + e.message + ')'); }
    });
    var pts = [];
    bank.forEach(function (q) {
      if (q.type === 'big') { (q.parts || []).forEach(function (p, i) { pts.push({ id: q.id + '-' + (i + 1), q: p }); }); }
      else { pts.push({ id: q.id, q: q }); }
    });
    P('题库条目=' + pts.length);

    /* 2. 每道题都有对应的卡片吗 */
    var miss = [];
    pts.forEach(function (pt) { if (!document.getElementById('q-' + pt.id)) miss.push(pt.id); });
    P('缺卡=' + miss.length + (miss.length ? '(' + miss.slice(0, 5).join(',') + ')' : ''));

    /* 3a. 填数题的写法容错：带单位、科学计数法都该判对（拿第一道数值题试） */
    var numPt = null;
    pts.forEach(function (pt) { if (!numPt && pt.q.type === 'num' && pt.q.ans != null) numPt = pt; });
    if (numPt) {
      var c0 = document.getElementById('q-' + numPt.id), q0 = numPt.q;
      var retry = function (val) {
        var btns = c0.querySelectorAll('.mini');
        if (btns.length) btns[btns.length - 1].click();              /* 先「重做本题」复位 */
        c0.querySelector('input').value = val;
        c0.querySelector('.btn').click();
        return /\bright\b/.test(c0.className);
      };
      var r1 = retry(String(q0.ans) + (q0.unit ? ' ' + q0.unit : ''));
      var r2 = retry(Number(q0.ans).toExponential(2));
      P('写法容错(' + numPt.id + ') 带单位=' + (r1 ? '对' : '错') + ' 科学计数法=' + (r2 ? '对' : '错'));
    }

    /* 3b. 按题库里的正确答案把每道题自动做一遍，全部应该判对 */
    var bad = [], thrown = 0;
    pts.forEach(function (pt) {
      var card = document.getElementById('q-' + pt.id); if (!card) return;
      var q = pt.q;
      try {
        if (q.type === 'single' || q.type === 'multi') {
          Array.prototype.forEach.call(card.querySelectorAll('.opt'), function (b, i) {
            if (q.opts && q.opts[i] && q.opts[i].ok) b.click();
          });
          if (q.type === 'multi') card.querySelector('.btn').click();
        } else if (q.type === 'num') {
          var inp = card.querySelector('input');
          inp.value = q.ansText ? q.ansText[0] : String(q.ans);
          card.querySelector('.btn').click();
        } else { return; }
        if (!/\bright\b/.test(card.className)) bad.push(pt.id);
      } catch (e) { thrown++; P('作答抛错 ' + pt.id + ':' + e.message); }
    });
    P('自动作答后判错=' + bad.length + (bad.length ? '(' + bad.slice(0, 6).join(',') + ')' : '') + ' 抛错=' + thrown);

    /* 4. 进度、计数、结算是否同步（关卡名是从页面推导的，一并打印出来核对） */
    var g = function (id) { var e = document.getElementById(id); return e ? e.textContent : '?'; };
    P('顶部进度=' + g('s-done') + '/' + g('s-total') + ' 正确率=' + g('s-rate') + ' 错题=' + g('s-wrong'));
    var cnt = [];
    Array.prototype.forEach.call(document.querySelectorAll('.cnt[data-cnt]'), function (c) {
      cnt.push(c.getAttribute('data-cnt') + '=' + c.textContent.trim());
    });
    P('各关计数=' + cnt.join(','));
    var names = [];
    Array.prototype.forEach.call(document.querySelectorAll('#r-bars .nm'), function (n) { names.push(n.textContent.trim()); });
    P('结算关卡名=' + names.join(' / '));
    P('结算评价=' + g('r-verdict'));

    /* 5. 「重做本题」能不能把卡片复位 */
    var one = document.querySelector('.q.wrongq') || document.querySelector('.q');
    if (one) {
      var btns = one.querySelectorAll('.mini');
      if (btns.length) btns[btns.length - 1].click();
      P('重做后该题=' + (/\b(done|right|wrongq)\b/.test(one.className) ? '仍为已答(异常)' : '已复位'));
    }

    /* 6. 报错 */
    var errs = window.__PROBE_ERRS__ || [];
    P('脚本错误=' + (errs.length ? errs.join(' | ') : '无'));
  } catch (e) {
    P('探针自身抛错:' + e.message);
  }

  document.title = '【探针】' + out.join(' ； ');

  /* 7. 陪练图与背景是**异步**加载的（实测要 1~2 秒），固定延时容易误报"没有图"——改成轮询 */
  var tries = 0;
  function lateImage() {
    var f = document.getElementById('petFig'), b = document.getElementById('bgimg');
    var fish = !!(f && f.classList.contains('kind-fish'));
    var photo = !!(f && f.classList.contains('kind-image'));
    var bg = !!(b && b.classList.contains('on'));
    var vis = !!(f && f.offsetWidth > 0);
    if (fish || photo || bg || tries >= 40) {
      var errs2 = window.__PROBE_ERRS__ || [];
      document.title += ' ；【异步·查了' + (tries + 1) + '次】陪练形象='
                      + (fish ? '内置大肥鱼' : (photo ? '同目录图片' : (vis ? '有(类名不认识)' : '无(没图也没选内置形象时就该是"无")')))
                      + ' 背景启用=' + (bg ? '是' : '否')
                      + ' 异步脚本错误=' + (errs2.length ? errs2.join(' | ') : '无');
      return;
    }
    tries++;
    setTimeout(lateImage, 250);
  }
  setTimeout(lateImage, 200);
})();
