'use strict';
/* 提示词装配。
 *
 * 「内核是 skill」这句话在这里落地：系统提示词 = SKILL.md 全文 + 生成契约的相关章节，
 * 两者都是**运行期从磁盘读**的（打包后从 resources/skill 与 resources/docs 读），
 * 改了 skill 不用改代码。
 *
 * 一条重要的取舍：**每个阶段只喂它那一段契约**。
 * 契约全文约 25KB，四段生成要跑 7~10 次调用，全量喂进去既贵又会让模型的注意力散掉。
 */

const fs = require('fs');
const path = require('path');

let cachedContract = null;
let cachedSkillMd = null;
let cachedContractPath = null;

/** 契约文档在哪：开发态在 apps/isg-studio/docs，打包态在 resources/docs。 */
function contractPath() {
  if (cachedContractPath) return cachedContractPath;
  const { app } = require('electron');
  const candidates = [];
  if (app && app.isPackaged) candidates.push(path.join(process.resourcesPath, 'docs', 'generation-contract.md'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'docs', 'generation-contract.md'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'isg-studio', 'docs', 'generation-contract.md'));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedContractPath = c;
      return c;
    }
  }
  throw new Error('找不到生成契约文档 generation-contract.md（应该在 apps/isg-studio/docs/ 下）');
}

/**
 * 把契约文档按 `## N. 标题` 切成小节。
 * 切不出来就抛错——**不允许静默退化成一整份文档**，那样提示词会悄悄变成另一个东西。
 */
function contractSections() {
  if (cachedContract) return cachedContract;
  const text = fs.readFileSync(contractPath(), 'utf8');
  const parts = {};
  const re = /^##\s+(\d+)\.\s*(.+)$/gm;
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ n: m[1], title: m[2], start: m.index });
  if (!hits.length) throw new Error('生成契约文档里找不到 "## N. 标题" 形式的小节');
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    parts[h.n] = { title: h.title, body: text.slice(h.start, end).trim() };
  });
  // 前言（第一个小节之前的内容）
  parts.intro = { title: '前言', body: text.slice(0, hits[0].start).trim() };
  cachedContract = parts;
  return parts;
}

function skillMd() {
  if (cachedSkillMd) return cachedSkillMd;
  const { readSkillMd } = require('../skill');
  cachedSkillMd = readSkillMd();
  return cachedSkillMd;
}

const CORE_SECTIONS = ['0', '1', '2', '3'];

/** 系统提示词。stage ∈ 'plan'|'prose'|'bank'|'demo'。 */
/** 从上下文里取语言设置。默认简体中文——这套材料是给中文学生看的。 */
function langOf(ctx) {
  return (ctx && ctx.options && ctx.options.language) || 'zh-CN';
}

