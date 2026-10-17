/* 演示探针 —— 拖动每个滑块到几个位置，把读数抄下来；再顺手查一遍 SVG 有没有元素越出 viewBox。
 *
 * 用法（和 verify-probe.js 一起注入）：
 *      python inject-probe.py 被测页.html verify-probe.js demo-probe.js
 *   结果同样读 <title>。输出的读数是"**该位置下页面显示的值**"，
 *   你要自己拿公式手算一遍核对（这正是"数据与图必须自洽"的最低验收）。
 *
 *   越界检查查的是"标签/箭头被 viewBox 裁掉"这类问题（作者在 ch14 上真踩过：
 *   曲线面板做窄了，滑块拉到最大时工作点标签被裁）。**叠字、压线这类问题它查不出来——
 *   画完必须截图看一眼。**
 *
 * ⚠️ 和 verify-probe.js 一样：本文件正文里不能出现 script 的开/闭标签（会被 HTML 解析器截断），
 *    提到标签时用 ⟨⟩。
 */
(function () {
  var out = [];
  function P(s) { out.push(s); }

  try {
    var demos = document.querySelectorAll('.demo');
    P('演示台=' + demos.length);

    Array.prototype.forEach.call(demos, function (demo, di) {
      var name = demo.id || ('demo' + (di + 1));
      var ranges = demo.querySelectorAll('input[type=range]');
      P('—— ' + name + '：滑块 ' + ranges.length + ' 个');

      Array.prototype.forEach.call(ranges, function (rg, ri) {
        var mn = parseFloat(rg.min || '0'), mx = parseFloat(rg.max || '100');
        var vals = [mn, mn + (mx - mn) / 2, mx];
        var shots = [];
        vals.forEach(function (v) {
          rg.value = String(v);
          rg.dispatchEvent(new Event('input', { bubbles: true }));
          var rd = [];
          Array.prototype.forEach.call(demo.querySelectorAll('.readout b'), function (b) {
            rd.push(b.textContent.trim());
          });
          if (!rd.length) {                       /* 没有 .readout 就退而求其次，抓 id 里带数字的读数 */
            Array.prototype.forEach.call(demo.querySelectorAll('[id^="d"] b, [id^="d"][class*=val]'), function (b) {
              rd.push(b.textContent.trim());
            });
          }
          shots.push(rg.value + '→[' + rd.join(' ') + ']');
        });
        P('   滑块' + (ri + 1) + '(' + (rg.getAttribute('aria-label') || rg.id || '') + ') ' + shots.join('  '));
      });

      /* SVG 越界检查 */
      var bad = [];
      Array.prototype.forEach.call(demo.querySelectorAll('svg'), function (svg) {
        var vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        if (vb.length !== 4) return;
        var x0 = vb[0], y0 = vb[1], x1 = vb[0] + vb[2], y1 = vb[1] + vb[3];
        Array.prototype.forEach.call(svg.querySelectorAll('text,circle,rect,line,path,image'), function (el) {
          var b; try { b = el.getBBox(); } catch (e) { return; }
          if (!b || (b.width === 0 && b.height === 0)) return;      /* 隐藏或空元素 */
          if (b.x < x0 - 2 || b.y < y0 - 2 || b.x + b.width > x1 + 2 || b.y + b.height > y1 + 2) {
            var t = (el.textContent || el.tagName).trim().slice(0, 14);
            bad.push(el.tagName + '⟨' + t + '⟩');
          }
        });
      });
      P('   SVG 越界元素=' + bad.length + (bad.length ? '(' + bad.slice(0, 6).join(' ') + ')' : ''));
    });
  } catch (e) {
    P('演示探针自身抛错:' + e.message);
  }

  document.title += ' ；【演示探针】' + out.join(' ； ');
})();
