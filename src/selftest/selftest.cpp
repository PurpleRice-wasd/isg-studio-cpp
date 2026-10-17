#include "selftest.h"

#include "../app/app.h"
#include "../book/book.h"
#include "../bridge/bridge.h"
#include "../bridge/channels.h"
#include "../pipeline/jobs.h"
#include "../pipeline/cleanup.h"
#include "../extract/extract.h"
#include "miniz.h"
#include "../settings/bg.h"
#include "../settings/dpapi.h"
#include "../settings/env.h"
#include "../settings/oscrypt.h"
#include "../settings/providers.h"
#include "../settings/store.h"
#include "../shell/dialogs.h"
#include "../shell/protocol.h"
#include "../shell/shell_ops.h"
#include "../util/base64.h"
#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>

#include <algorithm>
#include <filesystem>
#include <set>
#include <string>
#include <vector>

namespace isg {

namespace {

/* 一份极小的合法 PNG（1×1）。自己造而不是去仓库里找现成的截图 ——
   自测不该依赖"仓库里恰好有哪张图"，那种依赖会在别人 checkout 一份干净代码时炸。 */
const unsigned char kTinyPng[] = {
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82};

/* 一份极小的合法 JPEG（1×1，灰度）。
   ⚠️ 与 PNG 用不同扩展名是刻意的：bg 的"换图时只留一张"那条判据，
   只有在**换扩展名**的情况下才会走到"清掉旧名字"那一支。 */
const unsigned char kTinyJpg[] = {
    0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07,
    0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F,
    0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C,
    0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D,
    0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x01,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x37, 0xFF, 0xD9};

/* 一份极小的合法 GIF（1×1）。用来试"不支持的图片格式"那条拒绝路径 ——
   gif 是**真实存在的图片格式**，只是 bg 的白名单里没有它，正好卡在
   "扩展名不在 OK_EXT"这一支上。 */
const unsigned char kTinyGif[] = {
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3B};

/** 一次自测的记账本。判据一律断言**字段/数字**，并留下实际值。 */
struct Ledger {
    std::string name;
    Json lines = Json::array();
    int bad = 0;
    int checked = 0;
    /* 半成品落盘路径。每过一条判据就追加一行 —— 这样**中途崩掉**时，
       盘上留下的最后一行就是"死在哪儿"，而不是一片空白（env 那一套第一版就是这样：
       进程 0xC0000409、报告一个字节都没有，只能靠猜）。 */
    std::wstring partialPath;
    void touch(const std::string& text) const {
        if (partialPath.empty()) return;
        std::string cur;
        read_file_bytes(partialPath, cur);
        cur += text;
        cur += "\n";
        write_file_bytes(partialPath, cur);
    }

    void check(const std::string& label, bool ok, const std::string& extra = std::string()) {
        checked++;
        if (!ok) bad++;
        const std::string line = std::string(ok ? "  [ok]  " : "  [BAD] ") + label
                               + (extra.empty() ? "" : ("  —— " + extra));
        lines.push_back(line);
        touch(line);
        /* 立刻也往控制台写一份。
           为什么不能只攒到最后一次性打印：自测**跑到一半崩掉**的时候，
           攒着的那份一个字节都留不下来 —— 于是"崩在哪一条判据上"就变成靠猜。
           （这不是假想的：env 那一套第一版就是 0xC0000409，而报告文件根本没生成。） */
        console_write(line + "\n");
    }
    void eq(const std::string& label, const std::string& got, const std::string& want) {
        check(label, got == want, got == want ? "" : ("期望 " + want + "，实际 " + got));
    }
    void eqInt(const std::string& label, long long got, long long want) {
        check(label, got == want, got == want ? "" : ("期望 " + std::to_string(want) + "，实际 " + std::to_string(got)));
    }
    Json to_json() const {
        Json root = Json::object();
        root["ok"] = (bad == 0);
        root["test"] = name;
        root["checked"] = checked;
        root["bad"] = bad;
        root["lines"] = lines;
        return root;
    }
};

/* 比较两个 Key 时**打印的是长度与前后各 4 个字符**，不是全文 ——
   判据要能定位问题，但不能把 API Key 写进报告（报告是会被贴出去的）。 */
std::string decrypt_detail(const std::string& got, const std::string& want) {
    auto brief = [](const std::string& s) {
        if (s.empty()) return std::string("(空)");
        if (s.size() <= 8) return std::string("(len=") + std::to_string(s.size()) + ")";
        return s.substr(0, 4) + "…" + s.substr(s.size() - 4) + " (len=" + std::to_string(s.size()) + ")";
    };
    return "得到 " + brief(got) + "，期望 " + brief(want);
}

/* 词法归一化（与产品侧 env/protocol 用的 GetFullPathNameW 同一口径）。
   为什么要它：自测里比较路径时，两边可能一个用 `/`、一个用 `\`
   （第三路审查用 `--user-data=C:/...` 复现过两条假红）。**产品侧本来就归一化了**，
   这里只是让判据的比较条件与产品一致。 */
std::wstring full_path(const std::wstring& p) {
    wchar_t buf[32768] = {};
    const DWORD n = ::GetFullPathNameW(p.c_str(), static_cast<DWORD>(std::size(buf)), buf, nullptr);
    return (n > 0 && n < std::size(buf)) ? std::wstring(buf, n) : p;
}

std::wstring lower_w(std::wstring s) {
    std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) {
        return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c;
    });
    return s;
}

std::wstring temp_dir() {
    const std::wstring base = user_data_dir() + L"\\selftest";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(base), ec);
    return base;
}

bool write_bytes(const std::wstring& path, const void* data, size_t n) {
    const std::string s(reinterpret_cast<const char*>(data), n);
    return write_file_bytes(path, s);
}

std::string read_text(const std::wstring& path) {
    std::string out;
    read_file_bytes(path, out);
    return out;
}

/* ============================ 1. 设置 ============================ */
void test_settings(Ledger& L) {
    L.name = "settings";
    temp_dir();      // 保证 <userData>\selftest 存在（桩的记账文件写在那儿）
    const std::wstring settings = user_data_dir() + L"\\settings.json";

    /* 种一份**坏掉的**设置：内置预设的 name 被写成了 id；另有一家用户自己起过名字。 */
    Json seed = Json::object();
    seed["version"] = 1;
    Json provs = Json::object();
    auto mk = [](const char* name, const char* baseUrl, const char* model) {
        Json p = Json::object();
        p["enabled"] = true;
        p["name"] = name;
        p["baseUrl"] = baseUrl;
        p["format"] = "openai";
        p["models"] = Json::array({model});
        p["apiKeyEnc"] = "";
        return p;
    };
    provs["deepseek"] = mk("deepseek", "https://api.deepseek.com/v1", "deepseek-chat");
    provs["moonshot"] = mk("moonshot", "https://api.moonshot.cn/v1", "kimi-k2");
    provs["openai"] = mk("我的公司号", "https://api.openai.com/v1", "gpt-4o-mini");
    seed["providers"] = provs;
    Json active = Json::object();
    active["provider"] = "deepseek";
    active["model"] = "deepseek-chat";
    seed["active"] = active;
    seed["generation"] = Json::object();
    std::string err;
    json_write_file_atomic(settings, seed, 2, err);

    store_reset_cache();
    const Json pub = get_public_settings();
    const Json& p = pub["providers"];
    L.check("内置预设被写成 id → 已修回预设名（deepseek）", p["deepseek"]["name"] != "deepseek",
            p["deepseek"]["name"].get<std::string>());
    L.check("内置预设被写成 id → 已修回预设名（moonshot）", p["moonshot"]["name"] != "moonshot",
            p["moonshot"]["name"].get<std::string>());
    L.eq("用户自己起的名字一个字都不动", p["openai"]["name"].get<std::string>(), "我的公司号");

    /* ---------- 数组容错（第三路交叉审查抓到的**崩溃**） ----------
       `deep_merge` / `drop_secret_fields` 原来对数组调 `iter.key()`，而 nlohmann 会抛
       `invalid_iterator.207`；宿主侧没有 try/catch → `std::terminate` → 进程 0xC0000409。
       触发面不是恶意输入：顶层写成 `[1,2,3]`、或者手写的 `"ui":{"recentDirs":["C:\\a"]}`
       都会命中。这几条判据跑不过的话，**进程会直接消失**（所以"没崩"本身就是判据）。 */
    {
        std::string e;
        Json raw;
        L.check("顶层是数组也能解析", json_parse("[1,2,3]", raw, e), e);
        bool changed = false;
        const Json out = store_sanitize(raw, &changed);
        L.check("顶层是数组 → 容错成默认设置（旧版在这里直接崩）",
                out.is_object() && out.contains("providers"),
                json_dump(out, -1).substr(0, 60));

        Json raw2;
        L.check("属性里带数组也能解析",
                json_parse("{\"ui\":{\"recentDirs\":[\"C:\\\\a\"]},\"generation\":{\"x\":[1]}}", raw2, e), e);
        const Json out2 = store_sanitize(raw2, &changed);
        L.check("属性里的数组不会让 sanitize 崩", out2.is_object(), json_dump(out2, -1).substr(0, 60));

        Json raw3;
        json_parse("{\"ui\":{\"recentDirs\":[{\"apiKey\":\"sk-arr-secret\"}]}}", raw3, e);
        const Json out3 = store_sanitize(raw3, &changed);
        L.check("**数组元素里**的 secret 字段被清掉（不是跳过数组）",
                json_dump(out3, -1).find("sk-arr-secret") == std::string::npos,
                json_dump(out3["ui"], -1).substr(0, 80));
    }

    // 修完要回写，否则每次启动都要再修一遍（而且"修没修过"从界面上看不出来）
    Json onDisk;
    json_read_file(settings, onDisk, err);
    L.check("修过的名字已经落盘（不是每次启动现修）",
            onDisk["providers"]["deepseek"]["name"] != "deepseek",
            onDisk["providers"]["deepseek"]["name"].get<std::string>());

    /* 外链：只放行 http / https。**两头都要钉住** ——
       一项是"该放行的放行了"，另一项是"该拒的拒了"；
       只测一头的话，一个"永远拒绝"的实现也能过。 */
    std::vector<std::string> shown;
    Bridge bridge;
    bridge.UseShellStub(true, [](const std::string& what) {
        // 桩的记账口是 C 函数指针，捕获不了局部变量 —— 用文件记（这也是"证据落盘"）
        std::string cur;
        read_file_bytes(user_data_dir() + L"\\selftest\\shstub.txt", cur);
        cur += what + "\n";
        write_file_bytes(user_data_dir() + L"\\selftest\\shstub.txt", cur);
    });
    write_file_bytes(user_data_dir() + L"\\selftest\\shstub.txt", "");

    struct UrlCase { const char* url; bool want; const char* why; };
    const UrlCase cases[] = {
        {"javascript:alert(1)", false, "javascript: 不许拉起"},
        {"file:///C:/Windows/win.ini", false, "file: 不许拉起本机文件"},
        {"data:text/html,<h1>x</h1>", false, "data: 不许"},
        {"ms-settings:", false, "自定义 scheme 不许"},
        {"不是一个网址", false, "不是网址的直接拒"},
        {"", false, "空串拒"},
        {"https://www.deepseek.com", true, "https 放行"},
        {"http://localhost:9/x", true, "http 放行"},
    };
    for (const UrlCase& c : cases) {
        Json args = Json::array();
        args.push_back(c.url);
        const BridgeResult r = bridge.DispatchForTest("app:openExternal", args);
        L.check(std::string(c.why) + "：" + (c.url[0] ? std::string(c.url).substr(0, 30) : std::string("(空)")),
                r.ok == c.want, r.ok ? std::string() : r.code);
    }
    /* 期望值里那条根路径补出来的 `/` 是**对的**：走了一遍 URL 解析再交出去，
       根路径会被规范化成带尾斜杠的形式（这是 URL 规范，不是我们加的花样）。 */
    const std::string stub = read_text(user_data_dir() + L"\\selftest\\shstub.txt");
    L.check("被放行的那两条确实调了系统打开，而且参数就是那个网址（已规范化）",
            stub == "openExternal:https://www.deepseek.com/\nopenExternal:http://localhost:9/x\n",
            json_quote(stub));

    Json badArgs = Json::array();
    badArgs.push_back("https://www.deepseek.com");
    const BridgeResult viaOpenPath = bridge.DispatchForTest("app:openPath", badArgs);
    L.check("拿网址去调 openPath 会被拒（这正是原来那个 bug）", !viaOpenPath.ok, viaOpenPath.code);
}

