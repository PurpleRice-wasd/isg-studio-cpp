#include "providers.h"

#include "providers_data.h"

#include "../util/json_util.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <unordered_map>

namespace isg {

namespace {

/* 解析一次，之后只读。**故意不做容错**：这份 JSON 是编译进来的生成物，
   它要是坏的，说明生成步骤坏了 —— 那时候应该当场炸，而不是给出一张空表
   （空表的症状是"设置页里一家提供商都没有"，谁也想不到是数据文件的问题）。 */
struct Table {
    std::vector<Preset> list;
    std::unordered_map<std::string, size_t> byId;
};

const Table& table() {
    static const Table t = [] {
        Table out;
        Json arr = Json::parse(kProvidersJson, nullptr, false);
        if (arr.is_discarded() || !arr.is_array()) {
            ::OutputDebugStringA("[providers] 预设表 JSON 解析失败（生成物坏了？）\n");
            return out;
        }
        auto str = [](const Json& o, const char* k) -> std::string {
            auto it = o.find(k);
            return (it != o.end() && it->is_string()) ? it->get<std::string>() : std::string();
        };
        auto boolean = [](const Json& o, const char* k, bool dflt) -> bool {
            auto it = o.find(k);
            return (it != o.end() && it->is_boolean()) ? it->get<bool>() : dflt;
        };
        for (const Json& p : arr) {
            if (!p.is_object()) continue;
            Preset preset;
            preset.id = str(p, "id");
            if (preset.id.empty()) continue;
            preset.name = str(p, "name");
            preset.format = str(p, "format");
            preset.baseUrl = str(p, "baseUrl");
            preset.keyUrl = str(p, "keyUrl");
            preset.doc = str(p, "doc");
            preset.homepage = str(p, "homepage");
            preset.authField = str(p, "authField");
            preset.userAgent = str(p, "userAgent");
            preset.proxyHeader = str(p, "proxyHeader");
            preset.proxyBody = str(p, "proxyBody");
            preset.note = str(p, "note");
            preset.fullUrl = boolean(p, "fullUrl", false);
            preset.local = boolean(p, "local", false);
            // jsonMode「省略 = 支持」：所以默认值是 true，而不是 false
            preset.jsonMode = boolean(p, "jsonMode", true);
            if (auto it = p.find("order"); it != p.end() && it->is_number()) {
                preset.order = it->get<int>();
            }
            if (auto it = p.find("billing"); it != p.end() && it->is_object()) {
                preset.billingJson = json_dump(*it, -1);
            }
            if (auto it = p.find("models"); it != p.end() && it->is_array()) {
                for (const Json& m : *it) {
                    if (!m.is_object()) continue;
                    PresetModel pm;
                    pm.id = str(m, "id");
                    pm.name = str(m, "name");
                    pm.note = str(m, "note");
                    pm.vision = boolean(m, "vision", false);
                    auto num = [&](const char* k) -> int64_t {
                        auto it2 = m.find(k);
                        return (it2 != m.end() && it2->is_number()) ? it2->get<int64_t>() : 0;
                    };
                    pm.contextLimit = num("contextLimit");
                    pm.maxOutput = num("maxOutput");
                    if (!pm.id.empty()) preset.models.push_back(std::move(pm));
                }
            }
            out.byId.emplace(preset.id, out.list.size());
            out.list.push_back(std::move(preset));
        }
        return out;
    }();
    return t;
}

}  // namespace

const std::vector<Preset>& presets() { return table().list; }

const Preset* get_preset(const std::string& id) {
    if (id.empty()) return nullptr;
    const Table& t = table();
    // 与 oracle 的 getPreset 一致：先 trim 再查（设置文件是能手改的，前后空格很常见）
    const std::string key = trim(id);
    auto it = t.byId.find(key);
    return it == t.byId.end() ? nullptr : &t.list[it->second];
}

}  // namespace isg
