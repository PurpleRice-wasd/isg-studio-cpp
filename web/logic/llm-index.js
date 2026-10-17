'use strict';

/**
 * 大模型接入层 · 统一入口（架构文档 §3.3 契约）
 * ---------------------------------------------------------------------------
 * 对外：
 *   await chat({ provider, model, system, messages, temperature, maxTokens,
 *                json, onDelta, signal, stream, timeoutMs, retryDelays, onRetry })
 *     -> { text, usage:{ in, out, reported }, raw, data?, jsonError?, degraded, ms }
 *   await testConnection(providerCfg, { timeoutMs })
 *     -> { ok, models?, error?, latencyMs }
 *
 * 自测用辅助（导出）：joinUrl / parseJsonLoose / maskKey / anySignal / backoffDelay
 *
 * 职责划分（不引入任何第三方依赖，只用内置 fetch / AbortController / TextDecoder）：
 *   本文件  = HTTP 传输、超时、重试退避、SSE 分帧、错误归一化、JSON 容错解析、key 打码
 *   openai.js / anthropic.js = 协议差异（URL 归一化、请求头、请求体、流事件、响应解析）
 *
 * 依赖方向： index.js -> openai.js, anthropic.js, ../providers.js ； anthropic.js -> openai.js
 *          （无环）
 */

const { getPreset } = require('../providers');
const openai = require('./openai');
const anthropic = require('./anthropic');

const ADAPTERS = { openai, anthropic };

/** 单次请求默认超时（180s，架构 §6 的"不许卡死 UI"） */
const DEFAULT_TIMEOUT_MS = 180_000;
/** 测试连接的超时（10s，必须短） */
const TEST_TIMEOUT_MS = 10_000;
/** 指数退避重试延迟：最多重试 3 次 */
const RETRY_DELAYS = [1000, 3000, 9000];
/** 抖动比例 ±20% */
const JITTER_RATIO = 0.2;
/** 值得重试的 HTTP 状态（529 = Anthropic 的 overloaded，属于同一类瞬时故障） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
/** 429 带 Retry-After 时的等待上限 */
const MAX_RETRY_AFTER_MS = 30_000;
/** 错误体保留上限（进 UI / 日志） */
const MAX_ERROR_BODY_CHARS = 4000;
/* 一个"被切断事件"最多攒多少字节（多行拼接后的 pending）。
   ⚠️ 注意它**不是**单行上限 —— 单行的上限是下面的 MAX_LINE_CHARS。
   这条注释以前写成"SSE 单行缓冲上限"，与实际作用范围不符。 */
const MAX_PENDING_SSE_CHARS = 1 << 20;
/** 未出现换行符的累计字节上限：超过就丢弃并计数，防止"永不发换行"的响应撑爆内存 */
const MAX_LINE_CHARS = 4 << 20;
/* 一个被切断的 SSE 事件最多攒几行。
   以前只有字节上限（1MB），于是一条坏行能把后面所有事件拖着走很久；
   4 行足够覆盖真实的多行 JSON（服务端按 TCP 分片最多切出两三行），
   同时保证坏 pending 不会变成雪球。 */
const MAX_PENDING_SSE_LINES = 4;
/** 流式事件保留上限（raw.events） */
const MAX_STREAM_EVENTS = 20_000;
/** 解析失败时回灌给模型的原文前后片段长度 */
const RAW_PREVIEW_CHARS = 200;
/** 这些网络错误码重试也没用（端口没人监听 / URL 就是错的） */
const FATAL_NET_CODES = new Set(['ECONNREFUSED', 'ERR_INVALID_URL', 'ERR_UNESCAPED_CHARACTERS']);

// ---------------------------------------------------------------------------
// 错误对象
// ---------------------------------------------------------------------------

/**
 * 归一化后的错误。契约要求带 { status, providerMessage, retryable, url }。
 */
