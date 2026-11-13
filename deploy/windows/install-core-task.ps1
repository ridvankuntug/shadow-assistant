<#
.SYNOPSIS
    Registers the "Shadow Assistant Core" scheduled task for the current user.

.DESCRIPTION
    The task starts the Shadow Assistant tray app (ShadowTray.exe, see
    deploy\windows\tray\README.md) when the current user signs in, in that
    user's own interactive session (LogonType Interactive, RunLevel Limited).
    The tray app runs node core\dist\index.js directly - no PowerShell or
    cmd.exe in between and no console window - supervises it and shows its
    status in the notification area.

    It does not run as SYSTEM or as a service account: the Claude Agent SDK
    uses the Claude Code login stored in the user's profile, which a different
    account cannot see. See docs/05-deploy.md.

    Crash handling is done by the tray app (exponential backoff, gives up after
    repeated short runs). The task's own restart setting (RestartCount /
    RestartInterval) is only a second line of defence for when the tray app
    itself fails. The task has no execution time limit and ignores a second
    start while it is already running.

    Build the tray app first (dotnet publish, see docs/05-deploy.md).
    Administrator rights are not needed for a task that runs as the current
    user only. Nothing is registered with -WhatIf.

    run-core.ps1 is no longer used by the task; it stays as a manual fallback
    (e.g. when the .NET runtime is missing).

.PARAMETER TaskName
    Task name. Default: "Shadow Assistant Core".
.PARAMETER TaskPath
    Task Scheduler folder. Default: \ShadowAssistant\
.PARAMETER TrayPath
    ShadowTray.exe to start. Default: tray\publish\ShadowTray.exe next to this script.
.PARAMETER RepoRoot
    Repository root passed to the tray app. Default: SHADOW_REPO_ROOT, else two levels above this script.
.PARAMETER NodePath
    node.exe passed to the tray app. Default: SHADOW_NODE_PATH, else `node` from PATH at install time.
.PARAMETER LogDir
    Log folder passed to the tray app. Default: the tray app's default (%LOCALAPPDATA%\ShadowAssistant\logs).
.PARAMETER LogonDelaySeconds
    Delay after sign-in before the tray app starts (lets the network come up). Default: 30.
.PARAMETER Force
    Replace an existing task with the same name.
.PARAMETER StartNow
    Start the task right after registering it.
.PARAMETER NoShortcut
    Do not create the Start menu shortcut.
.PARAMETER ShortcutOnly
    Only create (or refresh) the Start menu shortcut; the task is left as it is.

.NOTES
    Start menu shortcut: "Shadow Assistant" in the current user's Start menu
    Programs folder. It starts the task (schtasks /run), not the exe, so a
    start by hand uses the same arguments as the sign-in start; a second start
    while the task runs is ignored. uninstall-core-task.ps1 removes it.

.EXAMPLE
    .\install-core-task.ps1 -WhatIf
.EXAMPLE
    .\install-core-task.ps1 -StartNow
