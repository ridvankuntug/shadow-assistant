using System.Globalization;

namespace ShadowTray;

public enum CoreRunState
{
    /// <summary>Not running: never started, stopped by the user or exited with code 0.</summary>
    Stopped,
    /// <summary>node is running.</summary>
    Running,
    /// <summary>Crashed; waiting for the backoff delay before the next start.</summary>
    WaitingRestart,
    /// <summary>Stop requested; waiting for the Core to shut down.</summary>
    Stopping,
    /// <summary>Too many short runs in a row; not restarting by itself.</summary>
    GaveUp,
    /// <summary>Cannot start (node or core\dist missing, bad arguments).</summary>
    Failed,
    /// <summary>
    /// A Core the tray did not start already answers /health; the tray starts
    /// none and watches it (<see cref="SupervisorSnapshot.RunningSince"/> = when it was seen).
    /// </summary>
    External,
}

/// <summary>Thread-safe copy of the supervisor's state.</summary>
public sealed record SupervisorSnapshot(
    CoreRunState State,
    DateTimeOffset? RunningSince = null,
    DateTimeOffset? NextRestartAt = null,
    int Failures = 0,
    int MaxFailures = 0,
    int? LastExitCode = null,
    string? Problem = null)
{
    public static SupervisorSnapshot Initial { get; } = new(CoreRunState.Stopped);
}

public enum TrayColour
{
    Green,
    Yellow,
    Red,
    /// <summary>A Core started outside the tray runs; the tray only watches it.</summary>
    Blue,
}

/// <summary>What the tray shows: icon colour, tooltip and the status lines of the menu.</summary>
public sealed record TrayStatus(TrayColour Colour, string Tooltip, IReadOnlyList<string> Lines);

/// <summary>
/// Maps supervisor state + Core health to what the tray shows. Pure: no
/// WinForms, no clock of its own.
///
/// Colour rules:
///   green  - Core running, its /health answers and every enabled service is ok;
///   yellow - Core running but /health not (yet) answering or an enabled
///            service is not ok (down / loading / unknown), or the Core is
///            waiting to be restarted / stopping;
///   red    - Core stopped, given up or cannot start;
///   blue   - a Core started outside the tray answers /health (the tray
///            watches it but cannot restart it); problems of its services are
///            in the tooltip and menu, not in the colour.
/// </summary>
public static class TrayStatusEvaluator
{
    /// <summary>NotifyIcon.Text limit.</summary>
    public const int MaxTooltipLength = 127;

    /// <summary>Lines shown while the Core cannot report service health.</summary>
    public static readonly IReadOnlyList<string> DefaultServices = ["home-assistant", "whisper-svc", "tts-svc"];

    private const string Prefix = "Shadow Assistant: ";

    public static TrayStatus Evaluate(SupervisorSnapshot s, CoreHealth? health, DateTimeOffset now)
    {
        var lines = new List<string> { "Core: " + CoreLine(s, health, now) };
        var reachable = s.State is CoreRunState.Running or CoreRunState.External && health is { Reachable: true };

        if (reachable && health!.Services.Count > 0)
        {
            foreach (var svc in health.Services) lines.Add($"{svc.Name}: {ServiceText(svc)}");
        }
        else
        {
            foreach (var name in DefaultServices) lines.Add($"{name}: bilinmiyor");
        }

        TrayColour colour;
        string summary;
        switch (s.State)
        {
            case CoreRunState.Running when !reachable:
                colour = TrayColour.Yellow;
                summary = "Core başlıyor / yanıt vermiyor";
                break;
            case CoreRunState.Running:
                colour = health!.Services.Any(IsProblem) ? TrayColour.Yellow : TrayColour.Green;
                summary = ProblemSummary(health) ?? "her şey çalışıyor";
                break;
            case CoreRunState.External:
                colour = TrayColour.Blue;
                summary = "Core dışarıda çalışıyor"
                          + (reachable && ProblemSummary(health!) is { } problems ? "; " + problems : "");
                break;
            case CoreRunState.WaitingRestart:
                colour = TrayColour.Yellow;
                summary = "Core " + CoreLine(s, health, now);
                break;
            case CoreRunState.Stopping:
                colour = TrayColour.Yellow;
                summary = "Core durduruluyor";
                break;
            case CoreRunState.GaveUp:
                colour = TrayColour.Red;
                summary = "Core art arda çöktü, vazgeçildi; logları kontrol edin";
                break;
            case CoreRunState.Failed:
                colour = TrayColour.Red;
                summary = "Core başlatılamıyor; menüye bakın";
                break;
            default:
                colour = TrayColour.Red;
                summary = "Core durduruldu";
                break;
        }

        return new TrayStatus(colour, Truncate(Prefix + summary, MaxTooltipLength), lines);
    }

