/* 关于：版本、skill 来源、许可、第三方素材 */
(function () {
  'use strict';

  var root = null, ctx = null, el, icon;

  function join(a, b) {
    if (!a) return '';
    return String(a).replace(/[\\/]+$/, '') + '/' + b;
  }

  function kv(rows) {
    var dl = el('dl', { class: 'kv' });
    rows.forEach(function (r) {
      if (!r) return;
      dl.appendChild(el('dt', { text: r[0] }));
      dl.appendChild(el('dd', { class: r[2] ? '' : 'plain', text: r[1] === '' || r[1] === undefined || r[1] === null ? '—' : String(r[1]) }));
    });
    return dl;
  }

  function infoRows(info) {
    if (!info) return [['应用版本', null, true], ['平台', null, true], ['skill 目录', null, true], ['配置文件', null, true]];
    return [
      ['应用版本', 'v' + (info.version || '未知'), true],
      ['平台', info.platform || '未知', false],
      ['skill 目录', info.skillDir || '（没找到）', true],
      ['配置文件', info.settingsPath || '（未知）', true]
    ];
  }

  function pathRow(label, path, openLabel) {
    return el('div', { class: 'input-row', style: 'margin-top:10px' }, [
      el('div', { class: 'hint mono', style: 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', title: path || '', text: path || '—' }),
      el('button', {
        class: 'btn sm', type: 'button', disabled: !path,
        on: { click: function () { ctx.call('revealPath', path); } }
      }, [icon('folder'), el('span', { text: openLabel || '在文件夹中显示' })]),
      el('button', {
        class: 'btn sm ghost', type: 'button', disabled: !path,
        on: { click: function () { ctx.copy(path, '路径已复制'); } }
      }, [icon('copy')])
    ]);
  }

  function build() {
    var s = ctx.state;
    var info = s.appInfo;

    root.appendChild(ctx.pageHead({
      title: '关于',
      sub: '讲练一体工作台 · 把课件变成能讲能练的单文件学习页'
    }));

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'about-hero' }, [
        el('span', { class: 'logo' }, [icon('layers')]),
        el('div', {}, [
          el('h2', { text: '讲练一体工作台' }),
          el('div', { class: 'v', text: info ? ('v' + (info.version || '未知') + ' · ' + (info.platform || '')) : '正在读取版本…' }),
          el('div', { class: 'hint', style: 'margin-top:6px', text: '把 PPT / PDF / 文本交给大模型，生成一个讲解与练习紧挨着、能即时判分、能拖演示、进度会存盘的学习页。整个页面只有一个 HTML 文件，不联网也能用。' })
        ])
      ])
    ]));

    /* 运行环境 */
    var envCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '运行环境' })])
    ]);
    if (info) {
      envCard.appendChild(kv(infoRows(info)));
      if (info.hasSkill === false) {
        envCard.appendChild(el('div', { class: 'banner warn', style: 'margin:12px 0 0' }, [
          icon('alert'),
          el('div', { class: 'bt' }, [
            el('b', { text: '没有找到内核 skill 目录' }),
            el('div', { text: '这个应用的内核是 interactive-study-guide skill（提示词、页面骨架、判分引擎都在里面）。' +
              '没找到它就没法生成——打包版请确认安装包完整，开发态请确认仓库里 skills/interactive-study-guide 还在。' })
          ])
        ]));
      }
    } else {
      envCard.appendChild(el('div', { class: 'empty' }, [
        ctx.spinner('lg'),
        el('b', { text: '正在读取应用信息…' }),
        el('p', { text: '如果一直停在这里，说明主进程没有响应（window.isg.appInfo）。' }),
        el('button', {
          class: 'btn', type: 'button', text: '重新读取',
          on: {
            click: function () {
              ctx.call('appInfo').then(function (res) {
                if (res.ok) ctx.state.appInfo = res.data;
                root.innerHTML = '';
                build();
              });
            }
          }
        })
      ]));
    }
    root.appendChild(envCard);

    /* 内核 */
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '内核：interactive-study-guide skill' })]),
      el('div', { class: 'hint', text: '生成用的提示词、单文件页面骨架、判分引擎、页内校验探针，全部来自这个 skill；运行期原样随包分发，不做二次改造。' }),
      el('ul', { class: 'plain', style: 'margin-top:10px' }, [
        el('li', { text: 'SKILL.md —— 生成规范与验收标准' }),
        el('li', { text: 'references/ —— 页面结构与校验清单' }),
        el('li', { text: 'assets/ —— page-skeleton.html、quiz-engine.js、practice.css、探针脚本' })
      ]),
      pathRow('skill', info && info.skillDir, '打开 skill 目录')
    ]));

    /* 许可 */
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '许可' })]),
      kv([
        ['本应用', 'MIT License', false],
        ['内核 skill', 'MIT License', false]
      ]),
      el('div', { class: 'hint', style: 'margin-top:8px', text: '可以自由使用、修改、再分发，保留版权声明即可。' })
    ]));

    /* 第三方素材 */
    var thirdCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '第三方素材' })]),
      el('div', { class: 'banner info', style: 'margin-bottom:12px' }, [
        icon('image'),
        el('div', { class: 'bt' }, [
          el('b', { text: '内置「大肥鱼」陪练形象' }),
          el('div', { text: '素材来自开源项目 1190fasheqi/dafeiyu-pet（MIT 许可），经过量化后以 data URI 内嵌进页面引擎，' +
            '所以生成出来的 HTML 不用带任何图片文件也能显示陪练。原图、许可原文、出处与改动说明都在 skill 的 third-party/dafeiyu-pet/ 目录里。' })
        ])
      ]),
      el('div', { class: 'hint', text: '如果你更想用自己的形象：把 pet.png / pet.jpg 放到输出目录，页面会优先用它；不想要陪练，生成时选「不要陪练」，右下角会留 0px 空位。' })
    ]);
    if (info && info.skillDir) {
      thirdCard.appendChild(pathRow('third', join(info.skillDir, 'third-party/dafeiyu-pet'), '打开素材目录'));
    }
    root.appendChild(thirdCard);

    /* 一些说明 */
    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: '这个工具不做什么' })]),
      el('ul', { class: 'plain' }, [
        el('li', { text: '不内置模型、不代管你的账号：用的是你自己的 API Key，费用直接结算给你选的服务商。' }),
        el('li', { text: '不上传课件到我们这里：课件只在本机读取，只有拼好的提示词会发给你配的那家 API。' }),
        el('li', { text: '不引用任何 CDN 或网络字体：生成的学习页离线可用。' })
      ])
    ]));
  }

  function mount(r, c) {
    root = r; ctx = c; el = c.el; icon = c.icon;
    build();
  }
  function unmount() { root = null; ctx = null; }

  window.ISGViews = window.ISGViews || {};
  window.ISGViews.about = { mount: mount, unmount: unmount };
})();
