'use strict';
/* 「累积成一册」的地基之一：**结构化数据的旁挂落盘**。
 *
 * 为什么要有这一层：章节成品 HTML 是**拼装器**（pipeline/assemble.js）把
 * 大纲 / 每个单元的讲解与题库 / 演示拼出来的。想把"以前生成的那一章"和新的合成一册，
 * 就必须**重新装配**一次 —— 在 HTML 文本层面拼两份成品是做不出来的（两份骨架、
 * 两套 `PAGE.key`、两套引擎的题区索引都会打架）。
 * 重新装配需要那一章生成时的结构化数据，而那些数据以前只活在 `runPipeline` 的局部 const 里，
 * 任务一结束就随进程一起没了，磁盘上只剩一份成品 HTML。
 *
 * ---- 为什么落在**产物旁边**，而不是 userData 里 ----
 * 这个功能的判断依据是"**这一份页面**"，不是"这台机器上的历史记录"：
 *   · 历史里的 `htmlPath` 是绝对路径，换目录/换机器就失效；
 *   · 旁挂文件**跟着文件走** —— 用户把 HTML 拷给同学、拖到另一个文件夹，数据还在；
 *   · 更要紧的是，它让"**选一个 HTML 文件**"这个入口能直接读到数据（否则只能从页面反推）。
 * 路径规则：与 HTML **同目录、同 basename**，再加 `.isg.json`：
 *   `ch13-磁介质-练一练.html` → `ch13-磁介质-练一练.html.isg.json`
 * 所以不需要"按 jobId 保留 N 份"的回收逻辑 —— 用户删页面时，旁挂文件自然跟着没了。
 *
 * ---- 同一个文件形状，单章与整册共用 ----
 * `kind` 区分 `chapter`（一章单独成页）与 `book`（几章合成的一册），`chapters[]` 都是列表
 * （单章就是只有一项的列表）。详见 `writeBook()` 的注释。
 *
 * ---- 调用方应该在什么时候调 ----
 *   · `writeBook(htmlPath, data)`：**在 pipeline 里 HTML 落盘成功之后、`jobs.finish(job)` 之前**调一次。
 *     失败策略：**只记 warn，页面照常交付** —— 页面已经写出来了，不能因为"旁挂数据没写下去"
 *     就让用户拿不到东西。但结果里要**明说**"这一章的数据没存下来，以后不能并进一册"
 *     （`writeBook` 返回 `{ok:false, reason, detail}`，reason 就是拿来写这句提示的）。
 *     拼装失败 / 用户取消的任务**不要**调：半份数据拿去合并只会拼出残页。
 *   · `readBook(htmlPath)` / `hasBook(htmlPath)`：给"选一个 HTML 进来合并"这条入口用，
 *     以及历史列表判断"这一份还能不能用来合并"。**读永远不会抛给调用方**：
 *     文件不在、JSON 坏、schema 版本不认识，都会得到一个说得清楚的"不可用"。
 *
 * ---- 两条纪律 ----
 *   1. **写入是原子的**：先写 `<...>.isg.json.tmp` 再 rename。中途断电/被杀进程不会留下
 *      半截 JSON —— 半截 JSON 会被读路径判成"坏文件"，等于用户白白丢了一章的结构数据。
 *   2. **`bank` 原样保存**（已规范化的 items，含最终的 `q.id`）。这是"进度零迁移"的前提：
 *      再拼装时 id 必须一模一样，否则 localStorage 里的作答记录全对不上。
 *      所以这一层**绝不去碰 bank 里的题**，只搬。
 */

const fs = require('fs');
const path = require('path');

/** 当前 schema。改结构时**只加不减**，并把老版本的读法登记进 READERS。 */
const SCHEMA = 'isg-book/1';

const SUFFIX = '.isg.json';
const KINDS = new Set(['chapter', 'book']);

/* schema → 读取器。表里没有的一律判"不可用"，
   绝不"尽力而为"地当成本版读 —— 那会让拼装器拿到缺字段的对象，
   表现是页面缺单元、题库静默少一半，而不是一条清楚的报错。 */
const READERS = {
  'isg-book/1': (raw) => raw,
};

/* ---------------- 路径 ---------------- */

/** 旁挂文件的路径。htmlPath 空或不是字符串 → null（调用方按"没有"处理）。 */
function sidecarPathFor(htmlPath) {
  const p = typeof htmlPath === 'string' ? htmlPath.trim() : '';
  if (!p) return null;
  return p + SUFFIX;
}

/** 这个路径是不是一个旁挂文件（用于"用户拖进来一个 .isg.json"之类的地方）。 */
function isSidecar(p) {
  return typeof p === 'string' && p.toLowerCase().endsWith(SUFFIX);
}

/* ---------------- 形状归一 ---------------- */

function str(v) {
  return v == null ? '' : String(v);
}

/**
 * 一章。**只有 `chapter` 和 `units` 是必需的**（units 由调用方保证非空，
 * 这里不拦：拦了只会让用户在"某章一个单元都没有"时丢掉整份数据）。
 */
