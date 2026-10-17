#include "channels.h"

#include <cstring>

namespace isg {

const char* const kChannels[] = {
    "app:info",
    "app:openPath",
    "app:openExternal",
    "app:revealPath",
    "app:previewUrl",
    "app:registerPath",
    "app:takePendingFile",
    "dialog:pickFile",
    "dialog:pickOutputDir",
    "dialog:pickImage",
    "bg:info",
    "bg:import",
    "bg:clear",
    "settings:get",
    "settings:save",
    "settings:test",
    "settings:export",
    "settings:import",
    "gen:start",
    "gen:cancel",
    "gen:answer",
    "gen:get",
    "gen:list",
    "run:scanCleanup",
    "run:doCleanup",
    "book:list",
    "book:pickFile",
    "book:inspect",
    "book:continuity",
    "extract:preview",
    "verify:run",
};

/* 这张 static_assert 是本文件存在的意义之一：**条数写死在这里**。
   没有它的话，往表里加一条通道、忘了改 kChannelCount，判据就会拿旧数字去比，
   而那正是"判据看起来在管、其实没管"的经典形态。 */
static_assert(sizeof(kChannels) / sizeof(kChannels[0]) == kChannelCount,
              "kChannels 的条数与 kChannelCount 不一致 —— 要么补上通道，要么改 kChannelCount（并同步 preload.js）");

const char* const kEventJobEvent = "job:event";

bool is_known_channel(const std::string& name) {
    for (const char* c : kChannels) {
        if (name == c) return true;
    }
    return false;
}

}  // namespace isg
