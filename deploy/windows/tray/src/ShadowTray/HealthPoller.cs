namespace ShadowTray;

/// <param name="At">When the request was sent (UTC).</param>
public sealed record HealthReading(CoreHealth Health, DateTimeOffset At);

/// <summary>
/// Polls the Core's <c>GET /health</c> for the UI (see <see cref="HttpCoreHealthProbe"/>).
/// The Core itself checks home-assistant, whisper-svc and tts-svc every
/// CORE_HEALTH_INTERVAL_MS, so the tray never talks to those services directly.
/// </summary>
public sealed class HealthPoller : IDisposable
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly ICoreHealthProbe _probe;
    private readonly Func<bool> _shouldPoll;
    private readonly CancellationTokenSource _cts = new();
    private HealthReading? _latest;

    /// <param name="shouldPoll">Polls only while this is true (a Core is running: the tray's own or an external one).</param>
    public HealthPoller(ICoreHealthProbe probe, Func<bool> shouldPoll)
    {
        _probe = probe;
        _shouldPoll = shouldPoll;
    }

    /// <summary>Latest result; null while no Core is running or before the first poll.</summary>
    public HealthReading? Latest => Volatile.Read(ref _latest);

    public void Start() => _ = Task.Run(LoopAsync);

    private async Task LoopAsync()
    {
        using var timer = new PeriodicTimer(Interval);
        do
        {
            CoreHealth? result = null;
            var startedAt = DateTimeOffset.UtcNow;
            if (_shouldPoll())
            {
                try
                {
                    result = await _probe.CheckAsync(_cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_cts.IsCancellationRequested)
                {
                    return;
                }
            }
            Volatile.Write(ref _latest, result is null ? null : new HealthReading(result, startedAt));
        }
        while (await WaitAsync(timer).ConfigureAwait(false));
    }

    private async Task<bool> WaitAsync(PeriodicTimer timer)
    {
        try
        {
            return await timer.WaitForNextTickAsync(_cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>Does not dispose the probe (the owner does).</summary>
    public void Dispose() => _cts.Cancel();
}
