// `.env` 文件与系统环境变量 —— 让 API Key 能放在**应用配置之外**。
//
// 对应 oracle 的 src/main/env.js：解析 / 查找 / 优先级 / 叠加 / 诊断逐条翻译，
// 连注释里那些"为什么"一并搬过来。实现这一层时最要紧的几条：
//
//   · **优先级是刻意的少见做法**：`ISG_ENV_FILE` 指定的文件 > 系统环境变量 > .env 文件
//     > settings.json。系统环境变量压过 .env 的理由是排障：临时 set 一个值试一下必须
//     立刻生效，被 .env 盖住的话用户会以为环境变量没生效，反而更难查。
//   · **解析 .env 的顺序坑**：先判引号，只有"不带引号"的值才去剥行尾注释。反过来写会把
//     `ISG_OUTPUT_DIR="C:\my # files\out"` 截断成 `C:\my` —— 静默用错值（写到错误的目录、
//     或用错 Key），而界面上显示的正是截断后的值，用户很难联想到是解析器干的。
//   · **`.env` 是明文**，比 DPAPI 加密的 settings.json 弱。这是用户明确要的取舍
//     （"我自己的文件、我自己管"），但界面上必须说清楚：设置页标「来自 .env」并给出路径。
//   · **只报"这一次真的用上了"的变量名**（env_info().used）。oracle 踩过：列"shell 里所有像
//     Key 的变量名"，把跑这个应用的那个 shell 自带的几十个 ANTHROPIC_* 全列了出来 ——
//     那是别人的环境，混进诊断只会让人以为配错了。
//   · 这一层**只读不写**：env 里的 Key 绝不能被写回 settings.json（否则"放在应用配置之外"
//     就白说了，明文还会顺带落盘）。本文件里没有任何写文件的调用。

#include "env.h"

#include "../app/app.h"
#include "../util/file_ops.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace isg {

