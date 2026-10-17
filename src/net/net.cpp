#include "net.h"

#include "../settings/store.h"
#include "../util/base64.h"
#include "../util/file_ops.h"
#include "../util/log.h"
#include "../util/str_util.h"
#include "../util/win_util.h"

#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <cctype>
#include <string>
#include <system_error>
#include <vector>

namespace isg {

namespace {

constexpr char kSentinel[] = "__ISG_HOST_KEY__";

std::string lower_ascii(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    return s;
}

/* URL 的 origin（scheme://host[:port]），小写。失败返回空串。 */
std::string origin_of(const std::string& url) {
    const std::string lower = lower_ascii(url);
    const size_t p = lower.find("://");
    if (p == std::string::npos) return std::string();
    const size_t start = p + 3;
    size_t end = lower.find_first_of("/?#", start);
    if (end == std::string::npos) end = lower.size();
    return lower.substr(0, end);
}

std::string replace_query_key(const std::string& url, const std::string& key) {
    const size_t q = url.find('?');
    const std::string base = (q == std::string::npos) ? url : url.substr(0, q);
    const std::string query = (q == std::string::npos) ? std::string() : url.substr(q + 1);
    std::vector<std::string> parts;
    size_t i = 0;
    while (i <= query.size()) {
        const size_t amp = query.find('&', i);
        const std::string part = query.substr(i, amp == std::string::npos ? std::string::npos : amp - i);
        if (!part.empty()) parts.push_back(part);
        if (amp == std::string::npos) break;
        i = amp + 1;
    }
    bool replaced = false;
    for (std::string& part : parts) {
        if (starts_with(lower_ascii(part), "key=")) {
            if (!key.empty()) part = "key=" + uri_component_encode(key);
            else part.clear();
            replaced = true;
        }
    }
    if (!replaced && !key.empty()) parts.push_back("key=" + uri_component_encode(key));
    std::string out = base;
    bool first = true;
    for (const std::string& part : parts) {
        if (part.empty()) continue;
        out += first ? "?" : "&";
        out += part;
        first = false;
    }
    return out;
}

bool header_has(const Json& headers, const std::string& name) {
    if (!headers.is_object()) return false;
    const std::string want = lower_ascii(name);
    for (auto it = headers.begin(); it != headers.end(); ++it) {
        if (lower_ascii(it.key()) == want) return true;
    }
    return false;
}

void header_set(Json& headers, const std::string& name, const std::string& value) {
    if (!headers.is_object()) headers = Json::object();
    for (auto it = headers.begin(); it != headers.end();) {
        if (lower_ascii(it.key()) == lower_ascii(name)) it = headers.erase(it);
        else ++it;
    }
    headers[name] = value;
}

bool host_is_anthropic_official(const std::string& origin) {
    const std::string lower = lower_ascii(origin);
    return lower.find("://anthropic.com") != std::string::npos
        || lower.find(".anthropic.com") != std::string::npos;
}

/* 与 oracle 的 `isLocalBase` 同一组主机。设置里允许把 Base URL 写成
   `127.0.0.1:11434`（不带协议）—— JS 侧的 normalizeBase 会补 http://，
   宿主做 origin 比较时也要按同一个规则补，否则会把合法请求判成 EBADURL。 */
std::string origin_of_base(std::string base) {
    base = trim(base);
    if (base.find("://") == std::string::npos) {
        const std::string lower = lower_ascii(base);
        const bool local = starts_with(lower, "localhost") || starts_with(lower, "127.0.0.1")
                        || starts_with(lower, "0.0.0.0") || starts_with(lower, "[::1]")
                        || starts_with(lower, "host.docker.internal");
        base = (local ? "http://" : "https://") + base;
    }
    return origin_of(base);
}

/* 把请求发给页面。Sender 已经保证线程安全。 */
std::string error_message(DWORD code) {
    return std::system_category().message(static_cast<int>(code));
}

}  // namespace

NetManager::~NetManager() { Shutdown(); }

void NetManager::SetSender(Sender s) {
    std::lock_guard<std::mutex> lk(mu_);
    sender_ = std::move(s);
}

void NetManager::Send(const Json& msg) {
    Sender s;
    {
        std::lock_guard<std::mutex> lk(mu_);
        s = sender_;
    }
    if (s) s(msg);
}

void NetManager::PostError(const std::shared_ptr<Req>& req, const std::string& code,
                           const std::string& message) {
    Json m = Json::object();
    m["__isg"] = 1;
    m["kind"] = "http-error";
    m["id"] = req->id;
    m["code"] = code;
    m["message"] = message;
    Send(m);
}

void NetManager::Reap() {
    for (auto it = workers_.begin(); it != workers_.end();) {
        if (it->done && it->done->load()) {
            if (it->thread.joinable()) it->thread.join();
            it = workers_.erase(it);
        } else {
            ++it;
        }
    }
}

void NetManager::Start(const Json& msg) {
    const int id = msg.contains("id") && msg["id"].is_number() ? msg["id"].get<int>() : 0;
    if (id <= 0) return;

    const std::string jobId = msg.contains("jobId") && msg["jobId"].is_string()
                                  ? msg["jobId"].get<std::string>() : std::string();
    std::string url = msg.contains("url") && msg["url"].is_string()
                          ? msg["url"].get<std::string>() : std::string();
    std::string method = msg.contains("method") && msg["method"].is_string()
                             ? msg["method"].get<std::string>() : std::string("GET");
    Json headers = msg.contains("headers") && msg["headers"].is_object()
                       ? msg["headers"] : Json::object();
    std::string body = msg.contains("body") && msg["body"].is_string()
                           ? msg["body"].get<std::string>() : std::string();
    const std::string providerId = msg.contains("providerId") && msg["providerId"].is_string()
                                       ? msg["providerId"].get<std::string>() : std::string();

    auto req = std::make_shared<Req>();
    req->id = id;
    req->jobId = jobId;

    /* 只允许 http/https，而且只允许发往**当前配置的提供商**。
       这不是多余的：渲染进程同时承载模型产出的页面，把"任意 URL + 自动附带 Key"
       暴露出去等于一个 SSRF/Key 外带的口子。 */
    const std::string lowerUrl = lower_ascii(url);
    if (!starts_with(lowerUrl, "http://") && !starts_with(lowerUrl, "https://")) {
        PostError(req, "EBADURL", "只支持 http/https");
        return;
    }
    Json provider;
    std::string perr;
    if (providerId.empty() || !provider_config(providerId, provider, perr)) {
        PostError(req, "ENO_PROVIDER", providerId.empty() ? "请求没有关联到任何提供商" : perr);
        return;
    }
    const std::string baseUrl = provider.contains("baseUrl") && provider["baseUrl"].is_string()
                                    ? provider["baseUrl"].get<std::string>() : std::string();
    if (origin_of(url) != origin_of_base(baseUrl)) {
        PostError(req, "EBADURL", "请求地址与提供商配置的域名不一致，已拒绝（防止把 Key 发到别处）");
        return;
    }

    /* ---- 注入真正的 Key（页面拿到的只是哨兵） ---- */
    const std::string apiKey = provider.contains("apiKey") && provider["apiKey"].is_string()
                                   ? provider["apiKey"].get<std::string>() : std::string();
    const std::string authField = provider.contains("authField") && provider["authField"].is_string()
                                      ? provider["authField"].get<std::string>() : std::string();
    std::string format = provider.contains("format") && provider["format"].is_string()
                             ? provider["format"].get<std::string>() : std::string("openai");

    /* 页面的适配器用哨兵拼过头（Bearer __ISG_HOST_KEY__ / x-api-key: … / ?key=…）。
       先把这些值清掉，再按真实配置补上。 */
    if (headers.is_object()) {
        for (auto it = headers.begin(); it != headers.end();) {
            if (it.value().is_string() && it.value().get<std::string>().find(kSentinel) != std::string::npos) {
                it = headers.erase(it);
            } else {
                ++it;
            }
        }
    }
    /* 回给页面的 URL 必须是**注入真 Key 之前**的那一份。
       `authField:'query'` 时真 Key 就在查询串里；把它塞进 `http-head.url` 等于
       把 Key 送进渲染进程（llm 层的 scrubber 只认识哨兵，洗不掉真 Key）。 */
    const std::string pageUrl = url;
    if (authField == "query") {
        url = replace_query_key(url, apiKey);
    } else if (!apiKey.empty()) {
        /* 协议以**请求头**为准也能认出来：页面里的适配器可能是 anthropic，
           而设置里的 provider.format 是 openai（测试/自定义网关会这样）。
           `anthropic-version` 是 Anthropic 协议必带的头，比猜 format 可靠。 */
        const bool isAnthropic = (format == "anthropic") || header_has(headers, "anthropic-version");
        if (isAnthropic) {
            if (authField == "auth_header") {
                if (!header_has(headers, "Authorization")) header_set(headers, "Authorization", "Bearer " + apiKey);
            } else if (authField == "api_key_header") {
                if (!header_has(headers, "x-api-key")) header_set(headers, "x-api-key", apiKey);
            } else if (host_is_anthropic_official(origin_of(url))) {
                if (!header_has(headers, "x-api-key")) header_set(headers, "x-api-key", apiKey);
            } else {
                if (!header_has(headers, "x-api-key")) header_set(headers, "x-api-key", apiKey);
                if (!header_has(headers, "Authorization")) header_set(headers, "Authorization", "Bearer " + apiKey);
            }
        } else if (authField == "api_key_header") {
            /* OpenAI 兼容网关里也有一部分只认 `api-key`（页面侧 openai.js 发的就是它）。
               以前这里只有 Authorization 一条路，这类网关会 401。 */
            if (!header_has(headers, "api-key")) header_set(headers, "api-key", apiKey);
        } else if (!header_has(headers, "Authorization")) {
            header_set(headers, "Authorization", "Bearer " + apiKey);
        }
    }

    /* 序列化 headers（跳过 Host/Content-Length，交给 WinHTTP） */
    std::string headerText;
    if (headers.is_object()) {
        for (auto it = headers.begin(); it != headers.end(); ++it) {
            if (!it.value().is_string()) continue;
            const std::string k = it.key();
            const std::string lk = lower_ascii(k);
            if (lk == "host" || lk == "content-length" || lk == "connection") continue;
            headerText += k + ": " + it.value().get<std::string>() + "\r\n";
        }
    }

    auto done = std::make_shared<std::atomic<bool>>(false);
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (shuttingDown_) {
            // 不能在这里调 PostError（它要再拿一次 mu_ → 自锁）
            Json m = Json::object();
            m["__isg"] = 1;
            m["kind"] = "http-error";
            m["id"] = req->id;
            m["code"] = "EABORTED";
            m["message"] = "程序正在退出";
            if (sender_) sender_(m);
            return;
        }
        Reap();
        live_.push_back(req);
        workers_.push_back(Worker{
            std::thread([this, req, url, pageUrl, method, headerText, body, done]() {
                auto finish = [&]() {
                    {
                        std::lock_guard<std::mutex> lk(mu_);
                        for (auto it = live_.begin(); it != live_.end(); ++it) {
                            if (*it == req) { live_.erase(it); break; }
                        }
                    }
                    done->store(true);
                };

                /* 线程入口必须自己兜住所有异常：异常逃出 std::thread = std::terminate，
                   收尾路径全部跳过，而这里正是"长跑 + 分配大缓冲"的地方。 */
                try {
                const std::wstring wurl = to_wide(url);
                URL_COMPONENTS uc{};
                uc.dwStructSize = sizeof(uc);
                uc.dwSchemeLength = static_cast<DWORD>(-1);
                uc.dwHostNameLength = static_cast<DWORD>(-1);
                uc.dwUrlPathLength = static_cast<DWORD>(-1);
                uc.dwExtraInfoLength = static_cast<DWORD>(-1);
                if (!::WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) {
                    PostError(req, "EBADURL", "WinHTTP 解析不了这个 URL");
                    finish();
                    return;
                }
                const bool secure = uc.nScheme == INTERNET_SCHEME_HTTPS;
                std::wstring host(uc.lpszHostName, uc.dwHostNameLength);
                std::wstring path(uc.lpszUrlPath, uc.dwUrlPathLength);
                if (uc.lpszExtraInfo != nullptr && uc.dwExtraInfoLength > 0) {
                    path.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
                }

                auto close_handle = [](HINTERNET h) { if (h) ::WinHttpCloseHandle(h); };
                using Handle = std::unique_ptr<void, decltype(close_handle)>;
                /* 版本号来自 CMake 的 ISG_APP_VERSION（工程根 VERSION 是单一真源），
                   不要在源码里再写死一份。 */
                Handle session(::WinHttpOpen(L"isg-studio/" L"" ISG_APP_VERSION,
                                             WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0),
                               close_handle);
                if (!session) {
                    session.reset(::WinHttpOpen(L"isg-studio/" L"" ISG_APP_VERSION,
                                                WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
                }
                if (!session) {
                    PostError(req, "ENETWORK", "WinHttpOpen 失败（" + error_message(::GetLastError()) + "）");
                    finish();
                    return;
                }
                /* 与 oracle 的 180s 默认超时对齐（页面的 AbortSignal.timeout 仍可更早取消）。
                   以前接收超时是 60s：推理型模型一次长时间静默就会被宿主判成 ETIMEDOUT，
                   而页面传更大的 timeoutMs 也没用。 */
                ::WinHttpSetTimeouts(session.get(), 30000, 30000, 60000, 180000);

                Handle connect(::WinHttpConnect(session.get(), host.c_str(), uc.nPort, 0), close_handle);
                if (!connect) {
                    PostError(req, "ENETWORK", "WinHttpConnect 失败（" + error_message(::GetLastError()) + "）");
                    finish();
                    return;
                }
                const std::wstring wmethod = to_wide(method);
                HINTERNET raw = ::WinHttpOpenRequest(connect.get(), wmethod.c_str(), path.c_str(),
                                                     nullptr, WINHTTP_NO_REFERER,
                                                     WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                     secure ? WINHTTP_FLAG_SECURE : 0);
                if (raw == nullptr) {
                    PostError(req, "ENETWORK", "WinHttpOpenRequest 失败（" + error_message(::GetLastError()) + "）");
                    finish();
                    return;
                }
                {
                    std::lock_guard<std::mutex> lk(req->mu);
                    if (!req->reqClosed) req->request = raw;
                }
                auto close_req = [&]() {
                    std::lock_guard<std::mutex> lk(req->mu);
                    if (req->request != nullptr && !req->reqClosed) {
                        req->reqClosed = true;
                        ::WinHttpCloseHandle(req->request);
                    }
                    req->request = nullptr;
                };

                /* 对齐 fetch 的 `redirect:'follow'`（http→https、区域化端点很常见）。
                   ⚠️ 这里信任的是**用户自己配置的提供商**：一个恶意提供商用 3xx 把请求
                   引到别处，本来也能直接记下 Key。真要做同源重定向校验，需要
                   WinHttpSetStatusCallback 在重定向事件里比 origin —— 留给后续阶段。 */
                DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
                ::WinHttpSetOption(raw, WINHTTP_OPTION_REDIRECT_POLICY,
                                   &redirectPolicy, sizeof(redirectPolicy));
                const std::wstring whdr = to_wide(headerText);
                if (!headerText.empty()) {
                    ::WinHttpAddRequestHeaders(raw, whdr.c_str(), static_cast<DWORD>(-1),
                                               WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE);
                }
                BOOL sent = ::WinHttpSendRequest(
                    raw, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                    body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
                    static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()), 0);
                if (!sent) {
                    const bool aborted = req->aborted.load();
                    close_req();
                    if (aborted) PostError(req, "EABORTED", "请求已取消");
                    else PostError(req, "ENETWORK", "WinHttpSendRequest 失败（" + error_message(::GetLastError()) + "）");
                    finish();
                    return;
                }
                if (!::WinHttpReceiveResponse(raw, nullptr)) {
                    const bool aborted = req->aborted.load();
                    close_req();
                    if (aborted) PostError(req, "EABORTED", "请求已取消");
                    else PostError(req, "ENETWORK", "WinHttpReceiveResponse 失败（" + error_message(::GetLastError()) + "）");
                    finish();
                    return;
                }

                DWORD status = 0;
                DWORD len = sizeof(status);
                ::WinHttpQueryHeaders(raw, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                      WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);

                Json headHeaders = Json::object();
                DWORD hlen = 0;
                ::WinHttpQueryHeaders(raw, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                                      WINHTTP_NO_OUTPUT_BUFFER, &hlen, WINHTTP_NO_HEADER_INDEX);
                if (::GetLastError() == ERROR_INSUFFICIENT_BUFFER && hlen > 0) {
                    std::wstring rawHeaders(hlen / sizeof(wchar_t), L'\0');
                    if (::WinHttpQueryHeaders(raw, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                                              &rawHeaders[0], &hlen, WINHTTP_NO_HEADER_INDEX)) {
                        const std::string all = to_utf8(rawHeaders);
                        size_t pos = 0;
                        bool first = true;
                        while (pos < all.size()) {
                            size_t eol = all.find("\r\n", pos);
                            if (eol == std::string::npos) eol = all.size();
                            const std::string line = all.substr(pos, eol - pos);
                            pos = eol + 2;
                            if (first) { first = false; continue; }   // HTTP/1.1 200 OK
                            const size_t colon = line.find(':');
                            if (colon == std::string::npos) continue;
                            std::string name = line.substr(0, colon);
                            std::string value = line.substr(colon + 1);
                            while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) value.erase(value.begin());
                            if (name.empty()) continue;
                            const std::string lname = lower_ascii(name);
                            if (headHeaders.contains(lname) && headHeaders[lname].is_string()) {
                                headHeaders[lname] = headHeaders[lname].get<std::string>() + ", " + value;
                            } else {
                                headHeaders[lname] = value;
                            }
                        }
                    }
                }

                Json head = Json::object();
                head["__isg"] = 1;
                head["kind"] = "http-head";
                head["id"] = req->id;
                head["status"] = status;
                head["headers"] = std::move(headHeaders);
                head["url"] = pageUrl;
                Send(head);

                std::vector<char> buf(16 * 1024);
                for (;;) {
                    if (req->aborted.load()) {
                        close_req();
                        PostError(req, "EABORTED", "请求已取消");
                        finish();
                        return;
                    }
                    DWORD read = 0;
                    if (!::WinHttpReadData(raw, buf.data(), static_cast<DWORD>(buf.size()), &read)) {
                        const bool aborted = req->aborted.load();
                        const DWORD e = ::GetLastError();
                        close_req();
                        if (aborted) PostError(req, "EABORTED", "请求已取消");
                        else if (e == ERROR_WINHTTP_TIMEOUT) PostError(req, "ETIMEDOUT", "接收超时");
                        else PostError(req, "ENETWORK", "WinHttpReadData 失败（" + error_message(e) + "）");
                        finish();
                        return;
                    }
                    if (read == 0) break;
                    Json chunk = Json::object();
                    chunk["__isg"] = 1;
                    chunk["kind"] = "http-chunk";
                    chunk["id"] = req->id;
                    chunk["data"] = base64_encode(std::string(buf.data(), read));
                    Send(chunk);
                }

                close_req();
                Json end = Json::object();
                end["__isg"] = 1;
                end["kind"] = "http-end";
                end["id"] = req->id;
                Send(end);
                finish();
                } catch (const std::exception& e) {
                    PostError(req, "ENETWORK", std::string("网络线程异常：") + e.what());
                    finish();
                } catch (...) {
                    PostError(req, "ENETWORK", "网络线程发生未知异常");
                    finish();
                }
            }),
            done});
    }
}

