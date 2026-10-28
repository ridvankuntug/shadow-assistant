using System.Diagnostics;
using System.Text;

namespace ShadowTray;

/// <summary>
/// Starts/stops the speech containers (deploy\docker-compose.yml) by running
/// docker.exe directly, the same commands as docs/05-deploy.md:
/// <c>docker compose --env-file ..\.env up -d</c> / <c>down</c> (volumes are kept),
/// and the game-mode commands (<see cref="GameModeController"/>).
/// </summary>
public sealed class DockerCompose(string? dockerExe, string? deployDir, string? envFile, RotatingLog log) : IComposeRunner
{
    /// <summary>docker.exe from PATH, else Docker Desktop's default install folder.</summary>
    public static string? Find(Func<string, string?> getEnv)
    {
        var onPath = TraySettings.FindOnPath("docker.exe", getEnv("PATH"));
        if (onPath is not null) return onPath;
        var programFiles = getEnv("ProgramFiles");
        if (string.IsNullOrEmpty(programFiles)) return null;
        var candidate = Path.Combine(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe");
        return File.Exists(candidate) ? candidate : null;
    }

    public bool Available => dockerExe is not null && deployDir is not null
                             && File.Exists(Path.Combine(deployDir, "docker-compose.yml"));

    /// <summary>The compose command for <paramref name="verb"/> ("up" means <c>up -d</c>, "down").</summary>
    public static IReadOnlyList<string> Command(string verb) => verb == "up" ? ["up", "-d"] : [verb];

    /// <summary>Arguments for <paramref name="verb"/> ("up" or "down").</summary>
    public static IReadOnlyList<string> Arguments(string verb, string? envFile) => Arguments(Command(verb), envFile);

    /// <summary><c>compose [--env-file &lt;file&gt;] &lt;command...&gt;</c>.</summary>
    public static IReadOnlyList<string> Arguments(IReadOnlyList<string> command, string? envFile)
    {
        var args = new List<string> { "compose" };
        // --env-file fails when the file is missing; every compose value has a default.
        if (envFile is not null && File.Exists(envFile)) args.AddRange(["--env-file", envFile]);
        args.AddRange(command);
        return args;
    }

    /// <returns>docker's exit code (-1 when it could not be started).</returns>
    public Task<int> RunAsync(string verb) => RunAsync(Command(verb));

    /// <returns>docker's exit code (-1 when it could not be started).</returns>
    public async Task<int> RunAsync(IReadOnlyList<string> command)
    {
        if (!Available) return -1;
        var verb = string.Join(' ', command);
        var psi = new ProcessStartInfo(dockerExe!)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = deployDir!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        foreach (var a in Arguments(command, envFile)) psi.ArgumentList.Add(a);

        log.Info($"docker compose {verb}: starting");
        using var p = new Process { StartInfo = psi };
        p.OutputDataReceived += (_, e) => { if (e.Data is not null) log.Info("docker: " + e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data is not null) log.Info("docker: " + e.Data); };
        try
        {
            p.Start();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            log.Info($"docker compose {verb}: could not start docker.exe: {ex.Message}");
            return -1;
        }
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        await p.WaitForExitAsync().ConfigureAwait(false);
        log.Info($"docker compose {verb}: exit code {p.ExitCode}");
        return p.ExitCode;
    }
}