namespace {

// ---------------------------------------------------------------------------
// 模块级状态（对应 JS 的 loaded / lastUsed）
// ---------------------------------------------------------------------------

EnvFile g_file;          // 缓存的 .env 读取结果（对应 JS 的 loaded）
bool g_loaded = false;   // false = 还没读，或刚被 env_reset() 过

/* 上一次 overlay **实际用上**的变量名。env_reset() **不清它** —— 与 oracle 的 lastUsed 一致：
   reset 的用途是"改完 .env 再读一遍"，而"上一次到底用了哪几个变量"是给界面看的诊断，
   顺手清掉只会让设置页在一瞬间说不出话来。 */
std::vector<std::string> g_lastUsed;

// ---------------------------------------------------------------------------
// 表（对应 KEY_VARS / GENERIC）
// ---------------------------------------------------------------------------

/* 每家的 Key 用哪几个环境变量名。`ISG_<ID>_API_KEY` 是通用形式，另外认各家自己惯用的
   名字（用户手上往往已经有这些变量）。**表里的先后顺序与 env.js 一致**：一家有多个候选名时
   按这个顺序先到先得（用户同时设了 MOONSHOT_API_KEY 与 KIMI_API_KEY 时，取前者）。 */
const Json& keyTable() {
    static const Json t = [] {
        Json j = Json::object();
        j["deepseek"]    = Json::array({"DEEPSEEK_API_KEY"});
        j["moonshot"]    = Json::array({"MOONSHOT_API_KEY", "KIMI_API_KEY"});
        j["dashscope"]   = Json::array({"DASHSCOPE_API_KEY", "QWEN_API_KEY", "TONGYI_API_KEY"});
        j["zhipu"]       = Json::array({"ZHIPU_API_KEY", "GLM_API_KEY", "ZHIPUAI_API_KEY"});
        j["minimax"]     = Json::array({"MINIMAX_API_KEY"});
        j["ark"]         = Json::array({"ARK_API_KEY", "VOLC_ACCESSKEY", "VOLCENGINE_API_KEY"});
        j["siliconflow"] = Json::array({"SILICONFLOW_API_KEY"});
        j["openrouter"]  = Json::array({"OPENROUTER_API_KEY"});
        j["openai"]      = Json::array({"OPENAI_API_KEY"});
        j["anthropic"]   = Json::array({"ANTHROPIC_API_KEY"});
        j["gemini"]      = Json::array({"GEMINI_API_KEY", "GOOGLE_API_KEY"});
        j["youdao"]      = Json::array({"YOUDAO_API_KEY"});
        // 本机端点、以及用户自填的那家：没有约定俗成的变量名，只认通用形式
        j["ollama"]      = Json::array();
        j["lmstudio"]    = Json::array();
        j["custom"]      = Json::array();
        return j;
    }();
    return t;
}

/* 通用变量：不绑定某一家，直接指定"用哪家、哪个地址、哪个模型"。
   顺序与 env.js 一致（它决定了 overlay 里 __applied 的顺序，界面按那个顺序列）。 */
const Json& genericTable() {
    static const Json t = [] {
        Json j = Json::object();
        j["provider"]    = "ISG_PROVIDER";
        j["apiKey"]      = "ISG_API_KEY";
        j["baseUrl"]     = "ISG_BASE_URL";
        j["model"]       = "ISG_MODEL";
        j["format"]      = "ISG_FORMAT";
        j["outputDir"]   = "ISG_OUTPUT_DIR";
        j["units"]       = "ISG_UNITS";
        j["points"]      = "ISG_POINTS";
        j["demos"]       = "ISG_DEMOS";
        j["audit"]       = "ISG_AUDIT";
        j["pet"]         = "ISG_PET";
        j["language"]    = "ISG_LANG";        // zh-CN（默认）/ follow（跟随课件语言）
        j["temperature"] = "ISG_TEMPERATURE";
        return j;
    }();
    return t;
}

// ---------------------------------------------------------------------------
// 路径助手（Windows 语义，对应 Node 的 path.resolve / process.cwd）
// ---------------------------------------------------------------------------

std::wstring wide_env(const wchar_t* name) {
    const DWORD need = ::GetEnvironmentVariableW(name, nullptr, 0);
    if (need == 0) return std::wstring();
    std::wstring buf(static_cast<size_t>(need), L'\0');
    const DWORD got = ::GetEnvironmentVariableW(name, buf.data(), need);
    if (got == 0 || got >= need) return std::wstring();
    buf.resize(got);
    return buf;
}

/* 当前工作目录。oracle 用的是 process.cwd() —— **进程的工作目录**，不是 exe 所在目录，
   两者在双击启动与从终端启动时并不一样，候选表里它们是两个不同的候选。 */
std::wstring current_dir() {
    const DWORD need = ::GetCurrentDirectoryW(0, nullptr);
    if (need == 0) return std::wstring(L".");
    std::wstring buf(static_cast<size_t>(need), L'\0');
    const DWORD got = ::GetCurrentDirectoryW(need, buf.data());
    if (got == 0 || got >= need) return std::wstring(L".");
    buf.resize(got);
    return buf;
}

/* 归一化绝对路径，对应 Node 的 path.resolve(p)：相对路径按当前工作目录展开，
   去掉 `.` 与 `..`。归一化是必须的：调用方（设置页、测试）拿到的路径要能与
   `path.resolve(ENV_FILE)` 逐字符比得上。 */
std::wstring normalize_abs(const std::wstring& path) {
    const DWORD need = ::GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (need == 0) return path;
    std::wstring buf(static_cast<size_t>(need), L'\0');
    const DWORD got = ::GetFullPathNameW(path.c_str(), need, buf.data(), nullptr);
    if (got == 0 || got >= need) return path;
    buf.resize(got);
    return buf;
}

// ---------------------------------------------------------------------------
// 数值 / 判定助手
// ---------------------------------------------------------------------------

/* 对齐 JS 的 `Number(v)` 再套 `isFinite`：整个字符串必须是一个合法的十进制数，
   NaN / ±Infinity 一律算"没给值"（JS 那边由 isFinite 把关）。

   为什么用 from_chars 而不是 strtod：strtod 跟着 setlocale 走（别的 locale 下小数点
   是逗号），而这里要的是 JS 那种"跟环境无关"的语义；它也不做堆分配 —— 本工程开了退出时
   的 CRT 泄漏检查，能少一份全局分配就少一份。
   与 JS 的唯一差别是进制前缀：`Number('0x30')` 在 JS 里是 48，这里当非法值跳过。
   .env 里没人用十六进制写选项，宁可跳过也不去"猜"用户的意思。 */
bool js_number(const std::string& raw, double& out) {
    const std::string s = trim(raw);
    if (s.empty()) {   // JS 的 Number('') === 0
        out = 0.0;
        return true;
    }
    double n = 0.0;
    const char* const first = s.data();
    const char* const last = s.data() + s.size();
    const std::from_chars_result r = std::from_chars(first, last, n, std::chars_format::general);
    if (r.ec != std::errc() || r.ptr != last) return false;   // 没解全 → 非法（JS 给 NaN）
    if (!std::isfinite(n)) return false;
    out = n;
    return true;
}

/* `/^(0|false|no|off)$/i`：**整串**匹配、大小写不敏感。
   注意是整串：`offline`、`none` 都不算 false（它们是"给了个别的词"，按真处理）。 */
bool is_false_word(const std::string& v) {
    const std::string s = ascii_lower(v);
    return s == "0" || s == "false" || s == "no" || s == "off";
}

/* `/^(zh|zh-cn|zh_cn|cn|chinese|中文|简体中文|simplified)/`：**前缀**匹配。
   所以 zh-tw、zh_CN-x、chinese-traditional 统统归到 zh-CN —— 照搬 oracle 的判定，
   `zh-cn`/`zh_cn` 这两支被 `zh` 吃掉，列在这里只是为了与 oracle 一一对得上。 */
bool is_zh_prefix(const std::string& v) {
    static const char* const kPrefixes[] = {
        "zh", "cn", "chinese", "simplified", "中文", "简体中文",
    };
    for (const char* p : kPrefixes) {
        if (starts_with(v, p)) return true;
    }
    return false;
}

}  // namespace

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

