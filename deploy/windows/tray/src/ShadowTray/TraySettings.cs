using System.Globalization;

namespace ShadowTray;

/// <summary>
/// Paths and addresses the tray works with. Each value comes from, in order:
/// a command-line argument, the process environment, the repo-root
/// <c>.env</c> (for Core/UI addresses only), a default.
/// </summary>
public sealed record TraySettings
{
    public const int DefaultCorePort = 8700;
    public const int DefaultUiPort = 8703;

    public required string? RepoRoot { get; init; }
    public required string? NodePath { get; init; }
    public required string LogDir { get; init; }
    /// <summary>Base URL of the Core's HTTP endpoint, e.g. http://127.0.0.1:8700.</summary>
    public required Uri CoreBaseUrl { get; init; }
    public required int UiPort { get; init; }
    /// <summary>Things that keep the Core from starting (shown in the menu and log).</summary>
    public required IReadOnlyList<string> Problems { get; init; }
    /// <summary>Logged only; the Core still starts (e.g. an unknown command-line argument, which is ignored).</summary>
    public IReadOnlyList<string> Warnings { get; init; } = [];

    public string? CoreEntry => RepoRoot is null ? null : Path.Combine(RepoRoot, "core", "dist", "index.js");
    public string? UiDist => RepoRoot is null ? null : Path.Combine(RepoRoot, "ui", "dist");
    public string? DeployDir => RepoRoot is null ? null : Path.Combine(RepoRoot, "deploy");
    public string? EnvFile { get; init; }

