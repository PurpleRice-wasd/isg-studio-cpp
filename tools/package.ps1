<#
    Phase 6：把构建产物打成一个**可直接拷给别人**的便携目录 + zip；有 NSIS 时再出一个安装包。

    交付目录的内容（与 docs/README.md 的约定一致）：
        isg-studio.exe          C++ 宿主
        pdfium.dll              PDF 抽取
        web/                    渲染层 + 逻辑 bundle
        skill/                  运行期原样读的 skill 内核（不内联！纲领 §4.6 第 6 条）
        docs/generation-contract.md  模型契约（运行期从磁盘读）
        LICENSE / README.txt

    用法：
        powershell -File tools\package.ps1                    # Release，产物在 build-package\
        powershell -File tools\package.ps1 -BuildDir build2
        powershell -File tools\package.ps1 -SkipZip            # 只铺目录

    ⚠️ 删除动作一律走 tools/_guard.ps1：只删自己刚建的那个 build-package 目录，
       路径必须落在工程根内、叶子名以 build 开头。
#>
[CmdletBinding()]
param(
    [string]$BuildDir = 'build',
    [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_guard.ps1')

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $dist = Join-Path $root "$BuildDir\dist"
    if (-not (Test-Path (Join-Path $dist 'isg-studio.exe'))) {
        throw "找不到构建产物：$dist\isg-studio.exe（先跑 tools\build.ps1）"
    }
    if (-not (Test-Path (Join-Path $dist 'web\index.html'))) {
        throw "产物里缺 web\（先跑 tools\build.ps1；它会拷 web 资产）"
    }

    # 版本单一真源是工程根的 VERSION（C++ 宿主 2.x 与 Electron oracle 1.4.2 有意分叉）。
    $versionFile = Join-Path $root 'VERSION'
    if (-not (Test-Path $versionFile)) { throw "找不到版本文件：$versionFile" }
    $version = (Get-Content $versionFile -TotalCount 1 -Encoding UTF8).Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "VERSION 里的版本号不合法：'$version'（要 x.y.z）" }
    $pkgRoot = Join-Path $root 'build-package'
    $stage = Join-Path $pkgRoot "isg-studio-$version"
    if (Test-Path $pkgRoot) {
        # 只删 build-package 这一个（叶子名合规、在工程根内）。
        Remove-Guarded -Path $pkgRoot -AllowedRoot $root -LeafPrefix 'build'
    }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # 1) 宿主与依赖
    Copy-Item (Join-Path $dist 'isg-studio.exe') $stage
    Copy-Item (Join-Path $dist 'pdfium.dll') $stage
    Copy-Item (Join-Path $dist 'web') $stage -Recurse

    # 2) skill 内核：**运行期从磁盘读**，不是内联。缺了它应用会明确报"没找到 skill"。
    # 独立仓库里 skill 就在本仓库根下；原 monorepo 里在 ../../skills，保留回退。
    $skillSrc = Join-Path $root 'skills\interactive-study-guide'
    if (-not (Test-Path (Join-Path $skillSrc 'SKILL.md'))) {
        $skillSrc = Join-Path $root '..\..\skills\interactive-study-guide'
    }
    if (-not (Test-Path (Join-Path $skillSrc 'SKILL.md'))) {
        throw "找不到 skill 内核：$skillSrc（交付包必须带上它）"
    }
    Copy-Item $skillSrc (Join-Path $stage 'skill') -Recurse

    # 3) 生成契约（运行期 prompts.js 的开发态候选会去找 <exe>\docs\generation-contract.md）
    # 独立仓库里契约在 docs/；原 monorepo 里在 ../isg-studio/docs，保留回退。
    $contract = Join-Path $root 'docs\generation-contract.md'
    if (-not (Test-Path $contract)) {
        $contract = Join-Path $root '..\isg-studio\docs\generation-contract.md'
    }
    if (-not (Test-Path $contract)) {
        throw "找不到生成契约：$contract"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'docs') | Out-Null
    Copy-Item $contract (Join-Path $stage 'docs')

    # 4) 许可与一句话说明
    $license = Join-Path $root 'LICENSE'
    if (-not (Test-Path $license)) { $license = Join-Path $root '..\..\LICENSE' }
    if (Test-Path $license) { Copy-Item $license $stage }
    @'
讲练一体工作台（isg-studio）
============================

运行：双击 isg-studio.exe。需要 Windows 10/11 与 WebView2 运行时（Win11 自带）。
数据：设置、历史、Key 加密后的密文都在 %APPDATA%\isg-studio。
内核：skill\ 与 docs\generation-contract.md 是运行期读取的；可以替换，但格式要兼容。
'@ | Out-File -FilePath (Join-Path $stage 'README.txt') -Encoding utf8

    # 5) 便携 zip
    if (-not $SkipZip) {
        $zip = Join-Path $pkgRoot "isg-studio-$version-portable.zip"
        if (Test-Path $zip) { Remove-GuardedFile -Path $zip -AllowedRoot $pkgRoot }
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
        Write-Output ("便携包：" + $zip + "（" + [math]::Round((Get-Item $zip).Length / 1MB, 2) + " MB）")
    }

    # 6) NSIS：安装版 + 单文件便携版（与 Electron 原档的两个 exe 对应）
    #    makensis 不在 PATH 时再找默认安装位置；两处都没有才明确跳过。
    # 统一成一个**字符串路径**：Get-Command 给的是 .Source，
    # Get-Item 给的是 .FullName —— 混用会在第一次跑时炸在属性不存在上。
    $mk = $null
    $cmd = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $mk = $cmd.Source
    } else {
        $candidates = @(
            (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe')
        )
        foreach ($c in $candidates) {
            if (Test-Path $c) { $mk = $c; break }
        }
    }
    if ($mk) {
        $version4 = ($version -split '\.') + @('0','0','0')
        $ver4 = ($version4[0..3] -join '.')

        # 6a) 安装版：可选目录、桌面 + 开始菜单快捷方式、卸载入口。
        #     安装范围是当前用户（LOCALAPPDATA），不需要管理员权限。
        $setupNsi = Join-Path $pkgRoot 'setup.nsi'
        $setupScript = @"
Unicode true
SetCompressor /SOLID lzma
Name "讲练一体工作台"
Caption "讲练一体工作台 $version 安装"
OutFile "$pkgRoot\ISG-Studio-Setup-$version-x64.exe"
InstallDir "`$LOCALAPPDATA\Programs\isg-studio"
InstallDirRegKey HKCU "Software\isg-studio" "InstallDir"
RequestExecutionLevel user
VIProductVersion "$ver4"
VIAddVersionKey /LANG=2052 "ProductName" "讲练一体工作台"
VIAddVersionKey /LANG=2052 "FileDescription" "讲练一体工作台 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "$version"
VIAddVersionKey /LANG=2052 "ProductVersion" "$version"
VIAddVersionKey /LANG=2052 "CompanyName" "interactive-study-guide"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装"
  SetOutPath "`$INSTDIR"
  File /r "$stage\*.*"
  WriteUninstaller "`$INSTDIR\uninstall.exe"

  CreateDirectory "`$SMPROGRAMS\讲练一体工作台"
  CreateShortcut "`$SMPROGRAMS\讲练一体工作台\讲练一体工作台.lnk" "`$INSTDIR\isg-studio.exe"
  CreateShortcut "`$DESKTOP\讲练一体工作台.lnk" "`$INSTDIR\isg-studio.exe"

  WriteRegStr HKCU "Software\isg-studio" "InstallDir" "`$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "DisplayName" "讲练一体工作台"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "DisplayVersion" "$version"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "Publisher" "interactive-study-guide"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "DisplayIcon" "`$INSTDIR\isg-studio.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "UninstallString" '"`$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio" "EstimatedSize" 11000
SectionEnd

Section "Uninstall"
  ; 用户可能就是在安装目录里双击 uninstall.exe：卸载器的 CWD 会是安装目录，
  ; 而 Windows 不允许删除当前目录 —— 不挪走的话 RMDir /r 静默失败、留下一个空壳。
  SetOutPath "`$TEMP"
  Delete "`$DESKTOP\讲练一体工作台.lnk"
  Delete "`$SMPROGRAMS\讲练一体工作台\讲练一体工作台.lnk"
  RMDir "`$SMPROGRAMS\讲练一体工作台"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio"
  DeleteRegKey HKCU "Software\isg-studio"
  ; 只删安装目录。**用户配置（%APPDATA%\isg-studio）保留** ——
  ; 卸载不该顺手毁掉历史、设置与进度，这是原版 electron-builder 的行为。
  RMDir /r "`$INSTDIR"
SectionEnd
"@
        # ⚠️ 必须带 BOM：NSIS 3 只把「带 BOM 的 UTF-8」当 Unicode 源；
        # 不带 BOM 时按 ANSI 解，快捷方式名与中文文案会变成乱码。
        [System.IO.File]::WriteAllText($setupNsi, $setupScript, (New-Object System.Text.UTF8Encoding($true)))
        & $mk $setupNsi
        if ($LASTEXITCODE -ne 0) { throw "makensis（安装版）失败，退出码 $LASTEXITCODE" }
        Write-Output "安装包：$pkgRoot\ISG-Studio-Setup-$version-x64.exe"

        # 6b) 便携版单文件：解到临时目录后运行，退出即清理（同 electron-builder 的 portable）。
        #     注意 ExecWait —— 不等的话 NSIS 退出会把正在运行的程序一起删掉。
        $portableNsi = Join-Path $pkgRoot 'portable.nsi'
        $portableScript = @"
Unicode true
SetCompressor /SOLID lzma
Name "讲练一体工作台"
OutFile "$pkgRoot\ISG-Studio-Portable-$version-x64.exe"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
VIProductVersion "$ver4"
VIAddVersionKey /LANG=2052 "ProductName" "讲练一体工作台"
VIAddVersionKey /LANG=2052 "FileDescription" "讲练一体工作台 便携版"
VIAddVersionKey /LANG=2052 "FileVersion" "$version"
VIAddVersionKey /LANG=2052 "ProductVersion" "$version"
VIAddVersionKey /LANG=2052 "CompanyName" "interactive-study-guide"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"

Section
  ; ⚠️ 必须显式初始化：SilentInstall silent 时安装器不跑 UI 初始化，
  ; 不调用这一句的话插件目录为空，SetOutPath/ExecWait 静默失败，
  ; 启动器**返回 0 却什么都没做**（实测踩到）。
  InitPluginsDir
  SetOutPath "`$PLUGINSDIR\app"
  File /r "$stage\*.*"
  ExecWait '"`$PLUGINSDIR\app\isg-studio.exe"'
  ; 先把安装器的当前目录挪走：SetOutPath 会把本进程的 CWD 设成 app 目录，
  ; 而 Windows 不允许删除当前目录（实测：文件被清了，空目录留下）。
  SetOutPath "`$TEMP"
  ; NSIS 退出时只会清掉它登记过的文件，自己 SetOutPath 出来的空目录要显式收。
  RMDir /r "`$PLUGINSDIR\app"
  RMDir "`$PLUGINSDIR"
SectionEnd
"@
        [System.IO.File]::WriteAllText($portableNsi, $portableScript, (New-Object System.Text.UTF8Encoding($true)))
        & $mk $portableNsi
        if ($LASTEXITCODE -ne 0) { throw "makensis（便携版）失败，退出码 $LASTEXITCODE" }
        Write-Output "便携单文件：$pkgRoot\ISG-Studio-Portable-$version-x64.exe"
    } else {
        Write-Output "[skip] 没装 NSIS（PATH 与 Program Files 下都没有 makensis.exe）—— 本次只产出便携目录/zip。"
        Write-Output "       安装包：winget install --id NSIS.NSIS -e 后重跑本脚本即可。"
    }

    $bytes = (Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
    Write-Output ("交付目录：" + $stage + "（" + [math]::Round($bytes / 1MB, 2) + " MB）")
    exit 0
}
catch {
    Write-Output ("[BAD] 打包失败：" + $_.Exception.Message)
    exit 1
}
finally {
    Pop-Location
}
