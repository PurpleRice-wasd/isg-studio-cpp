'use strict';
/* 确定性拼装：把「模型产出的片段」塞进 skill 的骨架页。
 *
 * 这是整个应用里最要紧的一条设计：**页面永远不由模型写**。
 * 模型只产出
 *   · 每个单元的讲解正文片段（inner HTML，不含 <section> 外壳）
 *   · 每个单元/综合单元的题库（结构化 JSON）
 *   · 若干演示的标记 + JS
 * 引擎、样式、吸顶条、结算区、陪练块一律原样来自 page-skeleton.html。
 * 这样 SKILL.md 里"最致命的六个坑"（尾逗号、script 顺序、DOM 缺失…）在结构上就不可能发生。
 *
 * 拼装哲学照抄 skill 的规矩：**凡拼接必断言**。锚点找不到就抛错，
 * 绝不允许静默产出一份"看起来还行、其实少了半个单元"的页面。
 *
 * ── 这一版针对"模型输出是敌意的"做了三处加固（每处都有实测的复现）──
 *   1. 写进 script 的东西一律转义（jsonForScript / jsForScript）。
 *      原来 `<!--` 会被转成 `<\!--`，那是**非法 JSON**，引擎 JSON.parse 抛错后
 *      整段题库静默消失；finalAdvice / 演示 js 里的 `</script>` 更会把引擎提前闭合、
 *      整页没有任何 JS，而任务照报"完成"。
 *   2. 引擎区间的替换**只在引擎区间里做**。正文不可信，它可能"引用"骨架配置原文，
 *      全局 replace 会改到正文那处、放过引擎里真正该改的那处（症状：用户选了"不要陪练"，
 *      右下角还是冒出陪练，且一声不响）。
 *   3. 断言失败时的报错要把"嫌疑指向模型正文"说清楚，别再一律怪骨架页被改过。
 */

const { normalizeBank, countPoints } = require('./bank');

/** 骨架页里我们用到的全部锚点。任何一条失配都会让拼装立刻失败。 */
const MARK = {
  title: /<title>([\s\S]*?)<\/title>/,
  header: /<header class="top">[\s\S]*?<\/header>/,
  // 正文区：从"讲：知识块写在这里"的注释到结算区之前
  contentStart: '  <!-- 讲：知识块写在这里（从《拆解手册》整节搬过来即可） -->',
  contentEnd: '  <section id="result">',
  bankBlock: /<script data-bank id="bank0" type="application\/json">[\s\S]*?<\/script>/,
  pageKey: /(\n\s*)key:'chXX-study-guide-v1',/,
  finalAdvice: /(\n\s*)finalAdvice:'',/,
  petImages: /petImages:\[[^\]]*\]/,
  bgImages: /bgImages:\[[^\]]*\]/,
  demoSlot: '/* ================= 章专用演示：把本章的演示 IIFE 放在这里 =================',
  demoSlotEnd: '/* ---------------- 收尾 ---------------- */',
  footer: /<footer>[\s\S]*?<\/footer>/,
  engineOpen: '<script id="engine">',
};

/**
 * 断言某段文本恰好出现 1 次。
 *
 * 出现 0 次 = 骨架页被改过（锚点过期）；出现 2 次以上 = **多半是模型正文里抄了骨架原文**。
 * 两者要分开说，否则用户会拿着"骨架页被改过"的错误线索去翻一个没问题的文件。
 */
