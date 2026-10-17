'use strict';
/* 多来源：角色的定义、入参归一、以及「来源分析结论」的校验。
 *
 * 分工：**提示词住在 `prompts.js`**（这个仓库的约定——所有给模型看的话都在那一个文件里，
 * 免得改措辞时要满仓库找）。这里只管**结构**：哪些角色合法、一份结论长什么样、
 * 什么样的结论必须打回重写。
 *
 * 为什么校验要写在这里而不是塞进流水线：这些规则每一条都对应一次真实的失败，
 * 它们值得有名字、有注释、能被单独测。塞进流水线的 `if` 里，下一个人只会看到一堆条件。
 */

const { KNOWN_TYPES } = require('./bank');

const ROLES = new Set(['courseware', 'textbook', 'exercises', 'exampaper']);

/**
 * 把界面/调用方给的入参归一成 `sources[]`。
 *
 * **向后兼容是这里的一半职责**：老调用只给 `input.filePath`（`test/e2e-mock.js`
 * 与 `test/auditors.js` 都直接 `createJob({filePath})`，连 IPC 都不走），
 * 那种调用要退化成"只有一份课件"，行为与从前完全一致。
 *
 * 出错时**抛错**而不是静默填默认值：角色写错、没给路径这类事必须当场说出来。
 * 调用方（IPC）把它转成 `BAD_ARG` 信封；默认值会让人以为配置生效了。
 */
function normalizeSources(input) {
  const raw = input && Array.isArray(input.sources) ? input.sources : null;

  if (raw && raw.length) {
    return raw.map((s, i) => {
      const at = `第 ${i + 1} 份来源`;
      const role = String((s && s.role) || '');
      if (!ROLES.has(role)) {
        throw new Error(`${at}的角色「${role || '没填'}」不认识——只认 ${[...ROLES].join(' / ')}`);
      }
      const filePath = String((s && s.filePath) || '');
      if (!filePath) throw new Error(`${at}没有给出文件路径`);
      return {
        id: String((s && s.id) || 's' + (i + 1)),
        role,
        filePath,
        fileName: String((s && s.fileName) || ''),
        label: String((s && s.label) || ''),
        scope: (s && s.scope) || null,
        /* 「这份材料属于第几章」。**与 role 是两个独立维度**：第 13 章的课本 + 课件是同一章的
           两份来源，而第 13 章与第 14 章是两章。留空 = "跟着 `options.chapterNo` 走"，
           全空时整份产出就是唯一的一章（老路径）。
           ⚠️ 这两个字段**必须原样带下去**：分组发生在流水线里（`pipeline/chapters.js`），
           中间任何一层把它们丢了，多章就会静默退化成"所有材料挤成一章"。 */
        chapterNo: String((s && s.chapterNo) || '').trim(),
        chapterTitle: String((s && s.chapterTitle) || '').trim(),
      };
    });
  }

  if (input && typeof input.filePath === 'string' && input.filePath) {
    return [{
      id: 's1', role: 'courseware', filePath: input.filePath,
      fileName: '', label: '', scope: null, chapterNo: '', chapterTitle: '',
    }];
  }
  return [];
}

/** 递归收集对象里的所有字符串值（跳过 sourceId/role —— 那两个是回填字段，不是内容）。 */
function collectStrings(obj, out, depth) {
  const acc = out || [];
  if (depth > 6 || obj == null) return acc;
  if (typeof obj === 'string') { acc.push(obj); return acc; }
  if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, acc, (depth || 0) + 1);
    return acc;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === 'sourceId' || k === 'role') continue;
      collectStrings(obj[k], acc, (depth || 0) + 1);
    }
  }
  return acc;
}

/**
 * 这份结论里有没有**整段抄自材料原文**的字符串？
 *
 * 为什么要有这条机器判据：真题那一步的规矩是"只提炼规律，不摘抄原题"，
 * 而这句话写在提示词里是**没有牙齿的**——模型完全可能把整道大题连题干带选项贴进 `summary`，
 * 而 JSON 依旧合法、后面每一步都照常跑。用户以为拿到的是仿题，其实页面里是真题原文。
 *
 * 判据取 200 字以上、且在材料正文里**逐字命中前 120 字**的字符串。
 * 用前 120 字做探针而不是整串：模型往往会顺手改个标点或去个空格，
 * 整串比对会被这种无关紧要的改动绕过。
 */
