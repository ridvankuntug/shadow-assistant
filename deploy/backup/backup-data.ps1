<#
.SYNOPSIS
    Backs up the Shadow Assistant data folder to an encrypted rclone remote.

.DESCRIPTION
    1. Packs the data folder (SHADOW_DATA_DIR, else <SHADOW_VAULT_DIR>\.shadow-assistant)
       into <LocalDir>\shadow-assistant-data-YYYYMMDD-HHMMSS.tar.gz.
    2. Copies the archive to the rclone crypt remote (file and folder names are
       encrypted too), which sits on a Google Drive remote (scope drive.file).
    3. Deletes archives older than RemoteDays on the remote, and keeps only the
       newest LocalKeep archives locally.

    Settings: parameter, else environment variable, else repo-root .env, else
    default. The crypt passwords are read only from SHADOW_BACKUP_CRYPT_PASSWORD
    and SHADOW_BACKUP_CRYPT_SALT (environment or .env) and are never logged.
    See backup-common.ps1 for why they are not kept in rclone.conf, and
    docs/05-deploy.md for the one-time remote setup.

    -WhatIf checks rclone and the remotes and prints the plan; it writes,
    uploads and deletes nothing.

.PARAMETER DataDir           Folder to back up. Env: SHADOW_DATA_DIR (fallback SHADOW_VAULT_DIR\.shadow-assistant).
.PARAMETER LocalDir          Where archives are written. Env: SHADOW_BACKUP_LOCAL_DIR. Default %LOCALAPPDATA%\ShadowAssistant\backups.
.PARAMETER LocalKeep         Archives kept locally. Env: SHADOW_BACKUP_LOCAL_KEEP. Default 3.
.PARAMETER RemoteDays        Days archives are kept on the remote; 0 = never delete. Env: SHADOW_BACKUP_REMOTE_DAYS. Default 60.
.PARAMETER DriveRemote       rclone Google Drive remote name. Env: SHADOW_BACKUP_DRIVE_REMOTE. Default gdrive.
.PARAMETER DrivePath         Folder on that remote holding the encrypted files. Env: SHADOW_BACKUP_DRIVE_PATH. Default shadow-assistant-backup.
.PARAMETER CryptRemote       Name of the crypt remote. Env: SHADOW_BACKUP_CRYPT_REMOTE. Default shadowcrypt.
.PARAMETER RclonePath        rclone.exe. Env: SHADOW_BACKUP_RCLONE_PATH. Default: PATH, else the winget install folder.
.PARAMETER RcloneConfig      rclone.conf to use. Env: SHADOW_BACKUP_RCLONE_CONFIG. Default: rclone's own default.
.PARAMETER LogDir            Log folder (backup.log). Env: SHADOW_BACKUP_LOG_DIR. Default %LOCALAPPDATA%\ShadowAssistant\logs.
.PARAMETER RepoRoot          Repo root, for .env. Env: SHADOW_REPO_ROOT. Default two levels above this script.

.EXAMPLE
    .\backup-data.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $DataDir,
    [string] $LocalDir,
    [string] $LocalKeep,
    [string] $RemoteDays,
    [string] $DriveRemote,
    [string] $DrivePath,
    [string] $CryptRemote,
    [string] $RclonePath,
    [string] $RcloneConfig,
    [string] $LogDir,
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$dot = Read-ShadowDotEnv $RepoRoot

$DataDir = Resolve-ShadowDataDir $DataDir $dot $RepoRoot
$LocalDir = [IO.Path]::GetFullPath((Get-ShadowSetting $LocalDir 'SHADOW_BACKUP_LOCAL_DIR' $dot (Join-Path $env:LOCALAPPDATA 'ShadowAssistant\backups')))
$keepText = Get-ShadowSetting $LocalKeep 'SHADOW_BACKUP_LOCAL_KEEP' $dot '3'
$daysText = Get-ShadowSetting $RemoteDays 'SHADOW_BACKUP_REMOTE_DAYS' $dot '60'
$keep = 0; $days = 0
if (-not [int]::TryParse($keepText, [ref]$keep) -or $keep -lt 1) { throw "LocalKeep must be a whole number >= 1 (got '$keepText')." }
if (-not [int]::TryParse($daysText, [ref]$days) -or $days -lt 0) { throw "RemoteDays must be a whole number >= 0 (got '$daysText')." }
$DriveRemote = Get-ShadowSetting $DriveRemote 'SHADOW_BACKUP_DRIVE_REMOTE' $dot 'gdrive'
$DrivePath = Get-ShadowSetting $DrivePath 'SHADOW_BACKUP_DRIVE_PATH' $dot 'shadow-assistant-backup'
$CryptRemote = Get-ShadowSetting $CryptRemote 'SHADOW_BACKUP_CRYPT_REMOTE' $dot 'shadowcrypt'
$RcloneConfig = Get-ShadowSetting $RcloneConfig 'SHADOW_BACKUP_RCLONE_CONFIG' $dot $null
$LogDir = Get-ShadowSetting $LogDir 'SHADOW_BACKUP_LOG_DIR' $dot (Join-Path $env:LOCALAPPDATA 'ShadowAssistant\logs')
$logFile = Join-Path ([IO.Path]::GetFullPath($LogDir)) 'backup.log'

