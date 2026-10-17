'use strict';

/**
 * 提供商预设表（架构文档 §3.2）
 * ---------------------------------------------------------------------------
 * PRESETS    -> [{ id, name, format, baseUrl, keyUrl, doc, homepage,
 *                   fullUrl, authField, userAgent, proxyHeader, proxyBody, billing,
 *                   models:[{id,name,contextLimit,maxOutput,vision?,note?}], note? }]
 * getPreset(id)
 *
 * 数据来源与置信度：
 *   每条 baseUrl 都用官方文档页面核对过（见 doc 字段）。
 *   模型 ID 照抄官方页面的拼写；官方页面没写的一律留空或用 note 标"未能确认"，
 *   不编造。厂家会改域名和模型名，所以每一项都建议用设置页的"测试连接"复核。
 *   homepage 也逐条访问核对过；**抓不到或拿不准的宁可留空，也不写一个"看起来像"的地址**
 *   —— 官网链接点开是别人的站点（或 404），比没有链接更糟。
 *   models[].contextLimit / maxOutput 一律先给 0（= 未声明）：本表的 note 里出现过
 *   "100 万 token""256k"之类**二手描述**，把它抄成数字就等于替官方声明了一个上限，
 *   而 resolveTokenPlan 会照着它去定请求的 max_tokens —— 抄错就是请求被截断，
 *   用户还看不出是自己没填过的一个数字干的。要声明让用户在设置页按官方页填。
 *   同理 vision 只标官方明确说过的，没说不标（不标的那条必须有 note 说明）。
 *
 * 1.4.0 起每家还带一组「请求整形」默认值（设置页里可改，见 DESIGN-1.4.0 §1.1）：
 *   homepage     官网（给人点的，不是 API 端点）
 *   fullUrl      true = baseUrl 本身就是完整请求地址，不再拼端点路径
 *   authField    '' = 按 format 的默认；可选 'auth_header' / 'api_key_header' / 'query'
 *   userAgent    空 = 不覆盖运行时默认
 *   proxyHeader  JSON 文本，解析后合并进请求头（用户的值赢）
 *   proxyBody    JSON 文本，解析后合并进请求体（用户的值赢，但覆盖不了 messages/stream）
 *   billing      {enabled,inputPerM,outputPerM,currency} —— 只用来算钱，不影响请求
 * ⚠️ 这些是**默认值**不是"预设限定值"：它们会被原样写进设置文件，之后一切以设置文件为准
 *   （改这里动不了老用户的配置——这正是 store.defaults() 那句"字段加在这里就等于做迁移"的另一面）。
 *
 * ⚠️ 本文件里的 `note` 是**预设的说明文案**（数据来源/置信度，给用户判断敢不敢用），
 *    跟设置文件里那个「备注」（用户自己写的，默认 ''）**不是一回事**，别合并成一个字段：
 *    说明文案删掉就再没有第二处记录"这条模型为什么算可信/哪儿未能确认"了，
 *    而且 test/llm-smoke.js 压着"没标 vision 的模型必须有 note"这条。
 *    设置里那个「备注」的默认值在 store.defaults() 里给（那边才是它该在的地方）。
 *
 * 额外字段（非契约，供 UI/接入层使用）：
 *   jsonMode  该预设是否支持 response_format:{type:'json_object'}；省略=支持
 *   local     true = 本机端点，不需要 API Key
 *   order     显示顺序
 *
 * 本文件不依赖 llm/ —— 依赖方向是单向的（llm/openai.js -> providers.js）。
 */

