// 工作台界面的背景图：导入、替换、移除。对应 oracle 的 src/main/bg.js —— 逐条翻译，
// 三个刻意的设计（理由一字不改地搬过来）：
//
//   1. **导入 = 复制进配置目录**（`<userData>/background/`），不是记住原图路径。
//      用户选完图往往把原图挪走/改名/删掉，记路径的话下次打开就是一片空白，
//      而且报错得莫名其妙。复制一份是几十 KB~几 MB 的事，换来"永远有效"。
//   2. **只放行这一个目录**，而不是把 `userData` 整个开成可读区。
//      主进程的 `isg://` 协议是按"白名单目录"服务的；把 userData 整个放行，渲染进程就能
//      读到同目录下的 `settings.json`（里面有加密后的 API Key 材料）。背景图单独住一个子目录。
//   3. **文件名固定 + 换扩展名时删掉旧的**：不该在磁盘上攒出 `background-1.png`、`background-2.jpg`
//      —— 配置目录是拿来用的，不是拿来堆的。
//
// 另一条是**数据的 P0**：导入的顺序必须是"先写临时名 → rename 就位 → 最后才清旧的"。
// 原来（oracle 修之前）是 `removeAll()` 紧接着按最终文件名 `copyFileSync`，等于"先删旧的
// 再写新的"，实测有两个后果：复制失败时旧图已经被删了（点一次导入、失败，连原来那张都没了），
// 以及用户把**当前这张**再选一遍时源=目标，先删就把源删了、目录被清空。
// 见 importFrom 里那段注释与 test/background.js 的 2b 节。

#include "bg.h"

#include "../app/app.h"
#include "../util/file_ops.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

