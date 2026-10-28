using System.Text.Json;

namespace ShadowTray;

/// <summary>One entry of the Core's <c>GET /health</c> <c>services</c> list.</summary>
/// <param name="Status">ok | loading | down | disabled | unknown (unknown = before the Core's first check round).</param>
/// <param name="Detail">
/// Optional short code from the Core's check (timeout, unreachable, http_503, …);
/// null when absent (older Cores never send it). Shown as free text.
/// </param>
public sealed record ServiceHealth(string Name, bool Enabled, string Status, string? Detail = null);

/// <summary>Result of one poll of the Core's <c>GET /health</c>.</summary>
public sealed record CoreHealth(bool Reachable, IReadOnlyList<ServiceHealth> Services)
{
    /// <summary>Longest <see cref="ServiceHealth.Detail"/> kept; the Core's codes are much shorter.</summary>
    public const int MaxDetailLength = 32;

    public static CoreHealth Unreachable { get; } = new(false, []);

    /// <summary>
    /// Parses the Core's /health body:
    /// <c>{"status":"ok","service":"core",...,"services":[{"name","enabled","status","detail"?}]}</c>
    /// (see docs/02-core-protocol.md). Anything else counts as unreachable.
    /// </summary>
    public static CoreHealth Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Unreachable;
            if (!root.TryGetProperty("status", out var st) || st.ValueKind != JsonValueKind.String || st.GetString() != "ok")
                return Unreachable;

            var list = new List<ServiceHealth>();
            if (root.TryGetProperty("services", out var services) && services.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in services.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object) continue;
                    if (!s.TryGetProperty("name", out var n) || n.ValueKind != JsonValueKind.String) continue;
                    var name = n.GetString()!;
                    var enabled = s.TryGetProperty("enabled", out var e) && e.ValueKind == JsonValueKind.True;
                    var status = s.TryGetProperty("status", out var ss) && ss.ValueKind == JsonValueKind.String
                        ? ss.GetString()!
                        : "unknown";
                    var detail = s.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String
                        ? CleanDetail(d.GetString())
                        : null;
                    list.Add(new ServiceHealth(name, enabled, status, detail));
                }
            }
            return new CoreHealth(true, list);
        }
        catch (JsonException)
        {
            return Unreachable;
        }
    }

    /// <summary>
    /// The detail goes into a menu line and the tooltip: no control characters,
    /// bounded length, empty means none.
    /// </summary>
    public static string? CleanDetail(string? detail)
    {
        if (detail is null) return null;
        var clean = new string(detail.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (clean.Length == 0) return null;
        return clean.Length <= MaxDetailLength ? clean : clean[..(MaxDetailLength - 1)] + "…";
    }
}

/// <summary>One request to the Core's <c>GET /health</c>.</summary>
public interface ICoreHealthProbe
{
    /// <summary>Never throws for network errors: an unreachable Core is <see cref="CoreHealth.Unreachable"/>.</summary>
    Task<CoreHealth> CheckAsync(CancellationToken cancellationToken);
}

/// <summary>
/// <c>GET &lt;core&gt;/health</c> over loopback HTTP (unauthenticated; names,
/// enabled flags, statuses and short detail codes only — see docs/02-core-protocol.md).
/// </summary>
public sealed class HttpCoreHealthProbe : ICoreHealthProbe, IDisposable
{
    private readonly HttpClient _http;
    private readonly Uri _healthUrl;

    public HttpCoreHealthProbe(Uri coreBaseUrl, TimeSpan? timeout = null)
    {
        _healthUrl = new Uri(coreBaseUrl, "/health");
        _http = new HttpClient(new SocketsHttpHandler { UseProxy = false }) { Timeout = timeout ?? TimeSpan.FromSeconds(2) };
    }

    public async Task<CoreHealth> CheckAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var res = await _http.GetAsync(_healthUrl, cancellationToken).ConfigureAwait(false);
            return res.IsSuccessStatusCode
                ? CoreHealth.Parse(await res.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false))
                : CoreHealth.Unreachable;
        }
        catch (Exception ex) when ((ex is HttpRequestException or TaskCanceledException) && !cancellationToken.IsCancellationRequested)
        {
            // Refused, reset, or the client timeout (a TaskCanceledException not
            // caused by the caller). A cancellation by the caller propagates.
            return CoreHealth.Unreachable;
        }
    }

    public void Dispose() => _http.Dispose();
}
