'use strict';

/**
 * OpenAI 兼容协议适配器。
 * ---------------------------------------------------------------------------
 * 只做"协议翻译"：URL 归一化 / 请求头 / 请求体 / 流事件 / 响应解析 / 参数降级表。
 * HTTP、超时、重试、SSE 分帧都在 index.js 里，本文件不碰网络。
 *
 * 导出 joinUrl() / normalizeBase() 是本文件独有的（Anthropic 适配器也复用），
 * 因为它是"用户粘贴的 Base URL 千奇百怪"这件事的唯一收敛点。
 */

const { getPreset } = require('../providers');

const CHAT_PATH = 'chat/completions';
const MODELS_PATH = 'models';

/** 形如 v1 / v1beta / v2 / v3 / v4 的版本段 */
const VERSION_SEGMENT = /^v\d+[a-z0-9]*$/i;
/** 不带版本号、但也算"已经到端点根"的尾段 */
const VERSIONLESS_TAILS = new Set(['beta']);
/** 用户可能整段粘贴进来的端点后缀（长的排前面，先剥长的） */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/models'];

/** 本机端点不需要 Authorization */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Key 的位置（设置页的 authField）。只认这三个，其余一律当"没选"。
 * 为什么不能"认不得就当 query/当裸头"：这三个值决定的是**鉴权往哪儿发**，
 * 一个拼错的枚举如果被当成"没有鉴权方式"，请求就会带着 401 回来，
 * 而用户看到的配置页上明明勾着一个选项 —— 排查方向会被彻底带偏。
 */
const AUTH_FIELDS = new Set(['auth_header', 'api_key_header', 'query']);

/**
 * proxyBody 里**不许**被用户改掉的两把钥匙。详见 applyProxyBody 的注释。
 * 这里是唯一一处"用户的值不赢"的地方，所以单独提出来当常量，改它必须改注释。
 */
const PROTECTED_BODY_KEYS = ['messages', 'stream'];

// ---------------------------------------------------------------------------
// Base URL 归一化
// ---------------------------------------------------------------------------

/**
 * 把用户随手填的 Base URL 收敛成"版本根"，例如：
 *   https://api.deepseek.com                       -> https://api.deepseek.com/v1
 *   https://api.deepseek.com/v1/chat/completions    -> https://api.deepseek.com/v1
 *   https://open.bigmodel.cn/api/paas/v4            -> 原样（已有 v4）
 *   https://generativelanguage.googleapis.com/v1beta/openai/  -> 原样（已有 v1beta）
 *   localhost:11434                                 -> http://localhost:11434/v1
 * 规则：只在"整条路径里没有版本段"且"尾段不是 beta"时才补 /v1。
 */
function normalizeBase(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) throw new Error('Base URL 为空');
  s = s.replace(/\s+/g, '');

  // 只填了域名/主机时补协议；本机默认 http，其余默认 https
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = (LOCAL_HOST.test(s) ? 'http://' : 'https://') + s;
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`Base URL 协议不支持（只支持 http/https）：${s}`);
  }

  s = s.replace(/[?#].*$/, ''); // 丢 query / hash
  s = s.replace(/\/+$/, ''); // 丢尾斜杠

  // 整段粘贴了完整端点时剥掉
  const lower = s.toLowerCase();
  for (const suf of ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length).replace(/\/+$/, '');
      break;
    }
  }

  const path = s.replace(/^https?:\/\/[^/]+/i, '');
  const segs = path.split('/').filter(Boolean);
  const hasVersion = segs.some((seg) => VERSION_SEGMENT.test(seg));
  const last = (segs[segs.length - 1] || '').toLowerCase();
  if (!hasVersion && !VERSIONLESS_TAILS.has(last)) s += '/v1';

  return s;
}

/** normalizeBase + 拼一段路径，保证中间只有一个斜杠 */
function joinUrl(baseUrl, path = CHAT_PATH) {
  const base = normalizeBase(baseUrl);
  const tail = String(path == null ? '' : path).replace(/^\/+/, '').replace(/\/+$/, '');
  return tail ? `${base}/${tail}` : base;
}

/**
 * `fullUrl:true` 时 baseUrl **本身就是**请求地址：不拼端点、不补 /v1、不剥掉路径里的
 * `/chat/completions`（有些中转的地址就长这样，剥掉之后没有东西拼回来，端点是空的）。
 *
 * 只做两件"不做就直接不能用"的清理：
 *   ① 去掉粘贴时带进来的空白/换行 —— 从文档里复制地址常会夹进空格，
 *      而 fetch 遇到这种 URL 抛的是 `ERR_UNESCAPED_CHARACTERS`，和"地址写错了"长得一模一样，
 *      用户根本查不出是空格；normalizeBase 也是这么做的，这里保持一致。
 *   ② 没有协议时补一个（本机默认 http，其余 https）—— 缺协议 fetch 直接失败。
 *
 * ⚠️ 这里**不**丢 query：中转常把参数写在地址上，而 authField:'query' 还要继续往上追加 key。
 */