class LlmError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = opts.status == null ? null : opts.status;
    this.providerMessage = opts.providerMessage || '';
    this.retryable = !!opts.retryable;
    this.url = opts.url || '';
    this.code = opts.code || null;
    this.body = opts.body || '';
    this.retryAfterMs = opts.retryAfterMs || 0;
    this.attempts = opts.attempts || 1;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
  /** 给人看的一行摘要（不含 key）。带上 HTTP 状态，但优先说人话。 */
  get summary() {
    if (this.status) {
      return this.providerMessage ? `HTTP ${this.status} · ${this.providerMessage}` : `HTTP ${this.status}`;
    }
    return this.providerMessage || this.message;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * API Key 打码：只留前 4 后 4。长度 <= 8 时全遮（否则等于没遮）。
 */
function maskKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  if (!s) return '(未设置)';
  /* 短 Key **整体遮住**：以前是 `length <= 8` 才全遮，于是 9 个字符的 Key 会显示成
     `abcd…fghi` —— 9 个里露出 8 个，等于没遮。而短 token 在自定义网关/本机网关上并不罕见。
     16 是常见的真实 Key 长度下限（`sk-` + 十几个字符），比它短的一律不给任何提示。 */
  if (s.length < 16) return '********';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * 造一个"把 key 洗掉"的函数。任何要进 UI / 日志 / 错误信息的字符串都要过它。
 * 除了精确匹配真实 key，还兜底拦 sk-xxx / Bearer xxx 形态。
 */
function makeScrubber(apiKey) {
  const k = typeof apiKey === 'string' ? apiKey.trim() : '';
  const masked = maskKey(k);
  const looksLikeKey = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;
  return (input) => {
    if (typeof input !== 'string' || !input) return input || '';
    let out = input;
    /* 门槛从 6 降到 4：短 Key 以前**一次都不替换**，于是它会原样出现在
       `job.error.message` 里（进而进 UI 与落盘历史）。代价是"4 个字符的串"可能误伤正文，
       但那只是显示难看；漏 Key 是实打实的损失。*/
    if (k.length >= 4) out = out.split(k).join(masked);
    out = out.replace(looksLikeKey, (m) =>
      m.startsWith('Bearer') ? `Bearer ${maskKey(m.slice(7).trim())}` : maskKey(m)
    );
    return out;
  };
}

/**
 * 把多个 AbortSignal 合成一个。任一 abort，合成信号 abort。
 * 优先用内置 AbortSignal.any（Node 20.3+），否则手动合并。
 */
function anySignal(signals) {
  const list = (Array.isArray(signals) ? signals : [signals]).filter(
    (s) => s && typeof s.addEventListener === 'function'
  );
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const ctrl = new AbortController();
  const onAbort = (ev) => {
    cleanup();
    const target = ev && 'target' in ev ? ev.target : ev;
    ctrl.abort(target && target.reason !== undefined ? target.reason : undefined);
  };
  const cleanup = () => {
    for (const s of list) s.removeEventListener('abort', onAbort);
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort(s);
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
}

/** 第 attempt 次重试（0 起）要等多久；rand 注入便于测试。 */
function backoffDelay(attempt, rand = Math.random, delays = RETRY_DELAYS) {
  const base = delays[Math.min(attempt, delays.length - 1)] || delays[delays.length - 1] || 1000;
  const jitter = 1 + (rand() * 2 - 1) * JITTER_RATIO;
  return Math.max(0, Math.round(base * jitter));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortErr = () =>
      new LlmError('请求已取消', { code: 'EABORTED', retryable: false });
    if (signal && signal.aborted) return reject(abortErr());
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function cleanup() {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      clearTimeout(timer);
      cleanup();
      reject(abortErr());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 本机端点（Ollama / LM Studio）：允许没有 API Key */
function isLocalBase(baseUrl) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:\d+)?(\/|$)/i.test(
    String(baseUrl || '').trim()
  );
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

// ---------------------------------------------------------------------------
// 错误归一化
// ---------------------------------------------------------------------------

/**
 * 从响应体里尽力抠出人话。两家的错误结构不同（还有各种网关），全部兜一遍：
 *   OpenAI      { error: { message, type, code } }
 *   Anthropic   { type:'error', error: { type, message } }
 *   杂牌网关     { message } / { msg } / { detail } / { error: "字符串" } / HTML
 */
function extractProviderMessage(parsed, rawText) {
  if (isPlainObject(parsed)) {
    const candidates = [
      isPlainObject(parsed.error) ? parsed.error.message : null,
      isPlainObject(parsed.error) && isPlainObject(parsed.error.error) ? parsed.error.error.message : null,
      isPlainObject(parsed.error) ? parsed.error.msg : null,
      typeof parsed.error === 'string' ? parsed.error : null,
      parsed.message,
      parsed.msg,
      typeof parsed.detail === 'string' ? parsed.detail : null,
      parsed.error_description,
      isPlainObject(parsed.response) && isPlainObject(parsed.response.error)
        ? parsed.response.error.message
        : null,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return truncate(c.trim(), 600);
    }
    // 结构陌生：别把信息丢了，序列化出来
    for (const key of ['error', 'detail']) {
      if (parsed[key] && typeof parsed[key] === 'object') {
        try {
          const s = JSON.stringify(parsed[key]);
          if (s && s !== '{}' && s.length <= 600) return s;
        } catch {
          /* 循环引用等，忽略 */
        }
      }
    }
  }
  const plain = String(rawText || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(plain, 400);
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 同 parseMaybeJson，但**把"成没成"单独带出来**。
 *
 * 为什么必须要它：`JSON.parse('null')`、`JSON.parse('0')`、`JSON.parse('""')` 都是**合法**的，
 * 结果却是假值。用 `if (!obj)` 判断"解析失败"会把它们一起误判——
 * 流式解析里这个误判的代价是**整条流被静默吞掉**（见 handleData 的说明）。
 */
function parseJsonChecked(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, value: null };
  }
}

function parseRetryAfter(res) {
  const h = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(h);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return 0;
}

async function buildHttpError(res, { url, scrub }) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* 读不出来就算了 */
  }
  const providerMessage = scrub(extractProviderMessage(parseMaybeJson(text), text));
  const status = res.status;
  /* 429 要分开看：**限流**该重试，**余额/配额耗尽**重试一万次也没用。
     以前只看状态码，于是"欠费"会被退避重试 4 次（~13s），
     而且上层的 askJson 还会把整个调用再重来若干轮 —— 一个注定失败的阶段能耗掉十几次请求。
     判据是错误体里的关键词（两家措辞不同，涵盖中英文）。 */
  const quotaExhausted =
    status === 429 &&
    /insufficient_quota|quota|credit balance|billing|exceeded your current quota|余额|欠费|配额|充值/i.test(
      String(providerMessage || '')
    );
  const retryable = RETRYABLE_STATUS.has(status) && !quotaExhausted;
  const label = status === 401 || status === 403 ? '鉴权失败' : status === 404 ? '端点不存在' : '请求被拒绝';
  const message = scrub(
    `HTTP ${status}（${label}）${providerMessage ? `：${providerMessage}` : ''}`
  );
  return new LlmError(message, {
    status,
    providerMessage,
    retryable,
    /* url 也要洗（与 buildNetworkError 同理）：authField:'query' 时 Key 就在查询串里，
       而 err.url 会随 err 一起进任务日志与落盘历史。scrub 对不含 Key 的 URL 是恒等变换。 */
    url: typeof scrub === 'function' ? scrub(url) : url,
    code: 'EHTTP',
    body: scrub(truncate(text, MAX_ERROR_BODY_CHARS)),
    retryAfterMs: parseRetryAfter(res),
  });
}

function buildNetworkError(err, { url, timeoutMs, externalSignal, scrub }) {
  /* ⚠️ url 也必须过 scrubber。
     它是**唯一**没洗过的字段，而 Key 完全可以写在 Base URL 的 userinfo 里
     （`https://sk-xxx@gateway/v1`）—— 那种配置下 `JSON.stringify(err)` 会带上明文 Key。
     当前 jobs.fail() 只把 message+stack 交给界面，所以暂时漏不出去；
     但只要将来有人把 err 整体序列化或打进日志，Key 就出去了。这条注释就是那道提醒。 */
  const safeUrl = typeof scrub === 'function' ? scrub(url) : url;
  if (externalSignal && externalSignal.aborted) {
    return new LlmError('请求已取消', {
      code: 'EABORTED',
      retryable: false,
      url: safeUrl,
      cause: err,
    });
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    // 超时/中止不重试：180s × 4 次会把 UI 卡死；由调用方决定是否重开
    // ⚠️ 报出来的秒数必须是**用户实际配的**那个。曾经这里一律写 180 秒
    //    （调用方传 timeoutMs: 0，被 `|| DEFAULT_TIMEOUT_MS` 兜到 180000），
    //    用户配了 30s 却看到"180 秒无响应"，排查时会被带到错的地方去。
    const ms = timeoutMs || DEFAULT_TIMEOUT_MS;
    const pretty = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`;
    return new LlmError(`请求超时（${pretty}无响应）`, {
      code: 'ETIMEOUT',
      retryable: false,
      url: safeUrl,
      cause: err,
    });
  }
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const detail = scrub((err && err.message) || String(err));
  return new LlmError(`网络请求失败：${detail}${code ? `（${code}）` : ''}`, {
    code: code || 'ENETWORK',
    retryable: !FATAL_NET_CODES.has(code),
    url: safeUrl,
    cause: err,
  });
}

// ---------------------------------------------------------------------------
// JSON 容错解析
// ---------------------------------------------------------------------------

/** 剥 ``` 围栏：优先取第一个围栏块的内容；围栏没闭合（流被截断）也尽量取。 */
function stripCodeFence(src) {
  const s = String(src);
  if (!s.includes('```')) return s;
  /* 只认"围栏**包住整段**"这种形态：整段以 ``` 开头。
     以前是"在整段里找第一对 ```"，于是正文中间出现围栏（代码/公式示例）时会把
     两段文字之间的内容当 JSON —— 要么解析失败，要么**解析出毫不相干的东西**。
     （`parseJsonLoose` 现在已经先试原文，这里是第二道。） */
  if (!/^\s*```/.test(s)) return s;
  const closed = s.match(/^\s*```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*?)```[ \t]*$/);
  if (closed && closed[1] !== undefined) return closed[1];
  const open = s.match(/```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n?([\s\S]*)$/);
  if (open && open[1] !== undefined) return open[1];
  return s;
}

/** 从首个 { 或 [ 截到与之配对（考虑字符串与转义）的收尾。找不到返回 null。 */
function sliceBalanced(src) {
  const s = String(src);
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 去尾逗号（等价于 /,\s*[}\]]/，但跳过字符串内部，避免"a,}b"这种内容被误伤） */
function stripTrailingCommas(src) {
  const s = String(src);
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // 丢掉这个逗号
    }
    out += ch;
  }
  return out;
}

