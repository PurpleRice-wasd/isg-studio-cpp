<#
    跑 isg-studio 的自测并打印结果。

    为什么单独一个脚本（而不是在命令行里 `& exe --selftest=...`）：
    isg-studio 是 **WIN32 子系统**程序，PowerShell 的 `&` **不会等它**
    —— 第一次跑会发现"没有任何输出、$LASTEXITCODE 是空的"，一度以为程序没起来。
    正确的等法是 Start-Process -Wait 或 .NET Process + WaitForExit()。
    （Phase 0 还踩过更细的一层：Start-Process -Wait 会连**整棵进程树**一起等，
    而 WebView2 的浏览器进程要磨蹭几秒 —— 所以下面用的是 .NET Process。）

    用法：
        powershell -File tools\run-selftests.ps1                    # 跑全部（含 ui）
        powershell -File tools\run-selftests.ps1 -Only settings,bridge
        powershell -File tools\run-selftests.ps1 -Exe <路径>
#>
[CmdletBinding()]
param(
    [string]$Exe = '',
    [string[]]$Only = @(),
    [string]$OutDir = '',
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_guard.ps1')

$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) {
    foreach ($cand in @('build\dist\isg-studio.exe', 'build2\dist\isg-studio.exe', 'build3\dist\isg-studio.exe')) {
        $p = Join-Path $root $cand
        if (Test-Path $p) { $Exe = $p; break }
    }
}
if (-not $Exe -or -not (Test-Path $Exe)) { throw "找不到 isg-studio.exe（用 -Exe 指定）" }
if (-not $OutDir) { $OutDir = Join-Path $root '_selftest-out' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$all = @('settings', 'background', 'env', 'key-leak', 'bridge', 'protocol', 'protocol-live', 'probe', 'ui')
$tests = if ($Only.Count) { $Only } else { $all }

function Invoke-One([string]$name) {
    $report = Join-Path $OutDir "$name.json"
    Remove-GuardedFile -Path $report -AllowedRoot $OutDir
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = "--selftest=$name --report=`"$report`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    # 读干净两个管道，否则子进程写满缓冲区会卡住
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    # ⚠️ **必须有超时**：这个应用会起 WebView2 与系统对话框，真挂住的时候
    #    "跑不完"如果不被报出来，整套验证就会静静地卡在那里（比报告红还难查）。
    $timedOut = $false
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        $timedOut = $true
        try { $proc.Kill() } catch { }
        $proc.WaitForExit(5000) | Out-Null
    }
    return @{ exit = $proc.ExitCode; report = $report; stdout = $stdout; stderr = $stderr; timeout = $timedOut }
}

$failed = 0
foreach ($t in $tests) {
    # `-Only` 的名字来自命令行，会被拼进报告路径再删 —— 形态先卡住
    if ($t -notmatch '^[a-z][a-z-]*$') { throw "-Only 只接受小写字母与连字符的自测名，收到的是 '$t'" }
    $r = Invoke-One $t
    $ok = $false
    $summary = ''
    if ($r.timeout) {
        Write-Output ("[BAD] {0,-11} 超时（{1} 秒没退出，已强杀）" -f $t, $TimeoutSec)
        $failed++
        continue
    }
    if (Test-Path $r.report) {
        $j = [System.IO.File]::ReadAllText($r.report, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        # ⚠️ **不信程序自报的 ok 布尔**（Phase 0 的原话：通过条件如果就是被测程序自己算的那个布尔，
        # 这一条等价于"它说它对"）。这里自己数 `[BAD]` 行，并要求"确实跑过判据"。
        # 只数一处：ui 的结果会被宿主原样搬进 root.lines，两边都数就是双倍
        $lines = @()
        $sr = $null
        if ($j.PSObject.Properties.Name -contains 'selftestResult') { $sr = $j.selftestResult }
        if ($sr -and ($sr.PSObject.Properties.Name -contains 'lines')) { $lines = @($sr.lines) }
        elseif ($j.PSObject.Properties.Name -contains 'groups') { foreach ($g in @($j.groups)) { $lines += @($g.lines) } }
        elseif ($j.PSObject.Properties.Name -contains 'lines') { $lines = @($j.lines) }
        $badLines = @($lines | Where-Object { $_ -match '\[BAD\]' }).Count
        $checked = @($lines | Where-Object { $_ -match '\[ok\]|\[BAD\]' }).Count
        $ok = ($badLines -eq 0) -and ($checked -gt 0)
        $summary = "checked=$checked bad=$badLines"
        # 逐条打印没过的（并留下实际值 —— 「某几项没过」这种话没有信息量）
        foreach ($line in $lines) {
            if ($line -match '\[BAD\]') { Write-Output "        $line" }
        }
    } else {
        $summary = '没有产出报告'
        if ($r.stderr) { Write-Output $r.stderr.Trim() }
    }
    if ($ok -and $r.exit -eq 0) { $mark = '[ok] ' } else { $mark = '[BAD]'; $failed++ }
    Write-Output ("{0} {1,-11} exit={2} {3}" -f $mark, $t, $r.exit, $summary)
}

Write-Output ''
$msg = if ($failed) { "=== $failed 套自测没过 ===" } else { '=== 全部通过 ===' }
Write-Output $msg
if ($failed) { exit 1 } else { exit 0 }
