// 文件与路径：比 win_util 里那几个更"业务一点"的助手（但仍然不做判断，只做动作）。
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace isg {

struct FileInfo {
    bool exists = false;
    bool isFile = false;
    bool isDir = false;
    int64_t size = 0;
    int64_t mtimeMs = 0;
};

FileInfo stat_path(const std::wstring& path);

/* 目录项的名字（不含路径，不递归）。目录不存在返回空表 —— 调用方自己判断"空"的含义。 */
std::vector<std::wstring> list_dir(const std::wstring& dir);

/* 复制文件。成功返回 true。**失败时必须如实返回 false**：
   bg.js 那套"导入失败不能把旧图弄丢"的逻辑全靠它。 */
bool copy_file(const std::wstring& from, const std::wstring& to);

/* 删文件。不存在也算成功（与 Node 的 rmSync({force:true}) 对齐）。 */
bool remove_file(const std::wstring& path);

/* 同目录内改名（原子替换目标）。 */
bool rename_over(const std::wstring& from, const std::wstring& to);

/* 编码成一个 isg:// URL 里的一段（对照 encodeURIComponent 的白名单字符集：
   A-Z a-z 0-9 - _ . ! ~ * ' ( ) 之外一律 %XX）。 */
std::string uri_component_encode(const std::string& utf8);

/* 解码一段 %XX。非法转义**原样保留**（与 oracle 的 try/catch 兜底一致：解不开就留着，
   让后面的白名单去拒，而不是在这里静默丢掉字符）。 */
std::string uri_component_decode(const std::string& s);

bool is_reparse_point(const std::wstring& path);

}  // namespace isg
