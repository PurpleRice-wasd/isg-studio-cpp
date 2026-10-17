// 生成任务的生命周期与事件广播（Phase 3/4）。
//
// 对应 oracle 的 `src/main/jobs.js`。为什么状态放在 C++ 而不是 JS：
//   · `gen:get` / `gen:list` 必须在页面重载之后仍然能回答（用户切页面、刷新）；
//   · 日志/阶段的广播要走 `job:event` —— 那是宿主 → 页面唯一的推送通道；
//   · 取消要同时中止 WinHTTP 请求（在 C++ 里）。
// 纯逻辑（pipeline / prompts / 校验 / 拼装）仍在页面里的 JS，本层只负责"记账与广播"。
//
// 与 oracle 的形状保持一致的字段：id / sources / mode / filePath / fileName / options /
// status / stages / logs / createdAt / updatedAt / htmlPath / report / error / chapter /
// ask / usage / outputs / chapterNos。界面（run.js / result.js）按这个形状读。
#pragma once

#include "../util/json_util.h"

#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace isg {

class JobStore {
public:
    using EmitterFn = std::function<void(const Json&)>;         // job:event 的 payload
    using AskReply = std::function<void(const Json&)>;          // { ok:true, data:value }

    JobStore() = default;
    ~JobStore();
    JobStore(const JobStore&) = delete;
    JobStore& operator=(const JobStore&) = delete;

    void SetEmitter(EmitterFn e);

    /* gen:start。input 是页面传来的对象。失败时 err 为人话。 */
    bool Create(const Json& input, Json& out, std::string& err);

    /* forPipeline=true：**不**做界面瘦身（保留 options.editedPages 等大字段）。
       `_pipeline:jobInfo/jobPart` 必须走这一条 —— 否则用户在抽取预览里改过的正文
       会在到达流水线之前就被 `Get()` 剥掉，而且 finish 时还会把宿主那份一起抹掉。 */
    Json Get(const std::string& id, bool forPipeline = false);
    /* 分块读取用：同一任务的 jobInfo 与 jobPart 必须来自**同一份**文本。 */
    std::string SnapshotText(const std::string& id);
    Json List();

    /* gen:cancel。返回 false = 任务不存在或已经结束。 */
    bool Cancel(const std::string& id, const Json& opts);

    /* gen:answer。返回 false = 问题已过期 / 值不在选项里。 */
    bool Answer(const Json& arg);

    /* 页面里的 jobs 垫片发来的消息（kind='pipeline'）。 */
    void HandlePageMessage(const Json& msg);

    /* `_pipeline:ask`：把一个待答问题挂上；用户回答时通过 reply 送回页面。 */
    bool OpenAsk(const std::string& jobId, const Json& ask, AskReply reply);

    /* 输出路径校验（Bridge 用它决定要不要 protocol_allow）。
       path 必须落在任务的输出目录之内。 */
    bool ValidateOutputPath(const std::string& jobId, const std::string& path, std::wstring& abs);

    /* 关窗：把未决问题按默认值收掉，避免页面侧留下永不回应的 Promise。 */
    void Shutdown();

    /* Phase 6：「带上一章」要按 id 找回历史里的 htmlPath（内存任务优先，其次 history.json）。
       找不到返回 null。 */
    Json FindEntry(const std::string& id);

    /* 给任务补一条日志（宿主侧发现的问题，例如"带上的章要注意"）。 */
    void AddLog(const std::string& id, const std::string& level, const std::string& message);

private:
    struct Private {
        std::wstring outDir;                      // 绝对路径（小写比较用）
        bool abortRequested = false;
        std::string cancelPolicy;
        Json ask;                                 // 待答问题（公开形态）
        std::string askId;
        Json askDefault;
        AskReply askReply;
        std::string writeError;
        std::map<std::string, std::string> writeBuffers;
        std::map<std::string, int64_t> writeChunks;       // 期望块数
        std::map<std::string, int64_t> writeChunksSeen;
        std::string snapshotText;                        // jobInfo/jobPart 的同一份文本
        bool snapshotValid = false;
    };

    Json& job(const std::string& id);
    void EmitPayload(const Json& payload);
    void EmitUnlocked(const Json& payload);
    void Log(Json& j, const std::string& level, const std::string& message);
    void SaveHistory();
    void SaveHistoryLocked();
    Json Snapshot(const Json& j) const;
    void EvictOld();
    void SettleAsk(const std::string& jobId, Json& j, Private& p, const Json& value,
                   const std::string& why);
    bool ValidateOutputPathLocked(const std::string& jobId, const std::string& path, std::wstring& abs);
    void HandleWrite(const Json& msg, const std::string& op);

    std::mutex mu_;
    EmitterFn emitter_;
    Json jobs_ = Json::object();                  // id -> job
    std::map<std::string, Private> priv_;
    int seq_ = 0;
};

}  // namespace isg