function normalizeFullUrl(baseUrl) {
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) throw new Error('Base URL 为空');
  s = s.replace(/\s+/g, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = (LOCAL_HOST.test(s) ? 'http://' : 'https://') + s;
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`Base URL 协议不支持（只支持 http/https）：${s}`);
  }
  return s;
}

/**
 * 端点地址。`opts.fullUrl` 由 provider 透传（协议无关，两个适配器共用）。
 * 第二个参数是**可选的**：llm-smoke / request-shape 那几套按老签名直接传字符串，
 * 只给路径不认 fullUrl，行为必须与从前逐字节一致。
 */
function endpointUrl(baseUrl, path, opts = {}) {
  if (opts && opts.fullUrl === true) return normalizeFullUrl(baseUrl);
  return joinUrl(baseUrl, path);
}

function chatUrl(baseUrl, opts) {
  return endpointUrl(baseUrl, CHAT_PATH, opts);
}

function modelsUrl(baseUrl, opts) {
  return endpointUrl(baseUrl, MODELS_PATH, opts);
}

/** 认得的 authField，认不得的返回 ''（= 按该格式的默认走） */
function resolveAuthField(provider) {
  const v = provider && provider.authField;
  return AUTH_FIELDS.has(v) ? v : '';
}

/**
 * authField:'query' —— 一部分中转只认 `?key=xxx`（Key 根本不在头里）。
 *
 * 为什么单独一个函数：它改的是 **URL**，而 URL 是 index.js 决定、适配器拼的；
 * 想把它塞进 buildHeaders 是做不到的（头里放不下 URL）。也因此这个 URL 之后
 * **任何**要进日志/错误的地方都必须先洗一遍 —— 见 index.js 里的 safeUrl。
 */
function withQueryAuth(url, provider) {
  const key = provider && provider.apiKey;
  if (!key || resolveAuthField(provider) !== 'query') return url;
  const u = String(url);
  // 地址自带的 query 不能覆盖：用 & 接上去；末尾已经是 ? / & 时不再补分隔符
  const sep = /[?&]$/.test(u) ? '' : u.includes('?') ? '&' : '?';
  return `${u}${sep}key=${encodeURIComponent(key)}`;
}

/**
 * 大小写不敏感地写一个请求头。
 *
 * 为什么不能直接 `headers[k] = v`：HTTP 头名**不区分大小写**，于是用户写
 * `authorization` 而我们已放了 `Authorization` 时，对象里会同时留下两个键，
 * undici 会把它们合并成 `Bearer 我的, Bearer 你的` 发出去 —— 表面上看"用户覆盖了
 * Authorization"，实际发的是两个值拼在一起，服务端按坏凭据处理。
 * 这类错只有抓包才看得出来（界面上、响应里都只是"鉴权失败"）。
 */
function setHeader(headers, name, value) {
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
  headers[name] = value;
}

/**
 * 解析设置页里那两段 JSON 文本（proxyHeader / proxyBody）。
 *
 * 解析失败**绝不抛**：这两段是"锦上添花"的覆盖项，为了它把整个生成任务打死不值得，
 * 上层应当降级成"没配"并留一条人话警告（testConnection 那条路也一样）。
 *
 * ⚠️ 返回的 error **不含原始文本**、也不含 JSON.parse 的原话：
 * Node 的解析错误会把出错的那一小段原文回显出来
 * （`Unexpected token 'B', "Bearer sk-…" is not valid JSON`），
 * 而这两段恰恰是用户最容易粘 Key 进去的地方 —— 那等于把 Key 写进日志。
 */
function parseJsonOverride(raw, label) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: true, value: null };
  let value;
  try {
    value = JSON.parse(s);
  } catch {
    return { ok: false, value: null, error: `${label} 不是合法 JSON，本次已忽略这一项覆盖` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, value: null, error: `${label} 必须是一个 JSON 对象，本次已忽略这一项覆盖` };
  }
  return { ok: true, value };
}

