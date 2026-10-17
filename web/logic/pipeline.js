'use strict';
/* 生成流水线：抽取 → 规划 → 内容 → 演示 → 拼装 → 校验 → 修复。
 *
 * 贯穿全流程的三条纪律：
 *   1. **模型只产片段**，页面由 assemble.js 拼（见该文件顶部的说明）。
 *   2. **每一段模型输出都要先过校验**，不合格就带着具体问题回灌重出，
 *      绝不把"大概率有问题"的东西拼进页面。
 *   3. **不吞异常**：每个阶段失败都带上"哪个单元、第几次尝试、模型原文片段"，冒到 UI 上。
 */

const fs = require('fs');
const path = require('path');

const store = require('../store');
const jobs = require('../jobs');
const preview = require('../preview');
const { log, progress, isCanceled, CanceledError, fail, finish } = jobs;
const { normalizeBank, KNOWN_TYPES, PART_TYPES } = require('./bank');

/* 这些模块由别的子代理实现，用懒加载避免"它还没写好时整个应用起不来" */
function lazy(mod, name) {
  return () => {
    const m = require(mod);
    if (!m || typeof m[name] !== 'function') {
      throw new Error(`内部错误：模块 ${mod} 没有导出 ${name}()，应用装错了或文件被改坏了`);
    }
    return m[name];
  };
}
const getExtract = lazy('../extract', 'extract');
const getAssemble = lazy('./assemble', 'assemble');
const getSkill = lazy('../skill', 'skeleton');

const CONCURRENCY_DEFAULT = 3;

/* ---------------- 小工具 ---------------- */

/** 字符串的短哈希（FNV-1a，8 位十六进制）。给存盘键做去重指纹用，不做任何安全用途。 */
function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function slugify(s, fallback) {
  const t = String(s || '')
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return t || fallback;
}

/**
 * 章号：**规划阶段**的 chapter 用 `no`（`outline.chapter.no`），而**拼装器形状**的 chapter
 * 用 `number`（`newChapter.chapter`，见 assemble 的契约）。两个名字都得认。
 *
 * ⚠️ 只认一个的话，文件名会**静默**少掉 `ch13-` 那一段前缀（`outName` 读到的是 undefined）——
 * 产出照常、页面照常，只是文件名叫「磁介质-讲练一体.html」而不是「ch13-磁介质-讲练一体.html」。
 * 用户按名字归档时会发现它排不到一起，而没有任何地方报错。
 */
function chapterNoOf(chapter) {
  const c = chapter || {};
  return c.no != null && c.no !== '' ? c.no : (c.number == null ? '' : c.number);
}

function outName(chapter, srcPath) {
  // ⚠️ 章号来自**模型**（或用户在界面上随手填的），必须净化。
  // 实测过 `no: "../../../../evil"` 会让产出被写到输出目录之外；配合结果页那句
  // "用系统程序打开"，等于把攻击者编写的本地 HTML 摆到用户面前。
  // 只留字母数字与 - _ .，并截断——章号本来就只有几个字符。
  const safeNo = String(chapterNoOf(chapter))
    .replace(/[^\w.\-]/g, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 16);
  const no = safeNo ? `ch${safeNo}-` : '';
  const base = slugify(chapter.title || path.basename(srcPath, path.extname(srcPath)), 'study-guide');
  return `${no}${base}-讲练一体.html`;
}

/**
 * 把这次任务的日志落到**输出目录**，给"跑砸了之后还能回头看"用。
 *
 * 为什么需要它：任务日志以前**只在内存里**（还封顶 2000 条），应用一关就永久消失 ——
 * 用户看到一大段报错、关掉窗口就再也找不着，想复盘只能凭记忆。
 *
 * 命名与清理那边约定好了：`<产物名>.run.log`（`src/main/cleanup.js` 按 `*.run.log` 后缀认它，
 * 所以**改名字要两边一起改**）。产物还没写出来时（失败在拼装之前）就按源文件名推一个基名。
 *
 * ⚠️ 写日志这件事**绝不能反过来把收尾弄崩**：失败路径上再抛一个异常，
 * 用户连"任务失败"都看不到了。所以整段吞异常，只往日志里补一句。
 */
function writeRunLog(job, why) {
  try {
    const outDir = job.options.outputDir || path.dirname(job.filePath || '');
    if (!outDir) return '';
    fs.mkdirSync(outDir, { recursive: true });
    const base = job.htmlPath
      ? path.basename(job.htmlPath)
      : slugify(path.basename(job.filePath || 'run', path.extname(job.filePath || '')), 'run') + '-讲练一体.html';
    const logPath = path.join(outDir, base + '.run.log');
    const lines = [];
    lines.push('讲练一体工作台 · 这一次没跑完');
    lines.push('时间：' + new Date().toISOString());
    lines.push('材料：' + (job.sources || []).map((s) => s.fileName || s.filePath).join('、'));
    lines.push('结果：' + why);
    lines.push('产物：' + (job.htmlPath || '（还没到拼装那一步，所以什么都没写出来）'));
    lines.push('');
    lines.push('—— 下面是这次任务的完整日志 ——');
    for (const it of (job.logs || [])) {
      const t = new Date(it.ts || it.at || Date.now()).toISOString().slice(11, 19);
      lines.push(`[${t}] ${it.level || 'info'}  ${it.message}`);
    }
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    return logPath;
  } catch (e) {
    try { log(job, 'warn', '失败日志没能写出来（' + ((e && e.message) || e) + '）—— 界面上的日志照常可以看'); } catch (e2) { /* 连日志都写不了就算了 */ }
    return '';
  }
}

/**
 * 一册的文件名。**为什么不能沿用 `outName`**：那个只由"章号+标题"决定，
 * 而合并产物的章号取的是**本次新生成那一章**的 —— 于是它会**静默覆盖**掉这一章的单章产物。
 * 单章页有它自己的用处（这周就发这一章给同学），所以两个都得留着，名字必须区分开。
 */
function bookOutName(bookTitle, chapters, srcPath) {
  const nos = (chapters || [])
    .map((c) => String(chapterNoOf(c && c.chapter)).replace(/[^\w.\-]/g, '').replace(/\.{2,}/g, '.').slice(0, 16))
    .filter(Boolean);
  // 章号区间：`ch13-15-`。章号是字符串，直接取首尾（用户普遍按 13、14、15 这么写）
  const range = nos.length ? (nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : nos[0]) : '';
  const fallback = range ? `第${range}章` : path.basename(srcPath || '', path.extname(srcPath || ''));
  const base = slugify(bookTitle || fallback, 'book');
  return `${range ? 'ch' + range + '-' : ''}${base}-一册-讲练一体.html`;
}

/**
 * 有限并发地跑一批任务，保留顺序。
 *
 * **任何一项失败都立刻停下后面的**：`Promise.all` 只负责把错误抛出去，
 * 它**不会取消**其它 worker——它们会继续把剩下的单元一个个跑完、继续烧 API 额度，
 * 而且失败之后还在往这个任务里写"「U2」完成"的日志，界面上一片错乱
 * （用户此刻多半已经点了"重新生成"，于是两份任务同时在打模型）。
 * 所以这里用一个共享的停止标志，每个 worker 在取下一项之前都看一眼。
 *
 * @param {object} [state] 可选，调用方可以拿到 `state.stopped` 来判断"已经出事了"
 */
