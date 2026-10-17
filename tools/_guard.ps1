<#
    本工程所有"危险动作"的唯一实现。别的脚本都 dot-source 它。

    为什么要有这个文件：删除与杀进程的护栏原来在本工程里被抄了三遍，其中两遍没抄全
    （`build.ps1 -Clean` 一处护栏都没有；`bench-startup.ps1` 的三条断言只看字符串、
    不看重解析点）。**同一件事有多个实现，就等于有多个走散的机会** ——
    这跟本仓库 `assets/sync-skeleton.py` 要解决的"资产与内联副本走散"是同一类问题。
    收成一份之后，"护栏够不够"只需要审一个地方。

    ⚠️ 本文件必须带 UTF-8 BOM（`python tools/check-ps1-encoding.py` 会查）。
#>

Set-StrictMode -Version Latest

<#
    把"要删的路径"解析成一个可信的绝对路径，任何一条不满足就抛错。

    护栏的每一条都对应一种真实的手滑：
      · 空串 / 相对路径           —— `-BuildDir ''`、`-BuildDir .`
      · 不在允许根之内            —— `-BuildDir ..\..` 能删到工程外
      · 就是允许根本身            —— `-BuildDir .` 会把允许根整个删掉
      · 叶子名不符合约定          —— `-BuildDir spike` 会删掉源码目录
#>
function Resolve-GuardedPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AllowedRoot,
        [Parameter(Mandatory)][string]$LeafPrefix
    )
    if ([string]::IsNullOrWhiteSpace($Path))    { throw '拒绝：路径为空' }
    if (-not [System.IO.Path]::IsPathRooted($Path)) { throw "拒绝：'$Path' 不是绝对路径" }

    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $root = [System.IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')

    if (-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝：'$full' 不在允许根 '$root' 之内"
    }
    if ($full.Length -le $root.Length) { throw "拒绝：'$full' 就是允许根本身" }
    if (-not (Split-Path $full -Leaf).StartsWith($LeafPrefix)) {
        throw "拒绝：'$full' 的目录名不以 '$LeafPrefix' 开头，不像是脚本自己创建的东西"
    }
    return $full
}

<#
    重解析点（junction / 符号链接）拒绝。

    为什么必须查：上面的 `GetFullPath` 只做**词法**折叠，不解析重解析点。
    若目标路径本身（或它在允许根内的某一级）是 junction，路径字符串仍全在允许根之内、
    叶子名也仍然合规 —— 护栏全过，然后递归删，真正被删的是链接指向的地方。
    PowerShell 的 `-Recurse -Force` 遇到目录联接的行为在不同版本/不同 .NET 上并不一致，
    护栏不该赌这一点。命中就只删链接本身（不递归），或者干脆拒删。
#>
function Assert-NotReparsePoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        # 从哪一级开始逐段查。空 = 只查目标本身（旧行为）。
        [string]$FromRoot = ''
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }

    <#
      逐段查，而不是只看叶子。
      ⚠️ `Get-Item C:oot\link\child` 的 Attributes **不含** ReparsePoint ——
      只有 `link` 那一级含。所以"只查叶子"对"允许根内有一级是 junction"的场景形同虚设：
      路径字符串全在根内、叶子名也合规，递归删下去会删到链接指向的外部。
      （第三路交叉审查点名的两处之一。）
    #>
    $start = if ($FromRoot) { [System.IO.Path]::GetFullPath($FromRoot).TrimEnd('') } else { '' }
    $target = [System.IO.Path]::GetFullPath($Path)
    if ($start -and -not $target.StartsWith($start + '', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝：'$target' 不在 '$start' 之内，无法逐段检查"
    }
    $cur = $target
    while ($true) {
        if (Test-Path -LiteralPath $cur) {
            $item = Get-Item -LiteralPath $cur -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                throw "拒绝：'$cur' 是重解析点（junction / 符号链接）。删除它可能会连带删掉链接指向的地方。"
            }
        }
        if (-not $start) { break }
        if ($cur -eq $start) { break }
        $parent = Split-Path -Parent $cur
        if (-not $parent -or $parent -eq $cur) { break }
        $cur = $parent
    }
}

<# 带完整护栏的递归删除。所有"清掉一个目录"的调用都应该走它。 #>
function Remove-Guarded {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AllowedRoot,
        [Parameter(Mandatory)][string]$LeafPrefix,
        [switch]$File    # 允许目标是文件（默认只允许目录）
    )
    $full = Resolve-GuardedPath -Path $Path -AllowedRoot $AllowedRoot -LeafPrefix $LeafPrefix
    if (-not (Test-Path -LiteralPath $full)) { return }
    Assert-NotReparsePoint -Path $full -FromRoot $AllowedRoot

    $item = Get-Item -LiteralPath $full -Force
    if (-not $File -and -not $item.PSIsContainer) {
        throw "拒绝：'$full' 不是目录（真要对文件动手就显式加 -File）"
    }
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
}