/**
 * 把 proxyHeader（JSON 文本）与 userAgent 落到请求头上。
 *
 * 顺序就是"谁说了算"：我们的默认 → provider.headers → proxyHeader → userAgent。
 *   · proxyHeader 排在 Authorization 之后 —— 用户**可以**用它换掉整条鉴权头（有些网关要
 *     `Authorization: Basic …` 或自家签名），这是这个功能存在的意义；
 *   · userAgent 排在最后：它比"一大包头"更具体，两个地方都写了 User-Agent 时以那个输入框为准。
 * warn(text) 由上层给（chat 收进 degraded、testConnection 收进连接失败的说明）。
 */
function applyHeaderOverrides(headers, provider, warn) {
  const raw = provider && provider.proxyHeader;
  if (raw && String(raw).trim()) {
    const got = parseJsonOverride(raw, 'proxyHeader');
    if (!got.ok) {
      if (typeof warn === 'function') warn('proxyHeader', got.error);
    } else if (got.value) {
      for (const [k, v] of Object.entries(got.value)) {
        /* 只收标量：JSON 里塞个对象/数组进来，undici 会把头值写成 "[object Object]"，
           请求照发、头是坏的，而界面上什么都看不出来。 */
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          setHeader(headers, k, String(v));
        }
      }
    }
  }
  const ua = provider && provider.userAgent;
  if (ua && String(ua).trim()) setHeader(headers, 'User-Agent', String(ua).trim());
  return headers;
}

/**
 * 把 proxyBody（JSON 文本）合并进请求体。
 *
 * 顺序：我们的默认在前、用户在后 —— 用户赢（temperature / top_p / 各家私有字段
 * 如 `X-Provider` 都能改，这正是这个功能的用途）。
 *
 * 例外只有两样，合并完**必须还原回我们的值**：
 *   · `messages` —— 对话内容是应用拼出来的。让一段配置改写它，等于设置页在背后
 *     换掉用户要问的问题，而日志里显示的提示词还是对的 —— 出了事根本查不出来。
 *   · `stream`   —— 这个标志必须与 index.js 里"按哪条路解析响应"的判断一致：
 *     流式解析器遇到整包 JSON 会一直等到超时，非流式解析器遇到 SSE 只会拿到一段
 *     解析不了的文本。用户配错时的症状是"模型一直没反应"或"响应不是合法 JSON"，
 *     跟这个开关的联系一点都看不出来。
 */
function applyProxyBody(body, provider, warn) {
  const raw = provider && provider.proxyBody;
  if (!raw || !String(raw).trim()) return body;
  const got = parseJsonOverride(raw, 'proxyBody');
  if (!got.ok) {
    if (typeof warn === 'function') warn('proxyBody', got.error);
    return body;
  }
  const merged = { ...body, ...got.value };
  for (const key of PROTECTED_BODY_KEYS) {
    // 用 hasOwnProperty 而不是 `body[key]` 判断：我们**没有**这个字段时，
    // 用户也不能凭空加上（例如非流式请求里塞 stream:true）
    if (Object.prototype.hasOwnProperty.call(body, key)) merged[key] = body[key];
    else delete merged[key];
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

function buildHeaders(provider, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
  };
  // 只要用户配了 key 就带上。本机端点(Ollama/LM Studio)不**要求** key，
  // 但用户要是填了（比如指向带鉴权的本地网关），那就该发出去。
  const key = provider && provider.apiKey;
  const field = resolveAuthField(provider);
  /* authField='query' 时这里**一个鉴权头都不发**：Key 已经在 URL 上了（见 withQueryAuth）。
     两个地方都发的话，那些"只认查询串"的中转会把多出来的头当成坏凭据直接拒绝 ——
     这是设置页里那个选项唯一的作用，必须真的生效。 */
  if (key && field !== 'query') {
    // '' / 'auth_header' / 认不得的值 ⇒ 该格式的默认（Bearer）
    if (field === 'api_key_header') setHeader(headers, 'api-key', key);
    else headers.Authorization = `Bearer ${key}`;
  }
  // 少数网关要额外头（如 OpenRouter 的 HTTP-Referer / X-Title）
  if (provider && provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  // proxyHeader / userAgent 永远压在上面所有来源之上（用户的值赢）
  return applyHeaderOverrides(headers, provider, opts.warn);
}

/**
 * @param {object} o
 * @param {string} o.model
 * @param {Array}  o.messages  已由 normalizeMessages 处理（system 已并入）
 * @param {string} o.system    已并入 messages，此处置空
 */
function buildBody(o) {
  const body = {
    model: o.model,
    messages: o.messages,
  };
  if (Number.isFinite(o.temperature)) body.temperature = o.temperature;
  if (Number.isFinite(o.maxTokens)) body.max_tokens = o.maxTokens;
  if (o.stream) {
    body.stream = true;
    // 流式默认不回 usage，要显式要；不支持该字段的端点会在 400 时被降级掉
    body.stream_options = { include_usage: true };
  }
  if (o.json) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * 归一化消息：校验角色、丢弃空内容、把 system 提到最前。
 * OpenAI 允许连续同角色，所以只做最基本处理。
 */
function normalizeMessages({ system, messages }) {
  const out = [];
  const sys = typeof system === 'string' ? system.trim() : '';
  if (sys) out.push({ role: 'system', content: sys });
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const content = contentToText(m.content);
    if (!content.trim()) continue; // 只有空白的消息是噪声，丢掉
    out.push({ role, content });
  }
  return { system: null, messages: out };
}

/** 内容可能是 string，也可能是 [{type:'text',text}] 片段数组 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

function defaultProbeModel() {
  return 'gpt-4o-mini';
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/**
 * 解析一条流事件的载荷。返回 null 表示这条事件与正文无关。
 * -> { delta?, reasoning?, usage?:{in?,out?}, finishReason? }
 */
function parseStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  if (obj.usage && typeof obj.usage === 'object') {
    out.usage = {
      in: num(obj.usage.prompt_tokens, obj.usage.input_tokens),
      out: num(obj.usage.completion_tokens, obj.usage.output_tokens),
    };
  }
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice && typeof choice === 'object') {
    const d = choice.delta || choice.message || {};
    const text = contentToText(d.content);
    if (text) out.delta = text;
    // DeepSeek-R1 一类的思维链字段：不并进正文，单独给上层
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      out.reasoning = d.reasoning_content;
    }
    const fr = choice.finish_reason || choice.stop_reason;
    if (fr) out.finishReason = fr;
  }
  return Object.keys(out).length ? out : null;
}

