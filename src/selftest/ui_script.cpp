// `--selftest=ui` 在真页面里跑的那段脚本。
//
// 单独一个文件而不是塞在 C++ 里当字符串，是因为它本质上是一段**前端代码**：
// 语法高亮、括号匹配、以及"它到底在测什么"都要能直接读。
//
// 为什么非要真页面（而不是在宿主里直接调 Dispatch）：
// 这一层要验的恰恰是"渲染层原样搬过来还能不能动"——方法名、信封形状、
// 取消订阅函数、拖拽取路径、以及**未实现的通道会不会明确报错**，
// 全都只有把真脚本加载起来、走一遍 postMessage 往返才验得到。
//
// 三条写这段脚本的纪律（都是被真实事故逼出来的）：
//   ① **每一步都 trace**。卡住的时候宿主那一侧只看得到"ExecuteScript 一直不 resolve"，
//      没有 trace 就只能猜卡在哪。trace 走 `kind:'trace'` 那条消息，宿主落进报告。
//   ② **每一段自己 try/catch**。一个 await 永远不 settle 会让整个脚本悬住；
//      分段之后至少能说清"死在哪一段"。
//   ③ **总超时兜底**。每一段都 race 一个计时器，保证脚本无论如何都会走到结尾。
//   ④ **结果是回传的，不是 return 的**。WebView2 的 `ExecuteScript` **不等 Promise**：
//      脚本 return 一个 Promise，它拿到的是 `{}`（"Promise 没法序列化"）。
//      Electron 的 `executeJavaScript` 会等，所以照搬那一套只会得到一句
//      "自测脚本返回了（2 字节）：{}" —— 看上去像脚本什么都没干（踩过）。
//      这里改成最后 post 一条 `kind:'selftestResult'` 的消息把结果送回去。
#include "selftest.h"