    /// <param name="args">
    /// Command line: --repo-root, --node-path, --log-dir (each followed by a
    /// value). Anything else is ignored with a warning; a missing value is a problem.
    /// </param>
    /// <param name="getEnv">Environment lookup (Environment.GetEnvironmentVariable in production).</param>
    /// <param name="exeDir">Folder of the running exe, start of the repo-root search.</param>
    public static TraySettings Resolve(IReadOnlyList<string> args, Func<string, string?> getEnv, string exeDir)
    {
        var parsed = ParseArgs(args);
        var problems = new List<string>(parsed.Errors);

        string? repoRoot = FirstNonEmpty(parsed.Get("--repo-root"), getEnv("SHADOW_REPO_ROOT"));
        if (repoRoot is not null)
        {
            repoRoot = Path.GetFullPath(repoRoot);
            if (!LooksLikeRepoRoot(repoRoot))
            {
                problems.Add($"Repo kökü geçersiz (core\\ ve services.yaml yok): {repoRoot}");
            }
        }
        else
        {
            repoRoot = FindRepoRoot(exeDir);
            if (repoRoot is null) problems.Add("Repo kökü bulunamadı: --repo-root verin veya SHADOW_REPO_ROOT ayarlayın.");
        }

        var nodePath = FirstNonEmpty(parsed.Get("--node-path"), getEnv("SHADOW_NODE_PATH"))
                       ?? FindOnPath("node.exe", getEnv("PATH"));
        if (nodePath is null) problems.Add("node.exe bulunamadı: Node.js 22+ kurun veya --node-path / SHADOW_NODE_PATH verin.");
        // node.exe and core\dist\index.js themselves are checked before every
        // start (StartProblems), so building the Core later needs no tray restart.

        var localAppData = getEnv("LOCALAPPDATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var logDir = FirstNonEmpty(parsed.Get("--log-dir"), getEnv("SHADOW_CORE_LOG_DIR"))
                     ?? Path.Combine(localAppData, "ShadowAssistant", "logs");
        logDir = Path.GetFullPath(logDir);

        // Same lookup as the Core (config.ts): SHADOW_ENV_FILE, else <repo>\.env;
        // the real environment wins over the file.
        var envFile = FirstNonEmpty(getEnv("SHADOW_ENV_FILE")) ?? (repoRoot is null ? null : Path.Combine(repoRoot, ".env"));
        var dotEnv = envFile is null ? new Dictionary<string, string>() : DotEnv.Load(envFile);
        string? Setting(string key) => FirstNonEmpty(getEnv(key), dotEnv.GetValueOrDefault(key));

        var corePort = ParsePort(Setting("CORE_PORT"), DefaultCorePort);
        var coreHost = ClientHost(Setting("CORE_HOST"));
        var uiPort = ParsePort(Setting("SHADOW_UI_PORT"), DefaultUiPort);

        return new TraySettings
        {
            RepoRoot = repoRoot,
            NodePath = nodePath,
            LogDir = logDir,
            CoreBaseUrl = new UriBuilder("http", coreHost, corePort).Uri,
            UiPort = uiPort,
            Problems = problems,
            Warnings = parsed.Warnings,
            EnvFile = envFile,
        };
    }

    /// <summary>Everything that keeps the Core from starting right now.</summary>
    public IReadOnlyList<string> StartProblems()
    {
        var list = new List<string>(Problems);
        if (NodePath is not null && !File.Exists(NodePath)) list.Add($"node.exe yok: {NodePath}");
        if (CoreEntry is not null && !File.Exists(CoreEntry))
            list.Add("Core derlenmemiş: core\\dist\\index.js yok (core\\ içinde npm ci, npm run build).");
        return list;
    }

    /// <summary>The repo root holds core\ and services.yaml.</summary>
    public static bool LooksLikeRepoRoot(string dir) =>
        Directory.Exists(Path.Combine(dir, "core")) && File.Exists(Path.Combine(dir, "services.yaml"));

    /// <summary>Walks up from <paramref name="start"/> (inclusive) to the first folder that looks like the repo root.</summary>
    public static string? FindRepoRoot(string start)
    {
        for (var dir = new DirectoryInfo(Path.GetFullPath(start)); dir is not null; dir = dir.Parent)
        {
            if (LooksLikeRepoRoot(dir.FullName)) return dir.FullName;
        }
        return null;
    }

    public static string? FindOnPath(string fileName, string? pathVariable)
    {
        if (string.IsNullOrEmpty(pathVariable)) return null;
        foreach (var part in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(part.Trim('"'), fileName);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch (ArgumentException)
            {
                // Malformed PATH entry.
            }
        }
        return null;
    }

    /// <summary>Port 1-65535 or the default (the Core refuses invalid values; the tray just falls back).</summary>
    public static int ParsePort(string? value, int fallback) =>
        int.TryParse(value?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var p) && p is > 0 and <= 65535 ? p : fallback;

    /// <summary>
    /// Address to reach the Core from this machine: a wildcard bind address
    /// (0.0.0.0 / ::) or an empty value means loopback.
    /// </summary>
    public static string ClientHost(string? coreHost)
    {
        var h = coreHost?.Trim();
        if (string.IsNullOrEmpty(h) || h == "0.0.0.0" || h == "::" || h == "[::]") return "127.0.0.1";
        return h.StartsWith('[') ? h.Trim('[', ']') : h;
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))?.Trim();

    private sealed record ParsedArgs(Dictionary<string, string> Values, List<string> Errors, List<string> Warnings)
    {
        public string? Get(string name) => Values.GetValueOrDefault(name);
    }

    private static ParsedArgs ParseArgs(IReadOnlyList<string> args)
    {
        var known = new[] { "--repo-root", "--node-path", "--log-dir" };
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var errors = new List<string>();
        var warnings = new List<string>();
        for (var i = 0; i < args.Count; i++)
        {
            var a = args[i];
            var name = known.FirstOrDefault(k => string.Equals(k, a, StringComparison.OrdinalIgnoreCase));
            if (name is null)
            {
                // Ignored, not fatal: a typo or a newer task's argument must not keep the Core down.
                warnings.Add($"unknown command-line argument ignored: {a}");
                continue;
            }
            if (i + 1 >= args.Count)
            {
                errors.Add($"{name} için değer eksik.");
                continue;
            }
            values[name] = args[++i];
        }
        return new ParsedArgs(values, errors, warnings);
    }
}