/**
 * 容错解析模型吐出的 JSON。步骤（架构 §3.3）：
 *   剥 ```json 围栏 → 截取首个 { / [ 到配对的收尾 → 去尾逗号 → JSON.parse
 * 失败时抛错，并带上原文前、后各 200 字（上层可原样回灌给模型）。
 */
function parseJsonLoose(text) {
  const original = String(text == null ? '' : text);
  const steps = [];

  /* ⚠️ ① 先试**原文**，严格解析成功就直接返回。
     这一步是后加的，但它是最重要的一步：以前**无条件**先剥围栏，于是
     "合法 JSON 里某个字符串值本身含 ``` 围栏"会被改坏 —— 而本应用生成的正是
     含代码块/公式示例的 HTML，属于高频形态。实测（test/_audit/v8/f-json.js）：
       {"blocks":[{"html":"<pre><code>```c\nint main(){}\n```</code></pre>"}]}
     原文完全合法，剥围栏之后返回的却是一个**空对象 {}** ——
     上层拿到的是错数据，而它未必通不过后面的校验（比直接报错更危险）。 */
  try {
    return JSON.parse(original.trim());
  } catch (e) {
    /* 原文不是合法 JSON，落回下面的宽松解析 */
  }

  try {
    let s = stripCodeFence(original);
    steps.push('剥围栏');
    const balanced = sliceBalanced(s);
    if (balanced != null) {
      s = balanced;
      steps.push('截取括号范围');
    }
    s = stripTrailingCommas(s);
    steps.push('去尾逗号');
    const value = JSON.parse(s.trim());
    return value;
  } catch (err) {
    // 前后各取 RAW_PREVIEW_CHARS 个字符（不加省略号，长度严格等于 RAW_PREVIEW_CHARS，
    // 上层可以直接拿去做回灌提示词，不用担心多一个字符）
    const head = original.slice(0, RAW_PREVIEW_CHARS);
    const tail = original.length > RAW_PREVIEW_CHARS ? original.slice(-RAW_PREVIEW_CHARS) : '';
    const e = new Error(
      `JSON 解析失败：${err.message}\n` +
        `--- 模型原文开头（≤${RAW_PREVIEW_CHARS} 字）---\n${head}\n` +
        `--- 模型原文结尾（≤${RAW_PREVIEW_CHARS} 字）---\n${tail}`
    );
    e.name = 'JsonParseError';
    e.code = 'EJSONPARSE';
    e.raw = original;
    e.head = head;
    e.tail = tail;
    e.steps = steps;
    e.cause = err;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function fetchOnce({ url, method, headers, body, timeoutMs, signal, scrub }) {
  const timeoutSignal =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const combined = anySignal([timeoutSignal, signal]);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: combined,
      redirect: 'follow',
    });
  } catch (err) {
    throw buildNetworkError(err, { url, timeoutMs, externalSignal: signal, scrub });
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * 逐行消费 SSE 流。
 * - 用 buffer 按 '\n' 切，切不出完整行的尾巴留在 buffer 里跨 chunk 拼接（半行保护）
 * - 支持 `data: x` / `data:x` / `[DONE]` / `: comment`
 * - 单行 JSON 解析失败时，先当"被拆成多行 data: 的同一个事件"合并重试
 * 返回 { text, reasoning, usage, finishReason, events, skipped }
 */
async function consumeSse(res, { onDelta, adapter, scrub, signal, ndjson, timeoutMs }) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    throw new LlmError('响应没有可读的流（该端点可能不支持 stream:true）', {
      code: 'ENOSTREAM',
      retryable: false,
      /* res.url 是 fetch 记下的**最终请求地址**，authField:'query' 时它带着 Key，
         而这里的错误会进任务日志 —— 必须洗（scrub 对无 Key 的 URL 是恒等变换）。 */
      url: scrub(res.url),
    });
  }
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pending = '';
  let pendingLines = 0; // 已经为「同一个被切断的事件」攒了几行（见 handleData 的说明）
  let text = '';
  let reasoning = '';
  const usage = { in: 0, out: 0, reported: false };
  let finishReason = null;
  let done = false;
  const events = [];
  let skipped = 0;

  const applyEvent = (obj) => {
    if (events.length < MAX_STREAM_EVENTS) events.push(obj);
    const errText = adapter.streamError ? adapter.streamError(obj) : null;
    if (errText) {
      throw new LlmError(scrub(`模型流内错误：${errText}`), {
        code: 'ESTREAM',
        retryable: false,
        url: scrub(res.url), // 同 ENOSTREAM：res.url 可能带着查询串里的 Key
        providerMessage: scrub(errText),
      });
    }
    const ev = adapter.parseStreamEvent(obj);
    if (!ev) return;
    if (ev.delta) {
      text += ev.delta;
      if (typeof onDelta === 'function') onDelta(ev.delta);
    }
    if (ev.reasoning) reasoning += ev.reasoning;
    if (ev.usage) {
      if (Number.isFinite(ev.usage.in)) usage.in = ev.usage.in;
      if (Number.isFinite(ev.usage.out)) usage.out = ev.usage.out;
      usage.reported = true;
    }
    if (ev.finishReason) finishReason = ev.finishReason;
  };

  const handleData = (rawPayload) => {
    const payload = rawPayload.trim();
    if (!payload) return;
    if (pending === '' && (payload === '[DONE]' || payload === 'DONE')) {
      done = true;
      return;
    }
    const joined = pending ? pending + payload : payload;
    const got = parseJsonChecked(joined);

    if (!got.ok) {
      /* ⚠️ 这一段修过一个「整条流被静默吞掉」的 bug。旧写法是：
           const obj = parseMaybeJson(candidate); if (!obj) { pending = candidate; return; }
         三个问题叠在一起：
           ① `JSON.parse('null' | '0' | '""')` 是**合法**结果（假值），却被 `!obj` 当成解析失败；
           ② 只要有一行进了 pending，**后面每一条正常事件都会被拼进这个坏串**（pending + payload）
              继续失败 —— 于是后续所有 delta、finish_reason、[DONE] 全部丢失；
           ③ 要累计到 1MB 才清空，而 `skippedEvents` 全仓没有任何调用方读它。
         症状是：模型答到一半就没了，没有异常、没有 finish_reason，**看起来像模型的问题**。
         （实测复现见 test/_audit/v8/b-sse.js：一条 `data: 0` 保活行之后，3 条正常事件全被吞。）
         现在的规则：
           · 上一轮攒了 pending 时，先把**这一行单独**试一次 —— 坏的 pending 拖不垮后面的流；
           · 只有"看起来就是一段被切断的 JSON"（以 { 或 [ 开头）才继续攒；
           · 最多攒 4 行（MAX_PENDING_SSE_LINES），不会再出现 1MB 级的雪球。 */
      /* ⚠️ 只有**单独解析出对象**才算"这条是真事件、前面攒的是坏 pending"。
         曾经写成 `if (solo.ok)` —— 只要本行单独能解析就清掉 pending，于是
         「一条被切成 ≥3 段的 JSON，而中间那一段本身恰好是个合法标量」会把**整条事件丢掉**：
            data: {"choices":[{"delta":{"content:     ← 攒成 pending
            data: 12                                  ← 单独能 parse（标量）→ 清空 pending ✗
            data: 34}}]}                              ← 单独 parse 不了 → 也丢
         实测（本仓 test/_audit/v8/b-sse.js 的三段用例）：text 变成空串，skipped 只记 2。
         旧写法（每行都往 pending 上拼）在三段情形下反而能拼成合法 JSON —— 也就是说这是
         "修上一版 bug 时引入的回归"。标量一律**不**走这条捷径，落回下面的继续攒。 */
      if (pending) {
        const solo = parseJsonChecked(payload);
        if (solo.ok && solo.value && typeof solo.value === 'object') {
          pending = '';
          pendingLines = 0;
          applyEvent(solo.value);
          return;
        }
      }
      const canGrow =
        !done &&
        pendingLines < MAX_PENDING_SSE_LINES &&
        joined.length < MAX_PENDING_SSE_CHARS &&
        /^[[{]/.test(joined);
      if (canGrow) {
        pending = joined;
        pendingLines++;
        return;
      }
      skipped++;
      pending = '';
      pendingLines = 0;
      return;
    }

    pending = '';
    pendingLines = 0;
    // 标量不是事件（`data: 0` 这类保活行）——解析成功但没内容，跳过，不喂给 applyEvent
    if (!got.value || typeof got.value !== 'object') {
      skipped++;
      return;
    }
    applyEvent(got.value);
  };

  const handleLine = (line) => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!clean || clean.startsWith(':')) return; // 空行 / 注释 / keep-alive
    if (!clean.startsWith('data:')) {
      /* ndjson：一行一条**裸 JSON**，没有 `data:` 前缀。
         ⚠️ 这一支以前是缺的：`chat()` 把 `application/x-ndjson` 列进了 content-type 白名单
         （当时那行的意图是"这是流、别当一次性 JSON 读"），但下面的解析只认 `data:` 前缀，
         于是 ndjson 网关的**每一个正常事件都被丢掉** → 每次调用 text 都是 `""`，
         而上层 explainEmptyText 会把它当成"模型返回了空正文"，去怀疑推理型模型吃光了输出预算、
         甚至把 maxTokens 一路抬到 64000 —— 真原因（网关格式）永远查不出来。
         只收 `{` / `[` 开头的行，不会把 SSE 的 event:/id:/retry: 误当数据。 */
      if (ndjson && /^[[{]/.test(clean)) handleData(clean);
      return;
    }
    handleData(clean.slice(5));
  };

  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      /* 单行缓冲的上限。
         ⚠️ `MAX_PENDING_SSE_CHARS` 的注释一直写着"SSE **单行**缓冲上限"，但它实际只作用在
         `pending`（被切断事件的多行拼接）上，`buffer` 本身没有任何上限 ——
         一个**永远不发换行**的响应能让它一直涨下去。正常流里一条 delta 只有几十字节，
         4MB 已经远超任何合理单行，触到就说明对端在发畸形东西。 */
      if (buffer.length > MAX_LINE_CHARS) {
        skipped++;
        buffer = '';
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) {
      buffer += decoder.decode(); // flush 掉解码器里剩下的半个多字节字符
      if (buffer.length) handleLine(buffer); // 最后一段（没有换行结尾）别丢
      if (pending) {
        const got = parseJsonChecked(pending);
        pending = '';
        pendingLines = 0;
        // 用 parseJsonChecked 而不是 `if (obj)`：`JSON.parse('null')` 这种合法假值不该被当成失败
        if (got.ok && got.value && typeof got.value === 'object') applyEvent(got.value);
        else skipped++;
      }
    }
  } catch (err) {
    if (err instanceof LlmError) throw err;
    // buildNetworkError 内部会洗 url（res.url 可能带查询串里的 Key）
    throw buildNetworkError(err, { url: res.url, timeoutMs, externalSignal: signal, scrub });
  } finally {
    try {
      if (typeof reader.cancel === 'function') await reader.cancel();
    } catch {
      /* 关流失败无所谓 */
    }
  }

  return { text, reasoning, usage, finishReason, events, skipped };
}