namespace isg {

const std::string& selftest_ui_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const t0 = Date.now();
  const trace = (s) => {
    try {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'trace', text: s }));
      }
    } catch (e) { /* trace 失败不能影响检查本身 */ }
  };
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    const line = (ok ? '  [ok]  ' : '  [BAD] ') + name
               + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra));
    lines.push(line);
    trace('check: ' + name + (ok ? '' : '  ← 没过'));
  };
  const api = window.isg;
  const send = (payload) => {
    try {
      window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload: payload }));
    } catch (e) { /* 送不回去就没救了，宿主那侧的超时兜底会兜住 */ }
  };

  /* 每一段自己兜住异常，**并且自己带超时**。
     只 try/catch 是不够的：真正把脚本挂死的是"某个 Promise 永远不 settle"
     （桥上没回、iframe 不 load），而那不会抛 —— 它会静静地等下去，
     直到宿主那侧的超时把整个进程杀掉，而杀掉之后连报告都没有。
     race 一个 15 秒的计时器，把"卡住"变成一条明确的判据失败。 */
  const PHASE_TIMEOUT_MS = 15000;
  async function phase(name, fn) {
    trace('phase 开始: ' + name);
    let timer = 0;
    try {
      await Promise.race([
        fn(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('超过 ' + PHASE_TIMEOUT_MS + ' ms 没有跑完（多半是某个请求没有得到应答）')),
                             PHASE_TIMEOUT_MS);
        })
      ]);
    } catch (e) {
      check('第「' + name + '」段跑完没有抛异常 / 没有卡住', false, String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
      trace('phase 结束: ' + name);
    }
  }

  /* ---- 1. 桥本身 ---- */
  await phase('桥本身', async () => {
    check('window.isg 存在', !!api);
    if (!api) throw new Error('window.isg 不存在（页面侧的桥没加载？）');
    const METHODS = ['appInfo','openPath','openExternal','revealPath','previewUrl','registerPath',
      'takePendingFile','pickFile','pickOutputDir','pickImage','backgroundInfo','importBackground',
      'clearBackground','getSettings','saveSettings','testConnection','exportSettings','importSettings',
      'startGeneration','cancelGeneration','answerGeneration','getJob','listJobs','scanCleanup','doCleanup',
      'listBookChapters','pickBookFile','inspectBookChapter','bookContinuity','previewExtract','verifyHtml',
      'pathForFile','onJobEvent'];
    const missing = METHODS.filter((m) => typeof api[m] !== 'function');
    check('window.isg 上 31 个方法 + pathForFile + onJobEvent 都在', missing.length === 0, missing.join('、'));
    const off = api.onJobEvent(function () {});
    check('onJobEvent 返回的是取消订阅函数（渲染层是同步用它的，不能是 Promise）', typeof off === 'function');
    if (typeof off === 'function') off();
  });

  /* ---- 2. appInfo ---- */
  await phase('appInfo', async () => {
    const info = await api.appInfo();
    check('appInfo 回了信封', !!info && typeof info.ok === 'boolean');
    check('appInfo 带版本号', !!(info && info.ok && info.data && info.data.version),
          info && info.ok ? info.data.version : '');
    check('appInfo 报出了配置目录', !!(info && info.ok && info.data && info.data.userData));
    check('appInfo 报出了 skill 目录 / 或给出找不到的原因',
      !!(info && info.ok && info.data && (info.data.skillDir || info.data.hasSkill === false)),
      info && info.ok ? (info.data.skillDir || info.data.skillError) : '');
    check('配置目录是纯 ASCII（中文路径会让 WebView2 静默退出）',
      !!(info && info.ok && info.data && /^[\x20-\x7E]*$/.test(info.data.userData || 'x')),
      info && info.ok ? info.data.userData : '');
  });

  /* ---- 3. 设置往返 ---- */
  await phase('设置往返', async () => {
    const before = await api.getSettings();
    check('getSettings 是 ok 信封', !!(before && before.ok === true));
    const pubText = JSON.stringify(before && before.data);
    check('公开设置里没有 apiKey 字段', pubText.indexOf('"apiKey"') < 0);
    check('公开设置里没有 apiKeyEnc 字段', pubText.indexOf('apiKeyEnc') < 0);
    const anyProv = before && before.data && before.data.providers && before.data.providers.deepseek;
    check('提供商带 hasKey / keyHint（不是明文）',
      !!(anyProv && typeof anyProv.hasKey === 'boolean' && typeof anyProv.keyHint === 'string'),
      anyProv ? JSON.stringify(anyProv.keyHint) : '');
    check('公开设置里带了 keyStorage（界面据此显示「未加密」警告条）',
      !!(before && before.data && before.data.keyStorage));

    const saved = await api.saveSettings({ ui: { bgScrim: 41 } });
    check('saveSettings 生效', !!(saved && saved.ok && saved.data && saved.data.ui && saved.data.ui.bgScrim === 41),
      saved && saved.ok ? String(saved.data.ui.bgScrim) : JSON.stringify(saved && saved.error));
    const after = await api.getSettings();
    check('再读一次还是 41（真的落盘了，不是只改了内存里的副本）',
      !!(after && after.ok && after.data.ui.bgScrim === 41));
    const clamped = await api.saveSettings({ ui: { bgScrim: 999, bgBlur: -5, bgImage: '../../evil.png' } });
    check('越界值被钳制（999→90，-5→0）',
      !!(clamped && clamped.ok && clamped.data.ui.bgScrim === 90 && clamped.data.ui.bgBlur === 0),
      clamped && clamped.ok ? (clamped.data.ui.bgScrim + '/' + clamped.data.ui.bgBlur) : '');
    check('bgImage 只留文件名（挡掉路径穿越）',
      !!(clamped && clamped.ok && clamped.data.ui.bgImage === 'evil.png'),
      clamped && clamped.ok ? clamped.data.ui.bgImage : '');
    await api.saveSettings({ ui: { bgScrim: 35, bgBlur: 6, bgImage: '' } });
  });

  /* ---- 4. 失败必须**明确报错**（不许静默返回 null/undefined） ----
     Phase 6 之后 31 个公开通道全部有实现，"未实现"这条契约改由**参数/状态错误**来验：
     通道收到做不到的请求时，仍然要回一个带 code 与人话的失败信封。 */
  await phase('失败信封', async () => {
    const nj = await api.scanCleanup('none');
    check('未知任务号的清理请求返回失败信封（不是静默返回 null）', !!(nj && nj.ok === false));
    check('失败信封带明确 code（NOT_FOUND）', !!(nj && nj.error && nj.error.code === 'NOT_FOUND'),
      nj && nj.error ? nj.error.code : '');
    check('错误文案说清了"为什么没法做"',
      !!(nj && nj.error && nj.error.message && nj.error.message.length > 10),
      nj && nj.error ? nj.error.message : '');
    const nj2 = await api.verifyHtml('', ['verify']);
    check('缺参数的校验请求同样明确报错（BAD_ARG）',
      !!(nj2 && nj2.ok === false && nj2.error.code === 'BAD_ARG'),
      nj2 && nj2.error ? nj2.error.code : '');
  });

  /* ---- 5. 外链白名单 ---- */
  await phase('外链白名单', async () => {
    const r1 = await api.openExternal('javascript:alert(1)');
    check('javascript: 被拒', !!(r1 && r1.ok === false));
    const r2 = await api.openExternal('file:///C:/Windows/win.ini');
    check('file: 被拒', !!(r2 && r2.ok === false));
    const r3 = await api.openExternal('不是一个网址');
    check('不是网址的直接拒', !!(r3 && r3.ok === false));
    const r4 = await api.openPath('https://www.deepseek.com');
    check('拿网址去调 openPath 会被拒（这正是原来那个「链接坏了」的 bug）', !!(r4 && r4.ok === false));
  });

  /* ---- 6. 背景图 ---- */
  await phase('背景图', async () => {
    const bg = await api.backgroundInfo();
    check('backgroundInfo 回信封', !!(bg && typeof bg.ok === 'boolean'));
    check('backgroundInfo 的字段齐（file / url / bytes）',
      !!(bg && bg.ok && bg.data && 'file' in bg.data && 'url' in bg.data && 'bytes' in bg.data));
  });

  /* ---- 7. isg:// 协议真的把文档服务出来了 ---- */
  await phase('isg 协议', async () => {
    const PROBE = __ISG_PROBE_HTML__;
    const pu = await api.previewUrl(PROBE);
    check('previewUrl 对放行过的文件给出 isg:// URL',
      !!(pu && pu.ok && pu.data && /^isg:\/\/local\//.test(pu.data.url)),
      pu && pu.ok ? pu.data.url : JSON.stringify(pu && pu.error));
    if (pu && pu.ok) {
      const loaded = await new Promise((res) => {
        const f = document.createElement('iframe');
        f.style.cssText = 'width:160px;height:80px;position:fixed;left:-9999px;top:0';
        let done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        f.onload = () => finish(true);
        f.onerror = () => finish(false);
        setTimeout(() => finish(false), 6000);
        f.src = pu.data.url;
        document.body.appendChild(f);
      });
      check('isg:// 的文档真的被服务出来了（iframe 真的 onload）', loaded);
    }
    const notAllowed = await api.previewUrl('C:\\Windows\\win.ini');
    check('没放行过的路径被 previewUrl 拒掉（理由要具体，不是含混的「读不到」）',
      !!(notAllowed && notAllowed.ok === false && notAllowed.error.code === 'NOT_ALLOWED'),
      notAllowed && notAllowed.error ? notAllowed.error.code : '');
  });

  /* ---- 8. 抽取预览：桥 → 抽取层 → 界面可编辑 ---- */
  await phase('抽取预览', async () => {
    const FILE = __ISG_EXTRACT_FILE__;
    const ctx = window.ISGCtx;
    check('渲染层暴露了 ISGCtx（自测需要一个可编程入口）', !!ctx && !!ctx.state);
    if (!ctx) return;

    /* 先测"没放行的路径"必须被明确拒绝。 */
    const denied = await api.previewExtract('C:\Windows\win.ini');
    check('未放行的路径被 extract:preview 拒掉（NOT_ALLOWED，不是含混的读不到）',
      !!(denied && denied.ok === false && denied.error && denied.error.code === 'NOT_ALLOWED'),
      denied && denied.error ? denied.error.code : '');

    const src = ctx.addSource(ctx.DEFAULT_ROLE, FILE);
    check('材料加进了清单', !!src && Array.isArray(ctx.state.sources) && ctx.state.sources.length === 1);
    if (!src) return;
    const loaded = await ctx.loadExtract(src.id);
    check('loadExtract 真的走通了桥（不是静默失败）', !!(loaded && loaded.ok === true),
      loaded && loaded.ok === false ? JSON.stringify(loaded.error) : '');
    const ex = src.extract;
    check('抽到 kind=text', !!(ex && ex.kind === 'text'), ex ? ex.kind : 'null');
    check('抽到 3 节（Markdown 标题切页）', !!(ex && ex.pages && ex.pages.length === 3),
      ex && ex.pages ? String(ex.pages.length) : '');
    check('契约字段齐（quality.chars/cjkRatio/suspect + meta.pageCount）',
      !!(ex && ex.pages && ex.pages[0] && ex.pages[0].quality
         && typeof ex.pages[0].quality.chars === 'number'
         && typeof ex.pages[0].quality.cjkRatio === 'number'
         && typeof ex.pages[0].quality.suspect === 'boolean'
         && ex.meta && ex.meta.pageCount === 3));
    check('正文真的抽出来了（含「椭球参数」）',
      !!(ex && ex.pages && ex.pages.some((p) => ((p.text || '') + ' ' + (p.title || '')).indexOf('椭球参数') >= 0)));

    /* 界面：切到抽取预览，应当为每一页渲染一个可编辑的 textarea。 */
    location.hash = '#extract';
    await new Promise((res) => setTimeout(res, 400));
    const boxes = document.querySelectorAll('textarea[aria-label^="第 "]');
    check('抽取预览为每一页渲染了可编辑 textarea', boxes.length >= 3, String(boxes.length));
    if (boxes.length) {
      const before = boxes[0].value;
      boxes[0].value = before + '\n自测追加一行';
      boxes[0].dispatchEvent(new Event('input', { bubbles: true }));
      const key = src.id + ':1';
      check('在 textarea 里改文字会写进 state.extractEdits（编辑真的生效）',
        typeof ctx.state.extractEdits[key] === 'string'
        && ctx.state.extractEdits[key].indexOf('自测追加一行') >= 0);
      /* 复原，别把用户真正的状态带脏（自测用的是临时配置目录，但这条纪律要对）。 */
      boxes[0].value = before;
      boxes[0].dispatchEvent(new Event('input', { bubbles: true }));
      check('改动复原后 extractEdits 里没有残留', !(key in ctx.state.extractEdits));
    }
    ctx.removeSource(src.id);
    location.hash = '#workbench';
    await new Promise((res) => setTimeout(res, 200));
  });

  /* ---- 9. 渲染层本身还活着 ---- */
  await phase('渲染层', async () => {
    check('侧栏渲染出来了（有 .navlist）', !!document.querySelector('.navlist'));
    /* ⚠️ **不能只看 `#viewRoot.children.length > 0`**。
       第三路审查证明过：`render()` 在 mount 之前就一定 append 一个 `.page`，
       mount 抛错还会再塞一个错误横幅 —— 于是"视图炸了"甚至"视图文件根本不存在"
       也照样是 5/5（`views[name]` 缺失时路由会**静默回落**到 workbench）。
       这里改成断言每个视图**自己的标题文字**，并且禁止出现"渲染失败"横幅。 */
    const expected = { workbench: '工作台', settings: '设置', run: '运行', result: '结果', about: '关于' };
    let routesOk = 0;
    for (const r of ['workbench', 'settings', 'run', 'result', 'about']) {
      location.hash = '#' + r;
      await new Promise((res) => setTimeout(res, 180));
      const root = document.getElementById('viewRoot');
      const text = root ? root.textContent : '';
      const failed = !!root && !!root.querySelector('.banner.warn') && text.indexOf('这个页面渲染失败了') >= 0;
      const hit = text.indexOf(expected[r]) >= 0;
      if (hit && !failed) routesOk++;
      else trace('路由 ' + r + '：标题命中=' + hit + ' 渲染失败横幅=' + failed);
    }
    check('五个视图各自渲染出自己的标题（工作台/设置/运行/结果/关于）',
          routesOk === 5, routesOk + '/5');
    /* ⚠️ 只看"有没有 .banner.warn"会把**合法的警告**（关于页的"没找到 skill 目录"、
       设置页的"Key 未加密"）当成渲染失败 —— 第三路审查在"skill 目录不存在"的环境里
       实测到这条假红。判据要钉的是**那句具体文案**。 */
    const rootText = (document.getElementById('viewRoot') || {}).textContent || '';
    check('没有出现「这个页面渲染失败了」这句文案', rootText.indexOf('这个页面渲染失败了') < 0);
    location.hash = '#workbench';
    await new Promise((res) => setTimeout(res, 250));
  });

  trace('脚本结束，用时 ' + (Date.now() - t0) + ' ms');
  lines.push(bad ? ('  === 页面内检查：' + bad + ' 项没过 ===') : '  === 页面内检查：全部通过 ===');
  send({ ok: bad === 0, bad: bad, lines: lines });
})().catch((e) => {
  /* 兜底：连最外层的 IIFE 都抛了（比如上面哪一段的语法在运行时炸了），
     也必须把结果送回去 —— 一句不回，宿主那边只能等到超时，而超时的报告里
     看不到真正的原因。 */
  send({ ok: false, bad: 1, lines: ['  [BAD] 自测脚本自己抛了：' + String((e && e.stack) || e)] });
});
)JS";
    return script;
}

}  // namespace isg
