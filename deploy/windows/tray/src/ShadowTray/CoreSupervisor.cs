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

/// <summary>Timing of the supervisor's /health use; defaults for production, short values in tests.</summary>
public sealed record SupervisorTiming
{
    /// <summary>
    /// A stop waits at most this long after the Core's start for its first
    /// /health answer before sending Ctrl+C (see <see cref="CoreSupervisor.StopAsync"/>).
    /// </summary>
    public TimeSpan ReadyTimeout { get; init; } = TimeSpan.FromSeconds(5);
    /// <summary>Pause between /health tries during that wait.</summary>
    public TimeSpan ReadyPollInterval { get; init; } = TimeSpan.FromMilliseconds(250);
    /// <summary>How often an external Core's /health is checked.</summary>
    public TimeSpan ExternalPollInterval { get; init; } = TimeSpan.FromSeconds(5);
    /// <summary>
    /// Missed /health answers in a row after which an external Core counts as
    /// gone and the tray starts its own. More than one, so a single slow answer
    /// of a busy Core does not start a second node (which would fail on the port).
    /// </summary>
    public int ExternalMissesBeforeStart { get; init; } = 2;

    public static SupervisorTiming Default { get; } = new();
}

/// <summary>
/// Runs the Core and restarts it after a crash, following run-core.ps1:
/// backoff from <see cref="RestartTracker"/>, no restart after exit code 0,
/// give up after too many short runs. A stop asked for through
/// <see cref="StopAsync"/> never triggers a restart.
///
/// External Core: before every start the supervisor asks the configured
/// Core's /health (when it has a probe). If a Core already answers (started by
/// hand, e.g. <c>npm run dev</c>), it starts no second node; it reports
/// <see cref="CoreRunState.External"/> and keeps checking. Once that Core has
/// missed <see cref="SupervisorTiming.ExternalMissesBeforeStart"/> checks in a
/// row, the supervisor starts its own Core, so a tray started at sign-in ends
/// up supervising the Core.
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
    private readonly ICoreHealthProbe? _probe;
    private readonly SupervisorTiming _timing;
    private readonly TimeProvider _time;
    private readonly object _gate = new();

    private SupervisorSnapshot _snapshot = SupervisorSnapshot.Initial;
    private Task? _loop;
    private CancellationTokenSource? _stopCts;
    private CancellationTokenSource? _skipWaitCts;
    private ICoreProcess? _current;
    private DateTimeOffset _currentStarted;
    private bool _stopRequested;
    /// <summary>
    /// <see cref="StopCoreAsync"/> calls not yet finished. While one runs, a
    /// start is deferred (see <see cref="StartLocked"/>), so an older stop can
    /// never signal or kill a Core started after it began.
    /// </summary>
    private int _stopsInProgress;
    /// <summary>A start asked for while a stop was still in progress; done when the last stop ends.</summary>
    private bool _startAfterStop;
    /// <summary>Bumped by every explicit stop and by dispose ("the user wants it stopped").</summary>
    private long _generation;
    private bool _disposed;

    /// <param name="probe">
    /// The Core's /health. Null: no external-Core detection and no wait for a
    /// just-started Core before Ctrl+C.
    /// </param>
    public CoreSupervisor(ICoreLauncher launcher, RestartPolicy policy, RotatingLog log,
        Func<IReadOnlyList<string>> startProblems, ICoreHealthProbe? probe = null,
        SupervisorTiming? timing = null, TimeProvider? time = null)
    {
        _launcher = launcher;
        _policy = policy;
        _log = log;
        _startProblems = startProblems;
        _probe = probe;
        _timing = timing ?? SupervisorTiming.Default;
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

    /// <summary>
    /// Caller holds <see cref="_gate"/>. Does nothing after <see cref="Dispose"/>.
    /// While a stop is still in progress (its loop may already have ended, e.g.
    /// the Core exited by itself during the stop's /health wait) the start is
    /// deferred until the last stop has finished; a later <see cref="StopAsync"/>
    /// cancels it.
    /// </summary>
    private void StartLocked()
    {
        if (_disposed) return;
        if (_loop is { IsCompleted: false })
        {
            if (!_stopRequested && _snapshot.State == CoreRunState.WaitingRestart) _skipWaitCts?.Cancel();
            return;
        }
        if (_stopsInProgress > 0)
        {
            if (!_startAfterStop) _log.Info("start requested while a stop is still finishing; starting once it has");
            _startAfterStop = true;
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
    /// Completes when the supervisor loop has ended. Cancels a restart in
    /// progress, and ends the watch of an external Core (which keeps running).
    ///
    /// Right after a start the Core may not have registered its SIGINT handler
    /// yet; a Ctrl+C then ends node through the default handler, skipping the
    /// clean shutdown. The Core registers the handler right after it starts
    /// listening, so a /health answer means it is in place: the stop first
    /// waits for one, but never past <see cref="SupervisorTiming.ReadyTimeout"/>
    /// after the start (a Core running longer than that is signalled at once).
    ///
    /// <paramref name="budget"/> (null: none) bounds the whole stop, for callers
    /// that can only wait so long (sign-out / shutdown): the /health wait ends
    /// <paramref name="grace"/> before the deadline, the Ctrl+C helper and the
    /// grace period are cut at the deadline, the Core is then killed, and the
    /// returned task completes by the deadline even if the supervisor loop has
    /// not finished its bookkeeping yet.
    /// </summary>
    public Task StopAsync(TimeSpan grace, TimeSpan? budget = null)
    {
        lock (_gate)
        {
            _generation++;
            // The user wants it stopped: a start deferred behind an earlier stop is off.
            _startAfterStop = false;
        }
        return StopCoreAsync(grace, budget);
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
        await StopCoreAsync(grace, budget: null).ConfigureAwait(false);
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
            _startAfterStop = false;
            // Ends a wait for the next restart at once.
            _stopCts?.Cancel();
        }
    }

    private async Task StopCoreAsync(TimeSpan grace, TimeSpan? budget)
    {
        DateTimeOffset? deadline = budget is { } b ? _time.GetUtcNow() + b : null;
        Task? loop;
        ICoreProcess? proc;
        DateTimeOffset started;
        lock (_gate)
        {
            loop = _loop;
            if (loop is null || loop.IsCompleted) return;
            // A second caller only waits; a second Ctrl+C would hit Node's default
            // SIGINT handling (the Core's handler is registered once) and kill it.
            proc = _stopRequested ? null : _current;
            started = _currentStarted;
            _stopRequested = true;
            _stopCts!.Cancel();
            _stopsInProgress++;
            if (proc is not null) _snapshot = _snapshot with { State = CoreRunState.Stopping };
        }

        try
        {
            if (proc is not null) await SignalThenKillAsync(proc, started, grace, deadline).ConfigureAwait(false);
            await WaitUntilAsync(loop, deadline).ConfigureAwait(false);
        }
        finally
        {
            lock (_gate)
            {
                _stopsInProgress--;
                if (_stopsInProgress == 0 && _startAfterStop)
                {
                    _startAfterStop = false;
                    StartLocked();
                }
            }
        }
    }

    /// <summary>
    /// Ctrl+C to <paramref name="proc"/>, kill after the grace. Neither is done
    /// once <paramref name="proc"/> has exited or is no longer the current run:
    /// <see cref="ICoreProcess.Kill"/> ends the launcher's job object, which is
    /// shared by all runs, so a late kill would take a newer Core with it.
    /// </summary>
    private async Task SignalThenKillAsync(ICoreProcess proc, DateTimeOffset started, TimeSpan grace, DateTimeOffset? deadline)
    {
        await WaitUntilReadyAsync(proc, started, deadline - grace).ConfigureAwait(false);
        if (!IsCurrent(proc))
        {
            _log.Info("Core exited while the stop waited for it; nothing to signal");
            return;
        }
        _log.Info("stopping Core (Ctrl+C)");
        var sent = await SendCtrlCAsync(proc, deadline).ConfigureAwait(false);
        var exited = false;
        var wait = Remaining(grace, deadline);
        if (sent)
        {
            exited = proc.Exited.IsCompleted ||
                     (wait > TimeSpan.Zero && await Task.WhenAny(proc.Exited, Task.Delay(wait, _time)).ConfigureAwait(false) == proc.Exited);
        }
        if (exited) return;
        lock (_gate)
        {
            // Checked and killed under the lock: while proc is the current run,
            // its loop cannot end, so no newer Core can be started before the
            // kill has landed.
            if (!ReferenceEquals(_current, proc) || proc.Exited.IsCompleted) return;
            _log.Info(!sent
                ? "could not send Ctrl+C to the Core; killing it"
                : wait < grace
                    ? "Core did not stop before the stop deadline; killing it"
                    : string.Create(CultureInfo.InvariantCulture, $"Core did not stop within {grace.TotalSeconds:0}s; killing it"));
            proc.Kill();
        }
    }

    private bool IsCurrent(ICoreProcess proc)
    {
        lock (_gate) return ReferenceEquals(_current, proc) && !proc.Exited.IsCompleted;
    }

    /// <summary>
    /// Sends Ctrl+C. With a deadline the helper (normally well under a second,
    /// up to its own 5 s timeout) runs in the background and is given up on
    /// (false: kill instead) when it has not finished by then.
    /// </summary>
    private async Task<bool> SendCtrlCAsync(ICoreProcess proc, DateTimeOffset? deadline)
    {
        if (deadline is null) return proc.RequestGracefulStop();
        var remaining = Remaining(TimeSpan.MaxValue, deadline);
        if (remaining <= TimeSpan.Zero)
        {
            _log.Info("stop deadline reached before Ctrl+C could be sent");
            return false;
        }
        var send = Task.Run(proc.RequestGracefulStop);
        if (await Task.WhenAny(send, Task.Delay(remaining, _time)).ConfigureAwait(false) == send)
            return await send.ConfigureAwait(false);
        _log.Info("Ctrl+C helper did not finish before the stop deadline");
        return false;
    }

    /// <summary>Waits for <paramref name="task"/>, but not past <paramref name="deadline"/> (null: no limit).</summary>
    private async Task WaitUntilAsync(Task task, DateTimeOffset? deadline)
    {
        if (deadline is not null)
        {
            var remaining = Remaining(TimeSpan.MaxValue, deadline);
            if (remaining <= TimeSpan.Zero || await Task.WhenAny(task, Task.Delay(remaining, _time)).ConfigureAwait(false) != task)
            {
                if (!task.IsCompleted) _log.Info("stop deadline reached before the supervisor finished; not waiting longer");
                return;
            }
        }
        await task.ConfigureAwait(false);
    }

    /// <summary><paramref name="value"/>, cut to the time left until <paramref name="deadline"/> (null: not cut).</summary>
    private TimeSpan Remaining(TimeSpan value, DateTimeOffset? deadline)
    {
        if (deadline is not { } d) return value;
        var left = d - _time.GetUtcNow();
        return left < value ? left : value;
    }

    /// <summary>
    /// Waits until the Core answers /health, it exits, or
    /// <see cref="SupervisorTiming.ReadyTimeout"/> after its start has passed,
    /// and never past <paramref name="limit"/> (a budgeted stop's deadline minus its grace).
    /// </summary>
    private async Task WaitUntilReadyAsync(ICoreProcess proc, DateTimeOffset started, DateTimeOffset? limit)
    {
        if (_probe is null) return;
        var deadline = started + _timing.ReadyTimeout;
        var cut = limit is { } l && l < deadline;
        if (cut) deadline = limit!.Value;
        if (_time.GetUtcNow() >= deadline) return;
        while (!proc.Exited.IsCompleted)
        {
            var remaining = deadline - _time.GetUtcNow();
            if (remaining <= TimeSpan.Zero)
            {
                _log.Info(cut
                    ? "stop deadline leaves no more time to wait for /health; sending Ctrl+C"
                    : string.Create(CultureInfo.InvariantCulture,
                        $"Core has not answered /health within {_timing.ReadyTimeout.TotalSeconds:0.#}s of its start; sending Ctrl+C anyway"));
                return;
            }
            using (var cts = new CancellationTokenSource(remaining, _time))
            {
                if (await IsAnsweringAsync(cts.Token).ConfigureAwait(false)) return;
            }
            remaining = deadline - _time.GetUtcNow();
            var pause = remaining < _timing.ReadyPollInterval ? remaining : _timing.ReadyPollInterval;
            if (pause > TimeSpan.Zero) await Task.WhenAny(proc.Exited, Task.Delay(pause, _time)).ConfigureAwait(false);
        }
    }

    /// <summary>One /health request; false when it does not answer, fails or is cancelled.</summary>
    private async Task<bool> IsAnsweringAsync(CancellationToken cancellationToken)
    {
        if (_probe is null) return false;
        try
        {
            return (await _probe.CheckAsync(cancellationToken).ConfigureAwait(false)).Reachable;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception ex)
        {
            _log.Info("warning: /health check failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// Watches an external Core until it has missed enough /health checks in a
    /// row (true: start our own now) or a stop / dispose is requested (false).
    /// </summary>
    private async Task<bool> WatchExternalAsync(CancellationToken stop, int? lastCode)
    {
        lock (_gate)
        {
            if (stop.IsCancellationRequested || _disposed) return false;
            _snapshot = new SupervisorSnapshot(CoreRunState.External, RunningSince: _time.GetUtcNow(), LastExitCode: lastCode);
        }
        _log.Info("a Core already answers /health (started outside the tray); not starting another one, watching it");
        var misses = 0;
        while (true)
        {
            try
            {
                await Task.Delay(_timing.ExternalPollInterval, _time, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            var up = await IsAnsweringAsync(stop).ConfigureAwait(false);
            if (stop.IsCancellationRequested) return false;
            misses = up ? 0 : misses + 1;
            if (misses >= _timing.ExternalMissesBeforeStart)
            {
                _log.Info("the external Core no longer answers /health; starting the tray's own Core");
                return true;
            }
        }
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
            if (await IsAnsweringAsync(stop).ConfigureAwait(false))
            {
                if (!await WatchExternalAsync(stop, lastCode).ConfigureAwait(false))
                {
                    _log.Info("stopped watching the external Core (stop or exit requested); it keeps running.");
                    Set(new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: lastCode));
                    return;
                }
                // Failures before the external Core are an older story.
                tracker.Reset();
            }

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
                _currentStarted = started;
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
