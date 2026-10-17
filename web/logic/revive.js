'use strict';
/* 反推：把一份**已经生成好的单文件学习页 HTML** 还原成结构化数据。
 *
 * 为什么需要它：用户想把「以前生成的页面」跟新生成的一章**合成一册**。
 *   · 本应用自己生成的页面 → 从现在起会把结构化数据落盘，走那条路是准的；
 *   · 别人传给他的、或本功能上线前生成的 HTML → 只有成品文件，只能从 HTML 反推。
 * 产物格式是我们自己定的（page-skeleton.html 经 assemble.js 替换），所以反推可行。
 *
 * ⚠️ **反推的成功标准不是"能拼出一份 JSON"，而是"对不上时必须报出来"。**
 * 一份安静生成出来的错结构，用户几周后才会发现（拿到一册串了单元的复习书），
 * 那时已经无从追查是哪一步错的。所以返回值里 problems 与 data 同等重要：
 * 每一条对不上都要带"具体是哪个单元 / 哪个 id"与"建议怎么办"。
 * `ok:false` 时 data 一律为 null —— 宁可让调用方拿到"什么都没有"，
 * 也不能让它拿到一份"看起来是好的"错结构（需求里最硬的一条）。
 *
 * ── 反推**做不到**的三件事（写在这里，免得下游以为拿到了完整原稿）──
 *   1. 单元导语 vs 正文里的第一个 <p class="lede">：
 *      assemble 把 u.lede 单独渲染成 <p class="lede"> 放在 <h2> 后面；如果模型自己写的
 *      正文第一句正好也是 <p class="lede">…</p>，两者在成品页里长得**一模一样**，无从区分。
 *      （症状：合并后那一段会重复一次。）概率低，但确实是反推的分辨率上限。
 *   2. 演示的 markup 原本挂在正文的哪一处：占位注释 <!--DEMO:id--> 会被 assemble **就地替换**，
 *      替换后的 DOM 与"模型自己写在正文里的演示 DOM"在成品页里同样无从区分。
 *      本模块的策略是：**DOM 留在 lectureHtml 里不动**，这类演示的 markup 记成空串，
 *      只把 JS 收进 demos[]。位置不变、内容不丢；抠出来反而再也不知道该塞回哪一行。
 *   3. 模型原始输出的原文：id 已经是命名空间化过的（`u1-q1`）、`lv` 是我们写进去的、
 *      选项已被规范化过。反推拿到的是**规范化之后**的题库；重新拼装时会再规范化一次，
 *      id 会变成 `u1-u1-q1`。存盘键跟着变（见 references/pitfalls.md「id 即存盘键」）。
 *      需要保持存盘键不变的下游，请看 data.注。
 *
 * 纯函数：不碰网络、不碰 Electron、不碰文件系统，可以用 node runner 直接测。
 */

const { countPoints } = require('./bank');

/* ------------------------------------------------------------------ *
 * 锚点：与 assemble.js 的 MARK 是同一批字面量
 * ⚠️ 这里的匹配一律**对空白宽容**（行尾 \r?、缩进任意、标签间可有空白）：
 *    成品页是用户手里的文件，过一遍邮件/网盘/编辑器之后行尾与缩进都可能变。
 *    但"宽容"只用在空白上，**属性值一个字都不许含糊**——含糊处正是结构串行的高发区，
 *    所以凡是结构对不上，宁可报出来也不猜。
 * ------------------------------------------------------------------ */
const RE = {
  /** 正文区起点：骨架里的那句注释。注意它在**成品页里已经被 assemble 吃掉了**（见下）。 */
  contentStartComment: /<!--\s*讲：知识块写在这里[\s\S]*?-->/,
  /** 正文区终点：结算区。 */
  contentEnd: /<section id="result">/,
  /** 成品页真正的"正文开始"证据：目录卡（assemble 每次都生成它）。 */
  howtoCard: /<div class="card" id="howto">/,
  mainOpen: /<main>/,
  /** 讲解小节的开始：<section id="…"> 后面紧跟 <h2><span class="num">…。
   *  两个条件一起用是有原因的：正文是模型写的，理论上可能自己带一个
   *  <section id="x">；但"下一行就是 <h2><span class="num">"这个组合只有 assemble 会写。 */
  lectureOpen: /^[ \t]*<section id="([^"]+)">[ \t]*\r?\n[ \t]*<h2><span class="num">/gm,
  /** 题区：一个单元一个，id 是 p-l<单元序号>。 */
  qsec: /<section class="qsec" id="p-l(\d+)">/g,
  /** 题库段：一段一个单元。JSON 里的 `<` 已被转义成 <，所以段内不会出现 </script>。 */
  bankSeg: /<script data-bank id="([^"]*)" type="application\/json">([\s\S]*?)<\/script>/g,
  engineOpen: /<script id="engine">/,
  /** 演示槽：从注释到"收尾"注释之间。 */
  demoSlot: /\/\* =+ 章专用演示：把本章的演示 IIFE 放在这里 =+/,
  demoSlotEnd: /\/\* -+ 收尾 -+ \*\//,
  /** 引擎之前的"预置大肥鱼"脚本（只有 pet:'fish' 才会被塞进去）。 */
  fishSeed: /工作台生成时默认选用内置「大肥鱼」形象/,
  /** assemble 给交付页注入的 CSP：**它是"这页确实出自拼装器"最便宜的一条证据**。 */
  cspMeta: /<meta http-equiv="Content-Security-Policy"/,
};
/* 演示槽里的每一条演示。标题与"由工作台…"后缀都是 assemble 写的固定形状。
   ⚠️ 每处用到都要 new 一个新的 RegExp：带 /g 的正则对象是有状态的（lastIndex），
   共享一个实例会让第二次调用从上次的位置继续扫，症状是"第一次解析对、第二次少几条"。 */
const demoEntryRe = () =>
  /^[ \t]*\/\* (.+?) —— 由工作台(校验|补上兜底 try\/catch 的演示) \*\/[ \t]*\r?$/gm;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** assemble 的 escapeHtml 的逆。只认它真正会产出的那几个实体，认不出的原样留着。 */
function unescapeHtml(s) {
  return String(s == null ? '' : s).replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    if (name.charAt(0) === '#') {
      const n = name.charAt(1) === 'x' || name.charAt(1) === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      try { return String.fromCodePoint(n); } catch (e) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, name) ? ENT[name] : m;
  });
}

