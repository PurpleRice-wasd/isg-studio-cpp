'use strict';
/* 题库的规范化 + 校验。
 *
 * 这里的规则**逐条对齐**引擎里的 badReason()（skills/interactive-study-guide/assets/quiz-engine.js:1237）。
 * 为什么要在应用侧再写一遍：引擎遇到不合格的题是"标红跳过 + 告警"，页面不报错——
 * 对人来说这就是"题凭空少了几道"。我们必须在拼装之前就发现，并且**带着明确的指示去让模型重写**，
 * 而不是把一份残缺的页面交给用户。
 *
 * 本模块只做纯函数变换，不碰 DOM、不碰网络。
 */

/**
 * 引擎认识的全部题型——**唯一一处定义**。
 *
 * 提示词、契约、校验层都从这里取，别再各自抄一份字面量：
 * 抄散的后果是"某一处加了新题型、另一处还在拦"，而症状是题目静默少掉几道。
 * `big` 是综合大题（含 parts），其余三种是叶子题型。
 */
const KNOWN_TYPES = new Set(['single', 'multi', 'num', 'big']);
/** 大题的子题只允许这三种——引擎的 badReason() 递归时也只认它们。 */
const PART_TYPES = new Set(['single', 'multi', 'num']);

/** Unicode 上/下标 → ASCII，用于把 "2.51×10⁻⁴" 这类写法救回来。 */
const SUP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁻': '-', '⁺': '+',
};
const SUB = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₋': '-', '₊': '+',
};

function desuper(s) {
  return String(s).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, (c) => SUP[c]);
}
function desub(s) {
  return String(s).replace(/[₀₁₂₃₄₅₆₇₈₉₋₊]/g, (c) => SUB[c]);
}

/* 一个"完整的数字"：不许有多余字符。 */
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/* 单位长什么样：必须以字母/单位符号开头，且只由这些字符组成，**而且不能含阿拉伯数字**。
   "A/m"、"A·m⁻¹"、"T"、"m/s²"、"kg·m/s²"（上标不算数字）都算；
   "-3"、"/2"、"(第2步)"、"x 100"、"T=9" 都不算。

   ⚠️ **"不许含数字"这条是防前缀截断的关键**（引擎的 parseNum 早就吃过亏，见
   references/pitfalls.md 第 64 条）。反例：`"5 x 100"` 里的 "x 100" 长得像单位，
   放过去就会把 5×100 截成 5，学员答 500 永远判错。凡带数字的尾巴，一律当"写法看不懂"退回。 */
const UNIT_RE = /^[A-Za-zΩμ°%][A-Za-zΩμ°%·⋅^*⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺₀₁₂₃₄₅₆₇₈₉/()\s.\-]*$/;

/** 把各种"人写的数字"归一成 ASCII 的纯数字串。返回 null 表示**看不懂**（而不是"算错了"）。 */
function cleanNumeric(s) {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (!t) return null;
  // 十六/八/二进制前缀：一律不认（"0x10" 被截成 0 会把错答判对）
  if (/^[+-]?0[xXbBoO]/.test(t)) return null;
  // 各种 Unicode 减号 / 全角负号
  t = t.replace(/[−–—－]/g, '-').replace(/＋/g, '+');
  // 全角数字与全角句点
  t = t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/．/g, '.');
  // 千分位分隔优先（1,234,567）——判据是"整串就是 1~3 位 + 若干组 3 位"
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(/(\d),(\d)/g, '$1.$2'); // 否则逗号当小数点（欧洲写法 1,06）
  // 上标/乘方写法 → e 记法。**必须在 desuper 之前做**，否则分不清 "10⁻⁴"（乘方）与 "100"（就是一百）。
  // 只认两种明确形态：`×10` 后面跟**上标数字**，或 `×10^` 后面跟普通指数。
  // `5 x 100` 两种都不匹配，于是会留成 "5 x 100"，最终被当作"写法看不懂"退回——
  // 这正是我们要的（以前它被当成 5×10^0 = 5，学员答 500 永远判错）。
  t = t
    .replace(/\s*[×xX*⋅]\s*10\s*([⁻⁺]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (m, sup) => 'e' + desuper(sup))
    .replace(/\s*[×xX*⋅]\s*10\s*\^\s*([+-]?\d+)/g, 'e$1')
    // `×10-4`（没写尖号）：只能靠"10 后面直接跟正负号"来认，而这个形状不可能出现在
    // "5 x 100" 里（100 后面没有符号），所以不会误伤那条。
    .replace(/\s*[×xX*⋅]\s*10\s*([+-]\d+)/g, 'e$1')
    .replace(/\s10\s*\^\s*([+-]?\d+)/g, 'e$1');
  // ⚠️ 这里**故意不 desuper 整串**：上标是"单位"的一部分（`kg·m/s²`），
  // 也是"乘方"的一部分（`10⁻⁴`，上一段已经吃掉）。如果在这里把 ² 变成 2，
  // 单位的字母表里就混进了 ASCII 数字，"不许含数字"那条规则会把合法单位一起误杀。
  // 数字中间的空格（"1 000 000"）
  t = t.replace(/(\d)\s+(\d)/g, '$1$2');
  return t.trim();
}