function systemPrompt(stage, opts) {
  const sec = contractSections();
  // §6 是"输入来源与多来源融合"，只对逐来源分析那一步有意义（它在契约末尾，见那里的说明）。
  // 取不到就跳过——`sec[k]` 为空时下面的循环本就不 push，所以这里不需要额外兜底。
  const want = stage === 'demo' ? ['0', '4', '2'] : stage === 'analyze' ? ['0', '6'] : CORE_SECTIONS;
  const chunks = [];
  chunks.push('# 你是「讲练一体」学习页的生成器');
  chunks.push(
    '你在为一位老师/学生生产**单文件 HTML 学习材料**的**零件**。' +
      '页面外壳、判分引擎、样式、进度条、结算区、陪练全部由宿主程序注入，' +
      '**你一个字都不要写它们**——你只产出下面契约里规定的那几样东西。'
  );
  /* ⚠️ 这一节是**对 SKILL.md 的覆盖**，不是补充说明。
     SKILL.md 是写给 Claude Code 的：它会让模型"把素材落盘到 _work/units.md"、
     "开两个子代理（出题 / 审题）"、"跑 inject-probe.py 校验"。这些在应用里**一样都做不到**——
     应用只是一次普通的 API 调用，没有文件系统、没有子代理、没有无头浏览器。
     不写清楚会怎样：模型可能去"写文件"（产出变成一段 _work/units.md 的正文而不是要的 JSON）、
     或者写一句"已交给审题代理"就收工。这类失败还很隐蔽——JSON 可能仍然是合法的，
     只是内容跑偏了。所以必须明说。 */
  chunks.push(
    '## 运行环境（**这一节覆盖 SKILL.md 里与它冲突的部分**）\n' +
      '你是在**一次普通的 API 调用**里工作的，不是 Claude Code。具体地说：\n' +
      '1. **没有文件系统**。不要"把素材落盘到 `_work/…`"、不要写任何文件、' +
      '也不要说"已保存到某路径"。你需要的一切，我在下面的提示词里直接给你。\n' +
      '2. **没有子代理**。不要派代理、不要等"审题代理"回来、不要写"这一步交给 XX 代理"。' +
      '该做的内容你一次做完；**独立审题那一步由调用你的程序另起一次调用完成**——' +
      '所以你只需要保证自己这一步的输出质量，不用替它操心。\n' +
      /* ⚠️ 多来源之后必须补这一条。用户可能一次给了课件 + 课本 + 习题 + 历年真题，
         而每一份来源**已经**被另一次独立调用分析过了。不写清楚会怎样：
         模型会试图"把整本课本也分析一遍"（顶爆上下文），或者写一句
         "已分别分析完三份来源"就收工——**而 JSON 仍然合法**，失败极其隐蔽。 */
      '   多来源时同理：**每一份来源也各由一次独立调用分析过了**，它们的结论会在下面直接给你。' +
      '你不要重做那份分析、不要假装去读文件、也不要写"我先分析一下各份材料"。\n' +
      '3. **不要输出过程叙述或工具调用**：不要写"我先读一下…""接下来我会…"，直接给约定的那个 JSON。\n' +
      '4. SKILL.md 里凡提到 `_work/`、子代理、`inject-probe.py`、无头浏览器、截图的地方，' +
      '都是给 Claude Code 用的，**与你无关**，按上面三条做即可。'
  );

  /* ⚠️ 语言：以前**一个字都没写**，完全指望模型自己"看着办"。
     后果很实在：课件是英文时（外文教材、英文 PPT 很常见），模型会顺着用英文写讲解、
     选项、解析——而这一整套材料是给中文学生看的。所以显式钉住，并做成可选项。 */
  const lang = (opts && opts.language) || 'zh-CN';
  if (lang === 'follow') {
    chunks.push(
      '## 语言\n' +
        '**跟随课件原文的语言**：课件是中文就用简体中文写、是英文就用英文写，别混着来。' +
        '同一份材料里前后保持一致。'
    );
  } else {
    chunks.push(
      '## 语言：**全部内容一律用简体中文**\n' +
        '包含但不限于：单元标题、讲解正文、题干、选项文字、`hint`（思路提示）、`sol`（解析）、' +
        '选项的 `why`（错在哪）、演示的标题与读数名、`finalAdvice`。\n' +
        '- **课件原文是英文（或别的语言）也一样**：读懂之后用简体中文重写；' +
        '不要照抄原文，也不要中英混排、两边各说一半。\n' +
        '- 专业术语可以「中文（English）」这样并排标注**一次**（例如「磁化强度（magnetization）」），' +
        '但正文、题干、解析必须是简体中文。\n' +
        '- 符号、公式、单位、变量名保持原样（`μ₀`、`A/m`、`nI` 这些不翻译）。'
    );
  }

  chunks.push('## 你的输出铁律\n' +
    '1. 只输出**一个 JSON 对象**，不要 Markdown 围栏、不要任何解释文字。\n' +
    '2. JSON 里**不许有尾逗号、注释、单引号、NaN、undefined**。\n' +
    '3. 字符串里的换行用 \\n 转义，引号用 \\" 转义。\n' +
    '4. 宁可少写一点，也不要写坏结构——结构坏了整段内容会凭空消失，而页面不会有任何报错。');
  for (const k of want) {
    if (sec[k]) chunks.push(sec[k].body);
  }
  // SKILL.md 只在"写讲解/写题"的阶段附上——它讲的是讲法、形态铁律与踩过的坑。
  // 演示那一步要的是契约 §4 的填空模板，附上整份 SKILL.md 只是白占上下文：
  // 实测演示是**最容易撞输出上限**的一步（要一次吐 markup + JS + checks），
  // 把这几 KB 让给输出更划算。
  if (stage !== 'demo') {
    chunks.push('## 附：技能规范原文（讲法、形态铁律、踩过的坑都以它为准）\n' + skillMd());
  }
  return chunks.join('\n\n---\n\n');
}

function json(obj) {
  return JSON.stringify(obj, null, 1);
}

/** 把抽取出来的课件文本按预算裁成可喂给模型的段落。 */
function sourceText(pages, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 24000;
  const keep = (pages || []).filter((p) => p && p.text && p.text.trim());
  const total = keep.reduce((n, p) => n + p.text.length, 0);
  if (total <= maxChars) {
    return keep.map((p) => `【第 ${p.index} 页】\n${p.text.trim()}`).join('\n\n');
  }
  // ⚠️ **必须真的刹车**：页数一多，`per` 的下限（400）会把总长顶穿预算——
  // 实测 100 页时 plan 提示词 4.3 万字（预算 2.6 万）、300 页 12.9 万字、800 页 34 万字，
  // 直接超出多数模型的上下文而 400 失败；这段文本还会在每个单元的调用里**重复发一遍**。
  //
  // 刹车按**实际累计长度**算，不是按正文长度：每页还有 `【第 N 页】` 页头、"（此处截断）"
  // 尾注与 `\n\n` 分隔符，页数一多这些加起来能到上千字（只按正文算会超 1~1.1 千字，实测过）。
  const out = [];
  let emitted = 0;
  let dropped = 0;
  const reserve = 120; // 给最后那句汇总留位置
  const budget = Math.max(600, maxChars - reserve);
  const per = Math.max(200, Math.floor(budget / keep.length));

  for (const p of keep) {
    const t = p.text.trim();
    const head = `【第 ${p.index} 页】\n`;
    const room = budget - emitted - head.length;
    if (room <= 40) {
      // 预算用完：**只留页号**，让模型知道这里还有内容，而不是以为这一页不存在
      dropped++;
      continue;
    }
    const take = Math.min(t.length, per, room);
    let chunk;
    if (take >= t.length) {
      chunk = head + t;
    } else if (take > 0) {
      chunk = `${head}${t.slice(0, take)}\n…（本页共 ${t.length} 字，此处截断）`;
      if (chunk.length > budget - emitted) chunk = head + t.slice(0, Math.max(0, room));
    } else {
      dropped++;
      continue;
    }
    out.push(chunk);
    emitted += chunk.length + 2; // +2 是 join('\n\n') 的分隔符
  }

  out.push(
    dropped
      ? `（课件较长，以上为节选：有 ${dropped} 页因篇幅原因未展开，共 ${keep.length} 页 / ${total} 字。` +
        '如需覆盖它们，请把这一章拆成几个文件分别生成。）'
      : `（课件较长，以上为节选；共 ${keep.length} 页 / ${total} 字）`
  );
  return out.join('\n\n');
}

