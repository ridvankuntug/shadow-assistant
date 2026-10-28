using System.Globalization;

namespace ShadowTray;

/// <summary>A started Core process.</summary>
public interface ICoreProcess : IDisposable
{
    int Id { get; }
    /// <summary>Completes with the exit code when the process has exited.</summary>
    Task<int> Exited { get; }
    /// <summary>Asks the process to shut down (Ctrl+C); false when that could not be sent.</summary>
    bool RequestGracefulStop();
    /// <summary>Kills the process and everything it started.</summary>
    void Kill();
}

public interface ICoreLauncher
{
    /// <summary>Starts the Core; every stdout/stderr line goes to <paramref name="output"/>.</summary>
    ICoreProcess Start(Action<string> output);
    /// <summary>For the log: what is started.</summary>
    string Describe();
}

/// <summary>
/// Runs the Core and restarts it after a crash, following run-core.ps1:
/// backoff from <see cref="RestartTracker"/>, no restart after exit code 0,
/// give up after too many short runs. A stop asked for through
/// <see cref="StopAsync"/> never triggers a restart.
///
/// All public members are thread-safe; the UI reads <see cref="Snapshot"/> on a timer.
/// Lifecycle decisions (start, stop, restart, dispose) are made under one lock,
/// and <see cref="StopAsync"/> / <see cref="Dispose"/> bump a generation counter:
/// a <see cref="RestartAsync"/> that began earlier sees the change and does not
/// start the Core again (e.g. Çıkış or Durdur while a restart is stopping the Core).
/// After <see cref="Dispose"/> nothing is ever started again.
/// </summary>
public sealed class CoreSupervisor : IDisposable
{
    private readonly ICoreLauncher _launcher;
    private readonly RestartPolicy _policy;
    private readonly RotatingLog _log;
    private readonly Func<IReadOnlyList<string>> _startProblems;
    private readonly TimeProvider _time;
    private readonly object _gate = new();

    private SupervisorSnapshot _snapshot = SupervisorSnapshot.Initial;
    private Task? _loop;
    private CancellationTokenSource? _stopCts;
    private CancellationTokenSource? _skipWaitCts;
    private ICoreProcess? _current;
    private bool _stopRequested;
    /// <summary>Bumped by every explicit stop and by dispose ("the user wants it stopped").</summary>
    private long _generation;
    private bool _disposed;

    public CoreSupervisor(ICoreLauncher launcher, RestartPolicy policy, RotatingLog log,
        Func<IReadOnlyList<string>> startProblems, TimeProvider? time = null)
    {
        _launcher = launcher;
        _policy = policy;
        _log = log;
        _startProblems = startProblems;
        _time = time ?? TimeProvider.System;
    }

    public SupervisorSnapshot Snapshot
    {
        get { lock (_gate) return _snapshot; }
    }

    /// <summary>
    /// Starts the supervisor loop with fresh failure counters. While waiting
    /// for a restart it restarts right away instead; while running it does nothing.
    /// </summary>
    public void Start()
    {
        lock (_gate) StartLocked();
    }

    /// <summary>Caller holds <see cref="_gate"/>. Does nothing after <see cref="Dispose"/>.</summary>
    private void StartLocked()
    {
        if (_disposed) return;
        if (_loop is { IsCompleted: false })
        {
            if (!_stopRequested && _snapshot.State == CoreRunState.WaitingRestart) _skipWaitCts?.Cancel();
            return;
        }
        _stopRequested = false;
        _stopCts?.Dispose();
        _stopCts = new CancellationTokenSource();
        var token = _stopCts.Token;
        _loop = Task.Run(() => RunGuardedAsync(token));
    }

    /// <summary>
    /// Stops the Core: Ctrl+C first, then kill after <paramref name="grace"/>.
    /// Completes when the supervisor loop has ended. Cancels a restart in progress.
    /// </summary>
    public Task StopAsync(TimeSpan grace)
    {
        lock (_gate) _generation++;
        return StopCoreAsync(grace);
    }

    /// <summary>
    /// Stops the Core, then starts it again with fresh counters, unless
    /// <see cref="StopAsync"/> or <see cref="Dispose"/> was called in the meantime.
    /// </summary>
    public async Task RestartAsync(TimeSpan grace)
    {
        long generation;
        lock (_gate)
        {
            if (_disposed) return;
            generation = _generation;
        }
        await StopCoreAsync(grace).ConfigureAwait(false);
        lock (_gate)
        {
            // Checked and started under the same lock StopAsync/Dispose take, so a
            // stop cannot slip in between the check and the start.
            if (_disposed || _generation != generation)
            {
                _log.Info("restart cancelled: stop or exit requested meanwhile");
                return;
            }
            StartLocked();
        }
    }