.EXAMPLE
    .\install-core-task.ps1 -ShortcutOnly
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $TaskName = 'Shadow Assistant Core',
    [string] $TaskPath = '\ShadowAssistant\',
    [string] $TrayPath,
    [string] $RepoRoot,
    [string] $NodePath,
    [string] $LogDir,
    [ValidateRange(0, 3600)] [int] $LogonDelaySeconds = 30,
    [switch] $Force,
    [switch] $StartNow,
    [switch] $NoShortcut,
    [switch] $ShortcutOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Install-StartMenuShortcut([string] $TaskFullName, [string] $IconPath) {
    $programs = [Environment]::GetFolderPath('Programs')
    $link = Join-Path $programs 'Shadow Assistant.lnk'
    $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
    if (-not $PSCmdlet.ShouldProcess($link, 'Create Start menu shortcut')) { return }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $sc = $shell.CreateShortcut($link)
        $sc.TargetPath = $schtasks
        $sc.Arguments = "/run /tn `"$TaskFullName`""
        $sc.WindowStyle = 7  # minimised: schtasks is a console program
        $sc.Description = 'Shadow Assistant tepsi uygulamasını başlatır (zamanlanmış görev).'
        if (Test-Path -LiteralPath $IconPath -PathType Leaf) { $sc.IconLocation = "$IconPath,0" }
        $sc.Save()
    }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    Write-Output "Start menu shortcut: $link"
}

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
if (-not $NodePath) { $NodePath = $env:SHADOW_NODE_PATH }
if (-not $NodePath) {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $NodePath = $cmd.Source }
}
if ($LogDir) { $LogDir = [IO.Path]::GetFullPath($LogDir).TrimEnd('\') }
if (-not $TrayPath) { $TrayPath = Join-Path $PSScriptRoot 'tray\publish\ShadowTray.exe' }
$TrayPath = [IO.Path]::GetFullPath($TrayPath)

if (-not $TaskPath.StartsWith('\')) { $TaskPath = '\' + $TaskPath }
if (-not $TaskPath.EndsWith('\')) { $TaskPath = $TaskPath + '\' }

if ($ShortcutOnly) {
    if (-not (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue)) {
        throw "Task $TaskPath$TaskName is not registered; install it first (without -ShortcutOnly)."
    }
    Install-StartMenuShortcut "$TaskPath$TaskName" $TrayPath
    return
}

# Same checks the tray app makes before starting the Core.
$problems = @()
if (-not (Test-Path -LiteralPath $TrayPath -PathType Leaf)) {
    $problems += "Tray app not built: $TrayPath is missing (see 'Build the tray app' in docs/05-deploy.md, or pass -TrayPath)."
}
if (-not $NodePath) { $problems += 'node.exe not found: install Node.js 22+ or pass -NodePath / set SHADOW_NODE_PATH.' }
elseif (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { $problems += "NodePath does not exist: $NodePath" }
if (-not ((Test-Path -LiteralPath (Join-Path $RepoRoot 'core') -PathType Container) -and
        (Test-Path -LiteralPath (Join-Path $RepoRoot 'services.yaml') -PathType Leaf))) {
    $problems += "RepoRoot does not look like the repository (no core\ and services.yaml): $RepoRoot"
}
elseif (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'core\dist\index.js') -PathType Leaf)) {
    $problems += "Core is not built: core\dist\index.js is missing (run 'npm ci' and 'npm run build' in core\)."
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.env') -PathType Leaf) -and -not $env:SHADOW_ENV_FILE) {
    Write-Warning "no .env in $RepoRoot (the Core will refuse to start without device tokens)"
}
if ($problems) {
    foreach ($p in $problems) { Write-Warning $p }
    throw 'Fix the problems above before installing the task.'
}

# The task starts the exe itself: no PowerShell, no console window. Each value
# is quoted; paths cannot contain '"' on Windows.
$argList = @('--repo-root', "`"$RepoRoot`"")
if ($NodePath) { $argList += @('--node-path', "`"$NodePath`"") }
if ($LogDir) { $argList += @('--log-dir', "`"$LogDir`"") }
$arguments = $argList -join ' '

$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $TrayPath -Argument $arguments -WorkingDirectory $RepoRoot
# -User ties the trigger to this account; a trigger for "any user" would need admin rights.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
if ($LogonDelaySeconds -gt 0) { $trigger.Delay = 'PT{0}S' -f $LogonDelaySeconds }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$description = 'Shadow Assistant Core (tray app ShadowTray.exe). Installed by deploy/windows/install-core-task.ps1.'

Write-Output "Task      : $TaskPath$TaskName"
Write-Output "Runs as   : $userId (interactive session, not elevated), at sign-in + $LogonDelaySeconds s"
Write-Output "Command   : `"$TrayPath`" $arguments"
Write-Output "Settings  : no time limit, ignore second start, task restart 3x every 5 min (the tray app handles Core crashes)"

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

if (-not $NoShortcut) { Install-StartMenuShortcut "$TaskPath$TaskName" $TrayPath }

if ($StartNow -and $PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Start scheduled task')) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-Output 'Started. The tray icon shows the Core status; its menu opens the log folder.'
}