/* ---------------- 多来源：素材段的组织 ---------------- */

/* 各角色的**原文权重**。
   ⚠️ `exampaper: 0` 不是"省 token"，是把"只提炼真题规律、不收录真题原文"从口号
   落到工程上：真题的正文**根本不进提示词**，模型就算想抄也无从抄起。
   它仍然会以"摘要"的形式参与（题型分布、常考考法），那是我们要的那部分。 */
const ROLE_WEIGHTS = { courseware: 1, textbook: 0.6, exercises: 0.4, exampaper: 0 };

/* 课件原文的上限——这是**护栏，不是预算**。
   ⚠️ 为什么不干脆"全附"：`sourceText()` 里那条刹车（见它自己的注释）正是因为
   「100 页课件会让规划提示词涨到 4.3 万字、直接超出多数模型的上下文而 400」才加的。
   **常规的一章课件远达不到这个数**——低于上限时 `sourceText()` 原样返回全部页，
   所以正常情况下这就是"全附"。真遇到几百页的材料会截断并在日志里说明，
   总比整个任务失败好。 */
const COURSEWARE_CAP = 60000;

/** 这份来源该用哪组页。textbook 可能被 scope 限成一节，那就用那一节。 */
function pagesOf(s) {
  if (!s) return [];
  if (Array.isArray(s.scopedPages)) return s.scopedPages;
  return s.pages || [];
}

/** 提示词里怎么称呼这份来源——用用户起的名字，其次文件名，最后才是内部 id。 */
function labelOf(s) {
  return (s && (s.label || s.fileName || s.id)) || '未命名来源';
}

const ROLE_LABEL = { courseware: '课件', textbook: '课本', exercises: '习题', exampaper: '历年真题' };

/** 把一份来源的分析结论压成一小段（它会进后面每一次调用，所以必须短）。 */
function noteSummary(s) {
  const n = s && s.note;
  if (!n) return '';
  const L = [];
  L.push(`### 来源「${labelOf(s)}」（${ROLE_LABEL[s.role] || s.role}）的分析结论`);
  if (n.summary) L.push(n.summary);
  if (Array.isArray(n.outline) && n.outline.length) {
    L.push('结构：' + n.outline.map((u) => u && u.title).filter(Boolean).join(' / '));
  }
  if (Array.isArray(n.terms) && n.terms.length) {
    L.push('术语：' + n.terms.slice(0, 20).map((t) => (t && t.en ? `${t.zh}（${t.en}）` : (t && t.zh) || '')).filter(Boolean).join('、'));
  }
  if (Array.isArray(n.formulas) && n.formulas.length) L.push('关键公式：' + n.formulas.slice(0, 10).join('；'));
  if (Array.isArray(n.questionTypes) && n.questionTypes.length) {
    L.push('题型规律（**出题必须贴合**）：' +
      n.questionTypes.slice(0, 12).map((q) => q && `${q.shape}→${q.mapped}${q.note ? `（${q.note}）` : ''}`).join('；'));
  }
  if (n.coverage && n.coverage.truncated) L.push('（这份材料较长，分析时只看了节选）');
  return L.join('\n');
}

/**
 * 多来源的素材段。**摘要在前，原文在后**——摘要便宜且信息密度高，先讲清"这是什么"。
 *
 * 单来源时与从前**逐字节一致**：`list.length === 1` 直接走 `sourceText()`，
 * 而低于上限时 `sourceText()` 原样返回全部页，所以常规课件的行为一个字都没变。
 * 这条不是巧合，是刻意保的——它是"现有 16 套自测继续全绿"的闸门。
 */
