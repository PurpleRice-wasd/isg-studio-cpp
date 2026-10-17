'use strict';
/* 多章生成：**怎么把一堆材料分成几章**、**章序怎么排**、**新旧章接不接得上**、
 * 以及**两章之间像不像在讲同一件事**。
 *
 * 为什么单独一个文件、而且只有纯函数：这四个问题**全是判据**，不是流程。
 * 判据写进流水线里就会变成一堆 `if`，下一个人既看不出规则，也没法单测；
 * 而这个仓库最贵的一课正是"规则藏在流程里 ⇒ 出错时没人说得清它到底按什么判的"。
 *
 * ⚠️ 这里**不读盘、不发请求、不碰 job**。给什么算什么，算不出来就如实说算不出来。
 */

/** 一份材料"有效章号"的来源：材料自己标的优先，没标才看全局的那个默认章号。 */
function pickOptionsChapterNo(options) {
  const o = options && typeof options === 'object' ? options : {};
  /* `chapterNo` 是**契约里的名字**（界面/§4.1 发给主进程的那套字段名）。
     再认一个 `number` 是刻意的容错：`ipc.js` 的 normalizeOptions 会把
     界面字段 `chapterNo` 改名成流水线字段 `number`，所以"归一之后的那份 options"
     里是没有 `chapterNo` 的。谁要是把归一后的 options 递进来而这里只认 chapterNo，
     结果不是报错而是**静静地全归成"没填章号"⇒ 一份材料一章**——
     正是这个仓库最怕的那种"看着完全正常"的错。两者都在时以 chapterNo 为准。 */
  const a = o.chapterNo;
  if (a !== undefined && a !== null && String(a).trim() !== '') return String(a).trim();
  const b = o.number;
  if (b !== undefined && b !== null && String(b).trim() !== '') return String(b).trim();
  return '';
}

/** 日志/报错里指一份材料用的人话。 */
function sourceName(s, i) {
  const x = s && typeof s === 'object' ? s : {};
  return String(x.label || x.fileName || x.filePath || x.id || `第 ${i + 1} 份`);
}

/**
 * 一份材料归到哪一章。
 * 材料自己标了就用它；没标 ⇒ **全局那个章号**（老路径：一份材料 + 章号填在选项里）。
 */
function effectiveNo(src, options) {
  const own = src && src.chapterNo;
  const ownStr = own === undefined || own === null ? '' : String(own).trim();
  return ownStr || pickOptionsChapterNo(options);
}

/* 章号"像不像数字"。只认非负整数与小数：章号不会带正负号、也不会是科学计数法，
   多余的容忍只会让 "1e2" 这种怪东西被当成第 100 章。 */
const NUMERIC_NO = /^\d+(?:\.\d+)?$/;

/**
 * 章序比较器（给 `Array.prototype.sort` 用）。
 *
 * 规则：**两边都像数字就按数值比，否则按字符串比**。
 * 为什么不是"能转数字就按数字"：一章叫「附录」、一章叫「13」时，
 * 把「附录」转成 NaN 再去比，排序结果取决于引擎怎么处理 NaN —— 那是不可复现的。
 * 宁可退成字符串比较（结果稳定、可解释），也不要一个"大部分时候对"的序。
 *
 * 数值相等但写法不同（`013` 与 `13`）时再按字符串决定先后：
 * 返回 0 会把这个顺序交给 sort 的稳定性，而稳定性是实现的细节，不该被依赖。
 */
