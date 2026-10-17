'use strict';
/* 探针结果的**解析层**（Phase 5）。
 *
 * 对应 oracle 的 `src/main/verify/runner.js` 里那些纯函数（splitSegments / parseTitle /
 * parseLevelCounts / parseAsyncSeg / parseDemoSeg / evalPetLine …）与 `demo-checks.js`
 * 的数值比较（near / pickNumber / sameValue）。这里逐函数搬过来，**口径一个字不改**：
 * `；` 分隔、`【组名】` 前缀继承、各关计数用"作答点"而不是题卡数、demo 读数 0.5% 相对容差。
 *
 * 为什么留在 JS 而不是翻成 C++：这些是**判据的口径**，逐字节照抄 oracle 比重新推导安全；
 * 宿主（C++）只负责把 title / DOM 快照 / 错误表交过来（见 src/verify/probe_runner.cpp）。
 *
 * 两种加载方式：index.html 里是普通脚本（挂到 window.__isgProbeParse）；
 * 也有可能被别的 CommonJS 环境 require。 */
(function (global) {
  'use strict';

  function item(key, raw, ok, note) {
    /* label 不是给人看的装饰：pipeline 的修复轮用 `/演示|滑块|SVG/` 与
       `/脚本错误/` 匹配 label 来决定要不要重出演示。丢了它，探针报出的
       「SVG 越界元素 / 滑块读数 / 脚本错误」就永远不会触发修复。 */
    return {
      key: key,
      label: LABELS[key] || key,
      raw: raw == null ? '' : raw,
      ok: ok === undefined ? null : ok,
      note: note || ''
    };
  }

  const LABELS = {
    '题库解析失败': '题库 JSON 能否全部解析',
    '题库条目': '题库作答点数量',
    '缺卡': '每道题都有对应卡片',
    '写法容错': '填数题写法容错（带单位 / 科学计数法）',
    '自动作答后判错': '按正确答案自动作答后全部判对',
    '作答抛错': '自动作答时抛错',
    '顶部进度': '顶部进度：已作答 = 总数',
    '顶栏总数': '顶栏的作答点总数 = 题库里的作答点数',
    '各关计数': '各关 .cnt 的分母 = 该关作答点数（题卡数一并核对）',
    '结算关卡名': '结算区用的关卡名',
    '结算评价': '结算评语',
    '重做后该题': '「重做本题」能把卡片复位',
    '脚本错误': '脚本错误（同步项跑完时）',
    '探针自身抛错': '探针自身抛错',
    '异步脚本错误': '脚本错误（异步项跑完后）',
    '陪练形象': '陪练形象',
    '背景启用': '背景图是否启用',
    '演示台': '演示台数量',
    '演示台滑块': '每个演示台的滑块数',
    '滑块读数': '滑块读数（要拿公式手算核对）',
    'SVG 越界元素': 'SVG 元素是否越出 viewBox',
    '演示探针自身抛错': '演示探针自身抛错',
    '陪练探针': '陪练探针',
    '探针未产出结果': '探针是否产出了结果',
    '探针未跑完': '探针是否在超时前跑完',
    '校验被中断': '校验是否跑完（应用退出时会就地结束）',
    '校验环境告警': '校验环境（加载方式 / 探针副本位置）'
  };

  function numOrNull(s) {
    const n = parseFloat(String(s == null ? '' : s).replace(/[^\d.\-+eE]/g, ''));
    return isFinite(n) ? n : null;
  }

  /** 解析「；」分隔 + 【组名】前缀（只有每条 flush 的第一个片段带前缀）。 */
  function splitSegments(title) {
    const out = [];
    let group = '';
    String(title || '').split('；').forEach(function (rawSeg) {
      const seg = rawSeg.trim();
      if (!seg) return;
      const m = /^【([^】]{0,24})】/.exec(seg);
      let text = seg;
      if (m) { group = m[1]; text = seg.slice(m[0].length).trim(); }
      out.push({ group: group, text: text, raw: seg });
    });
    return out;
  }

  // ---- 同步段（【探针】）

  function parseVerifySeg(seg) {
    const t = seg.text;
    let m;

    if (/^题库解析失败/.test(t)) {
      const body = t.replace(/^题库解析失败\s*[:：]\s*/, '');
      const bm = /^([^(（\s]*)\(([\s\S]*)\)\s*$/.exec(body);
      const bankId = bm ? bm[1] : '';
      const msg = bm ? bm[2] : body;
      return [item('题库解析失败', seg.raw, false,
        (bankId ? '题库段 ' + bankId + ' ' : '') + '解析不了：' + msg
        + '（JSON 里有尾逗号 / 全角引号 / 手写转义之类；引擎读不进去，题目会整段消失，而其它项看起来还"正常"）')];
    }
    if ((m = /^题库条目\s*=\s*(\d+)/.exec(t))) {
      const n = parseInt(m[1], 10);
      return [item('题库条目', seg.raw, n > 0,
        '题库里有 ' + n + ' 个作答点（单题算 1 个，大题按 parts 拆）'
        + (n === 0 ? '——一个都没有：多半是题库没进页面或解析失败，先看「题库解析失败」' : ''))];
    }
    if ((m = /^缺卡\s*=\s*(\d+)\s*(?:\(([^)]*)\))?/.exec(t))) {
      const n = parseInt(m[1], 10), ids = (m[2] || '').trim();
      return [item('缺卡', seg.raw, n === 0,
        n === 0 ? '每道题都有对应卡片（q-<id>）' : n + ' 个作答点找不到题卡：' + ids
          + '（题库里有、页面上没有 → 引擎没渲染出来，或 id 对不上）')];
    }
    if (/^写法容错/.test(t)) {
      const idm = /^写法容错\(([^)]*)\)/.exec(t);
      const unit = /带单位\s*=\s*(对|错)/.exec(t);
      const sci = /科学计数法\s*=\s*(对|错)/.exec(t);
      if (!unit || !sci) return [item('写法容错', seg.raw, null, '格式没认出来，原文见 raw')];
      const ok = unit[1] === '对' && sci[1] === '对';
      return [item('写法容错', seg.raw, ok,
        (idm ? '试的是 ' + idm[1] + '：' : '') + '带单位=' + unit[1] + ' 科学计数法=' + sci[1]
        + (ok ? '' : '（填数题的判分要把带单位和科学计数法都当对，不然用户写得对却判错）'))];
    }
    if ((m = /^自动作答后判错\s*=\s*(\d+)/.exec(t))) {
      const bad = parseInt(m[1], 10);
      const th = /抛错\s*=\s*(\d+)/.exec(t);
      const thrown = th ? parseInt(th[1], 10) : null;
      const ids = (/\(([^)]*)\)/.exec(t) || [])[1] || '';
      const ok = bad === 0 && thrown === 0;
      return [item('自动作答后判错', seg.raw, ok,
        '判错 ' + bad + ' 个' + (ids ? '（' + ids + '）' : '') + '、抛错 ' + (thrown == null ? '?' : thrown) + ' 个'
        + (ok ? '' : '——按题库里的正确答案做的，判错/抛错说明题库与引擎的清分规则不一致'))];
    }
    if (/^作答抛错/.test(t)) {
      return [item('作答抛错', seg.raw, false, t.replace(/^作答抛错\s*/, '自动作答时抛错：'))];
    }
    if ((m = /^顶部进度\s*=\s*([^\s/]+)\s*\/\s*([^\s]*)/.exec(t))) {
      const done = numOrNull(m[1]), total = numOrNull(m[2]);
      const rate = (/正确率\s*=\s*(\S+)/.exec(t) || [])[1] || '';
      const wrong = (/错题\s*=\s*(\S+)/.exec(t) || [])[1] || '';
      if (done == null || total == null) return [item('顶部进度', seg.raw, null, t)];
      return [item('顶部进度', seg.raw, done === total,
        '已作答 ' + done + '/' + total + ' 正确率=' + rate + ' 错题=' + wrong
        + (done === total ? '' : '（全部题目都答过了，顶部应该满；对不上说明计数没跟着题卡走）'))];
    }
    if ((m = /^各关计数\s*=\s*(.*)$/.exec(t))) {
      return [parseLevelCounts(seg, m[1].trim())];
    }
    if ((m = /^结算关卡名\s*=\s*(.*)$/.exec(t))) {
      const v = m[1].trim();
      return [item('结算关卡名', seg.raw, null,
        v ? '结算区用的是这些关卡名：' + v + '（核对有没有取错标题）' : '（空：页面上没推导出关卡名）')];
    }
    if ((m = /^结算评价\s*=\s*(.*)$/.exec(t))) {
      return [item('结算评价', seg.raw, null, m[1].trim() || '（空：没达到"全部达标"，或页面上没有结算区）')];
    }
    if ((m = /^重做后该题\s*=\s*(.*)$/.exec(t))) {
      const v = m[1].trim();
      const ok = /已复位/.test(v);
      return [item('重做后该题', seg.raw, ok, v + (ok ? '' : '（「重做本题」点完，卡片应回到未答状态）'))];
    }
    if ((m = /^脚本错误\s*=\s*(.*)$/.exec(t))) {
      const v = m[1].trim();
      return [item('脚本错误', seg.raw, v === '无', v === '无' ? '无脚本报错' : v)];
    }
    if (/^探针自身抛错/.test(t)) {
      return [item('探针自身抛错', seg.raw, false, '探针自己抛错了，后面的项多半没测到：' + t)];
    }
    return [item('未识别', seg.raw, null, '这条没认出来，原文见 raw')];
  }

  /** 各关计数：判据用**作答点**（从题库段自己算），取不到才退回题卡数近似。 */
  function parseLevelCounts(seg, value) {
    const pairs = value ? value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    const facts = (seg.domFacts && seg.domFacts.levels) || null;
    const byLv = {};
    if (facts) facts.forEach(function (f) { byLv[f.lv] = f; });

    const parts = [];
    let compared = 0, approx = 0;
    const mismatched = [];
    pairs.forEach(function (p) {
      const i = p.indexOf('=');
      const lv = i === -1 ? p : p.slice(0, i).trim();
      const val = i === -1 ? '' : p.slice(i + 1).trim();
      const nm = /^(\d+)\s*\/\s*(\d+)/.exec(val);
      const f = byLv[lv];
      const cards = (f && f.cards >= 0) ? f.cards : null;
      const tail = cards == null ? '' : '；本关 ' + cards + ' 张题卡';
      let extra = '';

      const cnt = nm ? parseInt(nm[2], 10) : null;
      if (nm && f && typeof f.points === 'number') {
        compared++;
        const pts = f.points;
        if (cnt === pts) extra = '（与作答点数 ' + pts + ' 一致' + tail + '）';
        else {
          extra = '（按题库算该关应有 ' + pts + ' 个作答点，对不上' + tail + '）';
          mismatched.push(lv + ': 计数分母 ' + cnt + ' vs 作答点 ' + pts);
        }
      } else if (nm && cards != null) {
        approx++;
        extra = '（按题卡数近似比对：' + cards + ' 张，' + (cnt === cards ? '一致' : '对不上') + '）';
        if (cnt !== cards) mismatched.push(lv + ': 计数分母 ' + cnt + ' vs 题卡 ' + cards);
      }
      parts.push(lv + '=' + val + extra);
    });

    let ok = null;
    if (compared > 0 || approx > 0) ok = mismatched.length === 0;
    return item('各关计数', seg.raw, ok,
      (parts.join('，') || '（空）')
      + (compared === 0 && approx === 0 ? '（没能和页面上的数对上，需人工核对）' : '')
      + (approx > 0 ? '［有 ' + approx + ' 关是拿题卡数近似比的］' : ''));
  }

  /** 顶栏总数 vs 题库作答点数（防"题库渲染两遍"）。 */
  function barTotalItem(facts) {
    if (!facts || facts.error) return null;
    const raw = facts.total;
    if (raw == null) return item('顶栏总数', '', null, '页面上没有 #s-total（没有顶部进度条？）');
    const n = numOrNull(raw);
    const pts = (typeof facts.totalPoints === 'number') ? facts.totalPoints : null;
    const raws = '顶栏 s-total=' + raw + '；题库作答点合计=' + (pts == null ? '?' : pts);
    if (n == null || pts == null) {
      return item('顶栏总数', raws, null, '读不出可比对的数字（题库段可能没解析成功）');
    }
    return item('顶栏总数', raws, n === pts,
      n === pts ? ('顶栏 ' + n + ' = 题库作答点数 ' + pts)
        : ('顶栏 ' + n + ' vs 题库 ' + pts + '（页面可能把题库渲染了两遍）'));
  }

  // ---- 异步段（【异步·查了N次】）

  function parseAsyncSeg(seg) {
    const t = seg.text;
    const items = [];
    const tries = (/查了\s*(\d+)\s*次/.exec(t) || [])[1];

    const pol = /陪练形象\s*=\s*([\s\S]*?)(?=\s+背景启用\s*=|\s*$)/.exec(t);
    const bg = /背景启用\s*=\s*([\s\S]*?)(?=\s+异步脚本错误\s*=|\s*$)/.exec(t);
    const err = /异步脚本错误\s*=\s*([\s\S]*)$/.exec(t);

    if (pol) {
      const v = pol[1].trim();
      items.push(item('陪练形象', seg.raw, null,
        v + '（同目录没图、也没选内置大肥鱼时就该是"无"；有图/选了内置大肥鱼就该显示）'
        + (tries ? ' 轮询 ' + tries + ' 次' : '')));
    }
    if (bg) items.push(item('背景启用', seg.raw, null, bg[1].trim()));
    if (err) {
      const v = err[1].trim();
      items.push(item('异步脚本错误', seg.raw, v === '无', v === '无' ? '无脚本报错' : v));
    }
    if (!items.length) items.push(item('未识别', seg.raw, null, '这条没认出来，原文见 raw'));
    return items;
  }

  // ---- 演示探针段（【演示探针】）

  function parseDemoSeg(seg) {
    const t = seg.text;
    let m;
    if ((m = /^演示台\s*=\s*(\d+)/.exec(t))) {
      const n = parseInt(m[1], 10);
      return [item('演示台', seg.raw, null, '页面里有 ' + n + ' 个演示台' + (n === 0 ? '（没有演示就不用查滑块读数与 SVG 越界）' : ''))];
    }
    if ((m = /^——\s*(\S*)\s*[：:]\s*滑块\s*(\d+)\s*个/.exec(t))) {
      return [item('演示台滑块', seg.raw, null, m[1] + '：' + m[2] + ' 个滑块')];
    }
    if ((m = /^滑块\s*(\d+)\s*(?:\(([^)]*)\))?\s*([\s\S]*)$/.exec(t))) {
      return [item('滑块读数', seg.raw, null,
        (m[2] ? '滑块' + m[1] + '(' + m[2] + ') ' : '滑块' + m[1] + ' ') + m[3].trim()
        + '——读数要拿公式手算核对')];
    }
    if ((m = /^SVG 越界元素\s*=\s*(\d+)/.exec(t))) {
      const n = parseInt(m[1], 10);
      const ids = (/\(([^)]*)\)/.exec(t) || [])[1] || '';
      return [item('SVG 越界元素', seg.raw, n === 0,
        n === 0 ? '没有元素越出 viewBox' : n + ' 个超界：' + ids + '（标签/箭头被裁掉了）')];
    }
    if (/^演示探针自身抛错/.test(t)) {
      return [item('演示探针自身抛错', seg.raw, false, t)];
    }
    return [item('未识别', seg.raw, null, '这条没认出来，原文见 raw')];
  }

  // ---- 陪练探针段（【陪练·…】）

  function evalPetLine(line) {
    if (/（异常）/.test(line)) return false;

    if (/^等了\d+轮/.test(line)) {
      if (/已显示|（期望如此）/.test(line)) return true;
      return null;
    }
    if (/^跟随模式/.test(line)) {
      const m = /位移=(-?\d+(?:\.\d+)?)px\/上(-?\d+(?:\.\d+)?)px/.exec(line);
      if (m) return Math.abs(parseFloat(m[1])) > 0 || Math.abs(parseFloat(m[2])) > 0;
      return null;
    }
    if (/^开关是否被隐藏=/.test(line)) return /^开关是否被隐藏=是/.test(line);
    if (/^藏起来后形象=/.test(line)) return /已隐藏/.test(line) ? true : (/还显示/.test(line) ? false : null);
    if (/^点开关召回=/.test(line)) return /回来了/.test(line) ? true : (/没回来/.test(line) ? false : null);
    if (/^右键菜单=/.test(line)) return /弹出/.test(line) ? true : (/没弹出/.test(line) ? false : null);
    if (/^调试接口=/.test(line)) return /^调试接口=有/.test(line) ? true : (/没有/.test(line) ? false : null);
    if (/^点开关后气泡=/.test(line)) return /冒了/.test(line) ? true : (/没冒/.test(line) ? false : null);
    if (/^单击冒泡=/.test(line)) return /单击冒泡=是/.test(line) ? true : (/单击冒泡=否/.test(line) ? false : null);
    if (/^打开后开关=/.test(line)) return /形象=显示/.test(line) ? true : (/形象=不显示/.test(line) ? false : null);
    if (/^点「用内置的大肥鱼」/.test(line)) return /形象=显示/.test(line) ? true : (/形象=不显示/.test(line) ? false : null);
    if (/^切内置大肥鱼：/.test(line)) return (/kind-fish=true/.test(line) && !/不显示/.test(line));
    if (/^切回我放的图片：/.test(line)) return /kind-image=true/.test(line) ? true : (/kind-image=false/.test(line) ? false : null);
    if (/^拖动：位移=/.test(line)) return /存盘=有/.test(line) ? true : (/存盘=无/.test(line) ? false : null);
    if (/^内置形象拖动位移=/.test(line)) {
      return /松手后 moving=false/.test(line) ? (/存盘=有/.test(line)) : false;
    }
    if (/^拖动中 侧面图可见=/.test(line)) return /可见=是/.test(line) ? true : (/可见=否/.test(line) ? false : null);
    if (/^点「大」后/.test(line)) return /--petk=1\.25/.test(line) ? true : (/\(空/.test(line) ? false : null);
    if (/^点「回到右下角」/.test(line)) return /存盘位置=已清/.test(line) ? true : (/存盘位置=仍在/.test(line) ? false : null);
    if (/^陪练块不完整/.test(line)) return null;

    const re = /([^\s（]+)\s*=\s*([^\s（]+)\s*（要 ([^）]+)）/g;
    let mm, any = false, all = true;
    while ((mm = re.exec(line))) {
      any = true;
      const got = mm[2], want = mm[3].trim();
      let r;
      if (want === '>0') { const n = parseFloat(got); r = isFinite(n) ? n > 0 : null; }
      else if (want === 'true' || want === 'false' || want === 'none') r = (got === want);
      else {
        const a = numOrNull(got), b = numOrNull(want);
        r = (a != null && b != null && /^-?\d/.test(want)) ? a === b : (got === want);
      }
      if (r !== true) all = false;
    }
    return any ? all : null;
  }

  function petLead(line) {
    const m = /^([^=：:（\s]{1,14})/.exec(line);
    return m ? m[1] : line.slice(0, 12);
  }

  function parsePetSeg(seg) {
    const head = (seg.group ? '【' + seg.group + '】' : '') + petLead(seg.text);
    const note = /^陪练块不完整/.test(seg.text)
      ? head + ' · 页面可以整块不要陪练，缺块本身不算错；要看的是同一组里的「题库段/题卡/结算条」有没有被连累'
      : head;
    return [item('陪练探针', seg.raw, evalPetLine(seg.text), note)];
  }

  // ---- 组装

  function parseTitle(title, markers, domFacts) {
    const mk = markers || {};
    const segs = splitSegments(title);
    const items = [];

    segs.forEach(function (seg) {
      seg.domFacts = domFacts || null;
      if (/^异步/.test(seg.group)) items.push.apply(items, parseAsyncSeg(seg));
      else if (seg.group.indexOf('演示探针') !== -1) items.push.apply(items, parseDemoSeg(seg));
      else if (seg.group.indexOf('陪练') !== -1) items.push.apply(items, parsePetSeg(seg));
      else items.push.apply(items, parseVerifySeg(seg));
    });

    const bar = barTotalItem(domFacts);
    if (bar) {
      let at = -1;
      items.forEach(function (it, i) { if (it.key === '顶部进度') at = i; });
      if (at === -1) items.push(bar); else items.splice(at + 1, 0, bar);
    }

    const have = {};
    items.forEach(function (it) { have[it.key] = true; });
    const required = [];
    if (mk.sync) required.push('题库条目', '缺卡', '自动作答后判错', '脚本错误');
    if (mk.async) required.push('异步脚本错误');
    if (mk.demo) required.push('演示台', 'SVG 越界元素');
    if (mk.pet) required.push('陪练探针');
    required.forEach(function (k) {
      if (!have[k]) {
        items.push(item(k, '', null,
          '探针没有报出这一项 —— 可能页面结构里没有对应元素，也可能探针中途抛错（看「探针自身抛错」）。'));
      }
    });

    return items;
  }

  /** C++ 交回的原始数据 → result 视图与 repairRound 认的 report。 */
  function buildReport(raw) {
    raw = raw || {};
    const items = parseTitle(raw.title || '', raw.markers || {}, raw.domFacts || null);

    if (raw.timedOut) {
      items.unshift(item('探针未跑完', raw.title || '', false,
        '等了超过超时时间，title 还没出现完整标记；下面报告基于超时那一刻的 title，'
        + '异步项（陪练形象/背景）多半还没定性。'));
    }
    if (raw.cancelled) {
      items.unshift(item('校验被中断', raw.title || '', null,
        '应用正在退出，这次校验被就地结束了。下面这些项是基于中断那一刻的页面状态算出来的，'
        + '**不是**一份完整结果，别拿它下结论。'));
    }
    const warns = Array.isArray(raw.warnings) ? raw.warnings.filter(function (w) { return !!w; }) : [];
    if (warns.length) {
      items.push(item('校验环境告警', '', null, warns.join('\n')));
    }
    if (!items.length) {
      items.push(item('探针未产出结果', '', false,
        'title 里没有探针输出（title=' + JSON.stringify(raw.title || '') + '）——'
        + '页面可能根本没跑到探针，或探针整段没执行。'));
    }
    const probeErrs = Array.isArray(raw.probeErrs) ? raw.probeErrs : [];
    const alreadyFlagged = items.some(function (it) {
      return (it.key === '脚本错误' || it.key === '异步脚本错误') && it.ok === false;
    });
    if (probeErrs.length && !alreadyFlagged) {
      items.push(item('脚本错误', 'window.__PROBE_ERRS__ = ' + JSON.stringify(probeErrs), false,
        '探针收尾后页面里累计的脚本报错：' + probeErrs.join(' | ')));
    }

    const mk = raw.markers || {};
    if (mk.pet) {
      const HINT = '\n（注意：本次同时注入了陪练探针，它会点「用内置的大肥鱼」、切形象模式，改掉页面状态；'
        + '这一项读到的可能是被探针改过之后的样子。想判"页面本来有没有图/背景"，请只跑 verify 探针。）';
      items.forEach(function (it) {
        if (it.key === '陪练形象' || it.key === '背景启用') it.note += HINT;
      });
    }

    const ok = items.length ? items.every(function (it) { return it.ok !== false; }) : null;
    return {
      title: raw.title || '',
      items: items,
      consoleErrors: Array.isArray(raw.consoleErrors)
        ? raw.consoleErrors.slice(0, 50).map(function (s) { return String(s).slice(0, 500); })
        : [],
      durationMs: Number(raw.durationMs) || 0,
      ok: ok,
      warnings: warns
    };
  }

  // ---- demo 读数核对（0.5% 相对容差，逐条照抄 oracle demo-checks.js） ----

  function near(a, b) {
    if (!isFinite(a) || !isFinite(b)) return false;
    if (Math.abs(a - b) <= 1e-12) return true;
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return Math.abs(a - b) / scale <= 0.005;
  }

  function pickNumber(text) {
    if (text == null) return null;
    const s = String(text).replace(/[，,]/g, '').trim();
    if (!s || s === '—' || s === '-') return null;
    const m = s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return isFinite(n) ? n : null;
  }

  function sameValue(got, want) {
    const g = String(got == null ? '' : got).trim();
    const w = String(want == null ? '' : want).trim();
    if (g === w) return true;
    const gn = pickNumber(g);
    const wn = pickNumber(w);
    if (gn != null && wn != null) return near(gn, wn);
    return false;
  }

  function buildDemoResult(raw, demos) {
    const list = (demos || []).filter(function (d) { return d && Array.isArray(d.checks) && d.checks.length; });
    if (!list.length) {
      return { ok: null, label: '演示读数与公式是否自洽',
               note: '这次没有可核对的 checks（模型没给或没有演示）', groups: [] };
    }
    const groups = Array.isArray(raw && raw.groups) ? raw.groups : [];
    const problems = [];
    const allGroups = [];
    if (raw && raw.timedOut) {
      return {
        ok: false,
        label: '演示读数与公式是否自洽（模型手算 vs 页面实算）',
        note: '演示核对超时：没有把所有演示跑完，不能当成"全部通过"',
        groups: groups
      };
    }
    /* C++ 逐个 demo 执行时已经把 demo id 丢了（只回 groups）——按顺序对上。 */
    groups.forEach(function (g, i) {
      /* 宿主会在每个 group 上挂 `demo`（一个演示可能有多组 checks）；
         老形态没有它时才按顺序退回到第 i 个演示。 */
      const demo = (g && g.demo) ? { id: g.demo } : (list[Math.min(i, list.length - 1)] || {});
      allGroups.push(Object.assign({ demo: demo.id }, g));
      (g.misses || []).forEach(function (miss) {
        problems.push(demo.id + ' 第 ' + ((g.index || 0) + 1) + ' 组：' + miss);
      });
      (g.read || []).forEach(function (r) {
        if (!sameValue(r.got, r.want)) {
          problems.push(demo.id + ' 第 ' + ((g.index || 0) + 1) + ' 组：#' + r.id
            + ' 实际「' + r.got + '」vs 模型手算「' + r.want + '」');
        }
      });
    });
    const total = allGroups.reduce(function (n, g) { return n + ((g.read || []).length); }, 0);
    if (!total) {
      return { ok: false, label: '演示读数与公式是否自洽',
               note: '一条读数都没读到，checks 里的元素 id 可能写错了：' + problems.slice(0, 3).join('；'),
               groups: allGroups };
    }
    return {
      ok: problems.length === 0,
      label: '演示读数与公式是否自洽（模型手算 vs 页面实算）',
      note: problems.length
        ? problems.length + ' 处对不上：' + problems.slice(0, 4).join('；') + (problems.length > 4 ? ' …' : '')
        : '核对了 ' + total + ' 个读数，全部与模型给的公式值一致',
      groups: allGroups
    };
  }

  const api = {
    LABELS: LABELS,
    item: item,
    numOrNull: numOrNull,
    splitSegments: splitSegments,
    parseTitle: parseTitle,
    buildReport: buildReport,
    near: near,
    pickNumber: pickNumber,
    sameValue: sameValue,
    buildDemoResult: buildDemoResult
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.__isgProbeParse = api;
})(typeof window !== 'undefined' ? window : this);
