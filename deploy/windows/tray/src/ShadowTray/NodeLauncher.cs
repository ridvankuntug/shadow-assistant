using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace ShadowTray;

/// <summary>
/// Starts <c>node core\dist\index.js</c> directly (no cmd.exe / PowerShell in
/// between), from the repo root, without a console window, with stdout and
/// stderr captured as UTF-8, inside a kill-on-close job object.
/// </summary>
public sealed class NodeLauncher : ICoreLauncher, IDisposable
{
    private static readonly UTF8Encoding Utf8NoBom = new(false);
    /// <summary>
    /// How long <see cref="ICoreProcess.Exited"/> waits, after the process has
    /// exited, for the rest of its stdout/stderr. Bounded because a leftover
    /// child holding the pipe open would otherwise delay it forever (the job
    /// kills such leftovers on dispose).
    /// </summary>
    private static readonly TimeSpan OutputDrainTimeout = TimeSpan.FromSeconds(3);

    private readonly string _nodePath;
    private readonly string _entry;
    private readonly string _workingDirectory;
    private readonly KillOnCloseJob? _job;
    private readonly Action<string> _warn;

    public NodeLauncher(string nodePath, string entry, string workingDirectory, Action<string> warn)
    {
        _nodePath = nodePath;
        _entry = entry;
        _workingDirectory = workingDirectory;
        _warn = warn;
        try
        {
            _job = new KillOnCloseJob();
        }
        catch (Win32Exception ex)
        {
            _job = null;
            warn("warning: no job object (" + ex.Message + "); the Core will not be stopped if the tray crashes");
        }
    }

    public string Describe() => $"\"{_nodePath}\" \"{_entry}\" (working directory {_workingDirectory})";

    public ICoreProcess Start(Action<string> output)
    {
        var psi = new ProcessStartInfo(_nodePath)
        {
            UseShellExecute = false,
            // CREATE_NO_WINDOW: node gets a console without a window, so Windows
            // Terminal (the default terminal) never opens one, and Ctrl+C can
            // still be delivered through that console (ConsoleCtrl).
            CreateNoWindow = true,
            WorkingDirectory = _workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
        };
        psi.ArgumentList.Add(_entry);

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var exited = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        // e.Data == null marks the end of a stream. Exited completes only after
        // both ended (or the drain timeout), so the last lines of a crash (fatal
        // message, stack trace) are in core.log before the process is disposed.
        var stdoutDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stderrDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        process.Exited += (_, _) =>
        {
            int code;
            try { code = process.ExitCode; }
            catch (InvalidOperationException) { code = -1; }
            _ = CompleteAfterDrainAsync(code);
        };
        process.OutputDataReceived += (_, e) => { if (e.Data is null) stdoutDone.TrySetResult(); else output(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is null) stderrDone.TrySetResult(); else output(e.Data); };

        async Task CompleteAfterDrainAsync(int code)
        {
            try
            {
                await Task.WhenAll(stdoutDone.Task, stderrDone.Task).WaitAsync(OutputDrainTimeout).ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                _warn("warning: Core output did not end within " +
                      OutputDrainTimeout.TotalSeconds.ToString("0", System.Globalization.CultureInfo.InvariantCulture) +
                      "s of its exit; the last lines may be missing");
            }
            finally
            {
                exited.TrySetResult(code);
            }
        }

        process.Start();
        var inJob = false;
        if (_job is not null)
        {
            // Small window: node runs for a moment before it is in the job. The
            // Core starts no child process during start-up, so nothing escapes.
            try
            {
                _job.Assign(process);
                inJob = true;
            }
            catch (Win32Exception ex)
            {
                _warn("warning: could not put the Core into the job object (" + ex.Message + ")");
            }
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return new NodeProcess(process, exited.Task, inJob ? _job : null, _warn);
    }

    public void Dispose() => _job?.Dispose();

    private sealed class NodeProcess(Process process, Task<int> exited, KillOnCloseJob? job, Action<string> warn) : ICoreProcess
    {
        private readonly int _id = process.Id;
        private bool _disposed;

        public int Id => _id;
        public Task<int> Exited => exited;

        public bool RequestGracefulStop() => !exited.IsCompleted && ConsoleCtrl.SendCtrlC(_id, warn);

        public void Kill()
        {
            // The job is shared by every run of this launcher: once this run is
            // over (exited and drained, or disposed) terminating it could only
            // hit a newer Core. Leftovers of this run are killed by Dispose.
            if (_disposed || exited.IsCompleted) return;
            if (job is not null)
            {
                job.Terminate();
                return;
            }
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { /* already exited */ }
            catch (Win32Exception) { /* access denied / exiting */ }
        }

        public void Dispose()
        {
            if (_disposed) return;
            // Anything the Core started and left behind goes with it.
            if (exited.IsCompleted) job?.Terminate();
            _disposed = true;
            process.Dispose();
        }
    }
}