function offsetToLine(text, off) {
  let n = 0;
  for (let i = 0; i < off && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * 去掉 assemble 的 indent(html, 4)：每行最多去掉 4 个前导空格。
 *
 * ⚠️ skipLines 里的行必须原样保留。症状说明为什么：演示的 DOM 是**占位注释替换**塞进正文的
 * （替换发生在 indent() 之后），它的续行缩进是模型自己写的、没有被 +4 过；
 * 跟着一起减 4 会把 `<div class="demo-h">` 这种两格缩进减成顶格，
 * 反推出来的 lectureHtml 就跟原文不一样了（`<pre>` 里还会真的改变显示）。
 */
function dedentLines(text, skipLines) {
  const skip = skipLines || null;
  return String(text)
    .split('\n')
    .map((line, i) => {
      if (!line.trim() || (skip && skip.has(i))) return line;
      let k = 0;
      while (k < 4 && (line.charAt(k) === ' ' || line.charAt(k) === '\t')) k++;
      return line.slice(k);
    })
    .join('\n');
}

/**
 * 反推出来的正文一律用 `\n`，**不受原文件行尾影响**。
 *
 * 为什么不是原样保留：成品页的行尾常常不是拼装器写的那样——用户用记事本"另存为"过一次，
 * 整份文件就变成 CRLF，模型写的正文里于是多出一堆 `\r`。
 * 那种 `\r` 只是 HTML 里的空白、不影响显示（HTML 解析器本来就会把 CRLF 归一成 LF），
 * 但会让"同一份页面在改行尾前后反推出两个不同的结构"，
 * 于是 diff 里全是噪音、也没法断言往返一致。剥掉它，往返就与行尾无关。
 *
 * ⚠️ 只对 **HTML 文本**（讲解正文、演示 markup）用，**不要用在演示的 JS 上**：
 * JS 里的 `\r\n` 在模板字符串里是有意义的内容，归一化就等于偷偷改了程序。
 */
function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

/** 去掉首尾的空行（保留行内的缩进形态）。 */
function trimBlankLines(s) {
  const lines = String(s).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

/**
 * 在 html 里找出所有 `<div class="demo" …>…</div>`（按 div 配对，支持嵌套）。
 *
 * 为什么不用正则截取：演示的 DOM 是自己带闭合标签的一整块，正则数不了嵌套，
 * 遇到 `<div class="demo"><div class="row"><div>…` 会提前收尾，症状是 markup 被截半、
 * 后半截留在 lectureHtml 里变成"谁也管不着的野 DOM"。
 */
function findDemoDivs(html) {
  const out = [];
  const tagRe = /<div\b[^>]*>|<\/div\s*>/g;
  const stack = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const t = m[0];
    if (t.charAt(1) === '/') {
      const open = stack.pop();
      if (open && open.isDemo) out.push({ start: open.at, end: m.index + t.length, id: open.id });
    } else {
      const c = /\bclass\s*=\s*"([^"]*)"/.exec(t) || /\bclass\s*=\s*'([^']*)'/.exec(t);
      const idm = /\bid\s*=\s*"([^"]*)"/.exec(t) || /\bid\s*=\s*'([^']*)'/.exec(t);
      stack.push({
        at: m.index,
        // 只认整词 demo：class="demo-h" / "demo-body" 不是演示外壳
        isDemo: !!(c && /(^|\s)demo(\s|$)/.test(c[1])),
        id: idm ? idm[1] : '',
      });
    }
  }
  return out;
}

/**
 * 把片段**开头**的 <p class="lede">…</p> 摘下来，返回 {lede, rest}。
 * ⚠️ `^\s*` 里的 `\s*` 不能省：片段是从上一行标签的**后面**切起的，开头是那个换行。
 * 只写 `^[ \t]*` 的话，只有导语正好跟在上一个标签同一行时才能摘到（实测踩到：
 * 导语被当成正文的第一段，于是它既在 lede 里、又在 lectureHtml 里，合并后重复一次）。
 */
function takeLede(fragment) {
  const m = /^\s*<p class="lede">([\s\S]*?)<\/p>[ \t]*\r?\n?/.exec(fragment);
  if (!m) return { lede: null, rest: fragment };
  return { lede: unescapeHtml(m[1]), rest: fragment.slice(m[0].length) };
}

function problem(code, level, message, hint) {
  return { code, level, message, hint: hint || '' };
}

/* ------------------------------------------------------------------ *
 * 第 1 块：页头（章标题 / 学科 / 章号 / 导语 / 页面自称的数字）
 * ------------------------------------------------------------------ */