/** 200 的流里内嵌错误（有些网关这么干） */
function streamError(obj) {
  if (obj && typeof obj === 'object' && obj.error) {
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.error.message === 'string') return obj.error.message;
    try {
      return JSON.stringify(obj.error);
    } catch {
      return '未知错误';
    }
  }
  return null;
}

function parseResponse(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  if (!choice) {
    // 少数端点直接回 {content: '...'}
    const loose = contentToText(data && data.content);
    return {
      text: loose,
      usage: { in: undefined, out: undefined },
      finishReason: data && data.stop_reason,
    };
  }
  const msg = choice.message || {};
  return {
    text: contentToText(msg.content),
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : undefined,
    usage: {
      in: num(data && data.usage && data.usage.prompt_tokens, data && data.usage && data.usage.input_tokens),
      out: num(data && data.usage && data.usage.completion_tokens, data && data.usage && data.usage.output_tokens),
    },
    finishReason: choice.finish_reason || choice.stop_reason,
  };
}

/** GET /models 的形状五花八门，全兜一遍 */
function parseModels(data) {
  const pick = (arr) =>
    arr
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model)))
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
  if (Array.isArray(data)) return pick(data);
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.data)) return pick(data.data);
  if (Array.isArray(data.models)) return pick(data.models);
  if (data.data && Array.isArray(data.data.models)) return pick(data.data.models);
  return [];
}