/* ============================ 2. 背景图 ============================ */
void test_background(Ledger& L) {
    L.name = "background";
    const std::wstring tmp = temp_dir();
    const std::wstring imgA = tmp + L"\\a.png";
    const std::wstring imgB = tmp + L"\\b.jpg";
    const std::wstring imgGif = tmp + L"\\c.gif";
    write_bytes(imgA, kTinyPng, sizeof(kTinyPng));
    write_bytes(imgB, kTinyJpg, sizeof(kTinyJpg));
    write_bytes(imgGif, kTinyGif, sizeof(kTinyGif));

    bg_clear();

    const int64_t sizeA = stat_path(imgA).size;
    BgImportResult a;
    std::string err;
    const bool importedA = bg_import_from(imgA, a, err);   // 先调用、再判据（实参求值顺序未定义）
    L.check("导入成功", importedA, err);
    L.check("返回了文件名与字节数", !a.file.empty() && a.bytes > 0,
            a.file + " / " + std::to_string(a.bytes));
    L.check("图被**复制**进了配置目录（不是记住原路径）",
            stat_path(a.abs).isFile && to_utf8(a.abs).find(to_utf8(bg_dir())) == 0, to_utf8(a.abs));
    L.eq("currentFile() 能读回来", to_utf8(bg_current_file()), to_utf8(a.abs));
    L.check("原图还在（复制不是搬走）", stat_path(imgA).isFile);

    /* 换图时只留一张（别攒出一堆 background-1/2/3）。
       这里**换了扩展名**（png → jpg），才会走到"清掉旧名字"那一支。 */
    BgImportResult b;
    const bool importedB = bg_import_from(imgB, b, err);
    L.check("换扩展名导入成功（png → jpg）", importedB, err);
    {
        int count = 0;
        std::string names;
        for (const std::wstring& f : list_dir(bg_dir())) {
            if (f.rfind(L"background.", 0) == 0) { count++; names += to_utf8(f) + " "; }
        }
        L.eqInt("目录里只有一张背景图（换扩展名时旧的那张被清掉了）", count, 1);
        L.eq("换成了新的那张", to_utf8(bg_current_file()), to_utf8(b.abs));
        L.check("目录里没有半截临时文件",
                names.find(".tmp") == std::string::npos, names);
    }

    /* ---- 2b. 导入失败 / 导入自己，都不能把手里的旧图弄丢（两个实测 P0）----
       失败注入**不靠改产品代码**：把临时名那个位置先占成只读文件，
       CopyFileW 就会失败 —— 而那个名字是可算的（`<dest>.<pid>.tmp`）。 */
    {
        BgImportResult kept;
        bg_import_from(imgA, kept, err);       // 先把手里的图换成 png
        const std::wstring dest = bg_dir() + L"\\background.jpg";
        const std::wstring tempSlot = dest + L"." + std::to_wstring(::GetCurrentProcessId()) + L".tmp";
        write_file_bytes(tempSlot, "占位");
        ::SetFileAttributesW(tempSlot.c_str(), FILE_ATTRIBUTE_READONLY);

        BgImportResult ignored;
        std::string copyErr;
        const bool okB = bg_import_from(imgB, ignored, copyErr);
        ::SetFileAttributesW(tempSlot.c_str(), FILE_ATTRIBUTE_NORMAL);
        ::DeleteFileW(tempSlot.c_str());

        L.check("复制失败会明确报错（不是静默成功）", !okB && copyErr.find("复制这张图失败了") != std::string::npos,
                copyErr);
        L.check("导入失败后旧图**还在**（失败不该把原来那张弄丢）",
                to_utf8(bg_current_file()) == to_utf8(kept.abs) && stat_path(kept.abs).isFile,
                to_utf8(bg_current_file()));
        L.check("导入失败不会在目录里留下半截临时文件",
                [&] {
                    for (const std::wstring& f : list_dir(bg_dir())) {
                        if (ends_with(to_utf8(f), ".tmp")) return false;
                    }
                    return true;
                }(),
                to_utf8(bg_current_file()));
    }
    {
        const std::wstring self = bg_current_file();
        const int64_t selfBytes = stat_path(self).size;
        BgImportResult res;
        std::string selfErr;
        const bool okSelf = bg_import_from(self, res, selfErr);
        L.check("导入自己不再报错（源和目标是同一个文件）", okSelf, selfErr);
        int count = 0;
        for (const std::wstring& f : list_dir(bg_dir())) {
            if (f.rfind(L"background.", 0) == 0) count++;
        }
        L.eqInt("导入自己不会把目录清空（还是那一张图）", count, 1);
        L.check("导入自己之后图还在、字节数没变",
                to_utf8(bg_current_file()) == to_utf8(self) && stat_path(bg_current_file()).size == selfBytes,
                std::to_string(selfBytes));
        L.eq("导入自己的返回值仍然指向那张图", res.file, to_utf8(file_name(self)));
    }

    /* ---- 3. 拒绝不该接受的输入 ---- */
    {
        BgImportResult r;
        std::string e;
        /* ⚠️ 每一条都**先把调用落成变量、再进判据**。
           理由见 test_env 里那段：C++ 不规定实参求值顺序，把有副作用的调用
           和它写出的那些值一起塞进同一次调用，等于让"读"可能发生在"写"之前。
           这一处在旧写法下"碰巧能过"（`e` 被判据的第 3 个实参读到时可能还是空串），
           而那种"碰巧"正是本项目最不想要的东西。 */
        bool rejected = !bg_import_from(imgGif, r, e);
        L.check("非图片扩展名被拒", rejected && e.find("不支持这种图片格式") != std::string::npos, e);
        rejected = !bg_import_from(tmp, r, e);
        L.check("目录被拒", rejected && (e.find("只能选文件") != std::string::npos
                                      || e.find("不支持") != std::string::npos), e);
        rejected = !bg_import_from(tmp + L"\\nope.png", r, e);
        L.check("不存在的路径被拒", rejected && e.find("读不到") != std::string::npos, e);
        rejected = !bg_import_from(L"", r, e);
        L.check("空路径被拒", rejected && e.find("没有给出") != std::string::npos, e);

        // 造一个 21MB 的文件（SetEndOfFile 不落实际数据）来试大小上限
        const std::wstring big = tmp + L"\\big.png";
        HANDLE h = ::CreateFileW(big.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                                 FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h != INVALID_HANDLE_VALUE) {
            LARGE_INTEGER li{};
            li.QuadPart = 21LL * 1024 * 1024;
            ::SetFilePointerEx(h, li, nullptr, FILE_BEGIN);
            ::SetEndOfFile(h);
            ::CloseHandle(h);
        }
        rejected = !bg_import_from(big, r, e);
        L.check("超过 20MB 被拒", rejected && e.find("太大了") != std::string::npos, e);
        ::DeleteFileW(big.c_str());
    }

    /* ---- 4. 移除 ---- */
    {
        const std::vector<std::string> removed = bg_clear();
        L.check("移除成功", !removed.empty(), std::to_string(removed.size()) + " 个");
        int count = 0;
        for (const std::wstring& f : list_dir(bg_dir())) {
            if (f.rfind(L"background.", 0) == 0) count++;
        }
        L.eqInt("目录里没有残留", count, 0);
        L.eq("currentFile() 变成空", to_utf8(bg_current_file()), "");
    }

    /* ---- 5. 设置字段的钳制（写坏会让样式整条失效） ---- */
    store_reset_cache();
    {
        Json patch = Json::object();
        patch["ui"] = Json::object();
        patch["ui"]["bgScrim"] = 999;
        patch["ui"]["bgBlur"] = -5;
        patch["ui"]["bgImage"] = "../../evil.png";
        const Json saved = save_settings(patch);
        L.eqInt("bgScrim 被夹到 90", saved["ui"]["bgScrim"].get<long long>(), 90);
        L.eqInt("bgBlur 被夹到 0", saved["ui"]["bgBlur"].get<long long>(), 0);
        L.eq("bgImage 只留文件名（挡掉路径穿越）", saved["ui"]["bgImage"].get<std::string>(), "evil.png");
    }
    {
        Json patch = Json::object();
        patch["ui"] = Json::object();
        patch["ui"]["bgScrim"] = "abc";
        patch["ui"]["bgBlur"] = "x";
        const Json saved = save_settings(patch);
        L.eqInt("非数字回落到默认值（scrim=35）", saved["ui"]["bgScrim"].get<long long>(), 35);
        L.eqInt("非数字回落到默认值（blur=6）", saved["ui"]["bgBlur"].get<long long>(), 6);
    }
    {
        Json patch = Json::object();
        patch["ui"] = Json::object();
        patch["ui"]["bgScrim"] = "50";
        const Json saved = save_settings(patch);
        L.eqInt("数字字符串被接受（\"50\" → 50）", saved["ui"]["bgScrim"].get<long long>(), 50);
    }
    (void)sizeA;
}

