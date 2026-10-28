using System.Collections.Concurrent;
using ShadowTray;

namespace ShadowTray.Tests;

/// <summary>Starts a real process (Windows PowerShell stands in for node).</summary>
public sealed class NodeLauncherTests
{
    private static readonly string PowerShell =
        Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");

    [Fact]
    public async Task Exited_completes_only_after_all_output_was_read()
    {
        // A short-lived "crash": lots of stderr, a last line, a non-zero code.
        const string script =
            "1..3000 | % { [Console]::Error.WriteLine('line ' + $_) }; " +
            "[Console]::Error.WriteLine('FATAL last line'); exit 3";
        var lines = new ConcurrentQueue<string>();
        var warnings = new ConcurrentQueue<string>();
        using var launcher = new NodeLauncher(PowerShell, script, Path.GetTempPath(), warnings.Enqueue);
        // A slow consumer (like a busy log file) keeps the reader behind the
        // process, so the process exits while lines are still unread.
        using var proc = launcher.Start(line =>
        {
            var until = System.Diagnostics.Stopwatch.GetTimestamp() + System.Diagnostics.Stopwatch.Frequency / 2000;
            while (System.Diagnostics.Stopwatch.GetTimestamp() < until) { }
            lines.Enqueue(line);
        });

        var code = await proc.Exited.WaitAsync(TimeSpan.FromSeconds(60));
        // Snapshot right when Exited completes: nothing may arrive later.
        var seen = lines.ToArray();

        Assert.Equal(3, code);
        Assert.Equal("FATAL last line", seen[^1]);
        Assert.Equal(3001, seen.Count(l => l.StartsWith("line ", StringComparison.Ordinal) || l == "FATAL last line"));
        Assert.Empty(warnings);
    }

    [Fact]
    public void Ctrl_c_is_not_sent_when_the_helper_cannot_be_started()
    {
        var old = ConsoleCtrl.HelperPath;
        try
        {
            ConsoleCtrl.HelperPath = Path.Combine(Path.GetTempPath(), "does-not-exist-" + Guid.NewGuid().ToString("N") + ".exe");
            var warnings = new List<string>();
            Assert.False(ConsoleCtrl.SendCtrlC(Environment.ProcessId, warnings.Add));
            Assert.Single(warnings);
        }
        finally
        {
            ConsoleCtrl.HelperPath = old;
        }
    }
}
