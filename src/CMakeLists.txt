# isg-studio（C++ 宿主）—— Phase 1 起的正式工程。
#
# 分层（纲领 §3.6）：app / shell / bridge / settings / util / selftest。
# 依赖方向是单向的：util ← app ← settings ← shell/bridge ← selftest ← main。
# **不许反向依赖**（settings 不许碰 WebView2、util 不许做业务判断）——
# 这条现在只是纪律，Phase 4 把纯逻辑 JS 搬进 Worker 之后它就是可测性的前提。

# 用相对本文件的路径定位依赖，**不要用 CMAKE_SOURCE_DIR**（理由见 spike/CMakeLists.txt）
get_filename_component(ISG_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(WV2_DIR "${ISG_ROOT}/third_party/webview2/build/native")
if (NOT EXISTS "${WV2_DIR}/include/WebView2.h")
  message(FATAL_ERROR
    "缺少 WebView2 SDK 头文件：${WV2_DIR}/include/WebView2.h\n"
    "先跑 tools/fetch-deps.ps1 把依赖取下来。")
endif()
if (NOT EXISTS "${ISG_ROOT}/third_party/nlohmann/json.hpp")
  message(FATAL_ERROR
    "缺少 nlohmann/json：${ISG_ROOT}/third_party/nlohmann/json.hpp\n"
    "先跑 tools/fetch-deps.ps1 把依赖取下来。")
endif()

# 预设表是生成物（tools/gen-providers.py）。缺了就直接报错，别让编译在一个
# "文件不存在"上打转 —— 报错要指向生成步骤。
if (NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/settings/providers_data.generated.cpp")
  message(FATAL_ERROR
    "缺少提供商预设表的生成物：src/settings/providers_data.generated.cpp\n"
    "跑 `python tools/gen-providers.py --write` 生成它（单一真源是 "
    "apps/isg-studio/src/main/providers.js）。")
endif()

# Phase 2 的抽取依赖。两个都在 tools/fetch-deps.ps1 里取，缺了就 FATAL，
# 报错必须指向"去跑取依赖的脚本"，而不是让编译在一堆缺头文件里打转。
set(PDFIUM_DIR "${ISG_ROOT}/third_party/pdfium")
if (NOT EXISTS "${PDFIUM_DIR}/include/fpdfview.h")
  message(FATAL_ERROR
    "缺少 PDFium：${PDFIUM_DIR}/include/fpdfview.h\n"
    "先跑 `powershell -File tools/fetch-deps.ps1` 把依赖取下来。")
endif()
if (NOT EXISTS "${PDFIUM_DIR}/lib/pdfium.dll.lib")
  message(FATAL_ERROR "缺少 PDFium 导入库：${PDFIUM_DIR}/lib/pdfium.dll.lib")
endif()
set(MINIZ_DIR "${ISG_ROOT}/third_party/miniz")
if (NOT EXISTS "${MINIZ_DIR}/miniz.c")
  message(FATAL_ERROR
    "缺少 miniz：${MINIZ_DIR}/miniz.c\n"
    "先跑 `powershell -File tools/fetch-deps.ps1` 把依赖取下来。")
endif()

# miniz 是第三方 C 代码，/W4 下会有一堆告警。单独成一个静态库并 /w，
# 让"自有代码在 /W4 下零告警"这条判据不被第三方噪声污染。
add_library(isg_miniz STATIC
  "${MINIZ_DIR}/miniz.c"
  "${MINIZ_DIR}/miniz_tdef.c"
  "${MINIZ_DIR}/miniz_tinfl.c"
  "${MINIZ_DIR}/miniz_zip.c"
)
target_include_directories(isg_miniz PUBLIC "${MINIZ_DIR}")
if (MSVC)
  # 显式再写一次 /W4：与全局的 /W4 相同，不会触发 D9025（"覆盖了之前的 /W4"）。
  # 实测 miniz 在 /W4 下没有告警。
  target_compile_options(isg_miniz PRIVATE /W4)
endif()

# .rc 里用相对文件名引用 manifest；rc.exe 只从当前目录与 /I 里找它。
# 不补这个 /I，res 目录在构建目录下时就会报 "cannot open file"。
if (MSVC)
  string(APPEND CMAKE_RC_FLAGS " /I\"${CMAKE_CURRENT_SOURCE_DIR}/app\"")
endif()

add_executable(isg-studio WIN32
  main.cpp

  # exe 的清单（PerMonitorV2 DPI 感知）与版本信息。
  # 这两样在自动判据里看不出差别，但用户双击时看得见：不声明 DPI 感知，
  # Windows 会把 200% 缩放下的整个窗口位图拉伸（界面发虚）。
  app/isg-studio.rc

  # util：不含 WebView2、不做业务判断
  util/win_util.cpp
  util/str_util.cpp
  util/file_ops.cpp
  util/base64.cpp
  util/json_util.cpp
  util/log.cpp
  util/hash.cpp

  # app：路径、版本、单实例、待打开的文件
  app/app.cpp
  app/single_instance.cpp
  app/pending.cpp

  # settings：配置与密钥（Key 只在特权层，绝不进渲染进程）
  settings/providers.cpp
  settings/providers_data.generated.cpp
  settings/dpapi.cpp
  settings/oscrypt.cpp
  settings/env.cpp
  settings/store.cpp
  settings/bg.cpp

  # shell：窗口、webview 宿主、本地协议、系统对话框
  shell/protocol.cpp
  shell/dialogs.cpp
  shell/shell_ops.cpp
  shell/style.cpp
  shell/app_window.cpp

  # extract：课件抽取（PDFium / miniz / 纯文本）
  extract/extract.cpp
  extract/text.cpp
  extract/pptx.cpp
  extract/pdf.cpp

  # net：WinHTTP 字节搬运（SSE 分帧/重试仍在页面里的 oracle llm/index.js）
  net/net.cpp

  # pipeline：任务生命周期与 job:event 广播（纯逻辑仍在页面的 logic-bundle.js）
  pipeline/jobs.cpp
  pipeline/cleanup.cpp

  # book：旁挂结构化数据的读半身（写半身在页面里跑 oracle 的 book.js）
  book/book.cpp

  # verify：Phase 5 的探针窗口驱动（解析口径在 web/logic/probe-parse.js）
  verify/probe_runner.cpp

  # bridge：window.isg 的唯一入口（31 个 invoke 通道 + job:event 订阅）
  bridge/channels.cpp
  bridge/bridge.cpp

  # selftest：四套等价自测 + 桥 & 协议自测
  selftest/selftest.cpp
  selftest/ui_script.cpp
)

target_include_directories(isg-studio PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}"
)

# 第三方头文件目录标成 **SYSTEM**：它们的告警不该混进"我们的代码零告警"这条判据里
# （WebView2 SDK 的头在 /W4 下会报 C4458 之类的参数遮蔽）。
# 标成 SYSTEM 之后 MSVC 用 /external:I 处理，告警与我们自己的代码分开 ——
# 而不是靠 `#pragma warning(push/disable)` 到处贴膏药。
target_include_directories(isg-studio SYSTEM PRIVATE
  "${WV2_DIR}/include"
  "${ISG_ROOT}/third_party"
  "${PDFIUM_DIR}/include"
)

# 清单已经由 app/isg-studio.rc 作为资源 #1 嵌入；再让链接器自动生成一份
# 会撞成重复资源（LNK1327 / manifest 工具失败）。
if (MSVC)
  target_link_options(isg-studio PRIVATE "/MANIFEST:NO")
endif()

target_link_libraries(isg-studio PRIVATE
  "${WV2_DIR}/x64/WebView2LoaderStatic.lib"
  isg_miniz
  "${PDFIUM_DIR}/lib/pdfium.dll.lib"
  shlwapi.lib        # SHCreateMemStream：内存当响应体
  ole32.lib          # CoInitializeEx / CoTaskMemFree
  oleaut32.lib       # 变体（WebView2 的执行结果）
  user32.lib
  gdi32.lib
  advapi32.lib       # 注册表、DPAPI
  crypt32.lib        # CryptProtectData
  bcrypt.lib         # SHA-256（金标准对拍的指纹）
  shell32.lib        # SHGetKnownFolderPath / ShellExecute
  comdlg32.lib       # 文件对话框
  version.lib
  dwmapi.lib         # 深色标题栏（外观）
  winhttp.lib        # WinHttpCrackUrl：网址规范化（app:openExternal 的白名单判据）
)

# ---------------------------------------------------------------------------
# 界面资产：web/ → <dist>/web
#
# 这是**一大块刻意不做的事**的记账：渲染层（index.html / app.css / app.js / views/*）
# 是从 oracle 的 src/renderer **逐字节复制**过来的（纲领 §4.1「这是翻译，不是重写」）。
# 复制发生在 tools/sync-web.ps1，构建时只负责把它拷到 exe 旁边。
# 唯一的例外是 isg-bridge.js（新写的、宿主侧的桥）与 index.html 里的一行 <script>。
# ---------------------------------------------------------------------------
set(ISG_WEB_SRC "${ISG_ROOT}/web")
set(ISG_WEB_DST "${CMAKE_BINARY_DIR}/dist/web")
if (NOT EXISTS "${ISG_WEB_SRC}/index.html")
  message(FATAL_ERROR
    "缺少界面资产：${ISG_WEB_SRC}/index.html\n"
    "先跑 `powershell -File tools/sync-web.ps1` 从 oracle 的 src/renderer 复制一份。")
endif()
# ⚠️ 这里**不能**用 `add_custom_command(TARGET ... POST_BUILD ...)`：
# POST_BUILD 只在 target 真的被重新链接时才跑，而"只改了 web/ 下的资产"不会触发链接 ——
# 于是资产改动静默地进不了 dist，跑起来还是老页面。这正是本项目最怕的那类失效
# （改了资产、行为没变，而且看不出为什么）。改成带 DEPENDS 的独立目标：
file(GLOB_RECURSE ISG_WEB_FILES CONFIGURE_DEPENDS "${ISG_WEB_SRC}/*")
set(ISG_WEB_STAMP "${CMAKE_BINARY_DIR}/web-assets.stamp")
add_custom_command(
  OUTPUT "${ISG_WEB_STAMP}"
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${ISG_WEB_SRC}" "${ISG_WEB_DST}"
  COMMAND ${CMAKE_COMMAND} -E touch "${ISG_WEB_STAMP}"
  DEPENDS ${ISG_WEB_FILES}
  COMMENT "把界面资产拷到 dist/web（exe 从自己旁边读它）")
add_custom_target(isg-web-assets ALL DEPENDS "${ISG_WEB_STAMP}")
add_dependencies(isg-studio isg-web-assets)

# ---------------------------------------------------------------------------
# PDFium：运行时 DLL 必须和 exe 并排（导入库只负责链接，不负责把 DLL 送到位）。
# 与 web 资产同理，用带 DEPENDS 的独立目标 —— 改了 third_party 里的 DLL 也要跟着更新。
set(ISG_PDFIUM_DST "${CMAKE_BINARY_DIR}/dist/pdfium.dll")
add_custom_command(
  OUTPUT "${ISG_PDFIUM_DST}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different "${PDFIUM_DIR}/bin/pdfium.dll" "${ISG_PDFIUM_DST}"
  DEPENDS "${PDFIUM_DIR}/bin/pdfium.dll"
  COMMENT "把 pdfium.dll 拷到 dist（exe 从自己旁边加载）")
add_custom_target(isg-pdfium-dll ALL DEPENDS "${ISG_PDFIUM_DST}")
add_dependencies(isg-studio isg-pdfium-dll)

# ---------------------------------------------------------------------------
# 版本号：**单一真源是工程根的 VERSION 文件**。
#
# 2.0.0 起 C++ 宿主与 Electron oracle 有意分叉：
#   · oracle（apps/isg-studio/）停在 1.4.2，是迁移基准，不跟着改；
#   · C++ 宿主是新的主架构，版本从 VERSION 读，CMake / exe 资源 / 安装包都跟它走。
# 所以这里**不再**要求与 oracle 的 package.json 相等；tools/phase1-verify.ps1 改为
# 核对 VERSION、exe 的 FileVersion、RC/manifest 三者一致，并单独确认 oracle 仍是 1.4.2。
if (NOT DEFINED ISG_APP_VERSION)
  file(STRINGS "${ISG_ROOT}/VERSION" ISG_APP_VERSION LIMIT_COUNT 1)
  string(STRIP "${ISG_APP_VERSION}" ISG_APP_VERSION)
endif()
if (NOT ISG_APP_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR "VERSION 里的版本号不合法：'${ISG_APP_VERSION}'（要 x.y.z）")
endif()
target_compile_definitions(isg-studio PRIVATE
  ISG_APP_VERSION="${ISG_APP_VERSION}"
  $<$<CONFIG:Debug>:_DEBUG>)

target_compile_options(isg-studio PRIVATE
  $<$<CONFIG:Debug>:/Od /Zi /RTC1>
  $<$<NOT:$<CONFIG:Debug>>:/O2>)

set_target_properties(isg-studio PROPERTIES
  OUTPUT_NAME "isg-studio"
  VS_DEBUGGER_WORKING_DIRECTORY "${ISG_ROOT}"
  RUNTIME_OUTPUT_DIRECTORY         "${CMAKE_BINARY_DIR}/dist"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_BINARY_DIR}/dist"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/dist"
)