function sourceTextAll(sources, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 24000;
  const list = (sources || []).filter((s) => s && !s.dropped && pagesOf(s).length);
  if (!list.length) return '';

  /* ⚠️ 单来源这一支**必须原样**用传进来的预算，不能换成 COURSEWARE_CAP。
     多来源才走"课件全附"那条路（那是用户对"融合时喂什么"的选择）；
     单来源保持与从前逐字节一致，是"现有自测继续全绿"的闸门——
     换了上限，中等长度的课件会突然不再截断，提示词跟着变，闸门就没了。 */
  if (list.length === 1) {
    return sourceText(pagesOf(list[0]), { maxChars });
  }

  const parts = [];
  // ① 每份来源的分析结论（含真题——它只给规律，不给原文）
  for (const s of list) {
    const note = noteSummary(s);
    if (note) parts.push(note);
  }
  // ② 课件原文：整份给（护栏见 COURSEWARE_CAP 的说明）
  for (const s of list.filter((x) => x.role === 'courseware')) {
    parts.push(`### 来源「${labelOf(s)}」原文\n` + sourceText(pagesOf(s), { maxChars: COURSEWARE_CAP }));
  }
  // ③ 其余来源的原文：在剩余预算里按权重分。exampaper 权重为 0，所以这里根本不会出现它。
  const others = list.filter((x) => x.role !== 'courseware' && ROLE_WEIGHTS[x.role] > 0);
  if (others.length) {
    const rest = Math.max(0, maxChars - parts.join('\n\n').length);
    const wsum = others.reduce((n, s) => n + ROLE_WEIGHTS[s.role], 0);
    for (const s of others) {
      // 每份**独立**走 sourceText 的刹车，避免一份 300 页课本把课件饿死
      const quota = Math.max(2000, Math.floor((rest * ROLE_WEIGHTS[s.role]) / wsum));
      parts.push(`### 来源「${labelOf(s)}」原文\n` + sourceText(pagesOf(s), { maxChars: quota }));
    }
  }
  const out = parts.join('\n\n');
  if (out.length > maxChars * 1.05) {
    // 护栏：万一 helper 被改坏，也不能让单次提示词悄悄超预算（超了就是 400）
    return out.slice(0, Math.floor(maxChars * 1.05));
  }
  return out;
}

/** 从 ctx 里取来源列表。**老调用只有 `ctx.pages`**（没有 sources），退化成"只有一份课件"。 */
function sourcesOf(ctx) {
  if (ctx && Array.isArray(ctx.sources) && ctx.sources.length) return ctx.sources;
  return [{ id: 's1', role: 'courseware', pages: (ctx && ctx.pages) || [] }];
}

/** 规划阶段要的素材：多来源时以"分析结论"为主（它要的是融合后的结构，不是几份原文）。 */
function materialForPlan(ctx) {
  const sources = (ctx && ctx.sources) || [];
  const usable = sources.filter((s) => s && !s.dropped && pagesOf(s).length);
  // 单来源 courseware 且没有分析结论 → 与从前逐字节一致
  if (usable.length <= 1 && !usable.some((s) => s.note)) {
    return sourceText(ctx.pages, { maxChars: 26000 });
  }
  return sourceTextAll(sources, { maxChars: 26000 });
}

/* ---------------- S0 · 逐来源分析 ---------------- */

/**
 * 每份来源各起一次**独立**调用去理解它。
 *
 * 隔离原则与独立审题（`auditMessages`）完全一致：只给它**这一份**来源的材料与角色说明，
 * 不给它别的来源的结论、不给任何出题过程的痕迹。这样每份材料被独立理解一遍，
 * 后面做融合的人才拿到互不污染的几个视角。
 */
function sourceNoteMessages(ctx, src) {
  const lang = langOf(ctx);
  const role = (src && src.role) || 'courseware';
  const scopeLine = src && src.scope && src.scope.label
    ? `\n**只看这一部分**：${src.scope.label}（用户指定；其余部分不在本次范围内，不要分析它）`
    : '';
  const byRole = {
    courseware: '这是**课堂课件**。把它的知识骨架抽出来：讲了哪几块、每块的核心结论、' +
      '用到的公式与常数、以及课件里出现过的例题类型。',
    textbook: '这是**教材**。把这一节的骨架抽出来：概念的定义、推导链条、' +
      '用到的公式与常数、以及定义性/前提性的表述（以后出题必须与它一致）。',
    exercises: '这是**习题集**。不要抄题，提炼它的**练法**：覆盖哪些知识点、' +
      '各是什么题型、难度分布、以及学生最容易在哪一步出错。',
    exampaper: '这是**历年真题**。⚠️ **绝对不要摘抄原题**，只提炼**题型规律**：' +
      '这份卷子由哪些题型构成、各占多少题/多少分、考法是"直接套公式"还是"两步计算"、' +
      '哪些考法反复出现。每一条都要给出它对应到我们四种题型的哪一种。',
  };
  const user =
    `## 任务：来源分析（S0 / source-note.json）\n\n` +
    `来源 id 是 "${src.id}"，角色是：${role}（${ROLE_LABEL[role] || role}）。` +
    `文件名：${src.fileName || ''}。${scopeLine}\n\n` +
    (byRole[role] || byRole.courseware) + '\n\n' +
    `### 我们的四种题型（你给出的 mapped 只能取其中之一）\n` +
    `- single 单选 · multi 多选 · num 填数值 · big 综合大题（含 parts）\n` +
    `真题里的判断题请映射成 two-option 的 single，填空题映射成 num（非数值用 ansText），` +
    `简答/计算/证明映射成 big。**不要自创 judge/fill/short 这类题型名。**\n\n` +
    `### 输出这个 JSON\n` +
    json({
      sourceId: '<照抄上面给的 id>',
      role: '<照抄上面给的角色>',
      summary: '这份材料是什么、覆盖什么（≤300 字）',
      outline: [{ title: '小节标题', points: ['这一小节的核心结论'] }],
      terms: [{ zh: '中文术语', en: 'English' }],
      formulas: ['T = nI'],
      constants: [{ name: '真空磁导率', value: '4π×10⁻⁷', unit: 'H/m' }],
      questionTypes: [{ shape: '两步计算', mapped: 'big', note: '每年必考' }],
      coverage: { truncated: false, note: '如果你只看到了一部分材料（被截断），把 truncated 写成 true' },
      warnings: ['这份材料里我没看懂的地方'],
    }) +
    `\n\n（questionTypes 只在 exampaper 时必填；别的角色给了也没关系。` +
    `不要输出任何解释文字，只给一个 JSON 对象。）\n\n` +
    `### 材料正文\n` +
    sourceText(pagesOf(src), { maxChars: role === 'exampaper' ? 20000 : 24000 });

  return { system: systemPrompt('analyze', { language: lang }), user };
}

