#include "json_util.h"

#include "win_util.h"

#include <filesystem>

namespace isg {

bool json_parse(const std::string& text, Json& out, std::string& err) {
    err.clear();
    // 空文本按"没有内容"处理，不算错误：settings.json 被清空过是常见的手改结果。
    if (text.empty()) {
        out = Json::object();
        return true;
    }
    Json parsed = Json::parse(text, nullptr, false);   // false = 不抛，失败返回 discarded
    if (parsed.is_discarded()) {
        err = "不是合法的 JSON";
        return false;
    }
    out = std::move(parsed);
    return true;
}

std::string json_dump(const Json& v, int indent) {
    // ensure_ascii=false：中文原样落盘。true 的话 settings.json / 报告里全是 \uXXXX，
    // 用户（设置页把路径显示给他了，手改很常见）根本没法读。
    return v.dump(indent, ' ', false, Json::error_handler_t::replace);
}

bool json_read_file(const std::wstring& path, Json& out, std::string& err) {
    std::string bytes;
    if (!read_file_bytes(path, bytes)) {
        err = "读不到这个文件";
        return false;
    }
    // 去掉 UTF-8 BOM：用户拿记事本存过的 settings.json 会带 BOM，
    // 而 nlohmann 的解析器见到 BOM 直接判非法 —— 那会让"文件明明是对的"变成读不了。
    if (bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xEF
        && static_cast<unsigned char>(bytes[1]) == 0xBB
        && static_cast<unsigned char>(bytes[2]) == 0xBF) {
        bytes.erase(0, 3);
    }
    return json_parse(bytes, out, err);
}

bool json_write_file_atomic(const std::wstring& path, const Json& v, int indent, std::string& err) {
    err.clear();
    const std::wstring dir = parent_dir(path);
    std::error_code ec;
    std::filesystem::create_directories(std::filesystem::path(dir), ec);
    if (ec) {
        err = "建不了目录：" + to_utf8(dir);
        return false;
    }
    const std::wstring tmp = path + L".tmp";
    if (!write_file_bytes(tmp, json_dump(v, indent))) {
        err = "写不了临时文件：" + to_utf8(tmp);
        return false;
    }
    // 同目录内的改名在 NTFS 上是原子的：目标已存在会被直接覆盖。
    if (!::MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        err = "改名到位失败（错误码 " + std::to_string(::GetLastError()) + "）";
        ::DeleteFileW(tmp.c_str());   // 别留下半截临时文件
        return false;
    }
    return true;
}

}  // namespace isg