function compareChapterNo(a, b) {
  const x = String(a == null ? '' : a).trim();
  const y = String(b == null ? '' : b).trim();
  if (NUMERIC_NO.test(x) && NUMERIC_NO.test(y)) {
    const nx = Number(x);
    const ny = Number(y);
    if (nx !== ny) return nx < ny ? -1 : 1;
  }
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * 把材料分组成章。
 *
 * @param {Array} sources 归一之后的 `sources[]`（可能带 `chapterNo` / `chapterTitle`）
 * @param {Object} options 原始 `input.options`（读 `chapterNo` / `subject`）
 * @returns {{ok:true, chapters:Array}|{ok:false, code:string, message:string}}
 *   Chapter = `{ no, title, subject, sources:[source…] }`
 *
 * 三条规则各自对应一次真实的坏结果：
 *   1. **全都没填章号** ⇒ 一章（`no:''`）。这是老路径：只给一份材料、章号留空，
 *      改造前改造后必须**逐字节一样**（`test/assemble-smoke.js` 的 sha256 压着）。
 *   2. **有的填了、有的没填** ⇒ 当场 `NO_CHAPTER`，且点名**是哪几份**没填。
 *      不报的话，那几份会被默默并进"全局章号"那一章里 —— 用户以为分好了章，
 *      拿到的却是一章混着两章的内容，而且**要复习到才看得出来**。
 *   3. **只有一部分材料时**也一样：分组只按章号，不看份数。
 */
function groupSources(sources, options) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && typeof s === 'object') : [];
  if (!list.length) {
    /* 空输入**不是**"一章空章"。真放过去，流水线会拿到一个一份材料都没有的章节去跑，
       错误会出现在离这里很远的地方（模型对着一份空材料硬编）。
       这里就地说清楚，代价是一条 message。 */
    return { ok: false, code: 'NO_SOURCES', message: '还没有选任何材料——先拖一份课件或课本进来' };
  }

  const noByIdx = list.map((s) => effectiveNo(s, options));

  // 规则 2：一部分有一份没有 —— 说不清"没填的那几份"该并进哪一章，只能当场拒
  const missing = [];
  noByIdx.forEach((no, i) => {
    if (!no) missing.push(sourceName(list[i], i));
  });
  if (missing.length && missing.length < list.length) {
    return {
      ok: false,
      code: 'NO_CHAPTER',
      message: `有 ${missing.length} 份材料没填章号：${missing.join('、')}。`
        + '要么每份都填上它属于哪一章，要么全都留空（全都留空就是只生成一章）。',
    };
  }

  // 规则 3：按有效章号分组，章序按 compareChapterNo 升序
  const byNo = new Map(); // 章号 → Chapter（章号是字符串，Map 的键正好）
  for (let i = 0; i < list.length; i++) {
    const no = noByIdx[i];
    let ch = byNo.get(no);
    if (!ch) {
      ch = { no, title: '', subject: '', sources: [] };
      byNo.set(no, ch);
    }
    ch.sources.push(list[i]);
    // 规则 5：章标题取组内**第一份非空**的 chapterTitle（空标题后面由流水线自动推断）
    if (!ch.title) {
      const t = list[i].chapterTitle;
      if (t !== undefined && t !== null && String(t).trim()) ch.title = String(t).trim();
    }
  }

  const chapters = [...byNo.values()].sort((a, b) => compareChapterNo(a.no, b.no));
  // 规则 6：subject 是**整次生成**的，不是每份材料各自的
  const subject = options && options.subject != null ? String(options.subject) : '';
  for (const ch of chapters) ch.subject = subject;

  return { ok: true, chapters };
}

/* ---------------- 新旧章接不接得上 ---------------- */

/**
 * 新章紧接在旧章后面吗？
 *
 * @param {Array<string|number>} newNos   这次要生成的章号
 * @param {Array<string|number>} knownNos 已经在册里的章号（"带上的章"）
 * @returns {{continuous:boolean, knownMin:number|null, knownMax:number|null,
 *            newMin:number|null, newMax:number|null, gapBefore:boolean}}
 *
 * "连续"的定义（两条**都要**成立）：
 *   1. 已知章号本身是一段**连续整数**（12、13 可以，12、14 不行）；
 *   2. `min(newNos) === max(knownNos) + 1`（14 接在 13 后面）。
 *
 * `gapBefore` = 新章**跳过了**旧章后面的号（旧 10、新 13 ⇒ 中间空着 11、12）。
 * 它是给日志/提示用的：接不上照样能出活（自成一份册子），但用户该被告知一声。
 *
 * ⚠️ **非数字章号一律判不连续**（宁可不缝，也不猜）。
 * 为什么这么死板：`上` / `下` / `附录` 这类章号既排不出序，也推不出"下一个是什么"。
 * 猜错的代价是**两支内容被缝成一份连续复习的书**，而错的地方要等用户复习到才发现；
 * 判错成"接不上"的代价只是少缝一次（产品形态上本来就是允许的 —— 自成一份册子）。
 * 这个仓库的惯例是"两个错里挑那个能看出来的"。
 *
 * 章号重复（12、12、13）按**集合**看：重复是用户手滑，不该因此判成"不连续"。
 */
function judgeContinuity(newNos, knownNos) {
  const toNums = (arr) => {
    const raw = Array.isArray(arr) ? arr : [];
    const out = [];
    let all = true;
    for (const v of raw) {
      const s = String(v == null ? '' : v).trim();
      if (!NUMERIC_NO.test(s)) { all = false; continue; }
      out.push(Number(s));
    }
    return { nums: [...new Set(out)].sort((a, b) => a - b), allNumeric: all && raw.length > 0 };
  };

  const know = toNums(knownNos);
  const news = toNums(newNos);
  const knownMin = know.nums.length ? know.nums[0] : null;
  const knownMax = know.nums.length ? know.nums[know.nums.length - 1] : null;
  const newMin = news.nums.length ? news.nums[0] : null;
  const newMax = news.nums.length ? news.nums[news.nums.length - 1] : null;

  /* 已知章号是不是一段连续整数：排序去重之后逐个差 1 就行。
     （`allNumeric` 已经保证里面没有"附录"这种混进来的东西。） */
  let knownRun = know.allNumeric && know.nums.length > 0;
  for (let i = 1; knownRun && i < know.nums.length; i++) {
    // 章号是整数才有"下一号"可言：12.5 接 13.5 不是章与章的关系
    if (!Number.isInteger(know.nums[i]) || know.nums[i] !== know.nums[i - 1] + 1) knownRun = false;
  }

  /* 没有旧章可接时返回**不连续**，而不是"空集也算连续"：
     调用方要问的是"这次的新章能不能缝进手上这一册"，手上什么都没有时就没什么可缝的；
     而返回 true 会让上层去算一个不存在的接缝（`max(knownNos) + 1` 是 undefined+1）。
     产品上这与"接不上"是同一个处理（自成一份册子），所以不会丢掉任何东西。 */
  const continuous = !!(knownRun
    && news.allNumeric
    && newMin !== null
    && knownMax !== null
    && news.nums.every((n) => Number.isInteger(n))
    && newMin === knownMax + 1);

  const gapBefore = !!(knownMax !== null && newMin !== null && newMin > knownMax + 1);

  return { continuous, knownMin, knownMax, newMin, newMax, gapBefore };
}

