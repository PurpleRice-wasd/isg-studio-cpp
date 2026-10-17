'use strict';

/**
 * Anthropic（Messages API）协议适配器。
 * ---------------------------------------------------------------------------
 * 与 openai.js 同形，由 index.js 统一驱动。
 *
 * 与 OpenAI 的关键差异：
 *   - 端点是 POST {base}/v1/messages
 *   - 认证头是 x-api-key（不是 Authorization: Bearer）；第三方 Anthropic 兼容网关
 *     两种都认，所以非官方域名会同时带上 Bearer（见 authStyle）
 *   - system 是**顶层字段**，不是 messages 里的一条
 *   - max_tokens **必填**
 *   - 必须带 anthropic-version: 2023-06-01
 *   - 不支持 response_format，JSON 只能靠提示词约束
 *   - 流式增量在 content_block_delta 事件的 delta.text
 *
 * 依赖方向： anthropic.js -> openai.js（只用它的 normalizeBase/joinUrl 字符串工具）
 */

const openai = require('./openai');

const CHAT_PATH = 'messages';
/** 官方要求必带的版本头 */
const API_VERSION = '2023-06-01';
/** max_tokens 必填，调用方没给时的兜底 */
const DEFAULT_MAX_TOKENS = 4096;
/** Anthropic 的采样温度上限是 1 */
const MAX_TEMPERATURE = 1;
/** 官方域名：只走 x-api-key，避免同时带 Bearer 被拒 */
const OFFICIAL_HOST = /(^|\.)anthropic\.com$/i;

function chatUrl(baseUrl, opts) {
  // fullUrl 的处理与 openai 完全同一段代码（见 openai.endpointUrl）：
  // 两边各写一份的话，迟早有一边漏了 fullUrl，而症状是"只有某一家中转不行"
  return openai.endpointUrl(baseUrl, CHAT_PATH, opts);
}

/** Anthropic 格式没有单独的 models 探测需求，testConnection 直接打 messages */
function modelsUrl() {
  return null;
}

function isOfficialHost(baseUrl) {
  try {
    const host = new URL(openai.normalizeBase(baseUrl)).hostname;
    return OFFICIAL_HOST.test(host);
  } catch {
    return false;
  }
}

/**
 * 认证方式（**只在用户没显式指定 authField 时才算数**）：
 *   'x-api-key'  只发 x-api-key（官方域名默认）
 *   'bearer'     只发 Authorization: Bearer（某些只认 OpenAI 风格头的网关）
 *   'both'       两个都发（第三方 Anthropic 兼容网关的默认，最大化兼容）
 * 可用 provider.authStyle 显式覆盖。
 */
function resolveAuthStyle(provider) {
  const want = provider && provider.authStyle;
  if (want === 'x-api-key' || want === 'bearer' || want === 'both') return want;
  return isOfficialHost(provider && provider.baseUrl) ? 'x-api-key' : 'both';
}

function buildHeaders(provider, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: opts.stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': API_VERSION,
  };
  const key = provider && provider.apiKey;
  const field = openai.resolveAuthField(provider);
  /* authField='query' ⇒ 一个鉴权头都不发（Key 在 URL 上，见 withQueryAuth） */
  if (key && field !== 'query') {
    if (field) {
      /* 用户显式选了 Key 的落点 ⇒ 完全照他说的来，**不再**叠加 authStyle 的"两个都发"。
         显式选择的意义就是"我知道这个网关要哪个"；再顺手多塞一个头，
         恰好是那些对凭据挑剔的网关会拒的形态（而且拒绝理由只说"鉴权失败"）。
         'api_key_header' 落在 x-api-key —— 与默认同址，但此时是**只发它**。 */
      if (field === 'auth_header') headers.Authorization = `Bearer ${key}`;
      else headers['x-api-key'] = key;
    } else {
      const style = resolveAuthStyle(provider);
      if (style === 'x-api-key' || style === 'both') headers['x-api-key'] = key;
      if (style === 'bearer' || style === 'both') headers.Authorization = `Bearer ${key}`;
    }
  }
  if (provider && provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  // proxyHeader / userAgent 永远压在上面所有来源之上（用户的值赢，包括换掉整条鉴权头）
  return openai.applyHeaderOverrides(headers, provider, opts.warn);
}

/**
 * @param {object} o
 * @param {string} o.system    顶层字段
 * @param {Array}  o.messages  只有 user / assistant
 */