void NetManager::Abort(int id) {
    std::vector<std::shared_ptr<Req>> hit;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& r : live_) {
            if (r && r->id == id) hit.push_back(r);
        }
    }
    for (const auto& r : hit) {
        r->aborted.store(true);
        std::lock_guard<std::mutex> lk(r->mu);
        if (r->request != nullptr && !r->reqClosed) {
            r->reqClosed = true;
            ::WinHttpCloseHandle(static_cast<HINTERNET>(r->request));
            r->request = nullptr;
        }
    }
}

void NetManager::AbortJob(const std::string& jobId) {
    std::vector<std::shared_ptr<Req>> hit;
    {
        std::lock_guard<std::mutex> lk(mu_);
        for (const auto& r : live_) {
            if (r && !jobId.empty() && r->jobId == jobId) hit.push_back(r);
        }
    }
    for (const auto& r : hit) {
        r->aborted.store(true);
        std::lock_guard<std::mutex> lk(r->mu);
        if (r->request != nullptr && !r->reqClosed) {
            r->reqClosed = true;
            ::WinHttpCloseHandle(static_cast<HINTERNET>(r->request));
            r->request = nullptr;
        }
    }
}

void NetManager::Shutdown() {
    std::vector<std::shared_ptr<Req>> live;
    std::vector<Worker> workers;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (shuttingDown_ && workers_.empty()) return;
        shuttingDown_ = true;
        live.swap(live_);
        workers.swap(workers_);
    }
    for (const auto& r : live) {
        r->aborted.store(true);
        std::lock_guard<std::mutex> lk(r->mu);
        if (r->request != nullptr && !r->reqClosed) {
            r->reqClosed = true;
            ::WinHttpCloseHandle(static_cast<HINTERNET>(r->request));
            r->request = nullptr;
        }
    }
    for (auto& w : workers) {
        if (w.thread.joinable()) w.thread.join();
    }
}

}  // namespace isg