<#
    只找**我们自己**派生的 WebView2 进程（含它的辅助进程）。

    判别用"满足其一"：
      1  命令行里有 `--webview-exe-name=<我们的 exe>` —— WebView2 会把宿主 exe 名写进去；
      2  命令行里的 `--user-data-dir` **正好**是传给它的那一个（带边界，不是裸子串）。

    为什么②必须独立成立：WebView2 还会派生 crashpad-handler / gpu-process / network 等
    辅助进程（实测命令行里**只有** `--type=… --user-data-dir=…`，**没有** `--webview-exe-name`）。
    只认①的话这些进程永远漏网，而它们恰好握着 user data folder 的文件锁 ——
    于是"清干净了"的断言会通过、紧接着删 profile 却失败（踩过：bench 第一轮就报
    "profile 没被删掉"）。带边界的精确路径匹配已经足以区分我们和别的宿主。
    对照：本机 `SearchHost.exe` 的 6 个 msedgewebview2 用的是它自己的 user data 目录，两条都不命中。

    为什么不能 `Get-Process msedgewebview2 | Stop-Process`：这台机器上
    `SearchHost.exe`（Windows 搜索）就挂着 6 个 msedgewebview2 —— 一刀切会去动
    与本工程无关的系统组件，属于最该三思的那类动作。
    为什么不能只用裸子串匹配 user-data-dir：`%TEMP%\isg-bench` 会命中
    `%TEMP%\isg-bench-2`，误伤同类别的另一个宿主。
#>
function Get-OurWebViewProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$UserDataDir,
        [string]$ExeName = 'isg-spike.exe'
    )
    if ([string]::IsNullOrWhiteSpace($UserDataDir)) { return @() }

    $ud = $UserDataDir.TrimEnd('\')
    # --user-data-dir 可能带引号也可能不带，用"后面跟引号或空白/结尾"卡住边界
    $udPattern  = [regex]::Escape('--user-data-dir=') + '"?(' + [regex]::Escape($ud) + ')"?(?:\s|$)'
    $exePattern = [regex]::Escape('--webview-exe-name=' + $ExeName)

    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $cl = $_.CommandLine
            if (-not $cl) { return $false }
            # 它是我们的宿主派生的辅助进程（辅助进程没有 exe-name 标志，靠精确路径认）
            if ($cl -match $udPattern) { return $true }
            # 或者它自报是我们这个 exe 的浏览器进程
            return ($cl -match $exePattern)
        }
}

function Clear-OurWebViewProcesses {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$UserDataDir,
        [string]$ExeName = 'isg-spike.exe'
    )
    $ours = @(Get-OurWebViewProcesses -UserDataDir $UserDataDir -ExeName $ExeName)
    if ($ours.Count -gt 0) {
        $ours | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 400
    }
}

<#
    单文件删除的护栏入口（非递归）。
    为什么要有它：项目规矩是"删除之前先看目标"，而自测/验证脚本里到处是
    `Remove-Item <自己刚生成的文件>` —— 它们**也应该走同一份断言**，
    否则"规矩"只在递归删除上成立，单文件删除就成了没护栏的例外。
    用法：Remove-GuardedFile -Path <文件> -AllowedRoot <根> -LeafPrefix <叶子名开头>
#>
function Remove-GuardedFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AllowedRoot,
        # 叶子名前缀；空 = 不限制叶子名（仍然要求"在允许根之内 + 不是重解析点 + 是文件"）
        [string]$LeafPrefix = ''
    )
    if ($LeafPrefix) {
        $full = Resolve-GuardedPath -Path $Path -AllowedRoot $AllowedRoot -LeafPrefix $LeafPrefix
    } else {
        # 没有叶子名约束时，仍要过"在根内"这一关（规则与 Resolve-GuardedPath 一致）
        $f = [System.IO.Path]::GetFullPath($Path)
        $r = [System.IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\')
        if (-not $f.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "拒绝：'$f' 不在允许根 '$r' 之内"
        }
        if ($f.Length -le $r.Length) { throw "拒绝：'$f' 就是允许根本身" }
        $full = $f
    }
    if (-not (Test-Path -LiteralPath $full)) { return }
    Assert-NotReparsePoint -Path $full -FromRoot $AllowedRoot
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { throw "拒绝：'$full' 是目录，单文件删除不接受目录" }
    Remove-Item -LiteralPath $full -Force
}