const Json& env_key_vars() { return keyTable(); }
const Json& env_generic_vars() { return genericTable(); }

Json env_parse_text(const std::string& text) {
    Json out = Json::object();
    /* JS 是 split(/\r?\n/)：CRLF 与 LF 都切。这里按 '\n' 切、再靠 trim 去掉行尾的 '\r'，
       结果一样；孤立的 '\r'（老式 Mac 换行）两边都不当换行，也一样不切。 */
    for (const std::string& raw : split(text, '\n')) {
        std::string line = trim(raw);
        if (line.empty() || line.front() == '#') continue;
        if (starts_with(line, "export ")) line = trim(line.substr(7));
        const size_t eq = line.find('=');
        if (eq == std::string::npos || eq == 0) continue;   // 与 JS 的 `if (i <= 0) continue` 等价
        const std::string key = trim(line.substr(0, eq));
        std::string value = trim(line.substr(eq + 1));
        /* ⚠️ 这一段就是上面文件头说的那个顺序坑：**先判引号，只有不带引号的值才去剥
           行尾注释**。先剥注释再剥引号的话，`"C:\my # files\out"` 会先被 ` #` 截断成
           `"C:\my` —— 静默用错值，而且界面上显示的就是这个截断后的值。 */
        const bool quoted = value.size() >= 2
            && ((value.front() == '"' && value.back() == '"')
                || (value.front() == '\'' && value.back() == '\''));
        if (quoted) {
            value = value.substr(1, value.size() - 2);
        } else {
            const size_t hash = value.find(" #");
            if (hash != std::string::npos && hash > 0) value = trim(value.substr(0, hash));
        }
        if (!key.empty()) out[key] = value;   // 同名后写的覆盖先写的（与 JS 的对象赋值一致）
    }
    return out;
}

std::wstring env_find_env_file() {
    /* 显式指定 > 配置目录 > 当前工作目录 > 程序所在目录。
       `app.getPath('userData')` 与 `app.getPath('exe')` 在 oracle 里可能抛（app 还没 ready），
       这里的 user_data_dir() / exe_dir() 不抛，所以不需要那两层 try —— 行为上等价于
       "取不到就跳过这一项"。 */
    std::vector<std::wstring> cands;
    const std::wstring explicitFile = wide_env(L"ISG_ENV_FILE");
    if (!explicitFile.empty()) cands.push_back(explicitFile);
    cands.push_back(user_data_dir() + L"\\.env");
    cands.push_back(current_dir() + L"\\.env");
    // 打包后 exe 在 <安装目录>，配置放它旁边对用户最直观
    cands.push_back(exe_dir() + L"\\.env");

    for (const std::wstring& c : cands) {
        if (c.empty()) continue;
        // "存在且是文件"才算：同名目录不该被当成配置文件（读它会失败并被当成 error）
        if (stat_path(c).isFile) return normalize_abs(c);
    }
    return std::wstring();
}