function buildBody(o) {
  const body = {
    model: o.model,
    messages: o.messages,
    // 必填：缺了会直接 400
    max_tokens: Number.isFinite(o.maxTokens) && o.maxTokens > 0 ? o.maxTokens : DEFAULT_MAX_TOKENS,
  };
  const sys = typeof o.system === 'string' ? o.system.trim() : '';
  if (sys) body.system = sys;
  if (Number.isFinite(o.temperature)) {
    body.temperature = Math.min(Math.max(o.temperature, 0), MAX_TEMPERATURE);
  }
  if (o.stream) body.stream = true;
  // 注意：这里**不**放 response_format —— Anthropic 不支持，发了就是 400
  return body;
}

/**
 * 归一化消息：
 *   - 只允许 user / assistant（role 不是这两个的一律降级成 user）
 *   - 连续同角色合并成一跳
 *   - 首条必须是 user，否则补一条占位（Anthropic 硬要求）
 */
function normalizeMessages({ system, messages }) {
  const merged = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = contentToText(m.content);
    if (!content.trim()) continue; // 只有空白的消息是噪声，丢掉
    const prev = merged[merged.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${content}`;
    else merged.push({ role, content });
  }
  if (merged.length && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '（继续）' });
  }
  const sys = typeof system === 'string' ? system.trim() : '';
  return { system: sys || null, messages: merged };
}

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
  // 最便宜的当前模型，仅用于 ping
  return 'claude-haiku-5-5';
}

// ---------------------------------------------------------------------------
// 响应
// ---------------------------------------------------------------------------

/**
 * 解析一条流事件。事件类型（官方 SSE）：
 *   message_start        -> usage.input_tokens
 *   content_block_start  -> 忽略
 *   content_block_delta  -> delta.text（text_delta）/ delta.thinking（thinking_delta）
 *   content_block_stop   -> 忽略
 *   message_delta        -> usage.output_tokens（累计值）、delta.stop_reason
 *   message_stop / ping  -> 忽略
 *   error                -> 由 streamError 拦下
 */
function parseStreamEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  switch (obj.type) {
    case 'message_start': {
      const usage = obj.message && obj.message.usage;
      if (usage) out.usage = { in: num(usage.input_tokens), out: num(usage.output_tokens) };
      break;
    }
    case 'content_block_delta': {
      const d = obj.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string') out.delta = d.text;
      else if (typeof d.text === 'string' && d.text) out.delta = d.text;
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') out.reasoning = d.thinking;
      break;
    }
    case 'message_delta': {
      const usage = obj.usage;
      if (usage) out.usage = { in: num(usage.input_tokens), out: num(usage.output_tokens) };
      const fr = obj.delta && obj.delta.stop_reason;
      if (fr) out.finishReason = fr;
      break;
    }
    default:
      return null; // ping / content_block_start / content_block_stop / message_stop
  }
  return Object.keys(out).length ? out : null;
}

function streamError(obj) {
  if (obj && obj.type === 'error') {
    const e = obj.error || {};
    return typeof e.message === 'string' ? e.message : JSON.stringify(e);
  }
  return null;
}

function parseResponse(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const thinking = blocks
    .filter((b) => b && b.type === 'thinking' && typeof b.thinking === 'string')
    .map((b) => b.thinking)
    .join('');
  const usage = (data && data.usage) || {};
  return {
    text,
    reasoning: thinking || undefined,
    usage: { in: num(usage.input_tokens), out: num(usage.output_tokens) },
    finishReason: data && data.stop_reason,
  };
}

/** Anthropic 的 GET /v1/models 形状，测试连接暂不用，留着给设置页拉列表 */
function parseModels(data) {
  const arr = data && Array.isArray(data.data) ? data.data : [];
  return arr.map((m) => m && m.id).filter((id) => typeof id === 'string' && id.trim());
}

function num(v) {
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// 参数降级
// ---------------------------------------------------------------------------

/**
 * Anthropic 官方不吃 response_format，所以 supportsJsonMode 恒为 false，
 * 这里只需要处理第三方网关可能不认的字段。
 */
function supportsJsonMode() {
  return false;
}

const degradations = [
  {
    field: 'temperature',
    test: (msg, body) => Number.isFinite(body.temperature) && /temperature/i.test(msg),
    label: '去掉 temperature（该端点不接受温度参数）',
    fix: (body) => {
      const next = { ...body };
      delete next.temperature;
      return next;
    },
  },
];

module.exports = {
  format: 'anthropic',
  chatUrl,
  modelsUrl,
  buildHeaders,
  buildBody,
  normalizeMessages,
  parseStreamEvent,
  streamError,
  parseResponse,
  parseModels,
  defaultProbeModel,
  supportsJsonMode,
  isJsonModeBlocked: () => false,
  resolveAuthStyle,
  isOfficialHost,
  degradations,
  API_VERSION,
  DEFAULT_MAX_TOKENS,
  isLocalBase: openai.isLocalBase,
};
