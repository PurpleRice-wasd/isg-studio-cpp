// 窗口外观：标题栏的深浅色、圆角、以及"跟随系统"的判定。
//
// ⚠️ Phase 1 的**已知缺口**（记账在 docs/phase1-design.md）：
// 渲染层的主题存在它自己的 localStorage 里（app.js 的 applyTheme），宿主读不到；
// 所以标题栏只在**启动时**按系统设置定一次，用户在界面里切主题不会立刻改到标题栏。
// 页面内容本身是对的（那是渲染层自己画的）。等 Phase 4/5 把界面与宿主的通道铺开之后
// 再加一条"主题变了"的事件，比现在硬猜一个标记更靠谱。
#pragma once

#include <windows.h>

namespace isg {

/* 系统现在是不是深色？（读 AppsUseLightTheme，读不到按浅色处理） */
bool system_prefers_dark();

/* 把窗口标题栏设成深色 / 浅色。返回是否真的设上了（老系统上这个属性可能不被支持）。 */
bool style_apply_dark_title_bar(HWND hwnd, bool dark);

/* 启动时调一次：按系统设置定标题栏。 */
void style_init_for_window(HWND hwnd);

}  // namespace isg