/**
 * 尽力把一个值变成有限的数字。失败返回 null（**绝不猜**）。
 * 认：200 / "200" / "2.51e-4" / "2.51×10⁻⁴" / "2.51*10^-4" / "1,06" / "1,234,567" /
 *     "1.06 T" / "200 A/m" / "−5"（各种负号）/ "１５"（全角）
 * 不认（返回 null，当作"这个写法看不懂"）：5-3 / 1/2 / 2+3 / "5 T=9" / 1.2.3 / 0x10 / 1e
 */
/**
 * 把一串"人写的数字"切成 { 数值, 单位 }。看不懂返回 null。
 *
 * **coerceNumber 与 extractUnit 必须共用这一个函数**：它们以前各写一套判据，
 * 于是同一个输入会出现"值取不到、单位却取到了"这种自相矛盾的结果
 * （实测 `extractUnit("1e")` 返回 "e"，而 `coerceNumber("1e")` 返回 null）——
 * 上层拿这个单位显示给学员看，就会显示成单位 "e"。
 */
function splitNumUnit(v) {
  if (typeof v !== 'string') return null;
  const t = cleanNumeric(v);
  if (t == null) return null;
  if (NUM_RE.test(t)) {
    const n = Number(t);
    return isFinite(n) ? { n, u: '' } : null;
  }
  // 数字 + 单位：整串必须**恰好**是「数字」+「像样的单位」，多一个字符都不行
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S[\s\S]*)$/);
  if (!m) return null;
  const rest = m[2].trim();
  if (!rest) {
    const n = Number(m[1]);
    return isFinite(n) ? { n, u: '' } : null;
  }
  if (!UNIT_RE.test(rest) || rest.length > 16) return null;
  // "1e" / "5e-" / "5e+" / "1ee" 都是写坏的科学计数法，不是"5 艾"之类——绝不能猜成 5。
  // 判据：整个"单位"只由 e/E 与正负号组成（真单位不会长这样）。
  if (/^[eE+\-]+$/.test(rest)) return null;
  const n = Number(m[1]);
  return isFinite(n) ? { n, u: rest } : null;
}

function coerceNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const r = splitNumUnit(v);
  return r ? r.n : null;
}

