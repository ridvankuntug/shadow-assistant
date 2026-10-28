<#
.SYNOPSIS
    Runs the Shadow Assistant Core (node core/dist/index.js) in a supervised loop.

.DESCRIPTION
    Started by the "Shadow Assistant Core" scheduled task (install-core-task.ps1)
    at logon, in the signed-in user's own session, so the Claude Agent SDK can use
    the user's Claude Code login. Can also be run by hand.

    - Restarts the Core when it exits with a non-zero code, with exponential
      backoff (InitialDelaySeconds doubling up to MaxDelaySeconds). The delay
      resets after the Core has stayed up for StableSeconds. After MaxFailures
      consecutive short-lived runs the wrapper gives up and exits 1.
    - Exit code 0 from the Core (clean shutdown, e.g. Ctrl+C) ends the wrapper.
    - Writes the Core's stdout/stderr plus its own messages to <LogDir>\core.log,
      rotated at MaxLogBytes, keeping MaxLogFiles old files (core.1.log ...).
    - Only one wrapper per user session runs at a time (named mutex).

    The Core itself reads the repo-root .env, services.yaml and router.yaml.

    Every parameter can also be set through an environment variable (the
    parameter wins): SHADOW_REPO_ROOT, SHADOW_NODE_PATH, SHADOW_CORE_LOG_DIR.

.PARAMETER RepoRoot
    Repository root (contains core\dist\index.js). Default: two levels above this script.
.PARAMETER NodePath
    node.exe to use. Default: SHADOW_NODE_PATH, else `node` from PATH.
.PARAMETER LogDir
    Log folder. Default: SHADOW_CORE_LOG_DIR, else %LOCALAPPDATA%\ShadowAssistant\logs.
.PARAMETER DryRun
    Resolve and validate everything, print the command, do not start the Core.

.EXAMPLE
    .\run-core.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string] $RepoRoot,
    [string] $NodePath,
    [string] $LogDir,
    [ValidateRange(1, 3600)] [int] $InitialDelaySeconds = 5,
    [ValidateRange(1, 86400)] [int] $MaxDelaySeconds = 300,
    [ValidateRange(1, 86400)] [int] $StableSeconds = 600,
    [ValidateRange(1, 1000)] [int] $MaxFailures = 20,
    [ValidateRange(65536, 1073741824)] [long] $MaxLogBytes = 10MB,
    [ValidateRange(1, 50)] [int] $MaxLogFiles = 5,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Setting([string] $Value, [string] $EnvName, [scriptblock] $Default) {
    if ($Value) { return $Value }
    $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
    if ($fromEnv) { return $fromEnv }
    return & $Default
}

$RepoRoot = Get-Setting $RepoRoot 'SHADOW_REPO_ROOT' { Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$NodePath = Get-Setting $NodePath 'SHADOW_NODE_PATH' {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $cmd.Source } else { $null }
}
$LogDir = Get-Setting $LogDir 'SHADOW_CORE_LOG_DIR' { Join-Path $env:LOCALAPPDATA 'ShadowAssistant\logs' }
$LogDir = [IO.Path]::GetFullPath($LogDir)
$entry = Join-Path $RepoRoot 'core\dist\index.js'
$logFile = Join-Path $LogDir 'core.log'

# --- logging -----------------------------------------------------------------

$script:writer = $null

function Open-Log {
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    # FileShare.ReadWrite: the log can be tailed (Get-Content -Wait) while we write.
    $stream = [IO.File]::Open($logFile, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $script:writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
    $script:writer.AutoFlush = $true
}

function Step-LogRotation {
    if ($script:writer.BaseStream.Length -lt $MaxLogBytes) { return }
    $script:writer.Dispose()
    for ($i = $MaxLogFiles; $i -ge 1; $i--) {
        $src = if ($i -eq 1) { $logFile } else { Join-Path $LogDir ("core.{0}.log" -f ($i - 1)) }
        $dst = Join-Path $LogDir ("core.{0}.log" -f $i)
        if (Test-Path -LiteralPath $src) { Move-Item -LiteralPath $src -Destination $dst -Force }
    }
    Open-Log
}

function Write-Log([string] $Message) {
    $line = '{0} [run-core] {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz'), $Message
    if ($script:writer) {
        $script:writer.WriteLine($line)
        Step-LogRotation
    }
    Write-Verbose $line
}

