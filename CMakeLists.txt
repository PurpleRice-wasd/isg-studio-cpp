cmake_minimum_required(VERSION 3.20)
# C 语言是给 miniz 用的（Phase 2 的 PPTX 解包）。PDFium 是预编译 DLL，不进编译。
project(isg-studio-cpp LANGUAGES C CXX)

# 让 CMAKE_MSVC_RUNTIME_LIBRARY 生效（Policy 0091），Debug 下必须链**调试版 CRT**，
# 否则 _CrtSetDbgFlag / _CRTDBG_LEAK_CHECK_DF 全是空操作。
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

# C++20：宿主侧用 std::string_view / std::optional / std::filesystem。
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if (MSVC)
  # /utf-8 不是可选项：源码里有中文注释与中文字符串常量，缺了它 MSVC 会按系统代码页
  # （这台机器是 936）解，表现是"注释后面的代码被吃掉"或字符串乱码。
  #
  # 注意 /utf-8 == /source-charset:utf-8 + /execution-charset:utf-8，所以**不能再**单独
  # 写 /source-charset:utf-8 —— cl 会以 D8016 报"两个选项不兼容"而拒绝编译。
  add_compile_options(/utf-8 /W4 /permissive- /Zc:__cplusplus /Zc:preprocessor)
  add_compile_definitions(UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

add_subdirectory(src)

# ---------------------------------------------------------------------------
# 生成契约：运行期 prompts.js 从 <exe>/docs/generation-contract.md 读。
# 开发态也要有这一份 —— 否则从 build/dist 直接跑会报"找不到生成契约"。
# 独立仓库里契约在 docs/；原 monorepo 里在 ../isg-studio/docs/（保留回退）。
# ---------------------------------------------------------------------------
set(ISG_CONTRACT_SRC "")
if (EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/docs/generation-contract.md")
  set(ISG_CONTRACT_SRC "${CMAKE_CURRENT_SOURCE_DIR}/docs/generation-contract.md")
elseif (EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../isg-studio/docs/generation-contract.md")
  set(ISG_CONTRACT_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../isg-studio/docs/generation-contract.md")
endif()
if (ISG_CONTRACT_SRC)
  set(ISG_CONTRACT_DST "${CMAKE_BINARY_DIR}/dist/docs/generation-contract.md")
  add_custom_command(
    OUTPUT "${ISG_CONTRACT_DST}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_BINARY_DIR}/dist/docs"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${ISG_CONTRACT_SRC}" "${ISG_CONTRACT_DST}"
    DEPENDS "${ISG_CONTRACT_SRC}"
    COMMENT "把生成契约拷到 dist/docs（运行期从 <exe>/docs 读）")
  add_custom_target(isg-contract ALL DEPENDS "${ISG_CONTRACT_DST}")
  add_dependencies(isg-studio isg-contract)
else()
  message(WARNING "找不到 docs/generation-contract.md：运行期会报缺少生成契约。")
endif()

# ---------------------------------------------------------------------------
# skill 内核：开发态也放到 <exe>/skill，让 skill_dir() 的打包态分支直接命中。
# 独立仓库的 build 目录在仓库根下，原来的 "../../../.." 开发态回退是 monorepo 布局，
# 拷到 dist/skill 之后不依赖那个相对路径；打包脚本也仍会把 skill 放进交付目录。
# ---------------------------------------------------------------------------
set(ISG_SKILL_SRC "${CMAKE_CURRENT_SOURCE_DIR}/skills/interactive-study-guide")
if (EXISTS "${ISG_SKILL_SRC}/SKILL.md")
  file(GLOB_RECURSE ISG_SKILL_FILES CONFIGURE_DEPENDS "${ISG_SKILL_SRC}/*")
  set(ISG_SKILL_DST "${CMAKE_BINARY_DIR}/dist/skill")
  add_custom_command(
    OUTPUT "${ISG_SKILL_DST}/SKILL.md"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${ISG_SKILL_SRC}" "${ISG_SKILL_DST}"
    DEPENDS ${ISG_SKILL_FILES}
    COMMENT "把 skill 内核拷到 dist/skill（exe 从自己旁边读）")
  add_custom_target(isg-skill ALL DEPENDS "${ISG_SKILL_DST}/SKILL.md")
  add_dependencies(isg-studio isg-skill)
else()
  message(WARNING "找不到 skills/interactive-study-guide/SKILL.md：运行期会报没找到 skill。")
endif()
