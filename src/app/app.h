// 应用级的路径、版本与"这一份东西在哪"。对应纲领 §3.6 的 app/。
//
// 一条硬规矩（纲领 §7.1 坑 1）：**配置目录必须是纯 ASCII**。
// Electron 拿中文 productName 当目录名 → `%APPDATA%\讲练一体工作台` →
// Chromium 初始化时报 `Unable to move the cache: 拒绝访问`，进程静默退出、退出码 0，
// 用户只看到"闪一下就没了"。所以目录名沿用 oracle 的 `isg-studio`（全是 ASCII），
// 给用户看的显示名才用中文。
#pragma once

#include <string>

namespace isg {

/* 配置目录：`%APPDATA%\isg-studio`。可被 ISG_USER_DATA 环境变量顶掉
   （自测要用临时目录，绝不能碰到用户真正的配置）。 */
std::wstring user_data_dir();

/* 程序所在目录（打包态下 assets 就在它旁边）。 */
std::wstring exe_dir();

/* 覆盖配置目录。**必须在任何读写设置之前调用**（自测用）。 */
void set_user_data_dir(const std::wstring& dir);

/* 应用版本。口径与 oracle 的 `version.js` 一致：只认打包进来的那个版本号，
   不认任何"运行时自报"的东西。 */
const char* app_version();

/* 显示名（给用户看的，可以是中文）。 */
const char* app_display_name();

/* skill 目录。查找顺序对齐 architecture.md §2：
   环境变量 ISG_SKILL_DIR > 打包态（<exe 旁>/skill）> 开发态向上找（<exe 旁>/../../../skills/interactive-study-guide）。
   **找不到时必须返回空串并由调用方报错**，不许静默回退成内置提示词。 */
std::wstring skill_dir();

/* skill_dir() 找不到时的**可读原因**（app:info 的 skillError 用它）。
   环境变量指错、缺 SKILL.md、根本没找到 —— 三种情况的说法不一样，界面要能区分。 */
const std::string& skill_dir_error();

/* 生成契约文档的位置（开发态在 apps/isg-studio/docs/，打包态在 <exe 旁>/docs/）。 */
std::wstring contract_path();

}  // namespace isg