function normalizeChapterEntry(c) {
  const x = c && typeof c === 'object' ? c : {};
  const ch = x.chapter && typeof x.chapter === 'object' ? x.chapter : {};
  const units = Array.isArray(x.units) ? x.units : [];
  const demos = Array.isArray(x.demos) ? x.demos : [];
  return {
    chapter: {
      /* `no` 与 `number` 两种写法都认：拼装器落盘的是 `number`，而旁挂数据自己的
         读取端与 revive 用 `no`。只认一个的话，真实生成链写出来的旁挂数据会**静默丢掉章号**
         （页面看起来完全正常，只是「带上一章」时显示"第 N 章"退化成序号）。 */
      no: str(ch.no !== undefined && ch.no !== null && String(ch.no).trim() !== '' ? ch.no : ch.number),
      title: str(ch.title),
      subject: str(ch.subject),
      intro: str(ch.intro),
    },
    // 这一章单独成页时用的存盘键：搬家（把一章并进一册）时要用它来认"这是同一章"
    key: str(x.key),
    sourceFile: str(x.sourceFile),
    createdAt: Number(x.createdAt) || Date.now(),
    jobId: str(x.jobId),
    units: units.map(normalizeUnit),
    demos: demos.map(normalizeDemo),
    // "这一章已经发出去过了，id 不许重算" —— 重算 id 会让用户已有的作答记录全部失联
    frozen: !!x.frozen,
  };
}

function normalizeUnit(u, i) {
  const x = u && typeof u === 'object' ? u : {};
  const out = Object.assign({}, x);
  out.id = str(x.id || 'u' + (i + 1));
  out.num = str(x.num);
  out.title = str(x.title);
  out.shortTitle = str(x.shortTitle);
  out.qsecTitle = str(x.qsecTitle);
  out.lede = str(x.lede);
  out.lectureHtml = str(x.lectureHtml);
  // ⚠️ 题库原样搬（见文件顶部第 2 条纪律）：这里**不规范化、不改 id**
  out.bank = Array.isArray(x.bank) ? x.bank : [];
  return out;
}

function normalizeDemo(d, i) {
  const x = d && typeof d === 'object' ? d : {};
  const out = Object.assign({}, x);
  out.id = str(x.id || 'd' + (i + 1));
  out.title = str(x.title);
  out.markup = str(x.markup);
  out.js = str(x.js);
  out.unitId = str(x.unitId);
  out.unitTitle = str(x.unitTitle);
  return out;
}

/**
 * 把调用方给的任意对象归一成要落盘的册/章，并顺手报出"哪儿不对劲"。
 *
 * 硬性要求只有两条：`kind` 认识、`chapters` 非空。其余一律容错填默认值 ——
 * 为了一个可选字段把整份结构数据拒掉，代价是用户以后再也合不了这一章。
 *
 * @returns {{ok:true, book:object, warnings:string[]}|{ok:false, reason:string, detail:string}}
 */
function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  const kind = str(d.kind || 'chapter');
  if (!KINDS.has(kind)) {
    return { ok: false, reason: 'bad-kind', detail: `kind 只认 ${[...KINDS].join(' / ')}，收到「${kind}」` };
  }
  const chapters = (Array.isArray(d.chapters) ? d.chapters : []).map(normalizeChapterEntry);
  if (!chapters.length) return { ok: false, reason: 'no-chapters', detail: 'chapters 是空的，这份数据拿不去合并' };

  const warnings = [];
  for (const c of chapters) {
    if (!c.key) warnings.push(`第 ${chapters.indexOf(c) + 1} 章的 key 是空的，将来搬家时认不出它`);
    if (!c.units.length) warnings.push(`「${c.chapter.title || '未命名'}」没有任何单元`);
    for (const u of c.units) {
      if (!u.id) warnings.push('有单元缺 id');
      if (u.bank.length && u.bank.some((q) => !q || !q.id)) {
        // 没有 id 的题在重新拼装时会拿到**新**的 id → 用户已有的作答记录会对不上号
        warnings.push(`「${c.chapter.title || '未命名'}」有题目没有 id（重新拼装时 id 会变，作答记录会对不上）`);
      }
    }
  }

  return {
    ok: true,
    warnings,
    book: {
      schema: SCHEMA,
      kind,
      appVersion: str(d.appVersion),
      title: str(d.title),
      subject: str(d.subject),
      /* 册的 key：**必须与章列表无关**（别用"各章键拼起来"那种做法），
         否则每加一章就换一次键，用户每次都得搬一遍作答记录。
         首次合并时生成一次，之后一直复用。 */
      key: str(d.key),
      chapters,
    },
  };
}

/* ---------------- 写 ---------------- */

