#include "store.h"

#include "bg.h"
#include "dpapi.h"
#include "oscrypt.h"
#include "env.h"
#include "providers.h"

#include "../app/app.h"
#include "../util/base64.h"
#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <cmath>
#include <string>
#include <vector>

namespace isg {

namespace {

constexpr char kFileName[] = "settings.json";

/* 新字段里那几个纯文本的限长（防手改/防粘贴一整篇文档进来把设置文件撑成几 MB）。
   ⚠️ 超长是**截断**而不是丢弃：截断后 JSON 解析会失败，llm 层按"没配"处理并 warn
   （DESIGN-1.4.0 §1.1 明确的行为），而"整段丢掉"会让用户以为自己没保存上。 */
constexpr size_t kTextMax = 500;
constexpr size_t kProxyMax = 8000;
/* authField 的白名单。认不出的一律归 ''（= 按 format 的默认）。
   绝不"原样透传"：这个值会被 llm 层拿去决定 Key 放在哪儿，一个拼错的值
   （'query '、'Query'、'bearer'）如果透传下去，最可能的表现是**Key 没带上却发了请求**
   → 401，而用户看到的是自己刚点过的那个选项，会觉得是应用坏了。 */
const char* const kAuthFields[4] = {"", "auth_header", "api_key_header", "query"};
/* 上下文/输出上限的硬上限：超过 200 万 tokens 的声明一定是填错了。 */
constexpr int64_t kTokenLimitMax = 2000000;

/* 提供商配置里**允许离开特权层**的字段（getPublicSettings 用的白名单）。
   以前是"整体深拷贝 → 删掉 apiKeyEnc"，安全审计实测出两个洞：
     · Key 材料写在别的字段名下（apiKey / secret / headers['X-Key'] / 嵌套一层 /
       顶层自定义字段）就会被原样发给渲染进程、也会被原样导出；
     · 设置页把 settings.json 的路径显示给用户，手改配置的人很自然就写成 apiKey。
   ⚠️ 1.4.0 新增的字段必须**同时**加进 KEEP、这里、以及 EXPORT 三张表；
   漏了 KEEP 那张的症状是"设置页保存了、重启就没了"（sanitize 当多余字段删掉，界面一切正常）。 */
const char* const kProviderFieldsPublic[] = {
    "enabled", "baseUrl", "format", "models", "name", "isCustom", "defaultModel",
    "note", "homepage", "fullUrl", "authField", "userAgent", "proxyHeader", "proxyBody", "billing"};
/* 导出：新字段要跟着走，但**依然一个 Key 都不带**。
   注意 `apiKeyEnc` 从不在任何一张表里 —— 别把它加进来。 */
const char* const kProviderFieldsExport[] = {
    "enabled", "baseUrl", "format", "models", "name",
    "note", "homepage", "fullUrl", "authField", "userAgent", "proxyHeader", "proxyBody", "billing"};

/* ---------- JS 语义的几个小函数 ----------
   sanitize 是从 JS 逐行翻过来的，里面到处是 `Number(v)` / `isFinite` / `!!v` / `Math.round`。
   这些函数存在的唯一目的就是让那些判断在 C++ 里**一看就能对上原文**，
   而不是每个调用点各自写一套近似的类型检查（那正是漂移的来源）。 */

/* Number(v) 的语义（这里只需要它返回"是不是一个可用数字 + 值"）：
   null→0、bool→1/0、""→0、字符串按 trim 后整体解析、其余 → 不是数字。 */
bool js_number(const Json& v, double& out) {
    if (v.is_number()) { out = v.get<double>(); return true; }
    if (v.is_null()) { out = 0.0; return true; }
    if (v.is_boolean()) { out = v.get<bool>() ? 1.0 : 0.0; return true; }
    if (v.is_string()) {
        const std::string s = trim(v.get<std::string>());
        if (s.empty()) { out = 0.0; return true; }
        try {
            size_t used = 0;
            const double d = std::stod(s, &used);
            if (used != s.size()) return false;      // "50px" 在 JS 里是 NaN
            out = d;
            return true;
        } catch (...) {
            return false;
        }
    }
    if (v.is_array()) {
        // JS: Number([]) === 0，Number([5]) === 5，更长的数组是 NaN
        if (v.empty()) { out = 0.0; return true; }
        if (v.size() == 1) return js_number(v[0], out);
        return false;
    }
    return false;   // 对象
}

/* JS 的 Math.round：**半数向 +∞ 取整**（Math.round(-0.5) === -0），
   与 std::round（半数远离 0）在负数上不同。这里的所有值在取整前都已夹到非负区间，
   但仍然照 JS 的写法来，免得将来有人复用这个函数时踩到差异。 */
double js_round(double x) { return std::floor(x + 0.5); }

/* 数字落盘时的形态。**这一条不做就等于改了用户的配置文件**：
   JS 里整数与小数是同一个 number 类型，而 `JSON.stringify(6)` 得到 `6`、`JSON.stringify(6.0)`
   也得到 `6`。C++ 这边如果一律塞 double，落盘会变成 `"units": 6.0` ——
   与 oracle 写出来的文件逐字节不同，对拍、diff、以及"老用户手改过的文件"全都会错位。
   所以：整数值一律存成整数，只有真的有小数部分才存浮点。 */
Json num_json(double v) {
    if (std::isfinite(v) && v == std::floor(v) && std::abs(v) < 9.0e15) {
        return Json(static_cast<int64_t>(v));
    }
    return Json(v);
}

Json clamp_num(const Json& v, double lo, double hi, double dflt) {
    double n = 0;
    if (!js_number(v, n) || !std::isfinite(n)) return num_json(dflt);
    const double r = js_round(n);
    return num_json(r < lo ? lo : (r > hi ? hi : r));
}

/* JS 的真值判定：false / 0 / "" / null / NaN / 缺失 → 假，其余（含对象与数组）→ 真。 */
bool js_truthy(const Json& v) {
    if (v.is_null()) return false;
    if (v.is_boolean()) return v.get<bool>();
    if (v.is_number()) { const double d = v.get<double>(); return d != 0 && !std::isnan(d); }
    if (v.is_string()) return !v.get<std::string>().empty();
    return true;
}

size_t count_utf16(const std::string& utf8) {
    /* JS 的 String.prototype.slice 按 **UTF-16 码元**切，不是码点。
       基本多文种平面（中文、拉丁、标点）两者一致；只有 emoji 这类代理对才有差别
       （JS 里算两个，我们按码点算一个）。差别只影响"超长文本在哪一个字被截断"，
       记录在 docs/phase1-design.md 的差异清单里，不为了它把整个字符串层换成 UTF-16。 */
    return utf8_length(utf8);
}

std::string slice_text(const Json& v, size_t max) {
    if (!v.is_string()) return std::string();
    const std::string s = v.get<std::string>();
    return utf8_truncate(s, max);
}

bool has_key(const Json& o, const char* k) { return o.is_object() && o.find(k) != o.end(); }

/* 深合并：只覆盖明确给出的字段，数组整体替换（不合并数组——那几乎总是错的）。
   就地改写 base（与 JS 的 deepMerge 一致）。 */
void deep_merge(Json& base, const Json& patch) {
    if (!patch.is_object() && !patch.is_array()) return;
    auto apply = [&](const std::string& key, const Json& v) {
        Json* slot = nullptr;
        if (base.is_object()) {
            if (!base.contains(key)) base[key] = Json();      // 先落一个 null 占位，保持插入顺序
            slot = &base[key];
        } else if (base.is_array()) {
            // 数组按下标当键（对应 JS 里对数组用 deepMerge 的行为）
            size_t idx = 0;
            try { idx = static_cast<size_t>(std::stoul(key)); } catch (...) { return; }
            while (base.size() <= idx) base.push_back(Json());
            slot = &base[idx];
        } else {
            return;
        }
        const bool vIsObj = v.is_object();
        if (vIsObj && slot->is_object()) {
            deep_merge(*slot, v);
        } else {
            *slot = v;
        }
    };
    /* ⚠️ **数组不能用 `it.key()`**：nlohmann 的 `key()` 对非 object 迭代器会抛
       `invalid_iterator.207`，而宿主侧没有 try/catch —— 抛出去就是 std::terminate，
       进程 0xC0000409 直接消失（Debug 下卡在 abort 对话框）。
       触发面不是"恶意输入"：settings.json 顶层写成 `[1,2,3]`、或者
       `"ui": {"recentDirs": ["C:\\a"]}` 这种**用户手写的无害数组**都会命中。
       而"读设置一律容错、坏字段不能让应用打不开"是这个文件的头号承诺。
       （这是第三路交叉审查用真实复现抓到的：exit=0xC0000409。） */
    if (patch.is_array()) {
        for (size_t i = 0; i < patch.size(); ++i) apply(std::to_string(i), patch[i]);
    } else {
        for (auto it = patch.begin(); it != patch.end(); ++it) apply(it.key(), it.value());
    }
}

Json deep_copy(const Json& v) { return Json::parse(json_dump(v, -1), nullptr, false); }

/* 计费字段的默认值。**每次都要新建对象**（不能共用一个常量：
   某一处改了 billing.currency，所有提供商的默认值会一起变——那是最难查的一类"串味"）。 */
Json billing_defaults() {
    Json b = Json::object();
    b["enabled"] = false;
    b["inputPerM"] = 0;
    b["outputPerM"] = 0;
    b["currency"] = "CNY";
    return b;
}

/* 某一家提供商的默认配置。
   defaults()（遍历预设）与 sanitize()（条目坏掉时的兜底）都走这里——
   两处各写一份必然漂移，而漂移的表现是"新装的提供商少了几个字段、界面显示成空"。 */
Json provider_defaults(const std::string& id) {
    const Preset* p = get_preset(id);
    Json out = Json::object();
    out["enabled"] = false;
    /* 显示名。默认照抄预设名；用户改了也只影响显示（id 才是身份）。
       注意 name 是 1.4.0 之前就存在的字段，语义不变。 */
    out["name"] = (p != nullptr && !p->name.empty()) ? p->name : id;
    out["note"] = "";                       // 用户自己的备注（与预设的说明文案不是一回事）
    out["homepage"] = (p != nullptr) ? p->homepage : "";
    out["fullUrl"] = false;
    out["authField"] = "";
    out["userAgent"] = "";
    out["proxyHeader"] = "";
    out["proxyBody"] = "";
    out["billing"] = billing_defaults();
    out["baseUrl"] = (p != nullptr) ? p->baseUrl : "";
    out["format"] = (p != nullptr) ? p->format : std::string();
    /* models 的持久形状是**对象数组**。
       ⚠️ 预设里那几个上限字段**一定给 0**：note 里的"100 万 token"是二手描述，
       抄成数字就等于替官方声明上限，会把请求的 max_tokens 直接定死。 */
    Json models = Json::array();
    if (p != nullptr) {
        for (const PresetModel& m : p->models) {
            Json one = Json::object();
            one["id"] = m.id;
            one["name"] = m.name;
            one["contextLimit"] = 0;
            one["maxOutput"] = 0;
            one["vision"] = m.vision;
            models.push_back(std::move(one));
        }
    }
    out["models"] = std::move(models);
    out["apiKeyEnc"] = "";
    return out;
}

Json defaults() {
    Json providers = Json::object();
    for (const Preset& p : presets()) providers[p.id] = provider_defaults(p.id);

    Json out = Json::object();
    out["version"] = 1;
    out["providers"] = std::move(providers);

    Json active = Json::object();
    active["provider"] = "deepseek";
    active["model"] = "";
    Json stages = Json::object();
    stages["analyze"] = "";
    stages["audit"] = "";
    active["stages"] = std::move(stages);
    out["active"] = std::move(active);

    Json g = Json::object();
    g["units"] = 6;
    g["points"] = 65;
    g["demos"] = 2;
    g["pet"] = "fish";             // none | fish | image
    g["petImagePath"] = "";        // 现状（别当它是活的）：全仓没有写入者
    g["theme"] = "auto";           // 现状（别当它是活的）：没有任何读取者
    g["outputDir"] = "";
    g["temperature"] = 0.4;
    g["concurrency"] = 3;
    g["repairRounds"] = 2;
    g["maxOutput"] = 0;            // 0 = 自动
    g["auditors"] = 1;             // 0–3：独立审题的人数
    g["audit"] = true;             // 老字段，保留兼容；sanitize 会把它折算成 auditors
    g["language"] = "zh-CN";
    g["onCancel"] = "keep";        // keep | clear
    g["onCancelAsk"] = true;
    out["generation"] = std::move(g);

    Json ui = Json::object();
    ui["lastView"] = "workbench";  // 现状（别当它是活的）：渲染进程用 location.hash 记路由
    ui["bgImage"] = "";            // 只记**文件名**
    ui["bgScrim"] = 35;            // 0–90
    ui["bgBlur"] = 6;              // 0–24 px
    out["ui"] = std::move(ui);
    return out;
}

/* 状态：读一次缓存住。keyStorage 是"这次进程里 Key 到底是怎么存的"，
   渲染层要据此显示"未加密"的警告条。 */
Json g_cache;
bool g_loaded = false;
std::string g_keyStorage = "encrypted";   // 'encrypted' | 'plaintext'

std::wstring settings_path_impl() { return user_data_dir() + L"\\" + to_wide(kFileName); }

std::string encrypt_key(const std::string& plain) {
    if (plain.empty()) return std::string();
    if (isg::encryption_available()) {
        std::string err;
        /* 用 **OSCrypt 格式**（不是裸 DPAPI）：oracle 的 safeStorage 落盘的就是这个，
           老配置要能读、我们写的也要能被它读 —— 兼容是双向的。见 oscrypt.h。 */
        std::string blob;
        if (oscrypt_encrypt(plain, blob, err)) {
            g_keyStorage = "encrypted";
            return "enc:" + base64_encode(blob);
        }
        /* 走到这里说明 DPAPI 出了问题。**不静默降级**——先记下来，
           由调用方决定要不要提示用户（getPublicSettings 会把 keyStorage 暴露出去）。 */
        log_warn("DPAPI 加密失败，退回明文存储：" + err);
    }
    g_keyStorage = "plaintext";
    return "raw:" + base64_encode(plain);
}

std::string decrypt_key(const std::string& stored) {
    if (stored.empty()) return std::string();
    if (starts_with(stored, "enc:")) {
        std::string blob;
        if (!base64_decode(stored.substr(4), blob)) {
            log_warn("已存的 Key 不是合法 base64");
            return std::string();
        }
        std::string err;
        std::string plain;
        if (oscrypt_decrypt(blob, plain, err)) return plain;
        /* 兼容更老的形态（裸 DPAPI，没有 v10 前缀）。解不开就记下来 ——
           换了机器/换了账户会导致这种情况，别报错，让用户重填就行。 */
        std::string legacy;
        std::string legacyErr;
        if (dpapi_decrypt_bytes(blob, legacy, legacyErr)) return legacy;
        log_warn("解不开已存的 Key：" + err);
        return std::string();
    }
    if (starts_with(stored, "raw:")) {
        g_keyStorage = "plaintext";
        std::string plain;
        if (!base64_decode(stored.substr(4), plain)) return std::string();
        return plain;
    }
    return std::string();
}

/* ---------- 递归清掉"键名像密钥材料"的字段 ---------- */
bool key_looks_secret(const std::string& key) {
    // 对应 /(api[-_]?key|secret|token|passwd|password|credential|authorization|bearer)/i
    const std::string k = ascii_lower(key);
    static const char* const needles[] = {"apikey", "api-key", "api_key", "secret", "token",
                                          "passwd", "password", "credential", "authorization", "bearer"};
    for (const char* n : needles) {
        if (k.find(n) != std::string::npos) return true;
    }
    return false;
}

bool drop_secret_fields(Json& obj, int depth) {
    if (depth > 8) return false;
    /* 数组要**逐元素递归**，而不是跳过：
       · `it.key()` 对数组会抛（见 deep_merge 上面的说明）；
       · 跳过数组则会留下一处真实的泄漏面 —— `active` / `generation` / `ui` 里的数组元素
         如果带 `apiKey` / `token` / `password`，它们会被整块拷进 get_public_settings
         与 export_settings（这两个地方对外发的是整份 active/generation/ui）。
       oracle 的 dropSecretFields 用 Object.keys 写数组也能递归进去，语义就是"数组里的也要清"。 */
    if (obj.is_array()) {
        bool arrayChanged = false;
        for (Json& v : obj) {
            if ((v.is_object() || v.is_array()) && drop_secret_fields(v, depth + 1)) arrayChanged = true;
        }
        return arrayChanged;
    }
    if (!obj.is_object()) return false;
    bool changed = false;
    // 先把键快照下来：**边遍历边删是未定义行为**（JS 那边 Object.keys() 天然是快照）
    std::vector<std::string> keys;
    keys.reserve(obj.size());
    for (auto it = obj.begin(); it != obj.end(); ++it) keys.push_back(it.key());

    for (const std::string& k : keys) {
        // `*Enc`（我们自己加密后存盘的约定）**永远不碰** —— 它是密文，删了就等于清空用户的 Key。
        if (ends_with(k, "Enc")) continue;
        if (key_looks_secret(k)) {
            obj.erase(k);
            changed = true;
            continue;
        }
        if (obj.contains(k) && (obj[k].is_object() || obj[k].is_array())) {
            if (drop_secret_fields(obj[k], depth + 1)) changed = true;
        }
    }
    return changed;
}

/* ---------- sanitize ---------- */

/* 把读进来的东西修回可用状态。*/
Json sanitize_impl(const Json& raw, bool* changedOut) {
  /* ⚠️ `d` 是**只读的默认值**，`out` 必须是它的**副本**。
   * 为什么不能直接把 `d` 交给 deepMerge：deepMerge 是**就地改写**的——
   * 它会往 `d` 里写调用方给的值。于是后面所有"回落到默认值"的写法（`d.generation.pet`、
   * `d.ui.bgScrim`…）读到的都是**被污染后的值本身**，回退等于没做：
   * 写坏的配置永远不会被修好，而且一声不响。
   * 实测踩到过：`bgScrim: "abc"` 一路原样通过（`dv` 就是那个 "abc"）。 */
  const Json d = defaults();
  Json notes = Json::array();
  bool changed = false;
  Json out = deep_copy(d);
  if (raw.is_object() || raw.is_array()) deep_merge(out, raw);

  /* 一处**有意的形态差异**：JS 里数组也是对象，所以 `providers: []` 会走进"逐项当提供商"的
     分支（留下一堆数字键，随后被 KEEP 白名单删光，等于所有提供商凭空消失）。
     nlohmann 不允许对数组用字符串下标（会抛，而宿主侧没有 try/catch），
     所以这里把"不是对象"（含数组）一律当成坏值 → 回落默认表。
     结果与 JS 那条路径的**最终形态**一致（都是回到默认表），只是不再经过那段中间态。 */
  if (!out.contains("providers") || !out["providers"].is_object()) {
    out["providers"] = d["providers"];
  }
  // 预设表里新增的提供商会自动补齐；被删掉的老 id 保留（用户可能自定义过）
  for (const Preset& p : presets()) {
    if (!out["providers"].contains(p.id)) out["providers"][p.id] = d["providers"][p.id];
  }

  // 遍历 providers：键快照（下面的兜底分支会替换整条，不能让迭代器失效）
  std::vector<std::string> ids;
  ids.reserve(out["providers"].size());
  for (auto it = out["providers"].begin(); it != out["providers"].end(); ++it) ids.push_back(it.key());

  for (const std::string& id : ids) {
    Json& cfg = out["providers"][id];
    // 数组也算"不是配置对象"：走这条兜底会得到一份完整的默认配置，
    // 而不是留下一堆数字键（它们随后会被 KEEP 白名单删掉，等于这家提供商凭空消失）
    if (!cfg.is_object()) {
      cfg = provider_defaults(id);
      continue;
    }

    /* models 的两种形状都认：**对象数组**（1.4.0 起）与**字符串数组**（老设置文件）。
       统一折成对象数组，并且：
         · **保持原顺序** —— 那就是设置页里的显示顺序；
         · **不去重** —— 字符串数组时代同一个 ID 出现两次是允许的；
         · 只丢掉"id 不是非空字符串"的项。
       contextLimit / maxOutput 是**声明值**：非法一律归 0 = 未声明，绝不"猜一个合理值"。 */
    const Json rawModels = (cfg.contains("models") && cfg["models"].is_array())
                             ? cfg["models"] : Json::array();
    Json folded = Json::array();
    bool sawNonObject = false;
    for (const Json& m : rawModels) {
      if (m.is_string()) {
        const std::string sid = trim(m.get<std::string>());
        if (!sid.empty()) {
          Json one = Json::object();
          one["id"] = sid;
          one["name"] = "";
          one["contextLimit"] = 0;
          one["maxOutput"] = 0;
          one["vision"] = false;
          folded.push_back(std::move(one));
        } else {
          changed = true;
        }
        sawNonObject = true;
        continue;
      }
      if (!m.is_object()) { changed = true; sawNonObject = true; continue; }
      auto str_field = [&](const char* k) -> std::string {
        auto it = m.find(k);
        return (it != m.end() && it->is_string()) ? it->get<std::string>() : std::string();
      };
      const std::string mid = trim(str_field("id"));
      if (mid.empty()) { changed = true; continue; }
      auto toks = [&](const char* k) -> int64_t {
        double n = 0;
        auto it = m.find(k);
        if (it == m.end() || !js_number(*it, n) || !std::isfinite(n) || n < 0) return 0;
        const double r = js_round(n);
        return static_cast<int64_t>(r > static_cast<double>(kTokenLimitMax) ? kTokenLimitMax : r);
      };
      Json one = Json::object();
      one["id"] = mid;
      one["name"] = utf8_truncate(str_field("name"), kTextMax);
      one["contextLimit"] = toks("contextLimit");
      one["maxOutput"] = toks("maxOutput");
      /* 严格 `=== true`，**不能**写 `!!m.vision`：设置文件是可以手改的，
         `vision: "false"` 用真值判定会变成 true —— 正好与字面意思相反。 */
      one["vision"] = (m.contains("vision") && m["vision"].is_boolean() && m["vision"].get<bool>());
      folded.push_back(std::move(one));
    }
    if (sawNonObject) changed = true;
    cfg["models"] = std::move(folded);

    if (!cfg.contains("format") || !cfg["format"].is_string()
        || (cfg["format"].get<std::string>() != "openai" && cfg["format"].get<std::string>() != "anthropic")) {
      cfg["format"] = "openai";
    }
    if (!cfg.contains("baseUrl") || !cfg["baseUrl"].is_string()) cfg["baseUrl"] = "";
    if (cfg.contains("enabled")) cfg["enabled"] = js_truthy(cfg["enabled"]);
    if (!cfg.contains("apiKeyEnc") || !cfg["apiKeyEnc"].is_string()) cfg["apiKeyEnc"] = "";

    /* ---------- 1.4.0 起的新字段 ---------- */
    /* 显示名。缺了 / 写坏了 → 回落预设名（别回落成 ''，界面上会变成一家没有名字的提供商）。
       ⚠️ 还有第三种情况：**`name` 恰好等于 id**。内置预设的名字永远不等于 id
       （`DeepSeek 深度求索` vs `deepseek`），所以这种情况不可能是用户自己起的 ——
       它是被写坏的（开发中间态的设置页存过一次，此后 sanitize 看到字段"存在"
       就一直原样保留，永远不会自愈）。症状是左侧列表整列显示成 `deepseek`
       这些小写 id。所以把这些条目**修回预设名**；用户真起过的名字一个字都不动。 */
    {
      const Preset* preset = get_preset(id);
      const std::string want = provider_defaults(id)["name"].get<std::string>();
      if (!cfg.contains("name") || !cfg["name"].is_string()
          || trim(cfg["name"].get<std::string>()).empty()) {
        cfg["name"] = want;
      } else {
        cfg["name"] = utf8_truncate(cfg["name"].get<std::string>(), kTextMax);
      }
      if (preset != nullptr && !preset->name.empty()
          && cfg["name"].get<std::string>() == id && preset->name != id) {
        cfg["name"] = utf8_truncate(preset->name, kTextMax);
        changed = true;   // 修过就回写，否则每次启动都要再修一遍
        notes.push_back("「" + id + "」的显示名此前被写成了内部 id，已恢复成「"
                        + cfg["name"].get<std::string>() + "」");
      }
    }
    auto text_field = [&](const char* k, size_t max) {
      auto it = cfg.find(k);
      cfg[k] = (it != cfg.end() && it->is_string()) ? utf8_truncate(it->get<std::string>(), max)
                                                    : std::string();
    };
    text_field("note", kTextMax);
    text_field("homepage", kTextMax);
    text_field("userAgent", kTextMax);
    // 这两样是**整段 JSON 文本**（llm 层解析后合并进请求头/请求体），所以限长放宽到 8000。
    text_field("proxyHeader", kProxyMax);
    text_field("proxyBody", kProxyMax);
    // 布尔只认显式 true（同上：手写的 "false" 不能翻转成 true）
    cfg["fullUrl"] = (cfg.contains("fullUrl") && cfg["fullUrl"].is_boolean() && cfg["fullUrl"].get<bool>());
    // Key 放哪儿。白名单外一律归 ''（= 按 format 的默认）
    {
      bool allowed = false;
      if (cfg.contains("authField") && cfg["authField"].is_string()) {
        const std::string v = cfg["authField"].get<std::string>();
        for (const char* a : kAuthFields) {
          if (v == a) { allowed = true; break; }
        }
      }
      cfg["authField"] = allowed ? cfg["authField"] : Json(std::string(""));
    }
    /* billing **逐字段重建**，不做深合并：多出来的键没有一样是我们需要的。
       单价**不取整**：按百万 tokens 计价本来就是小数（0.5 元/百万很常见），
       取整会把小模型的价格算没、把免费模型算成收费。
       上限 100000（元/百万 tokens）：再高一定是把"这次一共花了多少"填到单价里了。 */
    if (!cfg.contains("billing") || !cfg["billing"].is_object()) {
      cfg["billing"] = billing_defaults();
    } else {
      const Json& b = cfg["billing"];
      auto money = [&](const char* k) -> Json {
        double n = 0;
        auto it = b.find(k);
        if (it == b.end() || !js_number(*it, n) || !std::isfinite(n) || !(n > 0)) return num_json(0);
        return num_json(n > 100000.0 ? 100000.0 : n);
      };
      std::string cur;
      if (b.contains("currency") && b["currency"].is_string()) {
        cur = utf8_truncate(trim(b["currency"].get<std::string>()), 8);
      }
      Json nb = Json::object();
      nb["enabled"] = (b.contains("enabled") && b["enabled"].is_boolean() && b["enabled"].get<bool>());
      nb["inputPerM"] = money("inputPerM");
      nb["outputPerM"] = money("outputPerM");
      // 空/写坏 → CNY：界面上宁可显示个默认币种，也不要显示成空白
      nb["currency"] = cur.empty() ? std::string("CNY") : cur;
      cfg["billing"] = std::move(nb);
    }

    /* 有人会直接手改 settings.json，而且很自然会写 `apiKey` 而不是那个看不懂的 `apiKeyEnc`。
       以前的结果是：**盘上躺着一份明文 Key，应用却读不到它**。这里采纳进来再抹掉明文。 */
    if (cfg.contains("apiKey") && cfg["apiKey"].is_string() && !trim(cfg["apiKey"].get<std::string>()).empty()
        && cfg["apiKeyEnc"].get<std::string>().empty()) {
      cfg["apiKeyEnc"] = encrypt_key(trim(cfg["apiKey"].get<std::string>()));
      notes.push_back("「" + id + "」配置文件里的明文 apiKey 已被采纳并加密存储");
      changed = true;
    }
    if (cfg.contains("apiKey")) { cfg.erase("apiKey"); changed = true; }

    /* 严格白名单：只保留我们真正使用的字段。
       为什么不全删"已知的危险名字"就够了——安全审计实测：`nested.apiKey`、
       `headers['X-Key']` 这类**嵌套位置**照样能把明文带出去。 */
    static const char* const kKeep[] = {"enabled", "baseUrl", "format", "models", "apiKeyEnc", "name",
        "isCustom", "defaultModel", "note", "homepage", "fullUrl", "authField", "userAgent",
        "proxyHeader", "proxyBody", "billing"};
    std::vector<std::string> ckeys;
    ckeys.reserve(cfg.size());
    for (auto it = cfg.begin(); it != cfg.end(); ++it) ckeys.push_back(it.key());
    for (const std::string& k : ckeys) {
      bool keep = false;
      for (const char* kk : kKeep) {
        if (k == kk) { keep = true; break; }
      }
      if (!keep) { cfg.erase(k); changed = true; }
    }
  }

  Json& g = out["generation"];
  if (!g.is_object()) g = d["generation"];
  g["units"] = clamp_num(g.contains("units") ? g["units"] : Json(), 3, 10, d["generation"]["units"].get<double>());
  g["points"] = clamp_num(g.contains("points") ? g["points"] : Json(), 20, 120, d["generation"]["points"].get<double>());
  g["demos"] = clamp_num(g.contains("demos") ? g["demos"] : Json(), 0, 3, d["generation"]["demos"].get<double>());
  g["concurrency"] = clamp_num(g.contains("concurrency") ? g["concurrency"] : Json(), 1, 5, d["generation"]["concurrency"].get<double>());
  g["repairRounds"] = clamp_num(g.contains("repairRounds") ? g["repairRounds"] : Json(), 0, 3, d["generation"]["repairRounds"].get<double>());

  /* 审题人数。三种来源按优先级：
       ① 新的 `auditors`（数字）
       ② 老的 `audit`（布尔）——老用户升级时按 true→1 / false→0 折算
       ③ 都没有 → 默认 1
     迁移要读**原始输入**而不是合并后的对象：合并之后 defaults 的 1 会盖住"用户其实没设过"。 */
  {
    const Json rawG = (raw.is_object() && raw.contains("generation") && raw["generation"].is_object())
                        ? raw["generation"] : Json::object();
    // "有没有出现过"要用 contains 判断，不能只看值合不合法：
    // 出现过但是坏值（写成 "abc"）应当**回落到默认**，而不是去翻老字段。
    if (rawG.contains("auditors")) {
      double n = 0;
      g["auditors"] = (js_number(rawG["auditors"], n) && std::isfinite(n))
                        ? num_json(js_round(n < 0 ? 0 : (n > 3 ? 3 : n)))
                        : num_json(d["generation"]["auditors"].get<double>());
    } else if (rawG.contains("audit") && rawG["audit"].is_boolean()) {
      g["auditors"] = rawG["audit"].get<bool>() ? 1 : 0;
      changed = true;   // 折算过 → 立刻回写，下次就是新字段
    } else {
      g["auditors"] = 1;
    }
    // 让老字段与新字段始终一致，免得两处读出不同的意思
    g["audit"] = g["auditors"].get<double>() > 0;
  }
  {
    double t = 0;
    g["temperature"] = num_json((g.contains("temperature") && js_number(g["temperature"], t) && std::isfinite(t))
                                  ? (t < 0 ? 0.0 : (t > 1.5 ? 1.5 : t))
                                  : d["generation"]["temperature"].get<double>());
  }
  {
    auto enum_or = [&](const char* k, const char* dflt, std::initializer_list<const char*> ok) {
      std::string v;
      if (g.contains(k) && g[k].is_string()) v = g[k].get<std::string>();
      for (const char* o : ok) {
        if (v == o) { g[k] = v; return; }
      }
      g[k] = std::string(dflt);
    };
    enum_or("pet", "fish", {"none", "fish", "image"});
    enum_or("theme", "auto", {"auto", "light", "dark"});
    // language 的默认值来自 defaults（不是硬编码），这样改默认只改一处
    {
      const std::string dflt = d["generation"]["language"].get<std::string>();
      std::string v;
      if (g.contains("language") && g["language"].is_string()) v = g["language"].get<std::string>();
      g["language"] = (v == "zh-CN" || v == "follow") ? v : dflt;
    }
  }
  /* 取消后怎么收尾。老设置文件里没有这两个字段 —— deepMerge 已经把它们落成默认值，
     所以升级路径天然安全；这里只负责把**写坏的值**夹回来。
     注意别写成 `g.onCancelAsk = !!g.onCancelAsk` —— 那样字符串 "false" 会变成 true。 */
  if (!g.contains("onCancel") || !g["onCancel"].is_string()
      || (g["onCancel"].get<std::string>() != "keep" && g["onCancel"].get<std::string>() != "clear")) {
    g["onCancel"] = "keep";
  }
  g["onCancelAsk"] = !(g.contains("onCancelAsk") && g["onCancelAsk"].is_boolean()
                       && !g["onCancelAsk"].get<bool>());
  /* 单次输出上限。这里是它**唯一**的兜底：荒唐的值传到 llm 层就是一个必被拒的 max_tokens，
     而用户完全看不出是自己手填的那个数干的。 */
  {
    double n = 0;
    if (!g.contains("maxOutput") || !js_number(g["maxOutput"], n) || !std::isfinite(n) || n <= 0) {
      g["maxOutput"] = 0;
    } else if (n < 2000) {
      g["maxOutput"] = 2000;
    } else {
      g["maxOutput"] = num_json(js_round(n > 200000 ? 200000 : n));
    }
  }
  if (!g.contains("outputDir") || !g["outputDir"].is_string()) g["outputDir"] = "";
  if (!g.contains("petImagePath") || !g["petImagePath"].is_string()) g["petImagePath"] = "";

  // 界面背景这三项要钳制：写坏了会让样式直接失效，而界面只是"没背景"，用户看不出是配置坏了
  if (!out.contains("ui") || !out["ui"].is_object()) out["ui"] = d["ui"];
  if (!out["ui"].contains("bgImage") || !out["ui"]["bgImage"].is_string()) out["ui"]["bgImage"] = "";
  {
    // 只留文件名：正反斜杠都去掉，".." 也去掉——这个值只该是个名字
    std::string v = out["ui"]["bgImage"].get<std::string>();
    std::string cleaned;
    for (size_t i = 0; i < v.size(); ++i) {
      if (v[i] == '\\' || v[i] == '/') continue;
      if (v[i] == '.' && i + 1 < v.size() && v[i + 1] == '.') { ++i; continue; }
      cleaned.push_back(v[i]);
    }
    out["ui"]["bgImage"] = cleaned;
  }
  out["ui"]["bgScrim"] = clamp_num(out["ui"].contains("bgScrim") ? out["ui"]["bgScrim"] : Json(),
                                   0, 90, d["ui"]["bgScrim"].get<double>());
  out["ui"]["bgBlur"] = clamp_num(out["ui"].contains("bgBlur") ? out["ui"]["bgBlur"] : Json(),
                                  0, 24, d["ui"]["bgBlur"].get<double>());

  if (!out.contains("active") || !out["active"].is_object()) out["active"] = d["active"];
  if (!out["active"].contains("provider") || !out["active"]["provider"].is_string()) {
    out["active"]["provider"] = d["active"]["provider"];
  }
  if (!out["active"].contains("model") || !out["active"]["model"].is_string()) {
    out["active"]["model"] = d["active"]["model"];
  }
  /* 分阶段模型：值必须是**当前这家提供商 models 里真实存在的 id**，否则归 ''。
     为什么非要在这里卡一道：设置文件是能手改的，而且**正常操作**也会造成悬空 ——
     用户把某个模型从列表里删了、或者换了 active.provider，那个 stage 选择就指向不存在的模型。
     悬空值一路传到 llm 层的结果是：分析和审题那两步拿着一个不存在的模型去请求（404/400），
     报错里出现一个用户在当前模型列表里**从没见过**的名字，而他的设置页看上去完全正常。 */
  {
    std::vector<std::string> modelIds;
    const Json& pcfg = out["providers"].contains(out["active"]["provider"].get<std::string>())
                         ? out["providers"][out["active"]["provider"].get<std::string>()] : Json();
    if (pcfg.is_object() && pcfg.contains("models") && pcfg["models"].is_array()) {
      for (const Json& m : pcfg["models"]) {
        if (m.is_object() && m.contains("id") && m["id"].is_string()) {
          modelIds.push_back(m["id"].get<std::string>());
        }
      }
    }
    auto valid = [&](const std::string& s) {
      for (const std::string& id : modelIds) {
        if (id == s) return true;
      }
      return false;
    };
    const Json st = (out["active"].contains("stages") && out["active"]["stages"].is_object())
                      ? out["active"]["stages"] : Json::object();
    auto stage = [&](const char* k) -> std::string {
      auto it = st.find(k);
      if (it != st.end() && it->is_string() && valid(it->get<std::string>())) return it->get<std::string>();
      return std::string();
    };
    Json outStages = Json::object();
    outStages["analyze"] = stage("analyze");
    outStages["audit"] = stage("audit");
    out["active"]["stages"] = std::move(outStages);
  }

  /* ⚠️ 只清洗**缺白名单的那三个嵌套位置**（active / generation / ui），
     **绝不能对整份 out 递归**：`providers[*].apiKeyEnc` 里含 "apiKey"，
     整份递归会把它删掉 —— 那等于把用户**所有已存的 Key 一次清空**。
     （这个坑 oracle 自己踩了一次：先写成整份递归，纯函数一测就发现 apiKeyEnc 命中正则。） */
  if (drop_secret_fields(out["active"], 0)) changed = true;
  if (drop_secret_fields(out["generation"], 0)) changed = true;
  if (drop_secret_fields(out["ui"], 0)) changed = true;

  // 顶层同样白名单：设置文件只该有这几样。
  // theme / provider 是界面在用的顶层字段（主题、当前选中的提供商 id）。
  // 一开始漏了它们——后果是「外观改成深色，重启又变回来」这种很难查的小毛病。
  static const char* const kTopKeep[] = {"version", "providers", "active", "generation", "ui", "theme", "provider"};
  {
    std::vector<std::string> topKeys;
    topKeys.reserve(out.size());
    for (auto it = out.begin(); it != out.end(); ++it) topKeys.push_back(it.key());
    for (const std::string& k : topKeys) {
      if (k == "__changed") continue;
      bool keep = false;
      for (const char* kk : kTopKeep) {
        if (k == kk) { keep = true; break; }
      }
      if (!keep) { out.erase(k); changed = true; }
    }
  }
  out["__notes"] = std::move(notes);
  if (changed) out["__changed"] = true;
  if (changedOut != nullptr) *changedOut = changed;
  return out;
}

void save_cache() {
    std::string err;
    if (!json_write_file_atomic(settings_path_impl(), g_cache, 2, err)) {
        log_error("设置写入失败：" + err);
    }
}

/* 取缓存（必要时读盘 + 修 + 立刻回写）。 */
Json& load() {
    if (g_loaded) return g_cache;
    Json raw;
    std::string err;
    const std::wstring path = settings_path_impl();
    if (stat_path(path).exists) {
        if (!json_read_file(path, raw, err)) {
            /* 文件存在但读不动/是坏 JSON：别删，改名留档，方便排查 */
            const std::wstring broken = path + L".broken-" + std::to_wstring(::GetTickCount64());
            if (::MoveFileW(path.c_str(), broken.c_str())) {
                log_warn("settings.json 读不动（" + err + "），已改名留档：" + to_utf8(broken));
            } else {
                log_warn("settings.json 读不动（" + err + "），改名留档也失败了");
            }
            raw = Json();
        }
    }
    bool changed = false;
    g_cache = sanitize_impl(raw, &changed);
    g_loaded = true;
    /* sanitize 可能改动了内容（采纳了手写的明文 apiKey、丢掉了不用的字段）。
       **必须马上落盘**，否则那份明文会一直躺在磁盘上——我们刚把它"采纳并加密"的意义就没了。 */
    if (changed) {
        g_cache.erase("__changed");
        save_cache();
    }
    return g_cache;
}

Json pick_provider(const Json& cfg, const Json& extra) {
    Json out = Json::object();
    for (const char* k : kProviderFieldsPublic) {
        if (cfg.is_object() && cfg.contains(k)) out[k] = cfg[k];
    }
    if (!out.contains("models") || !out["models"].is_array()) out["models"] = Json::array();
    /* billing 是**嵌套对象**：拷一份再外发。
       不拷的话渲染层拿到的是这一份的引用，界面上改一下计费单价就直接改到了缓存里。 */
    Json b = billing_defaults();
    if (cfg.is_object() && cfg.contains("billing") && cfg["billing"].is_object()) {
        for (auto it = cfg["billing"].begin(); it != cfg["billing"].end(); ++it) b[it.key()] = it.value();
    }
    out["billing"] = std::move(b);
    if (extra.is_object()) {
        for (auto it = extra.begin(); it != extra.end(); ++it) out[it.key()] = it.value();
    }
    return out;
}

}  // namespace

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

std::wstring settings_path() { return settings_path_impl(); }

Json store_defaults() { return defaults(); }

bool store_encryption_available() { return encryption_available(); }

std::string mask_key(const std::string& key) {
    if (key.empty()) return std::string();
    if (count_utf16(key) <= 10) return "****";
    // oracle 用 slice(0,4) + '…' + slice(-4)：按 UTF-16 码元。Key 是 ASCII，等价。
    return key.substr(0, 4) + "…" + key.substr(key.size() - 4);
}

const char* store_key_storage() { return g_keyStorage.c_str(); }

Json store_sanitize(const Json& raw, bool* changed) { return sanitize_impl(raw, changed); }

void store_reset_cache() {
    g_cache = Json();
    g_loaded = false;
    g_keyStorage = "encrypted";
}

Json get_settings() {
    const Json& s = load();
    Json out = deep_copy(s);
    out.erase("__notes");
    for (auto it = out["providers"].begin(); it != out["providers"].end(); ++it) {
        const std::string id = it.key();
        const std::string enc = (s["providers"].contains(id) && s["providers"][id].contains("apiKeyEnc")
                                 && s["providers"][id]["apiKeyEnc"].is_string())
                                  ? s["providers"][id]["apiKeyEnc"].get<std::string>() : std::string();
        it.value()["apiKey"] = decrypt_key(enc);
        it.value().erase("apiKeyEnc");
    }
    /* `.env` / 系统环境变量**叠加**在最上面（优先级最高）。
       注意：这是**只读叠加**——env 里的 Key 绝不会被写回 settings.json。 */
    return env_overlay(out);
}

Json get_public_settings() {
    // 走 get_settings()：这样 .env / 环境变量里的 Key 也会体现在 hasKey 上
    const Json withKeys = get_settings();
    const Json& s = load();

    Json out = Json::object();
    out["version"] = s.contains("version") ? s["version"] : Json(1);
    /* ⚠️ 下面这几项必须从**已叠加 env** 的 withKeys 取。
       第一版还在从 load()（原始缓存）取，于是 .env 里的 ISG_MODEL / ISG_POINTS
       "生效了但界面看不到"——大模型层用的是叠加后的值、界面显示的是没叠加的。 */
    out["active"] = (withKeys.contains("active") && withKeys["active"].is_object()) ? withKeys["active"] : Json::object();
    out["generation"] = (withKeys.contains("generation") && withKeys["generation"].is_object()) ? withKeys["generation"] : Json::object();
    out["ui"] = (withKeys.contains("ui") && withKeys["ui"].is_object()) ? withKeys["ui"] : Json::object();
    /* ⚠️ 界面在读这两个顶层字段（主题、当前选中的提供商 id）。
       显式构造输出时漏掉它们，症状是"外观改成深色、重启又变回来"。 */
    {
        auto pick_str = [&](const char* k, const char* dflt) -> Json {
            if (withKeys.contains(k) && withKeys[k].is_string() && !withKeys[k].get<std::string>().empty()) return withKeys[k];
            if (s.contains(k) && s[k].is_string() && !s[k].get<std::string>().empty()) return s[k];
            return Json(std::string(dflt));
        };
        out["theme"] = pick_str("theme", "auto");
        out["provider"] = pick_str("provider", "");
    }
    out["providers"] = Json::object();

    if (s.contains("providers") && s["providers"].is_object()) {
        for (auto it = s["providers"].begin(); it != s["providers"].end(); ++it) {
            const std::string id = it.key();
            /* ⚠️ 取 `withKeys`（已叠加 .env）而不是 `s`（磁盘原文）。
               第一版这里写的是 s.providers[id]，于是 .env 里的 ISG_BASE_URL / ISG_FORMAT
               **实际生效了、界面却显示磁盘上的旧值**——用户照着界面排查会被带偏。 */
            Json cfg = (withKeys.contains("providers") && withKeys["providers"].contains(id))
                         ? withKeys["providers"][id] : Json::object();
            std::string plain;
            if (cfg.contains("apiKey") && cfg["apiKey"].is_string()) plain = cfg["apiKey"].get<std::string>();
            Json extra = Json::object();
            extra["hasKey"] = !plain.empty();
            extra["keyHint"] = mask_key(plain);
            // Key 是从 .env / 环境变量来的：界面要能说清楚"它不在应用配置里"
            extra["keyFromEnv"] = (cfg.contains("keyFromEnv") && js_truthy(cfg["keyFromEnv"]));
            extra["keyFrom"] = (cfg.contains("keyFrom") && cfg["keyFrom"].is_string())
                                 ? cfg["keyFrom"].get<std::string>() : std::string();
            out["providers"][id] = pick_provider(cfg, extra);
        }
    }
    out["env"] = env_info();               // 只报"读了哪个 .env、哪些变量有值"，**不含任何 Key 明文**
    out["keyStorage"] = g_keyStorage;
    out["encryptionAvailable"] = encryption_available();
    out["settingsPath"] = to_utf8(settings_path_impl());
    out["__notes"] = Json::array();
    return out;
}

Json save_settings(const Json& patch) {
    Json& s = load();
    if (!patch.is_object()) return get_public_settings();
    Json p = deep_copy(patch);

    if (p.contains("providers") && p["providers"].is_object()) {
        for (auto it = p["providers"].begin(); it != p["providers"].end(); ++it) {
            const std::string id = it.key();
            if (!it.value().is_object()) continue;
            if (!s["providers"].contains(id) || !s["providers"][id].is_object()) {
                Json fresh = Json::object();
                fresh["enabled"] = false;
                fresh["baseUrl"] = "";
                fresh["format"] = "openai";
                fresh["models"] = Json::array();
                fresh["apiKeyEnc"] = "";
                s["providers"][id] = std::move(fresh);
            }
            Json& target = s["providers"][id];
            Json& cfg = it.value();
            if (cfg.contains("apiKey")) {
                const Json k = cfg["apiKey"];
                if (k.is_null()) target["apiKeyEnc"] = "";
                else if (k.is_string() && !k.get<std::string>().empty()) {
                    target["apiKeyEnc"] = encrypt_key(trim(k.get<std::string>()));
                }
                cfg.erase("apiKey");
            }
            deep_merge(target, cfg);
            if (!target.contains("models") || !target["models"].is_array()) target["models"] = Json::array();
            if (!target.contains("format") || !target["format"].is_string()
                || (target["format"].get<std::string>() != "openai"
                    && target["format"].get<std::string>() != "anthropic")) {
                target["format"] = "openai";
            }
        }
        /* 「删除这家提供商」要真的删得掉。
           界面上的删除只是把它从草稿数组里移掉，保存时那份 providers **本来就不含它**——
           而按 id 合并是删不掉键的，于是按钮点了等于没点。
           语义：**patch 里给了 providers，就当它是完整的名单**；
           凡是"不是内置预设、又不在名单里"的，从本机配置里移除。
           内置预设永远保留（用户只是把它关掉，不是删掉）。 */
        std::vector<std::string> removedIds;
        std::vector<std::string> curIds;
        curIds.reserve(s["providers"].size());
        for (auto it = s["providers"].begin(); it != s["providers"].end(); ++it) curIds.push_back(it.key());
        for (const std::string& id : curIds) {
            if (p["providers"].contains(id)) continue;
            if (get_preset(id) != nullptr) continue;
            s["providers"].erase(id);
            removedIds.push_back(id);
        }
        if (!removedIds.empty()) log_info("[store] 已移除自定义提供商：" + join(removedIds, "、"));
        p.erase("providers");
    }

    deep_merge(s, p);
    bool changed = false;
    Json clean = sanitize_impl(s, &changed);
    /* sanitize 是在**副本**上删字段的，而合并只覆盖、不删除 ——
       被白名单否掉的顶层键会留在 s 上，而 save() 序列化的正是 s
       （实测：`saveSettings({'X-Api-Key': ...})` 真的落了盘）。所以先删掉 clean 里不存在的键。 */
    {
        std::vector<std::string> keys;
        keys.reserve(s.size());
        for (auto it = s.begin(); it != s.end(); ++it) keys.push_back(it.key());
        for (const std::string& k : keys) {
            if (!clean.contains(k)) s.erase(k);
        }
    }
    for (auto it = clean.begin(); it != clean.end(); ++it) s[it.key()] = it.value();
    s.erase("__notes");
    s.erase("__changed");
    save_cache();
    return get_public_settings();
}

bool provider_config(const std::string& id, Json& out, std::string& err) {
    const Json& s = load();
    if (!s["providers"].contains(id)) {
        err = "没有这个模型提供商：" + id;
        return false;
    }
    const Json& raw = s["providers"][id];
    const Preset* preset = get_preset(id);

    /* 顺序很重要：**先把应用里存的那份解密出来，再让 .env / 环境变量叠加在上面**。
       第一版写成 `getSettings().providers[id]` 再读 `apiKeyEnc` —— 而 getSettings() 已经
       把 apiKeyEnc 换成了 apiKey，于是永远读到空，报"还没填 API Key"。 */
    auto rs = [&](const char* k) -> Json {
        return raw.contains(k) ? raw[k] : Json();
    };
    Json entry = Json::object();
    entry["apiKey"] = decrypt_key(raw.contains("apiKeyEnc") && raw["apiKeyEnc"].is_string()
                                    ? raw["apiKeyEnc"].get<std::string>() : std::string());
    entry["name"] = rs("name");
    entry["baseUrl"] = rs("baseUrl");
    entry["format"] = rs("format");
    entry["models"] = rs("models");
    entry["note"] = rs("note");
    entry["homepage"] = rs("homepage");
    entry["fullUrl"] = rs("fullUrl");
    entry["authField"] = rs("authField");
    entry["userAgent"] = rs("userAgent");
    entry["proxyHeader"] = rs("proxyHeader");
    entry["proxyBody"] = rs("proxyBody");
    entry["billing"] = rs("billing");

    Json input = Json::object();
    input["providers"] = Json::object();
    input["providers"][id] = std::move(entry);
    input["active"] = s.contains("active") ? s["active"] : Json::object();
    const Json merged = env_overlay(input);
    /* ⚠️ **不许**写成 `merged["providers"][id]`。
       const Json 上的 operator[] 遇到不存在的键会**抛 out_of_range**，而宿主侧没有
       try/catch —— 抛出去就是 std::terminate，表现是进程 0xC0000409 直接消失、
       连一个字节的报告都留不下（env 那一套自测第一版就是这么死的，查了半天）。
       凡"读一个可能不存在的键"一律走 find/contains。 */
    const Json kNoValue;   // 空 Json（null）
    auto at = [&](const Json& o, const char* k) -> const Json& {
        if (!o.is_object()) return kNoValue;
        auto it = o.find(k);
        return it == o.end() ? kNoValue : *it;
    };
    const Json& cfg = at(at(merged, "providers"), id.c_str());

    const std::string apiKey = (cfg.contains("apiKey") && cfg["apiKey"].is_string())
                                 ? cfg["apiKey"].get<std::string>() : std::string();
    auto display_name = [&]() -> std::string {
        std::string n = (cfg.contains("name") && cfg["name"].is_string()) ? trim(cfg["name"].get<std::string>()) : std::string();
        if (!n.empty()) return n;
        if (preset != nullptr && !preset->name.empty()) return preset->name;
        return id;
    };
    const std::string baseUrl = [&]() {
        std::string b = (cfg.contains("baseUrl") && cfg["baseUrl"].is_string()) ? trim(cfg["baseUrl"].get<std::string>()) : std::string();
        if (!b.empty()) return b;
        return (preset != nullptr) ? preset->baseUrl : std::string();
    }();
    if (baseUrl.empty()) {
        err = "「" + display_name() + "」还没填 API Base URL";
        return false;
    }
    /* 本机端点（Ollama / LM Studio / 本机网关）**允许没有 Key**。
       这一条与 oracle 的 `llm/index.js: isLocalBase` 对齐；以前这里无条件要求 Key，
       而页面里的 llm 层对 127.0.0.1 是放行的 —— 结果是"测试连接"在页面侧通过了参数校验、
       却在宿主这里被 ENO_PROVIDER 挡住，用户看到的是"配置没问题但连不上"。
       显示名用**用户改过的那个**：报错信息里出现的名字应该跟他在设置页看到的一样。 */
    const bool localBase = [&]() -> bool {
        const std::string lower = ascii_lower(trim(baseUrl));
        const size_t p = lower.find("://");
        if (p == std::string::npos) return false;
        std::string host = lower.substr(p + 3);
        const size_t end = host.find_first_of("/?#");
        if (end != std::string::npos) host = host.substr(0, end);
        if (!host.empty() && host.front() == '[') {
            const size_t rb = host.find(']');
            if (rb != std::string::npos) host = host.substr(0, rb + 1);   // [::1]:11434 → [::1]
        } else {
            const size_t colon = host.rfind(':');
            if (colon != std::string::npos) host = host.substr(0, colon);
        }
        return host == "localhost" || host == "127.0.0.1" || host == "0.0.0.0"
            || host == "[::1]" || host == "host.docker.internal";
    }();
    if (apiKey.empty() && !localBase) {
        err = "「" + display_name() + "」还没填 API Key（也可以放在 .env 或环境变量里，见设置页「外观」下面的说明）";
        return false;
    }

    out = Json::object();
    out["id"] = id;
    out["name"] = display_name();
    out["format"] = at(cfg, "format").is_string() ? at(cfg, "format") : Json(std::string("openai"));
    out["baseUrl"] = baseUrl;
    out["apiKey"] = apiKey;
    out["models"] = at(cfg, "models").is_array() ? at(cfg, "models") : Json::array();
    // ---- 1.4.0：请求整形（llm 层负责真的作用到请求上）----
    out["fullUrl"] = (cfg.contains("fullUrl") && cfg["fullUrl"].is_boolean() && cfg["fullUrl"].get<bool>());
    auto sfield = [&](const char* k) -> Json {
        return (cfg.contains(k) && cfg[k].is_string()) ? cfg[k] : Json(std::string(""));
    };
    out["authField"] = sfield("authField");
    out["userAgent"] = sfield("userAgent");
    out["proxyHeader"] = sfield("proxyHeader");
    out["proxyBody"] = sfield("proxyBody");
    // 备注/官网/计费只给界面看，llm 层用不到；但它们是"完整配置"的一部分
    out["note"] = sfield("note");
    out["homepage"] = sfield("homepage");
    out["billing"] = (cfg.contains("billing") && cfg["billing"].is_object()) ? cfg["billing"] : billing_defaults();
    return true;
}

Json export_settings() {
    const Json& s = load();
    Json out = Json::object();
    out["version"] = s.contains("version") ? s["version"] : Json(1);
    out["active"] = (s.contains("active") && s["active"].is_object()) ? s["active"] : Json::object();
    out["generation"] = (s.contains("generation") && s["generation"].is_object()) ? s["generation"] : Json::object();
    out["ui"] = (s.contains("ui") && s["ui"].is_object()) ? s["ui"] : Json::object();
    out["providers"] = Json::object();
    if (s.contains("providers") && s["providers"].is_object()) {
        for (auto it = s["providers"].begin(); it != s["providers"].end(); ++it) {
            const Json& cfg = it.value();
            Json picked = Json::object();
            for (const char* k : kProviderFieldsExport) {
                if (cfg.contains(k)) picked[k] = cfg[k];
            }
            if (!picked.contains("models") || !picked["models"].is_array()) picked["models"] = Json::array();
            // billing 是对象：拷一份，免得导出结果与缓存共享同一个引用
            Json b = billing_defaults();
            if (cfg.contains("billing") && cfg["billing"].is_object()) {
                for (auto it2 = cfg["billing"].begin(); it2 != cfg["billing"].end(); ++it2) b[it2.key()] = it2.value();
            }
            picked["billing"] = std::move(b);
            out["providers"][it.key()] = std::move(picked);
        }
    }
    out["__exportedAt"] = iso_timestamp_utc();
    out["__exportedBy"] = "ISG Studio";
    out["__keysStripped"] = true;
    return out;
}

bool import_settings(const Json& obj, Json& publicOut, std::string& err) {
    if (!obj.is_object()) {
        err = "这个文件不是工作台的设置文件";
        return false;
    }
    Json& s = load();
    Json cur = deep_copy(s);
    Json incoming = deep_copy(obj);
    incoming.erase("__exportedAt");
    incoming.erase("__exportedBy");
    incoming.erase("__keysStripped");
    // 导入不带 Key，所以保留现有的 apiKeyEnc
    if (incoming.contains("providers") && incoming["providers"].is_object()) {
        for (auto it = incoming["providers"].begin(); it != incoming["providers"].end(); ++it) {
            const std::string id = it.key();
            if (!it.value().is_object()) continue;
            if (cur.contains("providers") && cur["providers"].contains(id)
                && cur["providers"][id].contains("apiKeyEnc")
                && cur["providers"][id]["apiKeyEnc"].is_string()
                && !cur["providers"][id]["apiKeyEnc"].get<std::string>().empty()) {
                it.value()["apiKeyEnc"] = cur["providers"][id]["apiKeyEnc"];
            }
        }
    }
    deep_merge(cur, incoming);
    bool changed = false;
    const Json merged = sanitize_impl(cur, &changed);
    for (auto it = merged.begin(); it != merged.end(); ++it) s[it.key()] = it.value();
    s.erase("__notes");
    s.erase("__changed");
    save_cache();
    publicOut = get_public_settings();
    return true;
}

}  // namespace isg
