<#
    取第三方依赖。目前只有一样：WebView2 SDK（NuGet 包 Microsoft.Web.WebView2）。

    为什么用 NuGet 包而不是 vcpkg：WebView2 SDK 就是几个头文件加三个 .lib/.dll，
    vcpkg 会顺带拉一整套构建体系，对 Phase 0 是净负担。真正需要 vcpkg 的是后面
    PDFium / miniz / pugixml 那几样（guidance §3.4），到 Phase 2 再引。

    用法：
        powershell -File tools\fetch-deps.ps1              # 已存在就跳过
        powershell -File tools\fetch-deps.ps1 -Force       # 强制重取
#>
[CmdletBinding()]
param(
    [string]$Version = '1.0.4258.31',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_guard.ps1')      # 删除动作一律走 _guard.ps1 里那一份实现

# $Version 来自命令行，会被拼进文件名再去删 —— 形态必须先卡住（`-Version '..\..\x'` 能删到 TEMP 之外）。
# ⚠️ 段数要允许 2–4：NuGet 的版本号是 4 段（`1.0.4258.31`），而这里原来只写了 3 段 ——
# 于是**默认值本身**就通不过校验，脚本一直在第一关就炸（Phase 0 时因为 SDK 目录已存在、
# 走的是"已就位"那条早退分支，所以没人发现）。这类"默认值自己不合规"的校验最容易骗人。
if ($Version -notmatch '^\d+(\.\d+){1,3}(-[A-Za-z0-9.]+)?$') {
    throw "-Version 只接受形如 1.0.4258.31 的版本号，收到的是 '$Version'"
}

$root = Split-Path -Parent $PSScriptRoot
$tp   = Join-Path $root 'third_party'
$dest = Join-Path $tp 'webview2'
$header = Join-Path $dest 'build\native\include\WebView2.h'

# ⚠️ 这里**不能 `exit 0`**：脚本现在管着不止一样依赖，早退会让后面的
# （nlohmann/json）永远取不到 —— 而症状是"跑过了，但构建说缺头文件"。
# 用一段 if/else 把 WebView2 这一段包起来就行。
if ((Test-Path $header) -and -not $Force) {
    Write-Output "WebView2 SDK 已就位：$header（要重取加 -Force）"
} else {
New-Item -ItemType Directory -Force -Path $tp, $dest | Out-Null

# NuGet 的包就是 zip，只是扩展名不同：直接下 .zip 省得再改一次名
$url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.zip"
$zip = Join-Path $env:TEMP "microsoft.web.webview2.$Version.zip"

Write-Output "下载 $url"
Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 300
Write-Output ("大小 {0:N2} MB" -f ((Get-Item $zip).Length / 1MB))

Expand-Archive -Path $zip -DestinationPath $dest -Force

foreach ($need in @(
    'build\native\include\WebView2.h',
    'build\native\include\WebView2EnvironmentOptions.h',
    'build\native\x64\WebView2LoaderStatic.lib',
    'build\native\x64\WebView2Loader.dll'
)) {
    if (-not (Test-Path (Join-Path $dest $need))) { throw "包解出来缺少 $need，版本 $Version 的结构可能变了" }
}

# 删自己刚下的那个 zip：走护栏（必须在 %TEMP% 之内、叶子名以 microsoft.web 开头）——
# $zip 的路径里含命令行来的 $Version，不设护栏就等于让它决定删哪。
Remove-Guarded -Path $zip -AllowedRoot $env:TEMP -LeafPrefix 'microsoft.web' -File
Write-Output "WebView2 SDK $Version 已就位：$dest"
Write-Output '（用的是静态 loader：exe 不再需要旁挂 WebView2Loader.dll）'
}

# ---------------------------------------------------------------------------
# nlohmann/json（header-only）
#
# 为什么不用 vcpkg：Phase 1 只需要一个头文件，而 vcpkg 要 bootstrap 一整套构建体系；
# 真正需要它的是 Phase 2 的 PDFium / miniz / pugixml，到时候再引（纲领 §3.4 原话）。
# 版本与 sha256 **都钉死**：这是从网上取来的代码，哈希对不上就说明拿到的不是那一份，
# 直接失败比"装上去再说"安全。
# ---------------------------------------------------------------------------
$nlVersion = 'v3.11.3'
$nlSha256  = '9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6'
$nlDir     = Join-Path $tp 'nlohmann'
$nlPath    = Join-Path $nlDir 'json.hpp'

if ((Test-Path $nlPath) -and -not $Force) {
    Write-Output "nlohmann/json 已就位：$nlPath（要重取加 -Force）"
} else {
    New-Item -ItemType Directory -Force -Path $nlDir | Out-Null
    $url = "https://raw.githubusercontent.com/nlohmann/json/$nlVersion/single_include/nlohmann/json.hpp"
    Write-Output "下载 $url"
    $tmp = Join-Path $env:TEMP "nlohmann-json-$nlVersion.hpp"
    Invoke-WebRequest -Uri $url -OutFile $tmp -TimeoutSec 300
    $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $nlSha256) {
        Remove-Guarded -Path $tmp -AllowedRoot $env:TEMP -LeafPrefix 'nlohmann-json' -File
        throw "nlohmann/json 的 sha256 对不上：期望 $nlSha256，实际 $actual。不安装。"
    }
    Move-Item -Force $tmp $nlPath
    Write-Output "nlohmann/json $nlVersion 已就位：$nlPath（sha256 已核对）"
}

