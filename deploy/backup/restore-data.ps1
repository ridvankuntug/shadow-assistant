<#
.SYNOPSIS
    Lists or restores Shadow Assistant data backups from the encrypted rclone remote.

.DESCRIPTION
    -List prints the archives on the remote (decrypted names).
    Otherwise downloads one archive (default: the newest) and unpacks it into
    -Destination, which must not exist yet or be empty. The live data folder is
    never overwritten; copy files from Destination yourself after checking them.

    Uses the same settings as backup-data.ps1 (parameters, environment, .env),
    including SHADOW_BACKUP_CRYPT_PASSWORD / SHADOW_BACKUP_CRYPT_SALT. Without the
    exact same two passwords the backups cannot be decrypted.

.EXAMPLE
    .\restore-data.ps1 -List
.EXAMPLE
    .\restore-data.ps1 -Destination "$env:TEMP\shadow-restore"
.EXAMPLE
    .\restore-data.ps1 -Archive shadow-assistant-data-20260101-033000.tar.gz -Destination D:\restore
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Restore')]
param(
    [Parameter(ParameterSetName = 'List', Mandatory = $true)] [switch] $List,
    [Parameter(ParameterSetName = 'Restore', Mandatory = $true)] [string] $Destination,
    [Parameter(ParameterSetName = 'Restore')] [string] $Archive,
    [string] $DriveRemote,
    [string] $DrivePath,
    [string] $CryptRemote,
    [string] $RclonePath,
    [string] $RcloneConfig,
    [string] $RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')

if (-not $RepoRoot) { $RepoRoot = $env:SHADOW_REPO_ROOT }
if (-not $RepoRoot) { $RepoRoot = Join-Path $PSScriptRoot '..\..' }
$dot = Read-ShadowDotEnv ([IO.Path]::GetFullPath($RepoRoot))

$DriveRemote = Get-ShadowSetting $DriveRemote 'SHADOW_BACKUP_DRIVE_REMOTE' $dot 'gdrive'
$DrivePath = Get-ShadowSetting $DrivePath 'SHADOW_BACKUP_DRIVE_PATH' $dot 'shadow-assistant-backup'
$CryptRemote = Get-ShadowSetting $CryptRemote 'SHADOW_BACKUP_CRYPT_REMOTE' $dot 'shadowcrypt'
$RcloneConfig = Get-ShadowSetting $RcloneConfig 'SHADOW_BACKUP_RCLONE_CONFIG' $dot $null
$rclone = Find-ShadowRclone (Get-ShadowSetting $RclonePath 'SHADOW_BACKUP_RCLONE_PATH' $dot $null)
$cfgArgs = @()
if ($RcloneConfig) { $cfgArgs = @('--config', $RcloneConfig) }
$source = "${CryptRemote}:"

try {
    Initialize-ShadowCryptRemote -Rclone $rclone -ConfigArgs $cfgArgs -DriveRemote $DriveRemote -DrivePath $DrivePath `
        -CryptRemote $CryptRemote `
        -Password (Get-ShadowSetting $null 'SHADOW_BACKUP_CRYPT_PASSWORD' $dot $null) `
        -Salt (Get-ShadowSetting $null 'SHADOW_BACKUP_CRYPT_SALT' $dot $null) | Out-Null

    $names = @(Invoke-ShadowRclone $rclone $cfgArgs @('lsf', $source, '--files-only',
            '--include', "$ShadowBackupPrefix*$ShadowBackupSuffix") | Sort-Object -Descending)
    # Names that do not decrypt are skipped by rclone with a notice on stderr:
    # that means the crypt passwords differ from the ones used for the backup.
    $undecryptable = @($ShadowRcloneStderr | Where-Object { $_ -match 'decrypt' })
    if ($undecryptable) {
        Write-Warning "$($undecryptable.Count) file(s) on $source could not be decrypted: wrong SHADOW_BACKUP_CRYPT_PASSWORD / SHADOW_BACKUP_CRYPT_SALT, or files not written by this crypt remote."
    }
    if ($List) {
        if (-not $names) { Write-Output "No backups on $source." }
        $names
        return
    }
    if (-not $names) { throw "No backups on $source that can be decrypted with the configured passwords." }
    if (-not $Archive) { $Archive = $names[0] }
    elseif ($names -notcontains $Archive) { throw "$Archive is not on $source (use -List)." }

    $Destination = [IO.Path]::GetFullPath($Destination)
    if ((Test-Path -LiteralPath $Destination) -and @(Get-ChildItem -LiteralPath $Destination -Force).Count -gt 0) {
        throw "Destination is not empty: $Destination"
    }
    if ($PSCmdlet.ShouldProcess($Destination, "Download and unpack $Archive")) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Invoke-ShadowRclone $rclone $cfgArgs @('copy', "$source$Archive", $Destination) | Out-Null
        $file = Join-Path $Destination $Archive
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        $tarOut = & $tar -xzf $file -C $Destination 2>&1
        if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE): $(@($tarOut) -join ' | ')" }
        Remove-Item -LiteralPath $file -Force
        Write-Output "Restored $Archive into $Destination"
    }
}
finally {
    Clear-ShadowCryptRemote
}