function assertOnce(haystack, needle, what) {
  const n = haystack.split(needle).length - 1;
  if (n === 1) return;
  if (n > 1) {
    throw new Error(
      `拼装失败：全页里「${what}」出现了 ${n} 次，应该只有 1 次。` +
        '最常见的成因是**模型在讲解正文里抄了骨架页的片段**（例如把一段配置当例子贴出来）。'
    );
  }
  throw new Error(
    `拼装失败：全页里找不到「${what}」。这通常意味着 ` +
      'skills/interactive-study-guide/assets/page-skeleton.html 被改过，' +
      '请对照 apps/isg-studio/docs/architecture.md 更新 assemble.js 的锚点。'
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把 JSON 安全地放进 script。
 *
 * **做法是把每一个 `<` 都转成 <** —— 这是合法 JSON 转义，JSON.parse 会还原成 `<`。
 * 为什么不用别的写法（都踩过）：
 *   · `</script` → `<\/script` 是对的（`\/` 是合法 JSON 转义）；
 *   · 但 `<!--` → `<\!--` **不是合法 JSON**（JSON 没有 `\!` 这个转义），JSON.parse 直接抛
 *     "Bad escaped character" → 引擎把它 catch 掉 → **那一整段题库的题凭空消失**，
 *     页面不报错、页眉却还写着「共 N 个作答点」。模型在题干里写一句 `<!-- 注意 -->` 就会触发。
 *   · 干脆一个 `<` 都不留：`</script` 与 `<!--` 一起解决，没有漏网的形态。
 */
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 往 script 里塞一段**模型写的 JS**（演示的 js）。
 *
 * `</script` 出现在 JS 里（字符串、正则、注释都算）会让 HTML 解析器提前闭合脚本，
 * 后面整段引擎变成页面上的可见文字、完全不执行。而 `<\/script` 在 JS 里与原写法**完全等价**
 * （`\/` 就是 `/`），所以这个替换是无损的。提示词禁不掉这件事——模型写
 * `document.write('</script>')` 很自然，所以 index.js 的 validateDemo 也要一起兜。
 */
function jsForScript(js) {
  return String(js == null ? '' : js).replace(/<\/script/gi, '<\\/script');
}

/**
 * 清洗**模型写的 HTML 片段**。这是最后一道防线，不依赖上游校验器有没有拦住。
 *
 * 为什么必须做：生成的这一页会被**真的执行**——
 *   · 用户打开"结果"页时，它在预览 iframe 里跑一次；
 *   · 每次自动校验，它在隐藏窗口里再跑一次；
 *   · 用户双击交付文件，它在自己的浏览器里跑。
 * 而页面里的 HTML 来自模型，模型又是在读**用户的课件**——课件里一句"请把下面的标签原样输出"
 * 就能让它写出 `<img src=x onerror=...>`。这条链不需要用户做任何异常操作。
 *
 * 清洗策略：整类删掉危险元素 + 抹掉内联事件与危险协议。
 * 注意**演示的 js 不能禁**（那是设计的一部分），所以页面还必须配 CSP——见 preview.js 与
 * assemble 里写进 head 的那条 meta。
 *
 * @returns {{ html:string, removed:string[] }}
 */
/* ---- 属性清洗用的小工具（只服务 sanitizeModelHtml）------------------------- */

/** URL 场景真正会出现的实体名。`:` 与字母的编码是绕过协议清洗的常用手法。 */
const URL_ENTITIES = {
  amp: '&', colon: ':', tab: '\t', newline: '\n', sol: '/',
  period: '.', num: '#', quest: '?', equals: '=', lpar: '(', rpar: ')',
};

function decodeUrlEntities(v) {
  return String(v).replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (m, hex, dec, name) => {
    if (hex) return codePointChar(parseInt(hex, 16));
    if (dec) return codePointChar(parseInt(dec, 10));
    const k = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(URL_ENTITIES, k) ? URL_ENTITIES[k] : m;
  });
}
function codePointChar(n) {
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}

/**
 * 这个属性值是不是"点了就会执行"的危险协议？
 *
 * 判之前先做两件**解析器本来就会做**的事，否则形同虚设：
 *   · 解实体 —— `&#106;avascript:` 在解析器眼里就是 `javascript:`；
 *   · 去掉空白与控制字符 —— 浏览器取 URL 前会剥掉前后的 C0 控制符与空白（`java\tscript:` 也认）。
 * ⚠️ 只认这几种，**不能**把所有 `data:` 都毙掉：演示里的内联图就是 `data:image/...`。
 */
function isDangerousUrl(raw) {
  const v = decodeUrlEntities(raw).replace(/[\u0000- \u007f]+/g, '').toLowerCase();
  return /^(javascript|vbscript):/.test(v)
    || /^data:text\/html/.test(v)
    || /^data:application\/xhtml/.test(v);
}

/** 脱掉属性值两端的引号（没有引号就是"无引号写法"，原样返回）。 */
function unquote(v) {
  return String(v).replace(/^["']/, '').replace(/["']$/, '');
}

/**
 * 清洗**一个标签内部**的属性。
 *
 * 只对标签跑（标签外是正文），所以不会像"对整段文本跑属性正则"那样把正文里的
 * `online=1`、`H/one=1` 当成内联事件删掉。`kinds` 由调用方传入，记录清掉了哪几类。
 */
function scrubTagAttrs(tag, kinds) {
  let t = tag;
  const sub = (re, repl, label) => {
    const before = t;
    t = t.replace(re, repl);
    if (t !== before) kinds.add(label);
  };

  // 内联事件：onclick= / onerror= / onload= …
  // 分隔符不能只认空白：HTML 解析器把 `/`（以及紧随引号的下一个字符）也当属性分隔符，
  // 所以 `<img src=x/onerror=…>` 与 `<img src="x"onerror=…>` 里的属性**照样生效**。
  sub(/([\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1', '内联事件（on*=）');

  // 危险协议：带引号 / 无引号 / 字母被实体编码 —— 三种写法都要认
  sub(
    /([\s/"'])(href|src|xlink:href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, name, raw) => (isDangerousUrl(unquote(raw)) ? pre + name + '="#"' : m),
    'javascript:/vbscript:/data:text-html 链接'
  );

  // 外链资源（页面必须零外部请求，离线也要能看）
  sub(
    /([\s/"'])(src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, name, raw) => (/^(?:https?:)?\/\//i.test(unquote(raw).trim()) ? pre + name + '="#"' : m),
    '外链资源'
  );
  sub(/([\s/"'])srcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1', '外链资源');
  sub(
    /([\s/"'])style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, raw) => {
      const q = /^["']/.test(raw) ? raw[0] : '';
      const v = unquote(raw);
      const cleaned = v.replace(/url\(\s*['"]?(?:https?:)?\/\/[^)]*['"]?\s*\)/gi, 'none');
      return cleaned === v ? m : pre + 'style=' + q + cleaned + q;
    },
    '外链资源'
  );
  return t;
}

function sanitizeModelHtml(input) {
  let s = String(input == null ? '' : input);
  const removed = [];
  const drop = (re, label) => {
    const before = s;
    s = s.replace(re, '');
    if (s !== before) removed.push(label);
  };
  // 整类删掉的元素（这些在"讲练一体"页面里没有任何正当用途）
  drop(/<script\b[\s\S]*?<\/script\s*>/gi, '<script>');
  drop(/<script\b[^>]*\/?>/gi, '<script>');
  drop(/<\/script\s*>/gi, '</script>');
  drop(/<style\b[\s\S]*?<\/style\s*>/gi, '<style>');
  drop(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '<iframe>');
  drop(/<iframe\b[^>]*\/?>/gi, '<iframe>');
  drop(/<object\b[\s\S]*?<\/object\s*>/gi, '<object>');
  drop(/<embed\b[^>]*\/?>/gi, '<embed>');
  drop(/<base\b[^>]*\/?>/gi, '<base>');
  drop(/<meta\b[^>]*\/?>/gi, '<meta>');
  drop(/<link\b[^>]*\/?>/gi, '<link>');
  drop(/<form\b[\s\S]*?<\/form\s*>/gi, '<form>');
  drop(/<form\b[^>]*\/?>/gi, '<form>');
  // ⚠️ <input> / <button> / <canvas> **不能整体删**：演示的滑块就是 <input type="range">、
  //    预设按钮就是 <button>——它们是这个页面的核心控件（实测误删过一次，症状是
  //    「演示的滑块不见了、读数全是 —」）。真正要防的是「能执行代码」与「能往外发东西」，
  //    那两类已经在上面 + 下面的事件/协议清洗里覆盖了。

  /* ---- 属性级清洗：**只在标签内部**做 ----
     ⚠️ 为什么必须先切出标签，而不是对整段文本跑正则：
     "属性名边界"判据（`on` 前面是空白 / `/` / 引号）在**标签外的正文**里也会命中普通文字。
     实测 `<p>把 online=1 填进去</p>` → `<p>把  填进去</p>`：` online=` 前面正好是空白，
     `on` 接上 `line` 又正好凑成 `on[a-z]+`，于是正常文字连同它的值一起被删掉了。 */
  const kinds = new Set();
  s = s.replace(/<[^<>]*>/g, (tag) => scrubTagAttrs(tag, kinds));
  for (const k of kinds) removed.push(k);
  return { html: s, removed };
}

function indent(text, n) {
  const pad = ' '.repeat(n);
  return String(text || '')
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n');
}

/**
 * 把两种入参形状归一成 `[{ chapter, units, demos }]`。
 *
 * 为什么要归一而不是直接要求新形状：`{chapter, units, demos}` 的单章形状是**存量调用方**
 * （index.js 的 assembleInput、test/hostile-input.js 的 base()）在用的，改形状会让它们全炸。
 */
function toChapters(input) {
  if (Array.isArray(input.chapters)) {
    if (!input.chapters.length) throw new Error('拼装失败：chapters 是空的');
    return input.chapters.map((c) => ({
      chapter: (c && c.chapter) || {},
      units: (c && c.units) || [],
      demos: (c && c.demos) || [],
      // 这一章**单独成页**时用的存盘键（见「进度搬家」那段）：一章并进一册时，
      // 学员在那一章单独页面里做过的题就存在这个键下。老的单章形状没有它。
      key: String((c && c.key) || ''),
    }));
  }
  // 老的单章形状：chapter/units/demos 都在顶层
  return [{ chapter: input.chapter || {}, units: input.units || [], demos: input.demos || [], key: '' }];
}

/** 目录与正文里的章标题（如「第 13 章 · 磁介质」）。 */
function chapterLabel(chapter, index) {
  const num = chapter && chapter.number ? `第 ${chapter.number} 章` : `第 ${index + 1} 章`;
  const title = String((chapter && chapter.title) || '').trim();
  return [num, title].filter(Boolean).join(' · ');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一个单元的题库在给定 namespace 下**会得到哪些 id**。
 *
 * ⚠️ 这里刻意把 bank.js:169-175 的"id 前缀规则"抄了一份：我们要在**调用 normalizeBank 之前**
 * 判断"加了 ns0 之后会不会撞车"，而 normalizeBank 只在已经撞了之后才把冲突**静默改名**
 * （记一条 fix 就过去了）。等到那时候再改就已经晚了——它的 id 已经进了 items。
 * 规则一旦在 bank.js 里改了，这里必须跟着改（两边都只做 `[^\w\-.]` → `-` 再拼前缀）。
 */
function prospectiveIds(bank, ns) {
  const out = [];
  (Array.isArray(bank) ? bank : []).forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return;
    let base = String(raw.id == null ? '' : raw.id).trim() || 'q' + (idx + 1);
    base = base.replace(/[^\w\-.]/g, '-');
    out.push(ns ? ns + '-' + base : base);
  });
  return out;
}

/** 演示 id 只在 `demoA…demoZ` 这 26 个槽里取（引擎与契约约定的 id 空间）。 */
function nextFreeDemoId(used) {
  for (let i = 0; i < 26; i++) {
    const id = 'demo' + String.fromCharCode(65 + i);
    if (!used.has(id)) return id;
  }
  return '';
}

/**
 * 一道题自身 + 它的子问（big 的 parts）—— 凡是"带 id 的作答点"都在这里。
 * 页面上的题卡 id 是 `q-<顶层 id>`（quiz-engine.js:1159），子问不再单独占 id。
 */
function endpointsOf(q) {
  return q && q.type === 'big' ? q.parts || [] : [q];
}

/**
 * 把一个演示的**整族 id**（`demoA`、`demoA-r`、`demoA-rv`…）从 oldId 改名到 newId。
 *
 * 为什么要连 js 一起改，而不是只改元素上的 id：多章拼在一起时，两章的演示很可能都叫
 * `demoA`（模型每章独立生成，取名习惯一样）。同一个文档里出现两套同名 id 的后果是
 * `getElementById` 只返回第一个 → 第二章的滑块拖了没反应、读数永远不动，**页面上什么都不报**。
 * 而只改元素 id、不改 js 里对它的引用更糟：演示直接 `getElementById` 拿到 null，整块不显示。
 *
 * 只改三类**确实是 id 引用**的位置，不做全局文本替换：演示 id 可能是个普通词（`demo`），
 * 全局替换会把 CSS 类名 `demo-head` / `demo-body` 一起改花。
 *   ① HTML 的 id 引用型属性：id= / for= / list= / form= / aria-controls= …
 *   ② 选择器字符串里的 `#demoA…`
 *   ③ js 里**整段就是 id 本身或它的派生 id** 的字符串字面量：'demoA' / 'demoA-r'
 */
function renameDemoIds(text, oldId, newId) {
  let out = String(text == null ? '' : text);
  if (!oldId || !newId || oldId === newId) return out;
  const o = escapeRe(oldId);
  const n = newId;
  out = out.replace(
    new RegExp(
      '(\\b(?:id|for|list|form|headers|aria-controls|aria-labelledby|aria-describedby|aria-owns|aria-flowto)\\s*=\\s*["\'])'
        + o + '(?=[-"\'\\s])',
      'gi'
    ),
    (m, pre) => pre + n
  );
  out = out.replace(
    new RegExp('(["\'])#' + o + '(?=[\\s.#:>\\[,"\']|$)', 'g'),
    (m, q) => q + '#' + n
  );
  out = out.replace(
    new RegExp('(["\'])' + o + '(?=[-"\'\\]\\)\\.,;]|$)', 'g'),
    (m, q) => q + n
  );
  return out;
}

/* ================= 进度搬家（多章合成一册时） =================
 *
 * 要解决的问题：引擎把做题进度放在 `localStorage[PAGE.key]` 下，形状是 `{pts:{…}, ui:{…}}`。
 * 学员很可能在**某一章单独成页**时做过题——那份页面的键是**那一章自己的**（`chapters[i].key`）。
 * 合并成一册之后，册用的是另一个键（调用方给的 pageKey），于是那一章在册里**看不见进度了**
 * ——记录其实还在 localStorage 里，只是新页面里没有任何一道题再引用它（症状与"进度清零"一样）。
 *
 * 怎么搬：多章合并的设计是"作答点 id 不撞不改"（冻结章的 id 一个字不动），所以绝大多数情况下
 * **把整个 `pts` 从旧键拷到新键**就够了，不用动任何 id。
 * 只有"两章各自独立生成、撞了 id、其中一章被加了 `c<章序号>-` 前缀"（见上面 namespace 那段）时
 * 才需要一张 id 映射表 —— 那张表就在 namespace 决策处顺手记下来（`namespace !== rawAnchor`），
 * 不是猜的。冻结章与没撞车的章一律 `map:{}`（= 整键拷贝）。
 *
 * ⚠️ 两条必须写清楚、也写进了页面注释里的事：
 *   1. **跨 origin 不通**：应用内预览走 `isg://local`、双击交付文件走 `file://`，
 *      两者 localStorage **不同源**，这段脚本只在"同一个源里"有效。
 *      所以**任何文案都不该承诺"进度一定在"**。
 *   2. **旧键不删**：用户可能还在用那份单章页面（甚至已经把它转发给别人）。
 *      删掉旧键会让那份页面的进度凭空消失，而这里一点好处都没有。
 */

/** 载荷指纹：各来源键排序后拼起来做个小哈希（FNV-1a），同一个册/同一批来源恒定。 */
function migrationFingerprint(keys) {
  const s = keys.join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'mig-' + h.toString(36);
}

/**
 * 生成搬家**载荷**（纯数据，注入前不碰页面）。
 *
 * @returns {{id:string,targetKey:string,sources:Array<{key:string,map:object}>}|null}
 *   `null` = 不需要搬家（只有一章、或者各章的键与册的键相同）→ **一个字节都不注入**。
 */
function progressMovePayload(chapterInfos, slots, normalized, pageKey, multi) {
  if (!multi) return null; // 单章：产出必须与"支持搬家之前"逐字节一致
  const sources = [];
  for (const info of chapterInfos) {
    const key = String(info.key || '');
    if (!key || key === pageKey) continue; // 这一章的进度本来就在册的键下
    const map = {};
    for (const s of slots) {
      if (s.info !== info) continue;
      const ns = s.namespace;
      // 没改名（冻结章 ns 是空串；没撞车的章 ns === rawAnchor）→ map 留空 = 整个 pts 直接拷贝
      if (!ns || ns === s.rawAnchor) continue;
      const pre = ns + '-';
      for (const q of normalized[s.lv] || []) {
        if (!q || typeof q.id !== 'string' || q.id.lastIndexOf(pre, 0) !== 0) continue;
        /* 新 id = `<新命名空间>-<模型写的 id>`，而**那一章单独成页时**用的是它自己的命名空间
           （= rawAnchor，见 slots 那段）：旧 id = `<rawAnchor>-<模型写的 id>`。
           ⚠️ 不能反过来"从新 id 上剥掉新前缀"当作旧 id —— 那剥下来的是模型写的那个 id，
           在册里长这样：新前缀 `c2-u1-`、旧 id 其实是 `u1-q1`，剥出来却成了 `q1`，
           于是 map 里一个键都对不上，旧记录会**原样留在旧 id 上**（看着像"搬了"，其实一道题都没接上）。 */
        const base = q.id.slice(pre.length);
        const oldId = s.rawAnchor ? s.rawAnchor + '-' + base : base;
        map[oldId] = q.id;
        // 大题的小问在引擎里是 `<大题 id>-<步号>`（quiz-engine.js:1290），也一并映射，
        // 否则大题做过的每一步都会留在旧键下、在册里显示成"没做"。
        if (q.type === 'big' && Array.isArray(q.parts)) {
          for (let i = 1; i <= q.parts.length; i++) map[oldId + '-' + i] = q.id + '-' + i;
        }
      }
    }
    sources.push({ key, map });
  }
  if (!sources.length) return null;
  sources.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // 与章顺序无关的稳定输出
  return {
    id: migrationFingerprint(sources.map((s) => s.key)),
    targetKey: pageKey,
    sources,
  };
}

/**
 * 把载荷包成一段 `<script>`。**位置必须在 `<script id="engine">` 之前**：
 * 引擎在脚本解析时就把 `localStorage[KEY]` 读成快照了（quiz-engine.js:34-38），晚一步跑等于没跑。
 *
 * 脚本只做四件事：读旧键 → 按 map 改名 → **只补不覆盖**地并进目标 → 打一个幂等标记。
 * 整段包在 try/catch 里：`localStorage` 在 `file://`（opaque origin）下可能直接抛，
 * **搬家失败绝不能影响页面正常打开**。
 */
function migrationScript(payload) {
  return [
    '<script>',
    '/* 进度搬家：把「这一章单独成页」时做过的题搬到册的键下（完整说明在 assemble.js）。',
    '   ⚠️ 只在**同一个源**里有效：应用内预览走 isg://local、双击文件走 file://，',
    '      两者 localStorage 不同源 —— 所以不要承诺「进度一定在」。',
    '   ⚠️ 旧键不删：用户可能还在用那份单章页面。 */',
    '(function(){try{',
    '  var M=' + jsonForScript(payload) + ';',
    '  var LS=localStorage, flag=M.targetKey+"__mig";',
    '  if(LS.getItem(flag)===M.id) return;                /* 幂等：同一册重开不再搬 */',
    '  var tgt={}; try{ tgt=JSON.parse(LS.getItem(M.targetKey)||"{}")||{}; }catch(e){ tgt={}; }',
    '  var out={}; for(var k in tgt) out[k]=tgt[k];        /* 只碰 pts/ui，其余字段原样保留 */',
    '  out.pts=out.pts||{}; out.ui=out.ui||{};',
    '  for(var i=0;i<M.sources.length;i++){',
    '    var src=M.sources[i], old=null;',
    '    try{ old=JSON.parse(LS.getItem(src.key)||"null"); }catch(e){ old=null; }',
    '    if(!old||typeof old!=="object") continue;',
    '    var op=old.pts||{};',
    '    for(var id in op){',
    '      var to=Object.prototype.hasOwnProperty.call(src.map,id)?src.map[id]:id;',
    '      if(!Object.prototype.hasOwnProperty.call(out.pts,to)) out.pts[to]=op[id];  /* 只补不覆盖 */',
    '    }',
    '    /* ui（陪练位置/大小/模式）逐个字段补：目标里已经有的不覆盖 */',
    '    if(old.ui&&typeof old.ui==="object") for(var u in old.ui){ if(!(u in out.ui)) out.ui[u]=old.ui[u]; }',
    '  }',
    '  LS.setItem(M.targetKey,JSON.stringify(out));',
    '  LS.setItem(flag,M.id);',
    '}catch(e){}})();',
    '</script>',
    '',
  ].join('\n');
}

/**
 * 拼装单文件页面。
 *
 * 入参有两种形状，**都接受**：
 *   新（一册多章）`{ skeleton, chapters:[{ chapter, units, demos }], pageKey, finalAdvice, pet, generator }`
 *   旧（单章）    `{ skeleton, chapter, units, demos, pageKey, finalAdvice, pet, generator }`
 *
 * ⚠️ **只有一章时，产出与"支持多章之前"逐字节一致**。这是"存量自测继续全绿"的闸门，
 * 所以下面所有"只有多章才需要"的东西（目录分组、按册统计、题区 data-name…）一律用 `multi` 挡着。
 *
 * ── 一册多章最要紧的一条：**不要把已经发出去的章改名** ──
 * 作答点 id 就是进度的存盘键（引擎把进度按 `store.pts[q.id]` 存在 `localStorage[PAGE.key]` 下）。
 * 如果"再加一章"就顺手给全册的 id 加章前缀，那么**每合并一次，学员已经做过的题就全部对不上**
 * ——旧记录还在 localStorage 里，只是没有任何一道题再引用它，界面表现是"进度清零"。
 * 所以规则是：
 *   · 章对象上带 `frozen:true`（这一章以前生成过、已经交付给用户了）→ 它的 item id **一个字都不改**，
 *     只把它们登记进 `seenIds`；
 *   · 本次新生成的那一章 → 先用老的 namespace（`u.id || 'u'+(章内下标+1)`），
 *     **只有真的会与已登记的 id 撞车**时才改用 `c<章序号>-<老 namespace>`。
 * 于是最常见的那条路——"在已有的册子上再加一章"——完全不需要改名、不需要任何进度迁移。
 * 单元锚点、演示 id 用的是同一条思路（不撞不改）。
 *
 * @param {object} input
 * @param {string} input.skeleton      page-skeleton.html 全文
 * @param {Array}  [input.chapters]    [{ chapter:{subject,number,title,intro,frozen}, units:[…], demos:[…],
 *                                       key }]，`key` = 这一章单独成页时的存盘键（多章时用它把那一章的
 *                                       进度搬进册的键下，见「进度搬家」那段）
 * @param {object} [input.chapter]     旧的单章写法：{ subject, number, title, intro }
 * @param {Array}  [input.units]       旧的单章写法：[{ id, num, title, lede, lectureHtml, bank, isFinal }]
 * @param {Array}  [input.demos]       旧的单章写法：[{ id, title, markup, js, unitId, unitTitle }]
 * @param {object} input.pageKey       存盘键（一册唯一）
 * @param {string} input.finalAdvice
 * @param {'none'|'fish'|'image'} input.pet
 * @returns {{ html:string, stats:object, fixes:Array, warnings:Array }}
 */
function assemble(input) {
  const { skeleton, pageKey } = input;
  const pet = input.pet || 'none';
  const fixes = [];
  const warnings = [];

  const chapters = toChapters(input);
  const multi = chapters.length > 1;
  for (const c of chapters) {
    if (!Array.isArray(c.units) || !c.units.length) throw new Error('拼装失败：没有任何单元');
  }
  if (!pageKey || !/^[\w\-.]+$/.test(pageKey)) throw new Error('拼装失败：pageKey 不合法（' + pageKey + '）');

  /* ---------- -0. 全局槽位表 ----------
     一切"按单元算"的东西都从这里取，不再各算各的：
       lv = 槽位下标 → **跨章连续、0..N-1 无跳号**（引擎的 lvHosts 是按 data-lv 字符串建的普通对象，
       取不到就产出坏卡）。`data-lv` / `.cnt` 的 `data-cnt` / 题库里的 `q.lv` 三处必须同源，
       各算各的（按章内下标）会让两章都从 0 开始，题被渲染到错误的题区里。 */
  const chapterInfos = chapters.map((c, ci) => ({
    chapter: c.chapter,
    units: c.units,
    demos: c.demos,
    key: c.key, // 这一章单独成页时的存盘键（进度搬家要用，见 7.5 节）
    idx: ci,
    frozen: !!(c.chapter && c.chapter.frozen),
    anchorByRaw: new Map(), // 原始 unitId → 最终锚点（演示挂载点要用最终值去页面里找）
  }));
  const slots = []; // 全部单元拉平；每项带着它所属的章
  for (const info of chapterInfos) {
    info.units.forEach((u, ui) => {
      slots.push({
        info,
        chapter: info.chapter,
        unit: u,
        ui,
        lv: slots.length,
        rawAnchor: u.id || 'u' + (ui + 1), // 与改动前同源：章内下标，不是全局 lv
        anchor: '',
        namespace: '',
        lectureHtml: '',
      });
    });
  }

  /* 处理顺序：**冻结章先占坑**。
     冻结章是"以前生成过、已经交付给用户"的章（`chapter.frozen`），它的 id / 锚点一个字都不能改，
     否则旧页面里的作答记录、以及它自己正文里的 `ref.h` 回看链接就全对不上了。
     所以先让它们把 id 与锚点登记下来，新章再来时**让新章改名**——
     反过来（新章先占）会把冻结章挤去改名，而那是静默的：页面照常打开，
     只是学员在这一章的作答记录全部对不上（进度看起来被清零了）。
     没有冻结章时（含现有的单章调用）这个顺序就是 lv 升序，与改动前完全一致。 */
  const processOrder = slots
    .slice()
    .sort((a, b) => (a.info.frozen === b.info.frozen ? a.lv - b.lv : a.info.frozen ? -1 : 1));

  /* 单元锚点：**撞了才改名**。两章的单元都自动生成 `u1`/`u2` 时锚点会撞，而锚点是全页共用的
     （目录、`ref.h` 的回看链接都按它找）。不撞就一个字不改。 */
  const usedAnchors = new Set();
  for (const s of processOrder) {
    let anchor = s.rawAnchor;
    if (usedAnchors.has(anchor)) {
      anchor = 'c' + (s.info.idx + 1) + '-' + s.rawAnchor;
      let n = 2;
      while (usedAnchors.has(anchor)) anchor = 'c' + (s.info.idx + 1) + '-' + s.rawAnchor + '-' + n++;
      warnings.push(`第 ${s.info.idx + 1} 章的单元锚点 ${s.rawAnchor} 与前面某处重名，已改成 ${anchor}`);
    }
    usedAnchors.add(anchor);
    s.anchor = anchor;
    if (!s.info.anchorByRaw.has(s.rawAnchor)) s.info.anchorByRaw.set(s.rawAnchor, anchor);
  }
  /* 章标题块的锚点（目录里的章小标题链到它）。排在单元锚点之后：单元的锚点更"正式"
     （冻结章里那些 `ref.h` 回看链接按它找），冲突时让单元赢。只有多章才需要。 */
  if (multi) {
    for (const info of chapterInfos) {
      let sec = 'c' + (info.idx + 1);
      let n = 2;
      while (usedAnchors.has(sec)) sec = 'c' + (info.idx + 1) + '-' + n++;
      usedAnchors.add(sec);
      info.secId = sec;
    }
  } else {
    chapterInfos[0].secId = '';
  }
  /* ---------- -0.2 演示 id 的全局分配 ----------
     演示的 id 空间只有 `demoA…demoZ` 共 26 个（引擎与生成契约都按这个形状认）。
     两章各自生成演示时，几乎必然都从 `demoA` 开始——同一个文档里两套同名 id 会让
     `getElementById` 只返回第一个，第二章的演示**静默失灵**（拖滑块没反应、读数不动）。
     所以这里统一分配：不撞就用原来的 id，撞了才换成**第一个没用过的大写字母**。
     改名要同步三处，漏掉任何一处都是静默故障：
       ① 演示自己的 id（markup 里的 id= 与 js 里的引用）——由 renameDemoIds 一起改；
       ② 它所在章的 `units[].lectureHtml` 里的 `<!--DEMO:旧id-->` 占位（**漏这处演示会被挂到错的单元**，
          而 :512 那段兜底只会记一条 warning，极难查）；
       ③ 后面挂 js 时用的那个 id。
     ⚠️ ② 的替换**必须一次扫过**（用 Map + 单趟正则），不能一个个 replace：同章内
     `demoA→demoB`、`demoB→demoC` 这样的连环改名按顺序替换会把两处都变成 demoC。 */
  const demoPlan = [];
  const usedDemoIds = new Set();
  const demoOrder = chapterInfos
    .slice()
    .sort((a, b) => (a.frozen === b.frozen ? a.idx - b.idx : a.frozen ? -1 : 1)); // 冻结章的演示先占 id
  for (const info of demoOrder) {
    for (const d of info.demos) {
      if (!d || !d.id) continue; // 与改动前一致：没有 id 的演示直接跳过
      const origId = String(d.id);
      let id = origId;
      if (usedDemoIds.has(id)) {
        const alt = nextFreeDemoId(usedDemoIds);
        if (!alt) {
          throw new Error(
            `拼装失败：一册最多 26 个演示（demoA…demoZ），现在要给第 ${demoPlan.length + 1} 个演示 ` +
              `${origId} 找不重名的 id 却已经用满了。请把一册拆成两册，或减少演示数量。`
          );
        }
        warnings.push(`演示 ${origId} 与前面某处的演示重名，已改名为 ${alt}（不改名两章的演示会互相抢控件）`);
        id = alt;
      }
      usedDemoIds.add(id);
      // 这个演示所属单元的**最终**锚点（原始 unitId 可能因为撞车被改成 c<章>-…）：
      // 挂载点要用它去找，finalChapters 落盘时也要存最终值，否则下次合并会找错单元。
      const rawUnitId = String(d.unitId || '');
      demoPlan.push({
        d, info, id, origId,
        unitAnchor: rawUnitId ? info.anchorByRaw.get(rawUnitId) || rawUnitId : '',
        finalMarkup: '',
        finalJs: '',
      });
    }
  }
  for (const s of slots) {
    const renames = new Map();
    for (const p of demoPlan) {
      if (p.info === s.info && p.origId !== p.id) renames.set(p.origId, p.id);
    }
    const raw = String(s.unit.lectureHtml || '');
    s.lectureHtml = renames.size
      ? raw.replace(/<!--DEMO:([\w.-]+)-->/g, (m, id) => (renames.has(id) ? `<!--DEMO:${renames.get(id)}-->` : m))
      : raw;
  }

  /* ---------- -0.3 正文里嵌的 id：跨章去重（**只有多章才做**） ----------
   *
   * 为什么必须做：模型写的讲解正文里带着自己的锚点（契约要求 `<h3>` 上有形如 `id="k1311"`
   * 的稳定 id，题库的「回看」链接按它找）。**这些 id 是章内自洽的，跨章没有任何机制区分** ——
   * 两章各自从同一套编号开始时（模型按"章内第几个单元第几个知识块"编号，这在同一个提示词下
   * 是最自然的写法），页面里就出现两套同名 id：`getElementById` 只返回第一个，
   * 另一章的回看链接全部指到前一章去。
   *
   * 不处理的话，拼装末尾的全页 id 自检会**当场判失败**（那是对的，宁可不发也不发一份坏页），
   * 但用户拿到的是"拼装自检失败：页面上有重复的 id" —— 他做不了任何事，只能换模型重跑。
   * 而这里其实有一个和"单元锚点""演示 id"完全同源的解：**不撞不改**。
   *
   * ⚠️ 只在 `multi` 时做。单章时章内重名是**模型自己写错了**，那种错值得当场炸出来
   * （现有的敌意输入测试正是压着它），不该被这里悄悄抹平。
   * ⚠️ 走 `processOrder`（冻结章先占 id），与锚点/演示同一套顺序：要让**新章**改名。
   */
  if (multi) {
    const usedInnerIds = new Set();
    for (const s of processOrder) {
      const html = String(s.lectureHtml || '');
      const rename = new Map();
      const withIds = html.replace(/(\sid\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'>]+))/gi, (m, pre, q, quoted, bare) => {
        const id = quoted !== undefined ? quoted : bare;
        if (!id || !usedInnerIds.has(id)) { if (id) usedInnerIds.add(id); return m; }
        let alt = 'c' + (s.info.idx + 1) + '-' + id;
        let n = 2;
        while (usedInnerIds.has(alt)) alt = 'c' + (s.info.idx + 1) + '-' + id + '-' + n++;
        usedInnerIds.add(alt);
        rename.set(id, alt);
        return q ? pre + q + alt + q : pre + alt;
      });
      if (!rename.size) { s.lectureHtml = html; continue; }
      /* 正文里指向自己的链接要**跟着一起改**：只改 id 不改 `href="#…"`，
         那些链接会指到**前一章的**同名锚点上去（点一下跳到别章，而且没有任何报错）。 */
      s.lectureHtml = withIds.replace(/(\shref\s*=\s*)(?:(["'])#([^"']*)\2|#([^\s"'>]+))/gi,
        (m, pre, q, quoted, bare) => {
          const id = quoted !== undefined ? quoted : bare;
          if (!id || !rename.has(id)) return m;
          return q ? pre + q + '#' + rename.get(id) + q : pre + '#' + rename.get(id);
        });
      /* 题库的「回看」链接存在 bank 里（不在这段 HTML 里），单独记下来，
         等题库规范化之后一并改（见下面 ref 校验之前那一段）。
         不改的后果不是"链接坏掉"而是**链接被摘掉**：第 3 节的死链检查发现 `#k1311` 不存在，
         把整条 ref 删掉、只记一条 fix —— 学员觉得"这题怎么没有回看"，没人知道为什么。 */
      s.innerIdMap = rename;
      warnings.push(`第 ${s.info.idx + 1} 章的正文里有 ${rename.size} 个锚点与前面某处重名，`
        + `已改成 c${s.info.idx + 1}-…（不改名的话这些锚点全都会指到前一章去）`);
    }
  }
  const firstChapter = chapterInfos[0].chapter;
  let h = skeleton;

  /* ---------- -1. 给交付页装一条 CSP ----------
     这一页会被**真的执行**三次（应用内预览、自动校验的隐藏窗口、用户双击打开）。
     内容来自模型、模型读的是用户的课件——所以必须假设页面里可能出现不该有的东西。
     这条 CSP 不改变任何既有功能（引擎与演示都是内联 script，图片是同目录文件或 data URI），
     但掐死了"把读到的内容往外发"这条路。 */
  assertOnce(h, '<meta charset="utf-8">', '<meta charset="utf-8">');
  const CSP =
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: file:; " +
    "font-src 'self' data:; " +
    "media-src 'self' data: file:; " +
    "connect-src 'none'; frame-src 'none'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'";
  h = h.replace(
    '<meta charset="utf-8">',
    () => '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
  );

  /* ---------- 0. 题库：规范化 + 校验（不合格的在这里就炸出来，别拼出一份残缺的页） ----------
     `seenIds` 跨**全册**共用：两章的题 id 撞了同样会让两题共用一个存盘键。

     namespace 的取舍见文件头那段：**冻结章一个字都不改**（它的 id 已经跟着 localStorage 里的
     作答记录发出去了），新章也只在"真会撞车"时才加 `c<章序号>-` 前缀。
     按 `processOrder` 走（冻结章先占 id），新章撞车时改的才是新章自己。
     没有冻结章时（含现有的单章调用）processing 顺序就是 lv 升序：单章时 seenIds 一开始是空的，
     "撞车"只可能发生在同一个章内——那是改动前就有的情形，仍旧交给 normalizeBank 自己改名
     （并记一条 fix），行为与从前完全一致。 */
  const seenIds = new Set();
  const bankErrors = [];
  const normalizedByLv = new Array(slots.length);
  for (const s of processOrder) {
    const ns0 = s.rawAnchor;
    let ns = ns0;
    if (s.info.frozen) {
      ns = ''; // 冻结章：沿用 items 里已经写好的 q.id，只登记进 seenIds
    } else if (multi && prospectiveIds(s.unit.bank, ns0).some((id) => seenIds.has(id))) {
      ns = 'c' + (s.info.idx + 1) + '-' + ns0;
      warnings.push(
        `第 ${s.info.idx + 1} 章「${s.unit.title || s.rawAnchor}」的题目 id 与别的章撞车，` +
          `已把这一章的前缀改成 ${ns}`
      );
    }
    s.namespace = ns;
    const res = normalizeBank(s.unit.bank, { lv: s.lv, namespace: ns, seenIds });
    for (const fx of res.fixes) fixes.push({ unit: s.unit.title, message: fx.message });
    for (const it of res.issues) bankErrors.push({ unit: s.unit.title, message: it.message });
    normalizedByLv[s.lv] = res.items;
  }
  // 题库段仍按**页面顺序**落盘（bank0..bankN 与 .qlist[data-lv] 一一对应）
  const normalized = normalizedByLv;
  if (bankErrors.length) {
    const err = new Error(`题库有 ${bankErrors.length} 处不合格，无法拼装`);
    err.bankErrors = bankErrors;
    throw err;
  }

  const stat = countPoints(normalized.flat());
  if (!stat.total) throw new Error('拼装失败：题库里一个作答点都没有');

  /* ---------- 1. 标题 / 页头（只有一章时逐字沿用旧文案） ---------- */
  const DEFAULT_INTRO = '上面讲解、下面就是题；每个小节讲完紧跟着这一节的练习。';
  const chapterTitles = chapterInfos
    .map((c) => String(c.chapter.title || '').trim())
    .filter(Boolean);
  const subjectTxt = multi
    ? String(chapterInfos.map((c) => c.chapter.subject || '').find(Boolean) || '课件')
    : firstChapter.subject || '课件';
  const numTxt = multi ? '' : firstChapter.number ? `第 ${firstChapter.number} 章` : '';
  const eyebrow = multi
    ? [subjectTxt, `共 ${chapters.length} 章`, '讲练一体'].filter(Boolean).join(' · ')
    : [subjectTxt, numTxt, '讲练一体'].filter(Boolean).join(' · ');
  const pageTitle = multi
    ? chapterTitles.join(' · ') || '讲练一体'
    : [numTxt, firstChapter.title].filter(Boolean).join(' · ') || '讲练一体';

  assertOnce(h, '</title>', '</title>');
  h = h.replace(MARK.title, () => `<title>${escapeHtml(pageTitle)} · 讲练一体</title>`);

  assertOnce(h, '<header class="top">', '<header class="top">');
  const demoCount = chapterInfos.reduce(
    (n, c) => n + c.demos.filter((d) => d && (d.js || d.markup)).length,
    0
  );
  const facts = [];
  facts.push(`    <div><b>${stat.total}</b><span>个作答点</span></div>`);
  facts.push(`    <div><b>${slots.length}</b><span>个单元</span></div>`);
  // 一册多章时把章数也报出来：页头那几个数字是学员判断"这一册有多大"的唯一依据
  if (multi) facts.push(`    <div><b>${chapters.length}</b><span>章</span></div>`);
  if (demoCount) facts.push(`    <div><b>${demoCount}</b><span>个可拖演示</span></div>`);
  h = h.replace(
    MARK.header,
    () =>
      [
        '<header class="top"><div class="top-inner">',
        `  <span class="eyebrow">${escapeHtml(eyebrow)}</span>`,
        `  <h1>${escapeHtml(multi ? chapterTitles.join(' · ') || '讲练一体' : firstChapter.title || pageTitle)}</h1>`,
        `  <p class="sub">${escapeHtml(multi ? DEFAULT_INTRO : firstChapter.intro || DEFAULT_INTRO)}</p>`,
        '  <div class="facts">',
      ]
        .concat(facts)
        .concat(['  </div>', '</div></header>'])
        .filter(Boolean)
        .join('\n')
  );

  /* ---------- 2. 正文：讲解 + 紧跟的题区 ---------- */
  assertOnce(h, MARK.contentStart, '正文起始注释');
  assertOnce(h, MARK.contentEnd, '结算区 <section id="result">');
  const i0 = h.indexOf(MARK.contentStart);
  const i1 = h.indexOf(MARK.contentEnd, i0);
  if (i1 < 0) throw new Error('拼装失败：结算区在正文起始注释之前，骨架顺序不对');

  const bodyParts = [];
  /* 本页地图：长页面靠锚点跳转，不做标签页（切页会丢滚动位置——见 SKILL.md 形态铁律第 1 条）。
     ⚠️ 锚点要指向**讲解区**，不是题区。
     以前这里是 `#p-l${i}`（题区），而链接文字用的是讲解标题 —— 于是点「13.1 磁化」
     会直接跳过 13.1 整节讲解、落到 13.1 的题上（实测：讲解区 y=632，落点 y=1736）。
     这一行是页面唯一的导航手段，指错了等于导航不可用。
     多章时按章分组（每章一个小标题 + 它下面的单元链接）：一册好几章、几十个小节，
     一条平铺的链接串根本找不到"第 14 章在哪"。 */
  if (multi) {
    const toc = [
      '  <div class="card" id="howto">',
      '    <h4>这一页怎么用</h4>',
      `    <p>一册到底，不用切页：每个小节讲完，紧接着就是这一节的题；每一章最后是综合大题，全册最后是学习结算。共 ${chapters.length} 章、${slots.length} 个单元、${stat.total} 个作答点。</p>`,
      '    <p style="margin-bottom:0">跳到：</p>',
    ];
    for (const info of chapterInfos) {
      const mine = slots.filter((s) => s.info === info);
      if (!mine.length) continue;
      toc.push(`    <p style="margin:.5em 0 .2em"><a href="#${escapeHtml(info.secId)}"><b>${escapeHtml(chapterLabel(info.chapter, info.idx))}</b></a></p>`);
      toc.push(
        '    <p style="margin:0 0 .2em 1.2em">' +
          mine
            .map(
              (s) =>
                `<a href="#${escapeHtml(s.anchor)}">${escapeHtml(
                  s.unit.shortTitle || s.unit.title || '第 ' + (s.ui + 1) + ' 节'
                )}</a>`
            )
            .join(' · ') +
          '</p>'
      );
    }
    toc.push('  </div>');
    bodyParts.push(toc.join('\n'));
  } else {
    bodyParts.push(
      [
        '  <div class="card" id="howto">',
        '    <h4>这一页怎么用</h4>',
        '    <p>一页到底，不用切页：每个小节讲完，紧接着就是这一节的题；全章最后是综合大题与学习结算。</p>',
        '    <p style="margin-bottom:0">跳到：',
        slots
          .map(
            (s) =>
              `<a href="#${escapeHtml(s.anchor)}">${escapeHtml(
                s.unit.shortTitle || s.unit.title || '第 ' + (s.ui + 1) + ' 节'
              )}</a>`
          )
          .join(' · '),
        '    </p>',
        '  </div>',
      ].join('\n')
    );
  }

  slots.forEach((s) => {
    const u = s.unit;
    const info = s.info;
    /* 多章时给每章开头插一个章标题。一册几百道题、几十个小节，没有章标题就分不清
       自己翻到哪一章了；目录里的章分组也才有落点。 */
    if (multi && s.ui === 0) {
      bodyParts.push('');
      bodyParts.push(`  <section id="${escapeHtml(info.secId)}">`);
      bodyParts.push(
        `    <h2><span class="num">第 ${escapeHtml(String(info.chapter.number || info.idx + 1))} 章</span>${escapeHtml(
          String(info.chapter.title || '')
        )}</h2>`
      );
      if (info.chapter.intro) bodyParts.push(`    <p class="lede">${escapeHtml(info.chapter.intro)}</p>`);
      bodyParts.push('  </section>');
    }
    bodyParts.push('');
    bodyParts.push(`  <section id="${escapeHtml(s.anchor)}">`);
    bodyParts.push(
      `    <h2><span class="num">${escapeHtml(u.num || String(s.ui + 1))}</span>${escapeHtml(u.title || '第 ' + (s.ui + 1) + ' 节')}</h2>`
    );
    if (u.lede) bodyParts.push(`    <p class="lede">${escapeHtml(u.lede)}</p>`);
    // 模型写的正文先过一遍清洗器（见 sanitizeModelHtml 的说明：这一页会被真的执行）
    const cleanProse = sanitizeModelHtml(s.lectureHtml);
    if (cleanProse.removed.length) {
      fixes.push({ unit: u.title, message: `正文里清掉了不该有的东西：${[...new Set(cleanProse.removed)].join('、')}` });
    }
    s.pageHtml = cleanProse.html; // 真正进页面的那一份（finalChapters 落盘时用它）
    bodyParts.push(indent(cleanProse.html, 4));
    bodyParts.push('  </section>');
    bodyParts.push('');
    /* 多章时题区上挂一个 data-name。引擎取关卡名是 `data-name` **优先于** h2
       （quiz-engine.js:206），所以"两章都有『小结』、结算区分不清是哪个小结"这个问题
       一行属性就解决了，不用动引擎。单章不加：h2 已经够用，而加了会改变既有产出。 */
    const dataName = multi
      ? ` data-name="${escapeHtml(
          [`第 ${info.chapter.number || info.idx + 1} 章`, [u.num, u.title].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(' ')
        )}"`
      : '';
    bodyParts.push(`  <section class="qsec" id="p-l${s.lv}"${dataName}>`);
    // 题区标题用模型给的 qsecTitle（契约 §0 的警告：它和讲解标题是两回事，
    // 结算条上的关卡名取自**题区** h2，用错了会在结算区显示成讲解标题）。
    // 兜底必须是「练一练 · X」——引擎只在 .num 是单个「练」字时才剥它，别的写法都会把关卡名弄花。
    const qsecTitle =
      u.qsecTitle && /^练一练/.test(u.qsecTitle)
        ? u.qsecTitle
        : `练一练 · ${u.shortTitle || u.title || '第 ' + (s.ui + 1) + ' 节'}`;
    s.qsecTitle = qsecTitle; // 生效的那一个（finalChapters 落盘时用它，别再让调用方猜兜底规则）
    bodyParts.push(`    <h2><span class="num">练</span>${escapeHtml(qsecTitle)}<span class="cnt" data-cnt="${s.lv}"></span></h2>`);
    if (u.quizLede || u.lede) bodyParts.push(`    <p class="lede">${escapeHtml(u.quizLede || u.lede)}</p>`);
    bodyParts.push(`    <div class="qlist" data-lv="${s.lv}"></div>`);
    bodyParts.push('  </section>');
  });

  h = h.slice(0, i0) + bodyParts.join('\n') + '\n\n' + h.slice(i1);

  /* ---------- 2.9 正文锚点改过名的，题库里的「回看」跟着改 ----------
     必须在下面的死链校验**之前**：晚一步，那些链接就会被当成死链静默摘掉。 */
  for (const s of slots) {
    if (!s.innerIdMap || !s.innerIdMap.size) continue;
    for (const q of normalized[s.lv] || []) {
      const targets = q.type === 'big' ? q.parts || [] : [q];
      for (const t of targets) {
        if (!t || !t.ref || !t.ref.h) continue;
        const id = String(t.ref.h).replace(/^#/, '');
        if (s.innerIdMap.has(id)) t.ref.h = '#' + s.innerIdMap.get(id);
      }
    }
  }

  /* ---------- 3. ref 锚点校验（在题库落进页面之前做，省得改完再序列化一次） ---------- */
  const idSet = new Set();
  for (const m of h.matchAll(/\sid="([^"]+)"/g)) idSet.add(m[1]);
  // 题区宿主与单元外壳的 id 也要算进去
  slots.forEach((s) => {
    idSet.add(s.anchor);
    idSet.add('p-l' + s.lv);
  });
  let deadRefs = 0;
  for (const items of normalized) {
    for (const q of items) {
      const targets = q.type === 'big' ? q.parts || [] : [q];
      for (const t of targets) {
        if (t && t.ref && t.ref.h) {
          const raw = String(t.ref.h);
          if (!raw.startsWith('#') || !idSet.has(raw.slice(1))) {
            delete t.ref;
            deadRefs++;
          }
        }
      }
    }
  }
  if (deadRefs) fixes.push({ unit: '—', message: `摘掉了 ${deadRefs} 处指向不存在位置的「回看」链接` });

  /* ---------- 4. 题库：一段一个单元，JSON 由我们序列化 ---------- */
  assertOnce(h, '<script data-bank id="bank0" type="application/json">', '题库锚点 bank0');
  const bankHtml = normalized
    .map(
      (items, i) =>
        `<script data-bank id="bank${i}" type="application/json">\n` + jsonForScript(items) + '\n</script>'
    )
    .join('\n\n');
  h = h.replace(MARK.bankBlock, () => bankHtml); // 用函数形式：避免 $& 之类的替换模式被解释

  /* ---------- 5. 引擎区间：PAGE 配置 ----------
     这一节以及下面的演示槽，全部**只在引擎脚本那一小段里替换**。
     原因：正文是模型写的、不可信，它完全可能"引用"骨架里的配置原文（例如讲解里贴一段
     `petImages:['pet.png']` 做例子）。全局 replace 会改到正文那一处、放过引擎里真正该改的那处，
     症状是"用户明明选了不要陪练，右下角还是冒出陪练"——而且一声不响。 */
  assertOnce(h, MARK.engineOpen, '引擎脚本起点');
  const engStart = h.indexOf(MARK.engineOpen);
  // 引擎区间 = 从 <script id="engine"> 到 </body>。
  // ⚠️ 不能用 <footer> 当终点：骨架里 footer 排在**引擎之前**（footer → 题库 → 引擎）。
  const bodyEnd = h.indexOf('</body>', engStart);
  if (bodyEnd < 0) throw new Error('拼装失败：引擎脚本之后找不到 </body>，骨架结构不对');
  let eng = h.slice(engStart, bodyEnd);

  /* 计数一律以**引擎原文**为准，而不是"被前面几次 patch 改过之后的 eng"。
     ⚠️ 踩过：`finalAdvice` 是**注入到引擎区间里**的，而它的内容来自模型。
     收尾语里只要出现一次 `petImages:[…]` 的字面量（比如在讲"陪练图是怎么配的"），
     后面对 `PAGE.petImages` 的计数就从 1 变成 2 → 直接抛错 → **整单失败、一个 HTML 都不产出**，
     而错误信息还把人往"骨架页被改过"上引。用户选了"不要陪练"时必现。
     （实测复现：`test/_audit/v1/t6-prompts-map.js` C1）
     拿原文计数之后，任何"前一次 patch 注入进来的文本"都不可能再影响后一次的计数。 */
  const engOriginal = eng;

  function patchEngine(re, repl, what) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const hits = engOriginal.match(new RegExp(re.source, flags));
    const count = hits ? hits.length : 0;
    if (count !== 1) {
      throw new Error(
        `拼装失败：引擎脚本里的「${what}」应该恰好出现 1 次，实际 ${count} 次。` +
          '这说明 skills/interactive-study-guide/assets/page-skeleton.html 的引擎被改过——' +
          '请对照 apps/isg-studio/docs/architecture.md 更新 assemble.js 的锚点。'
      );
    }
    eng = eng.replace(re, repl);
  }

  patchEngine(MARK.pageKey, (m, ws) => `${ws}key:'${pageKey}',`, 'PAGE.key');
  if (pet === 'none') {
    // 用户选了"不要陪练"：清空图片名清单，右下角就什么都不出现（引擎不内置任何小人）
    patchEngine(MARK.petImages, () => 'petImages:[]', 'PAGE.petImages');
    patchEngine(MARK.bgImages, () => 'bgImages:[]', 'PAGE.bgImages');
  }
  /* ⚠️ finalAdvice 必须放在**最后一个** patch：它是唯一一处把"模型给的文本"注入引擎区间的，
     而后面若还有 patch，注入进去的那段文字就可能被当成锚点命中（计数、替换都会错位）。
     目前它就是最后一个。 */
  if (input.finalAdvice) {
    // finalAdvice 落在 <script id="engine"> 内部，必须走 jsonForScript 转义：
    // 一句带 `</script>` 的收尾语会让解析器提前闭合引擎 → 整页没有任何 JS，而任务照报"完成"。
    patchEngine(
      MARK.finalAdvice,
      (m, ws) => `${ws}finalAdvice:${jsonForScript(String(input.finalAdvice))},`,
      'PAGE.finalAdvice'
    );
  }
  h = h.slice(0, engStart) + eng + h.slice(bodyEnd);

  /* ---------- 6. 演示：标记替换 + JS 塞进引擎的演示槽 ---------- */
  const demoJs = [];
  for (const p of demoPlan) {
    const d = p.d;
    const id = p.id; // 全局分配后的 id（不撞车时就是模型给的那个）
    const ph = `<!--DEMO:${id}-->`;
    if (d.markup) {
      const cleanMark = sanitizeModelHtml(d.markup);
      if (cleanMark.removed.length) {
        fixes.push({ unit: id, message: `演示标记里清掉了不该有的东西：${[...new Set(cleanMark.removed)].join('、')}` });
      }
      d.markup = cleanMark.html;
      // 改了名就同步改演示自己这一族的 id 引用（标记里的 id= 与 js 里的 getElementById）
      const markup = renameDemoIds(d.markup, p.origId, id);
      p.finalMarkup = markup; // finalChapters 落盘的是"最终形态"，见第 10 节
      if (h.includes(ph)) {
        h = h.replace(ph, () => markup);
      } else {
        // 挂到**该演示所属单元**的题区之前；连单元都找不到才退到第一个题区。
        // （以前统一挂到末尾、日志却说"最后一个单元"，位置和日志都不对）
        let placed = false;
        // 单元锚点可能因为重名被改过名（见上面 usedAnchors 那段），页面里要找**最终**那个
        const rawUnitId = String(d.unitId || '');
        const anchor = rawUnitId ? p.info.anchorByRaw.get(rawUnitId) || rawUnitId : '';
        const owner = anchor ? h.indexOf(`<section id="${anchor}"`) : -1;
        if (owner > 0) {
          const qsec = h.indexOf('<section class="qsec"', owner);
          if (qsec > 0) {
            h = h.slice(0, qsec) + markup + '\n\n' + h.slice(qsec);
            placed = true;
            warnings.push(`演示 ${id} 的占位注释没出现在正文里，已挂到「${d.unitTitle || rawUnitId}」的题区之前`);
          }
        }
        if (!placed) {
          const firstQsec = h.indexOf('<section class="qsec"', i0);
          if (firstQsec > 0) {
            h = h.slice(0, firstQsec) + markup + '\n\n' + h.slice(firstQsec);
            warnings.push(`演示 ${id} 没找到所属单元，已挂到第一个题区之前`);
          } else {
            warnings.push(`演示 ${id} 找不到任何可以挂载的位置，已丢弃`);
          }
        }
      }
    }
    if (d.js) {
      // 先留一份"最终形态"再套 jsForScript：落盘的是改名后的原始 js（不带 </script 转义、
      // 也不带下面那层 try/catch 外壳 —— 那些是"嵌进页面"时才要做的事）。
      p.finalJs = renameDemoIds(String(d.js).trim(), p.origId, id);
      const js = jsForScript(p.finalJs);
      // 契约 §1.5 要求模型自己把 js 写成 try{…}catch(e){…}；它已经包好了就不再套一层
      // （套两层不是错，但会让"演示自己抛错"的堆栈多一层噪音，排查时容易看错）
      if (/^try[ \t]*[{]/.test(js)) demoJs.push(`/* ${d.title || id} —— 由工作台校验 */\n${js}`);
      else
        demoJs.push(
          `/* ${d.title || id} —— 由工作台补上兜底 try/catch 的演示 */\n` +
            `try{\n${js}\n}catch(e){ console.error('[演示 ${id}] 出错：', e); }`
        );
    }
  }
  if (demoJs.length) {
    assertOnce(h, MARK.demoSlot, '演示槽注释');
    assertOnce(h, MARK.demoSlotEnd, '演示槽结束标记');
    const s2 = h.indexOf(MARK.demoSlotEnd);
    h = h.slice(0, s2) + demoJs.join('\n\n') + '\n\n    ' + h.slice(s2);
  }
  /* 没被替换掉的占位注释会原样留在页面上（页面上多出一行 `<!--DEMO:demoB-->` 文本，
     或者更糟：演示被别处的兜底逻辑挂到了错的单元）。改动前这种情况一声不响，这里至少留个记号。 */
  {
    const left = [...h.matchAll(/<!--DEMO:([\w.-]+)-->/g)].map((m) => m[1]);
    if (left.length) {
      warnings.push(`有 ${left.length} 处演示占位注释没被替换掉（${[...new Set(left)].join('、')}）：正文里的 <!--DEMO:…--> 与演示的 id 对不上`);
    }
  }

  /* ---------- 7. 陪练默认形象：内置大肥鱼 ---------- */
  if (pet === 'fish') {
    assertOnce(h, MARK.engineOpen, '引擎脚本起点');
    const seed =
      '<script>\n' +
      '/* 工作台生成时默认选用内置「大肥鱼」形象。已经自己改过偏好的用户不会被覆盖。 */\n' +
      '(function(){try{\n' +
      `  var k=${JSON.stringify(pageKey)};\n` +
      "  var s=JSON.parse(localStorage.getItem(k)||'{}')||{};\n" +
      '  s.ui=s.ui||{};\n' +
      "  if(s.ui.petArt!=='image'&&s.ui.petArt!=='fish') s.ui.petArt='fish';\n" +
      '  if(s.ui.pet===undefined) s.ui.pet=true;\n' +
      '  localStorage.setItem(k,JSON.stringify(s));\n' +
      '}catch(e){}})();\n' +
      '</script>\n';
    h = h.replace(MARK.engineOpen, () => seed + MARK.engineOpen);
  }

  /* ---------- 7.5 进度搬家：把「那一章单独成页」时的作答记录搬到册的键下 ----------
     位置有两个硬要求：
       · 必须在 `<script id="engine">` **之前** —— 引擎是在脚本解析时把 `localStorage[KEY]`
         读成快照的（quiz-engine.js:34-38），晚一步跑就等于没跑，而症状与"根本没做这件事"一样。
       · 排在陪练预置脚本（上一节）之后 —— 那段会先写好 `ui.petArt/pet`，搬家按"目标里没有才补"
         来填，于是**册这一层的陪练选择优先**，而旧章的陪练位置/大小/模式照样搬过来。
     不搬家时（单章、或各章的键与册的键相同）什么都不注入：单章产出必须逐字节不变。 */
  {
    const move = progressMovePayload(chapterInfos, slots, normalized, pageKey, multi);
    if (move) {
      assertOnce(h, MARK.engineOpen, '引擎脚本起点');
      // 载荷里的来源键来自调用方，走 jsonForScript 转义（与 finalAdvice、题库同一套）：
      // 里面只要出现一个 `</script`，解析器就会提前闭合这段脚本，整段搬家静默失效。
      h = h.replace(MARK.engineOpen, () => migrationScript(move) + MARK.engineOpen);
    }
  }

  /* ---------- 8. 页脚 ---------- */
  assertOnce(h, '<footer>', '<footer>');
  const fparts = [];
  // 带上生成它的版本号：出问题时第一句话往往是"这页是哪个版本生成的"，
  // 而后台报错、界面截图都不一定看得出构建时间。成本是一行字。
  const byline = input.generator ? `本页由「${input.generator}」依课件生成` : '本页由「讲练一体工作台」依课件生成';
  fparts.push(byline + '：讲解与练习紧挨着，点选项/填数值立刻判分，进度存在本机浏览器里。');
  if (multi) {
    fparts.push(
      `一册共 ${chapters.length} 章、${slots.length} 个单元、${stat.total} 个作答点` +
        `（概念题 ${stat.byType.single + stat.byType.multi}、计算题 ${stat.byType.num}、综合大题 ${stat.byType.big}）。`
    );
  } else {
    fparts.push(
      `共 ${stat.total} 个作答点（概念题 ${stat.byType.single + stat.byType.multi}、计算题 ${stat.byType.num}、综合大题 ${stat.byType.big}）。`
    );
  }
  fparts.push('建议在手机或平板上看：电脑上跑 <code>python -m http.server 8000</code>，手机同 Wi-Fi 访问即可。');
  h = h.replace(MARK.footer, () => `<footer><p style="margin-bottom:0">${fparts.join(' ')}</p></footer>`);

  /* ---------- 9. 交付前自检：必备 DOM / 题区宿主 / script 配平 ---------- */
  const must = [
    'id="s-done"', 'id="s-total"', 'id="s-rate"', 'id="s-wrong"', 'id="s-fill"',
    'id="onlyWrong"', 'id="resetAll"',
    'id="r-done"', 'id="r-rate"', 'id="r-wrong"', 'id="r-verdict"', 'id="r-bars"',
    'id="r-advicetext"', 'id="goWrong"', 'id="goAll"',
    'id="engine"',
  ];
  const missing = must.filter((m) => !h.includes(m));
  if (missing.length) throw new Error('拼装自检失败，缺少必备 DOM：' + missing.join(', '));
  slots.forEach((s) => {
    if (!h.includes(`data-lv="${s.lv}"`)) throw new Error(`拼装自检失败：缺少第 ${s.lv} 个题区宿主 .qlist[data-lv="${s.lv}"]`);
  });
  /* ---- 跨章撞车的机器防线 ----
     下面这几条全是"撞了会静默"的故障：页面能打开、不报错，只是某些题永远答不对、
     或者两章的题共用一份进度。多章时才当硬错误——单章时它们（除了 lv 那条）都是既有行为，
     一册只有一章本来就撞不起来，把既有的产出判成失败没有意义。 */
  // ① data-lv 必须恰好是 0..N-1 各一次（引擎的 lvHosts 是对象，跳号/重号都会产出坏卡）
  {
    const lvs = [...h.matchAll(/data-lv="(\d+)"/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(lvs)].sort((a, b) => a - b);
    const want = slots.map((s) => s.lv);
    if (lvs.length !== slots.length || uniq.length !== want.length || uniq.some((v, i) => v !== want[i])) {
      throw new Error(
        `拼装自检失败：题区宿主 .qlist 的 data-lv 应该是 ${want.join(',')}（0..${want.length - 1} 各一次），` +
          `实际出现的是 ${lvs.join(',')}。`
      );
    }
  }
  // ② 所有作答点 id 全局唯一（含 big 的 parts 派生 id）——重复 = 两题共用一个存盘键
  {
    const ids = [];
    for (const items of normalized) for (const q of items) for (const x of endpointsOf(q)) if (x.id) ids.push(x.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) {
      throw new Error(`拼装自检失败：作答点 id 重复（${[...new Set(dup)].join('、')}），两题会共用一份作答记录。`);
    }
  }
  // 一段正文里出现未闭合的 <!-- 会把它之后的**整个页面**（含题库与引擎）吞成注释，
  // 而浏览器一声不响。这里按数量配平来挡：注释开闭必须成对。
  // ⚠️ 必须先把 <script> 段整段剔掉再数：JSON 里的 `-->` 只是普通文本（`<` 已被转义成
  //    `<`，但 `>` 没有），拿它当注释结尾会让检查误报（实测踩到过）。
  const markupOnly = h.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const cmtOpen = (markupOnly.match(/<!--/g) || []).length;
  const cmtClose = (markupOnly.match(/-->/g) || []).length;
  if (cmtOpen !== cmtClose) {
    // 把嫌疑位置一并报出来。不说清楚的话，用户拿着一份十几万字的页面根本无从下手。
    const spots = [];
    let k = -1;
    while ((k = markupOnly.indexOf('-->', k + 1)) >= 0 && spots.length < 3) {
      spots.push('…' + markupOnly.slice(Math.max(0, k - 36), k + 3).replace(/\s+/g, ' ') + '…');
    }
    throw new Error(
      `拼装自检失败：HTML 注释开标记 ${cmtOpen} 个、闭标记 ${cmtClose} 个，配不平。` +
        '这种情况会让注释之后的所有内容（题库、引擎）被浏览器当成注释吞掉，而页面完全不报错。' +
        (spots.length ? ' 疑似位置：' + spots.join(' ｜ ') : '')
    );
  }
  const scriptOpen = (h.match(/<script\b/gi) || []).length;
  const scriptClose = (h.match(/<\/script>/gi) || []).length;
  if (scriptOpen !== scriptClose) {
    throw new Error(
      `拼装自检失败：script 开标签 ${scriptOpen} 个、闭标签 ${scriptClose} 个，配不平。` +
        '多半是某段模型内容里带了 `</script>`，把引擎提前闭合了。'
    );
  }

  /* ---- ③④ 只有在"真正的 DOM"里查才有意义 ----
     ⚠️ 必须先剔掉 <script> 段与 <!-- 注释 -->：`id="…"` 出现在注释里（骨架页的演示槽注释
     就写着 `建议 <div class="demo" id="demoA">…</div>` 当例子）或 JSON 里都**不会**进 DOM，
     拿原文去数会把骨架自己的说明文字当成撞车，一册多章时每单都误报。
     排在注释/脚本配平检查之后：配不平的时候先报那个更根本的问题。 */
  const domOnly = markupOnly.replace(/<!--[\s\S]*?-->/g, '');
  if (multi) {
    // ③ 页面里**静态**写着的 `id="q-…"` 必须与题库对得上：引擎渲染出来的题卡就是 `q-<id>`，
    //    正文里若混进一个同名的静态 id，getElementById 会拿到错的那个，判分/「重做本题」全歪。
    const known = new Set();
    for (const items of normalized) for (const q of items) for (const x of endpointsOf(q)) if (x.id) known.add(x.id);
    const bad = [];
    const seenStatic = new Set();
    for (const m of domOnly.matchAll(/\sid="q-([^"]+)"/g)) {
      if (!known.has(m[1]) || seenStatic.has(m[1])) bad.push(m[1]);
      seenStatic.add(m[1]);
    }
    if (bad.length) {
      throw new Error(
        `拼装自检失败：页面里有静态 id="q-…" 与题库对不上或重复（${[...new Set(bad)].join('、')}）。` +
          '引擎渲染的题卡 id 就是 `q-<作答点 id>`，正文里再出现一个同名的会抢走 getElementById。'
      );
    }

    // ④ 全页 id 无重复（多章时两套同名的 id 会让 getElementById 只认第一个）
    const first = new Map(); // id → 第一次出现的顺序
    const hits = new Map(); // id → [位置…]
    let n = 0;
    for (const m of domOnly.matchAll(/\sid="([^"]+)"/g)) {
      const id = m[1];
      if (!first.has(id)) first.set(id, n);
      if (!hits.has(id)) hits.set(id, []);
      hits.get(id).push(m.index);
      n++;
    }
    const dups = [...hits.keys()].filter((id) => hits.get(id).length > 1);
    if (dups.length) {
      // 报错要带**位置**：一份十几万字的页面，只说"id 重复"用户根本无从下手
      const where = dups.slice(0, 3).map((id) => {
        const spots = hits
          .get(id)
          .slice(0, 2)
          .map((k) => '…' + domOnly.slice(Math.max(0, k - 40), k + 40).replace(/\s+/g, ' ') + '…');
        return `  ${id}（第 ${first.get(id) + 1} 处）\n      ${spots.join('\n      ')}`;
      });
      throw new Error(
        `拼装自检失败：页面上有重复的 id：${dups.slice(0, 5).join('、')}。` +
          '同一个文档里两套同名 id 会让 getElementById 只返回第一个（另一处静默失灵）。\n' +
          where.join('\n')
      );
    }
  }

  /* ---------- 10. finalChapters：给调用方落盘的「最终形态」 ----------
     为什么要有它：调用方（生成流程）要把每一章的结构化数据存下来，供**以后合并成一册**用。
     存的时候必须存**命名空间生效之后**的题库 id，否则会出这种静默故障：
       · 旁挂数据里存的是原始的 `u1-s1`，而页面题库里的题号是 `s131-u1-s1`；
       · 带过来的章被冻结时 namespace 变成空串、id 保持原样（`u1-s1`），
         于是**学员按 `s131-u1-s1` 存的那些记录一条都读不出来** —— 页面看着完全正常。
     这件事**不能交给调用方自己再算一遍**：那等于把"命名空间怎么定"这套规则复制两份，
     两份规则迟早走散，而走散的后果又是静默的（id 对不上 → 进度丢）。
     所以由这里 —— 唯一知道最终结果的地方 —— 把它整个交出去。

     形状：与传入的 `chapters[]` **一一对应、同序**，且是纯数据（没有函数、没有循环引用），
     调用方可以直接 JSON.stringify 落盘：
       { chapter, key, units:[{ …传入的字段, id:最终锚点, lectureHtml, qsecTitle, bank:最终 items }],
         demos:[{ id:最终演示 id, title, unitId:最终锚点, unitTitle, markup, js }] }
     ⚠️ 只是**多返回一个字段**：`html` 一个字节都不受影响（单章产出逐字节不变是硬闸门）。 */
  const finalChapters = chapterInfos.map((info) => ({
    chapter: Object.assign({}, info.chapter),
    key: info.key || '',
    // slots 是按章号连续排下来的，filter 出来的顺序就是这一章的单元顺序
    units: slots
      .filter((s) => s.info === info)
      .map((s) =>
        Object.assign({}, s.unit, {
          id: s.anchor, // 最终生效的锚点（撞车时会变成 `c<章序号>-…`）
          lectureHtml: s.pageHtml == null ? String(s.unit.lectureHtml || '') : s.pageHtml,
          qsecTitle: s.qsecTitle,
          bank: normalized[s.lv], // ★ 规范化之后的题库：id 已带命名空间、含 lv、ref 已摘净
        })
      ),
    demos: demoPlan
      .filter((p) => p.info === info)
      .map((p) => ({
        id: p.id, // 全局分配之后的演示 id（撞车时会变成 demoB…）
        title: p.d.title || '',
        unitId: p.unitAnchor, // 最终的单元锚点（下次合并要按它找挂载点）
        unitTitle: p.d.unitTitle || '',
        markup: p.finalMarkup, // 清洗 + 改名之后的那一份
        js: p.finalJs, // 改名之后的 js（不含 try/catch 外壳与 </script 转义）
      })),
  }));

  return {
    html: h,
    stats: {
      ...stat,
      units: slots.length,
      chapters: chapters.length,
      demos: demoCount,
      bytes: Buffer.byteLength(h, 'utf8'),
    },
    finalChapters,
    fixes,
    warnings,
  };
}

module.exports = {
  assemble, jsonForScript, jsForScript, escapeHtml, sanitizeModelHtml, MARK, assertOnce,
  renameDemoIds, toChapters,
};
