// `.env` 文件与系统环境变量 —— 让 API Key 能放在**应用配置之外**。
// 对应 oracle 的 src/main/env.js（逐条语义照搬，注释里的取舍一并继承）。
//
// 优先级（与 oracle 一致，是一种刻意的少见做法）：
//   `ISG_ENV_FILE` 指定的文件 > **系统环境变量 > .env 文件** > settings.json
//   系统环境变量压过 .env 的理由：排障时"临时 set 一个值试一下"必须立刻生效。
//
// ⚠️ `.env` 是**明文**，比 DPAPI 加密的 settings.json 弱。这是用户明确要的取舍
//   （"我自己的文件、我自己管"），但界面上必须说清楚 —— 设置页会标「来自 .env」
//   并给出文件路径（见 store 的 keyFromEnv / keyFrom 与 env::info）。
#pragma once

#include <string>

#include "../util/json_util.h"

namespace isg {

/* 每家的 Key 用哪几个环境变量名（`ISG_<ID>_API_KEY` 是通用形式，
   另外认各家自己惯用的名字）。与 env.js 的 KEY_VARS 一一对应。 */
const Json& env_key_vars();

/* 通用变量：不绑定某一家，直接指定"用哪家、哪个地址、哪个模型"。
   与 env.js 的 GENERIC 一一对应。 */
const Json& env_generic_vars();

/* 极简 .env 解析：KEY=VALUE、# 注释、可有可无的引号、容忍 `export ` 前缀与 CRLF。
   **顺序很重要：先剥行尾注释，再剥引号**（反过来会把带 ' #' 的引号值截断，见 env.js 注释）。 */
Json env_parse_text(const std::string& text);

/* 找 .env：显式指定 > 配置目录 > 当前工作目录 > 程序所在目录。找不到返回空串。 */
std::wstring env_find_env_file();

/* 读一次并缓存。日志字段：file / values / error / from。 */
struct EnvFile {
    std::wstring file;
    std::string error;
    Json values = Json::object();
};
const EnvFile& env_load();

/* 取一个变量：**系统环境变量优先于 .env**（见文件顶部的取舍）。取不到返回空串。 */
std::string env_get(const std::string& name);

/* 某家提供商的 Key（按 KEY_VARS + 通用 ISG_API_KEY 找）。没有返回 false。 */
bool env_key_for(const std::string& id, std::string& key, std::string& varName);

/* 把 .env / 环境变量**叠加**到一份设置上（不改入参）。
   out 里带上 `__applied` 数组（{provider, field, varName}）供界面显示"来自 .env"。 */
Json env_overlay(const Json& settings);

/* 给 About / 设置页看的诊断信息（**不含任何 Key 明文**）。
   只报"这次真的用上了"的变量名，不报 shell 里所有长得像 Key 的名字
   （oracle 踩过：把跑它的那个 shell 的几十个 ANTHROPIC_* 全列了出来）。 */
Json env_info();

/* 单测/改完 .env 之后要重新读（否则缓存会挡住）。 */
void env_reset();

}  // namespace isg
