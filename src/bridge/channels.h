// `window.isg` 的 **31 个 invoke 通道** —— 全工程唯一的一份清单。
//
// 对应 oracle 的 `src/main/preload.js` 里的 `CHANNELS` 数组。纲领 §4.3 把"先冻结契约面"
// 排在 Phase 1 的第一件事，理由就是这个工程最怕静默失效：
// **未实现的通道必须明确报错，不许静默返回 undefined** —— 返回 undefined 会让渲染层
// 静默走错分支（"没有任务"、"没有设置"），而那正是本项目最恨的一类 bug。
//
// ⚠️ 数出来是 **31 条**，不是 32。历史上这里写过"32 个通道"，那是把 `job:event` 也算进去了，
// 而它是**订阅**（Host → Page 的单向事件），不是 invoke 通道；照字面登记会多出一个
// 不存在的通道，而"多登记一个"恰好会让 31 这个数变成 32、把这条判据的分子撑住。
// `bridge.cpp` 里有一条 static_assert 钉住这个数。
#pragma once

#include <string>

namespace isg {

// 顺序与 preload.js 的 CHANNELS 一致（便于两边对照阅读）。
extern const char* const kChannels[];

// 编译期就钉住条数：改了表却忘了改这里，构建直接失败。
// （运期那条判据在 tools/phase1-verify.ps1 里，两者都要有：
//   这里的 static_assert 防"改错了"，那边的判据防"整张表被替换成了别的东西"。）
constexpr int kChannelCount = 31;

bool is_known_channel(const std::string& name);

/* 事件通道名（Host → Page）。**不是** invoke 通道，但它同样只有一份清单。 */
extern const char* const kEventJobEvent;   // "job:event"

}  // namespace isg