/**
 * 把历年真题里提炼出的**题型规律**渲染成一段"必须贴合"的约束。
 *
 * 没有真题来源时返回空串——**不制造噪音**：只导了一份课件的人不该在提示词里
 * 看到一整节跟他无关的规矩。
 */
function questionTypeBlock(ctx) {
  const papers = ((ctx && ctx.sources) || []).filter((s) => s && s.role === 'exampaper' && s.note);
  if (!papers.length) return '';
  const rows = [];
  for (const s of papers) {
    for (const q of (s.note.questionTypes || [])) {
      if (!q || !q.shape) continue;
      rows.push(`- ${q.shape} → 用 \`${q.mapped}\`${q.note ? `：${q.note}` : ''}`);
    }
  }
  if (!rows.length) return '';
  return (
    '### 真题题型规律（**出题必须贴合这些形态**）\n' +
    rows.slice(0, 16).join('\n') + '\n' +
    '右边那一列是它在我们引擎里对应的题型。**`type` 只能取 single / multi / num / big 这四种**，' +
    '不要自创 judge（判断）、fill（填空）、short（简答）这类名字 —— 引擎不认识它们，' +
    '后果是题目被降级成单选、答案语义错位，**而页面不会有任何报错**。'
  );
}

/* ---------------- 跨章：前面几章讲了什么 ---------------- */

/**
 * 「关联生成」时才存在的那一段（用户在这一册的两章关联大时，在运行中选了它）。
 *
 * ⚠️ 返回的是**行数组**，不是字符串 —— 调用点用 `...` 展开进 `[...].join('\n')`。
 * 这么写是为了"没有这个字段时**逐字节不变**"：往数组里插一个空串会让 `join('\n')`
 * 多出一个空行，而绝大多数生成走的是"简单缝合"那一路，它们的提示词一个字都不许变。
 *
 * 为什么只给摘要：这一段的用处是"知道前面讲过什么"，不是"再读一遍前面的材料"。
 * 上下文要留给这一章自己的原文；而摘要本来就是"这份材料是什么"里密度最高的那一段。
 */
function priorChapterLines(ctx) {
  const rows = ((ctx && ctx.priorChapters) || []).filter((c) => c && c.summary);
  if (!rows.length) return [];
  return [
    '',
    '### 这本册子里**前面**已经讲过的章',
    '（用户选了「关联生成」，所以下面这些你在写这一章时要**主动照应**：前面讲过的概念不要'
      + '再从头解释一遍，能引用就引用；本章要用的工具如果前面讲过，点一句"上一章那个 X 在这里'
      + '怎么用"。**但不要为呼应而呼应** —— 跟本章没关系的地方就别硬扯。）',
  ].concat(rows.map((c) => `- 第 ${c.no} 章${c.title ? '「' + c.title + '」' : ''}：${c.summary}`));
}

/* ---------------- S1 · 切单元 ---------------- */

function planMessages(ctx) {
  const { meta, options } = ctx;   // 素材走 materialForPlan(ctx)，这里不再直接读 ctx.pages
  const unitLo = 3;
  const unitHi = 8;
  const want = Math.min(unitHi, Math.max(unitLo, options.units || 6));
  const user = [
    '## 任务：切单元（S1 / outline.json）',
    '',
    `这门课件是：**${meta.subject || '（未填）'}** 的 **第 ${meta.number || '?'} 章 · ${meta.title || '（未填）'}**。`,
    `请把整章切成 **${want} 个讲解单元** + **1 个综合大题单元**，总共 ${want + 1} 个题区。`,
    `整章的作答点目标：**约 ${options.points || 65} 个**（概念题与计算题大致各半，综合大题占 1/4 左右）。`,
    options.demos > 0
      ? `请设计 **${options.demos} 个可拖演示**（详见契约 §1.2 的 demos 字段）。`
      : '不要设计演示（demos 给空数组）。',
    '',
    '**你这一轮只切结构、配额度，不要写正文、不要写题。**',
    '',
    '### 输出前自查（不满足就改到满足）',
    '1. `answerPoints` == Σ`units[].targetCount` + `bigUnit.targetCount`（**必须精确相等**）',
    '2. `units[].lv` 互不重复，且构成 0..n 的连续序列（热身单元是 0；不要热身就从 0 开始）',
    '3. `sectionId` / `uid` / `qsecId` 全局唯一；`qsecId == "p-l"+lv`；`refAnchor == "#"+sectionId`',
    '4. 每个 `qsecTitle` 以「练一练」开头，且**不含**「已答」二字',
    '5. `chapter.key` **不要写**——宿主程序会自己生成存盘键，你写了也会被覆盖。',
    ...priorChapterLines(ctx),
    '',
    /* ⚠️ 这里必须走 materialForPlan，不能直接 sourceText(ctx.pages, …)。
         多来源时规划要的是**各份来源的分析结论**（融合后的结构），而不是几份原文——
         N 份原文全塞进这一步是最容易把上下文顶爆的地方。
         单来源课件时 materialForPlan 内部就退化成原来那一句，输出逐字节不变。 */
    ctx.sources && ctx.sources.length > 1 ? '### 各来源的材料' : '### 课件原文',
    materialForPlan(ctx),
    '',
    '只返回 S1 的 JSON。',
  ].join('\n');
  return { system: systemPrompt('plan', { language: langOf(ctx) }), user };
}

