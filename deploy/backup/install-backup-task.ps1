<#
.SYNOPSIS
    Registers a daily scheduled task that runs backup-data.ps1 as the current user.

.DESCRIPTION
    Runs in the current user's interactive session (rclone.conf and the Drive
    OAuth token live in that profile), not elevated. If the PC is off or nobody
    is signed in at the set time, the task runs at the next opportunity
    (StartWhenAvailable). backup-data.ps1 reads its settings, including the
    crypt passwords, from the environment or the repo-root .env.
    Nothing is registered with -WhatIf. Remove with -Uninstall.

.EXAMPLE
    .\install-backup-task.ps1 -At 03:30 -WhatIf
.EXAMPLE
    .\install-backup-task.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $TaskName = 'Shadow Assistant Backup',
    [string] $TaskPath = '\ShadowAssistant\',
    [ValidatePattern('^\d{1,2}:\d{2}$')] [string] $At = '03:30',
    [string] $RepoRoot,
    [switch] $Force,
    [switch] $Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $TaskPath.StartsWith('\')) { $TaskPath = '\' + $TaskPath }
if (-not $TaskPath.EndsWith('\')) { $TaskPath = $TaskPath + '\' }
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue

if ($Uninstall) {
    if (-not $existing) { Write-Output "Task $TaskPath$TaskName is not registered."; return }
    if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
        Write-Output "Removed $TaskPath$TaskName."
    }
    return
}

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
$script = Join-Path $PSScriptRoot 'backup-data.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -RepoRoot "{1}"' -f $script, $RepoRoot
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$time = [datetime]::ParseExact($At.PadLeft(5, '0'), 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)

$action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

Write-Output "Task    : $TaskPath$TaskName"
Write-Output "Runs as : $userId (interactive session, not elevated), daily at $At"
Write-Output "Command : $psExe $arguments"

if ($existing -and -not $Force) { throw "Task $TaskPath$TaskName already exists. Re-run with -Force to replace it." }
if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Register scheduled task')) {
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'Shadow Assistant data backup. Installed by deploy/backup/install-backup-task.ps1.'
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task -Force | Out-Null
    Write-Output "Registered $TaskPath$TaskName."
}