// ---------------------------------------------------------------------------
// 适配器解析
// ---------------------------------------------------------------------------

function resolveFormat(provider) {
  if (provider && (provider.format === 'openai' || provider.format === 'anthropic')) {
    return provider.format;
  }
  const preset = provider && provider.id ? getPreset(provider.id) : null;
  if (preset && (preset.format === 'openai' || preset.format === 'anthropic')) {
    return preset.format;
  }
  return 'openai'; // 大多数兼容端点是 OpenAI 形态
}

/**
 * 把"用户配的那些请求覆盖项"（fullUrl / authField / userAgent / proxyHeader / proxyBody）
 * 落到真正要发出去的那份 url / headers / body 上。
 *
 * 为什么必须收成一个函数、并且 chat 与 testConnection **共用**：
 * 只在 chat 里生效时的症状正是这个仓库最讨厌的假修复 ——
 * 「测试连接」能过（它自己拼了一套请求），真生成却过不了（另一套）。
 * 反过来也一样：如果只在测试连接里生效，用户会看到"配置没问题"而任务一直失败。
 *
 * warn(field, message) 可选，用来把"这段覆盖没生效"告诉上层；它**只**收到字段名与
 * 固定措辞，绝不带上覆盖内容（那里面可能有 Key）。
 */
function buildRequest(adapter, provider, o) {
  const headers = adapter.buildHeaders(provider, { warn: o.warn });
  const url = adapter.chatUrl(provider.baseUrl, { fullUrl: provider.fullUrl === true });
  const body = adapter.buildBody({
    model: o.model,
    system: o.system,
    messages: o.messages,
    temperature: o.temperature,
    maxTokens: o.maxTokens,
    json: o.json,
    stream: o.stream,
  });
  return {
    // authField:'query' 时 Key 就在这个 URL 上 —— 之后凡是要进日志/错误的副本都得先洗（safeUrl）
    url: openai.withQueryAuth(url, provider),
    headers,
    body: openai.applyProxyBody(body, provider, o.warn),
  };
}

