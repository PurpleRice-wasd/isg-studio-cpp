// 网络传输层（Phase 3）。
//
// 分工是纲领 §6 定下的那一条：
//   **SSE 分帧 / 重试 / 退避 / 400 参数降级 / 打码** 全部仍在 oracle 的 `llm/index.js` 里
//   （原样复制的 `web/logic/llm-index.js`）；C++ 只做 `fetch` 的字节搬运 ——
//   WinHTTP 建连、发请求、把响应体原样按块送回页面。
//
// 为什么这样分而不是在 C++ 里重写 SSE：
//   · `llm/index.js` 的 SSE 状态机注释里记着**三个真实回归 bug**（`data: 0` 保活行吞流、
//     标量误清 pending、1MB 雪球）。逐行翻译成 C++ 是最容易翻车、收益最低的活。
//   · API Key 仍然只在特权层：页面拿到的是 `providerConfig` 的**哨兵值**
//     （`__ISG_HOST_KEY__`），真正的 Key 在本层发出前替换。
//
// 线程模型：
//   Start() 在 UI 线程被调用；每个请求一个工作线程。工作线程**绝不**直接碰 WebView2，
//   只通过 Sender（由 AppWindow 接到 Bridge 的线程安全投递）把消息排回 UI 线程。
#pragma once

#include "../util/json_util.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace isg {

class NetManager {
public:
    /* 线程安全：可以从工作线程调用（Bridge 会把它排到 UI 线程再发）。 */
    using Sender = std::function<void(const Json&)>;

    NetManager() = default;
    ~NetManager();
    NetManager(const NetManager&) = delete;
    NetManager& operator=(const NetManager&) = delete;

    void SetSender(Sender s);

    /* kind='http-fetch' 的消息：{ id, jobId, providerId, url, method, headers, body }。
       **在 UI 线程调用**（要读设置里的 Key）。 */
    void Start(const Json& msg);

    /* kind='http-abort'：{ id }。任意线程可调。 */
    void Abort(int id);
    void AbortJob(const std::string& jobId);

    /* 关窗时调用：先取消所有在途请求，再 join 所有工作线程。
       **必须在 Bridge::Detach 之前**（工作线程还在往页面投消息）。 */
    void Shutdown();

private:
    struct Req {
        int id = 0;
        std::string jobId;
        std::atomic<bool> aborted{false};
        std::mutex mu;
        void* request = nullptr;     // HINTERNET，但这里不 include windows.h
        bool reqClosed = false;
    };
    struct Worker {
        std::thread thread;
        std::shared_ptr<std::atomic<bool>> done;
    };

    void Reap();
    void Send(const Json& msg);
    void PostError(const std::shared_ptr<Req>& req, const std::string& code, const std::string& message);

    std::mutex mu_;
    Sender sender_;
    std::vector<Worker> workers_;
    std::vector<std::shared_ptr<Req>> live_;
    bool shuttingDown_ = false;
};

}  // namespace isg
