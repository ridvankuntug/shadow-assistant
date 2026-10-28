using System.Text.Json;

namespace ShadowTray;

/// <summary>One entry of the Core's <c>GET /health</c> <c>services</c> list.</summary>
/// <param name="Status">ok | loading | down | disabled | unknown (unknown = before the Core's first check round).</param>
public sealed record ServiceHealth(string Name, bool Enabled, string Status);

/// <summary>Result of one poll of the Core's <c>GET /health</c>.</summary>
public sealed record CoreHealth(bool Reachable, IReadOnlyList<ServiceHealth> Services)
{
    public static CoreHealth Unreachable { get; } = new(false, []);

    /// <summary>
    /// Parses the Core's /health body:
    /// <c>{"status":"ok","service":"core",...,"services":[{"name","enabled","status"}]}</c>
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
                    list.Add(new ServiceHealth(name, enabled, status));
                }
            }
            return new CoreHealth(true, list);
        }
        catch (JsonException)
        {
            return Unreachable;
        }
    }
}