function assertProvider(provider) {
  if (!isPlainObject(provider)) {
    throw new LlmError('provider 参数缺失（需要 { id, format, baseUrl, apiKey }）', {
      code: 'ECONFIG',
      retryable: false,
    });
  }
  if (!provider.baseUrl || !String(provider.baseUrl).trim()) {
    throw new LlmError('未配置 Base URL', { code: 'ECONFIG', retryable: false });
  }
  if (!provider.apiKey && !isLocalBase(provider.baseUrl)) {
    throw new LlmError('未配置 API Key', { code: 'ECONFIG', retryable: false });
  }
}

// ---------------------------------------------------------------------------
// chat()
// ---------------------------------------------------------------------------

/**
 * 统一对话入口。
 *
 * @param {object}  o
 * @param {object}  o.provider     { id, format, baseUrl, apiKey }
 *   可选（1.4.0 起设置页会带过来，全部**真的**作用到请求上，见 buildRequest）：
 *   `fullUrl` / `authField` / `userAgent` / `proxyHeader` / `proxyBody`
 * @param {string}  o.model
 * @param {string} [o.system]
 * @param {Array}   o.messages     [{ role:'user'|'assistant', content:string }]
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {boolean}[o.json]        true = 要求 JSON 输出（OpenAI 侧带 response_format）
 * @param {Function}[o.onDelta]    流式增量回调 (text) => void
 * @param {AbortSignal}[o.signal]  外部取消信号
 * @param {boolean}[o.stream]      默认：给了 onDelta 就流式
 * @param {number} [o.timeoutMs]   默认 180s
 * @param {number[]}[o.retryDelays] 默认 [1000,3000,9000]
 * @param {Function}[o.onRetry]    ({ attempt, delayMs, error }) => void
 * @returns {Promise<{text, usage, raw, data?, jsonError?, degraded, ms}>}
 *   注意：json:true 时解析失败**不抛错**——`data` 为 undefined、`jsonError` 带原文，
 *   便于 pipeline 的 repair 阶段原样回灌给模型（架构 §6.4 不吞异常）。
 */