async function mapLimit(items, limit, fn, state) {
  const out = new Array(items.length);
  const st = state || {};
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      if (st.stopped) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        st.stopped = true;
        st.error = e;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------- 单次输出上限：先说好墙在哪 ---------------- */

/**
 * 由**声明的上下文窗口**推一个保守的单次输出上限。
 *
 * 除以 16 不是精确科学，是刻意保守：绝大多数模型的单次输出上限在上下文的 1/8 ~ 1/4 之间，
 * 取 1/16 意味着"这个数几乎不可能撞上服务端的硬上限"——而撞上硬上限的代价是
 * **整单在第一次调用就失败**（有些中转会直接把 `max_tokens` 超限当请求错误拒掉）。
 * 上下再夹一道：低于 16000 没有意义（还不如现在的默认值），高于 64000 就不必再大了——
 * 一次真吐出 6 万 token 的 JSON，解析与回灌的成本已经超过"重出一次"。
 */
function deriveOutputCap(contextLimit) {
  const n = Math.floor(Number(contextLimit) || 0);
  if (n <= 0) return 0;
  return Math.max(16000, Math.min(64000, Math.floor(n / 16)));
}

/**
 * 这次生成该用多大的输出上限。**整个应用只有这一个地方决定它**。
 *
 * 背景（这是一次真实故障的产物）：以前没有任何声明，`askJson` 从 16000 起步，
 * 撞上"输出被截断"就 16k→32k→64k 往上翻——**每翻一次就白烧一轮完整的调用**，
 * 而那一轮的结果一定是废的（截断的 JSON 解析不出来）。更糟的是最后一档也失败时，
 * 用户拿到的是一句"任务失败"，看不出"其实是墙太矮"。
 *
 * 现在：用户在设置里为每个模型声明一次上限，这里就**一步到位**。
 * 声明了就不爬（爬也没有意义——声明的就是墙）；没声明则**完全保持从前的行为**，
 * 免得老配置因为这一版突然变了性子。
 *
 * @param {object|undefined} modelCfg `providers.<id>.models` 里匹配上的那一项
 * @param {object} genOptions         任务选项（读 `maxOutput`：用户手填的覆盖值，0 = 自动）
 * @returns {{start:number, ceiling:number, climb:boolean, source:string}}
 *   `source` 取值：`declared-output` / `derived-context` / `user` / `default-climb`（进日志用）
 */
function resolveTokenPlan(modelCfg, genOptions) {
  const m = modelCfg && typeof modelCfg === 'object' ? modelCfg : {};
  const declaredOut = Math.floor(Number(m.maxOutput) || 0);
  const declaredCtx = Math.floor(Number(m.contextLimit) || 0);
  const user = Math.floor(Number(genOptions && genOptions.maxOutput) || 0);

  const hasDeclared = declaredOut > 0 || declaredCtx > 0;
  let ceiling;
  let source;
  if (declaredOut > 0) {
    ceiling = declaredOut;
    source = 'declared-output';
  } else if (declaredCtx > 0) {
    ceiling = deriveOutputCap(declaredCtx) || 64000;
    source = 'derived-context';
  } else {
    ceiling = 64000;
    source = user > 0 ? 'user' : 'default-climb';
  }

  let start;
  if (user > 0) start = Math.min(user, ceiling);
  else if (hasDeclared) start = ceiling;
  else start = 16000;

  /* 用户手填的值可能比声明的还大：那就以**声明的**为准（声明是墙），
     但起点仍给他填的那个数 —— 他要保守一点是他的自由，要冒进则不该越过墙。 */
  if (ceiling < start) ceiling = start;

  return { start, ceiling, climb: start < ceiling, source };
}

/**
 * 把这一次调用的 token 用量累加进任务（结果页据此给"预估费用"）。
 *
 * 三条取舍：
 *   · **只累加，不做任何计费判断** —— 单价是用户自己在设置里填的，这里不认识钱。
 *   · `usage.reported === false`（提供商没返回用量，例如某些中转的流式响应）时**照样计入调用次数**、
 *     但把 `reported` 记下来：结果页会明说"其中 N 次没有用量数据"，而不是假装总数是准的。
 *   · 失败/重试的那几轮**也算**（它们真的发出去并计费了）—— 只统计"成功那次"会把花费算少，
 *     而少算的那部分恰好是"重试很多次"的任务，正是用户最想知道的。
 */
function addUsage(job, usage) {
  if (!usage || typeof usage !== 'object') return;
  const u = job.usage || (job.usage = { in: 0, out: 0, calls: 0, unreported: 0 });
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  u.calls++;
  if (usage.reported === false) { u.unreported++; return; }
  u.in += n(usage.in);
  u.out += n(usage.out);
}

/** 提供商配置里取某个模型的声明。找不到就给 undefined（`resolveTokenPlan` 会走"没声明"那一路）。 */
function modelCfgOf(provider, model) {
  const list = (provider && Array.isArray(provider.models)) ? provider.models : [];
  const want = String(model == null ? '' : model);
  for (const m of list) {
    if (!m) continue;
    if (typeof m === 'string') { if (m === want) return { id: m }; continue; }
    if (String(m.id) === want) return m;
  }
  return undefined;
}

/**
 * 某个阶段该用哪个模型。
 *
 * 「分阶段用不同模型」只在**同一家提供商内**生效（跨提供商要另一把 Key，不做）：
 * 目的只有一个——把"便宜模型够用的那些调用"挪走，把贵模型留给真正要质量的那一步。
 * 用户没配就一直回落到主模型，于是**不配 = 与从前完全一样**。
 */
function modelForStage(settings, stage) {
  const st = (settings && settings.active && settings.active.stages) || {};
  if (stage === 'analyze' && st.analyze) return st.analyze;
  if (stage === 'audit' && st.audit) return st.audit;
  return (settings && settings.active && settings.active.model) || '';
}

/** 人话描述一份 token plan（进日志）。用户看得懂的措辞，不是枚举值。 */
function tokenPlanText(plan, scope) {
  const why = {
    'declared-output': '按你在设置里为这个模型声明的单次输出上限',
    'derived-context': '按你在设置里为这个模型声明的上下文窗口推算',
    user: '按你在工作台填的上限',
    'default-climb': '没有声明上限，沿用从前的"失败再往上翻倍"',
  }[plan.source] || '未知来源';
  return `${scope}单次输出上限 ${plan.start}${plan.climb ? `（${why}，不够会往上试到 ${plan.ceiling}）` : `（${why}，不再往上试）`}`;
}

/**
 * 要一次「必须是合法 JSON」的模型输出，不合法就带问题回灌重出。
 * validate(obj) 返回问题数组，空数组 = 通过。
 */
/**
 * 模型返回了**空正文**时，说清楚到底发生了什么，并给出"下一次换什么打法"。
 *
 * 为什么需要它：以前这种情况只会报 `JSON 解析失败：Unexpected end of JSON input`
 * —— 用户看到的是"解析失败"，而真正的原因是"压根没有正文可解析"，两者要采取的行动
 * 完全不同（前者改提示词，后者改模型参数）。
 *
 * 实测最常见的一种：**推理型模型（名字带 reasoner / thinking，或界面标了「思考」的）
 * 在难题上把整个输出预算花在思考里**，`content` 就是空的、`finish_reason` 是 `length`。
 * 这时候原样重发只会再空一次，必须**把输出上限调大**才有意义。
 */
function explainEmptyText(res, maxTokens, cap) {
  const fr = (res && res.finishReason) || '未知';
  const reasoning = (res && res.reasoning) || '';
  const out = (res && res.usage && res.usage.out) || 0;
  /* 往上翻的**天花板**。以前是写死的 64000；现在它是"这个模型声明的墙"——
     声明过就不再越过它往上试（越过了服务端只会拒掉整次请求，白烧一轮）。 */
  const top = Math.floor(Number(cap) || 0) || 64000;
  const facts = `模型这次返回了**空正文**（finish_reason=${fr}，输出 token=${out}，本次上限=${maxTokens}）`;
  const plan = { maxTokens: 0, dropJsonMode: false };

  if (reasoning.length > 0) {
    plan.maxTokens = Math.min(top, Math.max(maxTokens * 2, maxTokens + 8000));
    return {
      say: `${facts}，但它输出了 ${reasoning.length} 字的**思考内容**。` +
        '这几乎可以确定是「推理把输出预算吃光了」——推理型模型在难任务上会这样。' +
        `下一次把输出上限提到 ${plan.maxTokens} 再试。`,
      short: `空正文，但思考有 ${reasoning.length} 字（推理吃光了输出预算）`,
      maxTokens: plan.maxTokens,
      dropJsonMode: false,
    };
  }
  if (fr === 'length') {
    plan.maxTokens = Math.min(top, Math.max(maxTokens * 2, maxTokens + 8000));
    return {
      say: `${facts}，输出被上限截断了。下一次把上限提到 ${plan.maxTokens} 再试。`,
      short: '空正文，finish_reason=length（被输出上限截断）',
      maxTokens: plan.maxTokens,
      dropJsonMode: false,
    };
  }
  // 既没思考内容也没截断 —— 多半是这个提供商在 JSON 模式下返回了空
  return {
    say: `${facts}，也没有思考内容。多半是这个提供商在 \`response_format: json_object\`（JSON 模式）下返回了空。` +
      '下一次不带这个参数再试。',
    short: `空正文且无思考内容（finish_reason=${fr}）`,
    maxTokens: 0,
    dropJsonMode: true,
  };
}

async function askJson(job, opts) {
  const prompts = require('./prompts');
  const llm = require('../llm');
  const { stage, what, ctx, messages, validate, provider, model, temperature, signal, rounds } = opts;
  // 允许外部**先**给一份问题清单（例如独立审题的结果）：那样第一次调用就已经是"带着意见重出"，
  // 而不是先原样重发一遍把问题再犯一次。
  const seed = Array.isArray(opts.seedProblems) && opts.seedProblems.length ? opts.seedProblems : null;
  const maxRounds = Math.max(
    seed ? 1 : 0,
    rounds == null ? (job.options.repairRounds != null ? job.options.repairRounds : 2) : rounds
  );

  let last = '';
  let problems = seed;
  let lastMeta = null;
  /* 输出上限的**起点**与**天花板**。传了 `tokenPlan`（生成类调用点都会传）就按
     "用户/模型声明好的墙"起步；没传（小调用：规划、来源分析）保持各自的显式默认值，
     免得几个从不会被截断的调用突然发出一个 6 万 token 的请求。
     ⚠️ 天花板这一档**两边都要用**：它不只是起点，也是"往上试"的终点。 */
  const tokenPlan = opts.tokenPlan || null;
  const cap = (tokenPlan && Math.floor(Number(tokenPlan.ceiling)) > 0) ? Math.floor(Number(tokenPlan.ceiling)) : 64000;
  let maxTokens = (tokenPlan && Math.floor(Number(tokenPlan.start)) > 0)
    ? Math.floor(Number(tokenPlan.start))
    : (opts.maxTokens || 16000);
  let wantJson = true;

  for (let attempt = seed ? 1 : 0; attempt <= maxRounds; attempt++) {
    if (isCanceled(job)) throw new CanceledError();
    const repairCtx = opts.repairCtx || ctx;
    const msg = attempt === 0 ? messages : prompts.repairMessages(repairCtx, stage, problems, last, what);
    if (attempt > 0) log(job, 'warn', `「${what}」第 ${attempt + 1} 次尝试（共 ${maxRounds + 1} 次）`);

    let res;
    try {
      res = await llm.chat({
        provider,
        model,
        system: msg.system,
        messages: [{ role: 'user', content: msg.user }],
        temperature: temperature == null ? job.options.temperature : temperature,
        maxTokens,
        json: wantJson,
        signal,
        onDelta: (t) => jobs.emit(job, { type: 'delta', stage, what, text: t }),
      });
    } catch (e) {
      if (e && e.canceled) throw e;
      // 网络/鉴权类错误回灌给模型没有意义，直接冒上去
      if (e && (e.status === 401 || e.status === 403)) throw e;
      problems = ['上一次调用模型失败：' + (e.message || e)];
      last = '';
      if (attempt >= maxRounds) throw e;
      continue;
    }
    // 用量在**这一层**累加：所有模型调用都从 askJson 走，别处再各记一份迟早对不上
    addUsage(job, res.usage);
    last = res.text || '';
    lastMeta = {
      finishReason: res.finishReason,
      reasoningChars: ((res.reasoning) || '').length,
      outTokens: (res.usage && res.usage.out) || 0,
      maxTokens,
    };
    jobs.emit(job, { type: 'delta', stage, what, text: '', done: true });

    /* ★ 空正文：先把原因说清楚，再换一种打法重试。
       这一步不能省——"解析失败"和"压根没正文"要做的事完全不同。 */
    if (!last.trim()) {
      const why = explainEmptyText(res, maxTokens, cap);
      problems = [why.say];
      log(job, 'warn', `「${what}」${why.short}`);
      if (why.maxTokens > maxTokens) {
        maxTokens = why.maxTokens;
        log(job, 'info', `下一次把输出上限提到 ${maxTokens}`);
      }
      if (why.dropJsonMode && wantJson) {
        wantJson = false;
        log(job, 'info', '下一次不带 response_format 再试（有些提供商在 JSON 模式下会返回空）');
      }
      continue;
    }

    let obj;
    try {
      obj = llm.parseJsonLoose(last);
    } catch (e) {
      problems = [
        'JSON 解析失败：' + e.message,
        '常见原因：尾逗号、注释、单引号、输出被截断、或把 JSON 包在了 Markdown 围栏外的解释文字里。请只输出一个 JSON 对象。',
      ];
      log(job, 'warn', `「${what}」的 JSON 没解析出来：${e.message}`);
      // 输出被截断也会让 JSON 合不上括号：这时同样要把上限调大，否则下一次还是截断
      if (lastMeta && lastMeta.finishReason === 'length' && maxTokens < cap) {
        maxTokens = Math.min(cap, maxTokens * 2);
        log(job, 'info', `上一次的输出被上限截断了，下一次提到 ${maxTokens}`);
      }
      continue;
    }
    problems = validate(obj) || [];
    /* 校验器可能顺手把"能自动修正"的地方改好了（validateProse 会把裸 <table> 包一层、
       把 blocks 数改对）——改了什么要说出来，别静默改用户的东西。 */
    for (const f of (problems.fixed || [])) log(job, 'info', `「${what}」已自动修正：${f}`);
    if (!problems.length) return obj;

    /* ★ 最后一次尝试：只把 STRUCTURAL 类的问题交给"判失败"那一层；
       CLEANABLE / TOLERABLE 的降级成警告，让任务继续走完（讲解照常进页面，拼装时会清掉）。
       理由见文件上部 KIND 那一段：我们明明有能力安全处理它们，却拿它们在内容校验这一层
       把整段讲解回炉，会把重试机会耗光——真正该重试的"输出被截断"反而没机会重试。
       ⚠️ 前面几次**照旧按不合格回炉**：这条质量压力必须保住，不能一上来就降级。 */
    if (attempt >= maxRounds && opts.softenLastRound) {
      const soft = [];
      const hard = [];
      problems.forEach((m, i) => (problemKind(problems, i) === KIND.STRUCTURAL ? hard : soft).push(m));
      if (soft.length) {
        (job.proseDowngrades = job.proseDowngrades || []).push({ what, problems: soft.slice() });
        log(job, 'warn', `「${what}」有 ${soft.length} 处问题属于「拼装时会自动清理、或不影响页面能用」的类型，`
          + `不再为它重试，已照常交付（正文其余内容都在）：${soft.slice(0, 3).join('；')}${soft.length > 3 ? ' …' : ''}`);
      }
      if (!hard.length) return obj;
      problems = hard;   // 只剩结构性 → 下面照常判失败（也只把这几条交上去）
    }
    log(job, 'warn', `「${what}」有 ${problems.length} 处不合格：${problems.slice(0, 4).join('；')}${problems.length > 4 ? ' …' : ''}`);
  }
  const err = new Error(`「${what}」连续 ${maxRounds + 1} 次都没能产出合格结果。最后的问题：${(problems || []).join('；')}`);
  err.stage = stage;
  err.problems = problems;
  err.raw = last.slice(0, 4000);
  err.meta = lastMeta;
  throw err;
}

/* ---------------- 各阶段的校验器 ---------------- */

/** 正则元字符转义（演示 id 会被拼进 RegExp）。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 引擎与骨架页自己占用的元素 id。
 *
 * 模型给单元起 `sectionId` 时如果撞上这些，`getElementById` 会先拿到模型那个 `<section>`
 * ——引擎随后把它的 textContent 写成 "0 / 2"，**整节标题与讲解正文被一串数字抹掉**，
 * 而真正的结算面板永远停在初始值。页面不报错，只能靠肉眼发现。所以撞了就回灌重写。
 */
const RESERVED_IDS = new Set([
  's-done', 's-total', 's-rate', 's-wrong', 's-fill', 's-nosave',
  'onlyWrong', 'resetAll', 'petToggle',
  'r-done', 'r-rate', 'r-wrong', 'r-verdict', 'r-bars', 'r-advice', 'r-advicetext',
  'goWrong', 'goAll', 'wrongEmpty', 'result', 'howto', 'engine', 'pet', 'petBubble', 'petFig', 'bgimg',
]);

function validateOutline(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!o.chapter || typeof o.chapter !== 'object') p.push('缺 chapter 对象');
  else {
    if (!o.chapter.title) p.push('chapter.title 没写');
    if (!o.chapter.subject) p.push('chapter.subject 没写');
  }
  if (!Array.isArray(o.units) || !o.units.length) p.push('units 不是非空数组');
  else {
    const seen = { uid: new Set(), sectionId: new Set(), qsecId: new Set(), lv: new Set() };
    o.units.forEach((u, i) => {
      const at = `units[${i}]`;
      // ⚠️ 先判它是不是对象：模型给出 [null] / ["u1"] 时，下面每一句 `u.uid` 都会抛
      // TypeError 冒到界面上（用户看到 "Cannot read properties of null"），
      // 而且**一轮修复都不会触发**——校验器自己崩了，回灌自然无从谈起。
      if (!u || typeof u !== 'object' || Array.isArray(u)) {
        p.push(`${at} 不是一个对象（数组里每项都得是 {\"uid\":…} 这样的对象）`);
        return;
      }
      if (!u.uid) p.push(`${at} 缺 uid`);
      else if (seen.uid.has(u.uid)) p.push(`${at}.uid 与前面重复（${u.uid}）`);
      else seen.uid.add(u.uid);

      if (!u.title) p.push(`${at} 缺 title（讲解块标题）`);
      if (!u.qsecTitle) p.push(`${at} 缺 qsecTitle（题区标题，要以「练一练」开头）`);
      else if (!/^练一练/.test(u.qsecTitle)) p.push(`${at}.qsecTitle 必须以「练一练」开头，现在是「${u.qsecTitle}」`);
      // 结算条的关卡名是从题区 h2 推出来的，标题里混进计数或斜杠会被正则剥花
      else if (/已答|\d\s*\/\s*\d/.test(u.qsecTitle)) p.push(`${at}.qsecTitle 里不要写「已答」或 "x/y" 这类计数（结算条会自己算）`);

      if (!u.sectionId) p.push(`${at} 缺 sectionId`);
      else if (RESERVED_IDS.has(u.sectionId)) {
        // 撞上引擎自己的元素 id：引擎会把该 <section> 的 textContent 设成 "0 / 2"，
        // **整节标题与讲解正文被一串数字抹掉**，而真正的结算面板永远停在初始值，页面无报错
        p.push(`${at}.sectionId 用了引擎保留 id「${u.sectionId}」，换一个（如 s131）`);
      } else if (seen.sectionId.has(u.sectionId)) p.push(`${at}.sectionId 与前面重复（${u.sectionId}）`);
      else seen.sectionId.add(u.sectionId);

      if (u.qsecId != null && u.qsecId !== 'p-l' + u.lv) p.push(`${at}.qsecId 必须等于 "p-l"+lv（现在 lv=${u.lv}，qsecId=${u.qsecId}）`);
      if (!(u.targetCount > 0)) p.push(`${at}.targetCount 要不是正数`);
      if (u.lv != null && seen.lv.has(u.lv)) p.push(`${at}.lv 与前面重复（${u.lv}）`);
      else if (u.lv != null) seen.lv.add(u.lv);
    });
  }
  if (!o.bigUnit || typeof o.bigUnit !== 'object') p.push('缺 bigUnit（综合大题单元）');
  else {
    if (!o.bigUnit.title) p.push('bigUnit.title 没写');
    if (!(o.bigUnit.targetCount > 0)) p.push('bigUnit.targetCount 要不是正数');
    if (o.bigUnit.sectionId && RESERVED_IDS.has(o.bigUnit.sectionId)) {
      p.push(`bigUnit.sectionId 用了引擎保留 id「${o.bigUnit.sectionId}」，换一个（如 sbig）`);
    }
    if (o.bigUnit.sectionId && Array.isArray(o.units)) {
      const clash = o.units.some((u) => u && u.sectionId === o.bigUnit.sectionId);
      if (clash) p.push(`bigUnit.sectionId 与某个单元重复（${o.bigUnit.sectionId}）`);
    }
  }
  // 演示必须挂在真实存在的单元上，否则它的占位注释永远没人填
  if (Array.isArray(o.demos) && Array.isArray(o.units)) {
    const uids = new Set(o.units.filter((u) => u && u.uid).map((u) => u.uid));
    const seenDemoIds = new Set();
    o.demos.forEach((d, i) => {
      if (!d || typeof d !== 'object') {
        p.push(`demos[${i}] 不是一个对象`);
        return;
      }
      /* 演示 id 必须校验：它会被拼进 `new RegExp('<!--DEMO:' + id + '-->')`。
         模型给出含正则元字符的 id（`a(b`、`a[b`）时，**校验器自己**抛 SyntaxError，
         从 askJson 冒到整单 failed —— 已经烧掉的讲解/题库调用全部作废、一个文件都不产出，
         而用户看到的只有一句 `Invalid regular expression: … Unterminated group`。
         契约 §1.2 明写 id 要满足 ^demo[A-Z]$，之前只查了 unitUid。 */
      if (!d.id) {
        p.push(`demos[${i}] 没有 id（必须形如 demoA / demoB，宿主靠它把演示放回正文）`);
        return;
      }
      if (!/^demo[A-Z]$/.test(d.id)) {
        p.push(`demos[${i}].id「${d.id}」不合规：必须形如 demoA / demoB（只允许 demo + 一个大写字母）`);
        return;
      }
      if (seenDemoIds.has(d.id)) {
        p.push(`demos[${i}].id 与前面重复（${d.id}）——两个演示会抢同一个 DOM id，请改成 demoB / demoC`);
        return;
      }
      seenDemoIds.add(d.id);
      if (d.unitUid && !uids.has(d.unitUid)) {
        p.push(`demos[${i}].unitUid「${d.unitUid}」不在 units 里（可选：${[...uids].join('、')}）`);
      }
    });
  }
  if (Array.isArray(o.units) && o.bigUnit && typeof o.bigUnit.targetCount === 'number') {
    const sum = o.units.reduce((n, u) => n + (Number(u && u.targetCount) || 0), 0) + o.bigUnit.targetCount;
    if (o.answerPoints != null && Number(o.answerPoints) !== sum) {
      // 这一条是契约 §1.2 的不变量 1。不致命——执行层以 targetCount 为准——
      // 但差别大说明模型没在认真配额度，值得让它重来一次
      p.push(`answerPoints(${o.answerPoints}) 与 ΣtargetCount(${sum}) 不等，请改成一致`);
    }
  }
  return p;
}