const EnvFile& env_load() {
    if (g_loaded) return g_file;
    g_loaded = true;   // 先置位：读失败也要把"读过一次"留住，不然每次 env_get() 都会重读一遍磁盘
    g_file = EnvFile{};
    g_file.file = env_find_env_file();
    if (!g_file.file.empty()) {
        std::string bytes;
        if (!read_file_bytes(g_file.file, bytes)) {
            g_file.error = "读不到这个文件：" + to_utf8(g_file.file);
        } else {
            /* ⚠️ 这里**不剥 UTF-8 BOM**：oracle 的 fs.readFileSync(file,'utf8') 也不剥，
               两边行为必须一致。代价写在明处：拿记事本存出来的带 BOM 的 .env，
               第一个变量名会多一个不可见字符，于是读不到 —— 两个版本同样读不到。 */
            g_file.values = env_parse_text(bytes);
        }
    }
    return g_file;
}

std::string env_get(const std::string& name) {
    /* 系统环境变量优先于 .env（见文件顶部的取舍说明）。
       "没设"与"设成空串"都算没给值 —— 与 JS 的 `real !== undefined && real !== ''` 一致。 */
    const std::wstring wname = to_wide(name);
    if (!wname.empty()) {
        const DWORD need = ::GetEnvironmentVariableW(wname.c_str(), nullptr, 0);
        if (need > 0) {
            std::wstring buf(static_cast<size_t>(need), L'\0');
            const DWORD got = ::GetEnvironmentVariableW(wname.c_str(), buf.data(), need);
            if (got > 0) {
                buf.resize(got);
                const std::string v = to_utf8(buf);
                if (!v.empty()) return v;
            }
        }
    }
    const EnvFile& f = env_load();
    const auto it = f.values.find(name);
    if (it == f.values.end() || !it->is_string()) return std::string();
    return it->get<std::string>();
}

bool env_key_for(const std::string& id, std::string& key, std::string& varName) {
    key.clear();
    varName.clear();

    const Json& table = keyTable();
    const auto it = table.find(id);
    if (it != table.end() && it->is_array()) {
        for (const Json& name : *it) {
            if (!name.is_string()) continue;
            const std::string n = name.get<std::string>();
            const std::string v = env_get(n);
            if (!v.empty()) {
                key = v;
                varName = n;
                return true;
            }
        }
    }

    /* 通用形式：`ISG_<ID>_API_KEY`，其中 <ID> 是 id 转大写、把非 [A-Z0-9] 换成 `_`。
       非 ASCII 按**码点**换成一个 `_`（UTF-8 的续字节不单独计数），与 JS 正则
       `[^A-Z0-9]/g` 的逐字符替换对齐 —— 设置文件能手改，键名不一定是那 15 个预设。 */
    std::string lookup;   // 替换后的（查变量用）
    std::string shown;    // 只有大写、没有替换（报给界面用）
    for (size_t i = 0; i < id.size(); ++i) {
        const char c = id[i];
        if ((static_cast<unsigned char>(c) & 0xC0) == 0x80) continue;   // 续字节：跟着前导字节一起算
        const bool ascii = static_cast<unsigned char>(c) < 0x80;
        char up = c;
        if (ascii && c >= 'a' && c <= 'z') up = static_cast<char>(c - 'a' + 'A');
        const bool ok = ascii && ((up >= 'A' && up <= 'Z') || (up >= '0' && up <= '9'));
        shown += up;
        lookup += ok ? up : '_';
    }
    const std::string generic = env_get("ISG_" + lookup + "_API_KEY");
    if (generic.empty()) return false;
    key = generic;
    /* ⚠️ 这里**故意照抄 oracle 的不一致**：查的是替换过的名字，报出来的却是没替换的
       （`keyFor('my-provider')` 读的是 ISG_MY_PROVIDER_API_KEY，报的是
       ISG_MY-PROVIDER_API_KEY）。界面上的"来自 <变量名>"会因此少一层下划线。
       照搬是因为它影响的是显示文案，改掉反而会让两个版本对不上；要改就先进 JS 版。 */
    varName = "ISG_" + shown + "_API_KEY";
    return true;
}