async function chat(o = {}) {
  const {
    provider,
    model,
    system,
    messages,
    temperature,
    maxTokens,
    json = false,
    onDelta,
    signal,
    stream,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryDelays = RETRY_DELAYS,
    onRetry,
  } = o;

  assertProvider(provider);
  if (!model || !String(model).trim()) {
    throw new LlmError('未指定模型 ID', { code: 'ECONFIG', retryable: false });
  }

  const adapter = ADAPTERS[resolveFormat(provider)];
  const scrub = makeScrubber(provider.apiKey);
  const useStream = stream === undefined ? typeof onDelta === 'function' : !!stream;
  const norm = adapter.normalizeMessages({ system, messages });
  const wantJson = !!json && !!adapter.supportsJsonMode(provider, model);

  const degraded = [];
  /* 覆盖项写坏了（JSON 语法错）不当成致命错误：它是"锦上添花"的配置，
     为了它把整个生成任务打死不值得。但**必须留下痕迹**，否则用户会以为
     自己的覆盖生效了 —— degraded 进调用结果，控制台给"任务日志之外"的排查留一份。 */
  const warnConfig = (field, message) => {
    degraded.push({ field, label: message });
    console.warn(`[llm] ${message}`);
  };

  const req = buildRequest(adapter, provider, {
    model: String(model).trim(),
    system: norm.system,
    messages: norm.messages,
    temperature,
    maxTokens,
    json: wantJson,
    stream: useStream,
    warn: warnConfig,
  });
  const url = req.url;
  const headers = req.headers;
  /* ⚠️ 进错误 / 回调 / 日志的那一份 URL 必须是**洗过**的：
     authField:'query' 把 Key 拼在查询串里，而 err.url、onRetry 的 url 都会被上层写进
     任务日志（界面 + 落盘历史）。不洗就等于"设置页勾了 Key 放查询串，Key 就跟着报错文案到处跑"。
     scrub 对不含 Key 的 URL 是恒等变换，所以既有配置的报文一个字都不会变。 */
  const safeUrl = scrub(url);

  let body = req.body;
  const triedFixes = new Set();
  const maxRetries = Number.isFinite(o.maxRetries) ? o.maxRetries : retryDelays.length;
  let retries = 0;
  let attempts = 0;
  const t0 = Date.now();

  for (;;) {
    attempts++;
    let emitted = 0;
    try {
      const res = await fetchOnce({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs,
        signal,
        scrub,
      });

      if (!res.ok) {
        const err = await buildHttpError(res, { url: safeUrl, scrub });
        err.attempts = attempts;
        throw err;
      }

      const ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';

      // 端点无视 stream:true 直接回了 JSON —— 当成一次性响应处理，别把它当 SSE 解析
      if (useStream && !/text\/event-stream|application\/x-ndjson/i.test(ctype)) {
        const data = await readJsonSafely(res, safeUrl, scrub);
        const parsed = adapter.parseResponse(data);
        assertNotRefusal(parsed, safeUrl);
        if (parsed.text) {
          emitted = parsed.text.length;
          if (typeof onDelta === 'function') onDelta(parsed.text);
        }
        const out = {
          text: parsed.text,
          usage: normalizeUsage(parsed.usage),
          raw: data,
          degraded,
          ms: Date.now() - t0,
          streamed: false,
        };
        if (parsed.reasoning) out.reasoning = parsed.reasoning;
        return finishJson(out, json, originalText(out));
      }

      if (useStream) {
        const r = await consumeSse(res, {
          // 有些网关按 ndjson 回（一行一条裸 JSON，**没有** `data:` 前缀）。
          // 见 handleLine 里的说明：光把它列进 content-type 白名单是不够的。
          ndjson: /application\/x-ndjson/i.test(ctype),
          onDelta: (d) => {
            emitted += d.length;
            if (typeof onDelta === 'function') onDelta(d);
          },
          adapter,
          scrub,
          signal,
          timeoutMs,   // 只为了超时报错里能写出用户实际配的秒数（见 buildNetworkError）
        });
        assertNotRefusal({ finishReason: r.finishReason, text: r.text }, safeUrl);
        const out = {
          text: r.text,
          usage: normalizeUsage(r.usage),
          raw: {
            streamed: true,
            events: r.events,
            finishReason: r.finishReason,
            skippedEvents: r.skipped,
          },
          degraded,
          ms: Date.now() - t0,
          streamed: true,
        };
        if (r.reasoning) out.reasoning = r.reasoning;
        if (r.finishReason) out.finishReason = r.finishReason;
        return finishJson(out, json, r.text);
      }

      // 非流式
      const data = await readJsonSafely(res, safeUrl, scrub);
      const parsed = adapter.parseResponse(data);
      assertNotRefusal(parsed, safeUrl);
      const out = {
        text: parsed.text,
        usage: normalizeUsage(parsed.usage),
        raw: data,
        degraded,
        ms: Date.now() - t0,
        streamed: false,
      };
      if (parsed.reasoning) out.reasoning = parsed.reasoning;
      if (parsed.finishReason) out.finishReason = parsed.finishReason;
      return finishJson(out, json, parsed.text);
    } catch (err) {
      if (!(err instanceof LlmError)) {
        // 这里挂的是 safeUrl：任何抛给上层的异常字段都不许带 Key（见 url 的说明）
        throw Object.assign(err, { attempts, url: safeUrl });
      }
      err.attempts = attempts;
      if (err.code === 'EABORTED') throw err;

      // ① 参数降级：只在 400 且错误信息点到某个已知字段时才做，每个字段只降一次
      const fix = err.status === 400 ? pickBodyFix(adapter, err, body, triedFixes) : null;
      if (fix) {
        triedFixes.add(fix.field);
        body = fix.fix(body, err.providerMessage || err.message || '');
        degraded.push({ field: fix.field, label: fix.label, providerMessage: err.providerMessage });
        // 让适配器把这条经验记下来（例如 openai 会把该 base+model 拉黑，
        // 后续调用不再白撞一次 400 —— 一个生成任务会调模型 N 次，这个差别很实在）
        if (typeof fix.onDegraded === 'function') fix.onDegraded(provider, model);
        continue;
      }

      // ② 状态码重试；流已经吐过字了就不能重试（否则前端会看到重复内容）
      const canRetry = err.retryable && retries < maxRetries && emitted === 0;
      if (!canRetry) throw err;

      const delay = Math.max(
        err.retryAfterMs || 0,
        backoffDelay(retries, Math.random, retryDelays)
      );
      retries++;
      if (typeof onRetry === 'function') {
        // 同上：回调的 url 会被调用方写进日志，必须是洗过的
        onRetry({ attempt: retries, delayMs: delay, error: err, url: safeUrl });
      }
      await sleep(delay, signal);
    }
  }
}

