// 设置持久化。对应 oracle 的 src/main/store.js（逐条语义照搬）。
//
// 两条铁律（oracle 文件头原话）：
//   1. API Key **只**在特权层里以明文存在，落盘一律走 DPAPI 加密；
//      渲染进程永远只拿得到 { hasKey, hint }。
//   2. 读设置一律**容错**：文件被手改坏、字段缺失、类型不对，都要能起来 ——
//      不许因为一个坏字段让应用打不开（用户唯一的补救手段就是删文件，太粗暴）。
//
// 与 oracle 的一处**有意的形态差异**：那边靠抛异常传错误（`throw new Error(...)`），
// 这边宿主侧没有 try/catch，所以凡是会失败的动作一律"返回 false + 把原因写进 err"。
// 但**错误文案与分支必须一一对应**：`providerConfig` 的两种拒绝理由（没填 Key / 没填 Base URL）
// 界面上是有区别的，不能合并。
#pragma once

#include <string>

#include "../util/json_util.h"

namespace isg {

/* 设置文件路径：`<userData>/settings.json`。 */
std::wstring settings_path();

/* 内置的默认设置。字段加在这里就等于给老用户做了迁移。 */
Json store_defaults();

/* 加密是否可用（等价于 safeStorage.isEncryptionAvailable()）。 */
bool store_encryption_available();

/* Key 的掩码。**唯一**允许离开特权层的 Key 形态。 */
std::string mask_key(const std::string& key);

/* 明文版设置（含明文 Key）。**只在特权层内流转，绝不整份发给渲染进程**。 */
Json get_settings();

/* 发给渲染进程的版本：Key 只留掩码与"有没有"。 */
Json get_public_settings();

/* 保存。apiKey 是特例：空串 = 不动，null = 清除，非空 = 覆盖。其余字段深合并。 */
Json save_settings(const Json& patch);

/* 取某个提供商的明文配置，供 llm 层直接用。失败返回 false 并把原因写进 err。 */
bool provider_config(const std::string& id, Json& out, std::string& err);

/* 导出：必须剥离 Key（导出的文件经常被分享/进云盘）。 */
Json export_settings();

/* 导入。失败返回 false + err。成功返回新的公开设置。 */
bool import_settings(const Json& obj, Json& publicOut, std::string& err);

/* 上一次加解密用的是什么存储（'encrypted' | 'plaintext'）。界面要显式警告明文存储。 */
const char* store_key_storage();

/* sanitize 的入口：给自测用（"喂一份坏掉的配置进去，看它修成什么样"）。
   changed 非空时写出"这次修过没有"（load() 靠它决定要不要立刻回写）。 */
Json store_sanitize(const Json& raw, bool* changed);

/* 丢弃缓存（自测要反复换配置文件）。 */
void store_reset_cache();

}  // namespace isg