/* ---------------- S2 · 单元讲解正文 ---------------- */

function proseMessages(ctx, unit) {
  const { outline, options } = ctx;
  const demos = (outline.demos || []).filter((d) => d.unitUid === unit.uid);
  const user = [
    `## 任务：写「${unit.title}」这一节的讲解正文（S2 / unit-prose.json）`,
    '',
    `所属：${outline.chapter.subject} 第 ${outline.chapter.no} 章 · ${outline.chapter.title}`,
    // uid / sectionId 必须原样回填：执行层靠它把这份正文对上是哪个单元。
    // 不写在提示里，模型就只能猜，猜错的表现是"两个单元换了正文"且不报错。
    `本单元的 uid 是 "${unit.uid}"，sectionId 是 "${unit.sectionId}" —— 请**原样**回填到输出的同名字段里。`,
    `本节要讲透的概念：${(unit.concepts || []).join('、')}`,
    unit.formulas && unit.formulas.length ? `本节的核心公式：${unit.formulas.join('；')}` : '',
    ...priorChapterLines(ctx),
    '',
    '**讲法按 skill 的既定四段式，不许改**：每个知识块内部依次写',
    '① 大白话：这一块要解决什么问题 → ② 核心公式 → ③ 公式为什么长这样 → ④ **单独一段易错点**。',
    '公式后面给一句**记忆锚**（口诀或图像）。**记忆锚与易错点是重点，不许省。**',
    '',
    // ⚠️ 这行原来写成「（`<h3>`）」，模板字符串里的裸反引号会把 `<h3>` 甩到 JS 语法里去，
    // 变成 `字符串 < h3 > 字符串` 这种**语法合法、语义错误**的比较表达式（报 h3 is not defined）。
    // 凡是模板字符串，正文里提到标签一律用 ⟨⟩ 或去掉反引号——这个坑探针查不出来，只有真跑才炸。
    `写 ${Math.max(1, Math.min(4, (unit.concepts || []).length))} 个知识块（每个知识块一个 <h3> 小标题）。`,
    '',
    '### 硬性要求',
    '- `html` **从 `<h3>` 开始**，**不要**写 `<section>` / `<h2>` 外壳（宿主程序会加）。',
    '- 不许出现 `<script>`、`<style>`、`<h1>`；不许引 MathJax / LaTeX / CDN；公式一律用纯 HTML + Unicode 写。',
    '- `<h3>` 上要带一个稳定的 id（形如 `id="k1311"`），题库的「回看」链接会指向它。',
    demos.length
      ? `- 本节的演示要嵌在它对应的知识点**正下方**，位置写成占位注释：${demos.map((d) => `\`<!--DEMO:${d.id}-->\``).join('、')}（每个**恰好出现一次**，不要写演示的 HTML，宿主会填）`
      : '',
    '- `blocks` 字段必须**精确等于** `html` 里 `<h3>` 的出现次数。',
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 18000 }),
    '',
    '只返回 S2 的 JSON（`{uid, sectionId, blocks, html}`）。',
  ]
    .filter(Boolean)
    .join('\n');
  return { system: systemPrompt('prose', { language: langOf(ctx) }), user };
}

/* ---------------- S3 · 单元题库 ---------------- */

function bankMessages(ctx, unit) {
  const { outline, options } = ctx;
  const isBig = !!unit.isBigUnit;
  const n = unit.targetCount || 10;
  const mix = isBig
    ? `全部用 \`type:"big"\` 的大题（一步一问），**parts 总数必须精确等于 ${n}**，建议 ${Math.max(1, Math.round(n / 5))} 道大题、每题 4~6 步。`
    : `共 **${n} 个作答点**。建议配比：单选/多选约 ${Math.round(n * 0.4)} 个、填数值约 ${Math.round(n * 0.6)} 个。`;
  const user = [
    `## 任务：写「${unit.title}」这一节的题库（S3 / bank.json）`,
    '',
    mix,
    // 关联生成时，前面几章讲过的概念就不要再出重复的题了
    ...priorChapterLines(ctx),
    '',
    ...(questionTypeBlock(ctx) ? [questionTypeBlock(ctx), ''] : []),
    '### 硬性要求（每一条都会被执行层机械校验，不合格会打回重写）',
    '- 数值题的 `ans` **必须是 JSON 数字**，写成字符串会永远判错。`2.51×10⁻⁴` 要写成 `2.51e-4`。单位写在 `unit` 字段里，不要写在 `ans` 里。',
    '- 单选恰好一个 `ok:true`；多选至少两个 `ok:true`（或至少两个正确项）。选项 2~6 个。',
    '- 每个选项都要有 `why`：正确项写「为什么对」，干扰项写「**它错在哪**」——这句是给学生看的，要具体。',
    '- 每题都要有 `hint`（**只给方向，不给答案**）。',
    '- `id` 只写本单元内唯一的短名（如 `l1-1`、`n1-2`），宿主会加前缀保证全局唯一。',
    '- `lv` 不用你写（宿主按单元填）。',
    '- 干扰项要**像真的**：用学生真会犯的错（把 H 当磁场强弱、漏掉 μ₀、把 μr 当 1…），不要写一眼假的。',
    isBig
      ? '- 综合大题要**把整章串起来**：题干给一个完整情境，每一步单独作答、单独判分。'
      : `- 题目要扣住这两件事：${(unit.concepts || []).join('、')}。`,
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 16000 }),
    '',
    `只返回 S3 的 JSON（\`{uid:"${unit.uid}", bankId:"bankN", lv:${unit.lv}, items:[...]}\`）。`,
  ].join('\n');
  return { system: systemPrompt('bank', { language: langOf(ctx) }), user };
}