/**
 * 把结构化数据写到 HTML 旁边的 `<htmlPath>.isg.json`。
 *
 * **不抛异常**：出问题返回 `{ok:false, reason, detail}`，由调用方记 warn 并如实告诉用户
 * "这一章以后不能并进一册"。reason 取值：`bad-path` / `bad-kind` / `no-chapters` / `io`。
 *
 * @param {string} htmlPath 成品页面的路径（必须是文件路径，不是目录）
 * @param {object} data     形状见文件顶部；`kind` 缺省按 `chapter`
 * @returns {{ok:boolean, path?:string, warnings?:string[], reason?:string, detail?:string, error?:string}}
 */
function writeBook(htmlPath, data) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return { ok: false, reason: 'bad-path', detail: 'htmlPath 是空的，不知道该把数据写到哪儿去' };

  const n = normalize(data);
  if (!n.ok) return n;

  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(n.book, null, 2), 'utf8');
    // rename 覆盖同目录下的同名文件：Windows 上 Node 走 MOVEFILE_REPLACE_EXISTING，是原子的
    fs.renameSync(tmp, file);
    return { ok: true, path: file, warnings: n.warnings };
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp); // 不留半截临时文件
    } catch (e2) {}
    return { ok: false, reason: 'io', error: (e && e.message) || String(e) };
  }
}

/** 删掉旁挂文件（暂不导出给界面用，但合并/搬家那条线会需要它）。不抛。 */
function removeBook(htmlPath) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 读（全部容错） ---------------- */

/**
 * 读 HTML 旁边的结构化数据，并把"为什么读不出来"说清楚。
 *
 * @param {string} htmlPath
 * @returns {{ok:true, book:object, path:string}}
 *        | {{ok:false, reason:'bad-path'|'missing'|'corrupt'|'unsupported-schema'|'io',
 *            detail:string, path?:string, schema?:string}}
 *   `unsupported-schema` 表示"这份数据是别的版本写的"（降级展示时可以用 schema 说明），
 *   它与 `corrupt`（文件坏了/不是我们的文件）是两回事，界面上的说法也该不一样。
 */
function readBook(htmlPath) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return { ok: false, reason: 'bad-path', detail: 'htmlPath 是空的' };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const reason = e && e.code === 'ENOENT' ? 'missing' : 'io';
    return { ok: false, reason, path: file, detail: (e && e.message) || String(e) };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'corrupt', path: file, detail: 'JSON 解析失败：' + ((e && e.message) || String(e)) };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'corrupt', path: file, detail: '文件内容不是一个对象' };
  }
  const schema = str(obj.schema);
  if (!schema) {
    return { ok: false, reason: 'corrupt', path: file, detail: '没有 schema 字段（可能不是本程序写的文件）' };
  }
  const reader = READERS[schema];
  if (!reader) {
    return {
      ok: false,
      reason: 'unsupported-schema',
      path: file,
      schema,
      detail: `这份数据的版本「${schema}」不认识（本程序支持到 ${SCHEMA}）`,
    };
  }
  const migrated = reader(obj);
  if (!migrated || typeof migrated !== 'object' || !Array.isArray(migrated.chapters) || !migrated.chapters.length) {
    return { ok: false, reason: 'corrupt', path: file, schema, detail: '读取器拿不到 chapters 数组' };
  }
  return { ok: true, book: migrated, path: file };
}

/** 读一份结构化数据；**不可用一律返回 null**（想看原因用 `readBook()`）。 */
function getBook(htmlPath) {
  const r = readBook(htmlPath);
  return r.ok ? r.book : null;
}

/**
 * 这一份页面**有没有能用的**旁挂数据。
 *
 * 默认只 stat（**便宜**）：历史列表有几十条，每条都整份解析一遍（一份几百 KB）
 * 会把"列个表"变成几十 MB 的读盘。代价是"文件在但内容坏了"这里会报 true。
 *
 * `{deep:true}` 才是**准**的（真解析一遍）。它带一层按 (路径, mtime, 大小) 记忆的缓存：
 * 同一份文件只要没被改写就只解析一次 —— 所以"每次刷列表都深层判断"也是可以接受的，
 * 界面要如实说"这份还能不能准确合并"，宁可准一点。
 * 缓存命中不了的两头（文件被删 / 被改写）都会落到真解析上，不会给出过期的答案。
 */
const deepCache = new Map();
const DEEP_CACHE_MAX = 200;

function hasBook(htmlPath, opts) {
  const file = sidecarPathFor(htmlPath);
  if (!file) return false;
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile() || st.size <= 1) return false;
  } catch (e) {
    return false;
  }
  if (!(opts && opts.deep)) return true;
  const hit = deepCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.ok;
  const ok = readBook(htmlPath).ok;
  deepCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, ok });
  if (deepCache.size > DEEP_CACHE_MAX) {
    // 简单粗暴地丢最早插入的那条：缓存只是加速，丢了下次再解析一遍而已
    deepCache.delete(deepCache.keys().next().value);
  }
  return ok;
}

module.exports = {
  SCHEMA,
  SUFFIX,
  sidecarPathFor,
  isSidecar,
  normalize,
  writeBook,
  readBook,
  getBook,
  hasBook,
  removeBook,
};
