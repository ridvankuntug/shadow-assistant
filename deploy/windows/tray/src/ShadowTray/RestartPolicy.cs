namespace ShadowTray;

/// <summary>
/// Restart rules of the Core supervisor. Same defaults and semantics as
/// deploy/windows/run-core.ps1: 5 s doubling to 5 min, reset after 10 min of
/// uptime, give up after 20 short runs in a row, no restart after exit code 0.
/// </summary>
public sealed record RestartPolicy(
    TimeSpan InitialDelay,
    TimeSpan MaxDelay,
    TimeSpan StableUptime,
    int MaxFailures)
{
    public static RestartPolicy Default { get; } =
        new(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(10), 20);
}

public enum ExitAction
{
    /// <summary>Clean exit (code 0): do not restart.</summary>
    Stop,
    /// <summary>Restart after <see cref="ExitDecision.Delay"/>.</summary>
    Restart,
    /// <summary>Too many short runs in a row: stop trying.</summary>
    GiveUp,
}

/// <param name="Failures">Consecutive short-lived runs so far (including this one).</param>
public readonly record struct ExitDecision(ExitAction Action, TimeSpan Delay, int Failures);

/// <summary>
/// Decides what happens after the Core exited. Not thread-safe; one instance
/// per supervisor loop.
/// </summary>
public sealed class RestartTracker
{
    private readonly RestartPolicy _policy;
    private TimeSpan _delay;
    private int _failures;

    public RestartTracker(RestartPolicy policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (policy.InitialDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(policy), "InitialDelay must be positive.");
        if (policy.MaxDelay < policy.InitialDelay) throw new ArgumentOutOfRangeException(nameof(policy), "MaxDelay must be >= InitialDelay.");
        if (policy.MaxFailures < 1) throw new ArgumentOutOfRangeException(nameof(policy), "MaxFailures must be >= 1.");
        _policy = policy;
        _delay = policy.InitialDelay;
    }

    public RestartPolicy Policy => _policy;

    /// <summary>Consecutive short-lived runs so far.</summary>
    public int Failures => _failures;

    /// <summary>Forgets earlier failures (manual start / restart).</summary>
    public void Reset()
    {
        _delay = _policy.InitialDelay;
        _failures = 0;
    }

    public ExitDecision OnExit(int exitCode, TimeSpan uptime)
    {
        if (exitCode == 0) return new ExitDecision(ExitAction.Stop, TimeSpan.Zero, _failures);

        // A run that stayed up long enough counts as healthy: start over.
        if (uptime >= _policy.StableUptime) Reset();

        _failures++;
        if (_failures >= _policy.MaxFailures) return new ExitDecision(ExitAction.GiveUp, TimeSpan.Zero, _failures);

        var delay = _delay;
        var doubled = TimeSpan.FromTicks(Math.Min(_delay.Ticks * 2, _policy.MaxDelay.Ticks));
        _delay = doubled;
        return new ExitDecision(ExitAction.Restart, delay, _failures);
    }
}
