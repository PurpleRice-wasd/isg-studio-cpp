/* 设置：左提供商列表（带开关）+ 右详情 + 导入导出。
 *
 * 右详情区 1.4.0 起照用户给的参考截图重做（「编辑供应商」那种左标签右控件的排布）：
 *   名称 | 备注 → 官网 → API Key → 请求地址（完整 URL 开关）→ 橙色提示条
 *   → 高级选项（API 格式 / 认证字段）→ 测试连接 → 模型映射（含两个声明上限）
 *   → 默认兜底模型 → 单次输出上限 → 分阶段用不同模型 → User-Agent
 *   → 本地代理请求覆盖 → 配置 JSON → 计费配置
 * 其中「高级选项 / 模型映射 / 分阶段用不同模型 / 配置 JSON」四节可折叠，**默认收起**。
 * 折叠写法照 views/run.js 的 panel()（按钮 aria-expanded + 翻转 body.hidden），
 * 状态存在模块级 foldState 里 —— 重画时不记住的话，用户展开的区会自己合上。
 *
 * 字段名以 DESIGN-1.4.0.md §1 为准。新增的每一个字段都必须走三处：normalize() 里读进来、
 * serializable() 里参与"有没有改动"的比较、save() 里发回主进程 —— 漏掉最后一处的症状是
 * "界面上改了、保存后一切照旧"，而且界面上看不出任何异常。 */
