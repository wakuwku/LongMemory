#      __                      __  ___
#     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
#    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
#   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
#  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
#                      /____/                                 /____/
#
#  cavira oss (c) 2026  -  nullure (c) 2026
#  ----------------------------------------------------------
#  file  : stop-longmemory.ps1
#  usage : supports LongMemory stop longmemory

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$State = Join-Path $Root '.longmemory'
$PidFile = Join-Path $State 'server.pid'
$Stdin = Join-Path $State 'server.stdin'

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'No repository LongMemory PID file was found.'
    return
}

$rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
$ServerProcessId = 0
if (-not [int]::TryParse($rawPid, [ref]$ServerProcessId) -or $ServerProcessId -le 0) {
    throw "LongMemory PID file is invalid: $PidFile"
}
if ($ServerProcessId -eq $PID) {
    throw 'LongMemory PID file points to the current PowerShell process; refusing to stop it.'
}

$pidFileInfo = Get-Item -LiteralPath $PidFile
try {
    $ServerProcess = Get-Process -Id $ServerProcessId -ErrorAction Stop
} catch {
    Remove-Item -LiteralPath $PidFile -Force
    Remove-Item -LiteralPath $Stdin -Force -ErrorAction SilentlyContinue
    Write-Host "Removed stale LongMemory PID file for process $ServerProcessId."
    return
}

if ($ServerProcess.ProcessName -ine 'node') {
    throw "PID $ServerProcessId is $($ServerProcess.ProcessName), not node; refusing to stop it."
}

$expectedNode = (Get-Command node.exe -ErrorAction Stop).Source
$actualNode = $ServerProcess.Path
if ($actualNode -and -not [string]::Equals(
    [System.IO.Path]::GetFullPath($actualNode),
    [System.IO.Path]::GetFullPath($expectedNode),
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw "PID $ServerProcessId uses an unexpected Node executable; refusing to stop it."
}

# The PID file is written immediately after Start-Process. Comparing timestamps
# prevents a stale PID file from killing a later process that reused the same ID.
$startedAt = $ServerProcess.StartTime.ToUniversalTime()
$recordedAt = $pidFileInfo.LastWriteTimeUtc
if ([Math]::Abs(($recordedAt - $startedAt).TotalSeconds) -gt 60) {
    throw "PID $ServerProcessId did not start with this PID file; refusing to stop it."
}

Stop-Process -Id $ServerProcessId -Force
Remove-Item -LiteralPath $PidFile -Force
Remove-Item -LiteralPath $Stdin -Force -ErrorAction SilentlyContinue
Write-Host "Stopped LongMemory process $ServerProcessId."