/* ============================ 3. .env ============================ */
void test_env(Ledger& L) {
    L.name = "env";
    const std::wstring tmp = temp_dir();
    const std::wstring envFile = tmp + L"\\my.env";
    const std::string KEY = "sk-from-dotenv-abcdefghijklmnop";

    /* ---------------- 1. 解析 ---------------- */
    const std::string text =
        "# 注释行\n"
        "\n"
        "DEEPSEEK_API_KEY=" + KEY + "\n"
        "  ISG_MODEL = deepseek-chat  \n"
        "export ISG_PROVIDER=deepseek\n"
        "ISG_POINTS=42\n"
        "QUOTED=\"有 空格 的值\"\n"
        "SINGLE='单引号'\n"
        "INLINE=abc # 行尾注释\n"
        "EMPTY=\n"
        "NOT_A_PAIR\n";
    const Json parsed = env_parse_text(text);
    auto str = [&](const char* k) -> std::string {
        auto it = parsed.find(k);
        return (it != parsed.end() && it->is_string()) ? it->get<std::string>() : std::string("<缺失>");
    };
    L.eq("认 KEY=VALUE", str("DEEPSEEK_API_KEY"), KEY);
    L.eq("容忍两侧空格", str("ISG_MODEL"), "deepseek-chat");
    L.eq("容忍 export 前缀", str("ISG_PROVIDER"), "deepseek");
    L.eq("双引号里的空格保留", str("QUOTED"), "有 空格 的值");
    L.eq("单引号也认", str("SINGLE"), "单引号");
    L.eq("行尾注释被剥掉", str("INLINE"), "abc");
    L.check("注释行与空行被跳过", parsed.find("NOT_A_PAIR") == parsed.end());
    L.eq("CRLF 换行能正确处理", str("ISG_POINTS"), "42");
    /* 这条是 oracle 用一次真实事故换来的：**先剥行尾注释、再剥引号**，反过来会把
       `"C:\my # files\out"` 截断成 `C:\my` —— 静默写到错误的目录。 */
    {
        const Json q = env_parse_text("ISG_OUTPUT_DIR=\"C:\\my # files\\out\"\n");
        L.eq("引号里的 # 不被当行尾注释（剥注释与剥引号的顺序）",
             q["ISG_OUTPUT_DIR"].get<std::string>(), "C:\\my # files\\out");
    }

    /* ---------------- 2. 优先级：系统环境变量压过 .env ---------------- */
    write_file_bytes(envFile, "DEEPSEEK_API_KEY=" + KEY + "\nISG_POINTS=42\n");
    ::SetEnvironmentVariableW(L"ISG_ENV_FILE", envFile.c_str());
    env_reset();
    L.eq("默认位置能被 ISG_ENV_FILE 顶掉", to_utf8(full_path(env_load().file)), to_utf8(full_path(envFile)));
    L.eq(".env 里的值读得到", env_get("DEEPSEEK_API_KEY"), KEY);
    ::SetEnvironmentVariableW(L"DEEPSEEK_API_KEY", L"sk-from-real-env");
    L.eq("系统环境变量赢（排障时 set 一下必须立刻生效）", env_get("DEEPSEEK_API_KEY"), "sk-from-real-env");
    ::SetEnvironmentVariableW(L"DEEPSEEK_API_KEY", nullptr);

    /* ---------------- 3. 叠加到设置上 ---------------- */
    ::SetEnvironmentVariableW(L"ISG_PROVIDER", L"deepseek");
    ::SetEnvironmentVariableW(L"ISG_MODEL", L"deepseek-chat");
    ::SetEnvironmentVariableW(L"ISG_POINTS", L"48");
    env_reset();
    store_reset_cache();
    {
        const Json pub = get_public_settings();
        const Json& ds = pub["providers"]["deepseek"];
        L.check("provider 的 Key 来自 .env（hasKey=true）", ds["hasKey"].get<bool>(), "");
        L.check("标出了「来自环境/文件」以及变量名",
                ds["keyFromEnv"].get<bool>() && !ds["keyFrom"].get<std::string>().empty(),
                ds["keyFrom"].get<std::string>());
        L.check("只给掩码，不给明文",
                ds["keyHint"].is_string() && ds["keyHint"].get<std::string>().find(KEY) == std::string::npos,
                ds["keyHint"].get<std::string>());
        const std::string whole = json_dump(pub, -1);
        L.check("公开设置整体不含明文 Key", whole.find(KEY) == std::string::npos);
        L.eq("ISG_MODEL 生效", pub["active"]["model"].get<std::string>(), "deepseek-chat");
        L.eqInt("ISG_POINTS 生效", pub["generation"]["points"].get<long long>(), 48);
        L.check("诊断信息给到了 .env 路径与命中的变量名（界面据此显示「来自 .env」）",
                pub["env"]["found"].get<bool>() && to_utf8(envFile) == pub["env"]["file"].get<std::string>()
                && json_dump(pub["env"]["used"], -1).find("DEEPSEEK_API_KEY") != std::string::npos,
                json_dump(pub["env"], -1));
        bool onlyOurs = true;
        for (const Json& v : pub["env"]["used"]) {
            const std::string s = v.get<std::string>();
            if (s.rfind("ISG_", 0) != 0 && s.rfind("DEEPSEEK_", 0) != 0) onlyOurs = false;
        }
        L.check("诊断里**只有**实际用上的变量（不把跑它的那个 shell 的环境全列出来）", onlyOurs,
                json_dump(pub["env"]["used"], -1));

        /* ⚠️ **绝不能**把 `provider_config(...)` 写在判据的第 1 个实参里、却把依赖它结果的
           `cfg` / `err` 写在第 3 个实参里：C++ **不规定实参的求值顺序**，MSVC 从右往左 ——
           于是第 3 个实参先被求值，读到的还是默认构造的 `cfg`（null），
           而 `Json::value()` 对非对象会**抛异常**；宿主侧没有 try/catch，
           抛出去就是 std::terminate：进程原地消失、报告一个字节都没有，
           连"死在哪一条判据上"都看不出来（这就是 env 那套自测卡了半天的真凶）。
           规矩：**有副作用的调用一律先单独落成变量，再进判据。** */
        Json cfg;
        std::string cfgErr;
        const bool cfgOk = provider_config("deepseek", cfg, cfgErr);
        const std::string gotKey = cfgOk ? cfg.value("apiKey", std::string()) : std::string();
        L.check("providerConfig 拿到的是 .env 里的 Key（大模型层读的就是它）",
                cfgOk && gotKey == KEY,
                cfgOk ? gotKey.substr(0, 12) + "…" : cfgErr);
    }

    /* ---------------- 4. 最关键：不许落盘 ---------------- */
    {
        Json patch = Json::object();
        patch["generation"] = Json::object();
        patch["generation"]["units"] = 5;
        save_settings(patch);          // 触发一次真实的保存
        const std::string onDisk = read_text(user_data_dir() + L"\\settings.json");
        L.check("settings.json 里没有明文 Key", onDisk.find(KEY) == std::string::npos);
        L.check("settings.json 里也没有被 base64 过去的 Key",
                onDisk.find(base64_encode(KEY)) == std::string::npos);
        Json disk;
        std::string err;
        json_read_file(user_data_dir() + L"\\settings.json", disk, err);
        const std::string enc = disk["providers"]["deepseek"].contains("apiKeyEnc")
                                  ? disk["providers"]["deepseek"]["apiKeyEnc"].get<std::string>() : std::string();
        L.check("provider 的 apiKeyEnc 仍然是空的（没被 env 顶进去）", enc.empty(), json_quote(enc));
    }

    /* ---------------- 5. 没配 .env 时一切照旧 ---------------- */
    ::SetEnvironmentVariableW(L"ISG_ENV_FILE", nullptr);
    ::SetEnvironmentVariableW(L"ISG_PROVIDER", nullptr);
    ::SetEnvironmentVariableW(L"ISG_MODEL", nullptr);
    ::SetEnvironmentVariableW(L"ISG_POINTS", nullptr);
    env_reset();
    {
        const Json pub = get_public_settings();
        L.check("读不到 .env 时 found=false 且不报错", pub["env"]["found"].is_boolean() && !pub["env"]["found"].get<bool>(),
                json_dump(pub["env"], -1));
        L.check("提供商列表照常在（预设表里的家数）",
                pub["providers"].size() >= 14, std::to_string(pub["providers"].size()));
        L.check("没有 Key 的提供商 hasKey=false", !pub["providers"]["deepseek"]["hasKey"].get<bool>());
    }
}

/* ============================ 4. Key 不外漏 ============================ */
void test_key_leak(Ledger& L) {
    L.name = "key-leak";
    const std::wstring settings = user_data_dir() + L"\\settings.json";
    const std::string SECRET = "sk-realUSERkey-EEEEEEEEEEEEEEEE";

    /* 往 settings.json 里塞**各种形态**的 Key：名字不同的（apiKey / secret / token）、
       嵌套位置（headers['X-Key'] / nested.apiKey）、以及顶层自定义字段。
       这就是安全审计实测出来那个洞的形态：只删 apiKeyEnc 一个字段是不够的。 */
    Json seed = Json::object();
    seed["version"] = 1;
    Json ds = Json::object();
    ds["enabled"] = true;
    ds["baseUrl"] = "https://api.deepseek.com";
    ds["format"] = "openai";
    ds["models"] = Json::array({"deepseek-chat"});
    ds["apiKeyEnc"] = "raw:" + base64_encode(SECRET);
    ds["apiKey"] = SECRET;
    ds["secret"] = SECRET;
    ds["token"] = SECRET;
    ds["headers"] = Json::object();
    ds["headers"]["X-Key"] = SECRET;
    ds["nested"] = Json::object();
    ds["nested"]["apiKey"] = SECRET;
    Json provs = Json::object();
    provs["deepseek"] = ds;
    seed["providers"] = provs;
    Json active = Json::object();
    active["provider"] = "deepseek";
    active["model"] = "deepseek-chat";
    seed["active"] = active;
    seed["generation"] = Json::object();
    seed["ui"] = Json::object();
    Json custom = Json::object();
    custom["secret"] = SECRET;
    seed["custom"] = custom;
    std::string err;
    json_write_file_atomic(settings, seed, 2, err);

    store_reset_cache();
    const std::string pub = json_dump(get_public_settings(), -1);
    const std::string exp = json_dump(export_settings(), -1);
    const std::string onDisk = read_text(settings);

    L.check("明文 Key 不出现在 getPublicSettings 里",
            pub.find(SECRET) == std::string::npos);
    L.check("明文 Key 不出现在 exportSettings 里", exp.find(SECRET) == std::string::npos);
    L.check("导出里**没有** apiKey 字段", exp.find("\"apiKey\"") == std::string::npos);
    L.check("公开设置里**没有** apiKey 字段", pub.find("\"apiKey\"") == std::string::npos);
    L.check("公开设置里保留了 hasKey/keyHint",
            pub.find("\"hasKey\"") != std::string::npos && pub.find("\"keyHint\"") != std::string::npos);
    L.check("公开设置里 baseUrl/models 还在",
            pub.find("api.deepseek.com") != std::string::npos && pub.find("deepseek-chat") != std::string::npos);
    L.check("导出里带着 __keysStripped 标记（否则用户会以为它安全）",
            exp.find("__keysStripped") != std::string::npos);
    L.check("磁盘上（应该）仍有它、但只是 base64",
            onDisk.find(SECRET) == std::string::npos, "明文 ← 不应出现");
    L.check("手写的明文 apiKey 被采纳（不是被扔掉）——hasKey 仍然为真",
            pub.find("\"hasKey\":true") != std::string::npos);

    /* 单独钉一条：**绝不能对整份设置递归删字段** ——
       providers[*].apiKeyEnc 里含 "apiKey"，整份递归会把它删掉，
       那等于把用户**所有已存的 Key 一次清空**（oracle 自己踩过这个坑）。 */
    Json disk;
    json_read_file(settings, disk, err);
    L.check("apiKeyEnc 没被「删密钥字段」那道清洗误伤（它是密文，不能删）",
            !disk["providers"]["deepseek"]["apiKeyEnc"].get<std::string>().empty(),
            disk["providers"]["deepseek"]["apiKeyEnc"].get<std::string>().substr(0, 8) + "…");
}

/* ============================ 5. 与 Electron 的 Key 兼容 ============================ */
void test_key_compat(Ledger& L) {
    L.name = "keycompat";
    // 期望值由 tools/phase1-verify.ps1 用环境变量传进来（它先用真 Electron 写一份配置）
    wchar_t buf[512] = {};
    const DWORD n = ::GetEnvironmentVariableW(L"ISG_EXPECT_SECRET", buf, static_cast<DWORD>(std::size(buf)));
    const std::string expect = (n > 0 && n < std::size(buf)) ? to_utf8(std::wstring(buf, n)) : std::string();
    L.check("验前先确认期望值是**取到了**（取不到就成了「两份空值相等」的假绿）",
            !expect.empty(), expect.empty() ? "没有 ISG_EXPECT_SECRET" : "已取到");

    /* 先**单独验加解密那一层**：把盘上的密文直接取出来解一次。
       为什么要拆开验：`provider_config` 失败时只说"没填 Key"，
       而真正的原因可能是"密文解不开"——两件事的处理方式完全不同
       （前者让用户去填，后者要查格式 / 机器 / Windows 账户）。
       一条判据如果只能得出"没配好"，它就没有诊断价值。 */
    {
        Json disk;
        std::string readErr;
        const bool readOk = json_read_file(user_data_dir() + L"\\settings.json", disk, readErr);
        L.check("读得到盘上的 settings.json", readOk, readErr);
        if (readOk) {
            std::string encStored;
            if (disk.contains("providers") && disk["providers"].contains("deepseek")
                && disk["providers"]["deepseek"].contains("apiKeyEnc")) {
                encStored = disk["providers"]["deepseek"]["apiKeyEnc"].get<std::string>();
            }
            L.check("settings.json 里带着 enc: 密文", starts_with(encStored, "enc:"), encStored.substr(0, 12));
            std::string blob;
            const bool b64ok = starts_with(encStored, "enc:") && base64_decode(encStored.substr(4), blob);
            L.check("密文是合法 base64", b64ok);
            if (b64ok) {
                std::string plain;
                std::string decErr;
                const bool decOk = oscrypt_decrypt(blob, plain, decErr);
                L.check("OSCrypt 解开了它（v10 + AES-GCM + Local State 里的 DPAPI 密钥）",
                        decOk, decOk ? std::string() : decErr);
                if (decOk) {
                    L.check("解出来的明文就是 Electron 写进去的那一串", plain == expect,
                            decrypt_detail(plain, expect));
                }
            }
        }
    }

    store_reset_cache();
    Json cfg;
    std::string err;
    const bool ok = provider_config("deepseek", cfg, err);
    L.check("能读出 Electron 写下的那份配置", ok, err);
    if (ok) {
        const std::string got = cfg["apiKey"].get<std::string>();
        L.check("整条链路（santize → 解密 → providerConfig）拿到的明文逐字节相同",
                got == expect, decrypt_detail(got, expect));
    }
}

/* ============================ 5b. 反向：C++ 写、Electron 读 ============================ */
void test_key_write(Ledger& L) {
    L.name = "keywrite";
    wchar_t buf[512] = {};
    const DWORD n = ::GetEnvironmentVariableW(L"ISG_EXPECT_SECRET", buf, static_cast<DWORD>(std::size(buf)));
    const std::string secret = (n > 0 && n < std::size(buf)) ? to_utf8(std::wstring(buf, n)) : std::string();
    L.check("验前先确认要写的值取到了", !secret.empty(), secret.empty() ? "没有 ISG_EXPECT_SECRET" : "已取到");

    store_reset_cache();
    Json patch = Json::object();
    patch["providers"] = Json::object();
    patch["providers"]["deepseek"] = Json::object();
    patch["providers"]["deepseek"]["apiKey"] = secret;
    const Json pub = save_settings(patch);
    L.check("写完之后公开设置里 hasKey 为真",
            pub["providers"]["deepseek"]["hasKey"].get<bool>());
    Json cfg;
    std::string err;
    const bool ok = provider_config("deepseek", cfg, err);
    L.check("自己读回来也是对的（往返）", ok && cfg["apiKey"].get<std::string>() == secret, err);
    /* 真正的判据在下一棒：tools/electron-decrypt-probe.js 用**真的 Electron**
       去解这一份 —— 那一条证明的是"我们写的，老实现也读得懂"。 */
    L.check("已把带 Key 的配置写到：" , true, to_utf8(user_data_dir()));
}

