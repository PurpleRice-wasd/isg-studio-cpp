# 大肥鱼（内置陪练形象）· 素材来源与许可

这个目录里的两套图**不是本项目画的**，来自第三方开源仓库：

| 项 | 内容 |
|---|---|
| 来源 | https://github.com/1190fasheqi/dafeiyu-pet （大肥鱼桌宠 🐋） |
| 取用版本 | 分支 `main`，commit [`5b0e018`](https://github.com/1190fasheqi/dafeiyu-pet/commit/5b0e01856116bd2bae82df1f43c32faa5f056196)（2026-08-11） |
| 取用文件 | `sprites/正面_187.png` → 本目录 `front_187.png`；`sprites/侧面_187.png` → `side_187.png` |
| 文件校验 | `front_187.png` md5 `ce5b663801959a7518589c39083035c0`；`side_187.png` md5 `2dea30e0a96d91e7f01b81c2f92ba6f3`（与上游逐字节相同，未改动） |
| 作者许可 | MIT，原文见同目录 [`LICENSE.txt`](LICENSE.txt)（**分发时必须一起带上，不要删**） |
| 形象出处 | 该仓库自述为「DeepSeek V4 Pro 二创形象『鲸鱼娘·大肥鱼』」，即该美术本身是同人二创 |

## 本项目做了什么改动

1. 把两张 PNG 从 256 色调色板量化（`colors=256, FASTOCTREE`），尺寸不变
   （`front_187.png` 140×187 → 约 12.5KB；`side_187.png` 122×187 → 约 9.6KB）；
2. 把量化后的字节以 `data:image/png;base64,…` 的形式嵌进 `assets/quiz-engine.js` 的 `FISH` 常量，
   这样**页面不用额外带图文件**、离线也能用（见 `references/pet-guide.md`）；
3. 在 `assets/quiz-engine.js` 里 `FISH` 常量的正上方**内联了一份 MIT 许可原文**。

原图（未量化）留在这里，方便需要更高清时重新内嵌。**除以上三点，没有对素材做其他改动。**

### 关于第 3 点：为什么许可要内联进引擎

因为**引擎会被整段复制进每一张生成的页面**，而页面里嵌着这份美术的 base64 ——
每一份交付物都含该素材的副本。MIT 的条款是「许可原文随**所有副本**一起分发」，
只写一句"许可见 `third-party/dafeiyu-pet/`"不够：那个目录不跟着页面走。
（改动前的实测：生成的页面里出处指引和美术 base64 都在，`Permission is hereby granted`
出现 **0** 次。）

所以那段许可**不要删、也不要挪走**。它跟 `FISH` 是绑在一起的：
把 `FISH` 两个串置空就等于不再分发这份素材，那时许可才可以一起去掉。

## 这份素材还会出现在仓库的哪些地方

- `assets/quiz-engine.js` 的 `FISH` 常量（base64 内嵌）＋紧随其后的 MIT 许可原文（见上）；
- `assets/page-skeleton.html` 里那段**内联的引擎副本**（由 `sync-skeleton.py` 从上面那个文件同步过去，
  跑 `python assets/sync-skeleton.py` 会检查两边有没有走散）；
- 根目录 `docs/preview-light.png` / `docs/preview-dark.png` 两张预览截图——右下角的陪练就是它；
- 使用者用它生成的 HTML（内嵌同一份 base64 与同一段许可原文）。

除以上位置外，仓库内不含该素材（`pet.png` / `venti.*` 这类文件属于使用者自备图片，已被 `.gitignore` 挡住）。

## 换成别的形象 / 移除

- 只想换内置的那条鱼：改 `assets/quiz-engine.js` 里 `FISH` 的两个 base64 串即可
  （记得同步骨架页里内联的那一份——跑 `python assets/sync-skeleton.py --write` 就行）；
- 想用自己找的图：不用碰这里——把图片命名为 `pet.png` / `pet.jpg` 放到 HTML 旁边即可（见 `references/pet-guide.md`）；
- **原作者若有异议**：请开 issue 或联系仓库维护者，我们会立即移除这份素材（含上述所有出现位置），
  页面会自动回退为「不使用内置形象」（把 `FISH` 两个串置空即为此状态）。

## 使用上的提醒

MIT 只约束「作者有权许可的部分」。这套美术是同人二创，公开分发或商用前请自行确认风险；
若不想承担这个风险，把 `FISH` 里的两个串置空即可（引擎在 `FISH.front` 为空时不会提供「大肥鱼」这个选项，其余功能照常）。