/* ---------------- S3.5 · 独立审题（对应 skill 的「子代理 B」） ----------------
 *
 * skill 在 2026-10-16 的版本里加了一条：一章 ≥40 个作答点时，默认开两个子代理——
 * 一个出题、一个**独立重算**审题。理由是探针只验得了"判分逻辑对不对"，
 * **验不了"答案本身对不对"**：数值题答案错一位，学生就照着学错，这是最贵的一类错。
 *
 * 应用里没有子代理，但**可以真的再调一次模型**：给它题库和素材、不给任何出题过程的痕迹，
 * 让它自己从头算一遍。这正是"独立"的含义——它的判断不依赖出题人的推导。
 */
function auditMessages(ctx, unit, bankItems, opts) {
  const total = (opts && opts.total) || 1;
  const index = (opts && opts.index) || 1;
  const user = [
    `## 任务：独立审题 —— 把「${unit.title}」这一节的题库重算一遍`,
    '',
    '你是**审题人**，不是出题人。你看不到出题过程，也**不要去猜**它当时怎么想的。',
    '你唯一的职责：**用你自己的推导，独立判断每道题的答案对不对**。',
    '',
    '### 为什么要你来（这不是走过场）',
    '自动探针只能验证"判分逻辑对不对"（选项标了 ok 没有、数值容差合不合理、卡片渲染出来没有），',
    '**验证不了"答案本身对不对"**。数值题答案错一位，学生就照着错一位学下去——',
    '这是这套材料里最贵的一类错误，而它恰恰是自动检查抓不到的。',
    '',
    '### 怎么审',
    '1. **数值题**：自己从题干条件重新算一遍，与 `ans` 比。',
    '   注意常数与量级（μ₀ = 4π×10⁻⁷、c = 3×10⁸、10⁻⁴ 这类最容易错一位），',
    '   也要看 `tol` 是不是明显不合理（比如答案 300 却给 ±1 的容差）。',
    '2. **选择题**：标了 `ok:true` 的那个**是不是真的对**；每个干扰项**是不是真的错**；',
    '   `why` 里写的理由对不对（理由写反了同样是错——学生看的就是这句）。',
    '3. **多选题**：正确项的集合对不对（漏一个、多一个都算错）。',
    '4. **综合大题**：逐步重算，每一步都要对。',
    '5. 还要看：题干本身自不自洽、有没有两个选项其实都对、',
    '   数值题的答案有没有用到题干根本没给的条件。',
    '',
    // 多人交叉检验时，**必须告诉模型它是第几位**：它是独立重算的，不该猜别人在查什么，
    // 也不该为了"和前一位不一样"而刻意放过或加码。（顺带：假模型靠这句话区分审题人。）
    // 模板字符串：它本来就允许真换行，所以这里不写任何 \n 转义
    //（这个文件因为转义被写坏过两次，能不用就不用）
    total > 1
      ? `（你是 ${total} 位审题人里的**第 ${index} 位**。前面或后面还有别人在独立审同一份题库，
但你**看不到他们的结论**、也不需要猜他们在查什么。只按你自己的推导给出判断；
既不要因为"可能有人已经报过"就漏报，也不要为了显得不一样而硬报。
全对就照实写 {"issues":[]}。）`
      : '',
    '### 只报**你确信**的问题',
    '拿不准的**不要报**——误报会让出题人把本来对的改成错的。宁可漏报，不可误报。',
    '',
    '### 输出（只输出这一个 JSON）',
    '{"issues":[{"id":"题号","severity":"high","kind":"wrong-answer","detail":"问题是什么","suggest":"你认为应该是多少 / 应该怎么改"}]}',
    '',
    '- `severity`：`high` = 答案或判分会让学生学错（必须改）；`low` = 措辞、附加建议（可改可不改）。',
    '- `kind`：`wrong-answer` | `ambiguous` | `bad-why` | `off-topic` | `other`。',
    '- **全都正确就输出 {"issues":[]}** —— 这是正常且常见的结果，不要为了"交差"硬报几条。',
    '',
    '### 这一节对应的课件原文（核对常数、条件、单位用）',
    sourceTextAll(sourcesOf(ctx), { maxChars: 12000 }),
    '',
    '### 待审的题库',
    '```json',
    JSON.stringify(bankItems, null, 1),
    '```',
    '',
    '只返回那个 JSON。',
  ].join('\n');
  return { system: systemPrompt('bank', { language: langOf(ctx) }), user };
}

