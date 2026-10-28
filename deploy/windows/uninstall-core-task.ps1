<#
.SYNOPSIS
    Stops and removes the "Shadow Assistant Core" scheduled task.

.DESCRIPTION
    Stops the task if it is running, unregisters it and then stops any
    ShadowTray.exe started from this repository (e.g. started by hand) and
    any node.exe process still running this repository's core\dist\index.js
    (a child an older run-core.ps1 task may leave behind). Stopping the tray
    app also ends its Core (job object). Log files are kept.
    Nothing is changed with -WhatIf.

.PARAMETER TaskName
    Task name. Default: "Shadow Assistant Core".
.PARAMETER TaskPath
    Task Scheduler folder. Default: \ShadowAssistant\
.PARAMETER RepoRoot
    Repository root, used to find a leftover Core process. Default: SHADOW_REPO_ROOT, else two levels above this script.

.EXAMPLE
    .\uninstall-core-task.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $TaskName = 'Shadow Assistant Core',
    [string] $TaskPath = '\ShadowAssistant\',
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
if (-not $TaskPath.StartsWith('\')) { $TaskPath = '\' + $TaskPath }
if (-not $TaskPath.EndsWith('\')) { $TaskPath = $TaskPath + '\' }

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output "Task $TaskPath$TaskName is not registered."
}
else {
    if ($task.State -eq 'Running' -and $PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Stop running task')) {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    }
    if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
        Write-Output "Removed $TaskPath$TaskName."
    }
}

# A tray app started from this repo (task or by hand). Killing it closes its
# job object, which ends its Core too; the node.exe check below then finds nothing.
& { $WhatIfPreference = $false; Import-Module CimCmdlets }
$trayDir = Join-Path $PSScriptRoot 'tray'
$trays = @(Get-CimInstance Win32_Process -Filter "Name = 'ShadowTray.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($trayDir + '\',[StringComparison]::OrdinalIgnoreCase)) -or
        ($_.CommandLine -and $_.CommandLine.IndexOf("`"$RepoRoot`"", [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
foreach ($p in $trays) {
    if ($PSCmdlet.ShouldProcess("ShadowTray.exe PID $($p.ProcessId)", 'Stop process')) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped tray app $($p.ProcessId)."
    }
}
if ($trays) { Start-Sleep -Seconds 1 }

# A Core started by the task (or by hand) from this repo.
$entry = Join-Path $RepoRoot 'core\dist\index.js'
$leftover = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($p in $leftover) {
    if ($PSCmdlet.ShouldProcess("node.exe PID $($p.ProcessId) ($entry)", 'Stop process')) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped Core process $($p.ProcessId)."
    }
}