/** 从 "2.51×10⁻⁴ T" 里取出单位 "T"（取不到返回 ''）。判据与 coerceNumber 完全一致。 */
function extractUnit(v) {
  const r = splitNumUnit(v);
  return r ? r.u : '';
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 规范化一段题库。就地改传入的对象副本，返回 {items, fixes, issues}。
 *   fixes  —— 我们**自动改好**的地方（会写进日志，让用户知道模型哪里没按规矩来）
 *   issues —— 我们**改不了**的，必须回灌给模型重写
 */
function normalizeBank(rawItems, opts) {
  const o = opts || {};
  const lv = o.lv; // 这一段的关卡号，由我们定，不采信模型写的
  const ns = o.namespace || ''; // id 前缀，保证跨单元唯一
  const fixes = [];
  const issues = [];
  const items = [];

  if (!Array.isArray(rawItems)) {
    return { items: [], fixes, issues: [{ code: 'not-array', message: 'bank 不是数组' }] };
  }

  const seen = new Set();
  const seenSlash = o.seenIds instanceof Set ? o.seenIds : new Set();

  rawItems.forEach((raw, idx) => {
    const at = `第 ${idx + 1} 道`;
    if (!isPlainObject(raw)) {
      issues.push({ code: 'not-object', at, message: `${at}不是一个对象` });
      return;
    }
    const q = JSON.parse(JSON.stringify(raw));
    q.lv = lv;

    // id：加命名空间前缀，并保证全局唯一（引擎遇到重复 id 会自动改名并告警，
    // 那会让两题共用一个存盘键，所以我们在上游就断掉这个可能）
    let base = String(q.id == null ? '' : q.id).trim();
    if (!base) {
      base = 'q' + (idx + 1);
      fixes.push({ at, message: '模型没给 id，已自动补 ' + base });
    }
    base = base.replace(/[^\w\-.]/g, '-');
    let id = ns ? `${ns}-${base}` : base;
    if (seen.has(id) || seenSlash.has(id)) {
      let n = 2;
      while (seen.has(id + '-' + n) || seenSlash.has(id + '-' + n)) n++;
      fixes.push({ at, message: `id 重复（${id}），已改名为 ${id}-${n}` });
      id = id + '-' + n;
    }
    q.id = id;
    seen.add(id);
    seenSlash.add(id);

    if (q.type === 'big') {
      if (!Array.isArray(q.parts) || !q.parts.length) {
        issues.push({ code: 'big-no-parts', at, id, message: `${at}（${id}）是 big 类型但没有 parts` });
        return;
      }
      q.parts = q.parts
        .map((p, i) => {
          const pp = isPlainObject(p) ? Object.assign({}, p) : {};
          pp.type = pp.type || 'single';
          const ok = normalizePart(pp, `${at} 第 ${i + 1} 步`, id, i, issues, fixes);
          if (ok && (typeof ok.stem !== 'string' || !ok.stem.trim())) {
            // 没有题干的小问会在页面上渲染成一张**空白卡片**：引擎的 badReason 不查 stem，
            // 探针也查不出来（它只看 id 与判分），学员只会看到一张点不动的空题。
            issues.push({ code: 'part-no-stem', at, id, message: `${at} 第 ${i + 1} 步没有题干 stem（会渲染成一张空白题卡）` });
            return null;
          }
          return ok;
        })
        .filter(Boolean);
      if (!q.parts.length) {
        issues.push({ code: 'big-empty-parts', at, id, message: `${at}（${id}）的 parts 全部不合格` });
        return;
      }
      // 引擎会把每个小问的 id 自动生成为 `<大题id>-<步号>`，那也当存盘键用。
      // 这里必须一并登记：否则题库里另有一道普通题叫 "big1-1" 时会撞车，引擎只能靠自动改名兜住，
      // 而 id 一改，学员的作答记录就对不上了（见 pitfalls 第 70 条）。
      q.parts.forEach((_, i) => {
        const pid = `${id}-${i + 1}`;
        if (seen.has(pid) || seenSlash.has(pid)) {
          issues.push({
            code: 'big-step-id-clash',
            at,
            id,
            message: `${at}（${id}）的第 ${i + 1} 步占用的 id「${pid}」与题库里另一道题撞车，请改掉那道题的 id`,
          });
        }
        seenSlash.add(pid);
      });
    } else {
      const ok = normalizePart(q, at, id, null, issues, fixes);
      if (!ok) return;
      Object.assign(q, ok);
    }

    if (typeof q.stem !== 'string' || !q.stem.trim()) {
      issues.push({ code: 'no-stem', at, id, message: `${at}（${id}）没有题干 stem` });
      return;
    }
    items.push(q);
  });

  return { items, fixes, issues };
}

function normalizePart(p, at, parentId, partIndex, issues, fixes) {
  const type = p.type;
  if (!['single', 'multi', 'num'].includes(type)) {
    // 大题里的小题也允许再嵌 big？引擎的 badReason 递归时只认 single/multi/num，
    // 所以这里也只在三者里取值；缺省按单选处理，交给后面的校验兜底。
    if (type === 'big') {
      issues.push({ code: 'nested-big', at, message: `${at} 不允许再嵌 big 大题` });
      return null;
    }
    fixes.push({ at, message: `type「${type === undefined ? '没写' : type}」不认识，已按 single 处理` });
    p.type = 'single';
  }

  if (p.type === 'single' || p.type === 'multi') {
    if (!Array.isArray(p.opts)) {
      issues.push({ code: 'no-opts', at, message: `${at} 没有选项 opts 数组` });
      return null;
    }
    const opts = [];
    p.opts.forEach((oo, i) => {
      if (typeof oo === 'string') {
        // 模型偶尔把选项写成裸字符串数组 —— 救得回来（但没有 why，要提示）
        fixes.push({ at, message: `选项 ${i + 1} 是裸字符串，已转成对象（该选项没有 why 解释）` });
        opts.push({ t: oo, ok: false, why: '' });
        return;
      }
      if (!isPlainObject(oo)) {
        issues.push({ code: 'bad-opt', at, message: `${at} 的第 ${i + 1} 个选项不是对象` });
        return;
      }
      const o2 = { t: String(oo.t == null ? '' : oo.t), why: String(oo.why == null ? '' : oo.why) };
      o2.ok = oo.ok === true || oo.ok === 'true' || oo.ok === 1;
      if (oo.ok !== undefined && oo.ok !== true && oo.ok !== false && oo.ok !== 'true' && oo.ok !== 1 && oo.ok !== 0) {
        fixes.push({ at, message: `选项 ${i + 1} 的 ok 是「${oo.ok}」，已按 ${o2.ok} 处理` });
      }
      opts.push(o2);
    });
    p.opts = opts;

    if (opts.length < 2) {
      issues.push({ code: 'opts-too-few', at, id: parentId, message: `${at} 的选项不足两个（现在 ${opts.length} 个）` });
      return null;
    }
    if (opts.some((x) => !x.t.trim())) {
      issues.push({ code: 'empty-opt', at, id: parentId, message: `${at} 有选项文字是空的` });
      return null;
    }
    const okN = opts.filter((x) => x.ok).length;
    if (!okN) {
      issues.push({ code: 'no-correct', at, id: parentId, message: `${at} 没有任何一个选项标了 ok:true` });
      return null;
    }
    if (p.type === 'multi' && okN < 2) {
      // 契约 §1.4.3：多选至少两个正确项。只标一个的多选会退化成单选（勾一个也对、勾两个也错），
      // 学员按"多选"的心态去做必然做不对，而页面不会给任何提示。
      issues.push({
        code: 'multi-too-few-ok',
        at,
        id: parentId,
        message: `${at} 是 multi 多选，但只有 ${okN} 个正确项（至少要 2 个；只有一个正确项就应改用 type:"single"）`,
      });
      return null;
    }
    if (p.type === 'single' && okN > 1) {
      // 这条能自动救：把多出来的正确项降级会**改变答案**，绝不能自作主张。
      issues.push({
        code: 'single-multi-ok',
        at,
        id: parentId,
        message: `${at} 是单选却标了 ${okN} 个正确项——要么改成 type:"multi"，要么只留一个 ok:true`,
      });
      return null;
    }
    if (opts.some((x) => x.ok && !x.why.trim())) {
      fixes.push({ at, message: '有正确选项没写 why 解释（学生答对后看不到"为什么对"）' });
    }
    return p;
  }

  // num
  if (p.ansText != null) {
    if (!Array.isArray(p.ansText) || !p.ansText.length || p.ansText.some((x) => typeof x !== 'string' || !x.trim())) {
      issues.push({ code: 'bad-anstext', at, id: parentId, message: `${at} 的 ansText 要写成非空字符串数组，如 ["A/m","A·m⁻¹"]` });
      return null;
    }
    p.ansText = p.ansText.map((x) => String(x).trim());
    return p;
  }

  if (typeof p.ans === 'number') {
    if (!isFinite(p.ans)) {
      issues.push({ code: 'ans-not-finite', at, id: parentId, message: `${at} 的 ans 不是有限数字（NaN/Infinity）` });
      return null;
    }
  } else {
    const n = coerceNumber(p.ans);
    if (n == null) {
      issues.push({
        code: 'ans-not-number',
        at,
        id: parentId,
        message: p.ans === undefined
          ? `${at} 没写 ans（填数题必须有数字答案）`
          : `${at} 的 ans 必须是数字，现在是 ${JSON.stringify(p.ans)}（2.51×10⁻⁴ 要写成 2.51e-4）`,
      });
      return null;
    }
    // 救得回来就救，并顺手把答案里的单位搬进 unit（模型很爱把单位写在 ans 里）
    const u = extractUnit(p.ans);
    if (u && !p.unit) {
      p.unit = u;
      fixes.push({ at, message: `ans 里带着单位「${u}」，已搬到 unit 字段` });
    }
    fixes.push({ at, message: `ans 写成了 ${JSON.stringify(p.ans)}，已转成数字 ${n}` });
    p.ans = n;
  }

  if (p.tol != null) {
    // tol 只接受**纯数字**，不接受带单位的写法。`tol:"1%"` 被 coerceNumber 救成 1 是危险的：
    // 1% 是相对容差的意思，当成绝对容差 1 就意味着 ans=300 时 ±1 都算对，**错答会被判成对**。
    const raw = typeof p.tol === 'string' ? p.tol.trim() : p.tol;
    const t = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) ? Number(raw) : null;
    if (t == null || t < 0) {
      issues.push({ code: 'bad-tol', at, id: parentId, message: `${at} 的 tol 要是非负数字，现在是 ${JSON.stringify(p.tol)}` });
      return null;
    }
    p.tol = t;
  }
  if (p.unit != null && typeof p.unit !== 'string') p.unit = String(p.unit);
  return p;
}

/** 数一段题库里的"作答点"数（big 按 parts 数算），用于核对总量与占比。 */
function countPoints(items) {
  let n = 0;
  const byType = { single: 0, multi: 0, num: 0, big: 0 };
  for (const q of items) {
    if (q.type === 'big') {
      byType.big++;
      n += (q.parts || []).length;
    } else {
      byType[q.type] = (byType[q.type] || 0) + 1;
      n++;
    }
  }
  return { total: n, byType };
}

module.exports = {
  normalizeBank, coerceNumber, extractUnit, countPoints, desuper, desub,
  KNOWN_TYPES, PART_TYPES,
};
