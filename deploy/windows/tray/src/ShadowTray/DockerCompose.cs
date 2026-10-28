using System.Diagnostics;
using System.Text;

namespace ShadowTray;

/// <summary>
/// Starts/stops the speech containers (deploy\docker-compose.yml) by running
/// docker.exe directly, the same commands as docs/05-deploy.md:
/// <c>docker compose --env-file ..\.env up -d</c> / <c>down</c> (volumes are kept).
/// </summary>
public sealed class DockerCompose(string? dockerExe, string? deployDir, string? envFile, RotatingLog log)
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

    /// <summary>Arguments for <paramref name="verb"/> ("up" or "down").</summary>
    public static IReadOnlyList<string> Arguments(string verb, string? envFile)
    {
        var args = new List<string> { "compose" };
        // --env-file fails when the file is missing; every compose value has a default.
        if (envFile is not null && File.Exists(envFile)) args.AddRange(["--env-file", envFile]);
        args.Add(verb);
        if (verb == "up") args.Add("-d");
        return args;
    }

    /// <returns>docker's exit code (-1 when it could not be started).</returns>
    public async Task<int> RunAsync(string verb)
    {
        if (!Available) return -1;
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
        foreach (var a in Arguments(verb, envFile)) psi.ArgumentList.Add(a);

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
