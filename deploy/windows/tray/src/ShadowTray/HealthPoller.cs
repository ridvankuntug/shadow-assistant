namespace ShadowTray;

/// <param name="At">When the request was sent (UTC).</param>
public sealed record HealthReading(CoreHealth Health, DateTimeOffset At);

/// <summary>
/// Polls the Core's <c>GET /health</c> (unauthenticated; names, enabled flags
/// and statuses only — see docs/02-core-protocol.md). The Core itself checks
/// home-assistant, whisper-svc and tts-svc every CORE_HEALTH_INTERVAL_MS, so
/// the tray never talks to those services directly.
/// </summary>
public sealed class HealthPoller : IDisposable
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly HttpClient _http;
    private readonly Uri _healthUrl;
    private readonly Func<bool> _shouldPoll;
    private readonly CancellationTokenSource _cts = new();
    private HealthReading? _latest;

    /// <param name="shouldPoll">Polls only while this is true (the Core is running).</param>
    public HealthPoller(Uri coreBaseUrl, Func<bool> shouldPoll)
    {
        _healthUrl = new Uri(coreBaseUrl, "/health");
        _shouldPoll = shouldPoll;
        _http = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
    }

    /// <summary>Latest result; null while the Core is not running or before the first poll.</summary>
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
                    using var res = await _http.GetAsync(_healthUrl, _cts.Token).ConfigureAwait(false);
                    result = res.IsSuccessStatusCode
                        ? CoreHealth.Parse(await res.Content.ReadAsStringAsync(_cts.Token).ConfigureAwait(false))
                        : CoreHealth.Unreachable;
                }
                catch (OperationCanceledException) when (_cts.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
                {
                    result = CoreHealth.Unreachable;
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

    public void Dispose()
    {
        _cts.Cancel();
        _http.Dispose();
    }
}
