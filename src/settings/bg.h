// 工作台界面的背景图：导入、替换、移除。对应 oracle 的 src/main/bg.js。
//
// 三个刻意的设计（照抄 oracle，理由一字不改）：
//   1. **导入 = 复制进配置目录**（`<userData>/background/`），不是记住原图路径 ——
//      用户选完图往往把原图挪走/改名/删掉，记路径的话下次打开就是一片空白。
//   2. **只放行这一个目录**，不是把整个 userData 开成可读区 ——
//      白名单把 userData 整个放行，渲染进程就能读到同目录下的 settings.json
//      （里面有加密后的 API Key 材料）。
//   3. **文件名固定 + 换扩展名时删掉旧的** —— 不该在磁盘上攒出 background-1.png/2.jpg。
#pragma once

#include <string>
#include <vector>

namespace isg {

/* 允许的图片扩展名（小写，含点）。webp 也认。 */
extern const char* const kBgAllowedExt[4];

/* 配置目录下的 background/ 目录（不创建）。 */
std::wstring bg_dir();

/* 建目录并返回它。 */
std::wstring bg_ensure_dir();

/* 磁盘上现存的背景图绝对路径；没有返回空串。 */
std::wstring bg_current_file();

struct BgImportResult {
    std::string file;    // 文件名（只这一层，界面只该拿到名字）
    std::wstring abs;    // 绝对路径（主进程内部用）
    int64_t bytes = 0;
};

/* 把用户选的图导入进来。失败**抛 std::runtime_error 风格的错误**——
   本项目宿主侧不抛异常，所以这里用"返回 false + 把原因写进 err"的形态。 */
bool bg_import_from(const std::wstring& srcPath, BgImportResult& out, std::string& err);

/* 删掉现存背景图（换图与移除都走它，保证目录里只会有一张）。
   keep 非空时留着那一份（导入时用来保护"刚写好、还没改名就位"的新图）。 */
std::vector<std::string> bg_remove_all(const std::wstring& keep);

/* 移除背景图。 */
std::vector<std::string> bg_clear();

}  // namespace isg
