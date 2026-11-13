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
    if (-not $file) { $file = '.env' }
    # Relative SHADOW_ENV_FILE: to the repo root, the Core's working directory
    # (not the caller's; Test-Path and .NET would even disagree on that).
    if (-not [IO.Path]::IsPathRooted($file)) { $file = [IO.Path]::Combine($RepoRoot, $file) }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        # A missing file that was named explicitly is an error: going on without
        # it would back up the default folder (or miss the crypt passwords).
        if ($env:SHADOW_ENV_FILE) { throw "SHADOW_ENV_FILE names a file that does not exist: $file" }
        return $values
    }
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

# --- Data folder: the Core's rule (T20.3) -------------------------------------
# One rule, defined by the Core (resolveDataDir in core/src/config.ts) and
# described in docs/05-deploy.md, section "Data folder"; mirrored here so the
# status file lands where the Core reads it. Change all three together.
# The working directory the Core resolves against is taken to be the repo root
# (the tray and run-core.ps1 start it there); the caller's working directory is
# never used.

# SHADOW_DATA_DIR / SHADOW_VAULT_DIR as the Core sees them: a variable that
# exists in the process environment wins over .env even when it is blank (Node's
# .env loader keeps every existing variable); the value is trimmed.
function Get-ShadowCoreSetting([string] $Name, [hashtable] $DotEnv) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    # Windows PowerShell 5.1 returns $null for a variable that exists with an
    # empty value; the Env: drive still lists it (and Node keeps it).
    if ($null -eq $fromEnv -and (Test-Path -LiteralPath "Env:$Name")) { $fromEnv = '' }
    if ($null -ne $fromEnv) { return @{ Value = $fromEnv.Trim(); From = "$Name (environment)" } }
    if ($DotEnv.ContainsKey($Name)) { return @{ Value = ([string]$DotEnv[$Name]).Trim(); From = "$Name (.env)" } }
    return @{ Value = ''; From = $Name }
}

