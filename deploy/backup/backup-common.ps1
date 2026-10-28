# Shared helpers for backup-data.ps1 and restore-data.ps1. Dot-source only.
#
# Settings come from (first match wins): the script parameter, the process
# environment, the repo-root .env (same file the Core reads), a default.
#
# Encryption: the crypt remote is defined through rclone's environment-variable
# config (RCLONE_CONFIG_<NAME>_TYPE=crypt ...), built in this process from
# SHADOW_BACKUP_CRYPT_PASSWORD / SHADOW_BACKUP_CRYPT_SALT. rclone.conf then only
# holds the Google Drive remote (OAuth token); the crypt passwords are never
# written to it. Reason: rclone.conf stores passwords "obscured", which is
# reversible encoding, not encryption, in a well-known file that every rclone
# command reads. The variables are removed again when the script ends.
# If SHADOW_BACKUP_CRYPT_PASSWORD is empty, a crypt remote of the same name that
# already exists in rclone.conf is used as-is.

Set-StrictMode -Version Latest

$script:ShadowBackupPrefix = 'shadow-assistant-data-'
$script:ShadowBackupSuffix = '.tar.gz'
$script:ShadowBackupDocs = 'docs/05-deploy.md, section "Backups"'
$script:ShadowBackupEnvSet = @()
$script:ShadowBackupEnvSaved = @{}

function Read-ShadowDotEnv([string] $RepoRoot) {
    $values = @{}
    $file = $env:SHADOW_ENV_FILE
    if (-not $file) { $file = Join-Path $RepoRoot '.env' }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $values }
    # -cmatch: a case-insensitive match uses the current culture, and under
    # tr-TR [A-Za-z] does not match 'I' (keys like SHADOW_DATA_DIR were lost).
    foreach ($line in [IO.File]::ReadAllLines($file)) {
        if ($line -cmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $key = $Matches[1]
            $v = $Matches[2]
            # Same rules as Node's .env reader (the Core): a quoted value ends at
            # its closing quote; in an unquoted value '#' starts a comment.
            if ($v.Length -ge 1 -and ($v[0] -eq '"' -or $v[0] -eq "'" -or $v[0] -eq '`')) {
                $end = $v.IndexOf($v[0], 1)
                if ($end -gt 0) { $v = $v.Substring(1, $end - 1) }
            }
            else {
                $hash = $v.IndexOf('#')
                if ($hash -ge 0) { $v = $v.Substring(0, $hash) }
                $v = $v.Trim()
            }
            $values[$key] = $v
        }
    }
    return $values
}

function Get-ShadowSetting([string] $Value, [string] $Name, [hashtable] $DotEnv, $Default) {
    if ($Value) { return $Value }
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    if ($DotEnv.ContainsKey($Name) -and $DotEnv[$Name]) { return $DotEnv[$Name] }
    return $Default
}

# Relative paths are resolved against the repo root, like the Core does (it
# runs with the repo root as working directory), never against the caller's
# working directory (System32 for a scheduled task).
function Resolve-ShadowDataDir([string] $DataDir, [hashtable] $DotEnv, [string] $RepoRoot) {
    $dir = Get-ShadowSetting $DataDir 'SHADOW_DATA_DIR' $DotEnv $null
    if (-not $dir) {
        $vault = Get-ShadowSetting $null 'SHADOW_VAULT_DIR' $DotEnv $null
        if ($vault) {
            if (-not [IO.Path]::IsPathRooted($vault)) { $vault = Join-Path $RepoRoot $vault }
            $dir = Join-Path $vault '.shadow-assistant'
        }
    }
    if (-not $dir) { throw 'Data folder unknown: set SHADOW_DATA_DIR (or SHADOW_VAULT_DIR) in .env or pass -DataDir.' }
    if (-not [IO.Path]::IsPathRooted($dir)) { $dir = Join-Path $RepoRoot $dir }
    return [IO.Path]::GetFullPath($dir).TrimEnd('\')
}

function Find-ShadowRclone([string] $Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit -PathType Leaf)) { throw "rclone not found at $Explicit" }
        return $Explicit
    }
    $cmd = Get-Command rclone -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    # winget installs rclone without adding it to PATH for already-open shells.
    $pattern = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Rclone.Rclone_*\rclone-*\rclone.exe'
    $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
        Sort-Object { $_.VersionInfo.FileVersionRaw }, FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
    throw "rclone not found. Install it (winget install Rclone.Rclone), or set SHADOW_BACKUP_RCLONE_PATH. See $script:ShadowBackupDocs."
}