function num(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON 模式
// ---------------------------------------------------------------------------

/**
 * 该 provider 是否支持 `response_format: {type:'json_object'}`。
 *
 * 优先级（任何"不支持"的证据都压过"支持"）：
 *   1. 预设表里写死 jsonMode:false（如 Ollama / LM Studio）
 *   2. provider 上显式 supportsJsonMode:false（用户在设置页关掉）
 *   3. 运行时黑名单 —— 这个 base+model 刚刚因为 response_format 被 400 过（经验事实最硬）
 *   4. provider 上显式 supportsJsonMode:true
 *   5. 预设表里写死 jsonMode:true
 *   6. 本机端点默认不发
 *   7. 其余默认发
 *
 * 第 7 条默认"发"是安全的：真不支持时 400 会自动降级（见 degradations），
 * 并把这条经验记进黑名单，后续同一个 base+model 的调用不会再白撞一次。
 */
function supportsJsonMode(provider = {}, model = '') {
  const preset = provider && provider.id ? getPreset(provider.id) : null;
  if (preset && preset.jsonMode === false) return false;
  if (provider && provider.supportsJsonMode === false) return false;
  if (isJsonModeBlocked(provider, model)) return false;
  if (provider && provider.supportsJsonMode === true) return true;
  if (preset && preset.jsonMode === true) return true;
  const base = String((provider && provider.baseUrl) || '');
  if (LOCAL_HOST.test(base.replace(/^https?:\/\//i, ''))) return false; // Ollama / LM Studio
  return true;
}

/** 运行时记住"这个端点不吃 response_format"，避免每次调用都先撞一次 400 */
const jsonModeBlocklist = new Set();

function jsonModeKey(provider, model) {
  let base = '';
  try {
    /* fullUrl 时不能走 normalizeBase：它会剥掉端点后缀再补 /v1，于是
       `https://gw/a/chat/completions` 和 `https://gw/v1` 会算出同一个键 ——
       一个端点因为 response_format 被 400 之后，另一个也被连坐拉黑，
       而后者的用户只会看到"我的 JSON 模式莫名其妙不发了"。 */
    base =
      provider && provider.fullUrl === true
        ? String((provider && provider.baseUrl) || '').trim()
        : normalizeBase(provider && provider.baseUrl);
  } catch {
    base = String((provider && provider.baseUrl) || '');
  }
  return `${base}|${model || ''}`;
}

function isJsonModeBlocked(provider, model = '') {
  return jsonModeBlocklist.has(jsonModeKey(provider, model));
}

function blockJsonMode(provider, model = '') {
  jsonModeBlocklist.add(jsonModeKey(provider, model));
}

// ---------------------------------------------------------------------------
// 400 参数降级表
// ---------------------------------------------------------------------------

/**
 * 只在 HTTP 400 且 providerMessage 点到某个已知字段时才降级，每个字段只降一次。
 * 国内兼容端点最常见的三种"字段不认识"：
 */
const degradations = [
  {
    field: 'response_format',
    test: (msg, body) => !!body.response_format && /response_format|json_object|response format/i.test(msg),
    label: '去掉 response_format（该端点不支持 JSON 模式，改用提示词约束）',
    fix: (body) => {
      const next = { ...body };
      delete next.response_format;
      return next;
    },
    onDegraded: (provider, model) => blockJsonMode(provider, model),
  },
  {
    field: 'stream_options',
    test: (msg, body) => !!body.stream_options && /stream_options|stream options|include_usage/i.test(msg),
    label: '去掉 stream_options（该端点不支持流式用量统计，usage 将不准确）',
    fix: (body) => {
      const next = { ...body };
      delete next.stream_options;
      return next;
    },
  },
  {
    field: 'max_tokens',
    test: (msg, body) => Number.isFinite(body.max_tokens) && /max_completion_tokens/i.test(msg),
    label: '改用 max_completion_tokens（该模型不再接受 max_tokens）',
    fix: (body) => {
      const next = { ...body };
      next.max_completion_tokens = next.max_tokens;
      delete next.max_tokens;
      return next;
    },
  },
  {
    /* 「这个模型最多支持 N 个输出 token」——必须能降下来，否则整条链路会卡死：
       流水线给 bank 阶段 16000，而只支持 8192 的模型会 400；更糟的是
       `explainEmptyText` 在"空正文"时会把上限抬到 64000，下一轮**必然** 400。
       以前没有这条降级，症状是任务彻底失败，而报错只有厂商原文、没有"我帮你降了"。 */
    field: 'max_tokens_too_large',
    test: (msg, body) =>
      Number.isFinite(body.max_tokens) &&
      /(max_?tokens?|completion tokens).{0,60}?(too large|exceed|at most|max(imum)?\s*(is|of)?\s*\d|大于|超过|上限)/i.test(msg),
    label: '把输出上限降到该模型允许的值',
    fix: (body, msg) => {
      const nums = String(msg || '').match(/\d{3,6}/g) || [];
      const caps = nums.map(Number).filter((n) => n >= 256 && n < body.max_tokens).sort((a, b) => b - a);
      const next = { ...body };
      next.max_tokens = caps.length ? caps[0] : Math.min(body.max_tokens, 4096);
      return next;
    },
  },
];

module.exports = {
  format: 'openai',
  chatUrl,
  modelsUrl,
  normalizeBase,
  normalizeFullUrl,
  endpointUrl,
  joinUrl,
  /* 下面这组是"请求装饰"，与协议无关，anthropic.js 直接复用（它已经有 openai 依赖）：
     两处各写一份的下场是"其中一处忘了改"——这个仓库栽过好几次。 */
  resolveAuthField,
  withQueryAuth,
  applyHeaderOverrides,
  applyProxyBody,
  setHeader,
  parseJsonOverride,
  buildHeaders,
  buildBody,
  normalizeMessages,
  parseStreamEvent,
  streamError,
  parseResponse,
  parseModels,
  defaultProbeModel,
  supportsJsonMode,
  isJsonModeBlocked,
  blockJsonMode,
  jsonModeBlocklist,
  degradations,
  isLocalBase: (baseUrl) => LOCAL_HOST.test(String(baseUrl || '').replace(/^https?:\/\//i, '')),
};