const PRESETS = [
  // -------------------------------------------------------------------------
  // 国内
  // -------------------------------------------------------------------------
  {
    id: 'deepseek',
    order: 10,
    name: 'DeepSeek 深度求索',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    doc: 'https://api-docs.deepseek.com/',
    homepage: 'https://www.deepseek.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextLimit: 0, maxOutput: 0, note: '官方模型页当前列出的主力模型' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextLimit: 0, maxOutput: 0, note: '官方模型页当前列出的旗舰模型' },
    ],
    note:
      '官方参数表给的 Base URL 就是不带 /v1 的裸域名（本应用会自动补 /v1，两种写法都能用）。' +
      '官方页另注明 deepseek-v4-flash / deepseek-v4-flash-vision-exp 属遗留名，仍可调用但背后已换成 V4.1-Flash。' +
      '视觉能力官方页未标注 —— 未能确认。另有 Anthropic 格式端点：https://api.deepseek.com/anthropic',
  },
  {
    id: 'deepseek-anthropic',
    order: 11,
    name: 'DeepSeek（Anthropic 格式）',
    format: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    doc: 'https://api-docs.deepseek.com/',
    homepage: 'https://www.deepseek.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', contextLimit: 0, maxOutput: 0, note: '与 OpenAI 格式共用同一批模型' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextLimit: 0, maxOutput: 0, note: '与 OpenAI 格式共用同一批模型' },
    ],
    note:
      '用来验证 Anthropic 协议这条链路（有些任务用 Messages 格式更省事）。' +
      '端点 = {baseUrl}/v1/messages。模型 ID 请以官方页为准。',
  },
  {
    id: 'moonshot',
    order: 12,
    name: 'Moonshot 月之暗面 · Kimi',
    format: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    doc: 'https://platform.kimi.com/docs/api/chat',
    homepage: 'https://www.moonshot.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'kimi-k3', name: 'Kimi K3', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称原生支持视觉理解，100 万 token 上下文' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称支持视觉与文本输入，256k 上下文' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextLimit: 0, maxOutput: 0, note: '编码专向，256k' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code Highspeed', contextLimit: 0, maxOutput: 0, note: '上面那个的高速版' },
    ],
    note:
      '文档站已迁到 platform.kimi.com，但 API host 仍是 api.moonshot.cn，两者别混。' +
      'moonshot-v1 全系、kimi-k2、kimi-latest 等已被官方标为下线。' +
      '两个 code 变体的视觉能力官方未标注 —— 未能确认。',
  },
  {
    id: 'dashscope',
    order: 13,
    name: '阿里云百炼 · 通义千问',
    format: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    doc: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    homepage: 'https://www.aliyun.com/product/bailian',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'qwen3.8-max', name: '通义千问 3.8 Max', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen3.7-plus', name: '通义千问 3.7 Plus', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen3.8-flash', name: '通义千问 3.8 Flash', contextLimit: 0, maxOutput: 0, note: '官方模型表中当前在列的文本生成模型' },
      { id: 'qwen-long', name: '通义千问 Long', contextLimit: 0, maxOutput: 0, note: '兼容性页正文点名过的长文本模型' },
    ],
    note:
      '官方明确要求第三方客户端填的 Base URL 必须以 /compatible-mode/v1 结尾，且不要带 /chat/completions。' +
      '这里的 dashscope.aliyuncs.com 是官方标注的「旧域名，仍可用」；官方现在更推荐业务空间专属域名 ' +
      'https://{业务空间ID}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1（企业用户建议换成这个）。' +
      '新加坡地域换 dashscope-intl.aliyuncs.com。⚠ API Key 与地域绑定，跨地域会 401。' +
      '视觉：官方把 Qwen-VL 列为支持兼容协议的家族，但兼容页没列具体 VL 模型 ID —— 未能确认。' +
      '另有 Anthropic 格式端点：https://dashscope.aliyuncs.com/apps/anthropic',
  },
  {
    id: 'zhipu',
    order: 14,
    name: '智谱 GLM',
    format: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    doc: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    homepage: 'https://www.bigmodel.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', contextLimit: 0, maxOutput: 0, note: '旗舰，官方未标为视觉模型；1M 上下文 / 128K 输出' },
      { id: 'glm-5.2', name: 'GLM-5.2', contextLimit: 0, maxOutput: 0, note: '支持 thinking；官方未标为视觉模型' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称原生多模态，能理解图片/视频' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3 FlashX', contextLimit: 0, maxOutput: 0, vision: true, note: 'Flash 的更快版，同属多模态' },
      { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', contextLimit: 0, maxOutput: 0, vision: true, note: '多模态 Coding 基座' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '免费，视觉推理' },
    ],
    note:
      '官方 OpenAI 兼容页通篇用带尾斜杠的 https://open.bigmodel.cn/api/paas/v4/，' +
      '本应用存不带斜杠的写法，拼接时自己补（v4 已经含在 base 里，不会再补 /v1）。' +
      '另有 Anthropic 兼容端点 https://open.bigmodel.cn/api/anthropic（社区反映可能被 Coding Plan 门控，未在官方页确认）。',
  },
  {
    id: 'minimax',
    order: 15,
    name: 'MiniMax',
    format: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    doc: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
    homepage: 'https://www.minimax.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextLimit: 0, maxOutput: 0, vision: true, note: '支持图片/视频输入，1M 上下文' },
      { id: 'MiniMax-M3.1-Flash-Preview', name: 'MiniMax M3.1 Flash Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '官方注明暂时仅通过 M Plan 和 MiniMax Code 提供' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', contextLimit: 0, maxOutput: 0, note: '同上，速度更快' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
      { id: 'MiniMax-M2', name: 'MiniMax M2', contextLimit: 0, maxOutput: 0, note: '204,800 上下文；官方未标注视觉能力' },
    ],
    note:
      '⚠ 域名已变：现行官方文档的 API host 是 api.minimax.cn（国内）/ api.minimax.io（海外）。' +
      '老的 api.minimax.chat 和 api.minimaxi.com 在现在的官方文档里找不到作为 API 端点的证据 —— 未能确认。' +
      '另有 Anthropic 兼容端点 https://api.minimax.cn/anthropic',
  },
  {
    id: 'ark',
    order: 16,
    name: '火山方舟 · 豆包',
    format: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apikey',
    doc: 'https://docs.volcengine.com/docs/ark/chat-api',
    // 方舟自己的产品页路径（/product/ark）抓取拿不到内容，不按印象写；总部站点根已核对过
    homepage: 'https://www.volcengine.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-pro-260915', name: 'Doubao Seed 2.1 Pro', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-lite-260915', name: 'Doubao Seed 2.1 Lite', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
      { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao Seed 2.1 Turbo', contextLimit: 0, maxOutput: 0, note: '模型列表页「推荐」组' },
    ],
    note:
      '⚠ model 字段可能有两种填法：预置推理接入点填 Model ID（形如 doubao-seed-2-1-pro-260915），' +
      '自定义推理接入点填控制台里的 Endpoint ID（ep-xxxx）—— 「自定义接入点需填 Endpoint ID」这条' +
      '出自接入点文档页，本次未在 chat-api 页二次复核，填错会 404，遇到就换另一种试试。' +
      '官方模型列表页没有逐模型标注图片输入能力 —— 视觉未能确认。' +
      'Anthropic 协议只在 Coding Plan 下提供（https://ark.cn-beijing.volces.com/api/coding），且官方警告用错端点会额外计费。',
  },
  {
    id: 'siliconflow',
    order: 17,
    name: '硅基流动 SiliconFlow',
    format: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    doc: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    homepage: 'https://www.siliconflow.cn',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'deepseek-ai/DeepSeek-V3.1', name: 'DeepSeek V3.1', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'Qwen/Qwen3-32B', name: 'Qwen3 32B', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'zai-org/GLM-4.5', name: 'GLM-4.5', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'moonshotai/Kimi-K2-Instruct', name: 'Kimi K2 Instruct', contextLimit: 0, maxOutput: 0, note: '官方快速开始示例' },
      { id: 'Qwen/Qwen3-VL-32B-Instruct', name: 'Qwen3 VL 32B Instruct', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档里归在 VLM 组' },
    ],
    note:
      '模型 ID 是「组织/模型名」两段式，官方示例还出现过带 tier 前缀的三段式（Pro/deepseek-ai/DeepSeek-R1）。' +
      '国际站换 https://api.siliconflow.com/v1（CN 站的 key 能否通用，官方未声明 —— 未能确认）。' +
      '除显式标注的那个 VL 模型外，其余模型的视觉能力官方未逐项标注。',
  },

  // -------------------------------------------------------------------------
  // 国际
  // -------------------------------------------------------------------------
  {
    id: 'openai',
    order: 30,
    name: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    doc: 'https://developers.openai.com/api/docs',
    homepage: 'https://openai.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextLimit: 0, maxOutput: 0, vision: true, note: '官方称最新系列均支持文本+图像输入' },
    ],
    note:
      '⚠ Base URL：官方模型页没有直接写 base_url，这个值是按其官方示例里的 /v1/... 路径推导的，' +
      '不是文档原文直述 —— 未能 100% 确认（实际调用一直是这个）。' +
      'keyUrl 页面本身抓取返回 403，只有检索旁证 —— 未能确认。' +
      '新的旗舰模型可能只吃 max_completion_tokens 而不是 max_tokens，接入层遇到这个 400 会自动改名重试。',
  },
  {
    id: 'anthropic',
    order: 31,
    name: 'Anthropic Claude',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyUrl: 'https://platform.claude.com/settings/keys',
    doc: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    homepage: 'https://www.anthropic.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '当前 Opus，综合最稳，推荐默认' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '速度与能力平衡，日常主力' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextLimit: 0, maxOutput: 0, vision: true, note: '最便宜，适合测试连接/轻任务' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextLimit: 0, maxOutput: 0, vision: true, note: '最强的公开模型，价格也最高' },
    ],
    note:
      '端点 = {baseUrl}/v1/messages，必须带 anthropic-version: 2023-06-01（本应用自动带）。' +
      'system 是顶层字段；max_tokens 必填（接入层会给兜底值）。' +
      '官方文档现在把 Authorization: Bearer 列为主要的认证头，x-api-key 是仍被支持的 legacy fallback —— ' +
      '本应用对官方域名发 x-api-key（文档明确still supported），对第三方 Anthropic 兼容网关两个都发。' +
      '这些 ID 都是固定快照，不要自己加日期后缀。新版模型可能拒答（stop_reason=refusal），接入层会直接报错而不是给你空结果。',
  },
  {
    id: 'openrouter',
    order: 32,
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    doc: 'https://openrouter.ai/docs/quickstart',
    homepage: 'https://openrouter.ai',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: '~anthropic/claude-sonnet-latest', name: 'Claude Sonnet（latest 别名）', contextLimit: 0, maxOutput: 0, note: '官方快速开始页给的 ~ 别名形式' },
      { id: '~openai/gpt-sol-latest', name: 'OpenAI GPT Sol（latest 别名）', contextLimit: 0, maxOutput: 0, note: '官方快速开始页给的 ~ 别名形式' },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', contextLimit: 0, maxOutput: 0, note: 'API 参考页示例 slug' },
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', contextLimit: 0, maxOutput: 0, note: 'API 参考页示例 slug' },
    ],
    note:
      'model 必须带组织前缀（org/slug），上游模型更新很快，这里的 slug 只是示例 —— ' +
      '强烈建议点"测试连接"拉一次实时列表再选。视觉能力未逐项标注 —— 未能确认。',
  },
  {
    id: 'gemini',
    order: 33,
    name: 'Google Gemini',
    format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyUrl: 'https://aistudio.google.com/apikey',
    doc: 'https://ai.google.dev/gemini-api/docs/openai',
    // 没有面向 Gemini API 的独立"官网"，官方给开发者的入口就是 ai.google.dev（已核对可访问）
    homepage: 'https://ai.google.dev',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextLimit: 0, maxOutput: 0, vision: true, note: '官方 OpenAI 兼容页示例用的模型' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档对照表中出现' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', contextLimit: 0, maxOutput: 0, vision: true, note: '官方文档对照表中出现' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '预览版' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview', contextLimit: 0, maxOutput: 0, vision: true, note: '预览版' },
    ],
    note:
      '⚠ 必须带 /v1beta/openai 这一段，否则不是 OpenAI 协议（本应用会原样保留这段，不会再补 /v1）。' +
      '没有官方 Anthropic 兼容端点 —— 未能确认存在。' +
      '逐模型的 vision 标记官方没写，官方只说所有 Gemini 模型都是多模态，这里按 true 处理。' +
      'gemini-2.0-* 与 gemini-3-pro-preview 已 shut down，gemini-2.5-* 只对老用户开放，都没放进来。',
  },

  // -------------------------------------------------------------------------
  // 本机
  // -------------------------------------------------------------------------
  {
    id: 'ollama',
    order: 50,
    name: 'Ollama（本机）',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    keyUrl: '',
    doc: 'https://docs.ollama.com/api/openai-compatibility',
    homepage: 'https://ollama.com',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    local: true,
    jsonMode: false,
    models: [
      { id: 'qwen3:8b', name: 'Qwen3 8B', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull；ID 以你本地已拉的为准' },
      { id: 'qwen3-vl:8b', name: 'Qwen3 VL 8B', contextLimit: 0, maxOutput: 0, vision: true, note: '官方兼容页的 vision 示例模型' },
      { id: 'gpt-oss:20b', name: 'GPT-OSS 20B', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull' },
      { id: 'llama3.2', name: 'Llama 3.2', contextLimit: 0, maxOutput: 0, note: '需要先 ollama pull' },
    ],
    note:
      '本机端点，不需要 API Key（随便填或留空都行）。' +
      '官方明确前缀要带 /v1（裸 :11434 不行）。' +
      '模型 ID 取决于你本地已 pull 的东西，建议点"测试连接"拉实时列表。' +
      '默认不发 response_format（Ollama 对它的支持随版本变动）。',
  },
  {
    id: 'lmstudio',
    order: 51,
    name: 'LM Studio（本机）',
    format: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    keyUrl: '',
    doc: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    homepage: 'https://lmstudio.ai',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    local: true,
    jsonMode: false,
    models: [],
    note:
      '本机端点，不需要 API Key。官方文档刻意不给具体模型 ID（示例里写的是 ' +
      '"use the model identifier from LM Studio here"）—— 未能确认列表，' +
      '请加载好模型后点"测试连接"，从 /v1/models 拉取真实 ID 再填。',
  },

  // -------------------------------------------------------------------------
  // 兜底
  // -------------------------------------------------------------------------
  {
    id: 'custom',
    order: 99,
    name: '自定义 / 中转网关',
    format: 'openai',
    baseUrl: '',
    keyUrl: '',
    doc: '',
    // 自建/中转网关没有固定的官网 —— 留空。这里**绝不**填一个"看起来像"的地址：
    // 用户会点开它，然后得到一个跟这个应用毫无关系的站点。
    homepage: '',
    fullUrl: false,
    authField: '',
    userAgent: '',
    proxyHeader: '',
    proxyBody: '',
    billing: { enabled: false, inputPerM: 0, outputPerM: 0, currency: 'CNY' },
    models: [],
    note:
      '填任意 OpenAI 兼容或 Anthropic 兼容的 Base URL。可以只填域名（如 api.example.com），' +
      '接入层会自动补协议和 /v1；也可以整段粘贴完整的 chat/completions 地址，同样能识别。' +
      '模型 ID 请用"测试连接"从 /v1/models 拉取。',
  },
];

/** id -> preset */
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

/**
 * 按 id 取预设。取不到返回 undefined（上游要自己决定怎么提示，
 * 不要在这里悄悄回退成 custom —— 那会让用户以为配置生效了）。
 */
function getPreset(id) {
  if (typeof id !== 'string') return undefined;
  return BY_ID.get(id.trim());
}

module.exports = { PRESETS, getPreset };