/* ============================ 6. 桥的通道面 ============================ */
void test_bridge(Ledger& L) {
    L.name = "bridge";
    L.eqInt("通道表就是 31 条（不是 32 —— job:event 是订阅不是 invoke）",
            static_cast<long long>(kChannelCount), 31);
    {
        // 数**数组本身**（而不是再写一遍 kChannelCount），并查重 ——
        // 原来的写法两个实参都是 kChannelCount，是一条同义反复（第二路审查点出来的）。
        /* 数组条数在 channels.cpp 里由 static_assert 钉住（跨 TU 看不到 sizeof）；
           这里能验的是"没有重复"—— 重复登记会让 31 这个数虚高，而 kChannelCount 照样是 31。 */
        std::set<std::string> uniq;
        for (int i = 0; i < kChannelCount; ++i) uniq.insert(kChannels[i]);
        L.eqInt("31 个通道名互不相同（没有重复登记）", static_cast<long long>(uniq.size()), 31);
    }
    for (int i = 0; i < kChannelCount; ++i) {
        L.check(std::string("通道已登记：") + kChannels[i], is_known_channel(kChannels[i]));
    }
    L.check("没登记过的名字会被认出来", !is_known_channel("nope:nope"));

    /* 对话框通道要先换成"脚本化的用户选择"：否则这一套自测会真的弹出系统文件对话框
       —— 而它没人点，进程就永久挂在那里。自测可以有副作用，但不能有"挂住"的副作用。 */
    dialogs_set_stub(true, {});

    Bridge bridge;
    Json empty = Json::object();
    int notImpl = 0;
    int reachedHandler = 0;
    for (int i = 0; i < kChannelCount; ++i) {
        const char* c = kChannels[i];
        Json args = Json::array();
        const BridgeResult r = bridge.DispatchForTest(c, args);
        if (r.code == "UNKNOWN_CHANNEL" || r.code == "NO_HANDLER") {
            L.check(std::string("通道有分支（不是漏项）：") + c, false, r.code + " " + r.message);
            continue;
        }
        reachedHandler++;
        if (r.code == "NOT_IMPLEMENTED") {
            notImpl++;
            L.check(std::string("未实现的通道明确报错且说清阶段：") + c,
                    r.message.find("Phase") != std::string::npos, r.message);
        }
    }
    L.eqInt("每个通道都走到了一个明确的分支", reachedHandler, 31);
    /* Phase 6 之后 31 个公开通道全部有实现。这条判据仍然有意义：
       它盯的是"没有一条落在 NOT_IMPLEMENTED 上"——将来再加通道而只登记、不实现时，
       这里会立刻变成 >0，然后由上面那条"未实现的通道明确报错"逐个点名。 */
    L.eqInt("31 个公开通道全部有实现（NOT_IMPLEMENTED=0）", notImpl, 0);
    L.check("未知通道的名字会被明确拒绝",
            bridge.DispatchForTest("nope:nope", empty).code == "UNKNOWN_CHANNEL");
    L.check("未登记的内部通道也会明确拒绝",
            bridge.DispatchForTest("_pipeline:nope", empty).code == "UNKNOWN_CHANNEL");
}

/* ============================ 7. isg:// 的路径形态与白名单 ============================ */
void test_protocol(Ledger& L) {
    L.name = "protocol";
    const std::wstring tmp = temp_dir();
    const std::wstring inside = tmp + L"\\inside.txt";
    write_file_bytes(inside, "hello");
    const std::wstring outside = tmp + L"\\..\\outside.txt";
    write_file_bytes(outside, "secret");

    protocol_reset();
    L.check("没放行之前，临时目录里的文件也不许读", !protocol_is_allowed(inside));
    protocol_allow(tmp);
    L.check("放行之后自己的文件可以通过", protocol_is_allowed(inside));

    /* urlFor 的形态必须与 oracle 一致：逐段编码、盘符那个冒号编成 %3A。 */
    const std::string url = protocol_url_for(inside);
    L.check("urlFor 编出 isg://local/ 形态", starts_with(url, "isg://local/"), url);
    L.check("盘符的冒号被编码（不能整体 encodeURIComponent，否则分隔符也没了）",
            url.find("%3A") != std::string::npos, url);

    /* **安全边界不自己撞一遍，就等于没验过**（Phase 0 的原话）。
       拿各种越界形态去撞，要求它们被**显式拒**（返回 false + 原因），
       而不是"碰巧没服务出去" —— 后者可能是 404，判据就分不清
       "白名单拦住了"和"根本没这个文件"。 */
    struct ShapeCase { const char* url; const char* why; };
    const ShapeCase shapes[] = {
        {"isg://local/..%2f..%2fWindows/win.ini", "..%2f 编码穿越"},
        {"isg://local/%2e%2e%2f%2e%2e%2fWindows/win.ini", "%2e%2e%2f 双重形态"},
        {"isg://local/C%3A/Windows/win.ini%3Astream", "NTFS 数据流（第二个冒号）"},
        {"isg://local/%5C%5Cserver%5Cshare%5Cx.html", "UNC 路径"},
        {"isg://local/%5C%5C%3F%5CC%3A%5Cx.html", "设备路径 \\\\?\\"},
        {"isg://local/%5Cfoo.html", "根相对路径"},
        {"isg://local/other/plain.html", "不带盘符的相对路径"},
    };
    for (const ShapeCase& c : shapes) {
        std::wstring disk;
        std::string why;
        const bool parsed = protocol_disk_path_from_url(c.url, disk, why);
        L.check(std::string("越界形态被显式拒：") + c.why, !parsed, parsed ? to_utf8(disk) : why);
    }
    /* 正常形态要能解回来（只测"拒"不测"放"，一个永远拒的实现也能全绿） */
    {
        std::wstring disk;
        std::string why;
        const std::string u = protocol_url_for(inside);
        L.check("正常形态能解回磁盘路径", protocol_disk_path_from_url(u, disk, why), why);
        const std::string got = ascii_lower(to_utf8(full_path(disk)));
        const std::string want = ascii_lower(to_utf8(full_path(inside)));
        L.eq("解回来的就是原路径（大小写归一之后逐字符相同）", got, want);
        L.check("解回来的路径仍然通过白名单", protocol_is_allowed(disk));
    }
    protocol_reset();
}

/* ---------------------------------------------------------------------------
   Phase 2：抽取层自测（等价 oracle 的 extract-smoke.js）
   ---------------------------------------------------------------------------
   三条纪律：
     · 夹具**自己造**（不依赖 oracle 的 test/_out，也不依赖仓库里恰好有哪份课件）；
     · 每条判据断言字段/数字（页数、标题、文本片段、quality 字段），不断言"没抛错"；
     · 真实 PDF 用 ISG_SAMPLE_DIR 指过去；没有就明确记一条"跳过"，不当成通过。 */
std::string child_text(const Json& out, size_t i) {
    if (!out.contains("pages") || !out["pages"].is_array() || i >= out["pages"].size()) return std::string();
    return out["pages"][i].value("text", std::string());
}
std::string child_title(const Json& out, size_t i) {
    if (!out.contains("pages") || !out["pages"].is_array() || i >= out["pages"].size()) return std::string();
    return out["pages"][i].value("title", std::string());
}
bool child_quality_ok(const Json& out, size_t i) {
    if (!out.contains("pages") || !out["pages"].is_array() || i >= out["pages"].size()) return false;
    const Json& p = out["pages"][i];
    if (!p.contains("quality") || !p["quality"].is_object()) return false;
    const Json& q = p["quality"];
    return q.contains("chars") && q["chars"].is_number() && q.contains("cjkRatio")
           && q["cjkRatio"].is_number() && q.contains("suspect") && q["suspect"].is_boolean();
}
bool make_test_pptx(const std::wstring& path, std::string& err) {
    mz_zip_archive zip{};
    if (!mz_zip_writer_init_heap(&zip, 0, 0)) { err = "mz_zip_writer_init_heap 失败"; return false; }
    bool ok = true;
    auto add = [&](const char* name, const std::string& s) {
        if (!mz_zip_writer_add_mem(&zip, name, s.data(), s.size(), MZ_BEST_COMPRESSION)) ok = false;
    };
    const std::string slide1 = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>第一张：椭球参数与表格</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>实体测试：&amp; &lt; &gt; &quot; &apos; &#x4E2D;&#25991;</a:t></a:r></a:p><a:p><a:r><a:t>普通第一段</a:t></a:r><a:br/><a:r><a:t>a:br 之后的第二行</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="table"/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>
<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>参数</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>数值</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>长半轴 a</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>6378137 m</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>)xml";
    const std::string slide2 = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>第二张：应当排在最前面</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>这一页在 sldIdLst 里排第一，但文件名是 slide2.xml</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>)xml";
    const std::string presentation = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>)xml";
    const std::string presRels = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>)xml";
    const std::string rootRels = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>)xml";
    const std::string contentTypes = R"xml(<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>)xml";
    add("[Content_Types].xml", contentTypes);
    add("_rels/.rels", rootRels);
    add("ppt/presentation.xml", presentation);
    add("ppt/_rels/presentation.xml.rels", presRels);
    add("ppt/slides/slide1.xml", slide1);
    add("ppt/slides/slide2.xml", slide2);
    void* buf = nullptr;
    size_t size = 0;
    if (ok && !mz_zip_writer_finalize_heap_archive(&zip, &buf, &size)) {
        ok = false;
        err = "finalize 失败";
    }
    mz_zip_writer_end(&zip);
    if (ok) {
        if (buf == nullptr || size == 0) {
            ok = false;
            err = "zip 产物为空";
        } else {
            ok = write_file_bytes(path, std::string(static_cast<const char*>(buf), size));
            if (!ok) err = "写夹具文件失败";
        }
    }
    mz_free(buf);
    if (!ok) {
        remove_file(path);   // 别留下半截文件让下一次测试误读
        if (err.empty()) err = "写 zip 条目失败";
    }
    return ok;
}