/* ================= 讲解校验：哪些问题该回炉，哪些可以降级交付 =================
 *
 * 这一段是为一个**用户实跑报上来的故障**加的：
 *   某个单元的讲解连续 3 次没过校验，整个任务被打死、一个文件都没产出。
 *   而三次里前两次的问题（内联事件、裸 <table>）**拼装时本来就会被安全处理掉**
 *   （见 assemble.js 的 sanitizeModelHtml）—— 我们明明有能力处理，却先拿它们在内容校验
 *   这一层把整段讲解回炉，把三次机会耗光，真正该重试的"输出被截断"反而没机会重试。
 *
 * 所以每条规则都带一个类别：
 *   · CLEANABLE  拼装时 sanitizeModelHtml 会安全处理掉（整类删掉，或把值改成 #），
 *                交付出去的页面里不会剩下它 —— 最后一次尝试不再为它重试
 *   · TOLERABLE  清洗器**有意保留**（演示的滑块/预设按钮就是 <input>/<button>），
 *                但也执行不了任何东西；或者拼装器有兜底并会记一条警告 —— 也不再为它重试
 *   · STRUCTURAL 拼装器兜不住：交付出去就是坏页面（整页被吞、内容静默消失、引擎静默失效）
 *                —— 无论第几次尝试都判失败
 *
 * ⚠️ 判据是 sanitizeModelHtml **实际会做什么**（assemble.js 里 drop(...) 的清单 + scrubTagAttrs
 *    的两条 sub），每条 cleanable 规则旁边都注明了对应它的哪一句 —— 别凭印象挪类别。
 * ⚠️ 别为了"少报一点"把 STRUCTURAL 往 CLEANABLE 上挪：`<style>` 没配平、注释没配平、
 *    用了引擎保留 id 这几类，交付出去是真会坏页面的。
 * ⚠️ sanitizeModelHtml 本身一个字都别动（它被 20+ 套测试压着，见 test/hostile-input.js）。
 */
const KIND = { CLEANABLE: 'cleanable', TOLERABLE: 'tolerable', STRUCTURAL: 'structural' };

/** 问题 m 属于哪一类。没标类别的校验器一律算 structural（它们的失败都是真失败，行为与从前一致）。 */
function problemKind(problems, i) {
  const k = problems && problems.kinds;
  return (Array.isArray(k) && k[i]) || KIND.STRUCTURAL;
}

/**
 * 给"问题数组"挂上两样元信息：每条属于哪一类、以及校验器顺手自动改了什么。
 *
 * 用**不可枚举**属性挂：`join('；')`、`JSON.stringify`、`.slice()`、遍历都看不见它，
 * 所以日志、修复提示词、以及 test/_audit 里的脚本拿到的仍是一个普通的字符串数组。
 */
function withKinds(problems, kinds, fixed) {
  Object.defineProperty(problems, 'kinds', { value: kinds.slice(), enumerable: false });
  if (fixed && fixed.length) Object.defineProperty(problems, 'fixed', { value: fixed.slice(), enumerable: false });
  return problems;
}

/** `<style>` 这类标签：清洗器只删得掉**成对**的，开闭数量一致才敢说"拼装时会被清掉"。 */
function pairBalanced(html, open, close) {
  return (html.match(open) || []).length === (html.match(close) || []).length;
}

/**
 * 讲解正文的规则表：`[正则, 说法, 类别]`。类别可以是字符串，也可以是 `(html) => 类别`。
 * 每一条都对应"页面会静默出问题"的具体后果，不是洁癖。契约 §2.2 明说这些校验器要一并实现。
 */