/* ---------------- S4 · 演示 ---------------- */

function demoMessages(ctx, demo) {
  const unit = (ctx.outline.units || []).find((u) => u.uid === demo.unitUid) || {};
  const user = [
    `## 任务：写演示 ${demo.id}（S4 / demo.json）`,
    '',
    `它属于「${unit.title || ''}」这一节。`,
    `拖什么：**${demo.slider}**`,
    `一句话结论（必须成立）：${demo.insight}`,
    `这条演示的物理公式：${demo.formula}`,
    `读数格子（3~4 个）：${(demo.readouts || []).join('、')}`,
    `画布：viewBox = "${demo.svgViewBox || '0 0 520 200'}"`,
    '',
    '### 硬性要求',
    `- \`markup\` 的根元素必须是 \`<div class="demo" id="${demo.id}">\`；里面所有元素 id 一律以 \`${demo.id}-\` 或契约 §4 的短前缀开头，**绝不与别的演示或题目卡片撞名**。`,
    '- `js` **不要包 `<script>` 标签**，必须以 `try{` 开头、以 `}catch(e){ console.error(...) }` 结尾（契约 §4.1 给了填空模板，照着填）。',
    '- **读数与图形都由公式现场算**，绝不许把数值写死；刻度坐标也要用 JS 算。',
    '- `viewBox` 四周留 8~12 单位余量（滑块拉到底时标签不能被裁）。',
    '- SVG 的 `<text>` 里**不能**用 `<sub>`/`<sup>`（会挤成一行）：数字下标用 ₀₁₂₃，字母写成 `μr`。',
    `- \`checks\` 给 2~3 组：你自己**按公式手算**出读数该是多少，再填 \`expect\`。**不许猜。**`,
    '',
    '### 篇幅（很重要）',
    '- `markup` 控制在 **60 行以内**、`js` 控制在 **80 行以内**、`checks` 只给 2~3 组。',
    '- 演示要**小而准**：一个滑块 + 两三个读数 + 一条曲线就够了，不要写复杂的动画或多组联动。',
    '- 写太长会被输出上限截断，那时**整段 JSON 都作废**（前功尽弃），宁可小一点。',
    '',
    '### 这一节对应的课件原文',
    sourceTextAll(sourcesOf(ctx), { maxChars: 12000 }),
    '',
    '只返回 S4 的 JSON。',
  ].join('\n');
  return { system: systemPrompt('demo', { language: langOf(ctx) }), user };
}

/* ---------------- 修复回灌 ---------------- */

function repairMessages(ctx, stage, problems, previousRaw, what) {
  const lines = [
    `## 任务：上一轮生成的「${what}」没通过校验，请修好重出`,
    '',
    '### 具体问题（逐条改，别改别的地方）',
  ];
  // 修复轮里**必须重申这是哪个单元**：模型看不到上一轮的提示词了，
  // 只靠标题猜的话，它完全可能把第二个单元的题塞进第一个单元，而页面不会有任何报错。
  if (ctx && ctx.unit) {
    lines.push('');
    lines.push(`（重申）本单元的 uid 是 "${ctx.unit.uid}"，sectionId 是 "${ctx.unit.sectionId || ''}"，lv 是 ${ctx.unit.lv} —— 请原样回填。`);
  }
  for (const p of problems) lines.push(`- ${p}`);
  const prev = String(previousRaw || '').trim();
  if (prev) {
    lines.push('');
    lines.push('### 你上一轮的原样输出（供对照，可能被截断）');
    lines.push('```');
    lines.push(prev.slice(0, 6000));
    lines.push('```');
  } else {
    // 上一轮返回的是**空正文**。塞一个空的代码块进去只会让模型困惑
    // （"上一轮输出为空"本身不是它能修正的东西——要说清的是"没写出来"）。
    lines.push('');
    lines.push('### 说明');
    lines.push('你上一轮**没有输出任何正文**（不是格式问题，是空回复）。这一次请务必把完整的 JSON 写出来。');
  }
  lines.push('');
  lines.push('只返回修好后的完整 JSON（整份重出，不要只给差异）。');
  return { system: systemPrompt(stage, { language: langOf(ctx) }), user: lines.join('\n') };
}

module.exports = {
  systemPrompt,
  contractSections,
  contractPath,
  planMessages,
  proseMessages,
  bankMessages,
  auditMessages,
  demoMessages,
  repairMessages,
  /* ---- 多来源 ---- */
  sourceNoteMessages,   // S0：每份来源各一次独立分析
  sourceTextAll,        // 多来源的素材段（单来源时与从前逐字节一致）
  materialForPlan,      // 规划阶段要的素材
  sourcesOf,            // ctx → 来源列表（老调用退化成"只有一份课件"）
  questionTypeBlock,    // 真题题型规律 → 出题约束
  noteSummary,          // 一份来源的分析结论 → 一小段文字
  labelOf,              // 一份来源在提示词/日志里的称呼
  pagesOf,              // 一份来源该用哪几页（scope 生效时是那一节）
  ROLE_LABEL,
  ROLE_WEIGHTS,
  /* ---- 多章 ---- */
  priorChapterLines,    // 「关联生成」时那一段；没有 ctx.priorChapters 时返回**空数组**（逐字节不变）
  /* ---- 基础 ---- */
  sourceText,
  json,
};