# ---------------------------------------------------------------------------
# Phase 2：PDFium（预编译 DLL）与 miniz（PPTX 解包）
#
# PDFium 用的是 bblanchon/pdfium-binaries 的 win-x64 预编译包。版本与 sha256 都钉死：
# 这是从网上取来的二进制，哈希对不上就说明拿到的不是那一份。
# miniz 取 2.2.0 的源码（多个文件，逐个校验）—— 它是 public domain，单文件不够用。
# ---------------------------------------------------------------------------
$pdfiumTag = 'chromium/8100'
$pdfiumSha = '51621bcc1d9be9ea448f4b84b0516862b928e3968d3fca899af1a6d6e2848d6d'
$pdfiumDir = Join-Path $tp 'pdfium'
$pdfiumHeader = Join-Path $pdfiumDir 'include\fpdfview.h'
$pdfiumLib = Join-Path $pdfiumDir 'lib\pdfium.dll.lib'

if ((Test-Path $pdfiumHeader) -and (Test-Path $pdfiumLib) -and -not $Force) {
    Write-Output "PDFium 已就位：$pdfiumDir（要重取加 -Force）"
} else {
    $url = "https://github.com/bblanchon/pdfium-binaries/releases/download/$pdfiumTag/pdfium-win-x64.tgz"
    $tgz = Join-Path $env:TEMP "pdfium-win-x64-8100.tgz"
    Write-Output "下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $tgz -TimeoutSec 300
    $actual = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $pdfiumSha) {
        Remove-Guarded -Path $tgz -AllowedRoot $env:TEMP -LeafPrefix 'pdfium-win-x64' -File
        throw "PDFium 的 sha256 对不上：期望 $pdfiumSha，实际 $actual。不安装。"
    }
    $extract = Join-Path $env:TEMP "pdfium-extract-8100-$PID"
    Remove-Guarded -Path $extract -AllowedRoot $env:TEMP -LeafPrefix 'pdfium-extract'
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    & tar.exe -xzf $tgz -C $extract
    if ($LASTEXITCODE -ne 0) { throw "解压 PDFium 失败（tar exit=$LASTEXITCODE）" }
    Remove-Guarded -Path $pdfiumDir -AllowedRoot $tp -LeafPrefix 'pdfium'
    New-Item -ItemType Directory -Force -Path $pdfiumDir | Out-Null
    Copy-Item -Path (Join-Path $extract '*') -Destination $pdfiumDir -Recurse -Force
    foreach ($need in @('include\fpdfview.h', 'include\fpdf_text.h', 'bin\pdfium.dll', 'lib\pdfium.dll.lib')) {
        if (-not (Test-Path (Join-Path $pdfiumDir $need))) { throw "PDFium 包解出来缺少 $need" }
    }
    Remove-Guarded -Path $extract -AllowedRoot $env:TEMP -LeafPrefix 'pdfium-extract'
    Remove-Guarded -Path $tgz -AllowedRoot $env:TEMP -LeafPrefix 'pdfium-win-x64' -File
    Write-Output "PDFium $pdfiumTag 已就位：$pdfiumDir（sha256 已核对）"
}