function Write-CoreOutput([string] $Line) {
    $script:writer.WriteLine($Line)
    Step-LogRotation
}

# --- validation --------------------------------------------------------------

$problems = @()
if (-not $NodePath) { $problems += 'node.exe not found: install Node.js 22+ or pass -NodePath / set SHADOW_NODE_PATH.' }
elseif (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { $problems += "NodePath does not exist: $NodePath" }
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { $problems += "Core is not built: $entry is missing (run 'npm ci' and 'npm run build' in core\)." }
$envFile = if ($env:SHADOW_ENV_FILE) { $env:SHADOW_ENV_FILE } else { Join-Path $RepoRoot '.env' }
$envWarning = if (Test-Path -LiteralPath $envFile) { $null } else { "no .env at $envFile (the Core will refuse to start without device tokens)" }

if ($DryRun) {
    Write-Output "RepoRoot : $RepoRoot"
    Write-Output "Node     : $NodePath"
    Write-Output "Entry    : $entry"
    Write-Output "Log file : $logFile (rotates at $MaxLogBytes bytes, keeps $MaxLogFiles)"
    Write-Output ("Restart  : backoff {0}s doubling to {1}s, reset after {2}s up, give up after {3} short runs" -f $InitialDelaySeconds, $MaxDelaySeconds, $StableSeconds, $MaxFailures)
    Write-Output "Command  : `"$NodePath`" `"$entry`"   (working directory $RepoRoot)"
    if ($envWarning) { Write-Warning $envWarning }
    foreach ($p in $problems) { Write-Warning $p }
    if ($problems) { exit 1 }
    Write-Output 'Dry run: nothing started.'
    exit 0
}

# --- single instance ---------------------------------------------------------

$mutex = New-Object Threading.Mutex($false, 'Local\ShadowAssistantCoreRunner')
$haveMutex = $false
try { $haveMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $haveMutex = $true }

Open-Log
try {
    if (-not $haveMutex) {
        Write-Log 'another run-core instance is already running in this session; exiting.'
        exit 0
    }
    if ($problems) {
        foreach ($p in $problems) { Write-Log "error: $p" }
        exit 1
    }
    if ($envWarning) { Write-Log "warning: $envWarning" }

    # Node writes UTF-8; decode it as UTF-8 (Turkish text in logs).
    try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { Write-Log "warning: could not set console encoding: $($_.Exception.Message)" }

    Set-Location -LiteralPath $RepoRoot
    $delay = $InitialDelaySeconds
    $failures = 0
    while ($true) {
        Write-Log "starting Core: `"$NodePath`" `"$entry`""
        $started = Get-Date
        # 2>&1 merges stderr into the pipeline; with 'Stop' Windows PowerShell 5.1
        # would turn the first stderr line into a terminating error.
        $ErrorActionPreference = 'Continue'
        & $NodePath $entry 2>&1 | ForEach-Object { Write-CoreOutput ([string]$_) }
        $code = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        $upSeconds = [int]((Get-Date) - $started).TotalSeconds

        if ($code -eq 0) {
            Write-Log "Core exited cleanly (code 0) after ${upSeconds}s; not restarting."
            exit 0
        }
        if ($upSeconds -ge $StableSeconds) {
            $delay = $InitialDelaySeconds
            $failures = 0
        }
        $failures++
        if ($failures -ge $MaxFailures) {
            Write-Log "Core failed $failures times in a row (last code $code); giving up. Fix the cause (see above), then restart the task."
            exit 1
        }
        Write-Log "Core exited with code $code after ${upSeconds}s; restart $failures/$($MaxFailures - 1) in ${delay}s."
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min($delay * 2, $MaxDelaySeconds)
    }
}
finally {
    if ($haveMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
    if ($script:writer) { $script:writer.Dispose() }
}