(function () {
  'use strict';

  var root = null, ctx = null, el, icon;
  var draft = null;            // 模块级：离开页面再回来，没保存的改动还在
  var origJson = '';
  var selId = '';
  var testState = {};          // providerId -> {status:'idle'|'busy'|'ok'|'bad', text}
  var listBox, detailBox, footBox, noticeBox;
  var settingsWatcher = null;
  // 背景图：状态本身住在 app.js（ctx.bgState，整窗图层归它管），这里只管这一块界面
  var bgStateBox = null, bgAdjustBox = null;
  var rangeScrim = null, rangeBlur = null;
  var cancelBox = null;        // 「取消任务时」那一块（两个字段，立即保存）
  var importing = false;       // 导入进行中（系统文件对话框开着）

  /* ---------- 数据规整 ---------- */

  /**
   * 一个模型项。1.4.0 起 `providers.<id>.models` 是**对象数组**
   * （老设置文件里是字符串数组，store 的 sanitize 已经折过一道；这里再折一次是防着
   * 老配置、以及第三方脚本直接把字符串塞回来的情况）。
   *
   * `contextLimit` / `maxOutput` 是**用户声明的上限**，`0` = 未声明。
   * 界面上必须把它显示成「未声明」而不是一个 0 —— 0 看起来像"这个模型最多输出 0 个 token"，
   * 而它真正的含义是"我不知道，请沿用从前的做法"（见 pipeline 的 resolveTokenPlan）。
   */
  function normModel(m) {
    if (typeof m === 'string') return { id: m, name: '', contextLimit: 0, maxOutput: 0, vision: false, note: '' };
    return {
      id: m.id || m.model || m.name || '',
      name: m.name && m.name !== m.id ? m.name : '',
      contextLimit: tokensOf(m.contextLimit, TOKEN_LIMIT_MAX),
      maxOutput: tokensOf(m.maxOutput, TOKEN_LIMIT_MAX),
      vision: !!m.vision,
      note: m.note || ''
    };
  }

  /**
   * "有没有 Key / 掩码是什么"——以 store 的形状为准：
   * `store.getPublicSettings()` 给的是 provider 级的扁字段 `hasKey` / `keyHint`
   * （**没有** apiKey 子对象）。apiKey 的几种老写法只是兼容着，别再往新代码里抄。
   */
  function hasKeyOf(p) {
    if (typeof p.hasKey === 'boolean') return { hasKey: p.hasKey, hint: p.keyHint || '' };
    var k = p.apiKey;
    if (k === true) return { hasKey: true, hint: '' };
    if (typeof k === 'string') return k ? { hasKey: true, hint: mask(k) } : { hasKey: false, hint: '' };
    if (k && typeof k === 'object') return { hasKey: !!k.hasKey, hint: k.hint || '' };
    return { hasKey: false, hint: '' };
  }
  function mask(k) {
    k = String(k);
    return k.length > 8 ? k.slice(0, 3) + '…' + k.slice(-4) : '已填写';
  }

  /**
   * 设置 → 内部草稿。
   *
   * `store.providers` 是**以 id 为键的对象 map**（`{deepseek:{…}, custom:{…}}`），
   * 不是数组 —— 这里必须用 Object.entries 摊平，每项带上自己的 id。
   * （旧写法用 Array.isArray 判断，拿到 map 就当空数组 → 设置页永远是 0 家提供商。）
   */
  function normalize(s) {
    s = s || {};
    var raw = s.providers;
    var list;
    if (Array.isArray(raw)) list = raw;                       // 老形状，兼容
    else if (raw && typeof raw === 'object') {
      list = Object.keys(raw).map(function (id) {
        var p = raw[id];
        return (p && typeof p === 'object') ? Object.assign({ id: id }, p) : { id: id };
      });
    } else list = Array.isArray(s.presets) ? s.presets : [];

    var providers = list.map(function (p, i) {
      if (!p || typeof p !== 'object') p = { id: 'p' + i };
      var km = hasKeyOf(p);
      return {
        id: p.id || ('p' + i),
        name: p.name || p.id || '未命名',
        format: (String(p.format || '').toLowerCase() === 'anthropic') ? 'anthropic' : 'openai',
        baseUrl: p.baseUrl || p.base_url || '',
        enabled: p.enabled !== false,
        keyUrl: p.keyUrl || p.key_url || '',
        doc: p.doc || '',
        note: p.note || '',
        /* 1.4.0 新增的「请求整形」字段（DESIGN-1.4.0 §1.1）。
           每一个都要原样带回界面：这些是**用户自己能看见、要能改**的配置，
           界面不显示的那个字段等于没保存（"界面上开了开关、请求一点没变"就是这个仓库
           反复禁止的假修复）。 */
        homepage: p.homepage || '',
        fullUrl: p.fullUrl === true,             // 只认显式 true：手写的 "false" 不能翻转成真
        authField: authFieldOf(p.authField),
        userAgent: typeof p.userAgent === 'string' ? p.userAgent : '',
        proxyHeader: typeof p.proxyHeader === 'string' ? p.proxyHeader : '',
        proxyBody: typeof p.proxyBody === 'string' ? p.proxyBody : '',
        billing: billingOf(p.billing),
        hasKey: km.hasKey,
        keyHint: km.hint,
        // Key 来自 .env / 系统环境变量（不在应用配置里）：界面必须说清楚，
        // 否则用户会以为是自己填进去的、"删掉配置就能删掉"。
        keyFromEnv: !!p.keyFromEnv,
        keyFrom: p.keyFrom || p.key_from || '',
        models: Array.isArray(p.models) ? p.models.map(normModel) : [],
        defaultModel: p.defaultModel || p.default_model || '',
        isCustom: !!p.isCustom
      };
    });

    // 当前使用哪一家、哪家哪个模型：**以 store.active 为准**（流水线读的就是它）。
    var active = (s.active && typeof s.active === 'object') ? s.active : {};
    // 分阶段模型（§1.2）：空串 = 用 active.model。它**不分提供商**，所以挂在草稿顶层，
    // 不在某一家里面 —— 放进去的话，切一次提供商就会把它跟着搬走。
    var stages = (active.stages && typeof active.stages === 'object') ? active.stages : {};
    var activeProvider = active.provider || s.provider || s.currentProvider || '';
    if (!providerIdOf(providers, activeProvider)) activeProvider = providers[0] ? providers[0].id : '';

    // 反向回填：active.model → 那一家的 defaultModel；没有的退回第一个模型。
    // 这样"当前用的模型"在界面上有且只有一个来源，来回保存不会漂移。
    providers.forEach(function (p) {
      if (p.id === activeProvider && active.model) p.defaultModel = active.model;
      if (!p.defaultModel && p.models.length) p.defaultModel = p.models[0].id;
    });

    // ui.bgImage 由**主进程**在导入/移除时写（见 bg.js / ipc.js），界面不通过保存去改它；
    // 导入/移除成功后只在本地这份 state 镜像上跟一下（下面 doImport/doClear 那两处），
    // 免得同一个会话里别的地方读到旧值。
    //
    // 注意：**当前显示哪张背景图，权威来源是 backgroundInfo()**（它直接扫
    // userData/background/ 目录），不是这个字段。用户手工把图片文件删掉时，
    // 这个字段会残留旧名字、而 backgroundInfo() 会如实返回"没有"——以它为准。
    // 这里只带出两个用户可调的数值；主进程侧还有一层范围钳制，所以读到脏值也不怕。
    var ui = (s.ui && typeof s.ui === 'object') ? s.ui : {};
    // .env 的状态：主进程只报"读了哪个文件、哪些变量这次真的生效"，**不含任何 Key 值**
    var env = (s.env && typeof s.env === 'object') ? s.env : {};

    return {
      provider: activeProvider,
      providers: providers,
      stages: {
        analyze: String(stages.analyze || ''),
        audit: String(stages.audit || '')
      },
      // `generation.maxOutput`（§1.3）：0 = 自动。它在界面上和模型声明放在一起，
      // 但它属于 generation 而不是某一家提供商 —— 所以单独挂在草稿顶上，不进 providers。
      gen: { maxOutput: maxOutputOf((s.generation && s.generation.maxOutput)) },
      theme: s.theme || ctx.state.theme || 'auto',
      keyStorage: s.keyStorage || s.key_storage || '',
      outputDir: s.outputDir || '',
      ui: {
        bgScrim: clampRange(ui.bgScrim, 0, 90, 35),
        bgBlur: clampRange(ui.bgBlur, 0, 24, 6)
      },
      env: {
        file: env.file || '',
        found: !!env.found,
        error: env.error || '',
        used: Array.isArray(env.used) ? env.used.slice() : []
      }
    };
  }

  function clampRange(v, lo, hi, dv) {
    var n = Number(v);
    if (!isFinite(n)) return dv;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  }

  function providerIdOf(list, id) {
    if (!id) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  /** 某一家当前选中的默认模型（= 要写进 settings.active.model 的值） */
  function modelOf(list, id) {
    var p = providerIdOf(list, id);
    if (!p) return '';
    return p.defaultModel || (p.models[0] ? p.models[0].id : '') || '';
  }

  /**
   * 刚添加的「自定义提供商」的初始草稿。
   * 单独一个函数是为了让**新字段只在这里补一次** —— 以前它写在「添加」按钮的回调里，
   * 于是每加一个新字段就得回去找那个回调，漏一个的症状是"自定义提供商没有那一栏"，
   * 而预设那几家全都正常，很难往这里想。
   */
  function blankProvider(id) {
    return {
      id: id, name: '自定义提供商', format: 'openai', baseUrl: '', enabled: true,
      keyUrl: '', doc: '', note: '', homepage: '',
      fullUrl: false, authField: '', userAgent: '', proxyHeader: '', proxyBody: '',
      billing: billingOf(null),
      hasKey: false, keyHint: '', keyFromEnv: false, keyFrom: '',
      models: [], defaultModel: '', isCustom: true
    };
  }

  /** 兜底模型必须落在现有的模型里。模型被删掉或改了 id 之后它可能指着一个不存在的字符串，
   *  而那会让"生成时用哪个模型"变成一句 NO_MODEL 的报错，用户还看不出是自己删模型引起的。 */
  function syncDefault(p) {
    if (!p.defaultModel || !p.models.some(function (m) { return m.id === p.defaultModel; })) {
      p.defaultModel = p.models.length ? p.models[0].id : '';
    }
  }

  /* ---------- 1.4.0 新字段用的小工具 ---------- */

  /* 与 store.sanitize 同名的两个长度上限。写在这里不是为了"帮主进程把关"——
     主进程该截还是会截 —— 而是让 maxlength 和那句说明跟它对齐：
     两边对不上时，用户会看到"我明明填了 800 字，保存回来只剩 500"。 */
  var TEXT_MAX = 500;            // name / note / homepage / userAgent
  var PROXY_MAX = 8000;          // proxyHeader / proxyBody（整段 JSON 文本）
  var TOKEN_LIMIT_MAX = 2000000; // 单个模型声明的上限（tokens）

  /** 只认识这三个 authField（见 llm/openai.js 的 AUTH_FIELDS），认不得的一律当"没选"。 */
  var AUTH_FIELDS = ['auth_header', 'api_key_header', 'query'];
  function authFieldOf(v) {
    var s = String(v == null ? '' : v);
    return AUTH_FIELDS.indexOf(s) >= 0 ? s : '';
  }

  /** 1M 就是二进制兆 1048576（官方标称的"1M 上下文"是它，不是 1000000）。
   *  写成 1000000 会差 4.8 万 token —— 对"声明上限"这种要跟服务端硬限对齐的数，这就是个错数。 */
  var ONE_M = 1048576;

  /** tokens 数字：非法/负数一律归 0。0 在界面上的意思是「未声明」，不是一个真的上限。 */
  function tokensOf(v, max) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(max, Math.round(n));
  }

  /**
   * `generation.maxOutput`：0 = 自动。钳制规则与 store.sanitize **逐字对齐**
   * （0 或 2000..200000）。不对齐的话，界面上填 500、实际存成 2000，
   * 而用户手里没有任何线索能看出是被改过的。
   */
  function maxOutputOf(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    if (n < 2000) return 2000;
    return Math.min(200000, Math.round(n));
  }

  /** 计费配置：单价不取整（按百万 tokens 计价本来就是小数），负数/非数字归 0。 */
  function billingOf(b) {
    b = (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
    var money = function (v) {
      var n = Number(v);
      return isFinite(n) && n > 0 ? Math.min(100000, n) : 0;
    };
    var cur = typeof b.currency === 'string' ? b.currency.trim().slice(0, 8) : '';
    return { enabled: b.enabled === true, inputPerM: money(b.inputPerM), outputPerM: money(b.outputPerM), currency: cur || 'CNY' };
  }

  /**
   * 把一段 JSON 文本框验一道：不合法就返回一句人话（**带行号**），合法返回 ''。
   *
   * 为什么要行号：这两段通常是用户从中转站的文档里整段粘来的，一眼看不出哪儿多了个逗号；
   * 只说一句"不是合法的 JSON"，他只能整段重敲。空串 = 没配，直接放行（等价于不覆盖）。
   * 另外要求它是个**对象**：解析出来是数组/数字时，后面"合并进请求头"那一步会静默变成空操作。
   */
  function jsonProblem(text, what) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return '';
    var v;
    try {
      v = JSON.parse(s);
    } catch (e) {
      var msg = (e && e.message) || '不是合法的 JSON';
      var where = '';
      var lm = /line (\d+)/i.exec(msg);                       // 新版 V8 直接给行号
      if (lm) where = '第 ' + lm[1] + ' 行';
      else {
        var pm = /position (\d+)/i.exec(msg);                 // 老版只给字符偏移，自己数一下
        if (pm) where = '第 ' + (s.slice(0, Number(pm[1])).split('\n').length) + ' 行';
      }
      return what + (where ? where + '：' : '：') + msg;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return what + '要是一个 JSON 对象（形如 {"X-Provider": "abc"}），现在这段是' +
        (Array.isArray(v) ? '数组' : typeof v) + '。';
    }
    return '';
  }

  /** 哪一家的请求覆盖写坏了 —— 返回 {p, message, field} 或 null。
   *  保存前用它拦一道：等生成时才炸的话，用户已经白等了一轮。 */
  function badProxyOf() {
    for (var i = 0; i < draft.providers.length; i++) {
      var p = draft.providers[i];
      var m = jsonProblem(p.proxyHeader, '「Header 覆盖」');
      if (m) return { p: p, message: m, field: 'proxyHeader' };
      m = jsonProblem(p.proxyBody, '「Body 覆盖」');
      if (m) return { p: p, message: m, field: 'proxyBody' };
    }
    return null;
  }

  /* ---------- 折叠区 ----------
   *
   * 仓库里没有 `<details>` 的先例，照 views/run.js 的 panel() 来：按钮带 aria-expanded，
   * 点一下翻转 body.hidden，「展开 / 收起」的文案跟着切。
   *
   * ⚠️ 折叠状态存在模块级的 foldState 里，**不是**只在 DOM 上。
   * 理由：refreshDetail() 会在十几个地方被整块重画（删一个模型、一键设置、测试连接成功、
   * 套用 JSON…）。状态只活在 DOM 上的话，用户展开的那一节会在下一次重画时自己合上 ——
   * 而那看起来像界面在跟他作对，他会以为"展开"这个按钮是坏的。
   */
  var foldState = {};   // '<providerId>:<key>' -> true（展开）

  /**
   * 一个折叠区。返回的 open/close 是**直接翻 DOM**（不是重画整页）——
   * 重画会把调用方手里的节点引用全部作废，"点一下工具按钮、结果落在刚画出来的表格里"
   * 这种联动就做不成了。
   */
  function foldSection(p, key, title, opts) {
    opts = opts || {};
    var k = p.id + ':' + key;
    var open = opts.open === true || foldState[k] === true;
    var body = el('div', { class: 'fold-body' });
    body.hidden = !open;
    var stateText = el('span', { class: 'fold-state', text: open ? '收起' : '展开' });
    var head = el('button', {
      class: 'fold-head', type: 'button', 'aria-expanded': open ? 'true' : 'false',
      'aria-label': (open ? '收起' : '展开') + title,
      on: {
        click: function () {
          var now = head.getAttribute('aria-expanded') === 'true';
          setOpen(!now);
        }
      }
    }, [icon('chevron'), el('span', { class: 'fold-title', text: title }), stateText]);

    function setOpen(want) {
      foldState[k] = want;
      head.setAttribute('aria-expanded', want ? 'true' : 'false');
      body.hidden = !want;
      stateText.textContent = want ? '收起' : '展开';
      if (want && opts.onOpen) { try { opts.onOpen(); } catch (e) { } }
    }

    var tools = el('div', { class: 'fold-tools' });
    var node = el('div', { class: 'fold' }, [
      el('div', { class: 'fold-row' }, [head, tools]),
      opts.note ? el('div', { class: 'fold-note hint', text: opts.note }) : null,
      body
    ]);
    // 展开时才画内容：默认收起的那几节里，模型表格和 JSON 都是"重"的
    if (open && opts.onOpen) { try { opts.onOpen(); } catch (e) { } }
    return { node: node, body: body, head: head, tools: tools, open: function () { setOpen(true); }, close: function () { setOpen(false); } };
  }

  /** 切换提供商/重画之后把某个字段滚到眼前并聚焦（保存被拦下来时用）。 */
  function focusField(name) {
    if (!detailBox) return;
    var n = detailBox.querySelector('[data-field="' + name + '"]');
    if (!n) return;
    try { if (n.scrollIntoView) n.scrollIntoView({ block: 'center' }); } catch (e) { }
    try { n.focus({ preventScroll: true }); } catch (e) { }
  }

  /** 草稿里"值得比一比"的那份快照。漏掉新字段的症状是：改了它、底部却还说"所有改动都已保存"，
   *  于是「保存」按钮是灰的 —— 用户会以为这个框是坏的。所以新字段必须逐个加进来。 */
  function serializable() {
    return JSON.stringify({
      provider: draft.provider,
      theme: draft.theme,
      stages: draft.stages,
      maxOutput: (draft.gen || {}).maxOutput,
      providers: draft.providers.map(function (p) {
        return {
          id: p.id, name: p.name, format: p.format, baseUrl: p.baseUrl,
          enabled: p.enabled, models: p.models, defaultModel: p.defaultModel,
          note: p.note, homepage: p.homepage, fullUrl: !!p.fullUrl, authField: p.authField,
          userAgent: p.userAgent, proxyHeader: p.proxyHeader, proxyBody: p.proxyBody,
          billing: p.billing,
          keyTouched: !!p.keyInput || !!p.clearKey
        };
      })
    });
  }
  function isDirty() { return serializable() !== origJson; }

  function provider(id) {
    for (var i = 0; i < draft.providers.length; i++) if (draft.providers[i].id === id) return draft.providers[i];
    return null;
  }

  /* ---------- 顶栏提示 ---------- */

  function renderNotice() {
    noticeBox.innerHTML = '';
    if (!draft) return;
    if (draft.keyStorage === 'plaintext') {
      var path = (ctx.state.appInfo && ctx.state.appInfo.settingsPath) || '';
      noticeBox.appendChild(el('div', { class: 'banner warn' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '注意：API Key 现在是以明文存在磁盘上的' }),
          el('div', { text: '这台机器上系统的加密存储不可用（Linux 上常见），所以 Key 没有加密。' +
            '共用电脑的话，建议改用环境变量，或者用完把 Key 清掉。' }),
          path ? el('div', { class: 'hint mono', text: '配置文件：' + path }) : null
        ])
      ]));
    }
  }

  /* ---------- 左：提供商列表 ---------- */

  function buildList() {
    var wrap = el('div', { class: 'card' });
    wrap.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: '提供商' }),
      el('div', { class: 'right' }, [el('span', { class: 'hint', text: draft.providers.length + ' 家' })])
    ]));

    var list = el('div', { class: 'provider-list' });
    if (!draft.providers.length) {
      list.appendChild(el('div', { class: 'hint', style: 'padding:8px 2px', text: '还没拿到任何提供商预设。可以点下面的「添加自定义提供商」手动填。' }));
    }
    draft.providers.forEach(function (p) {
      var isCur = p.id === draft.provider;
      var sw = el('input', {
        type: 'checkbox', 'aria-label': '启用或停用 ' + p.name,
        on: {
          change: function () {
            p.enabled = sw.checked;
            refreshFoot();
          },
          click: function (e) { e.stopPropagation(); }
        }
      });
      sw.checked = p.enabled;

      var row = el('div', {
        class: 'provider-row', role: 'button', tabindex: '0',
        'aria-selected': String(p.id === selId),
        on: {
          click: function () { selId = p.id; refreshDetail(); refreshList(); },
          keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selId = p.id; refreshDetail(); refreshList(); } }
        }
      }, [
        el('span', { class: 'pv-icon', 'aria-hidden': 'true', text: (p.name || '?').slice(0, 1).toUpperCase() }),
        el('span', { class: 'pv-body' }, [
          el('span', { class: 'pv-name' }, [
            el('span', { text: p.name }),
            isCur ? el('span', { class: 'pv-star', title: '当前使用', text: '★ 当前' }) : null
          ]),
          // 这一行窄的时候会被省略号截掉，所以 title 上放全文（鼠标停一下能看全）
          el('span', {
            class: 'pv-sub',
            title: p.keyFromEnv ? 'Key 来自 .env / 环境变量（' + (p.keyFrom || '环境变量') + '）' : '',
            text: !p.hasKey ? '还没配 Key'
              : (p.keyFromEnv ? '来自 .env · ' : '已配 Key · ') + (p.models.length || 0) + ' 个模型'
          })
        ]),
        el('label', { class: 'switch', title: p.enabled ? '已启用' : '已停用' }, [sw, el('span', { class: 'track' })])
      ]);
      list.appendChild(row);
    });
    wrap.appendChild(list);

    wrap.appendChild(el('div', { style: 'margin-top:12px' }, [
      el('button', {
        class: 'btn sm block', type: 'button',
        on: {
          click: function () {
            var id = 'custom-' + Date.now().toString(36);
            draft.providers.push(blankProvider(id));
            selId = id;
            refreshList(); refreshDetail(); refreshFoot();
          }
        }
      }, [icon('plus'), el('span', { text: '添加自定义提供商' })])
    ]));
    return wrap;
  }

  function refreshList() {
    if (!listBox) return;
    listBox.innerHTML = '';
    listBox.appendChild(buildList());
  }

  /* ---------- 右：详情 ---------- */

  /** label 可以是字符串，也可以是一个节点（例如「API Key + 来自 .env」那一行） */
  function fieldRow(label, control, hint) {
    return el('div', { class: 'field' }, [
      el('span', { class: 'lbl' }, [label]),
      control,
      hint ? el('div', { class: 'hint', text: hint }) : null
    ]);
  }

  function buildDetail() {
    var p = provider(selId) || draft.providers[0];
    if (!p) {
      return el('div', { class: 'card' }, [ctx.emptyState({
        icon: 'key', title: '还没有提供商',
        text: '左边点「添加自定义提供商」，填上 Base URL 和 API Key 就能用了。'
      })]);
    }
    selId = p.id;
    var wrap = el('div', { class: 'card' });

    /* 头 */
    var curPill = (p.id === draft.provider)
      ? el('span', { class: 'pill field' }, [el('span', { class: 'dot' }), el('span', { text: '当前使用' })])
      : el('button', {
        class: 'btn sm', type: 'button', text: '设为当前使用',
        on: {
          click: function () {
            draft.provider = p.id;
            refreshList(); refreshDetail(); refreshFoot();
            ctx.toast('已把「' + p.name + '」设为当前使用', 'ok');
          }
        }
      });

    wrap.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: p.name }),
      el('div', { class: 'right' }, [
        p.enabled ? el('span', { class: 'pill ok', text: '已启用' }) : el('span', { class: 'pill', text: '已停用' }),
        curPill
      ])
    ]));

    /* ---------- 名称 | 备注（截图里并排的两列） ----------
       名称以前只能来自预设、界面不给改 —— 想区分「公司号 / 个人号」就只能去动 id，
       而 id 是这一家在 settings.json 里的键（身份），动了等于换一家。
       所以给一个可改的显示名：只影响这一页显示，请求里用不到它。 */
    var nameInput = el('input', {
      type: 'text', spellcheck: 'false', maxlength: String(TEXT_MAX),
      value: p.name || '', 'aria-label': '供应商显示名称',
      placeholder: p.isCustom ? '例如：公司专用中转' : '',
      on: { input: function () { p.name = nameInput.value; refreshFoot(); } }
    });
    var noteInput = el('input', {
      type: 'text', spellcheck: 'false', maxlength: String(TEXT_MAX),
      value: p.note || '', 'aria-label': '备注', placeholder: '例如：公司专用账号',
      on: { input: function () { p.note = noteInput.value; refreshFoot(); } }
    });
    wrap.appendChild(el('div', { class: 'duo' }, [
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '供应商名称' }), nameInput,
        el('div', { class: 'hint', text: '只改这一页的显示名，不影响请求。' })
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '备注' }), noteInput,
        el('div', { class: 'hint', text: '写给自己看的，比如这个 Key 是谁的、给谁用。' })
      ])
    ]));

    /* ---------- 官网链接 ---------- */
    var homeInput = el('input', {
      type: 'text', spellcheck: 'false', maxlength: String(TEXT_MAX),
      value: p.homepage || '', placeholder: 'https://example.com', 'aria-label': '官网链接',
      on: { input: function () { p.homepage = homeInput.value.trim(); refreshFoot(); } }
    });
    wrap.appendChild(fieldRow('官网链接', homeInput, '这家服务商的官网，「获取 API Key」那个链接就指向它。不影响请求。'));

    /* API Key */
    var km = { hasKey: p.hasKey, hint: p.keyHint };
    var keyInput = el('input', {
      type: 'password', id: 'st-key', autocomplete: 'off', spellcheck: 'false',
      placeholder: km.hasKey ? ('已保存 ' + (km.hint || '') + '（留空不改）') : '粘贴 API Key，例如 sk-…',
      'aria-label': 'API Key',
      on: {
        input: function () {
          p.keyInput = keyInput.value;
          if (keyInput.value) { p.clearKey = false; p.hasKey = true; km.hasKey = true; }
          refreshFoot();
        }
      }
    });
    keyInput.value = '';
    var eyeBtn = el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': '显示或隐藏 API Key',
      on: {
        click: function () {
          var show = keyInput.type === 'password';
          keyInput.type = show ? 'text' : 'password';
          eyeBtn.innerHTML = '';
          eyeBtn.appendChild(icon(show ? 'eyeOff' : 'eye'));
          eyeBtn.setAttribute('aria-label', show ? '隐藏 API Key' : '显示 API Key');
        }
      }
    }, icon('eye'));

    var keyUploader = el('div', { class: 'input-affix' }, [keyInput, eyeBtn]);

    var keyRow = el('div', { class: 'input-row' }, [
      keyUploader,
      km.hasKey ? el('button', {
        class: 'btn', type: 'button', text: '清除',
        on: {
          click: function () {
            ctx.confirm('清除这家提供商的 API Key？', '只是把本地保存的 Key 删掉，不会影响你在服务商那边的账户。', '清除').then(function (ok) {
              if (!ok) return;
              p.keyInput = ''; p.clearKey = true; p.hasKey = false; p.keyHint = '';
              keyInput.value = '';
              keyInput.placeholder = '粘贴 API Key，例如 sk-…';
              refreshDetail(); refreshFoot();
              ctx.toast('保存后生效', 'info');
            });
          }
        }
      }) : null
    ]);

    var keyHint = el('div', { class: 'hint' }, [
      el('span', { text: 'Key 只存在本机，不会进日志、不会进导出的配置；渲染进程拿不到明文。' })
    ]);

    /* 「获取 API Key」外链（截图里就在 Key 输入框下面一行）。
       ⚠️ 预设里的 keyUrl（直达"创建 API Key"那一页，见 providers.js）**不在**主进程的
       公开白名单里（PROVIDER_FIELDS_PUBLIC 没有它），渲染层根本收不到它；
       这里能拿到的只有 homepage。所以：keyUrl 有就用（哪天白名单放开了自动生效），
       没有就退到官网 —— 并且把目标域名写在旁边，别让用户点一个不知道会去哪的链接。 */
    var keySite = p.keyUrl || p.homepage || '';
    if (keySite) {
      var host = '';
      try { host = new URL(keySite).host; } catch (e) { host = keySite; }
      wrap.appendChild(el('div', { class: 'key-get' }, [
        el('button', {
          class: 'btn sm ghost', type: 'button',
          title: '用系统浏览器打开 ' + keySite,
          on: { click: function () { openKeyUrl(keySite); } }
        }, [el('span', { text: '获取 API Key' }), icon('external')]),
        el('span', { class: 'hint', text: '去 ' + host + ' 拿一把新的' })
      ]));
    }

    /* Key 是从 .env / 环境变量来的：这一行要一眼看出来，并且说清"填了也会被盖住"。
       不说的话用户会以为输入框里填的值生效了 —— 实际上环境变量优先级更高。 */
    var keyLabel = p.keyFromEnv
      ? el('span', { style: 'display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap' }, [
        el('span', { text: 'API Key' }),
        el('span', {
          class: 'pill info', title: '这个 Key 不在应用配置里，来自 .env / 环境变量',
          text: '来自 .env · ' + (p.keyFrom || '环境变量')
        })
      ])
      : 'API Key';

    wrap.appendChild(fieldRow(keyLabel, keyRow, null));
    if (p.keyFromEnv) {
      wrap.appendChild(el('div', { class: 'hint' }, [
        el('span', {
          text: '这个 Key 是从 .env / 环境变量读到的（' + (p.keyFrom || '环境变量') +
            '），不在应用配置里：把这里清空也不会影响它。环境变量里的值优先级更高，会盖住这里填的 —— ' +
            '想让这里填的生效，得先把那个变量去掉。'
        })
      ]));
    }
    wrap.appendChild(keyHint);

    /* ---------- 请求地址（+「完整 URL」开关） ---------- */
    var baseInput = el('input', {
      type: 'text', id: 'st-base', spellcheck: 'false', value: p.baseUrl || '',
      'aria-label': '请求地址',
      on: {
        input: function () { p.baseUrl = baseInput.value.trim(); refreshFoot(); },
        // 失焦时把"去掉首尾空格"这件事回填到界面上：从浏览器地址栏粘过来的地址常带空格，
        // 不回填的话，用户看到的和存下去的就是两个不同的字符串
        blur: function () { baseInput.value = p.baseUrl; }
      }
    });
    var fullUrlCb = el('input', {
      type: 'checkbox', 'aria-label': '把这一行当成完整请求地址',
      on: { change: function () { p.fullUrl = fullUrlCb.checked; paintBase(); refreshFoot(); } }
    });
    fullUrlCb.checked = !!p.fullUrl;

    var baseHint = el('div', { class: 'hint' });
    function paintBase() {
      baseInput.placeholder = p.format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com/v1';
      baseHint.textContent = p.fullUrl
        ? '这一行就是完整请求地址：程序一个字都不再往后拼，直接拿它发请求。要从别处粘一个以 /v1/chat/completions 结尾的地址过来时，打开这个开关。'
        : '这一行是接口根路径：程序会在后面接上 ' +
          (p.format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions') +
          ' 这类端点路径，所以一般填到 /v1 为止（Anthropic 官方不用加）。';
    }

    wrap.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'row-between' }, [
        el('span', { class: 'lbl', text: '请求地址' }),
        el('div', { class: 'sw-inline' }, [
          el('span', { class: 'sw-label', text: '完整 URL' }),
          el('label', { class: 'switch', title: '这一行是不是完整请求地址' }, [fullUrlCb, el('span', { class: 'track' })])
        ])
      ]),
      baseInput,
      baseHint
    ]));
    paintBase();

    /* ---------- 橙色提示条 ----------
       这条不是装饰：地址末尾多一个 `/` 确实会让一部分网关直接 404，
       而界面上、日志里都只会看到一句"连接失败"，用户根本不会想到是那个斜杠。 */
    wrap.appendChild(el('div', { class: 'banner warn' }, [
      icon('alert'),
      el('div', { class: 'bt' }, [
        el('b', { text: '填请求地址时不要以 / 结尾' }),
        el('div', { text: '末尾那个斜杠会和程序后面拼上去的路径连成 //v1/chat/completions 这种双斜杠，' +
          '一部分网关会因此报 404，而界面上看不出任何异常。' })
      ])
    ]));

    /* ---------- 高级选项（折叠） ---------- */
    var authHint = el('div', { class: 'hint' });
    /** Auth Field 的说明**必须跟着 API 格式走**：同一个选项在两种格式下落的头不一样
     *  （OpenAI 适配器写 `api-key`，Anthropic 适配器写 `x-api-key`），说反了等于把用户
     *  往一个必然 401 的配置上推。见 llm/openai.js 与 llm/anthropic.js 的 buildHeaders。 */
    function paintAuth() {
      var f = p.format === 'anthropic' ? 'anthropic' : 'openai';
      var a = authFieldOf(p.authField);
      var map = {
        'openai:': '没指定就用这一种格式的默认：发 Authorization: Bearer <Key>。绝大多数中转站要的就是它。',
        'openai:auth_header': '只发 Authorization: Bearer <Key>（与默认同址，但此时只发它）。',
        'openai:api_key_header': '只发 api-key: <Key> —— 注意是 api-key 这个自定义头，不是 Authorization。少数网关只认它。',
        'openai:query': '一个鉴权头都不发，Key 拼在请求地址上（?key=<Key>）。少数中转只认这种。',
        'anthropic:': '没指定就按 Anthropic 的默认来：官方域名只发 x-api-key: <Key>；第三方 Claude 兼容网关两个头都发（x-api-key + Authorization），兼容性最好。',
        'anthropic:auth_header': '只发 Authorization: Bearer <Key>，不再叠加 x-api-key（有些网关对多出来的凭据头直接判鉴权失败）。',
        'anthropic:api_key_header': '只发 x-api-key: <Key> —— Claude 官方就是这一种。',
        'anthropic:query': '一个鉴权头都不发，Key 拼在请求地址上（?key=<Key>）。少数中转只认这种。'
      };
      authHint.textContent = map[f + ':' + a] || '';
    }

    var fmtSel = el('select', {
      'aria-label': 'API 格式',
      on: {
        change: function () {
          p.format = fmtSel.value === 'anthropic' ? 'anthropic' : 'openai';
          paintBase(); paintAuth(); refreshFoot();
        }
      }
    }, [
      el('option', { value: 'openai', text: 'OpenAI 兼容（/v1/chat/completions）' }),
      el('option', { value: 'anthropic', text: 'Anthropic 原生（/v1/messages）' })
    ]);
    fmtSel.value = p.format;

    var authSel = el('select', {
      'aria-label': '认证字段',
      on: { change: function () { p.authField = authFieldOf(authSel.value); paintAuth(); refreshFoot(); } }
    }, [
      el('option', { value: '', text: '按 API 格式用默认' }),
      el('option', { value: 'auth_header', text: 'Authorization: Bearer <Key>' }),
      el('option', { value: 'api_key_header', text: 'API Key 专用头（api-key / x-api-key）' }),
      el('option', { value: 'query', text: '查询参数 ?key=<Key>' })
    ]);
    authSel.value = authFieldOf(p.authField);

    var adv = foldSection(p, 'adv', '高级选项', { note: '改错了会让请求直接发不出去，一般是给中转站用的。' });
    adv.body.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: 'API 格式' }),
      el('span', { class: 'select-wrap' }, [fmtSel]),
      el('div', { class: 'hint', text: '要和请求地址的协议一致：地址是 OpenAI 风格的却选了 Anthropic，会直接报 404 或参数错误。' })
    ]));
    adv.body.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '认证字段' }),
      el('span', { class: 'select-wrap' }, [authSel]),
      authHint
    ]));
    paintAuth();
    wrap.appendChild(adv.node);

    /* 测试连接 */
    var testBox = el('div', { class: 'test-result' });
    function paintTest() {
      var st = testState[p.id] || { status: 'idle' };
      testBox.innerHTML = '';
      testBox.className = 'test-result' + (st.status === 'ok' ? ' ok' : st.status === 'bad' ? ' bad' : '');
      if (st.status === 'busy') {
        testBox.appendChild(ctx.spinner());
        testBox.appendChild(el('span', { text: '正在连接…（最长约 20 秒）' }));
      } else if (st.status === 'ok') {
        testBox.appendChild(icon('check'));
        testBox.appendChild(el('span', { text: '连接成功' + (st.latency ? '，延迟 ' + st.latency + ' ms' : '') + (st.models ? '，拿到 ' + st.models + ' 个模型' : '') }));
      } else if (st.status === 'bad') {
        testBox.appendChild(icon('alert'));
        testBox.appendChild(el('span', { text: '失败：' + st.text }));
        if (st.detail) testBox.appendChild(ctx.detailButton(st.detail));
      } else {
        testBox.appendChild(el('span', { class: 'hint', text: '还没测过。测试会真的发一次请求，会产生极少量费用。' }));
      }
    }
    paintTest();

    wrap.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '测试连接' }),
      el('div', { class: 'input-row' }, [
        el('button', {
          class: 'btn', type: 'button', dataset: { act: 'test' },
          on: { click: function () { doTest(p, paintTest); } }
        }, [icon('play'), el('span', { text: '测试连接' })]),
        el('span', { class: 'hint', text: '改了 Key / 地址 / 格式，会先自动保存再测。' })
      ]),
      testBox
    ]));

    /* ---------- 模型映射（折叠） ----------
     * 一张表：显示名 / 实际请求模型 / 声明上限 / 单次输出上限。
     * 那两个「上限」是 1.4.0 的新东西，也是这一节存在的理由 —— 见下面那段说明。
     */

    /** 改「实际请求模型」时，把**指向它的那几处引用一起搬过去**：兜底模型（= active.model）
     *  与两个分阶段模型（active.stages.*）。不搬的话，改完模型名一保存，生成时就报"没有选模型"，
     *  而用户明明刚在列表里把那个模型改好。 */
    function renameModel(m, next) {
      var old = m.id;
      if (old === next) return;
      m.id = next;
      if (p.defaultModel === old) p.defaultModel = next;
      if (draft.stages) {
        ['analyze', 'audit'].forEach(function (k) { if (draft.stages[k] === old) draft.stages[k] = next; });
      }
    }

    var mmBusy = false, mmStatus = null;
    var mmStatusBox = el('div', { class: 'mm-status' });
    function paintMmStatus() {
      mmStatusBox.className = 'mm-status' + (mmBusy ? '' : mmStatus ? (mmStatus.ok ? ' ok' : ' bad') : '');
      mmStatusBox.innerHTML = '';
      if (mmBusy) {
        mmStatusBox.appendChild(ctx.spinner());
        mmStatusBox.appendChild(el('span', { text: '正在拉模型列表…（最长约 20 秒）' }));
        return;
      }
      if (!mmStatus) return;
      mmStatusBox.appendChild(icon(mmStatus.ok ? 'check' : 'alert'));
      mmStatusBox.appendChild(el('span', { text: mmStatus.text }));
    }

    var mmBody = el('div', {});
    var mm = foldSection(p, 'models', '模型映射', {
      note: '显示名称只影响这一页；「实际请求模型」才是发出去的那串字符。'
    });

    mm.body.appendChild(el('div', { class: 'hint mm-intro', text:
      '这个应用没法自动知道某个模型的上限：多数服务商的 /models 接口不返回上下文长度，' +
      '更不会返回单次输出上限。所以下面这两列要你按官方说明自己声明。' +
      '声明了「单次输出上限」之后，生成时一步到位就用这个数；不声明就沿用从前的做法 —— ' +
      '先要 16000，被截断再往上翻倍到 64000。' }));
    mm.body.appendChild(mmBody);
    mm.body.appendChild(mmStatusBox);

    function modelRow(m) {
      var nameIn = el('input', {
        type: 'text', value: m.name || '', placeholder: m.id || '显示名称', spellcheck: 'false',
        'aria-label': '「' + (m.id || '') + '」的显示名称',
        on: { input: function () { m.name = nameIn.value; refreshFoot(); } }
      });
      var idIn = el('input', {
        type: 'text', value: m.id || '', spellcheck: 'false',
        'aria-label': '实际请求模型', dataset: { field: 'modelId' },
        on: { input: function () { renameModel(m, idIn.value.trim()); refreshFoot(); } }
      });

      /* 「声明上限」= 上下文窗口。0 = 未声明，输入框留空、占位文案写「未声明」——
         摆一个 0 在那里，看起来像"这个模型最多只能吃 0 个 token"。 */
      var ctxIn = el('input', {
        type: 'number', min: '0', step: '1024', placeholder: '未声明',
        'aria-label': '「' + (m.id || '') + '」的声明上限（tokens）',
        value: m.contextLimit ? String(m.contextLimit) : '',
        on: {
          input: function () {
            m.contextLimit = tokensOf(ctxIn.value, TOKEN_LIMIT_MAX);
            oneM.checked = (m.contextLimit === ONE_M);
            refreshFoot();
          }
        }
      });
      // 1M 快捷勾选：官方标的"1M 上下文"就是 1048576（不是 1000000），见 ONE_M 的注释
      var oneM = el('input', {
        type: 'checkbox', 'aria-label': '「' + (m.id || '') + '」的声明上限按 1M 计',
        on: {
          change: function () {
            m.contextLimit = oneM.checked ? ONE_M : 0;
            ctxIn.value = m.contextLimit ? String(m.contextLimit) : '';
            refreshFoot();
          }
        }
      });
      oneM.checked = (m.contextLimit === ONE_M);

      var outIn = el('input', {
        type: 'number', min: '0', step: '1024', placeholder: '未声明',
        'aria-label': '「' + (m.id || '') + '」的单次输出上限（tokens）',
        value: m.maxOutput ? String(m.maxOutput) : '',
        on: { input: function () { m.maxOutput = tokensOf(outIn.value, TOKEN_LIMIT_MAX); refreshFoot(); } }
      });

      return el('tr', {}, [
        el('td', { dataset: { label: '显示名称' } }, [
          el('div', { class: 'name-cell' }, [
            nameIn,
            // 「看图」标记跟着模型走（预设里标的），它是"能不能读 PPT 截图"的唯一提示
            m.vision ? el('span', { class: 'pill info mm-vis', text: '看图' }) : null
          ])
        ]),
        el('td', { dataset: { label: '实际请求模型' } }, [idIn]),
        el('td', { dataset: { label: '声明上限' } }, [
          el('div', { class: 'tok-cell' }, [
            ctxIn,
            el('label', { class: 'one-m', title: '勾上就是 1048576 tokens' }, [oneM, el('span', { text: '1M' })])
          ])
        ]),
        el('td', { dataset: { label: '单次输出上限' } }, [outIn]),
        el('td', { dataset: { label: '操作' } }, [
          el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': '删除模型 ' + (m.id || ''),
            on: {
              click: function () {
                var i = p.models.indexOf(m);
                if (i >= 0) p.models.splice(i, 1);
                syncDefault(p);
                paintModels(); paintDefault(); refreshFoot();
              }
            }
          }, icon('trash'))
        ])
      ]);
    }

    function paintModels() {
      mmBody.innerHTML = '';
      if (!p.models.length) {
        mmBody.appendChild(el('div', { class: 'hint', style: 'padding:4px 2px', text: '还没有模型。点右上角「获取模型列表」自动拉一份，或在下面手填一个模型名。' }));
        return;
      }
      var table = el('table', { class: 'mm-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: '显示名称' }),
        el('th', { text: '实际请求模型' }),
        el('th', { text: '声明上限' }),
        el('th', { text: '单次输出上限' }),
        el('th', { class: 'mm-op', text: '操作' })
      ])]));
      table.appendChild(el('tbody', {}, p.models.map(modelRow)));
      mmBody.appendChild(table);
    }

    /* 手填一个模型。拉列表是主路，但"服务商刚上了一个新模型、/models 还没跟上"是常事，
       留一个手填入口，免得用户为了试一个模型名去改 settings.json。 */
    var newModel = el('input', {
      type: 'text', placeholder: '手动加一个模型名，例如 gpt-4o-mini', 'aria-label': '新模型名',
      on: { keydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); addModel(); } } }
    });
    function addModel() {
      var v = newModel.value.trim();
      if (!v) { ctx.toast('先填模型名', 'warn'); return; }
      if (p.models.some(function (m) { return m.id === v; })) { ctx.toast('这个模型已经在列表里了', 'warn'); return; }
      p.models.push({ id: v, name: '', contextLimit: 0, maxOutput: 0, vision: false, note: '' });
      if (!p.defaultModel) p.defaultModel = v;
      newModel.value = '';
      paintModels(); paintDefault(); refreshFoot();
    }
    mm.body.appendChild(el('div', { class: 'input-row mm-add' }, [
      newModel,
      el('button', { class: 'btn', type: 'button', text: '添加', on: { click: addModel } })
    ]));

    /* 两个工具按钮。放在标题那一行，所以折叠着也能点 ——
       点了会把这一节摊开（展开是直接翻 DOM，不重画整页：重画会作废上面那些闭包引用，
       "结果落在刚画出来的表格里"就无从谈起了）。 */
    mm.tools.appendChild(el('button', {
      class: 'btn sm', type: 'button',
      on: { click: function () { mm.open(); oneKeySet(); } }
    }, [icon('sliders'), el('span', { text: '一键设置' })]));
    mm.tools.appendChild(el('button', {
      class: 'btn sm', type: 'button', dataset: { act: 'fetchModels' },
      on: { click: function () { mm.open(); fetchModels(); } }
    }, [icon('refresh'), el('span', { text: '获取模型列表' })]));

    /** 「一键设置」：把当前列出的模型**全部**套用同一个声明上限（只动声明上限那一列）。 */
    function oneKeySet() {
      if (!p.models.length) { ctx.toast('先加一个模型，再一键设置上限', 'warn'); return; }
      var input = el('input', {
        type: 'number', min: '0', step: '1024', placeholder: '例如 1048576', 'aria-label': '声明上限（tokens）'
      });
      var cb = el('input', {
        type: 'checkbox',
        on: { change: function () { input.value = cb.checked ? String(ONE_M) : ''; } }
      });
      ctx.modal({
        title: '把 ' + p.models.length + ' 个模型的「声明上限」都设成多少？',
        body: el('div', {}, [
          el('div', { class: 'hint', text: '只改「声明上限」那一列，不动「单次输出上限」。填 0 就是全部改回「未声明」。' }),
          el('div', { class: 'field', style: 'margin-top:12px' }, [
            el('span', { class: 'lbl', text: '声明上限（tokens）' }),
            input,
            el('label', { class: 'checkline' }, [cb, el('span', { class: 't' }, [
              el('b', { text: '1M' }), el('small', { text: '勾上就是 1048576 tokens' })
            ])])
          ])
        ]),
        actions: [
          { label: '取消' },
          {
            label: '套用', kind: 'primary',
            onClick: function () {
              var n = tokensOf(input.value, TOKEN_LIMIT_MAX);
              // 输入框里写了非数字时 input.value 是空串 → 0。那等于"全部改成未声明"，
              // 和用户想干的事正好相反，所以这里要拦一下。
              if (String(input.value).trim() && !isFinite(Number(input.value))) {
                ctx.toast('填一个数字，或者勾「1M」', 'warn');
                return false;                       // 返回 false = 不关弹窗
              }
              p.models.forEach(function (m) { m.contextLimit = n; });
              paintModels(); refreshFoot();
              ctx.toast(n ? ('已把 ' + p.models.length + ' 个模型的声明上限设为 ' + n) : '已把声明上限全部改回「未声明」', 'ok');
            }
          }
        ]
      });
    }

    /** 「获取模型列表」：走的就是「测试连接」那一条通道（同一次请求顺带取回 /models）。
     *  不开第二条路 —— 开了一定会有一天两边不一样。 */
    function fetchModels() {
      if (mmBusy) return;
      // 和 doTest 一样：测的是**已保存的那份配置**，草稿没存就会拿旧配置去问
      if (isDirty()) {
        mmStatus = null;
        ctx.toast('先把改动保存了，再拉模型列表', 'info');
        save().then(function (ok) { if (ok) clickLive('fetchModels'); });
        return;
      }
      mmBusy = true; mmStatus = null; paintMmStatus();
      ctx.call('testConnection', p.id).then(function (res) {
        mmBusy = false;
        if (!res.ok) {
          mmStatus = { ok: false, text: '拉取失败：' + ctx.clip((res.error && res.error.message) || '调用失败', 200) };
          paintMmStatus(); return;
        }
        var d = res.data || {};
        if (!d.ok) {
          mmStatus = { ok: false, text: '拉取失败：' + ctx.clip(d.error || d.message || '连接失败', 200) };
          paintMmStatus(); return;
        }
        var added = 0, kept = 0;
        (d.models || []).forEach(function (raw) {
          var mm2 = normModel(raw);
          if (!mm2.id) return;
          var old = null;
          for (var i = 0; i < p.models.length; i++) if (p.models[i].id === mm2.id) old = p.models[i];
          if (old) {
            /* 已经在列表里的那个**一个字都不动**：那两个上限是用户照官方文档查出来填的，
               一次"获取模型列表"把它们抹掉，比不拉列表还糟。只在一个空的显示名上补一下
               （预设里带的显示名比裸 id 好认）。 */
            if (!old.name && mm2.name) old.name = mm2.name;
            kept++;
          } else {
            p.models.push(mm2);                      // 新来的：两个上限都是 0 = 未声明
            added++;
          }
        });
        paintModels(); paintDefault(); refreshFoot();
        mmStatus = {
          ok: true,
          text: '拿到 ' + (d.models || []).length + ' 个模型（新增 ' + added + ' 个，' + kept +
            ' 个已经在列表里 —— 它们已填的上限和显示名原样保留）'
        };
        paintMmStatus();
        ctx.toast(added ? ('拉到 ' + added + ' 个新模型') : '列表里没有新模型', added ? 'ok' : 'info');
      });
    }

    paintModels();
    wrap.appendChild(mm.node);

    /* ---------- 默认兜底模型 ---------- */
    var defSel = el('select', { id: 'st-default-model', 'aria-label': '默认兜底模型', on: { change: function () { p.defaultModel = defSel.value; refreshFoot(); } } });
    function paintDefault() {
      syncDefault(p);
      defSel.innerHTML = '';
      if (!p.models.length) {
        defSel.appendChild(el('option', { value: '', text: '（还没有模型）' }));
        defSel.disabled = true;
      } else {
        defSel.disabled = false;
        p.models.forEach(function (m) {
          defSel.appendChild(el('option', { value: m.id, text: (m.name ? m.name + ' · ' : '') + m.id }));
        });
        defSel.value = p.defaultModel;
      }
    }
    paintDefault();
    wrap.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '默认兜底模型' }),
      el('span', { class: 'select-wrap' }, [defSel]),
      el('div', { class: 'hint', text: '写内容、出题、拼页面都用它。当前正在使用的那一家，这里选的就是工作台按下「开始生成」时用的模型；没在用的那几家，这里只是给它自己留一个默认值。' })
    ]));

    /* ---------- 生成时的单次输出上限（generation.maxOutput） ----------
     * 它和上面那张表是同一件事的两头：表里声明的是"某个模型的墙"，这里是"这一次我只要这么多"。
     * 所以放在模型映射下面，紧挨着。 */
    var moInput = el('input', {
      type: 'number', min: '0', step: '1024', id: 'st-maxout', placeholder: '自动（按模型声明推算）',
      'aria-label': '生成时的单次输出上限', value: draft.gen.maxOutput ? String(draft.gen.maxOutput) : '',
      on: {
        input: function () { draft.gen.maxOutput = maxOutputOf(moInput.value); refreshFoot(); },
        blur: function () { moInput.value = draft.gen.maxOutput ? String(draft.gen.maxOutput) : ''; }
      }
    });
    wrap.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '生成时的单次输出上限' }),
      moInput,
      el('div', { class: 'hint', text: '留空 = 自动：按所选模型声明的「单次输出上限」一步到位用那个数；一个都没声明就沿用从前的做法（先要 16000，被截断再往上翻倍到 64000）。手填一个更保守的数（2000–200000）就以它为准 —— 它只改起点，不会越过模型声明的墙。' })
    ]));

    /* ---------- 分阶段用不同模型（折叠） ----------
     * 截图里没有这一节，它对应的是截图里「模型角色」那一栏的用途：
     * 把便宜模型够用的那两步挪走，把贵模型留给真正出内容的那一步。 */
    function stageField(label, key, desc) {
      var cur = (draft.stages && draft.stages[key]) || '';
      var sel = el('select', {
        'aria-label': label,
        on: {
          change: function () {
            draft.stages = draft.stages || { analyze: '', audit: '' };
            draft.stages[key] = sel.value;
            refreshFoot();
          }
        }
      });
      sel.appendChild(el('option', { value: '', text: '跟主模型一样（默认）' }));
      p.models.forEach(function (m) {
        sel.appendChild(el('option', { value: m.id, text: (m.name ? m.name + ' · ' : '') + m.id }));
      });
      /* 存着的那个模型不在这一家的列表里（换了提供商，或者模型被删了）：
         照样列出来、并且明说它现在不在列表里 —— 直接悄悄丢掉的话，
         用户会以为"我明明选过"，而生成时那一步用的是主模型。 */
      var stale = !!cur && !p.models.some(function (m) { return m.id === cur; });
      if (stale) sel.appendChild(el('option', { value: cur, text: cur + '（已不在这一家的模型列表里）' }));
      sel.value = cur;
      return el('div', { class: 'field' }, [
        el('span', { class: 'lbl', style: 'display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap' }, [
          el('span', { text: label }),
          stale ? el('span', { class: 'pill warn', text: '模型不在列表里' }) : null
        ]),
        el('span', { class: 'select-wrap' }, [sel]),
        el('div', { class: 'hint', text: desc })
      ]);
    }
    var stBody = el('div', {});
    var stFold = foldSection(p, 'stages', '分阶段用不同模型', {
      note: '只影响这两步的模型选择，出题与写内容仍然用主模型。',
      // 展开时重画一次：模型列表可能刚被改过（改了 id、删了一个），选项要跟着走
      onOpen: function () { paintStages(); }
    });
    function paintStages() {
      stBody.innerHTML = '';
      stBody.appendChild(stageField('逐来源分析用', 'analyze',
        '把每一份材料读一遍、列出知识点与公式的那一步。因为按材料份数各跑一次，这里换便宜模型省得最多。'));
      stBody.appendChild(stageField('独立审题用', 'audit',
        '生成完之后另起一次调用、独立把题重做一遍再和题库对答案的那一步。同理，它只是多一层复核。'));
      stBody.appendChild(el('div', { class: 'hint', text:
        '这两步都只读不写：它们不产出任何给学生看的内容，所以便宜的小模型就够，把贵的留给真正生成内容的那一步。' +
        '换掉它们只影响这两步用哪个模型，不影响出题质量 —— 重出题库、写讲解仍然用主模型（上面那个「默认兜底模型」）。' +
        '为什么不能跨提供商选：换一家要另一把 API Key，而 Key 是按提供商配的；这个应用不会拿别家的 Key 去发请求。' }));
    }
    stFold.body.appendChild(stBody);
    wrap.appendChild(stFold.node);

    /* ---------- 自定义 User-Agent ---------- */
    var uaInput = el('input', {
      type: 'text', spellcheck: 'false', maxlength: String(TEXT_MAX), value: p.userAgent || '',
      placeholder: '留空 = 不覆盖', 'aria-label': '自定义 User-Agent',
      on: { input: function () { p.userAgent = uaInput.value; refreshFoot(); } }
    });
    wrap.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '自定义 User-Agent' }),
      uaInput,
      el('div', { class: 'hint', text: '留空就是不改，用运行时默认的。个别网关按 User-Agent 判客户端，只有在被它拒了的时候才需要动这里。' })
    ]));

    /* ---------- 本地代理请求覆盖 ----------
     * 截图里这一节是"Header 覆盖 / Body 覆盖"两个框，用途也一样：
     * 给本机的转发程序用的，它会往真正的服务商那边转发。
     * ⚠️ 这两段只在**发请求**时用（llm 层解析后合并），不会跟 Key 走同一条路 ——
     * 但用户完全可以把 Key 自己写进 Header 里（中转要求自定义鉴权头时就是这么干的），
     * 所以那句说明要如实写，别让用户以为这里填的东西会被当密钥处理。 */
    var phBox = el('textarea', {
      rows: '5', spellcheck: 'false', maxlength: String(PROXY_MAX),
      'aria-label': 'Header 覆盖（JSON）', dataset: { field: 'proxyHeader' },
      placeholder: '{\n  "X-Provider": "cc-switch"\n}',
      on: { input: function () { p.proxyHeader = phBox.value; paintProxy(); refreshFoot(); } }
    });
    phBox.value = p.proxyHeader || '';
    var pbBox = el('textarea', {
      rows: '5', spellcheck: 'false', maxlength: String(PROXY_MAX),
      'aria-label': 'Body 覆盖（JSON）', dataset: { field: 'proxyBody' },
      placeholder: '{\n  "temperature": 0.2\n}',
      on: { input: function () { p.proxyBody = pbBox.value; paintProxy(); refreshFoot(); } }
    });
    pbBox.value = p.proxyBody || '';
    var phNote = el('div', { class: 'hint' });
    var pbNote = el('div', { class: 'hint' });

    /** 边填边验，不等点保存：JSON 的错法（多一个逗号、少了半个引号）在生成时爆出来的样子
     *  是一句"请求失败"，看不出是谁干的。不合法时**在这一段下面指名道姓说第几行**。 */
    function paintProxy() {
      var a = jsonProblem(p.proxyHeader, '「Header 覆盖」');
      var b = jsonProblem(p.proxyBody, '「Body 覆盖」');
      phNote.textContent = a || '留空 = 不覆盖。填了会合并进每一次请求的请求头；这里填的能覆盖 Authorization（中转要求自定义鉴权头时用这个）。';
      phNote.className = 'hint' + (a ? ' json-bad' : '');
      pbNote.textContent = b || '留空 = 不覆盖。填了会合并进每一次请求的请求体，可以加或覆盖 temperature 这类参数，但覆盖不了 messages 与 stream。';
      pbNote.className = 'hint' + (b ? ' json-bad' : '');
      phBox.classList.toggle('bad', !!a);
      pbBox.classList.toggle('bad', !!b);
    }
    paintProxy();

    wrap.appendChild(el('div', { class: 'divider' }));
    wrap.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '本地代理请求覆盖' }),
      el('div', { class: 'hint', text: '给本机那个转发程序用的（它再往真正的服务商那边转）。不配就是原样发出去。' }),
      el('div', { class: 'duo', style: 'margin-top:4px' }, [
        el('div', { class: 'field' }, [el('span', { class: 'lbl', text: 'Header 覆盖（JSON）' }), phBox, phNote]),
        el('div', { class: 'field' }, [el('span', { class: 'lbl', text: 'Body 覆盖（JSON）' }), pbBox, pbNote])
      ])
    ]));

    /* ---------- 配置 JSON（折叠） ----------
     * 截图里那一节末尾是「应用通用配置」按钮 —— 本应用没有"通用配置"这个概念
     * （每个提供商各管各的），所以**不硬造**它，换成"把这段 JSON 应用回表单"。 */
    function providerJson(x) {
      /* 白名单式构造，**绝不用草稿对象整个 stringify**：
         那样哪天字段里混进 apiKeyEnc / apiKey，就会原样躺进这个可编辑、可复制的文本框里。
         连"有没有 Key"都只发一个 boolean（hasKey），不发掩码、更不发明文。 */
      var b = billingOf(x.billing);
      return JSON.stringify({
        id: x.id,
        name: x.name || '',
        note: x.note || '',
        homepage: x.homepage || '',
        enabled: !!x.enabled,
        format: x.format,
        baseUrl: x.baseUrl || '',
        fullUrl: !!x.fullUrl,
        authField: x.authField || '',
        userAgent: x.userAgent || '',
        proxyHeader: x.proxyHeader || '',
        proxyBody: x.proxyBody || '',
        models: x.models.map(function (m) {
          return { id: m.id, name: m.name || '', contextLimit: m.contextLimit || 0, maxOutput: m.maxOutput || 0, vision: !!m.vision };
        }),
        defaultModel: x.defaultModel || '',
        billing: b,
        isCustom: !!x.isCustom,
        hasKey: !!x.hasKey
      }, null, 2);
    }
    var JSON_KEYS = ['id', 'name', 'note', 'homepage', 'enabled', 'format', 'baseUrl', 'fullUrl',
      'authField', 'userAgent', 'proxyHeader', 'proxyBody', 'models', 'defaultModel', 'billing', 'isCustom', 'hasKey'];
    // 名字里带这些词的一律不认（并明说）：这一段是可编辑的文本框，"把别处的配置整段粘进来"太自然了
    var JSON_SECRET_RE = /(api[-_]?key|secret|token|passw|credential|authorization|bearer)/i;

    var jsonArea = el('textarea', {
      rows: '12', spellcheck: 'false', 'aria-label': '这一家提供商的配置 JSON',
      on: { input: function () { paintJsonNote(); } }
    });
    var jsonNote = el('div', { class: 'hint' });
    function paintJsonNote() {
      var bad = jsonProblem(jsonArea.value, '配置 JSON ');
      jsonNote.textContent = bad ||
        '改完点「应用回表单」。它只作用于当前这家提供商 —— 不动别的提供商，也不动上面那些应用级的设置。';
      jsonNote.className = 'hint' + (bad ? ' json-bad' : '');
    }
    var js = foldSection(p, 'json', '配置 JSON', { note: '这一家提供商的配置，导出/贴给别人时用的。里面没有 API Key —— 它不在这里，也不会写进这里。' });
    js.body.appendChild(el('div', { class: 'input-row', style: 'margin-bottom:8px' }, [
      el('button', { class: 'btn sm primary', type: 'button', on: { click: applyJson } },
        [icon('check'), el('span', { text: '把这段 JSON 应用回表单' })]),
      el('button', { class: 'btn sm', type: 'button', on: { click: function () { jsonArea.value = providerJson(p); paintJsonNote(); } } },
        [icon('refresh'), el('span', { text: '从上面的表单重新生成' })])
    ]));
    js.body.appendChild(jsonArea);
    js.body.appendChild(jsonNote);

    /** 把编辑过的 JSON 套回草稿。逐字段走显式白名单、每个都重新规整一遍 ——
     *  JSON 是手写的，什么都可能出现在里面；顺手把不该进的东西（尤其是 Key）点名拒掉。 */
    function applyJson() {
      var bad = jsonProblem(jsonArea.value, '配置 JSON ');
      if (bad) { ctx.toast(bad, 'warn'); return; }
      var o;
      try { o = JSON.parse(jsonArea.value); } catch (e) { ctx.toast('这段 JSON 解析不了', 'warn'); return; }

      var refused = [], ignored = [];
      Object.keys(o).forEach(function (k) {
        if (JSON_SECRET_RE.test(k)) refused.push(k);
        else if (JSON_KEYS.indexOf(k) < 0) ignored.push(k);
      });
      if (refused.length) {
        ctx.toast('这段 JSON 里的「' + refused.join('、') + '」不会生效：API Key 只能用上面的输入框改，它不会经这里进配置。', 'warn');
      }
      if (Object.prototype.hasOwnProperty.call(o, 'id') && String(o.id) !== p.id) {
        ignored.push('id');
      }
      if (typeof o.name === 'string') p.name = o.name;
      if (typeof o.note === 'string') p.note = o.note;
      if (typeof o.homepage === 'string') p.homepage = o.homepage;
      if (typeof o.enabled === 'boolean') p.enabled = o.enabled;
      if (o.format === 'openai' || o.format === 'anthropic') p.format = o.format;
      if (typeof o.baseUrl === 'string') p.baseUrl = o.baseUrl.trim();
      if (typeof o.fullUrl === 'boolean') p.fullUrl = o.fullUrl;
      if (typeof o.authField === 'string') p.authField = authFieldOf(o.authField);
      if (typeof o.userAgent === 'string') p.userAgent = o.userAgent.slice(0, TEXT_MAX);
      if (typeof o.proxyHeader === 'string') p.proxyHeader = o.proxyHeader.slice(0, PROXY_MAX);
      if (typeof o.proxyBody === 'string') p.proxyBody = o.proxyBody.slice(0, PROXY_MAX);
      if (Array.isArray(o.models)) p.models = o.models.map(normModel).filter(function (m) { return !!m.id; });
      if (typeof o.defaultModel === 'string') p.defaultModel = o.defaultModel;
      if (o.billing && typeof o.billing === 'object') p.billing = billingOf(o.billing);
      if (typeof o.isCustom === 'boolean') p.isCustom = o.isCustom;

      refreshDetail(); refreshFoot();
      ctx.toast(ignored.length ? ('已套用，忽略了这些字段：' + ignored.join('、')) : '已套用回表单', ignored.length ? 'warn' : 'ok');
    }
    paintJsonNote();
    jsonArea.value = providerJson(p);
    paintJsonNote();
    wrap.appendChild(js.node);

    /* ---------- 计费配置 ---------- */
    var billCb = el('input', {
      type: 'checkbox', 'aria-label': '启用计费配置',
      on: { change: function () { p.billing.enabled = billCb.checked; paintBilling(); refreshFoot(); } }
    });
    billCb.checked = !!p.billing.enabled;
    var billBody = el('div', {});
    function moneyInput(label, key, placeholder) {
      var input = el('input', {
        type: 'number', min: '0', step: '0.01', placeholder: placeholder, 'aria-label': label,
        value: p.billing[key] ? String(p.billing[key]) : '',
        on: {
          input: function () { p.billing[key] = Number(input.value) > 0 ? Number(input.value) : 0; refreshFoot(); }
        }
      });
      return el('div', { class: 'field' }, [el('span', { class: 'lbl', text: label }), input]);
    }
    function paintBilling() {
      billBody.innerHTML = '';
      if (!p.billing.enabled) {
        billBody.appendChild(el('div', { class: 'hint', text: '没启用就不显示费用。' }));
        return;
      }
      var curInput = el('input', {
        type: 'text', spellcheck: 'false', maxlength: '8', placeholder: 'CNY', 'aria-label': '货币',
        value: p.billing.currency || 'CNY',
        on: { input: function () { p.billing.currency = curInput.value.trim() || 'CNY'; refreshFoot(); } }
      });
      billBody.appendChild(el('div', { class: 'duo' }, [
        moneyInput('输入单价（每百万 token）', 'inputPerM', '例如 2'),
        moneyInput('输出单价（每百万 token）', 'outputPerM', '例如 8')
      ]));
      billBody.appendChild(el('div', { class: 'field' }, [el('span', { class: 'lbl', text: '货币' }), curInput]));
    }
    paintBilling();
    wrap.appendChild(el('div', { class: 'field' }, [
      el('div', { class: 'row-between' }, [
        el('span', { class: 'lbl', text: '计费配置' }),
        el('div', { class: 'sw-inline' }, [
          el('span', { class: 'sw-label', text: '启用' }),
          el('label', { class: 'switch', title: '要不要算这次的费用' }, [billCb, el('span', { class: 'track' })])
        ])
      ]),
      billBody,
      el('div', { class: 'hint', text: '填了单价之后，结果页会按这次实际用掉的 token 给一个预估费用；不填就不显示。它只是一次估算，不是账单 —— 阶梯价、缓存命中、赠送额度都算不进来，也不会去问服务商那边实际扣了多少。' })
    ]));

    /* 危险操作 */
    if (p.isCustom) {
      wrap.appendChild(el('div', { class: 'divider' }));
      wrap.appendChild(el('button', {
        class: 'btn danger sm', type: 'button',
        on: {
          click: function () {
            ctx.confirm('删掉「' + p.name + '」？', '只会从本机配置里移除，不影响服务商那边的任何东西。', '删除').then(function (ok) {
              if (!ok) return;
              var i = draft.providers.indexOf(p);
              if (i >= 0) draft.providers.splice(i, 1);
              if (draft.provider === p.id) draft.provider = draft.providers[0] ? draft.providers[0].id : '';
              selId = draft.providers[0] ? draft.providers[0].id : '';
              refreshList(); refreshDetail(); refreshFoot();
            });
          }
        }
      }, [icon('trash'), el('span', { text: '删除这家提供商' })]));
    }
    return wrap;
  }

  /**
   * 「先把改动保存了，再测 / 再拉列表」这条路的收尾。
   *
   * ⚠️ 存完之后**不能**接着用手里那个 `p` 和那几个局部节点：save() 会把整份 draft
   * 换成 `normalize()` 出来的**新对象**，并 refreshDetail() 重画一遍详情区。
   * 于是旧引用写进去的东西没人看得到 —— 拉回来的模型加进了一个已经作废的对象，
   * 紧接着的重画又把它抹掉，而 toast 还在说"已加进列表"。这是一句谎话，
   * 也是这个仓库最忌讳的"界面上说做了、实际没做"。
   * 所以：存完就**点一下新画出来的那个按钮**，让新的那份闭包去干活。
   */
  function clickLive(action) {
    if (!detailBox) return;
    var b = detailBox.querySelector('[data-act="' + action + '"]');
    if (b) b.click();
  }

  /* ⚠️ 这里以前调的是 `openPath` —— 那是"用系统默认程序**执行一个文件**"，
     拿网址喂给它只会得到「文件不存在了：https://…」。用户看到的是"链接坏了"，
     而真正的原因是**当时根本没有开外链的通道**。现在走 `openExternal`
     （主进程只放行 http/https，其余 scheme 一律拒）。 */
  function openKeyUrl(url) {
    if (!url) return;
    ctx.call('openExternal', url).then(function (res) {
      // 兜底：系统没有默认浏览器之类的情况下，至少把链接塞进剪贴板
      if (!res.ok) ctx.copy(url, '没能在浏览器里打开，链接已复制');
    });
  }

  function doTest(p, paint) {
    function run() {
      testState[p.id] = { status: 'busy' };
      paint();
      ctx.call('testConnection', p.id).then(function (res) {
        if (!res.ok) {
          testState[p.id] = { status: 'bad', text: ctx.clip((res.error && res.error.message) || '调用失败', 160), detail: res.error };
          paint(); return;
        }
        var d = res.data || {};
        if (d.ok) {
          var added = 0;
          (d.models || []).forEach(function (m) {
            var mm = normModel(m);
            if (!mm.id) return;
            if (!p.models.some(function (x) { return x.id === mm.id; })) { p.models.push(mm); added++; }
          });
          testState[p.id] = { status: 'ok', latency: d.latencyMs || d.latency, models: (d.models || []).length || undefined };
          if (added) ctx.toast('拉到 ' + added + ' 个模型，已加进列表', 'ok');
          refreshDetail();
        } else {
          testState[p.id] = { status: 'bad', text: ctx.clip(d.error || d.message || '连接失败', 160), detail: d };
          paint();
        }
      });
    }

    if (isDirty()) {
      ctx.toast('先把改动保存了，再测这一份配置', 'info');
      save().then(function (ok) { if (ok) clickLive('test'); });
    } else run();
  }

  function refreshDetail() {
    if (!detailBox) return;
    detailBox.innerHTML = '';
    detailBox.appendChild(buildDetail());
  }

  /* ---------- 底部 ---------- */

  function refreshFoot() {
    if (!footBox) return;
    var dirty = isDirty();
    footBox.innerHTML = '';
    footBox.appendChild(el('div', { class: 'left' }, [
      el('div', { class: 'hint', text: dirty ? '有改动还没保存' : '所有改动都已保存' }),
      el('div', { class: 'hint mono', text: ((ctx.state.appInfo && ctx.state.appInfo.settingsPath) || '（配置文件位置未知）') })
    ]));
    footBox.appendChild(el('div', { class: 'right' }, [
      el('button', {
        class: 'btn', type: 'button', disabled: !dirty,
        on: {
          click: function () {
            draft = normalize(ctx.state.settings);
            origJson = serializable();
            selId = draft.providers.length ? draft.providers[0].id : '';
            testState = {};
            renderNotice(); refreshList(); refreshDetail(); refreshFoot();
            ctx.toast('已放弃未保存的改动', 'info');
          }
        }
      }, [el('span', { text: '取消' })]),
      el('button', {
        class: 'btn primary', type: 'button', disabled: !dirty,
        on: { click: function () { save().then(function (ok) { if (ok) ctx.toast('设置已保存', 'ok'); }); } }
      }, [icon('check'), el('span', { text: '保存' })])
    ]));
  }

  function save() {
    /* 保存前先把两段"请求覆盖"验一道并**当场拦下**。
       主进程对解析失败的处理是"忽略并 warn"（DESIGN §1.1）—— 它会照常保存，然后在生成时
       把那一段当没配。于是用户看到的是"生成失败"，而真正的原因是他三小时前粘进来的一个逗号，
       他还可能因此去反复改地址。所以这里拦下来，并且指名道姓说是哪一行。 */
    var badJson = badProxyOf();
    if (badJson) {
      selId = badJson.p.id;
      refreshList(); refreshDetail();
      focusField(badJson.field);
      ctx.toast(badJson.message, 'warn');
      return Promise.resolve(false);
    }

    // providers 必须发**以 id 为键的对象 map**：store 里就是 map，发数组会被存成
    // 键名 "0"、"1" 的垃圾条目，用户加的提供商从此找不到。
    var providers = {};
    draft.providers.forEach(function (p) {
      if (!p || !p.id) return;
      syncDefault(p);                                   // 兜底模型不能指着已经删掉的模型
      var o = {
        name: p.name, format: p.format, baseUrl: p.baseUrl,
        enabled: p.enabled, defaultModel: p.defaultModel,
        // 1.4.0 起 store 的 models 是**对象数组**（老形状是字符串数组，sanitize 两种都认）。
        // 只发 id 的后果是那两个声明上限保存一次就没了 —— 而界面上它们还在，看起来像存住了。
        models: p.models.filter(function (m) { return m && m.id; }).map(function (m) {
          return {
            id: m.id,
            name: m.name || '',
            contextLimit: tokensOf(m.contextLimit, TOKEN_LIMIT_MAX),
            maxOutput: tokensOf(m.maxOutput, TOKEN_LIMIT_MAX),
            vision: m.vision === true            // 只认显式 true，见 store.sanitize 的同类注释
          };
        }),
        // 请求整形（§1.1）。这些字段在 store 的 KEEP / PUBLIC / EXPORT 三张表里都有，
        // 不发就等于"界面上的开关改了、请求一点没变"。
        note: p.note || '',
        homepage: p.homepage || '',
        fullUrl: !!p.fullUrl,
        authField: authFieldOf(p.authField),
        userAgent: p.userAgent || '',
        proxyHeader: p.proxyHeader || '',
        proxyBody: p.proxyBody || '',
        billing: billingOf(p.billing),
        isCustom: !!p.isCustom
      };
      if (typeof p.keyInput === 'string' && p.keyInput.length) o.apiKey = p.keyInput;   // 新填的 Key（主进程负责加密）
      else if (p.clearKey) o.apiKey = null;                                            // 明确清除
      // 没动过的 Key 不带字段，主进程保留原值
      providers[p.id] = o;
    });

    var patch = {
      provider: draft.provider,
      theme: draft.theme,
      providers: providers,
      // 单次输出上限（§1.3）：只发这一个字段，generation 里别的项（审题人数、并发…）由
      // 主进程的深合并原样保留 —— 整份 generation 发上去会把工作台那边的改动盖掉。
      generation: { maxOutput: maxOutputOf(draft.gen && draft.gen.maxOutput) },
      // 流水线读的是 settings.active.{provider,model}，全仓没有别的写入者 ——
      // 不写它，主进程永远回 NO_MODEL，永远开不了工。
      // stages（§1.2）同理：不写它，分阶段模型就只活在界面上（而且它只在同一家提供商内生效）。
      active: {
        provider: draft.provider || '',
        model: draft.provider ? modelOf(draft.providers, draft.provider) : '',
        stages: {
          analyze: (draft.stages && draft.stages.analyze) || '',
          audit: (draft.stages && draft.stages.audit) || ''
        }
      }
    };
    return ctx.call('saveSettings', patch).then(function (res) {
      if (!res.ok) return false;
      ctx.state.settings = res.data || ctx.state.settings;
      draft = normalize(ctx.state.settings);
      draft.theme = patch.theme;
      ctx.applyTheme(patch.theme);
      origJson = serializable();
      testState = {};
      renderNotice(); refreshList(); refreshDetail(); refreshFoot();
      return true;
    });
  }

  function doExport() {
    ctx.call('exportSettings').then(function (res) {
      if (!res.ok || !res.data) return;
      var v = String(res.data);
      if (v.trim().charAt(0) === '{') {
        // 主进程直接把 JSON 交给了我们：展示 + 复制（导出里不含 API Key）
        var pre = el('pre', { text: v });
        ctx.modal({
          title: '配置内容（不含 API Key）',
          body: [el('div', { class: 'hint', text: '把下面这段存成 .json 就完成了备份。' }), pre],
          actions: [
            { label: '复制', onClick: function () { ctx.copy(v, '配置已复制'); } },
            { label: '关闭', kind: 'primary' }
          ]
        });
      } else {
        ctx.toast('已导出到 ' + v, 'ok');
        ctx.call('revealPath', v);
      }
    });
  }

  function doImport() {
    ctx.call('importSettings').then(function (res) {
      if (!res.ok || !res.data) return;
      ctx.state.settings = res.data;
      draft = normalize(res.data);
      origJson = serializable();
      ctx.applyTheme(draft.theme);
      selId = draft.providers.length ? draft.providers[0].id : '';
      renderNotice(); refreshList(); refreshDetail(); refreshFoot();
      ctx.toast('配置已导入', 'ok');
    });
  }

  /* ---------- 外观：深浅色 + 自定义背景图 ---------- */

  /** 把当前背景图状态画出来（状态行 + 两个按钮 + 两个滑块）。 */
  function paintBackground() {
    if (!bgStateBox || !bgAdjustBox) return;
    if (!draft.ui) draft.ui = { bgScrim: 35, bgBlur: 6 };   // 老草稿没有这一格时的兜底
    var bg = ctx.bgState || {};
    var has = !!bg.url;
    bgStateBox.innerHTML = '';
    bgAdjustBox.innerHTML = '';

    /* 状态行：没设 / 文件名 + 大小 */
    var stateRow = el('div', { class: 'bg-state' });
    if (has) {
      stateRow.appendChild(el('span', { class: 'pill field' }, [el('span', { class: 'dot' }), el('span', { text: '已设置' })]));
      stateRow.appendChild(el('span', { class: 'bg-file', title: bg.file, text: bg.file || '（文件名读不到）' }));
      stateRow.appendChild(el('span', { class: 'hint', text: ctx.fmtBytes(bg.bytes) }));
    } else {
      stateRow.appendChild(el('span', { class: 'pill', text: '没设背景图' }));
      stateRow.appendChild(el('span', { class: 'hint', text: '现在用的是主题自带的纯色背景。' }));
    }

    /* 按钮：导入中禁掉两个按钮 + 转圈，别让人以为没反应 */
    var pickBtn = el('button', {
      class: 'btn', type: 'button', id: 'st-bgPick', disabled: importing,
      'aria-busy': importing ? 'true' : 'false',
      on: { click: doPickBackground }
    }, importing
      ? [ctx.spinner(), el('span', { text: '正在打开文件对话框…' })]
      : [icon('image'), el('span', { text: '选择图片…' })]);

    var removeBtn = el('button', {
      class: 'btn danger', type: 'button', id: 'st-bgRemove', disabled: importing,
      on: { click: doRemoveBackground }
    }, [icon('trash'), el('span', { text: '移除' })]);

    var actions = el('div', { class: 'input-row' }, [pickBtn].concat(has ? [removeBtn] : []));

    bgStateBox.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '背景图' }),
      stateRow,
      actions,
      el('div', { class: 'hint', text: has
        ? '导入会把图片复制一份到工作台的配置目录，所以原图挪走或删掉都不影响。要换一张，直接再点「选择图片…」。'
        : '导入会把图片复制一份到工作台的配置目录，所以原图挪走或删掉都不影响。' })
    ]));

    /* 两个滑块：没背景图时没有任何效果，所以禁用 + 说明，别让人拖半天没反应 */
    rangeScrim = rangeField('背景明暗', 'bgScrim', 0, 90, '%', has, '盖在背景图上的一层压制层。往右拉背景更淡、面板更清楚；拉到 0 就是原图。');
    rangeBlur = rangeField('背景虚化', 'bgBlur', 0, 24, 'px', has, '把背景图虚化，图越花越该调高一点。调到 0 就是清晰的原图。');
    bgAdjustBox.appendChild(rangeScrim.wrap);
    bgAdjustBox.appendChild(rangeBlur.wrap);
    if (!has) {
      bgAdjustBox.appendChild(el('div', { class: 'hint', text: '这两个只在有背景图时才有意义——选了背景图之后可以在这里调。' }));
    }
  }

  /* 设置文件里的字段名（`ui.bgScrim` / `ui.bgBlur`）和界面层 `bgApply()` 认的参数名
     （`scrim` / `blur`）**不是一套**。
     ⚠️ 以前两边都直接传 key，于是"实时预览"那条路整个落空：拖滑块时 CSS 变量纹丝不动，
     只有松手后保存的回声让背景跳一下（审计 v4 的 bg-race / slider 两个用例都卡在这，
     而 slider 那条断言对 bgScrim 做了宽松放行，所以它"通过"了、真问题被漏掉）。
     这里做一次显式映射，两个名字各自保持自己的含义。 */
  function bgPatch(key, value) {
    var n = Number(value);
    if (key === 'bgScrim') return { scrim: n };
    if (key === 'bgBlur') return { blur: n };
    var p = {}; p[key] = n; return p;
  }

  /**
   * 一个滑块。拖动（input）= 只改 CSS 变量做实时预览；松手（change）= 存进设置。
   * 存完还要拿主进程回来的值回填一次：钳制在它那边，界面得跟着它，别自己显示一个假数。
   */
  function rangeField(label, key, min, max, unit, enabled, hint) {
    var cur = clampRange((draft.ui || {})[key], min, max, min);
    var valBox = el('span', { class: 'range-val', text: cur + unit });
    var input = el('input', {
      type: 'range', id: 'st-' + key, min: String(min), max: String(max), step: '1', value: String(cur),
      disabled: !enabled, 'aria-label': label,
      on: {
        input: function () {
          valBox.textContent = input.value + unit;
          ctx.bgApply(bgPatch(key, input.value));   // 实时预览：只动 --bg-scrim / --bg-blur
        },
        change: function () {
          valBox.textContent = input.value + unit;
          var patch = {}; patch[key] = Number(input.value);
          ctx.bgApply(bgPatch(key, input.value));
          saveUi(patch);
        }
      }
    });
    var wrap = el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: label }),
      el('div', { class: 'range-row' }, [input, valBox]),
      el('div', { class: 'range-scale' }, [el('span', { text: min + unit }), el('span', { text: max + unit })]),
      el('div', { class: 'hint', text: hint })
    ]);
    return { wrap: wrap, input: input, val: valBox, unit: unit, key: key };
  }

  /**
   * 滑块的值单独存：**不走** 底部那个"保存"按钮。
   * 理由是这两个值是即时生效的预览参数，让人拖完还得记得点保存才会被记住，
   * 是那种"看起来生效了、重启又变回去"的坑。
   * 走 saveSettings 的深合并，因此不会碰到 providers / theme 那些还在草稿里的改动。
   */
  function saveUi(patch) {
    // 把 ctx 抄一份到闭包里：unmount() 会把模块级的 ctx 置空，而"拖着滑块点了侧栏
    // 换页"完全来得及在这几个 await 之前发生 —— 那时回调里再读 ctx.state 就是
    // "Cannot read properties of null"，冒成一条没人处理的 Promise 拒绝。
    var c = ctx;
    return c.call('saveSettings', { ui: patch }).then(function (res) {
      if (!res.ok) return false;
      var d = res.data || {};
      c.state.settings = d;
      var ui = (d.ui && typeof d.ui === 'object') ? d.ui : {};
      draft.ui.bgScrim = clampRange(ui.bgScrim, 0, 90, draft.ui.bgScrim);
      draft.ui.bgBlur = clampRange(ui.bgBlur, 0, 24, draft.ui.bgBlur);
      c.bgApply({ scrim: draft.ui.bgScrim, blur: draft.ui.bgBlur });
      syncRanges();                                // 主进程钳制过，界面上要显示它存下来的那个数
      return true;
    });
  }

  function syncRanges() {
    [[rangeScrim, 'bgScrim'], [rangeBlur, 'bgBlur']].forEach(function (pair) {
      var r = pair[0];
      if (!r || !r.input) return;
      var v = draft.ui[pair[1]];
      if (r.input.value !== String(v)) r.input.value = String(v);
      r.val.textContent = v + r.unit;
    });
  }

  function doPickBackground() {
    if (importing) return;
    // 系统文件对话框可能开着很久，用户完全可能在这中间点了侧栏 ——
    // 所以下面的回调一律用这个抄下来的 c，不碰会被 unmount 置空的模块级 ctx。
    // （paintBackground() 自己会在 unmount 后空转：它先看 bgStateBox 还在不在。）
    var c = ctx;
    importing = true;
    paintBackground();                             // 立刻变"正在打开文件对话框…" + 转圈
    c.call('importBackground').then(function (res) {
      importing = false;
      if (res.ok && res.data) {
        var d = res.data;
        c.bgApply({ file: d.file || '', url: d.url || '', bytes: d.bytes || 0 });
        // 主进程顺手写了 ui.bgImage，本地这份也跟上，免得别处读到旧值
        if (c.state.settings && c.state.settings.ui) c.state.settings.ui.bgImage = d.file || '';
        c.toast('背景图已设好', 'ok');
      } else if (res.ok) {
        c.toast('没有选图片，背景没变', 'info');  // data 为 null = 用户在对话框里点了取消
      }
      // res.ok 为 false 时 c.call 已经弹过"失败 + 怎么办"了，这里不用重复
      paintBackground();
    });
  }

  function doRemoveBackground() {
    var c = ctx;
    c.confirm('移除背景图？', '只会删掉工作台配置目录里的那一份副本，你自己那张原图不动。', '移除').then(function (yes) {
      if (!yes) return;
      c.call('clearBackground').then(function (res) {
        if (!res.ok) return;
        c.bgApply({ file: '', url: '', bytes: 0 });
        if (c.state.settings && c.state.settings.ui) c.state.settings.ui.bgImage = '';
        c.toast('背景图已移除，回到纯色背景', 'ok');
        paintBackground();
      });
    });
  }

  /* ---------- API Key 的来源（.env / 系统环境变量） ----------
   *
   * 优先级：系统环境变量 > .env 文件 > 应用里设置的。
   * 这块很短，但必须回答两个问题：**我的 Key 到底是从哪读到的**、
   * **我在这个框里填的会不会生效**。不回答的话，用户会以为 Key 是自己填进去的、
   * 删掉配置就能删掉（实际还在 .env 里，或者反过来：填了却被环境变量盖住）。
   */
  function buildKeySourceCard() {
    var env = (draft && draft.env) || { found: false, file: '', error: '', used: [] };
    var envCount = draft.providers.filter(function (p) { return p.keyFromEnv; }).length;

    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: 'API Key 从哪来' }),
      el('div', { class: 'right' }, [
        // 读不了 ≠ 读到了：状态药丸要跟着错误走，不然"已读到 .env"会和下面的报错自相矛盾
        env.error ? el('span', { class: 'pill warn', text: '.env 读不了' })
          : env.found ? el('span', { class: 'pill ok', text: '已读到 .env' })
            : el('span', { class: 'pill', text: '没有找到 .env' }),
        envCount ? el('span', { class: 'pill info', text: envCount + ' 家的 Key 来自环境变量' }) : null
      ])
    ]));

    if (env.error) {
      card.appendChild(el('div', { class: 'banner warn' }, [
        icon('alert'),
        el('div', { class: 'bt' }, [
          el('b', { text: '这个 .env 读不了' }),
          el('div', { text: '文件在，但没能解析。要么修好它，要么把 Key 直接填在下面的提供商里。' }),
          el('div', { class: 'hint mono', text: env.error })
        ])
      ]));
    }

    if (env.found) {
      card.appendChild(el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '读到的文件' }),
        el('div', { class: 'bg-state' }, [
          el('span', { class: 'bg-file', title: env.file, text: env.file || '（路径未知）' })
        ]),
        el('div', { class: 'hint', text: env.used.length
          ? '本次真正生效的变量：' + env.used.join('、') + '（只列变量名，值不会显示出来）。'
          : '文件读到了，但里面没有能对上的变量 —— 现在用的还是应用里保存的 Key。' })
      ]));
    } else {
      card.appendChild(el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: '没找到 .env' }),
        el('div', { class: 'hint', text: '想让 Key 不跟着应用配置走（重装 / 清配置都不会丢），就把 apps/isg-studio/.env.example 复制成 .env，' +
          '放到 %APPDATA%\\isg-studio\\.env（或者 exe 所在目录），填上 Key 再重启工作台。' })
      ]));
    }

    card.appendChild(el('div', { class: 'hint', text: '优先级：系统环境变量 > .env 文件 > 应用里设置的。所以同一个 Key 两处都有时，以环境变量为准。' }));
    // 用 flex 排：「药丸 + 一句话」这种混排交给行内布局会被拆得很难看（实测中间会裂开一个空格）
    card.appendChild(el('div', {
      class: 'hint',
      style: 'margin-top:6px;display:flex;gap:7px;align-items:flex-start;flex-wrap:wrap'
    }, [
      el('span', { class: 'pill gold', text: '.env 是明文' }),
      el('span', {
        style: 'flex:1 1 320px;min-width:0',
        text: '它比应用内保存的弱（Windows 上走 DPAPI 加密）。别提交到 git、别放共享盘；共用电脑上更推荐直接填在下面，用系统加密存。'
      })
    ]));
    return card;
  }

  function buildAppearanceCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: '外观' }),
      el('div', { class: 'right' }, [el('span', { class: 'hint', text: '只管这个窗口，不影响生成出来的学习页' })])
    ]));

    /* 深浅色 */
    card.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '深浅色' }),
      el('div', { class: 'radio-cards', style: 'flex-direction:row;flex-wrap:wrap' }, [
        ['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']
      ].map(function (opt) {
        var input = el('input', {
          type: 'radio', name: 'st-theme', value: opt[0], checked: draft.theme === opt[0],
          on: {
            change: function () {
              if (!input.checked) return;
              draft.theme = opt[0];
              ctx.applyTheme(draft.theme);
              refreshFoot();
            }
          }
        });
        return el('label', { class: 'radio-card', style: 'flex:1 1 150px' }, [
          input, el('span', { class: 't' }, [el('b', { text: opt[1] })])
        ]);
      })),
      el('div', { class: 'hint', text: '生成出来的学习页也会自己跟着系统深浅色走，这里只管这个窗口。' })
    ]));

    /* 背景图 */
    card.appendChild(el('div', { class: 'divider' }));
    bgStateBox = el('div', {});
    bgAdjustBox = el('div', {});
    card.appendChild(bgStateBox);
    card.appendChild(bgAdjustBox);
    return card;
  }

  /* ---------- 取消任务时的收尾（生成跑到一半点「取消」） ----------
   *
   * 三个状态（缺一不可，所以是两个字段）：
   *   · onCancel    —— 保留（默认，安全侧）/ 清除
   *   · onCancelAsk —— 还问不问（默认 true = 每次都弹窗）
   * 「恢复成每次都问」这个出口必须存在：只存一个布尔值的话，用户勾了「以后都这样」就再也回不去了。
   *
   * 这两个字段**立即保存**（和外观那两个滑块同一条路），不走底部那个「保存」按钮 ——
   * 它们只有一个二选一 + 一个开关，让人改完还要记得点保存，是"看起来生效了、重启又变回去"的坑。
   */

  /** 从当前设置里读这两个字段（拿不到就是默认：保留 + 每次都问）。 */
  function genOf() {
    var g = (ctx.state.settings && ctx.state.settings.generation) || {};
    return { onCancel: g.onCancel === 'clear' ? 'clear' : 'keep', onCancelAsk: g.onCancelAsk !== false };
  }

  function saveGen(patch) {
    var c = ctx;                                    // 抄一份：unmount 会把模块级 ctx 置空
    return c.call('saveSettings', { generation: patch }).then(function (res) {
      if (!res.ok) return false;
      c.state.settings = res.data || c.state.settings;
      paintCancelCard();                            // 用主进程钳制后的值回填
      return true;
    });
  }

  function paintCancelCard() {
    if (!cancelBox) return;
    var g = genOf();
    cancelBox.innerHTML = '';

    function opt(val, title, desc) {
      var input = el('input', {
        type: 'radio', name: 'st-oncancel', value: val, checked: g.onCancel === val,
        on: { change: function () { if (input.checked) saveGen({ onCancel: val }); } }
      });
      return el('label', { class: 'radio-card', style: 'flex:1 1 190px' }, [
        input, el('span', { class: 't' }, [el('b', { text: title }), el('small', { text: desc })])
      ]);
    }
    cancelBox.appendChild(el('div', { class: 'field' }, [
      el('span', { class: 'lbl', text: '默认怎么收尾' }),
      el('div', { class: 'radio-cards', style: 'flex-direction:row;flex-wrap:wrap' }, [
        opt('keep', '保留', '半成品页面留着，你自己看完再处理。'),
        opt('clear', '清除', '自动删掉本次产生的临时件与半成品。')
      ]),
      el('div', { class: 'hint', text: '无论选哪个，勾了上面那项才免掉弹窗；清除也一律先把清单列出来给你确认，才会真删。' })
    ]));

    var cb = el('input', {
      type: 'checkbox', checked: g.onCancelAsk,
      on: { change: function () { saveGen({ onCancelAsk: cb.checked }); } }
    });
    cancelBox.appendChild(el('label', { class: 'checkline' }, [
      cb,
      el('span', { class: 't' }, [
        el('b', { text: '每次取消都先问我' }),
        el('small', { text: g.onCancelAsk
          ? '取消时弹窗，让你当场选保留还是清除（窗口里可勾「以后都这样」）。'
          : '不再弹窗，直接按上面这个选择做。想改回每次都问，把这一项勾上。' })
      ])
    ]));
  }

  function buildCancelCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'card-head' }, [
      el('h2', { text: '取消任务时' }),
      el('div', { class: 'right' }, [el('span', { class: 'hint', text: '指生成跑到一半时点「取消」' })])
    ]));
    cancelBox = el('div', {});
    card.appendChild(cancelBox);
    paintCancelCard();
    return card;
  }

  /* ---------- 组装 ---------- */

  function build() {
    root.appendChild(ctx.pageHead({
      title: '设置',
      sub: '这个工具不内置大模型，用的是你自己的 API Key',
      actions: [
        el('button', { class: 'btn sm', type: 'button', on: { click: doImport } }, [icon('upload'), el('span', { text: '导入' })]),
        el('button', { class: 'btn sm', type: 'button', on: { click: doExport } }, [icon('download'), el('span', { text: '导出' })])
      ]
    }));

    var s = ctx.state;
    if (!draft && !s.settingsLoaded && !s.settings) {
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'empty' }, [ctx.spinner('lg'), el('b', { text: '正在读设置…' })])
      ]));
      if (!settingsWatcher) {
        settingsWatcher = ctx.on('settings', function () {
          if (settingsWatcher) { settingsWatcher(); settingsWatcher = null; }
          if (ctx.route() === 'settings') ctx.go('#settings');   // 触发整页重挂，拿到刚读回来的设置
        });
      }
      return;
    }
    if (!draft) {
      if (s.settings) {
        draft = normalize(s.settings);
        origJson = serializable();
        selId = draft.providers.length ? draft.providers[0].id : '';
      } else {
        root.appendChild(el('div', { class: 'banner warn' }, [
          icon('alert'),
          el('div', { class: 'bt' }, [
            el('b', { text: '读不到配置文件' }),
            el('div', { text: '主进程没能返回设置，下面的内容可能不全。可以重试一次。' }),
            s.settingsError ? el('div', { class: 'hint mono', text: ctx.clip((s.settingsError && s.settingsError.message) || String(s.settingsError), 240) }) : null,
            el('div', { style: 'margin-top:8px;display:flex;gap:8px' }, [
              el('button', {
                class: 'btn sm primary', type: 'button', text: '重新读取',
                on: {
                  click: function () {
                    ctx.call('getSettings').then(function (res) {
                      ctx.state.settingsLoaded = true;
                      if (res.ok) { ctx.state.settings = res.data; ctx.state.settingsError = null; }
                      else ctx.state.settingsError = res.error;
                      selId = '';
                      root.innerHTML = '';
                      build();
                    });
                  }
                }
              }),
              s.settingsError ? ctx.detailButton(s.settingsError) : null
            ])
          ])
        ]));
        draft = normalize({});
        origJson = serializable();
        selId = '';
      }
    }

    noticeBox = el('div', {});
    root.appendChild(noticeBox);
    renderNotice();

    // 外观（深浅色 + 背景图）放最上面：这一页往下拉很长，而"背景太黑/太白"是
    // 用户第一眼就想改的东西，埋在最底下等于没做。
    root.appendChild(buildAppearanceCard());
    // 「取消任务时」紧跟外观：都是"这个应用自己的行为设置"，和下面的提供商无关。
    root.appendChild(buildCancelCard());
    // 再一块很短的「Key 从哪来」：它和外观无关，但同属"这个应用自己的设置"，
    // 而下面的提供商列表是另一回事。放在列表上面，用户扫一眼就知道 Key 的出处。
    root.appendChild(buildKeySourceCard());

    var layout = el('div', { class: 'settings-layout' }, []);
    listBox = el('div', {});
    detailBox = el('div', {});
    layout.appendChild(listBox);
    layout.appendChild(detailBox);
    root.appendChild(layout);

    footBox = el('div', { class: 'sticky-foot' });
    root.appendChild(footBox);

    refreshList();
    refreshDetail();
    refreshFoot();
    paintBackground();
    // 每次进设置页都跟主进程核对一次背景图（磁盘上的那份才算数），
    // 回来之后重画一遍：万一在别处换过图，这里显示的不会是旧名字。
    ctx.bgRefresh().then(function () { if (bgStateBox) paintBackground(); });
  }

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    build();
  }
  function unmount() {
    if (settingsWatcher) { try { settingsWatcher(); } catch (e) { } settingsWatcher = null; }
    root = null; ctx = null;
    listBox = detailBox = footBox = noticeBox = null;
    bgStateBox = bgAdjustBox = null;
    rangeScrim = rangeBlur = null;
    cancelBox = null;
    importing = false;
  }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.settings = { mount: mount, unmount: unmount };
})();