# Node's path.win32.resolve(Base, Path) with the working directory = Base.
# Absolute means \x, /x or X:\x (UNC included); .NET's IsPathRooted also counts
# the drive-relative X:x, Node does not. A root-relative \x takes Base's drive;
# a drive-relative X:x is under Base on Base's drive, else under the drive's
# current folder from the hidden =X: variable (as Node does), else X:\.
# The last two depend on the process: Get-ShadowDriveWarning flags them.
function Resolve-ShadowNodePath([string] $Path, [string] $Base) {
    if ($Path -cmatch '^[\\/](?![\\/])') {
        $Path = [IO.Path]::GetPathRoot($Base).TrimEnd('\', '/') + $Path
    }
    elseif ($Path -cmatch '^([A-Za-z]):(?![\\/])') {
        $rest = $Path.Substring(2)
        if ([string]::Equals($Matches[1] + ':', $Base.Substring(0, [Math]::Min(2, $Base.Length)), [StringComparison]::OrdinalIgnoreCase)) {
            $Path = [IO.Path]::Combine($Base, $rest)
        }
        else {
            $drive = $Matches[1] + ':'
            $current = [Environment]::GetEnvironmentVariable('=' + $drive)
            if ($current -and $current.StartsWith($drive, [StringComparison]::OrdinalIgnoreCase)) { $Path = [IO.Path]::Combine($current, $rest) }
            else { $Path = $drive + '\' + $rest }
        }
    }
    elseif ($Path -cnotmatch '^([\\/]|[A-Za-z]:[\\/])') {
        $Path = [IO.Path]::Combine($Base, $Path)
    }
    $full = [IO.Path]::GetFullPath($Path)
    # Drop a trailing separator, but keep a drive root (D:\) intact.
    if ($full.Length -gt [IO.Path]::GetPathRoot($full).Length) { $full = $full.TrimEnd('\', '/') }
    return $full
}

# The Core warns about these too (resolveDataDir): D:data or \data resolve
# against the process's drive state, which the two processes need not share.
function Get-ShadowDriveWarning([string] $Path) {
    if ($Path -cmatch '^(?:[A-Za-z]:(?![\\/])|[\\/](?![\\/]))') { return '; WARNING: drive- or root-relative path, use an absolute one (docs/05 "Data folder")' }
    return ''
}

# Returns @{ Path; Source }. -DataDir (parameter) overrides the rule, relative
# to the repo root; then:
# 1. SHADOW_DATA_DIR not blank: absolute, or relative to the repo root.
# 2. <SHADOW_VAULT_DIR>\.shadow-assistant if SHADOW_VAULT_DIR is an existing
#    folder (relative: to the repo root).
# 3. <repo root>\.shadow-assistant.
# No ~ or %VAR% expansion (the Core does none either).
function Resolve-ShadowDataDir([string] $DataDir, [hashtable] $DotEnv, [string] $RepoRoot) {
    if ($DataDir -and $DataDir.Trim()) {
        return @{ Path = (Resolve-ShadowNodePath $DataDir.Trim() $RepoRoot); Source = 'parameter -DataDir (not the Core''s rule)' }
    }
    $data = Get-ShadowCoreSetting 'SHADOW_DATA_DIR' $DotEnv
    if ($data.Value) { return @{ Path = (Resolve-ShadowNodePath $data.Value $RepoRoot); Source = ($data.From + (Get-ShadowDriveWarning $data.Value)) } }
    $base = $RepoRoot
    $source = 'the default <repo>\.shadow-assistant'
    $vault = Get-ShadowCoreSetting 'SHADOW_VAULT_DIR' $DotEnv
    if ($vault.Value) {
        $vaultDir = Resolve-ShadowNodePath $vault.Value $RepoRoot
        if (Test-Path -LiteralPath $vaultDir -PathType Container) {
            $base = $vaultDir
            $source = $vault.From + (Get-ShadowDriveWarning $vault.Value)
        }
        else { $source = "the default <repo>\.shadow-assistant: $($vault.From) is not an existing folder" }
    }
    return @{ Path = (Resolve-ShadowNodePath ([IO.Path]::Combine($base, '.shadow-assistant')) $RepoRoot); Source = $source }
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

# --- Status file (<data dir>\backup\status.json), read by the Core ----------
# Shape: {version: 1, runId, startedAt, finishedAt?, result: running|ok|failed,
# stage?: setup|archive|upload|prune, lastSuccessAt}; timestamps ISO 8601 UTC,
# lastSuccessAt null until the first success. Error messages are never written
# (they can hold remote names), only the stage. The archive excludes this file
# (backup-data.ps1), so a restore never brings an old status back.

function Get-ShadowUtcStamp([datetime] $Time = [datetime]::UtcNow) {
    return $Time.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

# lastSuccessAt of an existing status file, normalised to ISO UTC; $null when
# the file is missing, unreadable, invalid JSON or holds no valid timestamp.
function Read-ShadowBackupLastSuccess([string] $StatusFile) {
    try {
        if (-not (Test-Path -LiteralPath $StatusFile -PathType Leaf)) { return $null }
        $json = [IO.File]::ReadAllText($StatusFile) | ConvertFrom-Json
        if ($null -eq $json -or -not ($json.PSObject.Properties.Name -contains 'lastSuccessAt')) { return $null }
        $v = $json.lastSuccessAt
        # PowerShell 7's ConvertFrom-Json already turns ISO strings into [datetime].
        if ($v -is [datetime]) { return Get-ShadowUtcStamp $v }
        if ($v -isnot [string] -or -not $v) { return $null }
        $parsed = [datetime]::MinValue
        $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
        if (-not [datetime]::TryParse($v, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) { return $null }
        return Get-ShadowUtcStamp $parsed
    }
    catch {
        return $null
    }
}

# Writes the status atomically: a temp file next to it, then a replace/move, so
# the Core never reads a half-written file. Creates <data dir>\backup if needed,
# but never the data folder itself. Ignores -WhatIf on purpose: the caller
# decides (backup-data.ps1 writes nothing under -WhatIf).
function Write-ShadowBackupStatus([string] $StatusFile, [System.Collections.IDictionary] $Status) {
    $dir = Split-Path -Parent $StatusFile
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force -WhatIf:$false | Out-Null }
    $tmp = $StatusFile + '.tmp'
    $text = ConvertTo-Json -InputObject $Status -Depth 2
    [IO.File]::WriteAllText($tmp, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    # A few short retries: OneDrive or an antivirus scanner may hold the file
    # for a moment, and a lost final write would leave a false "running".
    for ($attempt = 1; ; $attempt++) {
        try {
            # [NullString]::Value: a plain $null would reach .NET as "" (invalid backup path).
            if (Test-Path -LiteralPath $StatusFile -PathType Leaf) { [IO.File]::Replace($tmp, $StatusFile, [NullString]::Value) }
            else { [IO.File]::Move($tmp, $StatusFile) }
            return
        }
        catch [IO.IOException], [UnauthorizedAccessException] {
            if ($attempt -ge 3) { throw }
            Start-Sleep -Milliseconds 300
        }
    }
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