# Runs rclone; returns its stdout lines. rclone's log/notice lines (stderr) are
# kept apart in $script:ShadowRcloneStderr so they are never mistaken for data
# (e.g. "cannot decrypt name" notices in an lsf listing). Throws on a non-zero
# exit code, with the stderr text in the message.
$script:ShadowRcloneStderr = @()
function Invoke-ShadowRclone([string] $Rclone, [string[]] $ConfigArgs, [string[]] $Arguments, [string] $InputText) {
    $all = @(@($ConfigArgs) + @($Arguments) | Where-Object { $null -ne $_ })
    $prev = $ErrorActionPreference
    $prevEncoding = $global:OutputEncoding
    $prevConsole = [Console]::OutputEncoding
    $ErrorActionPreference = 'Continue'
    # Text piped to a native program uses $OutputEncoding (ASCII in Windows
    # PowerShell 5.1), which would turn non-ASCII password characters into '?'.
    # rclone writes UTF-8; [Console]::OutputEncoding decodes what it prints.
    # It must be the global variable: a local one is ignored for native pipes.
    $global:OutputEncoding = New-Object Text.UTF8Encoding($false)
    try { [Console]::OutputEncoding = $global:OutputEncoding } catch { Write-Verbose 'console encoding unchanged' }
    try {
        if ($PSBoundParameters.ContainsKey('InputText')) { $out = $InputText | & $Rclone @all 2>&1 }
        else { $out = & $Rclone @all 2>&1 }
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
        $global:OutputEncoding = $prevEncoding
        try { [Console]::OutputEncoding = $prevConsole } catch { Write-Verbose 'console encoding unchanged' }
    }
    $stdout = @($out | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    $script:ShadowRcloneStderr = @($out | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    if ($code -ne 0) {
        throw ("rclone {0} failed (exit {1}): {2}" -f $Arguments[0], $code, ($script:ShadowRcloneStderr -join ' | '))
    }
    return $stdout
}

# Makes sure the crypt remote exists; defines it from env if a password is set.
# Never logs or returns the passwords.
function Initialize-ShadowCryptRemote {
    param(
        [string] $Rclone, [string[]] $ConfigArgs,
        [string] $DriveRemote, [string] $DrivePath, [string] $CryptRemote,
        [string] $Password, [string] $Salt
    )
    # The plain-text secrets are not passed on to tar/rclone child processes:
    # remove them from this process now; Clear-ShadowCryptRemote puts them back
    # (so an interactive session that set them keeps them).
    foreach ($name in @('SHADOW_BACKUP_CRYPT_PASSWORD', 'SHADOW_BACKUP_CRYPT_SALT')) {
        $old = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $old) {
            $script:ShadowBackupEnvSaved[$name] = $old
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
    $remotes = @(Invoke-ShadowRclone $Rclone $ConfigArgs @('listremotes') | ForEach-Object { $_.Trim().TrimEnd(':') })
    if ($remotes -notcontains $DriveRemote) {
        throw "rclone remote '$DriveRemote' not found (remotes: $($remotes -join ', ')). Create it first: $script:ShadowBackupDocs."
    }
    if (-not $Password) {
        if ($remotes -contains $CryptRemote) {
            # Refuse anything but a crypt remote: a same-named drive/local remote
            # would upload the data unencrypted. (Output not logged: holds secrets.)
            $show = @(Invoke-ShadowRclone $Rclone $ConfigArgs @('config', 'show', $CryptRemote))
            if (-not ($show | Where-Object { $_ -match '^\s*type\s*=\s*crypt\s*$' })) {
                throw "rclone remote '$CryptRemote' is not of type crypt; refusing to upload unencrypted data. See $script:ShadowBackupDocs."
            }
            return 'rclone.conf'
        }
        throw "SHADOW_BACKUP_CRYPT_PASSWORD is not set and there is no '$CryptRemote' remote in rclone.conf. See $script:ShadowBackupDocs."
    }
    if (-not $Salt) { throw "SHADOW_BACKUP_CRYPT_SALT is not set (both crypt passwords are required). See $script:ShadowBackupDocs." }
    if ($CryptRemote -cnotmatch '^[A-Za-z0-9_]+$') {
        throw "Crypt remote name '$CryptRemote' may contain only letters, digits and _ (it becomes part of an environment variable name)."
    }
    # "obscure -" reads the secret from stdin, so it never appears on a command line.
    $obscured1 = (Invoke-ShadowRclone $Rclone @() @('obscure', '-') $Password | Select-Object -Last 1).Trim()
    $obscured2 = (Invoke-ShadowRclone $Rclone @() @('obscure', '-') $Salt | Select-Object -Last 1).Trim()
    $prefix = 'RCLONE_CONFIG_' + $CryptRemote.ToUpperInvariant() + '_'
    $vars = [ordered]@{
        TYPE                      = 'crypt'
        REMOTE                    = "${DriveRemote}:$DrivePath"
        FILENAME_ENCRYPTION       = 'standard'
        DIRECTORY_NAME_ENCRYPTION = 'true'
        PASSWORD                  = $obscured1
        PASSWORD2                 = $obscured2
    }
    foreach ($k in $vars.Keys) {
        [Environment]::SetEnvironmentVariable($prefix + $k, $vars[$k], 'Process')
        $script:ShadowBackupEnvSet += ($prefix + $k)
    }
    return 'environment'
}

function Clear-ShadowCryptRemote {
    foreach ($name in $script:ShadowBackupEnvSet) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $script:ShadowBackupEnvSet = @()
    foreach ($name in @($script:ShadowBackupEnvSaved.Keys)) {
        [Environment]::SetEnvironmentVariable($name, $script:ShadowBackupEnvSaved[$name], 'Process')
    }
    $script:ShadowBackupEnvSaved = @{}
}

# Appends to <LogDir>\<name>; keeps one previous file (<name>.1) above MaxBytes.
function Write-ShadowBackupLog([string] $LogFile, [string] $Message, [long] $MaxBytes = 2MB) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $Message
    Write-Output $line
    if (-not $LogFile -or $WhatIfPreference) { return }
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force -WhatIf:$false | Out-Null }
    if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -ge $MaxBytes) {
        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force -WhatIf:$false
    }
    [IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}