const PROSE_RULES = [
  /* —— 清洗器**整类删掉**的（sanitizeModelHtml 里的 drop 列表）—— */
  [/<script\b/i, 'html 里出现了 <script>（会让外层解析器提前关闭脚本，整页 JS 失效）', KIND.CLEANABLE],   // drop(/<script\b[^>]*\/?>/) + 成对那一句
  [/<\/script/i, 'html 里出现了 </script>（同上）', KIND.CLEANABLE],                                   // drop(/<\/script\s*>/)
  [/<iframe\b/i, 'html 里出现了 <iframe>（本页不许嵌任何外部内容）', KIND.CLEANABLE],                  // drop(<iframe> 成对/单个)
  [/<base\b/i, 'html 里出现了 <base>（会改掉同目录图片的相对路径，陪练/背景就找不到了）', KIND.CLEANABLE], // drop(/<base\b[^>]*\/?>/)
  [/<link\b/i, 'html 里出现了 <link>（本页零外部资源，不引任何样式表）', KIND.CLEANABLE],               // drop(/<link\b[^>]*\/?>/)
  [/<meta\b/i, 'html 里出现了 <meta>（宿主已在 head 里写好，别再插）', KIND.CLEANABLE],                 // drop(/<meta\b[^>]*\/?>/)
  [/<form\b/i, 'html 里出现了 <form>（页面自己有按钮，别自己造）', KIND.CLEANABLE],                     // drop(<form> 成对/单个)
  /* —— 清洗器**改值/剥属性**的（scrubTagAttrs）—— */
  [/on[a-z]+\s*=/i, '标签上出现了内联事件（如 onclick=）——做题页不执行讲解里的脚本', KIND.CLEANABLE],     // sub(/([\s/"'])on[a-z]+\s*=/)
  [/\bsrc\s*=\s*["']?(?:https?:)?\/\//i, '出现了外链资源（本页必须零外部请求，离线也要能看）', KIND.CLEANABLE], // 外链那条 sub → 改成 "#"
  [/\bhref\s*=\s*["']https?:/i, '出现了外链链接（讲解里的链接一律用同页锚点 #xxx）', KIND.CLEANABLE],     // 同上
  /* —— 清洗器**有意保留**的控件（sanitizeModelHtml 那段注释：演示的滑块就是 <input type=range>、
        预设按钮就是 <button>，删了整个演示就没了）。它们执行不了任何东西（on*= 已被剥、
        外链已被改成 #），交付出去只是页面上多一个没用的控件，不该为它把整段讲解回炉。 —— */
  [/<input\b|<button\b/i, 'html 里出现了表单控件（页面自己有按钮，别自己造）', KIND.TOLERABLE],
  [/<canvas\b|<video\b|<audio\b/i, 'html 里出现了 canvas/video/audio（本页不用这些）', KIND.TOLERABLE],
  /* —— 清洗器兜不住的真失败 —— */
  [/<h1\b/i, 'html 里出现了 <h1>（页面已经有 h1 了）', KIND.STRUCTURAL],
  [/<section\b/i, 'html 里出现了 <section>（外壳由宿主加，你只写内部片段）', KIND.STRUCTURAL],
  [/<h2\b/i, 'html 里出现了 <h2>（小节标题由宿主加）', KIND.STRUCTURAL],
  /* <style> 单独说：清洗器只删**成对**的 <style>…</style>；配不平的那一个（例如只写了 <style>
     没闭合）会原样漏进页面，把**后面整页**吞成 CSS 文本 —— 而拼装器的自检拦不住它
     （那里数的是 <!-- 与 <script> 的配平）。所以按配平情况分：配平 = 拼装时会被清掉。 */
  [/<style\b/i, 'html 里出现了 <style>（样式由宿主提供）',
    (html) => (pairBalanced(html, /<style\b/gi, /<\/style\s*>/gi) ? KIND.CLEANABLE : KIND.STRUCTURAL)],
  [/class\s*=\s*["'][^"']*\bbox\b/i, '用了 class="box"——那个类默认 display:none，整段内容会凭空消失', KIND.STRUCTURAL],
  [/\$\$?[^$]+\$\$?/, 'html 里出现了 LaTeX 的 $…$ 公式（本页不引 MathJax，学生看到的是原始符号）', KIND.STRUCTURAL],
  [/\\frac|\\text\{|\\\(|\\\[/, 'html 里出现了 LaTeX 命令（本页不引 MathJax，学生看到的是原始符号）', KIND.STRUCTURAL],
  // 注意：<sub>/<sup> 在**讲解正文**里是允许的（契约 §3 的公式就写作 μ₀μ<sub>r</sub>H），
  // 只有 SVG 的 <text> 里不能用。那条由演示自己的 checks 与演示探针去管，不在这里一刀切。
];

/**
 * 数一数正文里有多少个**没被包起来**的 `<table>`。
 *
 * 两种写法都算"包好了"（判据与 autoFixProse 完全一致，否则自动包完还会被自己报一嗓子）：
 *   · `<div class="tablewrap"><table>` —— 契约 §3 表格那一行的写法（我们自动包出来的就是这个）
 *   · `<table class="tablewrap">`      —— 旧写法，兼容着
 * ⚠️ 原来的正则只认后一种，于是**契约要求的写法反而被判成不合格**：模型按契约写了
 *    `<div class="tablewrap"><table>`，校验器还照报"裸的 <table>"，回炉重出还是那样，白烧三轮。
 */
function bareTableCount(html) {
  let n = 0;
  for (const m of html.matchAll(/<table\b[^>]*>/gi)) {
    if (/\btablewrap\b/i.test(m[0])) continue;                                  // 自己带了 tablewrap
    if (/<div class="tablewrap">\s*$/i.test(html.slice(0, m.index))) continue;  // 上一句就是包它的 div
    n++;
  }
  return n;
}

/**
 * 顺手能改好的，直接改好 —— **比报警告好**（用户明确要的）。
 * 只做**内容无损**的改动：改坏了自己看不出来，那比回炉重出更糟。
 * @param {object} o prose 对象（就地改 o.html / o.blocks）
 * @param {string[]} fixed 收"改了什么"（人话，会进日志与报告）
 */
function autoFixProse(o, fixed) {
  /* ① 裸 <table> 包一层 <div class="tablewrap">。
     窄屏横向撑破版式就是这个引起的，而它**不值得回炉**：包一层纯属好事。 */
  if (/<table\b/i.test(o.html)) {
    const before = o.html;
    o.html = o.html.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (m, offset, whole) => {
      const head = m.slice(0, m.indexOf('>') + 1);
      if (/\btablewrap\b/i.test(head)) return m;                      // 自己带了 tablewrap，不动它
      if (/<div class="tablewrap">\s*$/i.test(whole.slice(0, offset))) return m;  // 已经包过一层了
      /* 里面还套着表格：非贪婪配对配到的不是真正的那一对，包下去会把 <div> 插进表格结构内部
         （浏览器会把它从表里挪出去，版式反而更乱）—— 这种不碰，留给上面的规则报一嗓子。 */
      if (/<table\b/i.test(m.slice(head.length))) return m;
      return '<div class="tablewrap">' + m + '</div>';
    });
    if (o.html !== before) fixed.push('把裸的 <table> 包进了 <div class="tablewrap">（窄屏就不会撑破版式了）');
  }

  /* ② blocks 字段与 <h3> 个数不符 → 直接改成实测值。
     这个字段**只有本校验器在读**（页面、拼装、落盘、合并都不看它），为它对不上回炉不值当。 */
  const h3 = (o.html.match(/<h3\b/gi) || []).length;
  if (o.blocks != null && Number(o.blocks) !== h3) {
    fixed.push(`把 blocks 字段从 ${o.blocks} 改成了 ${h3}（html 里就是 ${h3} 个 <h3>）`);
    o.blocks = h3;
  }
}

function validateProse(o, unit) {
  if (!o || typeof o !== 'object') return withKinds(['返回的不是一个对象'], [KIND.STRUCTURAL]);
  const p = [];
  const kinds = [];
  const fixed = [];
  const put = (msg, kind) => { p.push(msg); kinds.push(kind || KIND.STRUCTURAL); };
  if (typeof o.html !== 'string' || o.html.length < 80) put('html 太短或不是字符串');
  else {
    // 能自动修正的先改掉（改完再按规则看剩下的），别为"我们自己顺手能改好"的事回炉
    autoFixProse(o, fixed);
    const html = o.html;
    for (const [re, msg, kind] of PROSE_RULES) {
      if (re.test(html)) put(msg, typeof kind === 'function' ? kind(html) : kind);
    }

    // 注释必须配平：一个孤立的 <!-- 会把它之后**整个页面**（题库、引擎全在内）吞成注释，
    // 而浏览器完全不给信号——页面只剩页眉，控制台干干净净。
    // 结构性：清洗器不碰注释，拼装器的自检也会因它抛错 —— 兜不住，交付不了。
    const cmtOpen = (o.html.match(/<!--/g) || []).length;
    const cmtClose = (o.html.match(/-->/g) || []).length;
    if (cmtOpen !== cmtClose) {
      put(`HTML 注释没配平（<!-- ${cmtOpen} 个、--> ${cmtClose} 个）——除了演示占位注释，正文里不要写注释`);
    }

    /* 正文里写出引擎自己的 id → 文档序在前的那个（模型这个）会被 getElementById 拿到，
       引擎随后把它的 textContent 写成 "0 / 2"，**真正的结算面板永远停在初始值**，
       而页面与控制台都不报错。RESERVED_IDS 这套检查原本只用在 outline 的 sectionId 上。 */
    /* ⚠️ 属性写法要认全：`id=r-rate`（无引号）、`ID="r-rate"`（大写）在 HTML 里同样生效。
       旧正则写死了 `\sid\s*=\s*["']…["']`（必须小写 + 必须带引号），于是这两种写法直接放行，
       页面里同一个 id 出现两次、模型那份文档序在前 → getElementById 拿到它 →
       引擎把统计写进去的是那个假节点，**真正的结算区永远停在初始值，页面与控制台都不报错**。 */
    const reservedHit = [];
    for (const m of o.html.matchAll(/[\s/"']id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const idv = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      if (RESERVED_IDS.has(idv)) reservedHit.push(idv);
    }
    if (reservedHit.length) {
      // 结构性：清洗器不认 id，交付出去就是引擎静默写错地方（页面与控制台都不报错）
      put(`html 里用了引擎保留的 id（${[...new Set(reservedHit)].join('、')}）——它们会和结算区/顶栏重名，` +
        '导致那部分静默失效。请换一个 id（比如加上本节前缀 k131-）。');
    }

    /* 裸 <table>：正常情况 autoFixProse 已经自动包好了；这里兜的是它包不了的（没闭合的、
       里外套着的）。窄屏横向撑破版式是**观感**问题，不是坏页面 —— 别为它把整段讲解回炉。 */
    const bareTables = bareTableCount(html);
    if (bareTables) {
      put(`html 里有 ${bareTables} 个裸的 <table> 没包 <div class="tablewrap">（窄屏会撑破版式）`, KIND.TOLERABLE);
    }

    const h3 = (o.html.match(/<h3\b/gi) || []).length;
    // 块数为 0 = 结构不成形（契约 §2：每个知识块必须是一个 <h3>）→ 结构性
    if (!h3) put('html 里一个 <h3> 都没有（每个知识块必须是一个 <h3>）');
    // blocks 字段在 autoFixProse 里已经改对了；万一没改（html 不是字符串那种情况）这里也不兜——
    // 它只有本校验器在读，对不上不该让整段讲解回炉

    /* ⚠️ 演示占位这一段**必须在"html 是字符串"这个分支里面**：
       放在外面时，模型返回 `{error:…}`（或 html 写成 null / 数字）会让 `o.html.match`
       抛 TypeError —— **校验器自己崩了**，回灌自然无从谈起，用户看到的是一句
       "Cannot read properties of undefined (reading 'match')" 加一句"任务失败"，
       而且单元挂没挂演示决定了它犯不犯（有演示的单元必犯）。这是本轮测试真跑出来的。 */
    if (unit && Array.isArray(unit.demoIds)) {
      for (const id of unit.demoIds) {
        const n = (o.html.match(new RegExp(`<!--DEMO:${escapeRegExp(id)}-->`, 'g')) || []).length;
        /* 演示占位：拼装器**有兜底**（占位没出现在正文里时，它会挂到该演示所属单元的题区之前，
           并记一条警告；多出来的占位会原样留在页面上，也记一条警告）。页面不会坏，
           所以归 tolerable —— 最后一次尝试不再为它回炉。 */
        if (n !== 1) put(`演示占位 <!--DEMO:${id}--> 应该恰好出现 1 次，现在出现 ${n} 次`, KIND.TOLERABLE);
      }
    }
  }
  return withKinds(p, kinds, fixed);
}

function validateBankShape(o, unit) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!Array.isArray(o.items) || !o.items.length) return ['items 不是非空数组'];

  /* ⚠️ **自创题型必须在数条数之前拦下来**。
     `normalizeBank` 遇到不认识的 `type` 是**静默降级成 single**（见 bank.js 的 normalizePart），
     所以它拦不住模型自创的 `judge`（判断）/ `fill`（填空）/ `short`（简答）——
     那会变成一道**语义错位的单选题**（题干写着"判断对错"、选项却还是原来的四个），
     **而页面、控制台都不会报任何错**，用户只会觉得"这题怪怪的"。
     真题那一步最容易撞上：卷面写着"判断题"，模型就顺手写了个 `type:"judge"`。
     只对"写了但写错"的 type 硬判；"压根没写 type"保持原有的宽容降级，别动它。 */
  const badTypes = [];
  o.items.forEach((it, i) => {
    if (it && typeof it === 'object' && it.type !== undefined && !KNOWN_TYPES.has(it.type)) {
      badTypes.push(`items[${i}].type 是「${it.type}」，不是四种题型之一`
        + '（single 单选 / multi 多选 / num 填数值 / big 综合大题）。'
        + '判断题请写成两个选项（「正确」「错误」）的 single，填空题用 num，简答与计算用 big。');
    }
    if (it && it.type === 'big' && Array.isArray(it.parts)) {
      it.parts.forEach((pt, j) => {
        if (pt && typeof pt === 'object' && pt.type !== undefined && !PART_TYPES.has(pt.type)) {
          badTypes.push(`items[${i}].parts[${j}].type 是「${pt.type}」，大题的小题只能是 single / multi / num。`);
        }
      });
    }
  });
  if (badTypes.length) return badTypes;   // 先让它把题型改对，别的（条数、选项）这轮先不数

  if (unit) {
    // 数量对不上就重来——契约要求 targetCount 精确等于作答点总数
    let n = 0;
    for (const it of o.items) n += it && it.type === 'big' && Array.isArray(it.parts) ? it.parts.length : 1;
    const want = Number(unit.targetCount);
    if (want && n !== want) p.push(`items 里的作答点共 ${n} 个，但 outline 里这一节写的是 ${want} 个，请改成 ${want} 个`);
  }
  // **内容级校验也要在这里做**，不能只数条数。
  // 以前只有 assemble 才跑 normalizeBank，那时所有单元的正文都生成完了——
  // 一处"单选标了两个 ok:true"会让整单直接 failed，**没有任何一轮修复**，
  // 已花的费用与已生成的讲解全部作废，输出目录里连 HTML 都没有。
  // 现在把问题当回灌文本交给 askJson，模型能当场改。
  try {
    const res = normalizeBank(o.items, { lv: unit ? unit.lv || 0 : 0, namespace: 'check' });
    for (const it of res.issues) p.push(it.message);
  } catch (e) {
    p.push('题库规范化时出错：' + e.message);
  }
  return p;
}

/* ---------------- 分章 ---------------- */

/**
 * 这一次要生成哪几章。
 *
 * ⚠️ **永远在流水线里重新分组，不用 `job.chapters` 里那些来源对象。**
 * `gen:start` 分组用的是它自己 `normalizeSources(input)` 出来的那一份，而 `job.sources` 是
 * `createJob` 里**另一次**归一的产物 —— 两个数组里的对象不是同一个引用。
 * 拿前者去跑，抽取时会往 A 上写 `pages`、而规划读的是 B 上的 `pages`（undefined）：
 * 症状是"章是分对了，但每一章的材料都是空的"，而页面会照常生成出一份没有内容的册子。
 * 来源对象是**流水线这一路自己长出来的**（抽取、分析都往上挂东西），所以只能用它自己那一份。
 */
function resolveChapters(job) {
  const ch = require('./chapters');
  const g = ch.groupSources(job.sources || [], job.options || {});
  if (!g.ok) throw new Error(g.message);
  return g.chapters;
}

/**
 * 跨章关联：**只算，然后按需要问一句**（第 6 条）。
 *
 * 判据全部来自已经拿到的逐来源分析结论（S0），所以这里**不多烧一次模型调用**。
 * 只在"合成一册 + 至少两章"时才可能问；`separate`（本来就要各出各的）与单章一个字都不问。
 *
 * 问出口的门槛（`AFFINITY_ASK`）比"值得在日志里提一句"的门槛（`AFFINITY_NOTE`）高不少：
 * 每多问一次就多打断用户一次，而"两章有点关系"是常态，不值得为它停下来。
 *
 * @returns {Promise<'linked'|'simple'>}
 */
async function decideCrossChapter(job, chapters) {
  const ch = require('./chapters');
  if ((job.mode || 'book') === 'separate') return 'simple';
  if (chapters.length < 2) return 'simple';

  const notesOf = (c) => (c.sources || []).map((s) => s.note).filter(Boolean);
  const pairs = [];
  for (let i = 1; i < chapters.length; i++) {
    let best = 0;
    for (const x of notesOf(chapters[i - 1])) {
      for (const y of notesOf(chapters[i])) best = Math.max(best, ch.chapterAffinity(x, y));
    }
    if (best >= ch.AFFINITY_NOTE) {
      pairs.push({ i, score: best, prev: chapters[i - 1], next: chapters[i] });
    }
  }
  const name = (c, k) => (c.title ? `第 ${c.no || k + 1} 章「${c.title}」` : `第 ${c.no || k + 1} 章`);
  for (const p of pairs) {
    log(job, 'info', `${name(p.prev, p.i - 1)} 与 ${name(p.next, p.i)} 的内容有重合（关联度 ${p.score.toFixed(2)}）`);
  }
  const strong = pairs.filter((p) => p.score >= ch.AFFINITY_ASK).sort((a, b) => b.score - a.score);
  if (!strong.length) return 'simple';

  const p = strong[0];
  log(job, 'info', `${name(p.prev, p.i - 1)} 与 ${name(p.next, p.i)} 关联很大（${p.score.toFixed(2)}）——问一下要不要让它们互相照应`);
  const answer = await jobs.ask(job, {
    id: 'cross-chapter',
    title: '这两章关联很大，要不要让它们互相照应？',
    /* ⚠️ 这里（以及所有会进界面的文案）**不许用 Markdown 强调标记**：
       `ask.message` 是当纯文本渲染的，`**怎么生成**` 会连着星号一起显示给用户。 */
    message: `${name(p.prev, p.i - 1)} 和 ${name(p.next, p.i)} 讲的东西重合得不少。`
      + '下面的选择只影响「怎么生成」，不影响章的划分。',
    options: [
      {
        value: 'simple',
        label: '简单缝合（各自生成，直接拼在一起）',
        detail: '每章独立生成，互不引用。最省事，也最不容易出岔子；代价是同一件事可能在两章里各讲一遍。',
      },
      {
        value: 'linked',
        label: '关联生成（后面的章能看到前面几章讲了什么）',
        detail: '生成第 N 章时把前面几章的摘要放进提示词：它会主动呼应前面讲过的概念、不重复讲，'
          + '也会在需要时点明"上一章那个工具在这里怎么用"。多出来的代价只有提示词变长一点。',
      },
    ],
    default: 'simple',
  });
  return answer === 'linked' ? 'linked' : 'simple';
}

/* ---------------- 主流程 ---------------- */

async function runGeneration(job) {
  const ac = new AbortController();
  job._abort = ac;
  const signal = ac.signal;
  const t0 = Date.now();
  job.status = 'running';
  jobs.emit(job, { type: 'started', at: t0 });

  try {
    const settings = store.getSettings();
    const providerId = settings.active.provider;
    const model = settings.active.model;
    if (!providerId || !model) throw new Error('还没选模型：请到「设置」里启用一个提供商并选定模型');
    const provider = store.providerConfig(providerId);
    job.model = { provider: provider.name, model };
    log(job, 'info', `使用模型：${provider.name} / ${model}`);

    /* 「分阶段用不同模型」：只影响两个**便宜模型够用**的调用点（逐来源分析、独立审题），
       其余全部走主模型。没配就是空串 ⇒ `modelForStage` 回落主模型 ⇒ 与从前一模一样。 */
    const modelOf = (stage) => modelForStage(settings, stage);
    const stageModel = { analyze: modelOf('analyze'), audit: modelOf('audit') };
    for (const [k, v] of Object.entries(stageModel)) {
      if (v && v !== model) log(job, 'info', `分阶段模型：${{ analyze: '逐来源分析', audit: '独立审题' }[k]}用「${v}」`);
    }

    /* 单次输出上限**先说好墙在哪**（见 `resolveTokenPlan` 的注释）。每个调用点按它**自己那个模型**
       的声明取值 —— 分阶段模型不同，声明也就不同。 */
    const planFor = (m) => resolveTokenPlan(modelCfgOf(provider, m), job.options);
    const mainPlan = planFor(model);
    log(job, 'info', tokenPlanText(mainPlan, ''));
    if (stageModel.analyze && stageModel.analyze !== model) {
      log(job, 'info', tokenPlanText(planFor(stageModel.analyze), '逐来源分析：'));
    }
    /* ⚠️ `default-climb`（没声明、也没手填）时把 plan 传成 `null`，让各调用点用**它自己原来的**
       那个数值 —— 这样"老配置"发出的请求与 1.3.0 **逐字节一致**，不会因为这一版突然变了性子。
       一旦有声明或手填，plan 才接管（那正是"先说好墙在哪"要生效的情形）。 */
    const asPlanArg = (p) => (p.source === 'default-climb' ? null : p);
    const mainTokenPlan = asPlanArg(mainPlan);

    /* ---- 1. 抽取（每份来源各抽一次） ---- */
    progress(job, 'extract', 'running');
    const tEx = Date.now();
    const prompts = require('./prompts');
    const { labelOf, pagesOf, ROLE_WEIGHTS } = prompts;
    const { scopePages, validateSourceNote, trimNote } = require('./sources');
    const sources = job.sources || [];
    const label = (s) => labelOf(s);
    const textOf = (s) => pagesOf(s).filter((p) => p.text && p.text.trim());

    /* 用户手工修订按 **`${来源 id}:${页号}`** 回填。
       ⚠️ 这个键以前是**裸页号**。多来源下页号必然重复，于是"改了课本第 3 页"会变成
       "改了课件第 3 页"——不报错、不崩溃，内容悄悄错位，是最难发现的一类失效。
       没有 sourceId 的旧格式（老渲染进程 / 第三方脚本）归给主来源，保证修订不被丢掉。 */
    const editedByKey = new Map(
      (job.options.editedPages || []).map((e) => [`${e.sourceId || sources[0].id}:${e.index}`, e.text])
    );
    let usedEdits = 0;

    await mapLimit(sources, job.options.concurrency || 3, async (src) => {
      const ex = await getExtract()(src.filePath);
      src.kind = ex.kind;
      src.meta = ex.meta;
      src.diagnosis = ex.diagnosis;
      src.warnings = ex.warnings || [];
      src.pages = ex.pages;
      if (editedByKey.size) {
        src.pages = src.pages.map((p) => {
          const t = editedByKey.get(`${src.id}:${p.index}`);
          if (t === undefined) return p;
          usedEdits++;
          return Object.assign({}, p, { text: t, edited: true });
        });
      }
      src.scopedPages = scopePages(src.pages, src.scope);   // 课本只取用户指定的那一节
    });
    if (usedEdits) log(job, 'info', `采用了用户手工修订的 ${usedEdits} 页文本`);

    for (const src of sources) {
      if (src.diagnosis && src.diagnosis.likely) {
        log(job, 'warn', `「${label(src)}」看起来是扫描件或整页图片（${src.diagnosis.reason}）——本工具不做 OCR，这份材料多半抽不到文字`);
      }
      for (const w of src.warnings) log(job, w.level === 'warn' ? 'warn' : 'info', `[${label(src)}] ${w.message}`);
    }

    /* ⚠️ 硬失败**只针对主来源**。
       一份来源时语义与从前完全一致（主来源就是唯一来源）。
       多来源时，一份扫描件真题既不该把整单拖下水，也不该被静默忽略——
       所以其余来源抽不出文字只**降级**：标记 dropped + warn + 写进报告，用户看得见。 */
    const mainSource = sources[0];
    if (!textOf(mainSource).length) {
      throw new Error(
        `「${label(mainSource)}」里一个字都没抽出来。若是扫描版 PDF（整页都是图片），需要先做 OCR；` +
          '若是 PPT，请确认每页有文本框而不是整页图片。'
      );
    }
    for (const src of sources.slice(1)) {
      if (!textOf(src).length) {
        src.dropped = true;
        log(job, 'warn', `「${label(src)}」没抽到文字（多半是扫描件），本次生成不使用它——其余材料照常`);
      }
    }

    const suspect = [...new Set(sources.flatMap((s) => (s.pages || [])
      .filter((p) => p.quality && p.quality.suspect).map((p) => p.index)))];
    if (suspect.length) {
      log(job, 'warn', `有 ${suspect.length} 页疑似抽取异常（第 ${suspect.slice(0, 12).join('、')} 页）——生成前建议在「抽取预览」里核对`);
    }
    job.extract = {
      // kind/pageCount/chars 保持同名同义（单来源时数值与从前相同）
      kind: mainSource.kind,
      pageCount: sources.reduce((n, s) => n + (s.pages || []).length, 0),
      chars: sources.reduce((n, s) => n + textOf(s).reduce((m, p) => m + p.text.length, 0), 0),
      suspect,
      bySource: sources.map((s) => ({
        id: s.id, role: s.role, label: label(s), kind: s.kind,
        pageCount: (s.pages || []).length,
        chars: textOf(s).reduce((m, p) => m + p.text.length, 0),
        dropped: !!s.dropped,
      })),
    };
    log(job, 'info', `抽取完成：${sources.length} 份来源，合计 ${job.extract.pageCount} 页 / 有效文本 ${job.extract.chars} 字，用时 ${((Date.now() - tEx) / 1000).toFixed(1)}s`);
    progress(job, 'extract', 'done', { detail: `${sources.length} 份 / ${job.extract.pageCount} 页 / ${job.extract.chars} 字` });

    /* ---- 1.5 逐来源分析（S0） ---- */
    /* 每份来源各起一次**独立**调用去理解它（"课本、课件、习题分别开代理抓取分析"）。
       隔离原则与独立审题一致：只给这一份来源的正文与角色说明，不给别的来源的结论、不给过程痕迹。
       单来源时**整段跳过**——那是老路径，为唯一的一份材料多花一次调用没有意义。 */
    const liveSources = sources.filter((s) => !s.dropped);
    const needAnalyze = sources.length > 1 && liveSources.length > 1;
    progress(job, 'analyze', needAnalyze ? 'running' : 'skipped');
    if (needAnalyze) {
      const noteCtx = { sources, options: job.options };
      await mapLimit(liveSources, job.options.concurrency || 3, async (src) => {
        try {
          const note = await askJson(job, {
            stage: 'analyze',
            what: `「${label(src)}」来源分析`,
            ctx: noteCtx,
            messages: prompts.sourceNoteMessages(noteCtx, src),
            validate: (o) => validateSourceNote(o, src, pagesOf(src)),
            provider,
            // 逐来源分析只读不写：读一份材料、说它是什么。所以它是最该交给便宜模型的一步。
            model: modelOf('analyze'),
            signal,
            maxTokens: 8000,
            rounds: 1,
          });
          src.note = trimNote(note);
          log(job, 'info', `「${label(src)}」来源分析完成`);
        } catch (e) {
          if (e && e.canceled) throw e;
          /* ⚠️ 这句必须**按角色**说，不能一句话盖过去。
             对原文权重 > 0 的来源（课件/课本/习题）：分析没了，它仍然以**原文**参与融合；
             对**真题**（`ROLE_WEIGHTS.exampaper === 0`）：它的正文按设计根本不进提示词，
             只靠分析结论里的题型规律参与 —— 所以分析一失败，这份材料就**彻底没参与**。
             以前这里对所有角色都写"它仍以原文参与"，对真题是**假话**：
             用户会以为题型规律还在用，实际一个字都没进去，而且没有任何地方会告诉他。
             （这条有机器证据：`test/sources.js` 的反例里，真题分析失败后产出的页面
               搜不到 `MARK-EXAM`，而正例能搜到。） */
          const viaText = ROLE_WEIGHTS[src.role] > 0;
          log(job, 'warn', `「${label(src)}」来源分析没能完成（${
            viaText ? '只丢这份的分析结论，它仍以原文参与' : '这份材料本次**完全没有参与**——它的正文按设计不进提示词，只靠分析结论，而分析失败了'
          }）：${((e && e.message) || e).slice(0, 140)}`);
        }
      });
      progress(job, 'analyze', 'done', { detail: `${liveSources.filter((s) => s.note).length} / ${liveSources.length} 份` });
    } else {
      log(job, 'info', '本次只有一个来源，跳过逐来源分析');
    }

    /* ---- 1.8 分章：这一次要生成哪几章 ----
       分组规则与"哪几份材料没填章号"这类校验全在 `pipeline/chapters.js`（那边有单测压着），
       这里只管"拿到章定义之后怎么跑"。**一份材料、章号留空 ⇒ 退化成唯一的一章**，
       整条路径与改造前逐字节一致（有 sha256 断言压着）。 */
    const chapters = resolveChapters(job);
    /* 每章结尾那句"最后的忠告"是**大纲的一部分**（模型按这一章的内容写的），
       但拼装契约上它是**整份页面一个**。所以在这里按章收集，收尾时取该份页面**最后一章**的
       —— 一册读到最后，那句话正好是对全册的收束。 */
    const chapterAdvice = [];
    /* 多章时告诉界面"现在跑到第几章了"。单章时给 `undefined`：进度事件的形状与从前一致。 */
    /* 「现在跑到第几章」。**每一处按章跑的进度事件都要带上它** ——
       不带的话，界面在第二章开始时只能看着计数从 `4/4` 跳回 `0/4`，
       而没有任何东西能说明"这是在跑下一章"。用户看到的就是"进度倒退了"。
       单章时返回**空对象**（不是 `{chapter:undefined}`）：事件的形状与从前逐字节一致。 */
    const chExtra = (ci) => (chapters.length > 1
      ? { chapter: { index: ci + 1, total: chapters.length, no: chapters[ci].no || '' } }
      : {});
    job.chapterList = chapters.map((c) => ({ no: c.no, title: c.title, subject: c.subject }));
    /* 这次一共生成了**哪几章**。
       ⚠️ 它与 `job.chapter`（单数，取第一章）不是一回事，两个都要有：
       历史列表里的「这一章是什么」只显示得下一个章号，而**连续性判断**必须知道全部 ——
       合订本只记第一章的话，"上次生成过 13、14，这次接 15"会被判成接不上
       （已知章号只有 13），于是那条"从头缝到尾"的提示永远不会出现。 */
    job.chapterNos = chapters.map((c) => String(c.no || '')).filter(Boolean);
    if (chapters.length > 1) {
      log(job, 'info', `本次生成 ${chapters.length} 章：`
        + chapters.map((c, i) => `第 ${c.no || i + 1} 章${c.title ? '「' + c.title + '」' : ''}`).join('、')
        + `（产出方式：${job.mode === 'separate' ? '分开生成 HTML' : '合成一册'}）`);
    }

    /* ---- 1.9 跨章关联（第 6 条） ----
       判据来自已经拿到的**逐来源分析结论**，所以这里不需要再多烧一次模型调用。
       只在"合成一册 + 至少两章"时才可能问用户；其余情形一个字都不问。 */
    const linkMode = await decideCrossChapter(job, chapters);

    /* ---- 2~4. 逐章生成（规划 → 内容 → 演示） ----
       一章一趟、**串行**。为什么不做"一次规划多章"：那样要把整个规划契约推倒重来
       （模型一次吐出 N 章的单元树），而收益只是省几次调用；串行的改动面小得多，
       而且失败隔离天然——第 13 章砸了，已经跑完的第 14 章不至于跟着一起废掉。 */
    async function buildChapter(chDef, ci) {
      // 多章时才给日志/进度加章前缀：单章时一个字的输出都不许多（有测试在比对日志）
      const chTag = chapters.length > 1 ? `第 ${chDef.no || ci + 1} 章 · ` : '';
      const chSources = chDef.sources;
      const chMain = chSources[0];

      /* ---- 2. 规划 ---- */
      progress(job, 'plan', 'running', chExtra(ci));
      const meta = {
        subject: job.options.subject || '',
        number: chDef.no || job.options.number || '',
        title: chDef.title || job.options.title
          || chMain.meta.title || path.basename(chMain.filePath, path.extname(chMain.filePath)),
      };
      /* `ctx.pages` 保留 = **这一章的主来源**的页：现有几个阶段的提示词都读它，
         保留就不必逐个改写；多来源时它们走 `sourceTextAll(ctx.sources, …)`。
         ⚠️ 多章时 `ctx.sources` 只放**这一章的**来源。放全部会怎样：第 13 章的规划
         看得见第 14 章的课件，于是两章的单元互相串、术语混着用——而页面看起来完全正常。 */
      const ctx = { meta, pages: pagesOf(chMain), sources: chSources, options: job.options };
      /* 「关联生成」（用户在这一册的两章关联大时选的）：把**前面**几章的摘要挂上去。
         只给摘要、不给它们的原文 —— 上下文要留给这一章自己的材料，而摘要本来就是
         "这份材料是什么"里信息密度最高的那一段。没选关联生成时这个字段**根本不存在**，
         于是提示词与从前逐字节一致（prompts.js 那边就是按"有没有这个字段"分支的）。 */
      if (linkMode === 'linked' && ci > 0) {
        ctx.priorChapters = chapters.slice(0, ci).map((c, k) => ({
          no: c.no || String(k + 1),
          title: c.title || '',
          summary: (c.sources || []).map((s) => (s.note && s.note.summary) || '')
            .filter(Boolean).join(' ').slice(0, 400),
        })).filter((c) => c.summary);
      }
      const outline = await askJson(job, {
        stage: 'plan',
        what: '切单元',
        ctx,
        messages: require('./prompts').planMessages(ctx),
        validate: validateOutline,
        provider,
        model,
        signal,
        maxTokens: 8000,
      });

      // 存盘键由**我们**生成：模型写的 key 一旦重复，各章的作答记录就会串在一起
      const no = meta.number || outline.chapter.no || '';
      /* 存盘键：每章必须唯一，且必须能被 assemble 的校验器接受（`/^[\w\-.]+$/`，纯 ASCII）。
         ⚠️ 以前只靠"标题 slug"做唯一性，而中文标题 slug 之后只剩一串 `-`
         （JS 的 `\w` 就是 `[A-Za-z0-9_]`，不含 CJK）：
         实测 `磁介质与磁场中的介质` → `ch13------------studio-v1`。
         后果不是"难看"，而是**串档**：章号留空时，两章只要标题字数相同就得到完全相同的 key，
         localStorage 里的作答记录互相覆盖 —— 这正是骨架注释里点名要防的那件事。
         （实测复现：`test/_audit/v5/p1.html` 的 `key:'ch13------------studio-v1'`）
         所以再缀一段**标题的短哈希**：ASCII 安全，标题不同则 key 必不同。
         英文标题仍留可读的 slug，中文标题那段为空就整个省掉，不至于变成一排破折号。 */
      const titleForKey = String(outline.chapter.title || '');
      const asciiSlug = titleForKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
      const pageKey = `${no ? 'ch' + String(no).replace(/[^\w]/g, '') + '-' : ''}`
        + `${asciiSlug ? asciiSlug + '-' : ''}${shortHash(titleForKey)}-studio-v1`;
      outline.chapter = Object.assign({}, outline.chapter, { no, subject: meta.subject || outline.chapter.subject, title: meta.title || outline.chapter.title });
      job.chapter = { no: outline.chapter.no, title: outline.chapter.title, subject: outline.chapter.subject, key: pageKey };

      // 后续几个阶段的提示词都要引用大纲（章节信息、演示归属），挂到同一个 ctx 上
      ctx.outline = outline;

      const units = (outline.units || []).slice().sort((a, b) => (a.lv || 0) - (b.lv || 0));
      // bigUnit 在契约里没有 uid（§1.2），但执行层要用它来配对题库与提示词，
      // 所以这里统一补一个 —— 契约 §1.4 规定综合大题的 bank.uid 就是 "big"。
      const bigUnit = Object.assign({}, outline.bigUnit, { isBigUnit: true, uid: outline.bigUnit.uid || 'big' });
      const allUnits = units.concat([bigUnit]);
      const planPoints = allUnits.reduce((n, u) => n + (Number(u.targetCount) || 0), 0);
      log(job, 'info', `规划完成：${units.length} 个讲解单元 + 1 个综合大题单元，目标 ${planPoints} 个作答点，${(outline.demos || []).length} 个演示`);
      progress(job, 'plan', 'done', Object.assign({ detail: `${units.length} 个单元 · ${planPoints} 个作答点` }, chExtra(ci)));

      /* ---- 3. 内容（讲解 + 题库，逐单元并行） ---- */
      progress(job, 'content', 'running', Object.assign({ total: allUnits.length, done: 0 }, chExtra(ci)));
      // `prompts` 已经在抽取那一段声明过了（那里要调 sourceNoteMessages），这里不再重复 require
      let doneCount = 0;
      const runState = {};
      const content = await mapLimit(allUnits, job.options.concurrency || CONCURRENCY_DEFAULT, async (u) => {
        if (isCanceled(job)) throw new CanceledError();
        const unitForCtx = Object.assign({}, u, { demoIds: (outline.demos || []).filter((d) => d.unitUid === u.uid).map((d) => d.id) });

        // 综合大题单元不出讲解正文（契约 §1.3），只出大题
        let prose = { html: '', blocks: 0 };
        if (!u.isBigUnit) {
          prose = await askJson(job, {
            stage: 'prose',
            what: `${u.title} 的讲解`,
            ctx,
            repairCtx: Object.assign({}, ctx, { unit: u }),
            messages: prompts.proseMessages(ctx, unitForCtx),
            validate: (o) => validateProse(o, unitForCtx),
            provider,
            model,
            signal,
            // 声明过上限就按声明**一步到位**起步；没声明时它是 null，退回 12000（与 1.3.0 一致）
            tokenPlan: mainTokenPlan,
            maxTokens: 12000,
            /* 最后一次尝试时，"拼装时会安全处理/不影响页面能用"的问题降级成警告，照常交付
               （见 KIND 那一段与 askJson 里的软化逻辑）。前面几次照旧回炉。 */
            softenLastRound: true,
          });
        }
        let bank = await askJson(job, {
          stage: 'bank',
          what: `${u.title} 的题库`,
          ctx,
          // 修复时也要告诉模型"这是哪个单元"，否则它只能从标题猜——猜错的表现是
          // 第二个单元的题被塞进第一个单元，而且页面不会有任何报错
          repairCtx: Object.assign({}, ctx, { unit: u }),
          messages: prompts.bankMessages(ctx, unitForCtx),
          validate: (o) => validateBankShape(o, u),
          provider,
          model,
          signal,
          tokenPlan: mainTokenPlan,
          maxTokens: 16000,
        });

        /* 独立审题（skill 2026-10-16 版新增的「子代理 B」在应用里的对应物）。
           门槛与 skill 保持一致：作答点少的单元不值得多花一次调用。 */
        const auditors = Number(job.options.auditors) || 0;
        if (auditors > 0 && (Number(u.targetCount) || 0) >= 8) {
          /* 审题用的是**另一个模型**（用户配了的话）：审题只读不写——它拿题库重新算一遍、
             报出可疑的题，却不负责出题。所以它是"便宜模型也能干"的典型，正是分阶段模型要省的那一步。
             而下面"按审题意见重出题库"那一轮仍然是**主模型**：那是在出题，要质量。 */
          bank = await auditBank(job, {
            unit: u, unitForCtx, ctx, bank, provider, model, signal, auditors,
            tokenPlan: mainTokenPlan,
            auditModel: stageModel.audit || model,
            auditTokenPlan: asPlanArg(planFor(stageModel.audit || model)),
          });
        }
        // 别的单元已经失败/用户已取消时，这一份刚跑完的结果**不要再写日志与进度**：
        // 界面上已经显示"任务失败"，几秒后又冒出"「U2」完成"只会让人以为出了别的问题。
        if (runState.stopped || isCanceled(job)) return { unit: u, prose, bank, stale: true };
        doneCount++;
        progress(job, 'content', 'running', Object.assign({ done: doneCount, total: allUnits.length, detail: `${doneCount}/${allUnits.length}` }, chExtra(ci)));
        log(job, 'info', `「${u.title}」完成：讲解 ${(prose.html || '').length} 字，题库 ${(bank.items || []).length} 题`);
        return { unit: u, prose, bank };
      }, runState);
      if (isCanceled(job)) throw new CanceledError();
      progress(job, 'content', 'done', Object.assign({ detail: `${allUnits.length}/${allUnits.length}` }, chExtra(ci)));

      /* ---- 4. 演示 ---- */
      const demoPlans = (outline.demos || []).filter((d) => d && d.id);
      const demos = [];
      if (demoPlans.length) {
        progress(job, 'demo', 'running', Object.assign({ total: demoPlans.length, done: 0 }, chExtra(ci)));
        let dDone = 0;
        const failed = [];
        const built = await mapLimit(demoPlans, Math.min(2, job.options.concurrency || 2), async (d) => {
          if (isCanceled(job)) throw new CanceledError();
          let o;
          try {
            o = await askJson(job, {
              stage: 'demo',
              what: `演示 ${d.id}（${d.slider}）`,
              ctx,
              messages: prompts.demoMessages(ctx, d),
              validate: (x) => validateDemo(x, d),
              provider,
              model,
              signal,
              tokenPlan: mainTokenPlan,       // 演示是最容易撞上"输出被截断"的一步
              maxTokens: 16000,
            });
          } catch (e) {
            if (e && e.canceled) throw e;
            /* **演示做不出来，不该让整单失败。**
               演示是加分项（SKILL.md 里单节迷你页的演示本来就是可选的），而它恰好是
               最容易撞上"模型输出被截断/空正文"的一步——要一次吐出一大段 markup + JS + checks。
               以前这里一失败，用户拿不到任何东西：讲解、题库、校验全都白跑了。
               现在只丢掉这一个演示，页面照常产出，并在日志里说清楚是哪个、为什么。 */
            failed.push({ id: d.id, why: (e && e.message) || String(e) });
            log(job, 'warn', `演示 ${d.id} 没能生成，已跳过（页面其余部分照常）：${((e && e.message) || e).slice(0, 200)}`);
            return null;
          }
          dDone++;
          progress(job, 'demo', 'running', Object.assign({ done: dDone, total: demoPlans.length, detail: `${dDone}/${demoPlans.length}` }, chExtra(ci)));
          return { id: d.id, title: `${d.slider} · ${d.insight || ''}`, markup: o.markup, js: o.js, checks: o.checks, sliderId: o.sliderId, viewBox: o.viewBox };
        });
        demos.push(...built.filter(Boolean));
        if (failed.length) {
          log(
            job,
            'warn',
            `有 ${failed.length} 个演示没能生成（${failed.map((f) => f.id).join('、')}），页面其余部分不受影响。` +
              '演示这一步最费模型的输出长度——换一个输出上限更大的模型、或把「演示数」调小，通常就能出。'
          );
          job.demoFailures = failed;
        }
        progress(job, 'demo', failed.length === demoPlans.length ? 'failed' : 'done', Object.assign({
          detail: failed.length ? `${built.filter(Boolean).length}/${demoPlans.length}（${failed.length} 个跳过）` : `${built.length}/${demoPlans.length}`,
        }, chExtra(ci)));
      } else {
        progress(job, 'demo', 'skipped', Object.assign({ detail: '本次不生成演示' }, chExtra(ci)));
      }

      chapterAdvice[ci] = outline.finalAdvice || '';

      /* 这一章的产物，形状就是拼装器认的那个 `chapters[]` 元素。
         以前它一整段住在主流程里；多章之后它必须**跟着章走**——
         `pageKey` / `outline` / `content` / `demos` 全是这一章自己的东西。 */
      return {
        key: pageKey,
        frozen: false,
        chapter: { subject: outline.chapter.subject, number: outline.chapter.no, title: outline.chapter.title, intro: outline.chapter.intro || '' },
        units: content.map((c) => ({
          id: c.unit.sectionId || c.unit.uid,
          num: c.unit.num || '',
          title: c.unit.title,
          qsecTitle: c.unit.qsecTitle,
          lede: c.unit.lede || '',
          lectureHtml: c.prose.html || '',
          bank: (c.bank && c.bank.items) || [],
        })),
        // 带上 unitId：占位注释没被模型写进正文时，assemble 要能把它挂到**该演示所属单元**的
        // 题区之前。以前统一挂到末尾、日志却说"最后一个单元"，位置与日志都不对。
        demos: demos.map((d) => {
          const plan = demoPlans.find((x) => x.id === d.id) || {};
          const owner = allUnits.find((u) => u.uid === plan.unitUid);
          return {
            id: d.id,
            title: d.title,
            markup: d.markup,
            js: d.js,
            /* ⚠️ `checks` 必须跟着走：demo-checks（契约 §1.5）拿它做"模型手算 vs
               页面实算"的核对。多章改造时这里漏了它，于是 page.demos 里的每一项都没有
               checks —— checkDemos 直接判"这次没有可核对的 checks"，整条演示核对**静默失效**。
               sliderId / viewBox 同理：修复轮重出演示时要用它们做字段级校验。 */
            checks: Array.isArray(d.checks) ? d.checks : [],
            sliderId: d.sliderId || '',
            viewBox: d.viewBox || '',
            unitId: owner ? owner.sectionId || owner.uid : '',
            unitTitle: owner ? owner.title : '',
          };
        }),
      };
    }

    /* 逐章跑。**串行**：第 N+1 章开始之前第 N 章已经完整跑完 —— 于是日志与进度是线性的、
       失败点明确，也不会出现两章同时在打模型（多来源时那样做是为了融合，多章没有这个必要）。 */
    const newChapters = [];
    for (let ci = 0; ci < chapters.length; ci++) {
      newChapters.push(await buildChapter(chapters[ci], ci));
    }

    /* ---- 5. 拼装 ---- */
    // 收尾几个阶段以前完全不看取消信号：用户在"校验"那一步（最长 45s，是最宽的窗口）
    // 点了取消，日志里会同时出现"用户取消了任务"和"全部完成"，状态还是 done、文件也落了盘。
    if (isCanceled(job)) throw new CanceledError();
    /* 用户以前生成过的章（`gen:start` 载入后挂在 `job.carry` 上），**排在新的前面**。
       `frozen: true` 是给拼装器的信号：**这一章的作答点 id 一个字都不许改**——
       id 就是做题进度的存盘键，改了那一章的记录就全部对不上（而且症状是静默的串档）。 */
    const carried = (job.carry || []).map((c) => ({
      /* ⚠️ `frozen` 必须写在 **chapter 里面**：拼装器读的是 `c.chapter.frozen`（`assemble.js:534`）。
         写在条目这一层是**静默失效**——带过来的章不会被当成冻结章，它的作答点 id 会被重新命名，
         于是**那一章以前做过的题全部对不上**，而页面看起来完全正常。
         CHAPTER_MERGE_CONTRACT: frozen 在 chapter 内。 */
      /* 拼装器读的是 `chapter.number`；旁挂数据/revive 给的是 `no`。
         不补这一下的话，带过来的章在页面里会退化成"第 1 章/第 2 章"（按数组序号），
         而且不报错 —— 用户只会觉得"章号没带过来"。 */
      chapter: Object.assign({}, c.chapter, {
        number: (c.chapter && (c.chapter.number || c.chapter.no)) || '',
        frozen: true,
      }),
      units: c.units,
      demos: c.demos || [],
      key: c.key || '',
    }));

    const outDir = job.options.outputDir || path.dirname(job.filePath);
    fs.mkdirSync(outDir, { recursive: true });
    preview.allow(outDir);

    /* 这一次要写出**几份页面**：
         · `book`      —— 一份，装的是 [以前那些章…, 这次新生成的 N 章…]（N 可以是 1，就是老路径）
         · `separate`  —— 每章一份，各自独立、互不引用（用户要的就是"这周只发这一章"）
       两种模式共用下面同一段收尾代码，差别只在"这一份页面里装哪几章"。 */
    const separate = job.mode === 'separate' && chapters.length > 1;
    const pages = separate
      ? newChapters.map((c, i) => ({
        set: [c],
        tag: `第 ${chapters[i].no || i + 1} 章 · `,
        subject: c.chapter.subject,
        title: c.chapter.title,
        finalAdvice: chapterAdvice[i] || '',
        demos: c.demos || [],
      }))
      : [{
        set: [...carried, ...newChapters],
        tag: '',
        subject: newChapters[newChapters.length - 1].chapter.subject,
        title: newChapters[newChapters.length - 1].chapter.title,
        finalAdvice: chapterAdvice[chapterAdvice.length - 1] || '',
        // 修复轮与演示读数核对要按**这一份页面里实际有**的演示来，不能拿全部章的
        demos: newChapters.reduce((acc, c) => acc.concat(c.demos || []), []),
      }];

    const outputs = [];
    for (const page of pages) {
    let chapterFile = '';
    const what = page.set.length > 1 ? '这一册' : '这一章';
    progress(job, 'assemble', 'running');
    /* 册的存盘键**必须与章列表无关**：
         · 带过来的那份本身已经是册 → 用它的键（`gen:start` 放在 `job.carryBookKey`）
         · 否则用**这一份页面里第一章**的键 → 于是"再加一章"时键不变，进度一个字都不用搬
       ⚠️ 键要是随章列表变，每加一章都得把全册进度搬一次家，
       而搬家的失败模式是**完全静默的串档**（页面看着完全正常，做题记录却串到别的题上）。 */
    const isBook = page.set.length > 1;
    const bookKey = job.carryBookKey || (page.set[0] && page.set[0].key) || '';
    if (!bookKey) throw new Error('内部错误：算不出这一份页面的存盘键（章列表是空的）');
    if (isBook && carried.length) {
      log(job, 'info', `${page.tag}这一份是**一册**：${page.set.length} 章`
        + `（册的存盘键沿用「${(carried[0] && carried[0].chapter && carried[0].chapter.title) || '带过来的那一章'}」的，`
        + '这样以前做过的题在这个页面里还看得到）');
    }

    const assembleInput = {
      skeleton: getSkill()(),
      chapters: page.set,
      pageKey: bookKey,                       // 一册一个键；单章时就是这一章的键
      book: isBook ? { title: job.options.bookTitle || '', subject: page.subject } : null,
      generator: '讲练一体工作台 v' + require('../version').appVersion(),
      finalAdvice: page.finalAdvice,
      pet: job.options.pet || 'none',
    };
    let built;
    try {
      built = getAssemble()(assembleInput);
    } catch (e) {
      if (e.bankErrors) {
        e.message =
          `题库有 ${e.bankErrors.length} 处不合格，无法拼装：\n` +
          e.bankErrors.slice(0, 10).map((b) => `· [${b.unit}] ${b.message}`).join('\n') +
          (e.bankErrors.length > 10 ? `\n… 另有 ${e.bankErrors.length - 10} 处` : '');
      }
      throw e;
    }
    for (const w of built.warnings) log(job, 'warn', w);
    for (const f of built.fixes.slice(0, 30)) log(job, 'info', `自动修正：${f.unit ? '[' + f.unit + '] ' : ''}${f.message}`);
    if (built.fixes.length > 30) log(job, 'info', `另有 ${built.fixes.length - 30} 处同类自动修正未逐条列出`);

    /* ---- 6. 落盘 ---- */
    const htmlPath = path.join(outDir, isBook
      ? bookOutName(job.options.bookTitle, assembleInput.chapters, job.filePath)
      : outName(page.set[0].chapter, job.filePath));
    // 最后一道：**断言产出真的落在用户选的目录里**。净化函数哪天被人改坏、
    // 或者将来加了别的名字来源，这一句都能当场拦住"写到别处去"。
    const resolvedOut = path.resolve(outDir) + path.sep;
    if (!path.resolve(htmlPath).startsWith(resolvedOut)) {
      throw new Error(`内部错误：算出来的输出路径跑到了输出目录外面（${htmlPath}），已中止以免写错地方`);
    }
    fs.writeFileSync(htmlPath, built.html, 'utf8');
    if (!job.htmlPath) job.htmlPath = htmlPath;      // 结果页默认打开第一份
    job.htmlPaths = (job.htmlPaths || []).concat([htmlPath]);

    // 陪练：用户自备图片 → 拷到 HTML 同目录并起一个引擎认识的名字
    if ((job.options.pet || 'none') === 'image' && job.options.petImagePath) {
      try {
        const ext = path.extname(job.options.petImagePath).toLowerCase() || '.png';
        const okExt = ['.png', '.jpg', '.jpeg', '.webp'];
        if (okExt.includes(ext)) {
          const dest = path.join(outDir, 'pet' + ext);
          fs.copyFileSync(job.options.petImagePath, dest);
          log(job, 'info', `陪练图片已放到页面同目录：${path.basename(dest)}`);
        } else {
          log(job, 'warn', `陪练图片格式不支持（${ext}），请用 png/jpg/jpeg/webp；本次页面会显示内置大肥鱼`);
        }
      } catch (e) {
        log(job, 'warn', '复制陪练图片失败：' + e.message);
      }
    }

    log(job, 'info', `${page.tag}页面已写出：${htmlPath}（${(built.stats.bytes / 1024).toFixed(1)} KB，${built.stats.total} 个作答点）`);
    progress(job, 'assemble', 'done', { detail: `${(built.stats.bytes / 1024).toFixed(0)} KB · ${built.stats.total} 个作答点` });

    /* ---- 7. 校验 ---- */
    if (isCanceled(job)) throw new CanceledError();
    progress(job, 'verify', 'running');
    let report = null;
    const probes = ['verify'];
    if (built.stats.demos > 0) probes.push('demo');
    probes.push('pet');
    try {
      report = await runProbesAndChecks(htmlPath, probes,
        demosForChecks(built, page, newChapters.length), job.demoFailures, job.proseDowngrades);
      if (!job.report) job.report = attachAudit(job, report);
      const bad = (report.items || []).filter((i) => i.ok === false);
      if (bad.length) log(job, 'warn', `校验有 ${bad.length} 项没过：${bad.map((b) => b.label).join('、')}`);
      else log(job, 'info', '页内校验全部通过');
      if (report.consoleErrors && report.consoleErrors.length) {
        log(job, 'warn', `页面控制台有 ${report.consoleErrors.length} 条错误：${report.consoleErrors.slice(0, 3).join(' | ')}`);
      }
      progress(job, 'verify', 'done', { detail: bad.length ? `${bad.length} 项待修` : '全部通过' });
    } catch (e) {
      // 校验跑不起来不是致命问题——页面已经产出且可以打开。但必须说清楚，别让用户以为"验过了"。
      log(job, 'warn', '自动校验没能跑完：' + e.message + '（页面已生成，但**这一页没有被自动验证过**）');
      progress(job, 'verify', 'failed', { detail: e.message });
    }

    /* ---- 8. 修复（只修"能定位到具体单元"的问题） ---- */
    if (isCanceled(job)) throw new CanceledError();
    if (report && job.options.repairRounds > 0) {
      const fixes = await repairRound(job, { report, demos: page.demos, provider, model, signal, tokenPlan: mainTokenPlan, htmlPath, built, assembleInput, outDir });
      if (fixes) {
        progress(job, 'repair', 'running', { detail: '重出有问题的演示' });
        try {
          built = getAssemble()(assembleInput);
          fs.writeFileSync(htmlPath, built.html, 'utf8');
          if (!job.htmlPath) job.htmlPath = htmlPath;
          report = await runProbesAndChecks(htmlPath, probes,
        demosForChecks(built, page, newChapters.length), job.demoFailures, job.proseDowngrades);
          if (!job.report) job.report = attachAudit(job, report);
          const bad2 = (report.items || []).filter((i) => i.ok === false);
          progress(job, 'repair', 'done', { detail: bad2.length ? `仍有 ${bad2.length} 项没过` : '修复后全部通过' });
          log(job, bad2.length ? 'warn' : 'info', bad2.length ? `修复后仍有 ${bad2.length} 项没过` : '修复后校验全部通过');
        } catch (e) {
          progress(job, 'repair', 'failed', { detail: e.message });
          log(job, 'warn', '修复后重跑校验失败：' + e.message);
        }
      } else {
        progress(job, 'repair', 'skipped', { detail: '没有需要修复的项' });
      }
    } else {
      progress(job, 'repair', 'skipped', { detail: report ? '已关闭自动修复' : '没有校验报告' });
    }

    /* ---- 6.1 旁挂一份结构化数据（"以后能不能并进一册"全靠它）----
       ⚠️ 位置很讲究，两条：
         · 必须写在**最终产物之后**。修复轮会重拼一次（上面那段），
           要是写在初次落盘那里，演示的修正就不会进这份数据 —— 而合并时用的是它。
         · 必须写在**成功路径上**（`finish` 之前）。半途失败的任务没有页面，
           留一份数据下来是孤儿：谁都打不开，还会在历史里假装"能准确合并"。
       ⚠️ 失败**不拖垮整单**：页面照常交付。但这句警告要说清后果 ——
       用户得知道"这一章以后不能并进一册"，而不是等到那天才发现。 */
    try {
      const bk = require('../book');
      const r = bk.writeBook(htmlPath, {
        // 一册写 'book'、单章写 'chapter'：**同一个文件形状**，读取端一套代码。
        // `kind:'book'` 还有个用处——下次再带它进来时，合并页要用**册的键**（不是某一章的键），
        // 否则每加一章都得把全册进度搬一次家。
        kind: isBook ? 'book' : 'chapter',
        title: job.options.bookTitle || page.title,
        subject: page.subject,
        key: bookKey,                          // 一册一个键；单章时就是这一章的键
        /* ⚠️ 一定要用 `built.finalChapters`（拼装器**最终**那一份），不能用 `assembleInput.chapters`。
           两者差在**作答点 id**：输入里是模型给的原始 id（`u1-s1`），而页面里生效的是加了单元命名空间的
           （`s131-u1-s1`）。存错那一份的后果是**静默的**：带过来的章被冻结、id 保持原样，
           而学生原来的进度是按带命名空间的那个存的 —— 那一章的记录会全部读不出来，
           而页面看起来完全正常。（这条是实测对比"页面题库 vs 旁挂数据"抓出来的。）
           自己再算一遍命名空间是不行的：两份规则迟早走散，走散又是静默丢进度。
           所以只能由**唯一知道最终结果的那个地方**（拼装器）给出来。 */
        chapters: (built.finalChapters || []).map((fc, i) => {
          const src = page.set[i] || {};
          return {
            chapter: fc.chapter,
            key: src.key || '',
            sourceFile: src.chapter && src.chapter.frozen
              ? src.chapter.sourceFile || '(以前生成的)'
              : job.fileName || path.basename(job.filePath || ''),
            createdAt: Date.now(),
            jobId: src.chapter && src.chapter.frozen ? '' : job.id,
            units: fc.units,
            demos: fc.demos || [],
            frozen: !!(src.chapter && src.chapter.frozen),
          };
        }),
      });
      if (r && r.ok) {
        chapterFile = r.path;
        for (const w of (r.warnings || [])) log(job, 'warn', '章节数据：' + w);
      } else {
        log(job, 'warn', `${what}的结构化数据没能存下来（${(r && r.reason) || '未知原因'}）——`
          + '页面照常能用，但以后不能再把它并进一册');
      }
    } catch (e) {
      log(job, 'warn', `${what}的结构化数据没能存下来（` + ((e && e.message) || e) + '）——'
        + '页面照常能用，但以后不能再把它并进一册');
    }

    /* 结果页按这份清单逐个列出（`separate` 模式会有好几份）。
       兼容字段：`job.htmlPath` / `job.chapterFile` / `job.report` 取**第一份**的 ——
       老的结果页只读这三个，取第一份比取最后一份更符合"我这次到底生成了什么"的直觉。 */
    outputs.push({ htmlPath, chapterFile, isBook, chapters: page.set.length,
      chapter: page.set[0].chapter, report, tag: page.tag });
    }   // ← for (const page of pages)

    job.outputs = outputs;
    if (outputs.length && !job.chapterFile) job.chapterFile = outputs[0].chapterFile || '';
    job.durationMs = Date.now() - t0;
    log(job, 'info', `全部完成，用时 ${(job.durationMs / 1000).toFixed(1)}s`
      + (outputs.length > 1 ? `，共写出 ${outputs.length} 份页面` : ''));

    finish(job);
    return job;
  } catch (e) {
    if (e && e.canceled) {
      job.status = 'canceled';
      log(job, 'warn', '任务已取消');
      /* 取消也留一份日志：取消和失败同属"没跑完"，用户回头想看当时跑到哪儿了，是同一个需求。
         而且取消之后往往还会去清理文件，日志正好说明"清掉的是什么、当时发生了什么"。 */
      const p = writeRunLog(job, '被你取消了');
      if (p) log(job, 'info', '这次的日志已写在输出目录：' + path.basename(p));
      jobs.emit(job, { type: 'done', status: 'canceled' });
      jobs.saveHistory();
      return job;
    }
    /* 失败时先把日志落到输出目录，**再**调 fail —— 顺序反过来的话 fail 会先把状态改成 failed，
       而这份日志正是要记"失败在哪一步"。 */
    const lp = writeRunLog(job, '任务失败：' + ((e && e.message) || e));
    if (lp) log(job, 'info', '这次的日志已写在输出目录：' + path.basename(lp));
    fail(job, e);
    return job;
  } finally {
    job._abort = null;
  }
}

/** 审题报告的校验器：只要求结构对；**不给"必须有问题"的压力**（全对是常见结果）。 */
function validateAudit(o) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (!Array.isArray(o.issues)) return ['缺 issues 数组（全对时写成 "issues":[]）'];
  o.issues.forEach((it, i) => {
    if (!it || typeof it !== 'object') p.push(`issues[${i}] 不是一个对象`);
    else {
      if (!it.id) p.push(`issues[${i}] 缺 id（哪道题）`);
      if (!it.detail) p.push(`issues[${i}] 缺 detail（问题是什么）`);
    }
  });
  return p;
}

/** 把题干压成一行摘要。题库里的 stem 常带 HTML 标签，报告里是纯文本，得先剥掉。 */
function stemBrief(s) {
  const t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 46 ? t.slice(0, 46) + '…' : t;
}

/**
 * **独立审题**：对应 skill 2026-10-16 版新增的「子代理 B」。
 *
 * 探针只验得了"判分逻辑对不对"，验不了"答案本身对不对"——数值题答案错一位，
 * 学生就照着错一位学。这一步补的就是这个缺口：再调一次模型，只给它题库和素材、
 * 不给任何出题过程的痕迹，让它从头独立重算。
 *
 * 三条设计取舍：
 *   · **审题失败不拖垮整单**：它是加分项，挂了就保留原题库，只记一条警告。
 *   · **只让 high 级问题触发重出**：low 是措辞建议，为它重出一遍不值当。
 *   · **最多重出 2 轮**：第二轮还报同样的 high 问题，说明两边判断不一致，
 *     再循环只会烧钱——记下来交给用户看，比假装修好了强。
 */
async function auditBank(job, o) {
  const prompts = require('./prompts');
  let bank = o.bank;
  if (!bank || !Array.isArray(bank.items) || !bank.items.length) return bank;

  /* 审题人的**人数**由用户选（0–3）。应用没有"子代理"机制，但这件事在语义上就是交叉检验：
     N 个互不可见的模型调用、各自从头独立重算。所以这里不做任何"共享上下文"的事——
     它们谁也不看谁的结论，计票在最后。
     0 = 不开（省调用，但答案对不对没人独立复核）；上限 3 是成本墙，再多边际收益很小。 */
  const N = Math.max(0, Math.min(3, Number(o.auditors) || 0));
  if (!N) return bank;

  /** 多人时要求"两个独立的人报同一题"才改；单人时当然一个人说了算。 */
  const NEED = N === 1 ? 1 : 2;

  job.audit = job.audit || { rounds: 0, auditors: N, high: 0, single: 0, low: 0, byUnit: {}, suspect: [] };

  for (let round = 0; round < 2; round++) {
    if (isCanceled(job)) throw new CanceledError();

    // N 位审题人**并行**跑（他们本来就互不依赖），一位失败只丢这一位
    const reports = await mapLimit(
      Array.from({ length: N }, (_, i) => i),
      N,
      async (i) => {
        try {
          const r = await askJson(job, {
            stage: 'bank',
            what: N > 1 ? `${o.unit.title} 的独立审题（第 ${i + 1}/${N} 位）` : `${o.unit.title} 的独立审题`,
            ctx: o.ctx,
            messages: prompts.auditMessages(o.ctx, o.unit, bank.items, { index: i + 1, total: N }),
            validate: validateAudit,
            provider: o.provider,
            // 审题人用的可能是**便宜的那个模型**（见 gen 主流程里"分阶段模型"那段）
            model: o.auditModel || o.model,
            signal: o.signal,
            tokenPlan: o.auditTokenPlan || null,
            maxTokens: 8000,
            rounds: 1,
          });
          return { ok: true, issues: Array.isArray(r.issues) ? r.issues : [] };
        } catch (e) {
          if (e && e.canceled) throw e;
          log(job, 'warn', `「${o.unit.title}」第 ${i + 1}/${N} 位审题没能完成（只丢这一位）：${((e && e.message) || e).slice(0, 140)}`);
          return { ok: false, issues: [] };
        }
      }
    );

    const okOnes = reports.filter((r) => r.ok);
    if (!okOnes.length) {
      log(job, 'warn', `「${o.unit.title}」${N} 位审题人都没能完成，题库保留原样`);
      return bank;
    }

    // 逐题计票：哪位审题人报了哪道题为 high
    /* 计票必须按**人数**，不能按**条数**。
       审计实测过一个能让整套交叉检验失效的写法：同一位审题人在一次回答里对同一道题
       给两条 high（例如同时报 wrong-answer 与 bad-why）——按条数就是两票，
       直接凑够"两人独立确认"，**一个人的误报就能改掉一个本来正确的答案**，
       而日志还会谎报"2 位审题人中至少 2 位都报了同一题"。
       所以：每位审题人内部先按 id 去重，再计入 Map。 */
    const votes = new Map();
    let lowCount = 0;
    /* 计票要**记得住是谁投的**：报告里得写清"谁怀疑"（第 i/N 位审题人）。
       所以这里不能先 filter 出 okOnes 再遍历——那样会丢掉原始序号，
       只能写出"有一个人报了"，用户拿着这句话没法判断该不该信。 */
    for (let ai = 0; ai < reports.length; ai++) {
      const r = reports[ai];
      if (!r.ok) continue;                      // 没跑完的那位不参与计票
      const seenByThisAuditor = new Set();
      for (const it of r.issues) {
        if (!it || it.severity !== 'high') {
          lowCount++;
          continue;
        }
        const k = String(it.id);
        if (seenByThisAuditor.has(k)) continue; // 同一位重复报同一题只算一票
        seenByThisAuditor.add(k);
        const v = votes.get(k) || { n: 0, samples: [], by: [] };
        v.n++;
        v.by.push(ai + 1);                      // 1 起，与日志/提示词里的"第 i 位"同一个编号
        if (v.samples.length < 3) v.samples.push(it);
        votes.set(k, v);
      }
    }

    // 题号 → 题干摘要：报告是给人看的，只丢一个 `u1-n1` 这种内部 id，用户对不上是哪道题
    const stemById = new Map();
    for (const it of (bank.items || [])) {
      if (it && it.id) stemById.set(String(it.id), it.stem || '');
    }
    const agreed = [...votes.entries()].filter(([, v]) => v.n >= NEED);
    const single = [...votes.entries()].filter(([, v]) => v.n < NEED);

    job.audit.rounds++;
    job.audit.byUnit[o.unit.title] = {
      auditors: okOnes.length,
      high: agreed.length,
      single: single.length,
      low: lowCount,
    };
    job.audit.low += lowCount;

    /* 只被少数人报出的**不改**，但也不丢：记进报告。
       理由：审题最大的风险是误报（误报会让出题人把对的改成错的），
       所以多人模式下宁可用"两个独立确认"这道门槛；而只报一次的那些，
       交给用户人工看一眼，比让模型按可疑意见改掉更稳。 */
    if (single.length) {
      job.audit.single += single.length;
      for (const [id, v] of single) {
        const x = v.samples[0] || {};
        job.audit.suspect.push({
          unit: o.unit.title,
          id,
          n: v.n,
          of: okOnes.length,
          by: v.by.slice(),          // 是哪几位审题人（1 起）——"谁怀疑"
          kind: x.kind || '',
          detail: x.detail || '',    // "怀疑什么"
          suggest: x.suggest || '',
          stem: stemBrief(stemById.get(String(id))),   // "哪一题"
        });
      }
      log(job, 'info', `「${o.unit.title}」有 ${single.length} 题只被 ${okOnes.length} 位审题人中的少数报出（${single.map(([id, v]) => `${id}×${v.n}`).join('、')}）——**没到"两人独立确认"，不改**，已记进校验报告的「有人怀疑、但没被确认的题」一节供你人工看一眼`);
    }

    if (!agreed.length) {
      log(job, 'info', `「${o.unit.title}」独立审题通过（${okOnes.length} 位审题人${lowCount ? `，另有 ${lowCount} 条非致命建议` : ''}）`);
      return bank;
    }

    job.audit.high += agreed.length;
    log(job, 'warn', `「${o.unit.title}」${agreed.length} 处**答案级**问题被独立确认` +
      `（${okOnes.length} 位审题人${NEED > 1 ? `中至少 ${NEED} 位都报了同一题` : ''}），正在按意见重出：` +
      agreed.slice(0, 3).map(([id, v]) => `第 ${id} 题 ${(v.samples[0] || {}).detail || ''}`).join('；') +
      (agreed.length > 3 ? ' …' : ''));

    try {
      bank = await askJson(job, {
        stage: 'bank',
        what: `${o.unit.title} 的题库（按审题意见重出）`,
        ctx: o.ctx,
        repairCtx: Object.assign({}, o.ctx, { unit: o.unit }),
        messages: prompts.bankMessages(o.ctx, o.unitForCtx || o.unit),
        seedProblems: agreed.map(([id, v]) => {
          const x = v.samples[0] || {};
          return `第 ${id} 题（${x.kind || '问题'}）：${x.detail || ''}${x.suggest ? ' → ' + x.suggest : ''}`;
        }),
        validate: (r) => validateBankShape(r, o.unit),
        provider: o.provider,
        // ⚠️ 这一轮**仍然用主模型**：它是在出题，不是在挑错。审题可以交给便宜模型，重出不行。
        model: o.model,
        signal: o.signal,
        tokenPlan: o.tokenPlan || null,
        maxTokens: o.maxTokens || 16000,
      });
    } catch (e) {
      if (e && e.canceled) throw e;
      log(job, 'warn', `「${o.unit.title}」按审题意见重出失败（保留上一版题库）：${((e && e.message) || e).slice(0, 160)}`);
      return bank;
    }
  }
  log(job, 'warn', `「${o.unit.title}」按审题意见重出后**仍有**答案级问题——两边判断不一致，已按模型给的版本交付，建议人工看一眼这几题`);
  return bank;
}

/**
 * 跑探针 + 演示读数核对，合成一份报告。
 *
 * 两条是**互相独立**的证据：探针看的是"页面能不能用"（判分/计数/存盘/陪练/报错），
 * demo-checks 看的是"演示的图和数自不自洽"（模型手算的公式值 vs 页面实算的读数）。
 * 任一条挂了都不该把另一条吞掉——所以这里用 allSettled 的手工版本，各自 try/catch。
 */
/**
 * 交给 demo-checks 的演示列表：**id 必须是最终 id**。
 *
 * 拼装器会给撞名的演示改名（一册里两章都从 demoA 开始 → 后一个变 demoB），
 * 而 `page.demos` 里还是模型给的 plan id。拿 plan id 去最终页面里找元素，
 * 轻则"找不到读数"，重则**核对到另一章的同名演示**。
 *
 * finalChapters 与 page.set 同序；`newCount` 是本次新生成的章数（前面的都是带过来的）。
 * 只把 final id 换上去，checks 仍取 page.demos 里的那一份。
 */
function demosForChecks(built, page, newCount) {
  const list = (page && Array.isArray(page.demos)) ? page.demos : [];
  const finals = [];
  if (built && Array.isArray(built.finalChapters) && built.finalChapters.length >= newCount) {
    for (let ci = built.finalChapters.length - newCount; ci < built.finalChapters.length; ci++) {
      const ch = built.finalChapters[ci] || {};
      for (const d of (ch.demos || [])) finals.push(d);
    }
  }
  return list.map((d, i) => Object.assign({}, d, {
    id: (finals[i] && finals[i].id) || d.id,
  }));
}

async function runProbesAndChecks(htmlPath, probes, demos, fails, proseDowngrades) {
  const report = await require('../verify/runner').runProbes({ htmlPath, probes, timeoutMs: 45000 });
  try {
    const r = await require('../verify/demo-checks').checkDemos({ htmlPath, demos: demos || [] });
    if (r && r.label) {
      report.items = (report.items || []).concat([{ key: 'demo-checks', label: r.label, raw: r.note, ok: r.ok, note: r.note }]);
      report.demoChecks = r;
    }
  } catch (e) {
    report.items = (report.items || []).concat([
      { key: 'demo-checks', label: '演示读数与公式是否自洽', raw: '核对没跑起来：' + e.message, ok: null, note: e.message },
    ]);
  }
  // 有演示没生成出来的话，报告要如实写出来——否则用户只会觉得"说好的 2 个演示呢"
  if (fails && fails.length) {
    report.items = report.items || [];
    report.items.unshift({
      key: 'demo-missing',
      label: `有 ${fails.length} 个演示没能生成`,
      raw: fails.map((f) => `${f.id}：${String(f.why).slice(0, 120)}`).join(' ｜ '),
      ok: false,
      note:
        '演示是加分项，页面其余部分不受影响。这一步最费模型的输出长度——' +
        '换个输出上限更大的模型，或把工作台里的「演示数」调到 1，通常就能出。',
    });
  }
  /* 降级交付也要如实写进报告（见 askJson 里"最后一次尝试"那段）。
     用户翻开报告时得知道："这一段的讲解在最后一次尝试时仍然带着这类问题，是我们**没再重试**
     直接交付的" —— 而不是以为它是一次就过。
     ⚠️ `ok:null` 是**第三类**结果（既不是通过也不是没通过，更不是"没测到"）：
     写成 ok:false 会被算进"没通过"、还会被 repairRound 当成"要不要重出演示"的判据，
     写成 ok:true 则是假话（它并不是校验通过的）。渲染层为这个 key 单独显示「降级交付」标签。 */
  if (proseDowngrades && proseDowngrades.length) {
    report.items = report.items || [];
    const n = proseDowngrades.reduce((s, d) => s + (d.problems || []).length, 0);
    report.items.push({
      key: 'prose-downgrade',
      label: `${proseDowngrades.length} 段讲解有 ${n} 处「拼装时会自动处理 / 不影响页面能用」的问题，未再重试（已照常交付）`,
      raw: proseDowngrades.map((d) => `${d.what}：${(d.problems || []).join('；')}`).join(' ｜ '),
      ok: null,
      note:
        '这些讲解在最后一次尝试时仍然带着这几处问题，而重试次数已经用完。它们要么会被拼装器安全处理掉' +
        '（内联事件剥掉、外链改成 #、<link>/<meta>/<form>/<iframe> 整类删掉），要么交付后也不影响页面能不能用' +
        '（例如正文里多出来的表单控件）——所以不再为它们重试，照常交付了。页面里的正文内容没有丢。' +
        '如果你不希望正文里出现这类写法，换一个更听话的模型，或把「修复轮次」调大。',
    });
    report.proseDowngrades = proseDowngrades.slice();
  }
  return report;
}

/**
 * 把独立审题的结论并进校验报告。
 *
 * ⚠️ 这一步曾经整个漏掉，症状是**信息只在日志里活着**：`auditBank` 明明把
 * "只被少数审题人报出、没到两人确认"的疑点记进了 `job.audit.suspect`，
 * 日志里也明写着"已记进校验报告供你人工看一眼"，可 `job.report` 里根本没有
 * audit 这一节，渲染层只读 `report`（全仓没有任何地方读 `job.audit`）。
 * 用户关掉日志窗口，这条**最该人看一眼**的信息就没了——而日志还告诉他去看报告。
 *
 * 注意**别**把它塞进 `report.items`：items 是探针结果，会参与"没通过 N 项"的统计，
 * 而"有人怀疑"既不是通过也不是没通过。写成失败项或写成断言，用户就会去改
 * 本来正确的答案——这正是多人投票门槛要防的事。所以单独放在 `report.audit` 里。
 */
function attachAudit(job, report) {
  if (!report) return report;      // 校验压根没跑起来时没有报告可挂（这种情况渲染层会回落读 job.audit）
  const a = job.audit;
  if (!a) return report;
  report.audit = {
    auditors: a.auditors,
    rounds: a.rounds,
    high: a.high,                  // 被"两人独立确认"、已按意见重出的处数
    single: a.single,
    low: a.low,
    suspect: (a.suspect || []).slice(),
    byUnit: a.byUnit || {},
  };
  return report;
}

function validateDemo(o, plan) {
  const p = [];
  if (!o || typeof o !== 'object') return ['返回的不是一个对象'];
  if (typeof o.markup !== 'string' || !o.markup.includes(`id="${plan.id}"`)) {
    p.push(`markup 的根元素必须是 <div class="demo" id="${plan.id}">`);
  }
  if (typeof o.markup === 'string') {
    if (/<script\b|<\/script/i.test(o.markup)) p.push('markup 里不许有 script 标签');
    if (/<style\b/i.test(o.markup)) p.push('markup 里不许有 <style>（样式写在 practice.css 或行内 style 属性里）');
  }
  if (typeof o.js !== 'string' || o.js.length < 40) p.push('js 太短或不是字符串');
  else {
    // `</script` 与 `<script>` 一样致命：前者让解析器**提前闭合**引擎脚本，
    // 整页 JS 全死、残余源码变成页面上的文字，而生成端毫无察觉。
    // （assemble 的 jsForScript 会兜一层转义，这里拦下来是为了让模型改对，而不是靠兜底活着。）
    if (/<script\b/i.test(o.js)) p.push('js 里不许有 <script> 标签');
    if (/<\/script/i.test(o.js)) p.push('js 里不许出现 </script（哪怕在字符串里）——它会提前闭合页面的脚本标签');
    // 演示里的元素 id 必须带自己的前缀，否则会和别的演示/题目卡片撞名。
    // 契约 §4 允许两种前缀：`d<X>-` 或 `<本演示id>-`（提示词里就是这么写的，别把后者判成不合格）。
    const prefix = new RegExp('^(?:d[A-Z]|' + String(plan && plan.id ? plan.id : 'demo[A-Z]').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')-');
    const badIds = [];
    for (const m of o.js.matchAll(/getElementById\(\s*["']([^"']+)["']/g)) {
      if (!prefix.test(m[1])) badIds.push(m[1]);
    }
    if (badIds.length) {
      p.push(`演示里取的这些 id 没有本演示的前缀（${badIds.slice(0, 4).join('、')}）——请用 \`${plan.id}-\` 开头，避免与别的演示或题卡撞名`);
    }
  }
  if (!Array.isArray(o.checks) || o.checks.length < 2) p.push('checks 至少给 2 组手算核对（不许猜）');
  return p;
}

/** 依据校验报告决定要不要重出演示；返回 true 表示改过了。 */
async function repairRound(job, ctx) {
  const { report, demos, provider, model, signal, built, assembleInput } = ctx;
  const items = report.items || [];
  const demoBad = items.find((i) => /演示|滑块|SVG/.test(i.label) && i.ok === false);
  const scriptBad = items.find((i) => /脚本错误/.test(i.label) && i.ok === false);
  if (!demoBad && !scriptBad) return false;
  if (!demos.length) return false;

  const problems = [];
  if (demoBad) problems.push(`校验探针报告：${demoBad.label} —— ${demoBad.raw || demoBad.note || '未通过'}`);
  if (scriptBad) problems.push(`页面里有脚本错误：${scriptBad.raw || ''}（很可能来自演示的 JS）`);
  problems.push('请逐条修好，并**保持 markup 里的元素 id 与 js 里取的一致**。');

  const prompts = require('./prompts');
  let changed = false;
  for (const d of demos) {
    if (isCanceled(job)) throw new CanceledError();
    try {
      // 修复时手上只有演示自己的信息（所属单元的原文不再重复喂），所以 plan 只用来做字段级校验
      const plan = { id: d.id, slider: d.title, viewBox: d.viewBox || '0 0 520 200' };
      const fixed = await askJson(job, {
        stage: 'demo',
        what: `演示 ${d.id} 的修复`,
        ctx: { outline: { units: [] }, pages: [], options: job.options },
        messages: prompts.repairMessages({ outline: { units: [] }, pages: [], options: job.options }, 'demo', problems, JSON.stringify({ id: d.id, markup: d.markup, js: d.js }), `演示 ${d.id}`),
        validate: (o) => validateDemo(o, plan),
        provider,
        model,
        signal,
        tokenPlan: ctx.tokenPlan || null,
        rounds: 1,
        maxTokens: 12000,
      });
      d.markup = fixed.markup;
      d.js = fixed.js;
      d.checks = fixed.checks;
      changed = true;
      /* ⚠️ 这里**必须**把修好的 markup/js 写回**拼装输入里那个对象**。
         以前写的是 `assembleInput.demos.find(...)` —— 而 `assembleInput` 上根本没有 `demos`
         这个字段（它只有 `chapters`），于是那一句是个 TypeError，被下面的 catch 吞成一句
         "演示 X 修复失败"；重拼用的是**没改过**的 chapters，页面上的演示一点变化都没有。
         这就是最坏的一类 bug：日志说修了、界面说修了、校验也重跑了，而**产物根本没修**。
         现在按 id 在**所有章**里找那个对象（`demos` 与 `chapters[].demos` 里是同一个引用，
         找到就直接改它；找不到说明传进来的 demos 与拼装输入不是一套，那也不该静默）。 */
      const target = (assembleInput.chapters || [])
        .reduce((acc, c) => acc.concat((c && c.demos) || []), [])
        .find((x) => x && x.id === d.id);
      if (target && target !== d) {
        target.markup = d.markup;
        target.js = d.js;
        target.checks = d.checks;
        target.sliderId = d.sliderId;
        target.viewBox = d.viewBox;
      }
      // 正文里的旧占位已经被替换过了，第二次拼装要从骨架重来——
      // 所以这里让调用方重新拼装（assembleInput 里的 lectureHtml 仍带占位注释）
      log(job, 'info', `演示 ${d.id} 已重出`);
    } catch (e) {
      log(job, 'warn', `演示 ${d.id} 修复失败：${e.message}`);
    }
  }
  return changed;
}

module.exports = {
  runGeneration, validateOutline, validateProse, validateBankShape, mapLimit, slugify,
  // 「先说好墙在哪」的唯一实现，值得单独钉住（自测直接调它，比隔着 runGeneration 好验得多）
  resolveTokenPlan, deriveOutputCap, modelForStage, modelCfgOf,
  // 用量的累加（结果页的"预估费用"靠它），单独导出便于钉住"重试那几轮也算"
  addUsage,
};
