#      __                      __  ___
#     / /   ____  ____  ____ _/  |/  /__  ____ ___  ____  _______  __
#    / /   / __ \/ __ \/ __ `/ /|_/ / _ \/ __ `__ \/ __ \/ ___/ / / /
#   / /___/ /_/ / / / / /_/ / /  / /  __/ / / / / / /_/ / /  / /_/ /
#  /_____/\____/_/ /_/\__, /_/  /_/\___/_/ /_/ /_/\____/_/   \__, /
#                      /____/                                 /____/
#
#  cavira oss (c) 2026  -  nullure (c) 2026
#  ----------------------------------------------------------
#  file  : start-longmemory.ps1
#  usage : supports LongMemory start longmemory

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $Root 'dist\cli\index.js'
$State = Join-Path $Root '.longmemory'
$Stdout = Join-Path $State 'server.log'
$Stderr = Join-Path $State 'server.err.log'
$Stdin = Join-Path $State 'server.stdin'
$PidFile = Join-Path $State 'server.pid'
$HealthUri = 'http://127.0.0.1:7331/health'

function Resolve-AbsoluteLongMemoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $pathRoot = [System.IO.Path]::GetPathRoot($Value)
    $isWindowsRootRelative = $pathRoot -eq '\' -or $pathRoot -eq '/'
    if (-not [System.IO.Path]::IsPathRooted($Value) -or $isWindowsRootRelative) {
        throw "$Label must be an absolute path."
    }
    return [System.IO.Path]::GetFullPath($Value)
}

$pluginDataValues = @(
    $env:PLUGIN_DATA,
    $env:CLAUDE_PLUGIN_DATA,
    $env:LONGMEMORY_PLUGIN_DATA
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
    Resolve-AbsoluteLongMemoryPath -Value $_.Trim() -Label 'plugin data path'
}

if ($pluginDataValues.Count -gt 0) {
    $PluginData = $pluginDataValues[0]
    foreach ($candidate in $pluginDataValues) {
        if (-not [string]::Equals($candidate, $PluginData, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Plugin data environment variables disagree.'
        }
    }
} else {
    $UserProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $CodexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path $UserProfile '.codex'
    } else {
        Resolve-AbsoluteLongMemoryPath -Value $env:CODEX_HOME.Trim() -Label 'CODEX_HOME'
    }
    $PluginData = Join-Path $CodexHome 'plugins\data\longmemory-longmemory'
}

$Database = if ([string]::IsNullOrWhiteSpace($env:LONGMEMORY_DB_PATH)) {
    Join-Path $PluginData 'central-memory.db'
} else {
    Resolve-AbsoluteLongMemoryPath -Value $env:LONGMEMORY_DB_PATH.Trim() -Label 'LONGMEMORY_DB_PATH'
}

function Invoke-LongMemoryHealth {
    $parameters = @{
        Uri = $HealthUri
        TimeoutSec = 3
        ErrorAction = 'Stop'
    }

    # -NoProxy is available in PowerShell 6+ but not Windows PowerShell 5.1.
    # Detect the parameter instead of assuming which host is running this file.
    $invokeRestMethod = Get-Command Invoke-RestMethod -ErrorAction Stop
    if ($invokeRestMethod.Parameters.ContainsKey('NoProxy')) {
        $parameters.NoProxy = $true
    }

    return Invoke-RestMethod @parameters
}

function Test-LongMemoryHealth {
    try {
        $health = Invoke-LongMemoryHealth
        return [bool]($health.data.ok -and $health.data.status.ready)
    } catch {
        return $false
    }
}

if (Test-LongMemoryHealth) {
    Write-Host 'LongMemory is already healthy at http://127.0.0.1:7331'
    return
}
if (-not (Test-Path -LiteralPath $Entry)) {
    throw 'LongMemory is not built. Run pnpm install and pnpm build first.'
}

New-Item -ItemType Directory -Force -Path $State | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Database) | Out-Null
$env:LONGMEMORY_DB_PATH = $Database
$env:LONGMEMORY_PLUGIN_DATA = $PluginData
$env:LONGMEMORY_HOST = '127.0.0.1'
$env:LONGMEMORY_PORT = '7331'
$env:LONGMEMORY_MCP_HTTP = 'true'
$env:NO_COLOR = '1'
[System.IO.File]::WriteAllText($Stdin, [string]::Empty, [System.Text.Encoding]::ASCII)

$ServerProcess = Start-Process -FilePath $Node `
    -ArgumentList @("`"$Entry`"", 'serve', '--mcp-http') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardInput $Stdin `
    -RedirectStandardOutput $Stdout `
    -RedirectStandardError $Stderr `
    -PassThru

try {
    [System.IO.File]::WriteAllText($PidFile, [string]$ServerProcess.Id, [System.Text.Encoding]::ASCII)
} catch {
    Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
    throw
}

$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $ServerProcess.Refresh()
    if ($ServerProcess.HasExited) {
        break
    }
    if (Test-LongMemoryHealth) {
        Write-Host "LongMemory started at http://127.0.0.1:7331 (PID $($ServerProcess.Id))"
        return
    }
    Start-Sleep -Milliseconds 500
}

if (-not $ServerProcess.HasExited) {
    Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $PidFile) {
    $recordedPid = (Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($recordedPid -eq [string]$ServerProcess.Id) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $Stdin -Force -ErrorAction SilentlyContinue
throw "LongMemory did not become healthy. Check $Stdout and $Stderr."
