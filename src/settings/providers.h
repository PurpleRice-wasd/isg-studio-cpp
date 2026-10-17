// 提供商预设表（对应 oracle 的 src/main/providers.js）。
//
// **数据**来自生成物 providers_data.generated.cpp（单一真源仍是 providers.js）；
// 这一层只负责把它解析成结构体并按 id 查。
//
// oracle 的那份注释里有一条本文件必须继承的判据（test/llm-smoke.js 压着）：
//   「没标 vision 的模型必须有 note 说明」—— 所以 PresetModel 把 note 原样留着，
//   不要在解析时丢掉任何字段：将来 llm 层要用 fullUrl / authField / proxyHeader 等。
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace isg {

struct PresetModel {
    std::string id;
    std::string name;
    std::string note;          // "为什么这条算可信 / 哪儿未能确认"（不是用户备注）
    bool vision = false;
    int64_t contextLimit = 0;  // 一律 0 = 未声明（见 providers.js 顶部那段说明）
    int64_t maxOutput = 0;
};

struct Preset {
    std::string id;
    std::string name;
    std::string format;        // 'openai' | 'anthropic'
    std::string baseUrl;
    std::string keyUrl;
    std::string doc;
    std::string homepage;
    std::string authField;
    std::string userAgent;
    std::string proxyHeader;
    std::string proxyBody;
    std::string note;          // 预设说明文案（与设置里那个「备注」不是一回事）
    bool fullUrl = false;
    bool local = false;        // true = 本机端点，不需要 API Key
    bool jsonMode = true;      // 是否支持 response_format:{type:'json_object'}；省略=支持
    int order = 0;
    std::vector<PresetModel> models;
    // billing 用 JSON 原样留着（{enabled,inputPerM,outputPerM,currency}）：
    // 它要原样进设置文件的默认值，字段名与类型由 store 那一侧管。
    std::string billingJson;
};

/* 全部预设，**保持 providers.js 里的顺序**（那张表本身就是按 order 排的，
   重排会让设置页的列表顺序变了，而用户认的是那个顺序）。 */
const std::vector<Preset>& presets();

/* 按 id 取预设。取不到返回 nullptr（**不要**回退成 custom —— 那会让用户以为配置生效了）。 */
const Preset* get_preset(const std::string& id);

}  // namespace isg