/** 400 时按已知字段降级（response_format / stream_options / max_tokens 改名） */
function pickBodyFix(adapter, err, body, triedFixes) {
  const list = adapter.degradations || [];
  const msg = `${err.providerMessage || ''} ${err.body || ''}`;
  for (const d of list) {
    if (triedFixes.has(d.field)) continue;
    if (!d.test(msg, body)) continue;
    return d;
  }
  return null;
}

function normalizeUsage(u) {
  const src = u || {};
  return {
    in: Number.isFinite(src.in) ? src.in : 0,
    out: Number.isFinite(src.out) ? src.out : 0,
    reported: !!(src.reported || Number.isFinite(src.in) || Number.isFinite(src.out)),
  };
}

function originalText(out) {
  return out.text;
}

/**
 * 新版 Claude 会以 HTTP 200 + stop_reason=refusal 拒答。
 * 这时候 text 是空的，如果放过去，上层只会看到"JSON 解析失败"这种误导性的报错
 * （架构 §6.2：不许静默产出半成品）。直接抛一个说人话的错误。
 */
function assertNotRefusal(parsed, url) {
  if (parsed && parsed.finishReason === 'refusal' && !String(parsed.text || '').trim()) {
    throw new LlmError(
      '模型拒答了本次请求（stop_reason=refusal），没有返回任何内容。请调整提示词，或换一个模型重试。',
      { code: 'EREFUSAL', status: 200, retryable: false, url }
    );
  }
}

/** json:true 时顺手解析，失败只记录不抛（原文在 jsonError.raw 里，可直接回灌） */
function finishJson(out, json, text) {
  if (json) {
    try {
      out.data = parseJsonLoose(text);
    } catch (e) {
      out.jsonError = {
        message: e.message,
        raw: e.raw,
        head: e.head,
        tail: e.tail,
      };
    }
  }
  return out;
}