void test_extract(Ledger& L) {
    const std::wstring dir = temp_dir();
    const ExtractOptions opt;
    ExtractError err;
    Json out;

    /* ---- 1. Markdown：标题切页 + 契约字段 ---- */
    const std::wstring md = dir + LR"(\extract-selftest.md)";
    write_file_bytes(md, R"md(# 第一章 大地测量基础

正文第一段。

## 1.1 椭球参数

长半轴 a = 6378137 m。

## 1.2 常用坐标系

这里有三种坐标系。
)md");
    const bool mdOk = extract_file(md, opt, out, err);
    L.check("Markdown 抽取成功", mdOk, err.message);
    if (mdOk) {
        L.eq("kind=text", out.value("kind", ""), "text");
        L.eqInt("按 ATX 标题切成 3 节", static_cast<long long>(out["pages"].size()), 3);
        L.eq("第 1 节标题", child_title(out, 0), "第一章 大地测量基础");
        L.eq("第 2 节标题去掉了 # 号", child_title(out, 1), "1.1 椭球参数");
        L.check("正文跟着小节走", child_text(out, 1).find("6378137") != std::string::npos);
        L.check("每页都有 quality{chars,cjkRatio,suspect}",
                child_quality_ok(out, 0) && child_quality_ok(out, 1) && child_quality_ok(out, 2));
        L.eqInt("meta.pageCount 与 pages 一致", out["meta"].value("pageCount", 0), 3);
        L.check("meta.title 取第一节标题",
                out["meta"].value("title", "").find("大地测量基础") != std::string::npos);
        L.check("diagnosis 字段齐",
                out.contains("diagnosis") && out["diagnosis"].contains("likely")
                && out["diagnosis"].contains("pages"));
    }

    /* ---- 2. 纯文本 / GBK ---- */
    const std::wstring plain = dir + LR"(\extract-plain.txt)";
    write_file_bytes(plain, R"txt(这是一段没有任何 Markdown 标题的讲稿。
第二行。
)txt");
    if (extract_file(plain, opt, out, err)) {
        L.eqInt("没有标题时整体一页", static_cast<long long>(out["pages"].size()), 1);
        bool info = false;
        for (const auto& w : out["warnings"]) if (w.value("level", "") == "info") info = true;
        L.check("没有标题会给一条 info 提示（不是静默）", info);
    } else {
        L.check("纯文本抽取成功", false, err.message);
    }
    const unsigned char gbkBytes[] = {0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x0A};
    const std::wstring gbkPath = dir + LR"(\extract-gbk.txt)";
    write_file_bytes(gbkPath, std::string(reinterpret_cast<const char*>(gbkBytes), sizeof(gbkBytes)));
    if (extract_file(gbkPath, opt, out, err)) {
        L.eq("GBK 文件被正确解码", child_text(out, 0), "中文测试");
    } else {
        L.check("GBK 文件能抽", false, err.message);
    }

    /* ---- 3. 错误上下文 ---- */
    const std::wstring missing = dir + LR"(\no-such-file.pdf)";
    err = ExtractError{};
    L.check("文件不存在会报错", !extract_file(missing, opt, out, err));
    L.check("错误信息带上了路径（上下文不丢）",
            err.message.find("no-such-file.pdf") != std::string::npos, err.message);
    const std::wstring docx = dir + LR"(\extract-unknown.docx)";
    write_file_bytes(docx, "not a courseware");
    err = ExtractError{};
    L.check("不认识的扩展名会报错", !extract_file(docx, opt, out, err));
    L.check("错误信息说明了不支持", err.message.find("不认识这个文件类型") != std::string::npos, err.message);
    const std::wstring ole = dir + LR"(\extract-legacy.doc)";
    const unsigned char oleMagic[] = {0xD0, 0xCF, 0x11, 0xE0, 0x00, 0x00, 0x00, 0x00};
    write_file_bytes(ole, std::string(reinterpret_cast<const char*>(oleMagic), sizeof(oleMagic)));
    err = ExtractError{};
    L.check("旧版二进制 Office 格式被明确拒绝", !extract_file(ole, opt, out, err));
    L.eq("拒绝码是 LEGACY_BINARY_FORMAT", err.code, "LEGACY_BINARY_FORMAT");
    L.check("错误文案告诉用户另存为 pptx/pdf",
            err.message.find("另存为") != std::string::npos, err.message);

    /* ---- 4. PPTX：放映顺序 / 实体 / 段落 / 表格 ---- */
    const std::wstring pptx = dir + LR"(\extract-selftest.pptx)";
    std::string zerr;
    const bool madePptx = make_test_pptx(pptx, zerr);
    L.check("能造出最小 PPTX 夹具", madePptx, zerr);
    err = ExtractError{};
    if (!madePptx) {
        L.check("PPTX 抽取（夹具没造出来，后续判据无法执行）", false, zerr);
    } else if (extract_file(pptx, opt, out, err)) {
        L.eq("kind=pptx", out.value("kind", ""), "pptx");
        L.eqInt("抽到 2 张幻灯片", static_cast<long long>(out["pages"].size()), 2);
        L.check("幻灯片顺序由 sldIdLst 决定（slide2.xml 排第一）",
                child_text(out, 0).find("应当排在最前面") != std::string::npos, child_title(out, 0));
        L.check("标题取自 title 占位符",
                child_title(out, 0).find("第二张") != std::string::npos, child_title(out, 0));
        L.check("XML 实体全部解码", child_text(out, 1).find(R"q(& < > " ' 中文)q") != std::string::npos);
        L.check("正文里没有残留的实体写法", child_text(out, 1).find("&amp;") == std::string::npos);
        L.check("a:p 分段 / a:br 换行",
                child_text(out, 1).find(R"q(普通第一段
a:br 之后的第二行)q") != std::string::npos);
        L.check("表格按「 | 」连接", child_text(out, 1).find("参数 | 数值") != std::string::npos);
        L.check("表格数据行", child_text(out, 1).find("长半轴 a | 6378137 m") != std::string::npos);
        L.check("pptx 每页 quality 齐", child_quality_ok(out, 0) && child_quality_ok(out, 1));
    } else {
        L.check("PPTX 抽取成功", false, err.message);
    }

    /* ---- 5. 坏 PDF：报错必须带文件名 ---- */
    const std::wstring badPdf = dir + LR"(\extract-broken.pdf)";
    write_file_bytes(badPdf, R"pdf(%PDF-1.4
this is not a real pdf
%%EOF
)pdf");
    err = ExtractError{};
    const bool badOk = extract_file(badPdf, opt, out, err);
    L.check("坏 PDF 的处理是明确的（报错，或明确抽出 0 页）",
            !badOk || out["pages"].empty());
    if (!badOk) {
        L.check("坏 PDF 的报错带上了文件名",
                err.message.find("extract-broken.pdf") != std::string::npos, err.message);
    } else {
        L.check("坏 PDF 抽出 0 页时没有可疑的空壳结果", out["pages"].empty());
    }


}


/* 真实 PDF 的判据单独一套：它依赖外部样本（ISG_SAMPLE_DIR）。
   这样合成夹具那套（--selftest=extract）在没有样本的机器上也能跑，
   而"缺样本"不会被静默地当成"全部通过"（条数对不上就会红）。 */
void test_extract_pdf(Ledger& L) {
    ExtractError err;
    Json out;
    /* ---- 6. 真实 PDF：页数 / 正文 / 可疑页 / 耗时 ---- */
    wchar_t sampleBuf[32768] = {};
    const DWORD sampleLen = ::GetEnvironmentVariableW(L"ISG_SAMPLE_DIR", sampleBuf,
                                                      static_cast<DWORD>(std::size(sampleBuf)));
    const std::wstring sampleDir = (sampleLen > 0 && sampleLen < std::size(sampleBuf))
                                       ? std::wstring(sampleBuf, sampleLen) : std::wstring();
    if (sampleDir.empty()) {
        L.check("真实 PDF 对拍：设置了 ISG_SAMPLE_DIR", false,
                "没有设置 ISG_SAMPLE_DIR —— 这一条**不算通过**，只是跳过（DoD 需要真 PDF）");
    } else {
        const std::wstring pdf = sampleDir + LR"(\03 地球椭球-1.pdf)";
        if (!stat_path(pdf).isFile) {
            L.check("真实 PDF 对拍：找得到 03 地球椭球-1.pdf", false, to_utf8(pdf));
        } else {
            ExtractOptions popt;
            const int64_t t0 = ProcessClock{}.now_ms();
            const bool ok = extract_file(pdf, popt, out, err);
            const int64_t ms = ProcessClock{}.now_ms() - t0;
            L.check("真实 PDF 抽取成功", ok, err.message);
            if (ok) {
                L.eqInt("页数 33", static_cast<long long>(out["pages"].size()), 33);
                int64_t total = 0;
                int64_t blank = 0;
                std::string all;
                for (size_t i = 0; i < out["pages"].size(); ++i) {
                    total += out["pages"][i]["quality"].value("chars", 0);
                    all += child_text(out, i);
                    for (const auto& r : out["pages"][i]["quality"].value("reasons", Json::array())) {
                        if (r.is_string() && r.get<std::string>() == "no_text_extracted") ++blank;
                    }
                }
                L.check("总字符数 > 5000（中文确实抽出来了）", total > 5000, std::to_string(total));
                L.check("正文含「地球椭球」", all.find("地球椭球") != std::string::npos);
                L.check("正文里没有 U+FFFD", all.find("�") == std::string::npos);
                L.eqInt("有 1 页整页无文字（与 oracle 一致）", blank, 1);
                L.check("33 页在 10 秒内抽完", ms < 10000, std::to_string(ms) + " ms");
            }
        }
    }
    /* 大文件只在设置了 ISG_SAMPLE_DIR 且文件存在时跑；143 页是 oracle 那一套的口径。 */
    if (!sampleDir.empty()) {
        const std::wstring big = sampleDir + LR"(\数字图像处理——图像增强-xh.pdf)";
        if (stat_path(big).isFile) {
            ExtractOptions popt;
            const int64_t t0 = ProcessClock{}.now_ms();
            const bool ok = extract_file(big, popt, out, err);
            const int64_t ms = ProcessClock{}.now_ms() - t0;
            L.check("26MB / 143 页 PDF 抽取成功", ok, err.message);
            if (ok) {
                L.eqInt("页数 143", static_cast<long long>(out["pages"].size()), 143);
                int64_t total = 0;
                for (const auto& p : out["pages"]) total += p["quality"].value("chars", 0);
                L.check("总字符数 > 20000", total > 20000, std::to_string(total));
                L.check("143 页在 60 秒内抽完", ms < 60000, std::to_string(ms) + " ms");
            }
        }
    }
}

/* ---------------- Phase 6：旁挂数据（读半身 + 形状） ---------------- */

void test_book(Ledger& L) {
    const std::wstring dir = temp_dir() + L"\\book";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    const std::wstring html = dir + L"\\ch13.html";
    const std::wstring side = html + L".isg.json";
    write_file_bytes(html, "<!doctype html><title>x</title><p>page</p>");

    const std::string json = R"JSON({
  "schema": "isg-book/1",
  "kind": "book",
  "title": "大学物理",
  "subject": "大学物理学",
  "key": "book-key-abc",
  "chapters": [
    { "chapter": {"no":"13","title":"磁介质","subject":"大学物理学","intro":"导语"},
      "key": "ch13-key", "frozen": true,
      "units": [{ "id":"u1","num":"13.1","title":"磁化","shortTitle":"13.1","qsecTitle":"练一练",
                  "lede":"导读","lectureHtml":"<p>正文</p>",
                  "bank":[{"id":"q1","type":"single","stem":"题","opts":[],"ans":0}] }],
      "demos": [{ "id":"demoA","title":"演示","markup":"<div></div>","js":"var a=1;","unitId":"u1","unitTitle":"磁化" }] },
    { "chapter": {"no":"14","title":"电磁感应"}, "key": "ch14-key",
      "units": [], "demos": [] }
  ]
})JSON";
    std::string err;
    Json parsed;
    L.check("夹具 JSON 自己先能解析", json_parse(json, parsed, err), err);
    write_file_bytes(side, json);

    book::ReadResult r = book::read_book(html);
    L.check("旁挂数据能读出来（schema 认识）", r.ok(), r.detail);
    L.eq("顶层 key 原样拿到", r.ok() ? r.book.value("key", std::string()) : std::string(), "book-key-abc");
    L.eq("kind=book 原样拿到", r.ok() ? r.book.value("kind", std::string()) : std::string(), "book");

    book::SidecarLoad loaded = book::load_from_sidecar(html);
    L.check("一册两章**都**带上来（只取 chapters[0] 就是静默丢章）",
            loaded.ok && loaded.entries.is_array() && loaded.entries.size() == 2,
            std::to_string(loaded.entries.is_array() ? loaded.entries.size() : 0));
    L.eq("带着的是册的顶层 key", loaded.book_key, "book-key-abc");
    L.check("每一章都 frozen（作答点 id 一个字不许改）",
            loaded.entries.is_array() && loaded.entries.size() == 2
                && loaded.entries[0].value("frozen", false) && loaded.entries[1].value("frozen", false));
    const Json u = loaded.entries.is_array() && !loaded.entries.empty()
                       ? loaded.entries[0]["units"][0] : Json();
    L.eq("单元必填字段齐（id）", u.value("id", std::string()), "u1");
    L.eq("shortTitle 这类拼装器要用的字段原样保留", u.value("shortTitle", std::string()), "13.1");
    L.check("题库原样搬（id 没被重算）",
            u.contains("bank") && u["bank"].is_array() && !u["bank"].empty()
                && u["bank"][0].value("id", std::string()) == "q1");
    L.eq("演示补上了 unitTitle", loaded.entries.is_array() && !loaded.entries.empty()
             ? loaded.entries[0]["demos"][0].value("unitTitle", std::string()) : std::string(),
         "磁化");

    Json c1 = book::judge_continuity(Json::array({"14"}), Json::array({"13"}));
    L.check("14 接在 13 后面 → 连续", c1.value("continuous", false));
    Json c2 = book::judge_continuity(Json::array({"15"}), Json::array({"12", "13"}));
    L.check("15 跳过 14 → 不连续", !c2.value("continuous", false));
    L.check("不连续时 gapBefore=true（日志要用它提醒用户）", c2.value("gapBefore", false));
    Json c3 = book::judge_continuity(Json::array({"附录"}), Json::array({"13"}));
    L.check("非数字章号一律判不连续（宁可不缝，也不猜）", !c3.value("continuous", false));

    Json entry = Json::object();
    entry["htmlPath"] = to_utf8(html);
    entry["status"] = "done";
    Json d = book::describe_for_list(entry);
    L.eq("旁挂数据在 → mergeStatus=chapter", d.value("mergeStatus", std::string()), "chapter");
    L.check("chapter 时 exactMerge=true", d.value("exactMerge", false));

    const std::wstring plain = dir + L"\\plain.html";
    write_file_bytes(plain, "<html></html>");
    Json e2 = Json::object();
    e2["htmlPath"] = to_utf8(plain);
    e2["status"] = "done";
    Json d2 = book::describe_for_list(e2);
    L.eq("只剩 HTML → mergeStatus=html", d2.value("mergeStatus", std::string()), "html");
    L.check("html 时 canMerge=true 但 exactMerge=false",
            d2.value("canMerge", false) && !d2.value("exactMerge", false));

    write_file_bytes(side, "{ not json");
    book::ReadResult bad = book::read_book(html);
    L.eq("坏 JSON → corrupt（不是静默当成没数据）",
         std::string(bad.status == book::ReadStatus::corrupt ? "corrupt" : "other"), "corrupt");
}

/* ---------------- Phase 6：收尾清单（宁可漏，不可误删） ---------------- */

void test_cleanup(Ledger& L) {
    const std::wstring dir = temp_dir() + L"\\cleanup";
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    const std::wstring html = dir + L"\\ch13-磁场-讲练一体.html";
    const std::wstring side = html + L".isg.json";
    const std::wstring probe = dir + L"\\_probe_12345_0_ch13-磁场-讲练一体.html";
    const std::wstring runlog = dir + L"\\ch13-磁场-讲练一体.run.log";
    const std::wstring pet = dir + L"\\pet.png";
    const std::wstring userProbe = dir + L"\\_probe_notes.html";
    const std::wstring userProbe2 = dir + L"\\_probe_2024.html";
    const std::wstring userLog = dir + L"\\体检.run.log.bak";
    write_file_bytes(html, "<html></html>");
    write_file_bytes(side, "{}");
    write_file_bytes(probe, "probe");
    write_file_bytes(runlog, "boom");
    write_file_bytes(pet, "PNG");
    write_file_bytes(userProbe, "my notes");
    write_file_bytes(userProbe2, "yearly");
    write_file_bytes(userLog, "nope");

    Json job = Json::object();
    job["htmlPath"] = to_utf8(html);
    job["filePath"] = to_utf8(temp_dir() + L"\\课件.md");
    job["options"] = Json::object();
    job["options"]["outputDir"] = to_utf8(dir);
    Json logs = Json::array();
    Json l1 = Json::object();
    l1["message"] = "陪练图片已放到页面同目录：pet.png";
    logs.push_back(l1);
    job["logs"] = logs;

    CleanupPlan plan = cleanup_scan_run(job);
    int artifacts = 0, probes = 0, logsN = 0, pets = 0;
    std::set<std::wstring> paths;
    for (const CleanupFile& f : plan.files) {
        paths.insert(lower_w(f.path));
        if (f.kind == "artifact") ++artifacts;
        else if (f.kind == "probe") ++probes;
        else if (f.kind == "log") ++logsN;
        else if (f.kind == "pet") ++pets;
        L.check("清单条目带 path/bytes/kind/what 四样",
                !f.path.empty() && f.bytes >= 0 && !f.kind.empty() && !f.what.empty());
    }
    L.eqInt("认出了产物（页面 + 旁挂数据）", artifacts, 2);
    L.eqInt("认出了探针副本", probes, 1);
    L.eqInt("认出了失败日志（*.run.log）", logsN, 1);
    L.eqInt("认出了本次真拷过的陪练图", pets, 1);
    L.eqInt("没漏也没多（正好 5 个）", static_cast<long long>(plan.files.size()), 5);
    L.check("用户自己起的 _probe_notes.html 不被认", !paths.count(lower_w(userProbe)));
    L.check("_probe_2024.html（缺一段数字）不被认", !paths.count(lower_w(userProbe2)));
    L.check("*.run.log.bak 不被认", !paths.count(lower_w(userLog)));
    int64_t sum = 0;
    for (const CleanupFile& f : plan.files) sum += f.bytes;
    L.eqInt("totalBytes = 各文件大小之和", plan.totalBytes, sum);

    /* 不带"真拷过"的证据时，pet.png 是用户的文件，不能列。 */
    Json job2 = job;
    job2["logs"] = Json::array();
    CleanupPlan plan2 = cleanup_scan_run(job2);
    bool listedPet = false;
    for (const CleanupFile& f : plan2.files) if (lower_w(f.path) == lower_w(pet)) listedPet = true;
    L.check("没有\"拷过\"的证据时，不认 pet.png（宁可漏，不可误删）", !listedPet);

    /* 删除：目录外的路径必须被拒；正常清单能删；删完不再存在。 */
    const std::wstring outside = temp_dir() + L"\\outside.txt";
    write_file_bytes(outside, "keep me");
    Json want = Json::array();
    want.push_back(to_utf8(probe));
    want.push_back(to_utf8(outside));
    Json removed = cleanup_do(job, want);
    L.check("白名单内的路径删掉了",
            removed["removed"].is_array() && removed["removed"].size() == 1);
    L.check("目录外的路径被拒，且文件还在",
            !stat_path(outside).exists ? false : true);
    L.check("删除失败如实回报（不是静默丢弃）",
            removed["failed"].is_array() && removed["failed"].size() == 1);
    L.check("探针副本真的删了", !stat_path(probe).exists);
    L.check("无关文件（sidecar / 用户文件）一个没动",
            stat_path(side).exists && stat_path(userProbe).exists && stat_path(userProbe2).exists);

    /* ---- 通道层：run:scanCleanup / run:doCleanup 必须自己查任务、自己重扫 ----
       只测模块函数证明不了"渲染层递一个任意 jobId / 任意路径能不能删"。 */
    {
        const std::wstring dir2 = temp_dir() + L"\\cleanup-channel";
        std::filesystem::create_directories(std::filesystem::path(dir2), ec);
        const std::wstring p2 = dir2 + L"\\_probe_999_0_x.html";
        const std::wstring l2 = dir2 + L"\\x.run.log";
        write_file_bytes(p2, "probe");
        write_file_bytes(l2, "log");
        const std::wstring outside2 = temp_dir() + L"\\channel-outside.txt";
        write_file_bytes(outside2, "keep");

        JobStore jobs;
        Json input = Json::object();
        Json sources = Json::array();
        Json s1 = Json::object();
        s1["id"] = "s1";
        s1["role"] = "courseware";
        s1["filePath"] = to_utf8(dir + L"\\课件.md");
        s1["fileName"] = "课件.md";
        sources.push_back(s1);
        input["sources"] = sources;
        Json opts = Json::object();
        opts["outputDir"] = to_utf8(dir2);
        input["options"] = opts;
        input["mode"] = "book";
        Json created;
        std::string err;
        const bool made = jobs.Create(input, created, err);
        L.check("通道自测先建了一个真任务", made, err);
        const std::string jobId = created.value("jobId", std::string());
        Bridge br;
        br.SetJobs(&jobs);

        const BridgeResult scan = br.DispatchForTest("run:scanCleanup", Json::array({jobId}));
        int nFiles = -1;
        if (scan.ok && scan.data.is_object() && scan.data.contains("files")
            && scan.data["files"].is_array()) {
            nFiles = static_cast<int>(scan.data["files"].size());
        }
        L.check("run:scanCleanup 通过任务号扫出了清单", scan.ok && nFiles == 2,
                std::to_string(nFiles));
        Json req = Json::object();
        req["jobId"] = jobId;
        Json wantPaths = Json::array();
        wantPaths.push_back(to_utf8(p2));
        wantPaths.push_back(to_utf8(outside2));
        req["paths"] = wantPaths;
        const BridgeResult done = br.DispatchForTest("run:doCleanup", Json::array({req}));
        int removedN = -1, failedN = -1;
        if (done.ok && done.data.is_object()) {
            removedN = done.data["removed"].is_array()
                           ? static_cast<int>(done.data["removed"].size()) : -1;
            failedN = done.data["failed"].is_array()
                          ? static_cast<int>(done.data["failed"].size()) : -1;
        }
        L.check("run:doCleanup 只删清单内的那一个", done.ok && removedN == 1,
                std::to_string(removedN));
        L.check("递进来的目录外路径被重扫挡住", done.ok && failedN == 1,
                std::to_string(failedN));
        L.check("目录外的文件确实还在", stat_path(outside2).exists);
        const BridgeResult unknown = br.DispatchForTest("run:scanCleanup", Json::array({"nope"}));
        L.check("不存在的任务号 → NOT_FOUND（不猜目录）",
                !unknown.ok && unknown.code == "NOT_FOUND", unknown.code);
    }
}

}  // namespace