function findCopiedText(note, pages) {
  const hay = (pages || []).map((p) => (p && p.text) || '').join('\n');
  if (!hay) return '';
  for (const s of collectStrings(note)) {
    if (typeof s !== 'string' || s.length < 200) continue;
    if (hay.includes(s.slice(0, 120))) return s;
  }
  return '';
}

/**
 * 校验一份来源分析结论。返回**问题列表**（空数组＝通过）。
 * 返回列表而不是抛错：调用方要把这些问题**回灌给模型**让它重写，所以它们得是文字。
 */
function validateSourceNote(note, src, pages) {
  const bad = [];
  if (!note || typeof note !== 'object' || Array.isArray(note)) return ['返回的不是一个 JSON 对象'];

  /* ⚠️ 回填字段必须对得上。不查会怎样：模型在分析"课本"那一份时，
     顺手写成了上一次调用里的 sourceId —— 于是这份结论被挂到**另一份来源**头上，
     后面的融合拿错材料还不知道。这与 repairMessages 里"重申 uid"是同一类教训。 */
  if (String(note.sourceId == null ? '' : note.sourceId) !== src.id) {
    bad.push(`sourceId 必须原样回填 "${src.id}"，你写的是 "${note.sourceId}"`);
  }
  if (String(note.role == null ? '' : note.role) !== src.role) {
    bad.push(`role 必须原样回填 "${src.role}"，你写的是 "${note.role}"`);
  }
  if (!note.summary || !String(note.summary).trim()) bad.push('summary 不能为空——用一句话说清这份材料是什么、覆盖什么');

  if (src.role === 'exampaper') {
    const qt = Array.isArray(note.questionTypes) ? note.questionTypes : [];
    if (!qt.length) bad.push('历年真题必须给出 questionTypes —— 这份卷子由哪些题型构成');
    qt.forEach((q, i) => {
      if (!q || !q.shape) { bad.push(`questionTypes[${i}] 缺 shape（这一题型长什么样）`); return; }
      if (!KNOWN_TYPES.has(q.mapped)) {
        bad.push(`questionTypes[${i}].mapped 是「${q.mapped}」，不是四种题型之一`
          + '（single 单选 / multi 多选 / num 填数值 / big 综合大题）。'
          + '判断题请映射成两个选项的 single，填空题用 num，简答与计算用 big。');
      }
    });
  }

  const copied = findCopiedText(note, pages);
  if (copied) {
    bad.push(`疑似摘抄了材料原文（有一段 ${copied.length} 字的内容在材料里逐字出现）。`
      + '这里只要**结论与规律**（讲了哪些知识点、什么题型、常考什么），不要把原文贴进来。');
  }

  return bad;
}

/* 一份结论会进后面每一次调用（每个单元两次起步），所以必须封顶。
   超了就砍最长的那些数组，而不是砍 summary —— summary 是信息密度最高的那一段。 */
const NOTE_MAX_CHARS = 2500;

function trimNote(note) {
  if (!note || typeof note !== 'object') return note;
  const out = Object.assign({}, note);
  const size = () => JSON.stringify(out).length;
  const trim = (key, keep) => {
    if (Array.isArray(out[key]) && out[key].length > keep) out[key] = out[key].slice(0, keep);
  };
  for (const [k, keep] of [['outline', 6], ['terms', 15], ['formulas', 8], ['constants', 8], ['questionTypes', 10], ['warnings', 3]]) {
    if (size() <= NOTE_MAX_CHARS) break;
    trim(k, keep);
  }
  if (size() > NOTE_MAX_CHARS && typeof out.summary === 'string') {
    out.summary = out.summary.slice(0, 300);
  }
  return out;
}

/**
 * 这份来源实际该用哪几页。
 *
 * 课本整本塞不进任何模型的上下文（几百页），所以按**一章/一节**给——用户填了页码范围就只取那一段。
 * 没填 scope、或填了但两头都是空的，就返回全部页（课件/习题/真题的正常路径）。
 * 取不到的边界情况一律返回全部页而不是空数组：**宁可多给，也不要静默把材料变成空的**。
 */
function scopePages(pages, scope) {
  const list = pages || [];
  if (!scope) return list;
  const from = Number(scope.pageFrom) || 0;
  const to = Number(scope.pageTo) || 0;
  if (!from && !to) return list;
  const out = list.filter((p) => (from ? p.index >= from : true) && (to ? p.index <= to : true));
  return out.length ? out : list;
}

module.exports = { ROLES, normalizeSources, validateSourceNote, trimNote, findCopiedText, scopePages };
