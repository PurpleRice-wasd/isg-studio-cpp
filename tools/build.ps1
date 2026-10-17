<#
    isg-studio-cpp 构建脚本。

    为什么要它：这台机器上 cmake 与 ninja 都不在全局 PATH 里，它们是 Visual Studio
    自带的（D:\visualstudio\Common7\IDE\CommonExtensions\Microsoft\CMake\...）。
    不先 call vcvars64.bat 就敲 cmake，得到的是"找不到 cl.exe"这类没头没脑的报错。

    ⚠️ 本文件必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的 .ps1 按系统
    代码页（这台机器是 936）解码，中文注释会被解成乱码，然后解析器在乱码上崩掉，
    报一堆和真正原因无关的语法错误。tools/fix-encoding.ps1 负责修这一点。

    用法：
        powershell -File tools\build.ps1                 # Release 构建
        powershell -File tools\build.ps1 -Config Debug   # Debug 构建（开 CRT 泄漏检查）
        powershell -File tools\build.ps1 -Clean          # 先删掉 build/ 再配
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string]$Config = 'Release',
    [string]$BuildDir = 'build',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_guard.ps1')      # 删除动作一律走 _guard.ps1 里那一份实现

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $vcvars = 'D:\visualstudio\VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars)) {
        throw "找不到 vcvars64.bat：$vcvars（Visual Studio 安装位置变了就要改这里）"
    }

    # 先卡住参数形态：`-BuildDir ..\..` 会让 Join-Path 拼出工程之外的路径。
    if ([System.IO.Path]::IsPathRooted($BuildDir) -or $BuildDir -match '[\\/]' -or $BuildDir -match '\.\.') {
        throw "-BuildDir 只接受**单个**目录名（如 build / build-debug），收到的是 '$BuildDir'。" +
              "带路径分隔符或 .. 的形式能拼到工程目录之外，这里直接拒掉。"
    }

    $buildPath = Join-Path $root $BuildDir
    if ($Clean) {
        # -Clean 会递归删掉整个构建目录。目标由命令行参数拼出来，所以护栏一条都不能省：
        # 必须在工程根之内、叶子名必须以 build 开头、不能是重解析点、必须是目录。
        # （原先这里是一句光秃秃的 Remove-Item -Recurse -Force：`-BuildDir ..\..` 能删到工程外。）
        Remove-Guarded -Path $buildPath -AllowedRoot $root -LeafPrefix 'build'
    }

    # 全部塞进一个 .bat 里跑：vcvars 设的环境变量只在那一个 cmd 会话里有效，
    # 分成两次调用的话第二次就没有 cl.exe 了。
    # 这个 .bat 里**不写中文**（cmd 的默认代码页是 936，中文批处理容易出岔子）。
    $lines = @(
        '@echo off',
        "call `"$vcvars`" >nul 2>&1",
        'if errorlevel 1 exit /b 1',
        "cmake -S `"$root`" -B `"$buildPath`" -G Ninja -DCMAKE_BUILD_TYPE=$Config",
        'if errorlevel 1 exit /b 1',
        "cmake --build `"$buildPath`" --config $Config",
        'if errorlevel 1 exit /b 1',
        'exit /b 0'
    )
    $batFile = Join-Path $env:TEMP 'isg-build.bat'
    Set-Content -Path $batFile -Value $lines -Encoding ascii

    & cmd.exe /c $batFile
    if ($LASTEXITCODE -ne 0) { throw "构建失败（退出码 $LASTEXITCODE）" }

    Write-Output ''
    Write-Output '=== 产物 ==='
    $dist = Join-Path $buildPath 'dist'
    if (Test-Path $dist) {
        # ⚠️ 必须 `-File`：dist 里现在有 `web\` 这个**目录**，而 DirectoryInfo 没有 Length 属性 ——
        # 直接 `$_.Length` 会抛"在此对象上找不到属性 Length"，把一次**成功的构建**
        # 报成失败（Phase 0 时 dist 里只有 exe，所以这条一直没暴露）。
        Get-ChildItem $dist -File | ForEach-Object {
            '{0,-26} {1,12:N0} 字节' -f $_.Name, $_.Length
        }
        Get-ChildItem $dist -Directory | ForEach-Object {
            # 对齐符只能写 `{0,-26}`（负数是左对齐），**不能**写成 `{1,>12}` —— 那是 C# 的写法，
            # PowerShell 的 -f 会抛"输入字符串的格式不正确"，而报错还指在别处。
            '{0,-26} （目录）' -f $_.Name
        }
    } else {
        Write-Output '(还没有 dist 目录)'
    }
}
finally {
    Pop-Location
}