int selftest_run_headless(const std::string& name, const std::wstring& reportPath) {
    std::vector<Ledger> ledgers;
    auto run = [&](const char* n, void (*fn)(Ledger&)) {
        Ledger l;
        if (!reportPath.empty()) l.partialPath = reportPath + L".partial";
        l.touch(std::string("=== 开始自测：") + n);
        fn(l);
        ledgers.push_back(std::move(l));
        (void)n;
    };

    if (name == "settings") run("settings", test_settings);
    else if (name == "background") run("background", test_background);
    else if (name == "env") run("env", test_env);
    else if (name == "key-leak") run("key-leak", test_key_leak);
    else if (name == "keycompat") run("keycompat", test_key_compat);
    else if (name == "keywrite") run("keywrite", test_key_write);
    else if (name == "bridge") run("bridge", test_bridge);
    else if (name == "protocol") run("protocol", test_protocol);
    else if (name == "extract") run("extract", test_extract);
    else if (name == "extract-pdf") run("extract-pdf", test_extract_pdf);
    /* 无窗口的那一套叫 book-data：`book` 这个名字留给真窗口的通道自测（main 那边要先分流）。 */
    else if (name == "book-data") run("book-data", test_book);
    else if (name == "cleanup") run("cleanup", test_cleanup);
    else {
        Json root = Json::object();
        root["ok"] = false;
        root["test"] = name;
        root["lines"] = Json::array({"  [BAD] 不认识的自测名：" + name});
        const std::string text = json_dump(root, 2);
        if (!reportPath.empty()) write_file_bytes(reportPath, text);
        console_write(text + "\n");
        return 2;
    }

    int bad = 0;
    int checked = 0;
    Json all = Json::array();
    std::string text;
    for (const Ledger& l : ledgers) {
        const Json j = l.to_json();
        all.push_back(j);
        bad += l.bad;
        checked += l.checked;
        text += "=== 自测：" + l.name + " ===\n";
        for (const Json& line : l.lines) text += line.get<std::string>() + "\n";
        text += "\n";
    }
    text += (bad ? ("❌ 失败 " + std::to_string(bad) + " 项（共 " + std::to_string(checked) + " 项）\n")
                 : ("✅ 全部通过（共 " + std::to_string(checked) + " 项）\n"));

    Json root = Json::object();
    root["ok"] = (bad == 0);
    root["test"] = name;
    root["checked"] = checked;
    root["bad"] = bad;
    root["groups"] = all;
    if (!reportPath.empty()) {
        write_file_bytes(reportPath, json_dump(root, 2));
        // 人读的那份（报告与 oracle 的自测输出同形）
        std::wstring human = reportPath;
        const size_t dot = human.find_last_of(L'.');
        if (dot != std::wstring::npos) human = human.substr(0, dot) + L".txt";
        write_file_bytes(human, text);
    }
    console_write(text);
    return bad == 0 ? 0 : 1;
}