async function readJsonSafely(res, url, scrub) {
  /* url 由调用方给，可能是 safeUrl 也可能没洗过，这里统一洗一遍再挂到错误上：
     这个函数会把 url 写进**四个**错误对象，任何一处漏洗都等于把查询串里的 Key 交出去
     （scrub 对不含 Key 的 URL 是恒等变换，所以既有的 err.url 断言不受影响）。 */
  const safeUrl = typeof scrub === 'function' ? scrub(url) : url;
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    throw buildNetworkError(err, { url: safeUrl, timeoutMs: 0, scrub });
  }
  if (!text.trim()) {
    throw new LlmError('响应体为空', {
      code: 'EEMPTY',
      status: res.status,
      retryable: res.status >= 500,
      url: safeUrl,
    });
  }
  const data = parseMaybeJson(text);
  if (data == null) {
    throw new LlmError(scrub(`响应不是合法 JSON：${truncate(text, 300)}`), {
      code: 'EBADJSON',
      status: res.status,
      retryable: false,
      url: safeUrl,
      body: scrub(truncate(text, MAX_ERROR_BODY_CHARS)),
    });
  }
  if (isPlainObject(data) && data.error) {
    const providerMessage = scrub(extractProviderMessage(data, text));
    throw new LlmError(scrub(`模型返回错误：${providerMessage}`), {
      code: 'EPROVIDER',
      status: res.status,
      providerMessage,
      retryable: false,
      url: safeUrl,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// testConnection()
// ---------------------------------------------------------------------------

/**
 * 测试连接。**绝不抛错**，永远返回 { ok, models?, error?, latencyMs }。
 *
 * OpenAI 兼容：先 GET {base}/models（不带 /v1 的会补上）；
 *             非 2xx 或拿到不可用的列表，再退化成一次 max_tokens:1 的最小 chat/completions。
 * Anthropic ：直接做一次 max_tokens:1 的最小 messages 调用。
 * 默认 10s 超时保护，且不重试（UI 不能被卡住）。
 */
async function testConnection(providerCfg, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TEST_TIMEOUT_MS;
  const t0 = Date.now();
  const done = (patch) => ({ latencyMs: Date.now() - t0, ...patch });

  let adapter;
  let scrub;
  try {
    assertProvider(providerCfg);
    adapter = ADAPTERS[resolveFormat(providerCfg)];
    scrub = makeScrubber(providerCfg.apiKey);
  } catch (err) {
    return done({ ok: false, models: [], error: describe(err) });
  }

  const provider = {
    ...providerCfg,
    // 本地端点没 key 也能测；别让 buildHeaders 拼出 Authorization: Bearer undefined
    apiKey: providerCfg.apiKey || 'local-not-needed',
  };

  const probe = async (label, fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, label, error: describe(err) };
    }
  };

  const failures = [];
  /* 覆盖项写坏了（proxyHeader/proxyBody 不是合法 JSON）时，用户**必须**能看见，
     否则他会对着一个"测试连接失败"反复改地址 —— 而真正被忽略的是这两段设置。
     走既有的 error 通道：成功时只在控制台留一份，失败时并进那句人话里。 */
  const notes = [];
  const warnedFields = new Set();
  const warnConfig = (field, message) => {
    /* 同一个字段只报一次：这条路上 buildHeaders 会被调到两次（/models 探测一次、
       探针 chat 一次），而两处读的是同一份配置 —— 不去重的话用户会在
       "测试连接失败"那句话里看到同一条警告重复两遍，像是出了两个问题。 */
    if (warnedFields.has(field)) return;
    warnedFields.add(field);
    notes.push(message);
    console.warn(`[llm] ${message}`);
  };
  let ids = [];

  if (adapter.format === 'anthropic') {
    const r = await probe('messages', () =>
      minimalChat(adapter, provider, timeoutMs, warnConfig)
    );
    if (r.ok) return done({ ok: true, models: [] });
    failures.push(`messages: ${r.error}`);
  } else {
    /* fullUrl 时 baseUrl 指向的是一个**完整端点**（如 `…/v1/chat/completions?key=x`），
       拿它去拼 /models 只会得到一个不存在的地址（`…/chat/completions/models`）：
       白白多一次必然失败的探测，还会把它的 404 混进最后的报错里，
       让人以为"地址配错了"—— 而地址恰恰是对的。直接跳到真端点探测。 */
    const modelsUrl =
      provider.fullUrl === true
        ? null
        : openai.withQueryAuth(adapter.modelsUrl(provider.baseUrl), provider);
    if (modelsUrl) {
      const r = await probe('models', async () => {
        const res = await fetchOnce({
          url: modelsUrl,
          method: 'GET',
          // 与 chat 完全同一套头（含 authField / userAgent / proxyHeader）：
          // 探测用一套、真调用用另一套，就是"测试连接能过、真生成过不了"的由来
          headers: adapter.buildHeaders(provider, { warn: warnConfig }),
          timeoutMs,
          scrub,
        });
        if (!res.ok) throw await buildHttpError(res, { url: modelsUrl, scrub });
        const data = await readJsonSafely(res, modelsUrl, scrub);
        const list = adapter.parseModels(data);
        if (!list.length) throw new LlmError('模型列表为空或格式不认识', { url: modelsUrl });
        return list;
      });
      if (r.ok) {
        ids = r.value;
        return done({ ok: true, models: ids });
      }
      failures.push(`GET /models: ${r.error}`);
    }
    const r2 = await probe('chat', () => minimalChat(adapter, provider, timeoutMs, warnConfig));
    if (r2.ok) return done({ ok: true, models: ids });
    failures.push(`chat/completions: ${r2.error}`);
  }

  return done({
    ok: false,
    models: [],
    error: [...notes, failures.join('；') || '未知错误'].join('；'),
  });
}

/**
 * 从 provider.models 里取第一个模型的 **id**（字符串），没有就返回 ''。
 *
 * ⚠️ 1.4.0 起这一步的形状变了：`store.providerConfig().models` 是**对象数组**
 * （`{id, name, contextLimit, maxOutput, vision}`），从前是字符串数组。
 * 还照老样子写 `models[0]` 的话，会把**一整个对象**当成模型名发出去 ——
 * 端点收到的 `model` 是 `[object Object]`（JSON 里干脆就是个对象），回 404「模型不存在」，
 * 而用户手里明明填着正确的模型名，只会觉得是工具坏了。
 * 这条路径平时碰不到：只有 `GET /models` 不可用、退化到 chat 探针时才走到。
 * 老形状（字符串数组）也要继续认：导入的旧设置、.env、手写配置都还可能给字符串。
 * 容忍规则与 `pipeline/index.js` 的 `modelCfgOf` 保持一致。
 */
function firstModelId(list) {
  if (!Array.isArray(list)) return '';
  for (const m of list) {
    if (typeof m === 'string' && m.trim()) return m.trim();
    if (m && typeof m === 'object' && typeof m.id === 'string' && m.id.trim()) return m.id.trim();
  }
  return '';
}

/** 一次 max_tokens:1 的最小调用，只验信道与凭据，不计较内容 */
async function minimalChat(adapter, provider, timeoutMs, warn) {
  const scrub = makeScrubber(provider.apiKey);
  const norm = adapter.normalizeMessages({
    system: 'ping',
    messages: [{ role: 'user', content: 'ping' }],
  });
  /* ⚠️ 必须走 buildRequest（= 与 chat() 同一条路）：探测要是用了另一套 URL/头/体，
     "测试连接"通过的配置在真生成时可能因为同一处差异直接 401/400 —— 而用户已经
     被那个绿色的"连接正常"骗过一次了。 */
  const req = buildRequest(adapter, provider, {
    /* 探针模型要优先用**用户自己配的**，最后才轮到写死的兜底。
       以前只写 `provider.model || defaultProbeModel()`，而 `store.providerConfig()` 返回的对象里
       **没有 `model` 字段**（只有 `models` 数组），所以永远落到写死的 `gpt-4o-mini`。
       后果：当 `GET /models` 不可用、退化到 chat 探针时，会拿着 `gpt-4o-mini` 去问一个只认自家模型的端点
       → 404 → 用户看到"模型 `gpt-4o-mini` 不存在"——一个他**从没输入过**的模型名，
       而他的配置其实完全正确。
       （`provider.models` 的形状有两种，取 id 的活儿交给 firstModelId，
         别在这里直接下标取 —— 见那个函数上的说明。） */
    model: provider.model || firstModelId(provider.models) || adapter.defaultProbeModel(provider),
    system: norm.system,
    messages: norm.messages,
    maxTokens: 1,
    temperature: 0,
    json: false,
    stream: false,
    warn, // proxyHeader/proxyBody 写坏了要能说出来（这条路的调用方负责展示）
  });
  const url = req.url;
  const res = await fetchOnce({
    url,
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    timeoutMs,
    scrub,
  });
  // buildHttpError / buildNetworkError 内部都洗 url（authField:'query' 时它带 Key）
  if (!res.ok) throw await buildHttpError(res, { url, scrub });
  await readJsonSafely(res, url, scrub); // 顺带确认响应体可解析
  return true;
}

function describe(err) {
  if (err instanceof LlmError) return err.summary;
  return (err && err.message) || String(err);
}

module.exports = {
  // 契约
  chat,
  testConnection,
  // 自测 / 上层复用
  parseJsonLoose,
  joinUrl: openai.joinUrl,
  normalizeBase: openai.normalizeBase,
  // 请求覆盖项的几个纯函数（自测/审计直接调，不必再伪造一次请求）
  normalizeFullUrl: openai.normalizeFullUrl,
  withQueryAuth: openai.withQueryAuth,
  applyProxyBody: openai.applyProxyBody,
  applyHeaderOverrides: openai.applyHeaderOverrides,
  maskKey,
  makeScrubber,
  anySignal,
  backoffDelay,
  isLocalBase,
  LlmError,
  adapters: ADAPTERS,
  resolveFormat,
  // 常量
  DEFAULT_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
  RETRY_DELAYS,
  RETRYABLE_STATUS,
};