    /// <summary>
    /// Nothing is started after this. Does not wait for a running Core: the
    /// owner disposes the launcher next, whose job object kills it.
    /// </summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _generation++;
            // Ends a wait for the next restart at once.
            _stopCts?.Cancel();
        }
    }

    private async Task StopCoreAsync(TimeSpan grace)
    {
        Task? loop;
        ICoreProcess? proc;
        lock (_gate)
        {
            loop = _loop;
            if (loop is null || loop.IsCompleted) return;
            // A second caller only waits; a second Ctrl+C would hit Node's default
            // SIGINT handling (the Core's handler is registered once) and kill it.
            proc = _stopRequested ? null : _current;
            _stopRequested = true;
            _stopCts!.Cancel();
            if (proc is not null) _snapshot = _snapshot with { State = CoreRunState.Stopping };
        }

        if (proc is not null)
        {
            _log.Info("stopping Core (Ctrl+C)");
            var sent = proc.RequestGracefulStop();
            var exited = sent && await Task.WhenAny(proc.Exited, Task.Delay(grace, _time)).ConfigureAwait(false) == proc.Exited;
            if (!exited)
            {
                _log.Info(sent
                    ? string.Create(CultureInfo.InvariantCulture, $"Core did not stop within {grace.TotalSeconds:0}s; killing it")
                    : "could not send Ctrl+C to the Core; killing it");
                proc.Kill();
            }
        }
        await loop.ConfigureAwait(false);
    }

    private void Set(SupervisorSnapshot s)
    {
        lock (_gate) _snapshot = s;
    }

    private async Task RunGuardedAsync(CancellationToken stop)
    {
        try
        {
            await RunAsync(stop).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // A bug here must not leave the icon claiming the Core is running.
            _log.Info("error: supervisor failed: " + ex.Message);
            lock (_gate)
            {
                _current = null;
                _snapshot = new SupervisorSnapshot(CoreRunState.Failed, Problem: "denetleyici hatası: " + ex.Message);
            }
        }
    }

    private async Task RunAsync(CancellationToken stop)
    {
        var tracker = new RestartTracker(_policy);
        int? lastCode = null;
        while (true)
        {
            var problems = _startProblems();
            if (problems.Count > 0)
            {
                foreach (var p in problems) _log.Info("error: " + p);
                Set(new SupervisorSnapshot(CoreRunState.Failed, Problem: problems[0], LastExitCode: lastCode));
                return;
            }

            ICoreProcess proc;
            DateTimeOffset started;
            lock (_gate)
            {
                if (stop.IsCancellationRequested || _disposed)
                {
                    _snapshot = new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: lastCode);
                    return;
                }
                _log.Info("starting Core: " + _launcher.Describe());
                try
                {
                    proc = _launcher.Start(_log.WriteRaw);
                }
                catch (Exception ex)
                {
                    _log.Info("error: could not start the Core: " + ex.Message);
                    _snapshot = new SupervisorSnapshot(CoreRunState.Failed, Problem: "başlatılamadı: " + ex.Message);
                    return;
                }
                started = _time.GetUtcNow();
                _current = proc;
                _snapshot = new SupervisorSnapshot(CoreRunState.Running, RunningSince: started,
                    Failures: tracker.Failures, MaxFailures: _policy.MaxFailures, LastExitCode: lastCode);
            }

            var code = await proc.Exited.ConfigureAwait(false);
            var up = _time.GetUtcNow() - started;
            lock (_gate) _current = null;
            // Kills anything the Core left behind in its job.
            proc.Dispose();
            lastCode = code;
            var upText = ((int)up.TotalSeconds).ToString(CultureInfo.InvariantCulture);

            if (stop.IsCancellationRequested)
            {
                _log.Info($"Core stopped on request (code {code}) after {upText}s.");
                Set(new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: code));
                return;
            }

            var decision = tracker.OnExit(code, up);
            switch (decision.Action)
            {
                case ExitAction.Stop:
                    _log.Info($"Core exited cleanly (code 0) after {upText}s; not restarting.");
                    Set(new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: code));
                    return;
                case ExitAction.GiveUp:
                    _log.Info($"Core failed {decision.Failures} times in a row (last code {code}); giving up. Fix the cause (see above), then use Başlat in the tray menu.");
                    Set(new SupervisorSnapshot(CoreRunState.GaveUp, Failures: decision.Failures,
                        MaxFailures: _policy.MaxFailures, LastExitCode: code));
                    return;
            }

            var delaySeconds = ((int)decision.Delay.TotalSeconds).ToString(CultureInfo.InvariantCulture);
            _log.Info($"Core exited with code {code} after {upText}s; restart {decision.Failures}/{_policy.MaxFailures - 1} in {delaySeconds}s.");
            CancellationTokenSource skip;
            lock (_gate)
            {
                _skipWaitCts?.Dispose();
                _skipWaitCts = skip = new CancellationTokenSource();
                _snapshot = new SupervisorSnapshot(CoreRunState.WaitingRestart, NextRestartAt: _time.GetUtcNow() + decision.Delay,
                    Failures: decision.Failures, MaxFailures: _policy.MaxFailures, LastExitCode: code);
            }
            using var both = CancellationTokenSource.CreateLinkedTokenSource(stop, skip.Token);
            try
            {
                await Task.Delay(decision.Delay, _time, both.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!stop.IsCancellationRequested)
            {
                // "Başlat" while waiting: restart now with fresh counters.
                _log.Info("restart requested; starting now.");
                tracker.Reset();
            }
            catch (OperationCanceledException)
            {
                _log.Info("stop requested while waiting to restart.");
                Set(new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: code));
                return;
            }
        }
    }
}