function parseHeader(h, problems) {
  const head = /<header class="top">([\s\S]*?)<\/header>/.exec(h);
  const titleTag = /<title>([\s\S]*?)<\/title>/.exec(h);
  const out = { found: false, subject: '', no: '', title: '', intro: '', claimed: {} };

  // <title> 的形状是「第 X 章 · <章标题> · 讲练一体」；章号只能从这里或 eyebrow 拿。
  if (titleTag) {
    let t = unescapeHtml(titleTag[1]).replace(/[ \t]*·[ \t]*讲练一体[ \t]*$/, '');
    const m = /^第\s*(.+?)\s*章\s*·\s*([\s\S]*)$/.exec(t);
    if (m) { out.no = m[1].trim(); out.title = m[2].trim(); }
    else { out.title = t.trim(); }
  }

  if (!head) {
    problems.push(problem('header-missing', 'blocker',
      '页头解析不出来：这份文件里找不到 <header class="top">…</header>，章标题、学科、章号都拿不到。',
      '确认这是不是「讲练一体」页面（骨架页一定带这个页头）。若不是，这份文件不能用"从 HTML 反推"这条路，' +
      '请让用户改用手工提供的信息，或重新生成一次。'));
    return out;
  }
  out.found = true;
  const inner = head[1];

  const eye = /<span class="eyebrow">([\s\S]*?)<\/span>/.exec(inner);
  if (eye) {
    const parts = unescapeHtml(eye[1]).split(' · ');
    if (parts.length && parts[parts.length - 1] === '讲练一体') parts.pop();
    for (const p of parts) {
      const m = /^第\s*(.+?)\s*章$/.exec(p);
      if (m) { if (!out.no) out.no = m[1].trim(); }
      else if (!out.subject) out.subject = p.trim();
    }
  }
  const h1 = /<h1>([\s\S]*?)<\/h1>/.exec(inner);
  if (h1) out.title = unescapeHtml(h1[1]).trim();
  const sub = /<p class="sub">([\s\S]*?)<\/p>/.exec(inner);
  if (sub) out.intro = unescapeHtml(sub[1]);

  // 页面自称的数字（页头 facts）：用来交叉核对"题目是不是少了几道"
  const pts = /<b>(\d+)<\/b><span>个作答点<\/span>/.exec(inner);
  const uns = /<b>(\d+)<\/b><span>个单元<\/span>/.exec(inner);
  const dms = /<b>(\d+)<\/b><span>个可拖演示<\/span>/.exec(inner);
  out.claimed = {
    points: pts ? Number(pts[1]) : null,
    units: uns ? Number(uns[1]) : null,
    demos: dms ? Number(dms[1]) : null,
  };
  if (!out.title) {
    problems.push(problem('chapter-title-missing', 'warn',
      '章标题解析不出来（页头里 <h1> 是空的）。合并后这一章在目录里会没有名字。',
      '手工补一个章标题。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 2 块：正文区（目录卡 + 每单元的小节 + 紧跟的题区）
 * ------------------------------------------------------------------ */

function parseBody(h, problems) {
  const out = { regionStart: -1, regionEnd: -1, howtoFound: false, howtoLinks: [], units: [] };

  const endM = RE.contentEnd.exec(h);
  if (!endM) {
    problems.push(problem('content-region-missing', 'blocker',
      '找不到结算区 <section id="result">，无法确定正文的范围。',
      '这份文件不是「讲练一体」页面（或被改坏过）。请让用户确认文件来源。'));
    return out;
  }
  out.regionEnd = endM.index;

  /* 正文区起点：骨架里那句「讲：知识块写在这里」的注释在**成品页里已经被吃掉了**
     （assemble.js 用 bodyParts 整段替换掉了它，注释本身不保留）。所以先找它、
     找不到再退到目录卡、再退到 <main>。第一次读这份代码的人很容易在这里踩空。 */
  const cm = RE.contentStartComment.exec(h);
  if (cm && cm.index < out.regionEnd) {
    out.regionStart = cm.index + cm[0].length;
  } else {
    const hw = RE.howtoCard.exec(h);
    if (hw && hw.index < out.regionEnd) {
      out.regionStart = hw.index;
      out.howtoFound = true;
    } else {
      const mn = RE.mainOpen.exec(h);
      if (mn && mn.index < out.regionEnd) out.regionStart = mn.index + mn[0].length;
    }
  }
  if (out.regionStart < 0) {
    problems.push(problem('content-region-missing', 'blocker',
      '找不到正文区的起点（既没有「讲：知识块写在这里」注释，也没有目录卡 <div class="card" id="howto">）。',
      '这份文件可能不是本工具生成的。请让用户确认它的来源。'));
    return out;
  }
  const region = h.slice(out.regionStart, out.regionEnd);

  // 目录卡：它本身是生成的、不用反推；但它里面那串锚点链接是**免费的一条校验**
  if (!out.howtoFound) {
    problems.push(problem('howto-missing', 'warn',
      '正文里没有「这一页怎么用」的目录卡（<div class="card" id="howto">）。这一块合并后会重新生成，不影响内容；' +
      '但它不见说明这一页**被人手工改过**，其余部分请一并留意。',
      '不用处理；若同时还有别的对不上，优先怀疑这份文件被改过。'));
  } else {
    const card = /<div class="card" id="howto">([\s\S]*?)<\/div>/.exec(region);
    if (card) {
      const aRe = /<a href="#([^"]+)">([\s\S]*?)<\/a>/g;
      let m;
      while ((m = aRe.exec(card[1]))) out.howtoLinks.push({ href: m[1], text: unescapeHtml(m[2]) });
    }
  }

  /* ---- 题区（先找题区，讲解小节靠它定位：题区是每个单元的收尾，位置最稳）---- */
  RE.qsec.lastIndex = 0;
  const qs = [];
  let q;
  while ((q = RE.qsec.exec(region))) qs.push({ at: q.index, atEnd: RE.qsec.lastIndex, lv: Number(q[1]), lid: q[1] });

  if (!qs.length) {
    problems.push(problem('no-units', 'blocker',
      '正文里一个题区（<section class="qsec" id="p-lN">）都没有。',
      '这份文件不是本工具生成的页面，或正文被整体删掉了。请让用户确认来源。'));
    return out;
  }

  RE.lectureOpen.lastIndex = 0;
  const lec = [];
  let L;
  while ((L = RE.lectureOpen.exec(region))) lec.push({ at: L.index, tagEnd: L.index + L[0].length, id: L[1] });

  qs.forEach((qsec, k) => {
    const u = {
      index: k, id: '', num: '', title: '', lede: '', quizLede: '',
      lectureHtml: '', qsecTitle: '', qsecLede: '', lv: qsec.lv, qsecId: 'p-l' + qsec.lid,
    };
    // 讲解小节 = 这个题区之前、上一个题区之后的最后一个讲解小节
    const floor = k > 0 ? qs[k - 1].atEnd : -1;
    let open = null;
    for (const l of lec) if (l.at > floor && l.at < qsec.at) open = l;
    if (!open) {
      problems.push(problem('lecture-missing', 'blocker',
        `第 ${k + 1} 个题区（id="${u.qsecId}"）前面找不到对应的讲解小节（<section id="…"> + <h2><span class="num">）。`,
        '正文结构已经乱了，无法确定这一节讲的是什么、属于哪个单元。请让用户重新生成这一章。'));
      out.units.push(u);
      return;
    }
    u.id = open.id;

    /* 标题行。窗口只开 600 字：再长就不是标题了，而放开到整节会让
       `[\s\S]*?</h2>` 匹配到正文深处偶然出现的 </h2>（正文是模型写的）。 */
    const h2slice = region.slice(open.at, open.tagEnd + 600);
    const h2m = /<h2><span class="num">([\s\S]*?)<\/span>([\s\S]*?)<\/h2>/.exec(h2slice);
    if (h2m) {
      u.num = unescapeHtml(h2m[1]);
      u.title = unescapeHtml(h2m[2]);
    } else {
      problems.push(problem('lecture-h2-unreadable', 'warn',
        `单元 ${k + 1}（section id="${open.id}"）的标题行看不懂（不是 <h2><span class="num">…</span>…</h2> 的形状）。`,
        '合并后这一节的编号与标题会是空的，需要手工补。'));
    }

    const closeAt = region.lastIndexOf('</section>', qsec.at);
    const bodyStart = h2m ? open.at + h2m.index + h2m[0].length : open.tagEnd;
    if (closeAt < 0 || closeAt < bodyStart) {
      problems.push(problem('lecture-unclosed', 'blocker',
        `单元 ${k + 1}（section id="${open.id}"）的 </section> 找不到，讲解正文的范围无法确定。`,
        '这份文件被改坏了。请让用户重新生成这一章。'));
      out.units.push(u);
      return;
    }
    let inner = region.slice(bodyStart, closeAt);
    const first = takeLede(inner);
    if (first.lede !== null) { u.lede = first.lede; inner = first.rest; }

    // 正文里的演示 DOM：它们没有经过 indent()，去缩进时要跳过这几行（见 dedentLines）
    const demoRanges = findDemoDivs(inner).map((d) => [d.start, d.end]);
    const skip = new Set();
    for (const [a, b] of demoRanges) {
      const la = offsetToLine(inner, a);
      const lb = offsetToLine(inner, b);
      for (let i = la; i <= lb; i++) skip.add(i);
    }
    /* ⚠️ 顺序：先归一 EOL，再去缩进。
       反过来的话（先去缩进再归一），行尾的 `\r` 会被当成行内容的一部分，
       于是"最后那行只有缩进的空行"判不出是空行、去不掉，
       归一之后它就变成一个多余的行尾换行——症状是同一份页面在 CRLF 与 LF 下
       反推出两个不一样的 lectureHtml，diff 里全是噪音。 */
    u.lectureHtml = trimBlankLines(dedentLines(normalizeEol(inner), skip));

    /* ---- 题区 ---- */
    /* 题区窗口要开得足够大：题区导语（quizLede）是模型写的一整段话，
       窗口窄了会在中间截断，导语就被读成半句（⚠️ 实测 900 字会截到，改 4000）。 */
    const qTail = region.slice(qsec.atEnd, qsec.atEnd + 4000);
    const qh = /<h2><span class="num">([\s\S]*?)<\/span>([\s\S]*?)<span class="cnt" data-cnt="(\d+)"><\/span><\/h2>/.exec(qTail);
    if (qh) {
      u.qsecTitle = unescapeHtml(qh[2]);
      u.cntIndex = Number(qh[3]);
    } else {
      u.cntIndex = null;
      problems.push(problem('qsec-h2-unreadable', 'warn',
        `单元 ${k + 1} 的题区标题行看不懂（不是 <h2><span class="num">练</span>…<span class="cnt" data-cnt="N"></span></h2> 的形状）。` +
        '题区标题会决定结算区里那一关叫什么，拿不到就只能用讲解标题兜底。',
        '手工确认一下这一节的"练一练"标题；其余内容不受影响。'));
    }
    /* ⚠️ 要从 `qh.index + qh[0].length` 切，不能只按长度切：h2 前面有缩进与换行，
       按长度切会从 h2 的**中间**开始，导语就永远摘不到（症状：每个单元的题区导语都读成空，
       还反过来报"讲解有导语、题区没有"，把人往"文件被改过"上引）。 */
    const ql = takeLede(qTail.slice(qh ? qh.index + qh[0].length : 0));
    if (ql.lede !== null) u.qsecLede = ql.lede;
    const lv = /<div class="qlist" data-lv="(\d+)">/.exec(qTail);
    u.dataLv = lv ? Number(lv[1]) : null;
    // 题区与讲解之间那一段：assemble 会把"占位注释没写进正文"的演示挂在这里
    u.gap = region.slice(closeAt + '</section>'.length, qsec.at);
    out.units.push(u);
  });

  // 最后一个题区之后还有讲解小节 → 多出来的一节，合并时会丢
  const lastQ = qs[qs.length - 1];
  const extra = lec.filter((l) => l.at > lastQ.at);
  if (extra.length) {
    problems.push(problem('lecture-after-last-qsec', 'warn',
      `最后一个题区之后还有 ${extra.length} 个讲解小节（id：${extra.map((e) => e.id).join('、')}），` +
      '它们没有配套的题区。',
      '这些小节的内容合并后会**丢掉**（结构里每个单元都必须带一段题库）。要保住就先把它们并进相邻单元。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 3 块：题库段（一段一个单元，段内是扁平数组）
 * ------------------------------------------------------------------ */

function parseBanks(h, problems) {
  const segs = [];
  const re = new RegExp(RE.bankSeg.source, 'g');
  let m;
  while ((m = re.exec(h))) segs.push({ id: m[1], text: m[2], index: segs.length });
  if (!segs.length) {
    problems.push(problem('no-banks', 'blocker',
      '一个题库段（<script data-bank …>）都没有。题目全部丢失，反推没有意义。',
      '这份文件不是本工具生成的页面，或题库段被整体删掉了。请让用户确认来源。'));
    return segs;
  }
  segs.forEach((s, i) => {
    const want = 'bank' + i;
    s.indexOk = s.id === want;
    try {
      s.items = JSON.parse(s.text);
    } catch (e) {
      s.items = null;
      s.error = e.message;
      problems.push(problem('bank-json-invalid', 'blocker',
        `题库段 ${i + 1}（id="${s.id}"）的 JSON 解析失败：${e.message}。` +
        (s.id !== want ? `（顺带一提，它的 id 应该是 "${want}"）` : '') +
        ' ⚠️ 这正是引擎会**静默吞掉**整段题库的那种坏法：页面上那几道题凭空消失，而页面不报任何错。',
        '这一段必须修好才能用。若只是想看其余单元，请让用户先把那一段的 JSON 补完整（多半是最后一个逗号或漏了引号）。'));
    }
  });
  return segs;
}

/* ------------------------------------------------------------------ *
 * 第 4 块：引擎区间的 PAGE 配置（pageKey / finalAdvice / pet）
 * ------------------------------------------------------------------ */

function parseEngine(h, problems) {
  const out = { found: false, pageKey: '', finalAdvice: '', pet: '', petImagesFound: false, bgEmpty: null };
  const open = RE.engineOpen.exec(h);
  if (!open) {
    problems.push(problem('engine-missing', 'blocker',
      '找不到引擎脚本 <script id="engine">。没有它就等于没有页面的存档键（PAGE.key），' +
      '合并后这一章的作答记录会跟别的章串在一起。',
      '这份文件不是本工具生成的页面。请让用户确认来源，或重新生成这一章。'));
    return out;
  }
  const bodyEnd = h.indexOf('</body>', open.index);
  if (bodyEnd < 0) {
    problems.push(problem('engine-unclosed', 'blocker',
      '引擎脚本之后找不到 </body>，页面结构不完整。',
      '这份文件被截断或被改坏了，请让用户重新生成这一章。'));
    return out;
  }
  out.found = true;
  const eng = h.slice(open.index, bodyEnd);

  /* PAGE 配置块：用 `var PAGE={` … 第一个 `};` 夹出来，而不是在整个引擎里搜。
     整个引擎里搜会被**注入进去的 finalAdvice** 骗到：收尾语里只要出现一次
     `key:'…'` 的字面量（比如在讲"存盘键是怎么配的"），就会命中错的那处，
     症状是 pageKey 反推成了收尾语里的例子，而且一声不响。 */
  const pi = eng.indexOf('var PAGE={');
  if (pi < 0) {
    problems.push(problem('page-block-missing', 'blocker',
      '引擎里找不到 PAGE 配置块（var PAGE={…}）。',
      '骨架页被改过，或这不是本工具生成的页面。请让用户确认来源。'));
    return out;
  }
  const pj = eng.indexOf('};', pi);
  const page = pj < 0 ? eng.slice(pi, pi + 4000) : eng.slice(pi, pj + 2);

  const km = /\bkey\s*:\s*'([^']*)'/.exec(page);
  if (!km) {
    problems.push(problem('pagekey-missing', 'blocker',
      'PAGE 配置里没有 key（存盘键）。没有它就无法保证合并后这一章的作答记录不跟别的章串。',
      '这份页面的引擎被改过。请让用户重新生成这一章，或手工指定一个存盘键。'));
    return out;
  }
  out.pageKey = km[1];

  /* finalAdvice 只从 key 之后的文本里找：注入的收尾语在它后面，见上面那段说明。
     ⚠️ 必须同时认单引号与双引号两种字面量：
       · 有收尾语时 assemble 写的是 JSON 字符串 → finalAdvice:"…"（双引号）；
       · **没有收尾语时它压根不替换这一行**，骨架原文的 finalAdvice:'' 会原样留着（单引号）。
         只认双引号的话，"没写收尾语"这个再普通不过的情况会被判成"引擎配置解析不出来"，
         整份页面直接不能用——实测踩到过。 */
  const fam = /\bfinalAdvice\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(page.slice(km.index));
  if (!fam) {
    problems.push(problem('finaladvice-unreadable', 'blocker',
      'PAGE.finalAdvice 解析不出来（既不是 finalAdvice:"…" 也不是 finalAdvice:\'\'）。',
      '这份页面的引擎被改过。请让用户手工补一句收尾语（留空也行），或重新生成这一章。'));
  } else if (fam[1].charAt(0) === '"') {
    try { out.finalAdvice = JSON.parse(fam[1]); }
    catch (e) {
      problems.push(problem('finaladvice-unreadable', 'blocker',
        'PAGE.finalAdvice 是一个坏掉的 JSON 字符串：' + e.message,
        '请让用户重新生成这一章。'));
    }
  } else {
    // 骨架里那个没被填过的空串（也兼容手工写进去的单引号字符串）
    out.finalAdvice = fam[1].slice(1, -1).replace(/\\(['\\])/g, '$1');
  }

  const pm = /\bpetImages\s*:\s*\[([^\]]*)\]/.exec(page);
  const bm = /\bbgImages\s*:\s*\[([^\]]*)\]/.exec(page);
  if (!pm || !bm) {
    problems.push(problem('pet-config-missing', 'blocker',
      'PAGE 配置里找不到 petImages / bgImages（陪练形象的候选图片名），无法判断原来选的陪练方式。',
      '这份页面的引擎被改过。请让用户手工指明陪练方式（不要陪练 / 内置大肥鱼 / 同目录图片）。'));
    return out;
  }
  out.petImagesFound = true;
  const petEmpty = !pm[1].trim();
  const bgEmpty = !bm[1].trim();
  const seed = RE.fishSeed.test(h.slice(0, open.index));

  if (seed && petEmpty) {
    problems.push(problem('pet-ambiguous', 'warn',
      '这一页同时有"预置大肥鱼"脚本、又把 petImages 清空了，两个证据互相矛盾（正常生成不会这样）。' +
      '已按"内置大肥鱼"处理。',
      '照原样合并即可；若原来选的是"不要陪练"，合并后右下角会多出一个陪练，届时在页面上关掉就行。'));
    out.pet = 'fish';
  } else if (seed) out.pet = 'fish';
  else if (petEmpty) out.pet = 'none';
  else out.pet = 'image';

  if (out.pet !== 'none' && bgEmpty) {
    problems.push(problem('bg-images-empty', 'warn',
      'petImages 有内容但 bgImages 是空的：页面背景图会退回用头像那张铺开。',
      '这是引擎的正常兜底（留空 bgImages 就等于"拿头像铺背景"），不用处理。'));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 第 5 块：演示（演示槽里的 JS + 正文里的 DOM）
 * ------------------------------------------------------------------ */

function parseDemoSlot(h, problems) {
  const out = { found: false, entries: [] };
  const s = RE.demoSlot.exec(h);
  const e = RE.demoSlotEnd.exec(h);
  if (!s || !e || e.index < s.index) {
    problems.push(problem('demo-slot-missing', 'warn',
      '找不到演示槽（「章专用演示」注释与「收尾」注释之间那一段）。这一页上的演示 JS 无法反推。',
      '合并后这一章的演示会全部消失，讲解与题目不受影响。若这一章本来就没有演示，可以忽略。'));
    return out;
  }
  out.found = true;
  const close = h.indexOf('*/', s.index + s[0].length);
  const from = close < 0 ? s.index + s[0].length : close + 2;
  const region = h.slice(from, e.index);

  const marks = [];
  const re = demoEntryRe();
  let m;
  while ((m = re.exec(region))) marks.push({ at: m.index, end: re.lastIndex, title: m[1], kind: m[2] });

  if (!marks.length) {
    if (region.trim()) {
      problems.push(problem('demo-slot-unrecognized', 'warn',
        '演示槽里有内容，但不是本工具生成的形状（既没有「由工作台校验」也没有「由工作台补上兜底 try/catch」的标记）。' +
        '这一段 JS 合并后会**丢掉**。',
        '若这一章的演示是后来手工加的，请让用户把它单独保存一份。'));
    }
    return out;
  }
  if (region.slice(0, marks[0].at).trim()) {
    problems.push(problem('demo-slot-prefix', 'warn',
      '演示槽开头有一段不属于任何演示的内容，反推时会被丢掉。',
      '若这段内容重要，请让用户单独保存一份。'));
  }

  marks.forEach((mk, i) => {
    const body = region.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : region.length);
    const en = { title: mk.title, kind: mk.kind, id: '', js: '' };
    if (mk.kind === '校验') {
      // 模型自己把 js 包成了 try{…}catch：assemble 原样放进来，没有加 id 标记
      en.js = body.trim();
    } else {
      /* ⚠️ 开头的 `\s*` 不能省：body 是从注释行**后面**切起的，第一个字符就是那个换行。
         少了它这条就永远匹配不上，症状是"每个演示都报 JS 外壳看不懂、id 全部丢失"。
         行尾的 `catch` 也要按 assemble.js 里那行字面量**逐字**写（` console.error(...)` 前有一个空格）。 */
      const w = /^\s*try\{\r?\n([\s\S]*?)\r?\n\}catch\(e\)\{\s*console\.error\('\[演示 ([\s\S]*?)\] 出错：', e\); \}/.exec(body);
      if (w) { en.js = w[1].trim(); en.id = w[2]; }
      else {
        en.js = body.trim();
        problems.push(problem('demo-js-unrecognized', 'warn',
          `演示「${mk.title}」的 JS 外壳看不懂（不是本工具补的那层 try/catch），已原样收下。` +
          '它的 id 也就无从得知，只能靠出现顺序跟正文里的演示 DOM 配对。',
          '合并后在页面上点一遍这个演示，确认它还动得起来。'));
      }
    }
    out.entries.push(en);
  });
  return out;
}

/**
 * 把演示槽里的 JS 与正文里的演示 DOM 配成对。
 *
 * 配对的**唯一硬证据**是 id：JS 用 getElementById 去取 DOM，两边的 id 必然相同。
 * 拿不到 id 时只能按出现顺序配——那是猜，所以：
 *   · 数量正好对得上 → 配下去，但写一条 warn 说清"这是按顺序配的"；
 *   · 数量对不上     → 只配能配的，多出来的**逐条报出来**，绝不闷掉。
 */
function pairDemos(entries, cands, problems) {
  const demos = [];
  const usedE = new Set();
  const usedC = new Set();
  /* 嵌在正文里的演示**合并成一条**报出来。
     一章往往有三四个演示，逐条报会刷屏，用户反而会跳过不看——
     而这条说明本身是"内容没丢、位置也是对的"，只是交代一下它换了个存法。 */
  const inLecture = [];

  const mk = (en, c, n) => {
    const d = {
      id: (en && en.id) || (c && c.id) || 'demo' + (n + 1),
      title: (en && en.title) || '',
      markup: '',
      js: (en && en.js) || '',
      unitId: '',
    };
    if (c && c.inLecture) {
      // DOM 留在 lectureHtml 里，但 unitId 照报：调用方要靠它知道这个演示属于哪一节
      d.unitId = c.unitId;
      inLecture.push(`${d.title || d.id}（在单元「${c.unitTitle || c.unitId}」的正文里）`);
    } else if (c) {
      d.markup = c.html;
      d.unitId = c.unitId;
    }
    return d;
  };

  // ① 先按 id 配
  entries.forEach((en, i) => {
    if (!en.id) return;
    const k = cands.findIndex((c, j) => !usedC.has(j) && c.id && c.id === en.id);
    if (k >= 0) { usedE.add(i); usedC.add(k); demos.push(mk(en, cands[k], demos.length)); }
  });

  // ② 剩下的按出现顺序配
  const restE = entries.map((_, i) => i).filter((i) => !usedE.has(i));
  const restC = cands.map((_, j) => j).filter((j) => !usedC.has(j));
  if (restE.length && restC.length) {
    const n = Math.min(restE.length, restC.length);
    for (let k = 0; k < n; k++) {
      usedE.add(restE[k]); usedC.add(restC[k]);
      demos.push(mk(entries[restE[k]], cands[restC[k]], demos.length));
    }
    if (restE.length === restC.length) {
      problems.push(problem('demo-paired-by-order', 'warn',
        `有 ${n} 个演示没法按 id 配对（JS 里没有工作台写的 id 标记），已按**出现顺序**跟正文里的演示 DOM 配对。` +
        '顺序配对在"某一段演示的 DOM 被删过"时会把 JS 接到错的演示上。',
        '合并后逐个点一遍这几个演示，确认动的是它自己那一块。'));
    }
  }
  restE.filter((i) => !usedE.has(i)).forEach((i) => {
    const en = entries[i];
    demos.push(mk(en, null, demos.length));
    problems.push(problem('demo-js-without-markup', 'warn',
      `演示「${en.title || en.id || '(无标题)'}」在演示槽里有 JS，但正文里找不到对应的演示 DOM。` +
      '它合并后**不会显示**（JS 跑起来取不到元素）。',
      '要么把它原来那块 DOM 找回来，要么让用户确认这个演示已经废弃、直接从结构里删掉。'));
  });
  restC.filter((j) => !usedC.has(j)).forEach((j) => {
    const c = cands[j];
    demos.push(mk(null, c, demos.length));
    problems.push(problem('demo-markup-without-js', 'warn',
      `单元「${c.unitTitle || c.unitId}」的正文里有一块演示 DOM（${c.id ? 'id="' + c.id + '"' : '没有 id'}），` +
      '但演示槽里没有对应的 JS。这多半是"纯静态演示"（只摆图不动），也可能是它的 JS 在生成时就丢了。',
      '合并后它会照原样留在正文里；如果是该动不动的演示，请让用户回头查一下那一章的生成日志。'));
  });

  if (inLecture.length) {
    problems.push(problem('demo-markup-in-lecture', 'warn',
      `有 ${inLecture.length} 个演示的 DOM 嵌在讲解正文里：${inLecture.join('；')}。` +
      '（生成时是 <!--DEMO:id--> 占位注释被就地替换的。）反推时它们**留在 lectureHtml 里不动、markup 记为空串**，' +
      '合并后会出现在原来的位置，内容一点不会丢。',
      '不用处理。但这也意味着"演示原本挂在正文的哪一行"无法再从结构里看出来，改动正文时留意别把演示块当成普通段落删掉。'));
  }
  return demos;
}

/* ------------------------------------------------------------------ *
 * 校验：每一条都返回"哪一条对不上 + 建议怎么办"
 * ------------------------------------------------------------------ */

function validate(p) {
  const P = [];

  // 0) 这页到底是不是拼装器生成的
  if (!RE.cspMeta.test(p.html)) {
    P.push(problem('no-csp-meta', 'warn',
      '这份 HTML 里没有交付页应有的 CSP meta 标签（assemble.js 每次都会注入）。' +
      '它可能不是本工具生成的页面，或者被人手工改过。',
      '先确认文件来源；如果确实是本工具生成的，说明这一页比当前拼装器旧，反推结果请人工核对一遍。'));
  }

  // 1) 单元数 vs 题库段数 —— 结构上最要命的一条
  const nu = p.units.length;
  const nb = p.banks.length;
  if (nu !== nb) {
    P.push(problem('unit-bank-count-mismatch', 'blocker',
      `单元数 ${nu} 与题库段数 ${nb} 不一致：正文里有 ${nu} 个题区，页面上有 ${nb} 段题库。` +
      '一段题库对应一个单元，对不上就无法确定"哪段题属于哪个单元"——硬猜的结果是一册题连着别人的讲解。',
      nb < nu
        ? `多半是第 ${nb + 1} 段题库（<script data-bank id="bank${nb}">）被删掉了或 JSON 坏掉被浏览器吞了。请让用户重新生成这一章，或把缺的那段补回来。`
        : `多出来的是第 ${nu + 1} 段之后的题库段。请让用户确认是不是多复制了一段；确认后删掉多余的，再合并。`));
  }

  // 2) 题库段 id 必须是 bank0…bankN-1
  p.banks.forEach((b, i) => {
    if (!b.indexOk) {
      P.push(problem('bank-id-sequence', 'blocker',
        `第 ${i + 1} 段题库的 id 是 "${b.id}"，按顺序应该是 "bank${i}"。` +
        '引擎只按出现顺序读这些段（不看 id），但 id 对不上说明这一页被手工改过，其余地方也要打问号。',
        '请让用户确认这一页的来源；若确认只是 id 被改了，可以按出现顺序改造后用。'));
    }
  });

  // 3) 题区序号：必须从 0 起、连续、不重号
  const seq = p.units.map((u) => u.lv);
  const dup = seq.filter((n, i) => seq.indexOf(n) !== i);
  const missing = [];
  for (let i = 0; i < seq.length; i++) if (!seq.includes(i)) missing.push(i);
  const seqBad = seq.length !== new Set(seq).size || missing.length || seq.some((n, i) => n !== i);
  if (seqBad) {
    // 报错里带上 id 原文：用户拿到这句话要能在十几万字的文件里搜索到它
    const seqTxt = p.units.map((u) => u.qsecId).join('、');
    P.push(problem('qsec-sequence', 'blocker',
      `题区序号不对：正文里的题区依次是 ${seqTxt}（序号 [${seq.join(', ')}]），不是从 0 起的连续序列。` +
      (dup.length ? ` 重号：${[...new Set(dup)].join('、')}。` : '') +
      (missing.length ? ` 缺号：${missing.join('、')}。` : '') +
      ' 引擎会把题按 lv 塞进 .qlist[data-lv=N]，序号一乱，题目就会渲染进别的单元的题区里（而页面不报错）。',
      '这一页必须修好再用。请让用户重新生成这一章——手工改回连续序号会连带影响题库里的 lv 与存盘键。'));
  }

  p.units.forEach((u, k) => {
    // 4) 题区 id 的 N 与 data-lv、data-cnt 三处必须一致
    if (u.dataLv != null && u.dataLv !== u.lv) {
      P.push(problem('qsec-lv-mismatch', 'blocker',
        `单元 ${k + 1} 的题区 id 是 "p-l${u.lv}"，但里面 .qlist 的 data-lv 是 ${u.dataLv}。` +
        '引擎按 data-lv 决定题目渲染到哪里，两者不一致时这一节的题会跑到别的单元下面。',
        '请让用户重新生成这一章。'));
    }
    if (u.cntIndex != null && u.cntIndex !== k) {
      P.push(problem('cnt-index-mismatch', 'warn',
        `单元 ${k + 1} 的题区标题上写着 data-cnt="${u.cntIndex}"，应该是 "${k}"。` +
        '吸顶条上"3/5 已答"那个计数会挂到错的题区上。',
        '合并后计数会重新生成，不用处理；但可以据此判断这一页被人手工改过。'));
    }
    // 5) 讲解导语 vs 题区导语
    if (u.lede && u.qsecLede && u.lede !== u.qsecLede) {
      u.quizLede = u.qsecLede;
    } else if (u.lede && u.qsecLede === '') {
      P.push(problem('lede-missing-in-qsec', 'warn',
        `单元 ${k + 1} 的讲解有导语，题区却没有。成品页里这两处应当一致（题区导语缺省就取讲解那段），` +
        '不一致说明这一页被人改过。已按讲解那处为准。',
        '不用处理。但这一页既然被改过，其余内容请抽查一下。'));
    } else if (!u.lede && u.qsecLede) {
      // assemble 的取值顺序是 quizLede || lede，讲解那处没有导语却只有题区有 —— 只可能是 quizLede
      u.quizLede = u.qsecLede;
    }
  });

  // 6) 每段的 lv 必须与它所属单元的序号一致
  p.units.forEach((u, k) => {
    const b = p.banks[k];
    if (!b || !Array.isArray(b.items)) return;
    const bad = b.items.filter((it) => it && typeof it === 'object' && it.lv != null && it.lv !== k);
    if (bad.length) {
      P.push(problem('bank-lv-mismatch', 'blocker',
        `第 ${k + 1} 段题库（id="${b.id}"）里有 ${bad.length} 道题的 lv 不是 ${k}` +
        `（例如「${bad[0].id}」的 lv 是 ${bad[0].lv}）。lv 是"这道题属于哪个题区"的唯一依据，` +
        '对不上就说明这段题库实际属于别的单元——按段号硬配会把 A 单元的题挂到 B 单元下面。',
        '请让用户重新生成这一章。'));
    }
  });

  // 7) 合计作答点：页头/页脚自称的数字 vs 实际算出来的
  let total = 0;
  const perUnit = [];
  p.units.forEach((u, k) => {
    const b = p.banks[k];
    const items = b && Array.isArray(b.items) ? b.items : [];
    const c = countPoints(items);
    perUnit.push(c.total);
    total += c.total;
    u.bank = items;
    u.points = c.total;
    if (items.length === 0) {
      P.push(problem('unit-bank-empty', 'blocker',
        `单元 ${k + 1}（${u.title || u.id}）的题库是空的：合并后这一节只有讲解、一道题都没有。`,
        '请让用户重新生成这一章，或确认这一段题库本来就没题（那也应该把它并进相邻单元）。'));
    }
  });

  const claimed = p.header.claimed || {};
  if (claimed.points != null && claimed.points !== total) {
    P.push(problem('point-total-mismatch', 'warn',
      `页头写着「${claimed.points} 个作答点」，但从题库里算出来的是 ${total} 个` +
      `（每段分别是：${perUnit.join(' / ')}）。` +
      (claimed.points > total
        ? `差 ${claimed.points - total} 个：这几道题在成品页里**已经不存在**了（多半是某段题库的 JSON 坏了被引擎吞掉、或生成时就没写进去），反推拿不回来。`
        : `实际比页头多 ${total - claimed.points} 个：页头是生成时写的，题库后来被加过题。`),
      '合并后的新页面会按题库重新算这个数字，所以不用处理；但请把这句话告诉用户——' +
      '有题目在历史页面上就已经丢了，只能重新生成那一章才能补回来。'));
  }
  if (claimed.units != null && claimed.units !== p.units.length) {
    P.push(problem('unit-total-mismatch', 'warn',
      `页头写着「${claimed.units} 个单元」，正文里实际有 ${p.units.length} 个。`,
      '合并后按实际单元数走；但两个数字对不上说明这一页被改过，请抽查一遍。'));
  }

  // 8) ref.h 的锚点必须都能在页面里找到
  const dead = [];
  p.units.forEach((u, k) => {
    const walk = (items, label) => {
      items.forEach((q, qi) => {
        if (!q || typeof q !== 'object') return;
        const targets = q.type === 'big' ? (q.parts || []) : [q];
        targets.forEach((t) => {
          if (!t || !t.ref || !t.ref.h) return;
          const raw = String(t.ref.h);
          if (!raw.startsWith('#') || !p.ids.has(raw.slice(1))) {
            dead.push(`${label} 第 ${qi + 1} 题（${q.id}）→ ${raw}`);
          }
        });
      });
    };
    walk(u.bank || [], `单元 ${k + 1}`);
  });
  if (dead.length) {
    P.push(problem('dead-ref', 'warn',
      `有 ${dead.length} 处「回看」链接指向页面上不存在的位置：${dead.slice(0, 5).join('；')}` +
      (dead.length > 5 ? ` …另有 ${dead.length - 5} 处` : '') + '。' +
      '合并后这些链接点下去没有任何反应。',
      '合并时把这些 ref 去掉即可（拼装器本来也会自动摘掉死链，见 assemble.js 第 3 步）。'));
  }

  // 9) 目录卡的锚点
  const badLinks = (p.howtoLinks || []).filter((l) => !p.ids.has(l.href));
  if (badLinks.length) {
    P.push(problem('howto-link-dead', 'warn',
      `目录卡里有 ${badLinks.length} 个跳转链接指向不存在的小节：` +
      badLinks.slice(0, 5).map((l) => `「${l.text}」→ #${l.href}`).join('；') + '。',
      '目录合并后会重新生成，不用处理。'));
  }

  // 10) 演示数
  if (claimed.demos != null && claimed.demos !== p.demos.length) {
    P.push(problem('demo-total-mismatch', 'warn',
      `页头写着「${claimed.demos} 个可拖演示」，反推出来 ${p.demos.length} 个。`,
      '合并后按反推出来的算；对不上的部分请对照上面关于演示的几条具体说明。'));
  }

  return P;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

function buildData(p) {
  const unitPoints = p.units.map((u) => u.points || 0);
  return {
    // 与 assemble() 的 chapter 对齐：no 就是它要的 number，subject/title/intro 同名
    chapter: {
      no: p.header.no || '',
      title: p.header.title || '',
      subject: p.header.subject || '',
      intro: p.header.intro || '',
    },
    pageKey: p.engine.pageKey,
    finalAdvice: p.engine.finalAdvice,
    pet: p.engine.pet,
    units: p.units.map((u) => {
      const o = {
        id: u.id,
        num: u.num,
        title: u.title,
        qsecTitle: u.qsecTitle,
        lede: u.lede,
        lectureHtml: u.lectureHtml,
        bank: u.bank || [],
        points: u.points || 0,
      };
      // quizLede 只在"与讲解导语不同"时才带上：拼装时它优先于 lede，不带就等于丢了一段话
      if (u.quizLede && u.quizLede !== u.lede) o.quizLede = u.quizLede;
      return o;
    }),
    demos: p.demos,
    不确定的地方: p.problems.map((x) => (x.level === 'blocker' ? '【不能用】' : '【注意】') + x.message + (x.hint ? ' 建议：' + x.hint : '')),
    注: [
      '题库是**规范化之后**的：id 已带单元命名空间（如 ' + (p.units[0] && p.units[0].id ? p.units[0].id + '-q1' : 'u1-q1') + '）、' +
        '每道题多了一个 lv、选项已整理成 {t,ok,why}。再拼装时会再规范化一次，id 会变成两层前缀。',
      '每个单元的作答点数：' + unitPoints.join(' / ') + '，合计 ' + unitPoints.reduce((a, b) => a + b, 0) + '。',
    ],
  };
}

/**
 * 解析 + 校验。
 *
 * @returns {{ ok:boolean, data:object|null, problems:Array }}
 *   ok       —— 能不能用。false 就是"不能用"，**这时 data 一定是 null**：
 *               宁可让调用方拿到"什么都没有"，也不能让它拿到一份看起来是好的错结构。
 *   data     —— 与落盘格式对齐的结构（见 buildData），可直接喂给拼装器。
 *   problems —— 每一条都是 { code, level:'blocker'|'warn', message, hint }，
 *               message 里带具体的单元名/id，hint 是"建议怎么办"。
 */
function revive(html) {
  if (typeof html !== 'string' || !html) {
    return {
      ok: false,
      data: null,
      problems: [problem('empty-input', 'blocker', '没有拿到任何 HTML 内容。', '请确认文件读进来了（是不是空的、或读错了文件）。')],
    };
  }

  const problems = [];
  const p = { html, ids: new Set(), problems };

  // 页面里所有 id：ref.h 的锚点校验要用（与 assemble.js 第 3 步同源）
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) p.ids.add(m[1]);

  p.header = parseHeader(html, problems);
  p.body = parseBody(html, problems);
  p.units = p.body.units;
  p.banks = parseBanks(html, problems);
  p.engine = parseEngine(html, problems);
  p.howtoLinks = p.body.howtoLinks;

  // 演示：JS 在演示槽里，DOM 在正文里，两边配起来
  const slot = parseDemoSlot(html, problems);
  const cands = [];
  p.units.forEach((u) => {
    (findDemoDivs(u.lectureHtml) || []).forEach((d) => {
      cands.push({ html: u.lectureHtml.slice(d.start, d.end), id: d.id, inLecture: true, unitId: u.id, unitTitle: u.title });
    });
    (findDemoDivs(u.gap || '') || []).forEach((d) => {
      /* 题区前那一段：这是 assemble 给"占位注释没写进正文"的演示留的位置，要抠出来交给 demos[]。
         ⚠️ 这里的 markup **不能去缩进**：它是 assemble 在拼装最后一步**原样插进去**的
         （不像讲解正文那样过了 indent(html,4)）。去缩进会把演示 DOM 自己的两格缩进吃掉，
         反推出来的 markup 与原文对不上（症状：`<pre>` 里的显示会变）。 */
      cands.push({ html: normalizeEol(trimBlankLines(u.gap.slice(d.start, d.end))), id: d.id, inLecture: false, unitId: u.id, unitTitle: u.title });
    });
  });
  p.demos = pairDemos(slot.entries, cands, problems);
  p.problems = problems.concat(validate(p));

  const blocked = p.problems.some((x) => x.level === 'blocker');
  return { ok: !blocked, data: blocked ? null : buildData(p), problems: p.problems };
}

module.exports = { revive, parseHeader, parseBody, parseBanks, parseEngine, parseDemoSlot, validate, findDemoDivs, unescapeHtml, dedentLines, normalizeEol };