namespace isg {

/* 允许的图片格式。webp 也认（现代浏览器都支持）。 */
const char* const kBgAllowedExt[4] = {".png", ".jpg", ".jpeg", ".webp"};

namespace {

constexpr wchar_t kBase[] = L"background";        // 固定文件名（不含扩展名）
constexpr int64_t kMaxBytes = 20LL * 1024 * 1024; // 上限 20MB

// ---------------------------------------------------------------------------
// 小助手
// ---------------------------------------------------------------------------

bool wstarts_with(const std::wstring& s, const wchar_t* prefix) {
    const size_t n = std::wcslen(prefix);
    return s.size() >= n && s.compare(0, n, prefix) == 0;
}

bool is_allowed_ext(const std::string& lowerExt) {
    for (const char* e : kBgAllowedExt) {
        if (lowerExt == e) return true;
    }
    return false;
}

/* Node 的 path.extname(p) 的最小实现（结果转小写），只保留 bg 这一层用得上的语义：
     · 先取最后一段名字（`C:\a.b\c` → `c`，扩展名**不**从目录名里取）；
     · 最后一个点之前的都算主名，开头的点不算扩展名（`.env` → ``）；
     · 末尾的点算（`background.` → `.`）；
     · `.` / `..` 没有扩展名。
   返回带点的小写扩展名，没有则返回空串。 */
std::string ext_name_lower(const std::wstring& path) {
    const std::wstring base = file_name(path);
    if (base == L"." || base == L"..") return std::string();
    const size_t dot = base.find_last_of(L'.');
    if (dot == std::wstring::npos || dot == 0) return std::string();
    return ascii_lower(to_utf8(base.substr(dot)));
}

/* 归一化绝对路径，对应 Node 的 path.resolve：removeAll 靠它比"这一份是不是 keep 指的那份"。
   两边都由同一个 bg_dir() 拼出来，所以正常情况下逐字符相等；带上这一步是为了防
   用户用 ISG_USER_DATA 指了个带 `..` 或尾随分隔符的目录，那种情况下字符串直接比会漏判。 */
std::wstring normalize_abs(const std::wstring& path) {
    const DWORD need = ::GetFullPathNameW(path.c_str(), 0, nullptr, nullptr);
    if (need == 0) return path;
    std::wstring buf(static_cast<size_t>(need), L'\0');
    const DWORD got = ::GetFullPathNameW(path.c_str(), need, buf.data(), nullptr);
    if (got == 0 || got >= need) return path;
    buf.resize(got);
    return buf;
}

/* 错误原因里的"系统错误 N"，读得懂一点总比一个裸数字强（宿主侧没有 try/catch，
   这里是唯一能把"为什么失败"带给用户的地方）。 */
std::string win_err_utf8(DWORD code) {
    return "系统错误 " + std::to_string(code);
}

}  // namespace

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

std::wstring bg_dir() {
    return user_data_dir() + L"\\" + kBase;
}

std::wstring bg_ensure_dir() {
    const std::wstring d = bg_dir();
    if (d.empty()) return d;
    std::error_code ec;
    // recursive:true 的等价物：中间层不存在也一并建出来
    std::filesystem::create_directories(std::filesystem::path(d), ec);
    /* 建不出来**不在这里报错**：这个函数没有 err 出口，而且调用它的导入流程紧接着就要往
       这个目录写文件，那一步会失败并给出可读原因（"复制这张图失败了…"）。
       也就是说失败不会消失，只是往后挪了一格、带着更具体的上下文报出来。 */
    return d;
}

std::wstring bg_current_file() {
    const std::wstring d = bg_dir();
    if (d.empty()) return std::wstring();
    /* 目录不存在时 list_dir 给空表 —— 与 JS 的 existsSync 提前返回等价。
       取"第一个"匹配项：readdir 与 FindFirstFileW 都是按操作系统的目录顺序给的，一致。 */
    for (const std::wstring& name : list_dir(d)) {
        // 前缀判定**区分大小写**（与 JS 的 startsWith 一致）：`Background.png` 不算背景图；
        // 扩展名不区分（path.extname(f).toLowerCase()）。这两条都是照抄。
        if (!wstarts_with(name, L"background.")) continue;
        if (!is_allowed_ext(ext_name_lower(name))) continue;
        return d + L"\\" + name;
    }
    return std::wstring();
}

std::vector<std::string> bg_remove_all(const std::wstring& keep) {
    std::vector<std::string> removed;
    const std::wstring d = bg_dir();
    if (d.empty()) return removed;
    const std::wstring keepAbs = keep.empty() ? std::wstring() : normalize_abs(keep);

    for (const std::wstring& name : list_dir(d)) {
        if (!wstarts_with(name, L"background.")) continue;
        const std::wstring full = d + L"\\" + name;
        /* ⚠️ **必须先判 keep 再删**。导入时新图就写在这个目录、也叫 `background.*`，
           少了这一句，"清空旧的"会把刚拷好的新图一起删掉
           （症状：导入成功但界面没背景 —— 实测踩过）。 */
        if (!keepAbs.empty() && normalize_abs(full) == keepAbs) continue;
        // 删不掉不算致命：同名的那张会被 rename 覆盖，别的名字的顶多留一份多余的
        if (remove_file(full)) removed.push_back(to_utf8(name));
    }
    /* 与 oracle 的一处**刻意**差异：JS 的 unlinkSync 一抛异常就跳出整个循环（那是没有
       try/catch 包住的意外行为），这里改成"记下失败、继续删下一个"。理由是它旁边那条注释
       说的意图——"删不掉不算致命"、目录里只该留一张：一个被占用的旧图不该挡住别的旧图被清掉。
       正常路径（没文件被占用）两边完全一样。 */
    return removed;
}

std::vector<std::string> bg_clear() {
    return bg_remove_all(std::wstring());
}

bool bg_import_from(const std::wstring& srcPath, BgImportResult& out, std::string& err) {
    err.clear();
    // 失败时不留旧值：调用方拿到 false 就不该再读 out（免得把上一次的结果当这一次的）
    out = BgImportResult{};

    if (srcPath.empty()) {
        err = "没有给出图片路径";
        return false;
    }
    const std::string ext = ext_name_lower(srcPath);
    if (!is_allowed_ext(ext)) {
        err = "不支持这种图片格式（" + (ext.empty() ? std::string("没有扩展名") : ext)
            + "）——请用 png / jpg / jpeg / webp";
        return false;
    }
    const FileInfo st = stat_path(srcPath);
    if (!st.exists) {
        err = "读不到这个文件：" + to_utf8(srcPath);
        return false;
    }
    // 目录（以及一切"存在但不是普通文件"的东西，比如设备名）都在这里被挡下
    if (!st.isFile) {
        err = "只能选文件，不能选目录";
        return false;
    }
    // 上限 20MB：一张桌面背景不可能这么大，超了多半是选错了文件
    if (st.size > kMaxBytes) {
        char mb[32] = {};
        (void)::snprintf(mb, sizeof(mb), "%.1f", static_cast<double>(st.size) / 1048576.0);
        err = std::string("这张图太大了（") + mb + " MB）——请用 20MB 以内的图片";
        return false;
    }

    bg_ensure_dir();
    /* ⚠️ 顺序是"**先写、再就位、最后才删旧的**"。三个后果都是实测出来的：
         · 复制那一步失败（源被删/权限/磁盘满）→ 旧图**一个字节都没动**；
         · 用户把**当前这张背景图自己**再选一遍（换图时很容易误点）→ 源和目标是同一个文件，
           这里也不会先把源删掉，所以不再出现"目录被清空"；
         · rename 在同目录内是**原子**的、目标已存在时直接覆盖，所以"同名的那张旧图"是靠
           这一步被替换掉的，不靠先删 —— 改名失败时旧图原封不动。
       最后那步"清旧的"只在换扩展名（png → jpg）时有用，它失败也只是留下一个多余文件。 */
    const std::wstring dest = bg_dir() + L"\\" + kBase + to_wide(ext);
    /* 临时名以 `.tmp` 结尾：ext_name_lower 不是 png/jpg/webp，所以 bg_current_file() 不会把
       它当成背景图报给界面；但它仍然排在 `background.` 前缀下，bg_remove_all() 会顺手清掉
       上次异常退出留下的半截文件。`<pid>` 那一段照抄 process.pid，让并发/重入的临时名不撞车。 */
    const std::wstring tmp =
        dest + L"." + std::to_wstring(::GetCurrentProcessId()) + L".tmp";

    // ① 先写：这一步失败，磁盘上的旧图一个字节都没动
    if (!copy_file(srcPath, tmp)) {
        const DWORD code = ::GetLastError();   // 先取，别让下面的清理把错误码冲掉
        remove_file(tmp);                      // 可能已建出半截文件
        err = "复制这张图失败了（原来那张还在）：" + win_err_utf8(code) + "（"
            + to_utf8(srcPath) + "）";
        return false;
    }
    // ② 改名到位（同目录内原子替换目标）
    if (!rename_over(tmp, dest)) {
        const DWORD code = ::GetLastError();
        /* 这里**不删 tmp**，照抄 oracle：它没有走到第三步就抛了，半截文件留给下一次
           bg_remove_all() 清。旧图此时是完好的（覆盖还没发生）。 */
        err = "把这张图放到配置目录失败了（原来那张还在）：" + win_err_utf8(code)
            + " —— 临时文件会留到下次导入时清掉";
        return false;
    }
    // ③ 清掉换扩展名留下的旧图（以及上次的半截临时文件），保留刚就位的这张
    bg_remove_all(dest);

    out.file = to_utf8(file_name(dest));
    out.abs = dest;
    out.bytes = st.size;
    return true;
}

}  // namespace isg
