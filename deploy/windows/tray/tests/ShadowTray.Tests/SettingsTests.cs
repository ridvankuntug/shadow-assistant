using ShadowTray;

namespace ShadowTray.Tests;

public sealed class SettingsTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "shadowtray-repo-" + Guid.NewGuid().ToString("N"));

    public SettingsTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "core", "dist"));
        File.WriteAllText(Path.Combine(_root, "services.yaml"), "services: []\n");
        File.WriteAllText(Path.Combine(_root, "core", "dist", "index.js"), "");
        Directory.CreateDirectory(Path.Combine(_root, "bin"));
        File.WriteAllText(Path.Combine(_root, "bin", "node.exe"), "");
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private Func<string, string?> Env(params (string Key, string Value)[] vars)
    {
        var d = vars.ToDictionary(v => v.Key, v => v.Value, StringComparer.OrdinalIgnoreCase);
        d.TryAdd("PATH", Path.Combine(_root, "bin"));
        d.TryAdd("LOCALAPPDATA", Path.Combine(_root, "lad"));
        return k => d.GetValueOrDefault(k);
    }

    [Fact]
    public void Finds_the_repo_root_by_walking_up_from_the_exe()
    {
        var exeDir = Path.Combine(_root, "deploy", "windows", "tray", "publish");
        Directory.CreateDirectory(exeDir);
        var s = TraySettings.Resolve([], Env(), exeDir);
        Assert.Equal(_root, s.RepoRoot);
        Assert.Empty(s.Problems);
        Assert.Empty(s.StartProblems());
        Assert.Equal(Path.Combine(_root, "core", "dist", "index.js"), s.CoreEntry);
        Assert.Equal(Path.Combine(_root, "bin", "node.exe"), s.NodePath);
        Assert.Equal(Path.Combine(_root, "lad", "ShadowAssistant", "logs"), s.LogDir);
        Assert.Equal(new Uri("http://127.0.0.1:8700/"), s.CoreBaseUrl);
        Assert.Equal(8703, s.UiPort);
    }

    [Fact]
    public void Arguments_win_over_environment()
    {
        var other = Path.Combine(_root, "other-node.exe");
        File.WriteAllText(other, "");
        var s = TraySettings.Resolve(
            ["--repo-root", _root, "--node-path", other, "--log-dir", Path.Combine(_root, "L")],
            Env(("SHADOW_NODE_PATH", "C:\\nowhere\\node.exe"), ("SHADOW_CORE_LOG_DIR", "C:\\elsewhere")),
            Path.GetTempPath());
        Assert.Equal(other, s.NodePath);
        Assert.Equal(Path.Combine(_root, "L"), s.LogDir);
        Assert.Empty(s.StartProblems());
    }

    [Fact]
    public void Environment_is_used_without_arguments()
    {
        var s = TraySettings.Resolve([], Env(("SHADOW_REPO_ROOT", _root), ("SHADOW_CORE_LOG_DIR", Path.Combine(_root, "E"))), Path.GetTempPath());
        Assert.Equal(_root, s.RepoRoot);
        Assert.Equal(Path.Combine(_root, "E"), s.LogDir);
    }

    [Fact]
    public void Reports_missing_root_node_and_build()
    {
        var empty = Path.Combine(_root, "empty");
        Directory.CreateDirectory(empty);
        var s = TraySettings.Resolve([], k => k == "PATH" ? empty : null, Path.GetPathRoot(empty)!);
        Assert.Null(s.RepoRoot);
        Assert.Contains(s.Problems, p => p.Contains("Repo kökü bulunamadı"));
        Assert.Contains(s.Problems, p => p.Contains("node.exe bulunamadı"));

        File.Delete(Path.Combine(_root, "core", "dist", "index.js"));
        var s2 = TraySettings.Resolve(["--repo-root", _root], Env(), _root);
        Assert.Empty(s2.Problems);
        Assert.Contains(s2.StartProblems(), p => p.Contains("Core derlenmemiş"));
    }

    [Fact]
    public void Invalid_repo_root_and_unknown_arguments_are_problems()
    {
        var s = TraySettings.Resolve(["--repo-root", Path.Combine(_root, "core"), "--bogus"], Env(), _root);
        Assert.Contains(s.Problems, p => p.Contains("Repo kökü geçersiz"));
        Assert.Contains(s.Problems, p => p.Contains("--bogus"));
        var s2 = TraySettings.Resolve(["--node-path"], Env(), _root);
        Assert.Contains(s2.Problems, p => p.Contains("değer eksik"));
    }

    [Fact]
    public void Core_and_ui_addresses_come_from_dotenv_with_environment_winning()
    {
        File.WriteAllText(Path.Combine(_root, ".env"), "CORE_HOST=0.0.0.0\nCORE_PORT=9800\nSHADOW_UI_PORT=9803\n");
        var s = TraySettings.Resolve(["--repo-root", _root], Env(), _root);
        Assert.Equal(new Uri("http://127.0.0.1:9800/"), s.CoreBaseUrl);
        Assert.Equal(9803, s.UiPort);

        var s2 = TraySettings.Resolve(["--repo-root", _root], Env(("CORE_PORT", "9900")), _root);
        Assert.Equal(9900, s2.CoreBaseUrl.Port);
    }

    [Fact]
    public void Shadow_env_file_replaces_the_repo_env()
    {
        var alt = Path.Combine(_root, "alt.env");
        File.WriteAllText(alt, "CORE_PORT=9123\n");
        File.WriteAllText(Path.Combine(_root, ".env"), "CORE_PORT=9800\n");
        var s = TraySettings.Resolve(["--repo-root", _root], Env(("SHADOW_ENV_FILE", alt)), _root);
        Assert.Equal(9123, s.CoreBaseUrl.Port);
        Assert.Equal(alt, s.EnvFile);
    }

    [Theory]
    [InlineData(null, 8700)]
    [InlineData("", 8700)]
    [InlineData(" 8800 ", 8800)]
    [InlineData("0", 8700)]
    [InlineData("70000", 8700)]
    [InlineData("-1", 8700)]
    [InlineData("12ab", 8700)]
    public void Ports_fall_back_to_the_default(string? value, int expected)
    {
        Assert.Equal(expected, TraySettings.ParsePort(value, 8700));
    }

    [Theory]
    [InlineData(null, "127.0.0.1")]
    [InlineData("", "127.0.0.1")]
    [InlineData("0.0.0.0", "127.0.0.1")]
    [InlineData("::", "127.0.0.1")]
    [InlineData("127.0.0.1", "127.0.0.1")]
    [InlineData("localhost", "localhost")]
    [InlineData("[::1]", "::1")]
    public void Wildcard_bind_addresses_map_to_loopback(string? host, string expected)
    {
        Assert.Equal(expected, TraySettings.ClientHost(host));
    }

    [Fact]
    public void Ipv6_loopback_builds_a_valid_url()
    {
        File.WriteAllText(Path.Combine(_root, ".env"), "CORE_HOST=::1\n");
        var s = TraySettings.Resolve(["--repo-root", _root], Env(), _root);
        Assert.Equal("http://[::1]:8700/", s.CoreBaseUrl.ToString());
    }
}

public class DotEnvTests
{
    [Fact]
    public void Parses_keys_comments_quotes_and_export()
    {
        var d = DotEnv.Parse("""
            # comment
            CORE_PORT=8800
            export CORE_HOST = 0.0.0.0
            EMPTY=
            QUOTED="a # not a comment"
            SINGLE='x y'
            INLINE=value # comment
            NOEQUALS
            =novalue
            NL="a\nb"
            """);
        Assert.Equal("8800", d["CORE_PORT"]);
        Assert.Equal("0.0.0.0", d["CORE_HOST"]);
        Assert.Equal("", d["EMPTY"]);
        Assert.Equal("a # not a comment", d["QUOTED"]);
        Assert.Equal("x y", d["SINGLE"]);
        Assert.Equal("value", d["INLINE"]);
        Assert.Equal("a\nb", d["NL"]);
        Assert.False(d.ContainsKey("NOEQUALS"));
        Assert.Equal(7, d.Count);
    }

    [Fact]
    public void Missing_file_gives_an_empty_set()
    {
        Assert.Empty(DotEnv.Load(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), ".env")));
    }
}