    /// <summary>"sorun: whisper-svc kapalı (timeout), …" or null when no enabled service has a problem.</summary>
    private static string? ProblemSummary(CoreHealth health)
    {
        var bad = health.Services.Where(IsProblem).ToList();
        return bad.Count == 0 ? null : "sorun: " + string.Join(", ", bad.Select(b => $"{b.Name} {ServiceText(b)}"));
    }

    /// <summary>
    /// The health reading that belongs to the current run (own or external
    /// Core): a reading taken before the Core was (re)started or seen
    /// describes an earlier process and is ignored.
    /// </summary>
    public static CoreHealth? CurrentHealth(SupervisorSnapshot s, HealthReading? reading) =>
        reading is not null && s.State is CoreRunState.Running or CoreRunState.External
                            && s.RunningSince is { } since && reading.At >= since
            ? reading.Health
            : null;

    /// <summary>An enabled service that is not ok makes the icon yellow; disabled ones never do.</summary>
    public static bool IsProblem(ServiceHealth s) => s.Enabled && s.Status != "ok" && s.Status != "disabled";

    /// <summary>Turkish status, with the Core's detail code in brackets when it sent one: "kapalı (timeout)".</summary>
    public static string ServiceText(ServiceHealth s)
    {
        var text = s.Status switch
        {
            "ok" => "çalışıyor",
            "loading" => "yükleniyor",
            "down" => "kapalı",
            "disabled" => "devre dışı",
            _ => s.Enabled ? "bilinmiyor" : "devre dışı",
        };
        return string.IsNullOrEmpty(s.Detail) ? text : $"{text} ({s.Detail})";
    }

    public static string CoreLine(SupervisorSnapshot s, CoreHealth? health, DateTimeOffset now) => s.State switch
    {
        CoreRunState.Running when health is not { Reachable: true } => "başlıyor",
        CoreRunState.Running => "çalışıyor" + (s.RunningSince is { } since ? $" ({Duration(now - since)})" : ""),
        CoreRunState.WaitingRestart => "yeniden başlatılacak ("
                                       + (s.NextRestartAt is { } at ? $"{Duration(at - now)} sonra, " : "")
                                       + string.Create(CultureInfo.InvariantCulture, $"deneme {s.Failures}/{s.MaxFailures - 1})"),
        CoreRunState.Stopping => "durduruluyor",
        CoreRunState.GaveUp => string.Create(CultureInfo.InvariantCulture, $"vazgeçildi ({s.Failures} hata, son kod {s.LastExitCode})"),
        CoreRunState.Failed => "başlatılamıyor: " + (s.Problem ?? "bilinmeyen hata"),
        // No reading yet (null) right after it was seen: it did answer then.
        CoreRunState.External => health is { Reachable: false } ? "dışarıda çalışıyor (yanıt vermiyor)" : "dışarıda çalışıyor",
        _ => s.LastExitCode is { } code
            ? string.Create(CultureInfo.InvariantCulture, $"durduruldu (çıkış kodu {code})")
            : "durduruldu",
    };

    /// <summary>Short Turkish duration: "45 sn", "12 dk", "3 sa 5 dk".</summary>
    public static string Duration(TimeSpan d)
    {
        if (d < TimeSpan.Zero) d = TimeSpan.Zero;
        if (d.TotalSeconds < 60) return string.Create(CultureInfo.InvariantCulture, $"{(int)Math.Ceiling(d.TotalSeconds)} sn");
        if (d.TotalMinutes < 60) return string.Create(CultureInfo.InvariantCulture, $"{(int)d.TotalMinutes} dk");
        return string.Create(CultureInfo.InvariantCulture, $"{(int)d.TotalHours} sa {d.Minutes} dk");
    }

    /// <summary>Cuts to <paramref name="max"/> characters, ending with "…" when cut.</summary>
    public static string Truncate(string text, int max)
    {
        if (text.Length <= max) return text;
        return text[..(max - 1)] + "…";
    }
}