$rclone = Find-ShadowRclone (Get-ShadowSetting $RclonePath 'SHADOW_BACKUP_RCLONE_PATH' $dot $null)
$cfgArgs = @()
if ($RcloneConfig) { $cfgArgs = @('--config', $RcloneConfig) }
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "tar.exe not found at $tar (it ships with Windows 10 1803 and later)." }
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { throw "Data folder does not exist: $DataDir" }

$name = '{0}{1}{2}' -f $ShadowBackupPrefix, (Get-Date -Format 'yyyyMMdd-HHmmss'), $ShadowBackupSuffix
$archive = Join-Path $LocalDir $name
$target = "${CryptRemote}:"

try {
    $mode = Initialize-ShadowCryptRemote -Rclone $rclone -ConfigArgs $cfgArgs -DriveRemote $DriveRemote -DrivePath $DrivePath `
        -CryptRemote $CryptRemote `
        -Password (Get-ShadowSetting $null 'SHADOW_BACKUP_CRYPT_PASSWORD' $dot $null) `
        -Salt (Get-ShadowSetting $null 'SHADOW_BACKUP_CRYPT_SALT' $dot $null)

    Write-ShadowBackupLog $logFile "backup start: $DataDir -> $archive -> $target (crypt remote from $mode; remote keeps $days days, local keeps $keep)"

    if ($PSCmdlet.ShouldProcess($archive, "Create archive of $DataDir")) {
        if (-not (Test-Path -LiteralPath $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null }
        $partial = $archive + '.partial'
        $parent = Split-Path -Parent $DataDir
        $leaf = Split-Path -Leaf $DataDir
        $tarOut = & $tar -czf $partial -C $parent $leaf 2>&1
        if ($LASTEXITCODE -ne 0) {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            throw "tar failed (exit $LASTEXITCODE): $(@($tarOut) -join ' | ')"
        }
        Move-Item -LiteralPath $partial -Destination $archive
        Write-ShadowBackupLog $logFile ("archive written: {0} ({1:N0} bytes)" -f $name, (Get-Item -LiteralPath $archive).Length)
    }

    if ($PSCmdlet.ShouldProcess($target, "Upload $name")) {
        Invoke-ShadowRclone $rclone $cfgArgs @('copy', $archive, $target) | Out-Null
        $present = @(Invoke-ShadowRclone $rclone $cfgArgs @('lsf', $target, '--files-only', '--include', $name))
        if ($present -notcontains $name) { throw "upload finished but $name is not listed on $target" }
        Write-ShadowBackupLog $logFile "uploaded: $name"
    }

    if ($days -gt 0 -and $PSCmdlet.ShouldProcess($target, "Delete $ShadowBackupPrefix* archives older than $days days")) {
        # --min-age is relative to now, so the archive just uploaded is never matched.
        Invoke-ShadowRclone $rclone $cfgArgs @('delete', $target, '--min-age', "${days}d",
            '--include', "$ShadowBackupPrefix*$ShadowBackupSuffix") | Out-Null
        Write-ShadowBackupLog $logFile "remote pruned: archives older than $days days"
    }

    $old = @(Get-ChildItem -LiteralPath $LocalDir -Filter "$ShadowBackupPrefix*$ShadowBackupSuffix" -File -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -Skip $keep)
    foreach ($f in $old) {
        if ($PSCmdlet.ShouldProcess($f.FullName, 'Delete old local archive')) {
            Remove-Item -LiteralPath $f.FullName -Force
            Write-ShadowBackupLog $logFile "local pruned: $($f.Name)"
        }
    }
    Write-ShadowBackupLog $logFile 'backup done'
}
catch {
    Write-ShadowBackupLog $logFile "backup FAILED: $($_.Exception.Message)"
    throw
}
finally {
    Clear-ShadowCryptRemote
}
