# 交付形态验收：安装版 + 便携单文件。
# 只操作用 TEMP 下自建目录与本工程自产的安装包；删目录前断言路径形态。
#
# 用法：
#   powershell -File tools\package-acceptance.ps1 `
#       -SamplePdf "C:\path\某章.pdf" -ExpectedPages 33
#
# 不给 -SamplePdf 时跳过"已安装程序抽取真 PDF"那一段（明确打印 [skip]）。
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$SamplePdf = '',
    [int]$ExpectedPages = 0
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
# 版本默认跟工程根的 VERSION 走，不在脚本里再写死一份。
if (-not $Version) {
    $vf = Join-Path $root 'VERSION'
    if (-not (Test-Path $vf)) { throw "找不到版本文件：$vf（或显式传 -Version）" }
    $Version = (Get-Content $vf -TotalCount 1 -Encoding UTF8).Trim()
}
$pkg = Join-Path $root 'build-package'
$setup = Join-Path $pkg "ISG-Studio-Setup-$Version-x64.exe"
$portable = Join-Path $pkg "ISG-Studio-Portable-$Version-x64.exe"
$samplePdf = $SamplePdf
$testRoot = Join-Path $env:TEMP 'isg-pkg-acceptance'
$installDir = Join-Path $testRoot 'install'
$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) '讲练一体工作台.lnk'
$startLnk = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\讲练一体工作台\讲练一体工作台.lnk'
$regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\isg-studio'
$userData = Join-Path $env:APPDATA 'isg-studio'

$script:bad = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Output "[ok]  $name  $detail" }
    else { Write-Output "[BAD] $name  $detail"; $script:bad++ }
}

# ---- 0. 清理，只删自己建的那个 TEMP 子目录 ----
$tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$full = [IO.Path]::GetFullPath($testRoot)
if (-not $full.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝删除不在 TEMP 下的目录：$full"
}
if (Test-Path $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

Check '安装包存在' (Test-Path $setup) $setup
Check '便携单文件存在' (Test-Path $portable) $portable

# ---- 1. 静默安装到 TEMP ----
$p = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
Check '静默安装退出码 0' ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"
foreach ($rel in @('isg-studio.exe','pdfium.dll','web\index.html','skill\SKILL.md','docs\generation-contract.md','uninstall.exe')) {
    Check "安装目录含 $rel" (Test-Path (Join-Path $installDir $rel))
}
Check '桌面快捷方式已建' (Test-Path $desktopLnk)
Check '开始菜单快捷方式已建' (Test-Path $startLnk)
Check '卸载登记项已写' (Test-Path $regPath)
if (Test-Path $regPath) {
    $r = Get-ItemProperty $regPath
    Check '卸载项写着产品名' ($r.DisplayName -eq '讲练一体工作台') $r.DisplayName
    Check '卸载项写着版本' ($r.DisplayVersion -eq $Version) $r.DisplayVersion
}

# ---- 2. 启动已安装的程序，确认窗口与 DPI，再关掉 ----
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PkgWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
'@
[void][PkgWin]::SetThreadDpiAwarenessContext([IntPtr](-4))

function Find-AppWindow([int]$targetPid, [int]$timeoutMs = 20000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $found = [IntPtr]::Zero
        $cb = [PkgWin+EnumProc]{
            param($h, $l)
            $pp = 0; [void][PkgWin]::GetWindowThreadProcessId($h, [ref]$pp)
            if ($pp -eq $script:wantPid -and [PkgWin]::IsWindowVisible($h)) {
                $sb = New-Object Text.StringBuilder 256
                [void][PkgWin]::GetClassNameW($h, $sb, 256)
                $r = New-Object PkgWin+RECT
                [void][PkgWin]::GetWindowRect($h, [ref]$r)
                if ($sb.ToString() -eq 'ISG_STUDIO_MAIN_WINDOW' -and ($r.R - $r.L) -gt 400) {
                    $script:hit = $h
                }
            }
            return $true
        }
        $script:wantPid = $targetPid
        $script:hit = [IntPtr]::Zero
        [void][PkgWin]::EnumWindows($cb, [IntPtr]::Zero)
        if ($script:hit -ne [IntPtr]::Zero) { return $script:hit }
        Start-Sleep -Milliseconds 150
    }
    return [IntPtr]::Zero
}