Json env_overlay(const Json& settings) {
    /* JS 是 `JSON.parse(JSON.stringify(settings || {}))` —— null/undefined 变成 {}，
       其余深拷贝一份，**绝不改入参**。这里等价：对象直接拷，其余给 {}。
       （JS 收到标量时严格模式会抛，我们没有异常，退化成 {} 更安全；实际调用点只传对象。） */
    Json out = settings.is_object() ? settings : Json::object();

    Json applied = Json::array();
    /* 界面直接显示 field 与 varName，所以 field 必须是这些中文字面量本身，
       不要"顺手"改成英文键名 —— 设置页照抄的是 oracle 的文案。 */
    auto pushApplied = [&applied](const std::string& provider, const std::string& field,
                                  const std::string& varName) {
        Json item = Json::object();
        item["provider"] = provider;
        item["field"] = field;
        item["varName"] = varName;
        applied.push_back(std::move(item));
    };
    auto ensureActive = [&out]() -> Json& {
        const auto it = out.find("active");
        if (it == out.end() || !it->is_object()) out["active"] = Json::object();
        return out["active"];
    };

    // 只收"给了值"的通用变量；没给的字段一律保持 settings 里的原样
    std::map<std::string, std::pair<std::string, std::string>> gen;   // key → {值, 变量名}
    for (auto it = genericTable().begin(); it != genericTable().end(); ++it) {
        if (!it.value().is_string()) continue;
        const std::string name = it.value().get<std::string>();
        const std::string v = env_get(name);
        if (!v.empty()) gen[it.key()] = std::make_pair(v, name);
    }

    // 1) 通用变量：ISG_API_KEY 之类要配一个"当前使用的那家"
    if (const auto it = gen.find("provider"); it != gen.end()) {
        ensureActive()["provider"] = it->second.first;
        pushApplied(it->second.first, "当前提供商", it->second.second);
    }
    // 通用变量只作用于"当前使用的那家"。**必须在这一步之后取**（provider 可能刚被改过）
    std::string activeId;
    {
        const auto it = out.find("active");
        if (it != out.end() && it->is_object()) {
            const auto pit = it->find("provider");
            if (pit != it->end() && pit->is_string()) activeId = pit->get<std::string>();
        }
    }

    // 2) 逐家：Key / Base URL / 格式
    if (const auto pit = out.find("providers"); pit != out.end() && pit->is_object()) {
        for (auto& kv : pit->items()) {
            const std::string id = kv.key();
            Json& p = kv.value();
            /* JS 在这里对非对象的值会抛（严格模式），我们没有异常 → 跳过这一家。
               这是不可达的输入：providers 是 store 建出来的、且每个值都是对象。 */
            if (!p.is_object()) continue;

            std::string k;
            std::string kn;
            const bool hasKey = env_key_for(id, k, kn);
            if (hasKey) {
                p["apiKey"] = k;
                // keyFromEnv / keyFrom 是设置页标「来自 .env」的依据（store 会读它们）
                p["keyFromEnv"] = true;
                p["keyFrom"] = kn;
                pushApplied(id, "API Key", kn);
            }
            if (id == activeId) {
                // 通用 ISG_API_KEY 只在"这一家自己没给 Key"时兜底：具体压过通用
                if (const auto ai = gen.find("apiKey"); ai != gen.end() && !hasKey) {
                    p["apiKey"] = ai->second.first;
                    p["keyFromEnv"] = true;
                    p["keyFrom"] = ai->second.second;
                    pushApplied(id, "API Key", ai->second.second);
                }
                if (const auto bi = gen.find("baseUrl"); bi != gen.end()) {
                    p["baseUrl"] = bi->second.first;
                    pushApplied(id, "Base URL", bi->second.second);
                }
                if (const auto fi = gen.find("format"); fi != gen.end()) {
                    // 只认 anthropic，别的（包括拼错的 anthropic-）一律落到 openai
                    p["format"] = fi->second.first == "anthropic" ? "anthropic" : "openai";
                    pushApplied(id, "API 格式", fi->second.second);
                }
            }
        }
    }
    if (const auto it = gen.find("model"); it != gen.end()) {
        ensureActive()["model"] = it->second.first;
        pushApplied(activeId, "模型", it->second.second);
    }

    // 3) 生成选项。JS 用 `out.generation || (out.generation = {})`，所以到这一步之后
    //    out.generation **一定**是个对象，哪怕一个 ISG_* 都没设。
    {
        const auto it = out.find("generation");
        if (it == out.end() || !it->is_object()) out["generation"] = Json::object();
    }
    Json& g = out["generation"];

    /* 数值一律"取整 + 夹紧"：写坏一个值会让界面样式整条失效（而界面只是"没背景"，
       用户看不出是配置坏了），所以宁可夹到合法区间。 */
    auto numVar = [&](const char* genKey, double lo, double hi, const char* field) {
        const auto it = gen.find(genKey);
        if (it == gen.end()) return;
        double n = 0.0;
        if (!js_number(it->second.first, n)) return;   // 非法值直接跳过，保持 settings 原样
        /* std::round 与 Math.round 只差"恰好 .5 的负数"（-0.5→-0 vs -1）；三个字段的下界
           都 >= 0，差不到这儿来。 */
        g[field] = static_cast<std::int64_t>(std::min(hi, std::max(lo, std::round(n))));
        pushApplied(std::string(), field, it->second.second);
    };
    numVar("units", 3.0, 10.0, "units");
    numVar("points", 20.0, 120.0, "points");
    numVar("demos", 0.0, 3.0, "demos");

    if (const auto it = gen.find("temperature"); it != gen.end()) {
        double n = 0.0;
        if (js_number(it->second.first, n)) {
            const double t = std::min(1.5, std::max(0.0, n));   // 这个**不取整**，小数有意义
            /* ⚠️ 整数值写成整数：JS 的 JSON.stringify(1) 是 `1`，而 nlohmann 把 double 1.0
               落成 `1.0` —— 落到 settings.json 就是两个版本不一致的字节（读回来虽然等价，
               但对拍会多出一处差异）。 */
            g["temperature"] = (t == std::floor(t)) ? Json(static_cast<std::int64_t>(t)) : Json(t);
            pushApplied(std::string(), "temperature", it->second.second);
        }
    }
    if (const auto it = gen.find("audit"); it != gen.end()) {
        g["audit"] = !is_false_word(trim(it->second.first));
        pushApplied(std::string(), "audit", it->second.second);
    }
    if (const auto it = gen.find("language"); it != gen.end()) {
        const std::string v = ascii_lower(trim(it->second.first));
        if (v == "follow" || v == "en" || v == "source") {
            g["language"] = "follow";
            pushApplied(std::string(), "language", it->second.second);
        } else if (is_zh_prefix(v)) {
            g["language"] = "zh-CN";
            pushApplied(std::string(), "language", it->second.second);
        }
        // 两边都不沾的值（"ja" 之类）不写、也不进 __applied —— 与 oracle 一样是"没听懂"
    }
    if (const auto it = gen.find("pet"); it != gen.end()) {
        // ⚠️ 这里**不做小写**（oracle 用 ['none','fish','image'].includes(v)）："None" 不算数
        const std::string v = trim(it->second.first);
        if (v == "none" || v == "fish" || v == "image") {
            g["pet"] = v;
            pushApplied(std::string(), "pet", it->second.second);
        }
    }
    if (const auto it = gen.find("outputDir"); it != gen.end()) {
        g["outputDir"] = it->second.first;   // 原样：路径里可能有尾随分隔符，正是用户打的
        pushApplied(std::string(), "outputDir", it->second.second);
    }

    g_lastUsed.clear();
    for (const Json& item : applied) {
        const auto it = item.find("varName");
        if (it != item.end() && it->is_string()) g_lastUsed.push_back(it->get<std::string>());
    }
    // 头文件冻结的形态：__applied 挂在返回的设置里（不是 JS 的 {settings, applied} 双字段）
    out["__applied"] = std::move(applied);
    return out;
}

Json env_info() {
    const EnvFile& l = env_load();
    Json used = Json::array();
    for (const std::string& v : g_lastUsed) used.push_back(v);

    Json out = Json::object();
    out["file"] = to_utf8(l.file);
    out["found"] = !l.file.empty();
    out["error"] = l.error;
    /* 值一律不外发 —— 这个对象会被送进渲染进程，Key 明文一个字节都不能进来。
       只报"这一次真的用上了"的变量名，理由见文件头最后一条。 */
    out["used"] = std::move(used);
    return out;
}

void env_reset() {
    g_file = EnvFile{};
    g_loaded = false;
    // ⚠️ 不清 g_lastUsed：与 oracle 的 lastUsed 一致（见文件头的说明）
}

}  // namespace isg
