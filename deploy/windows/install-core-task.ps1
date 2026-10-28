<#
.SYNOPSIS
    Registers the "Shadow Assistant Core" scheduled task for the current user.

.DESCRIPTION
    The task starts deploy\windows\run-core.ps1 when the current user signs in,
    in that user's own interactive session (LogonType Interactive, RunLevel
    Limited). It does not run as SYSTEM or as a service account: the Claude
    Agent SDK uses the Claude Code login stored in the user's profile, which a
    different account cannot see. See docs/05-deploy.md.

    Crash handling is done by run-core.ps1 (exponential backoff, gives up after
    repeated short runs). The task's own restart setting (RestartCount /
    RestartInterval) is only a second line of defence for when the wrapper
    itself fails. The task has no execution time limit and ignores a second
    start while it is already running.

    Administrator rights are not needed for a task that runs as the current
    user only. Nothing is registered with -WhatIf.

.PARAMETER TaskName
    Task name. Default: "Shadow Assistant Core".
.PARAMETER TaskPath
    Task Scheduler folder. Default: \ShadowAssistant\
.PARAMETER RepoRoot
    Repository root passed to run-core.ps1. Default: SHADOW_REPO_ROOT, else two levels above this script.
.PARAMETER NodePath
    node.exe passed to run-core.ps1. Default: SHADOW_NODE_PATH, else `node` from PATH at install time.
.PARAMETER LogDir
    Log folder passed to run-core.ps1. Default: run-core.ps1's default (%LOCALAPPDATA%\ShadowAssistant\logs).
.PARAMETER LogonDelaySeconds
    Delay after sign-in before the Core starts (lets the network come up). Default: 30.
.PARAMETER Force
    Replace an existing task with the same name.
.PARAMETER StartNow
    Start the task right after registering it.

.EXAMPLE
    .\install-core-task.ps1 -WhatIf
.EXAMPLE
    .\install-core-task.ps1 -StartNow
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $TaskName = 'Shadow Assistant Core',
    [string] $TaskPath = '\ShadowAssistant\',
    [string] $RepoRoot,
    [string] $NodePath,
    [string] $LogDir,
    [ValidateRange(0, 3600)] [int] $LogonDelaySeconds = 30,
    [switch] $Force,
    [switch] $StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
if (-not $NodePath) { $NodePath = $env:SHADOW_NODE_PATH }
if (-not $NodePath) {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $NodePath = $cmd.Source }
}
if ($LogDir) { $LogDir = [IO.Path]::GetFullPath($LogDir).TrimEnd('\') }

$runCore = Join-Path $PSScriptRoot 'run-core.ps1'
if (-not (Test-Path -LiteralPath $runCore -PathType Leaf)) { throw "run-core.ps1 not found next to this script: $runCore" }
if (-not $TaskPath.StartsWith('\')) { $TaskPath = '\' + $TaskPath }
if (-not $TaskPath.EndsWith('\')) { $TaskPath = $TaskPath + '\' }

# Validate with the wrapper's own dry run, so install-time and run-time
# checks are the same code. It exits 1 when node or core\dist is missing.
$dryArgs = @{ RepoRoot = $RepoRoot; DryRun = $true }
if ($NodePath) { $dryArgs.NodePath = $NodePath }
if ($LogDir) { $dryArgs.LogDir = $LogDir }
& $runCore @dryArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "run-core.ps1 -DryRun reported problems (see warnings above). Fix them before installing the task."
}

# Windows PowerShell 5.1 is always present; the task does not depend on pwsh.
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# -ExecutionPolicy Bypass applies to this one process only; it is needed when
# the machine policy is Restricted or the repo files carry a download mark.
$argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', "`"$runCore`"", '-RepoRoot', "`"$RepoRoot`"")
if ($NodePath) { $argList += @('-NodePath', "`"$NodePath`"") }
if ($LogDir) { $argList += @('-LogDir', "`"$LogDir`"") }
$arguments = $argList -join ' '

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $RepoRoot
# -User ties the trigger to this account; a trigger for "any user" would need admin rights.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
if ($LogonDelaySeconds -gt 0) { $trigger.Delay = 'PT{0}S' -f $LogonDelaySeconds }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$description = 'Shadow Assistant Core (run-core.ps1). Installed by deploy/windows/install-core-task.ps1.'

Write-Output "Task      : $TaskPath$TaskName"
Write-Output "Runs as   : $userId (interactive session, not elevated), at sign-in + $LogonDelaySeconds s"
Write-Output "Command   : $psExe $arguments"
Write-Output "Settings  : no time limit, ignore second start, task restart 3x every 5 min (run-core.ps1 handles crashes)"

$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    throw "Task $TaskPath$TaskName already exists. Re-run with -Force to replace it, or run uninstall-core-task.ps1 first."
}

$verb = if ($existing) { 'Replace scheduled task' } else { 'Register scheduled task' }
if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", $verb)) {
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
    try {
        Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null
    }
    catch [Microsoft.Management.Infrastructure.CimException] {
        throw "Registering the task failed: $($_.Exception.Message). If this is 'Access is denied', see Troubleshooting in docs/05-deploy.md."
    }
    Write-Output "Registered $TaskPath$TaskName."
}

if ($StartNow -and $PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Start scheduled task')) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-Output "Started. Log: run '$runCore -DryRun' to see the log file path."
}