$app = Start-Process -FilePath (Join-Path $installDir 'isg-studio.exe') -PassThru
$h = Find-AppWindow $app.Id 20000
Check '已安装程序建出主窗口' ($h -ne [IntPtr]::Zero) "hwnd=$h"
if ($h -ne [IntPtr]::Zero) {
    # 窗口在 WebView2 控制器就绪**之前**就建好了；立刻关窗会把"启动中"当成"启动失败"。
    # 等一拍，让控制器/页面真的起来再验。
    Start-Sleep -Milliseconds 1200
    $r = New-Object PkgWin+RECT
    [void][PkgWin]::GetWindowRect($h, [ref]$r)
    $dpi = [PkgWin]::GetDpiForWindow($h)
    Check '窗口 DPI 感知生效（DPI>96）' ($dpi -gt 96) "dpi=$dpi size=$($r.R-$r.L)x$($r.B-$r.T)"
    [void][PkgWin]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
$exited = $app.WaitForExit(20000)
Check '关窗后进程正常退出（退出码 0）' ($exited -and $app.ExitCode -eq 0) "exit=$(if($exited){$app.ExitCode}else{'timeout'})"

# ---- 3. 已安装程序的抽取能力（pdfium.dll 在 exe 旁）----
if ($samplePdf -and (Test-Path $samplePdf)) {
    $extractOut = Join-Path $testRoot 'extract.json'
    & (Join-Path $installDir 'isg-studio.exe') --extract="$samplePdf" --out="$extractOut" | Out-Null
    Check '已安装程序抽取真 PDF 退出码 0' ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"
    $pages = $null
    if (Test-Path $extractOut) {
        $ej = Get-Content $extractOut -Raw -Encoding UTF8 | ConvertFrom-Json
        $pages = $ej.meta.pageCount
    }
    if ($ExpectedPages -gt 0) {
        Check "抽取结果页数与样本一致（$ExpectedPages）" ($pages -eq $ExpectedPages) "pages=$pages"
    } else {
        Write-Output "[skip] 没给 -ExpectedPages，只验抽取成功不验页数（pages=$pages）"
    }
} else {
    Write-Output "[skip] 没给 -SamplePdf（或文件不存在），跳过已安装程序的真 PDF 抽取"
}

# ---- 4. 静默卸载：只删安装目录，用户配置保留 ----
$u = Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
Check '静默卸载退出码 0' ($u.ExitCode -eq 0) "exit=$($u.ExitCode)"
$gone = $false
for ($i = 0; $i -lt 50; $i++) { if (-not (Test-Path $installDir)) { $gone = $true; break }; Start-Sleep -Milliseconds 200 }
Check '卸载后安装目录已移除' $gone
Check '卸载后桌面快捷方式已移除' (-not (Test-Path $desktopLnk))
Check '卸载后开始菜单快捷方式已移除' (-not (Test-Path $startLnk))
Check '卸载后登记项已移除' (-not (Test-Path $regPath))
Check '卸载后用户配置仍在（不毁历史/设置）' (Test-Path (Join-Path $userData 'settings.json'))

# ---- 5. 便携单文件：启动 → 找子进程窗口 → 关窗 → 临时目录清理 ----
$before = @(Get-CimInstance Win32_Process -Filter "Name='isg-studio.exe'" | Select-Object -ExpandProperty ProcessId)
$pp = Start-Process -FilePath $portable -PassThru
$child = $null
$deadline = [DateTime]::UtcNow.AddSeconds(45)
while ([DateTime]::UtcNow -lt $deadline -and $null -eq $child) {
    $c = Get-CimInstance Win32_Process -Filter "Name='isg-studio.exe'" |
         Where-Object { $before -notcontains $_.ProcessId -and $_.CommandLine -match '\\app\\isg-studio\.exe' }
    if ($c) { $child = $c | Select-Object -First 1 }
    if ($null -eq $child) { Start-Sleep -Milliseconds 250 }
}
Check '便携版解出并启动了子进程' ($null -ne $child) $(if($child){"pid=$($child.ProcessId)"}else{''})
if ($null -ne $child) {
    $childPid = [int]$child.ProcessId
    $exePath = ($child.CommandLine -replace '^"([^"]+)".*$', '$1')
    $extractDir = Split-Path -Parent (Split-Path -Parent $exePath)
    $ch = Find-AppWindow $childPid 30000
    Check '便携版主窗口出现' ($ch -ne [IntPtr]::Zero)
    if ($ch -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 1200
        $r = New-Object PkgWin+RECT
        [void][PkgWin]::GetWindowRect($ch, [ref]$r)
        Add-Type -AssemblyName System.Drawing
        $bmp = New-Object Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
        $shotDir = Join-Path $root '_verify-out'
        New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
        $shot = Join-Path $shotDir 'portable-run.png'
        $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Check '便携版截图已保存' (Test-Path $shot) $shot
        [void][PkgWin]::PostMessageW($ch, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    $goneApp = $false
    for ($i = 0; $i -lt 100; $i++) {
        if (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) { $goneApp = $true; break }
        Start-Sleep -Milliseconds 200
    }
    Check '关窗后便携版子进程退出' $goneApp
    $gonePack = $false
    for ($i = 0; $i -lt 100; $i++) {
        if (-not (Get-Process -Id $pp.Id -ErrorAction SilentlyContinue)) { $gonePack = $true; break }
        Start-Sleep -Milliseconds 200
    }
    Check '便携启动器随后退出' $gonePack
    Start-Sleep -Seconds 1
    Check '便携版临时解压目录已清理' (-not (Test-Path $extractDir)) $extractDir
}

# ---- 6. 清理自己的测试目录 ----
if (Test-Path $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }

Write-Output ""
if ($script:bad -eq 0) { Write-Output '**结论：交付形态验收全部通过。**'; exit 0 }
else { Write-Output "**结论：有 $($script:bad) 项未通过。**"; exit 1 }