const std::string& selftest_pipeline_script() {
    /* 这段脚本跑在**真页面**里，用的是真正的 `window.isg` → C++ → 页面 JS 流水线。
       它只负责驱动与等结果；"产物里到底有什么"由宿主在 OnScriptResult 里读文件核对
       （页面读不了磁盘，也不应该读）。
       ⚠️ 结果必须走 selftestResult 消息回传：ExecuteScript 不等 Promise。 */
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const t0 = Date.now();
  const trace = (s) => {
    try {
      window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'trace', text: s }));
    } catch (e) {}
  };
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try {
      window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload }));
    } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.isg;
  const fixture = __ISG_PIPELINE_FIXTURE__;
  const outDir = __ISG_PIPELINE_OUT__;

  try {
    check('window.isg 就绪', !!api && typeof api.startGeneration === 'function');
    check('pipeline-host 就绪', !!window.__isgPipelineHost);

    const errors = [];
    let doneEvent = null;
    api.onJobEvent(function (ev) {
      if (!ev) return;
      if (ev.type === 'log' && ev.entry && ev.entry.level === 'error') errors.push(ev.entry.message);
      if (ev.type === 'done') doneEvent = ev;
    });

    trace('准备调用 startGeneration');
    const started = await api.startGeneration({
      sources: [{ id: 's1', role: 'courseware', filePath: fixture, fileName: 'pipeline.md', label: 'pipeline.md' }],
      options: {
        outputDir: outDir,
        // ⚠️ 用**界面真实字段名**：quizTarget / chapterTitle（不是 points / title）。
        // 直接写 points 会绕过 OPTION_ALIASES，测不出"滑杆与章标题有没有生效"。
        units: 6, quizTarget: 40, demos: 2,
        chapterTitle: '测试章', pet: 'none', auditors: 1, repairRounds: 2, concurrency: 3,
        language: 'zh-CN', temperature: 0.3,
        // 用户逐页修订：流水线必须收到它（`options.editedPages` 不能被宿主瘦身剥掉）。
        editedPages: [{ sourceId: 's1', index: 1, text: '# 磁介质与磁场中的介质\n\nEDITED-SENTINEL：这一页是用户改过的。\n' }]
      },
      mode: 'book'
    });
    const jobId = started && started.ok && started.data && (started.data.jobId || started.data.id);
    trace('startGeneration 返回：' + JSON.stringify(started && started.error ? started.error : { ok: started && started.ok, jobId }));
    check('gen:start 回了 jobId', !!jobId, jobId || JSON.stringify(started && started.error));
    if (!jobId) { send({ ok: false, bad: bad + 1, lines }); return; }

    let last = null;
    // 宿主看门狗是 90 秒；这里最多 80 秒，保证脚本自己的诊断能送回去。
    for (let i = 0; i < 160; i++) {
      await sleep(500);
      const jr = await api.getJob(jobId);
      if (i % 4 === 0) trace('轮询 #' + i + '：' + JSON.stringify(jr && jr.ok ? { status: jr.data && jr.data.status, logs: jr.data && jr.data.logs && jr.data.logs.length } : (jr && jr.error)));
      if (jr && jr.ok && jr.data) {
        last = jr.data;
        if (last.status === 'done' || last.status === 'failed' || last.status === 'canceled') break;
      }
    }
    check('任务在 120 秒内结束', !!(last && (last.status === 'done' || last.status === 'failed' || last.status === 'canceled')),
      last ? last.status : '没有任务快照');
    check('任务状态是 done', !!(last && last.status === 'done'),
      last && last.error ? last.error.message : (last ? last.status : ''));
    if (errors.length) trace('任务日志里的 error：' + errors.slice(0, 3).join(' | '));
    check('任务日志里没有 error 级条目', errors.length === 0, errors.slice(0, 3).join(' | '));
    check('done 事件到达', !!(doneEvent && doneEvent.status === 'done'), doneEvent ? doneEvent.status : '');
    check('产出了 HTML 路径', !!(last && last.htmlPath), last ? last.htmlPath : '');
    check('日志条数 > 10（流水线真的跑了很多步）', !!(last && Array.isArray(last.logs) && last.logs.length > 10),
      last && last.logs ? String(last.logs.length) : '');

    lines.push('  [info] 用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
    send({
      ok: bad === 0, bad, lines, jobId,
      status: last && last.status, htmlPath: last && last.htmlPath,
      audit: last && last.audit, usage: last && last.usage,
      logs: (last && Array.isArray(last.logs)) ? last.logs : []
    });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_net_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  try {
    check('__isgTestChat 就绪（页面里的 llm 层能直接被驱动）', typeof window.__isgTestChat === 'function');
    // **先**测「测试连接」：这时还没跑过 __isgTestChat（它内部会 setEnv）。
    // 这一条专门盯"新启动应用、直接点测试连接"的路径（以前必然 ENO_PROVIDER）。
    // settings:test → 页面里的 llm.testConnection → GET /models（与真生成同一条代码路径）
    const tc = await window.isg.testConnection('deepseek');
    check('测试连接通过（/models 拿到了列表）',
      !!(tc && tc.ok && tc.data && tc.data.ok && Array.isArray(tc.data.models) && tc.data.models.length),
      tc && tc.ok ? JSON.stringify(tc.data && { ok: tc.data.ok, models: tc.data.models, error: tc.data.error }) : JSON.stringify(tc && tc.error));
    const chunks = [];
    const res = await window.__isgTestChat({
      model: 'mock-large',
      json: true,
      stream: true,
      maxTokens: 123,
      temperature: 0.1,
      messages: [{ role: 'user', content: 'ping' }],
      provider: { supportsJsonMode: true },
      onDelta: (t) => chunks.push(t)
    });
    check('chat 返回了结果', !!res);
    check('正文完整（SSE 跨包拼接 + `data: 0` 保活行之后仍然收到全部内容）',
      res.text === '{"ok":1}', JSON.stringify(res.text));
    check('流式增量拼起来等于正文', chunks.join('') === '{"ok":1}', JSON.stringify(chunks.join('')));
    check('json:true 时解析出了 data', !!(res.data && res.data.ok === 1), JSON.stringify(res.data));
    check('usage 来自流内事件（in=10 / out=5）',
      !!(res.usage && res.usage.in === 10 && res.usage.out === 5), JSON.stringify(res.usage));
    const deg = Array.isArray(res.degraded) ? res.degraded : [];
    check('400 降级：去掉了 response_format', deg.some((d) => d.field === 'response_format'), JSON.stringify(deg));
    check('400 降级：去掉了 stream_options', deg.some((d) => d.field === 'stream_options'), JSON.stringify(deg));
    const chunkCount = Number(window.__isgLastFetchChunks) || 0;
    check('SSE 真的是跨消息块拼出来的（收到 >1 个 chunk）', chunkCount > 1, String(chunkCount));

    send({ ok: bad === 0, bad, lines });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_cancel_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const trace = (s) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'trace', text: s })); } catch (e) {}
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.isg;
  const fixture = __ISG_PIPELINE_FIXTURE__;
  const outDir = __ISG_PIPELINE_OUT__;
  try {
    const started = await api.startGeneration({
      sources: [{ id: 's1', role: 'courseware', filePath: fixture, fileName: 'cancel.md', label: 'cancel.md' }],
      options: { outputDir: outDir, units: 6, points: 40, demos: 2, pet: 'none',
                 auditors: 0, repairRounds: 0, concurrency: 3, language: 'zh-CN' },
      mode: 'book'
    });
    const jobId = started && started.ok && started.data && (started.data.jobId || started.data.id);
    check('gen:start 回了 jobId', !!jobId);
    if (!jobId) { send({ ok: false, bad: bad + 1, lines }); return; }

    // 故障服务在 slow 模式下每个请求睡 10 秒；1.5 秒时任务一定还在等模型。
    await sleep(1500);
    const before = await api.getJob(jobId);
    trace('取消前状态：' + (before && before.data && before.data.status));
    check('取消前任务仍在运行（模型请求还没回来）',
      !!(before && before.ok && before.data && (before.data.status === 'running' || before.data.status === 'pending')),
      before && before.data ? before.data.status : '');

    const t0 = Date.now();
    const c = await api.cancelGeneration(jobId, { policy: 'keep' });
    check('cancelGeneration 返回 true', !!(c && c.ok && c.data === true), JSON.stringify(c && (c.error || c.data)));

    let last = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const jr = await api.getJob(jobId);
      if (jr && jr.ok && jr.data) {
        last = jr.data;
        if (last.status === 'canceled' || last.status === 'failed' || last.status === 'done') break;
      }
    }
    const ms = Date.now() - t0;
    check('任务在 20 秒内结束', !!(last && (last.status === 'canceled' || last.status === 'failed' || last.status === 'done')),
      last ? last.status : '没有任务快照');
    check('最终状态是 canceled（不是 failed，也不是 running）', !!(last && last.status === 'canceled'),
      last ? last.status : '');
    // 服务端要睡 10 秒；如果取消没有真的中止在途请求，这里会等到 ≥10 秒。
    check('取消在 8 秒内生效（在途 HTTP 请求被中止，而不是等它超时）', ms < 8000, ms + ' ms');
    const logs = (last && Array.isArray(last.logs)) ? last.logs.map((l) => l.message || '') : [];
    check('日志里有「用户取消了任务」', logs.some((m) => m.indexOf('用户取消了任务') >= 0));
    send({ ok: bad === 0, bad, lines });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_verify_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  const api = window.isg;
  const P = window.__isgProbeParse;
  const goodPath = __VERIFY_GOOD__;
  const badPath = __VERIFY_BAD__;
  const tinyPath = __VERIFY_TINY__;
  try {
    check('probe-parse.js 已加载', !!(P && typeof P.buildReport === 'function'));

    const rawGood = await window.__isgHost.invoke('verify:run', [{ htmlPath: goodPath, probes: ['verify'], timeoutMs: 20000 }]);
    const rawD = rawGood && rawGood.ok ? rawGood.data : null;
    const domKeys = rawD && rawD.domFacts && typeof rawD.domFacts === 'object'
      ? Object.keys(rawD.domFacts).join(',') : String(rawD && rawD.domFacts);
    lines.push('  [info] 原始 domFacts: ' + domKeys
      + '；error=' + JSON.stringify(rawD && rawD.domFacts && rawD.domFacts.error)
      + '；total=' + JSON.stringify(rawD && rawD.domFacts && rawD.domFacts.total));

    const good = await api.verifyHtml(goodPath, ['verify']);
    check('verifyHtml 回了信封', !!(good && good.ok), JSON.stringify(good && good.error));
    const gr = good && good.ok ? good.data : null;
    check('报告里有 items', !!(gr && Array.isArray(gr.items) && gr.items.length > 0),
      gr ? String(gr.items.length) : '没有报告');
    const badItems = (gr && gr.items ? gr.items : []).filter((it) => it.ok === false);
    check('真页面没有判 false 的项', badItems.length === 0,
      badItems.map((x) => x.label).join('、'));
    const keys = (gr && gr.items ? gr.items : []).map((it) => it.key);
    for (const k of ['题库条目', '缺卡', '自动作答后判错', '脚本错误']) {
      check('报告里有「' + k + '」', keys.indexOf(k) >= 0);
    }
    check('报告里有 DOM 快照比出来的「顶栏总数」', keys.indexOf('顶栏总数') >= 0);

    const badPage = await api.verifyHtml(badPath, ['verify']);
    const br = badPage && badPage.ok ? badPage.data : null;
    check('被改坏的页面：校验整体判不通过', !!(br && br.ok === false),
      br ? JSON.stringify(br.items.filter((x) => x.ok === false).map((x) => x.key)) : JSON.stringify(badPage && badPage.error));
    check('被改坏的页面：至少一项 ok=false（不是"什么都没测到"）',
      !!(br && br.items && br.items.some((x) => x.ok === false)));
    const badKeys = (br && br.items ? br.items : []).filter((x) => x.ok === false).map((x) => x.key);
    check('失败项是「题库条目」而不是超时/别的原因',
      badKeys.indexOf('题库条目') >= 0 && badKeys.indexOf('探针未跑完') < 0,
      JSON.stringify(badKeys));

    const unk = await api.verifyHtml(goodPath, ['not-a-probe']);
    check('不认识的探针名 → BAD_ARG（不猜）',
      !!(unk && unk.ok === false && unk.error && unk.error.code === 'BAD_ARG'),
      JSON.stringify(unk && unk.error));

    const demoOk = [{ id: 'd1', checks: [{ set: { r: 3 }, expect: { o: '6' } }] }];
    const rawOk = await window.__isgHost.invoke('_verify:demo', [{ htmlPath: tinyPath, demos: demoOk }]);
    const rOk = rawOk && rawOk.ok ? P.buildDemoResult(rawOk.data, demoOk) : null;
    lines.push('  [info] demo raw: ' + JSON.stringify(rawOk && rawOk.data));
    check('demo 核对：读数与公式一致 → ok=true', !!(rOk && rOk.ok === true),
      rOk ? rOk.note : JSON.stringify(rawOk && rawOk.error));

    const demoBad = [{ id: 'd1', checks: [{ set: { r: 3 }, expect: { o: '7' } }] }];
    const rawBad = await window.__isgHost.invoke('_verify:demo', [{ htmlPath: tinyPath, demos: demoBad }]);
    const rBad = rawBad && rawBad.ok ? P.buildDemoResult(rawBad.data, demoBad) : null;
    check('demo 核对：读数对不上 → ok=false（该报错就报错）', !!(rBad && rBad.ok === false),
      rBad ? rBad.note : JSON.stringify(rawBad && rawBad.error));

    check('0.5% 容差内算相等', P.sameValue('1.0179', '1.01794') === true);
    check('明显不同必须判不等', P.sameValue('1.0179', '1.1120') === false);
    check('能从带单位的文本里抠出数字', P.pickNumber('1.06 T') === 1.06 && P.pickNumber('—') === null);

    send({ ok: bad === 0, bad, lines });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_multi_source_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.isg;
  try {
    const started = await api.startGeneration({
      sources: [
        { id: 's1', role: 'courseware', filePath: __MS_FIXTURE1__, fileName: 'courseware.md', label: 'courseware.md' },
        { id: 's2', role: 'exampaper', filePath: __MS_FIXTURE2__, fileName: 'exam.md', label: 'exam.md' }
      ],
      options: { outputDir: __MS_OUT__, units: 6, quizTarget: 40, demos: 1, pet: 'none',
                 auditors: 0, repairRounds: 0, concurrency: 3, language: 'zh-CN', temperature: 0.3 },
      mode: 'book'
    });
    const jobId = started && started.ok && started.data && (started.data.jobId || started.data.id);
    check('gen:start 回了 jobId', !!jobId, JSON.stringify(started && started.error));
    if (!jobId) { send({ ok: false, bad: bad + 1, lines }); return; }
    let last = null;
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      const jr = await api.getJob(jobId);
      if (jr && jr.ok && jr.data) {
        last = jr.data;
        if (last.status === 'done' || last.status === 'failed' || last.status === 'canceled') break;
      }
    }
    check('任务 done', !!(last && last.status === 'done'),
      last ? (last.error ? last.error.message : last.status) : '没有任务快照');
    const logs = (last && Array.isArray(last.logs)) ? last.logs.map((l) => l.message || '') : [];
    check('日志里说清了这是多来源生成', logs.some((m) => /多来源/.test(m)),
      logs.join(' | ').slice(0, 160));
    const rep = last && last.report;
    check('多来源任务也有探针报告', !!(rep && Array.isArray(rep.items) && rep.items.length),
      rep ? String(rep.items.length) : '没有 report');
    check('报告里没有判 false 的项', !!(rep && Array.isArray(rep.items)
      && rep.items.every((it) => !(it && it.ok === false))), '');
    send({ ok: bad === 0, bad, lines, jobId, htmlPath: last && last.htmlPath });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_book_e2e_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.isg;
  const fixture = __ISG_PIPELINE_FIXTURE__;
  const outDir = __ISG_PIPELINE_OUT__;

  async function waitJob(jobId) {
    let last = null;
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      const jr = await api.getJob(jobId);
      if (jr && jr.ok && jr.data) {
        last = jr.data;
        if (last.status === 'done' || last.status === 'failed' || last.status === 'canceled') break;
      }
    }
    return last;
  }

  async function run(opts) {
    const r = await api.startGeneration({
      sources: [{
        id: 's1', role: 'courseware', filePath: fixture, fileName: 'book-e2e.md',
        label: 'book-e2e.md',
        chapterNo: opts.chapterNo, chapterTitle: opts.chapterTitle
      }],
      options: Object.assign({
        outputDir: outDir, units: 6, quizTarget: 40, demos: opts.demos,
        pet: 'none', auditors: 1, repairRounds: 0, concurrency: 3,
        language: 'zh-CN', temperature: 0.3
      }, opts.options || {}),
      mode: 'book',
      carry: opts.carry
    });
    const id = r && r.ok && r.data && (r.data.jobId || r.data.id);
    check(opts.label + '：gen:start 回了 jobId', !!id, JSON.stringify(r && r.error));
    if (!id) return { id: '', job: null };
    const job = await waitJob(id);
    check(opts.label + '：任务 done', !!(job && job.status === 'done'),
      job ? (job.error ? job.error.message : job.status) : '没有任务快照');
    return { id, job };
  }

  try {
    const first = await run({ label: '第 1 次（单章）', chapterNo: '13', chapterTitle: '磁介质', demos: 1 });
    if (!first.job || first.job.status !== 'done') { send({ ok: false, bad: bad + 1, lines }); return; }

    const list = await api.listBookChapters();
    const one = list && list.ok && Array.isArray(list.data)
      ? list.data.filter((x) => x.id === first.id)[0] : null;
    check('book:list 里能找到刚生成的任务，且 mergeStatus=chapter（旁挂数据落盘了）',
      !!(one && one.mergeStatus === 'chapter' && one.exactMerge === true),
      one ? one.mergeStatus : JSON.stringify(list && list.error));

    const insp = await api.inspectBookChapter({ kind: 'history', id: first.id });
    check('book:inspect(history) 走旁挂数据这条精确路',
      !!(insp && insp.ok && insp.data && insp.data.from === 'sidecar' && insp.data.canCarry === true),
      JSON.stringify(insp && (insp.data || insp.error)));

    const second = await run({
      /* 第 2 次也生成演示：带过来的章占住 demoA，新章会被拼装器改名成 demoB。
         这正是 demo-checks 最容易"核对到另一章同名演示"的场景。 */
      label: '第 2 次（带第 1 章）', chapterNo: '14', chapterTitle: '电磁感应', demos: 1,
      carry: [{ kind: 'history', id: first.id }]
    });
    if (!second.job || second.job.status !== 'done') { send({ ok: false, bad: bad + 1, lines }); return; }

    const outs = Array.isArray(second.job.outputs) ? second.job.outputs : [];
    check('第 2 次写出 1 份页面', outs.length === 1, String(outs.length));
    check('这一份是**一册**（isBook=true、chapters=2）',
      !!(outs[0] && outs[0].isBook === true && outs[0].chapters === 2),
      outs[0] ? JSON.stringify({ isBook: outs[0].isBook, chapters: outs[0].chapters }) : '没有 outputs');
    check('第 2 次日志里说清了"带上 N 章"',
      (second.job.logs || []).some((l) => /带上了 \d+ 章/.test(l.message || '')),
      (second.job.logs || []).map((l) => l.message).join(' | ').slice(0, 160));
    check('第 2 次日志里有"这一份是一册"',
      (second.job.logs || []).some((l) => /这一份是\*\*一册\*\*/.test(l.message || '')));

    send({ ok: bad === 0, bad, lines,
           jobId1: first.id, jobId2: second.id,
           htmlPath1: first.job.htmlPath, htmlPath2: second.job.htmlPath,
           chapterFile2: second.job.chapterFile || '' });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

const std::string& selftest_book_script() {
    static const std::string script = R"JS(
(async () => {
  const lines = [];
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    lines.push((ok ? '  [ok]  ' : '  [BAD] ') + name
      + ((extra === undefined || extra === '') ? '' : ('  —— ' + extra)));
  };
  const send = (payload) => {
    try { window.chrome.webview.postMessage(JSON.stringify({ __isg: 1, kind: 'selftestResult', payload })); } catch (e) {}
  };
  const api = window.isg;
  const side = __BOOK_SIDE__;
  const plain = __BOOK_PLAIN__;
  const junk = __BOOK_JUNK__;
  const secret = __BOOK_SECRET__;
  const md = __BOOK_MD__;
  try {
    /* 配一个"看着像能用"的模型：carry 的失败路径发生在建任务之前，
       但它前面有 NO_MODEL 这一关，不配就走不到 carry。 */
    const sv = await api.saveSettings({
      providers: { mock: { enabled: true, name: 'Mock', baseUrl: 'http://127.0.0.1:1/v1',
                             format: 'openai', models: ['mock'], apiKey: '' } },
      active: { provider: 'mock', model: 'mock' }
    });
    check('设置能保存（只为过 gen:start 的 NO_MODEL 关）', !!(sv && sv.ok), JSON.stringify(sv && sv.error));

    const list = await api.listBookChapters();
    check('book:list 回了 {ok,data} 信封，data 是数组',
      !!(list && list.ok && Array.isArray(list.data)), JSON.stringify(list && list.error));

    const i1 = await api.inspectBookChapter({ kind: 'file', path: side });
    const d1 = i1 && i1.ok ? i1.data : null;
    check('旁挂数据在：from=sidecar、canCarry=true、problems 为空',
      !!(d1 && d1.from === 'sidecar' && d1.canCarry === true && d1.problems.length === 0),
      JSON.stringify(d1 && { from: d1.from, canCarry: d1.canCarry, n: d1.problems.length }));
    check('章号/标题拿得到（sidecar）', !!(d1 && d1.chapter.no === '13' && d1.chapter.title === '磁介质'),
      JSON.stringify(d1 && d1.chapter));
    check('inspect 的 payload 里**没有** data（结构数据不跟着走）',
      !!d1 && !Object.prototype.hasOwnProperty.call(d1, 'data'));
    check('payload 恰好五个键',
      !!d1 && JSON.stringify(Object.keys(d1).sort()) === '["canCarry","chapter","from","ok","problems"]',
      d1 && JSON.stringify(Object.keys(d1).sort()));

    const i2 = await api.inspectBookChapter({ kind: 'file', path: plain });
    const d2 = i2 && i2.ok ? i2.data : null;
    check('只剩成品页面：from=revive、canCarry=true', !!(d2 && d2.from === 'revive' && d2.canCarry === true),
      JSON.stringify(d2 && { from: d2.from, canCarry: d2.canCarry }));
    check('反推的"注意"如实带回来', !!(d2 && d2.problems.length >= 1 && d2.problems.every((p) => p.level && p.message)),
      d2 ? String(d2.problems.length) : '');

    const i3 = await api.inspectBookChapter({ kind: 'file', path: junk });
    const d3 = i3 && i3.ok ? i3.data : null;
    check('结构对不上 → canCarry=false，并带 blocker',
      !!(d3 && d3.canCarry === false && d3.problems.some((p) => p.level === 'blocker')),
      d3 ? JSON.stringify(d3.problems.map((p) => p.code)) : JSON.stringify(i3 && i3.error));

    const i4 = await api.inspectBookChapter({ kind: 'file', path: secret });
    check('没放行过的路径 → NOT_ALLOWED（报一个路径读不了任意文件）',
      !!(i4 && i4.ok === false && i4.error && i4.error.code === 'NOT_ALLOWED'),
      JSON.stringify(i4 && i4.error));

    const i5 = await api.inspectBookChapter({ kind: '瞎写', id: 'x' });
    check('不认识的来源 → BAD_ARG（不猜）',
      !!(i5 && i5.ok === false && i5.error && i5.error.code === 'BAD_ARG'));

    const cont = await api.bookContinuity({ chapterNos: ['14'] });
    check('book:continuity 回了 continuous/knownNos/pendingNos',
      !!(cont && cont.ok && cont.data && typeof cont.data.continuous === 'boolean'
         && Array.isArray(cont.data.knownNos) && Array.isArray(cont.data.pendingNos)),
      JSON.stringify(cont && (cont.data || cont.error)));

    const before = await api.listJobs();
    const beforeN = (before && before.ok && Array.isArray(before.data)) ? before.data.length : -1;
    const st = await api.startGeneration({
      sources: [{ id: 's1', role: 'courseware', filePath: md, fileName: 'lesson.md', label: 'lesson.md' }],
      options: { outputDir: __BOOK_OUT__ },
      carry: [{ kind: 'file', path: junk }]
    });
    check('带一份不能用 → CARRY_UNUSABLE', !!(st && st.ok === false && st.error && st.error.code === 'CARRY_UNUSABLE'),
      JSON.stringify(st && st.error));
    check('错误信息是人话（"不能合并"+哪一条对不上）',
      !!(st && st.error && /不能合并/.test(st.error.message || '') && (st.error.message || '').length > 20),
      (st && st.error && st.error.message || '').slice(0, 120));
    const after = await api.listJobs();
    const afterN = (after && after.ok && Array.isArray(after.data)) ? after.data.length : -2;
    check('失败时没有留下僵尸任务（先验后建）', beforeN >= 0 && afterN === beforeN,
      beforeN + ' → ' + afterN);

    const sep = await api.startGeneration({
      sources: [{ id: 's1', role: 'courseware', filePath: md, fileName: 'lesson.md', label: 'lesson.md' }],
      options: { outputDir: __BOOK_OUT__ },
      mode: 'separate',
      carry: [{ kind: 'file', path: side }]
    });
    check('分开生成 + carry → BAD_ARG（一册不存在，不硬塞）',
      !!(sep && sep.ok === false && sep.error && sep.error.code === 'BAD_ARG'),
      JSON.stringify(sep && sep.error));

    send({ ok: bad === 0, bad, lines });
  } catch (e) {
    send({ ok: false, bad: bad + 1, lines: lines.concat(['  [BAD] 脚本自己抛了：' + String((e && e.stack) || e)]) });
  }
})();
)JS";
    return script;
}

}  // namespace isg