/* ---------------- 两章像不像在讲同一件事 ---------------- */

/* 阈值：两条都按 §4.5 定死在这里，别处不许再写魔数。
   ASK  —— 高到值得**打断用户**问一句"要不要关联生成"；
   NOTE —— 低到只值得在日志里提一句"这两章可能有点关系"（问会烦人，不提又会漏）。 */
const AFFINITY_ASK = 0.25;
const AFFINITY_NOTE = 0.12;

/* 中日韩统一表意文字（含扩展 A 与兼容区）。用来判"这个字符串要不要额外切 2-gram"。 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/**
 * 一段文字 → 词元集合。
 *
 * 两套表示**都要**（并集，见 §4.5 的"中文按字/词都要能对上"）：
 *   · **整串**：对上"词"。同一个术语两边写法一致时（`磁通量` / `磁通量`，
 *     `Magnetic Flux` / `Magnetic Flux`）直接命中 —— 这是最强的信号，不该被切碎。
 *   · **中文 2-gram**：对上"字"。中文没有空格，整串比对要求一字不差，
 *     而两章讲同一件事时措辞几乎不会完全相同（`磁通量` / `磁通密度`、
 *     `安培环路定理` / `环路定理`）。切成 2-gram 之后这类重叠才看得见。
 *     只切 2-gram 不切 1-gram：单字（`场`/`的`）在任何两份物理材料里都会撞上，
 *     那不是"像在讲同一件事"，那是噪声。
 *
 * 英文一律转小写：`magnetic field` 与 `Magnetic Field` 是同一个术语，
 * 大小写不同不该算成两个词（中文转小写无影响，所以这一段对所有串都安全）。
 */
function tokensOf(text) {
  const out = new Set();
  const s = String(text == null ? '' : text).trim();
  if (!s) return out;
  out.add(s.toLowerCase());
  if (!CJK.test(s)) return out;
  /* 只在**连续的汉字段**内切：混排的 `磁场 magnetic` 切成跨段的 2-gram
     会造出 `场 ` 这种既不是汉字也不是词的碎片，把交集撑大。 */
  for (const run of s.match(/[㐀-䶿一-鿿豈-﫿]+/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 从一份来源分析结论（`note`）里取词元。只取 §4.5 指定的三处：术语（中/英）与结构标题。 */
function tokensOfNote(note) {
  const out = new Set();
  if (!note || typeof note !== 'object' || Array.isArray(note)) return out;
  const terms = Array.isArray(note.terms) ? note.terms : [];
  for (const t of terms) {
    if (!t || typeof t !== 'object') continue;
    for (const tk of tokensOf(t.zh)) out.add(tk);
    for (const tk of tokensOf(t.en)) out.add(tk);
  }
  const outline = Array.isArray(note.outline) ? note.outline : [];
  for (const u of outline) {
    if (!u || typeof u !== 'object') continue;
    for (const tk of tokensOf(u.title)) out.add(tk);
  }
  return out;
}

/**
 * 两份来源分析结论有多像（0..1，集合 Jaccard：交集 ÷ 并集）。
 *
 * ⚠️ **任一份为空 ⇒ 0，不做假设**。为什么不做"缺一份就按另一份算"之类的兜底：
 *   这个数只有两个用途 —— 要么触发一次**打断用户**的提问，要么在日志里提一句。
 *   两份都没内容却算出个高分，用户会被一个莫名其妙的问题拦住；
 *   而返回 0 的后果只是"少问一次、按默认的简单缝合继续"。两个错里挑那个安静的。
 */
function chapterAffinity(noteA, noteB) {
  const a = tokensOfNote(noteA);
  const b = tokensOfNote(noteB);
  if (!a.size || !b.size) return 0; // 其中一份没内容，或两份都没有
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/* 导出面**恰好是这六个**（§4.2 的三个判据 + §4.5 的关联度与两个阈值）。
   多导出一个名字就是多一个接口：下一个人会以为它有约定、会去依赖它。 */
module.exports = {
  groupSources,
  compareChapterNo,
  judgeContinuity,
  chapterAffinity,
  AFFINITY_ASK,
  AFFINITY_NOTE,
};