$minizVer = '2.2.0'
$minizDir = Join-Path $tp 'miniz'
$minizFiles = @{
    'miniz.c'         = '8711357479c6747bdb835905cf84afa710d0932db9d05d9c4590245873c291e1'
    'miniz.h'         = '1d268b56e6762b6a44bdaaa950964536e0b4d3349abd86575f7bf4a050d2abe8'
    'miniz_common.h'  = '767de9910646c06dc879c00b3b748922a51de3350dd4d794d27e0edd8ea20798'
    'miniz_tdef.c'    = '41d8bf1a4969c9983df2e0977d4ff909a90ec43fd2982b02d03dd6834bce1a25'
    'miniz_tdef.h'    = '413cdaf302c1e097de90a0bfecd7ad1bb2a5df87c941886acc915541aa0200b9'
    'miniz_tinfl.c'   = 'f3140db5a171360e5d70c538858f8bfe9c91d1ab7c409a2f8b262b8c18d21201'
    'miniz_tinfl.h'   = '5eba2135358d3a84686230865d4d9eda9f6833517eb3041f0db6c7dabf7dbe8b'
    'miniz_zip.c'     = '98b96fa8bfa0088bbade88b274f4f2ec696da045c3087114da12f862ae70de07'
    'miniz_zip.h'     = '7af3cf3ab22e94dc694d14a3534867bc144b602ed371c571579d875101fd0e73'
}
$minizReady = $true
foreach ($name in $minizFiles.Keys) {
    if (-not (Test-Path (Join-Path $minizDir $name))) { $minizReady = $false }
}
if ($minizReady -and -not $Force) {
    Write-Output "miniz 已就位：$minizDir（要重取加 -Force）"
} else {
    New-Item -ItemType Directory -Force -Path $minizDir | Out-Null
    $tmpDir = Join-Path $env:TEMP "miniz-$minizVer-$PID"
    Remove-Guarded -Path $tmpDir -AllowedRoot $env:TEMP -LeafPrefix 'miniz-'
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    foreach ($name in $minizFiles.Keys) {
        $url = "https://raw.githubusercontent.com/richgel999/miniz/$minizVer/$name"
        $tmp = Join-Path $tmpDir $name
        Write-Output "下载 $url"
        Invoke-WebRequest -Uri $url -OutFile $tmp -TimeoutSec 120
        $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $minizFiles[$name]) {
            Remove-Guarded -Path $tmpDir -AllowedRoot $env:TEMP -LeafPrefix 'miniz-'
            throw "miniz 的 $name sha256 对不上：期望 $($minizFiles[$name])，实际 $actual。不安装。"
        }
        Move-Item -Force $tmp (Join-Path $minizDir $name)
    }
    # miniz_export.h 是 CMake 生成物；这里给静态库用的空定义。
    Set-Content -Path (Join-Path $minizDir 'miniz_export.h') -Encoding ascii -Value @(
        '#ifndef MINIZ_EXPORT', '#define MINIZ_EXPORT', '#endif')
    Remove-Guarded -Path $tmpDir -AllowedRoot $env:TEMP -LeafPrefix 'miniz-'
    Write-Output "miniz $minizVer 已就位：$minizDir（每个文件的 sha256 已核对）"
}
