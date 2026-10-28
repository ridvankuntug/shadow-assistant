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
/// <param name="GameMode">Game mode is on: the icon gets a pause mark (<see cref="TrayIcons"/>).</param>
public sealed record TrayStatus(TrayColour Colour, string Tooltip, IReadOnlyList<string> Lines, bool GameMode = false);

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
///
/// Game mode (<see cref="GameModeController"/>): whisper-svc is stopped on
/// purpose, so it is never a problem (no yellow); its line reads "oyun modu",
/// the tooltip starts with "Shadow Assistant (oyun modu): " and the icon has
/// a pause mark. The colour is decided by everything else as usual.
/// </summary>
public static class TrayStatusEvaluator
{
    /// <summary>NotifyIcon.Text limit.</summary>
    public const int MaxTooltipLength = 127;

    /// <summary>Lines shown while the Core cannot report service health.</summary>
    public static readonly IReadOnlyList<string> DefaultServices = ["home-assistant", "whisper-svc", "tts-svc"];

    private const string Prefix = "Shadow Assistant: ";
    private const string GameModePrefix = "Shadow Assistant (oyun modu): ";

    /// <summary>Menu line of the game-mode service while it is (meant to be) stopped.</summary>
    public const string GameModeText = "oyun modu";

    public static TrayStatus Evaluate(SupervisorSnapshot s, CoreHealth? health, DateTimeOffset now, bool gameMode = false)
    {
        var lines = new List<string> { "Core: " + CoreLine(s, health, now) };
        var reachable = s.State is CoreRunState.Running or CoreRunState.External && health is { Reachable: true };

        if (reachable && health!.Services.Count > 0)
        {
            foreach (var svc in health.Services) lines.Add($"{svc.Name}: {ServiceText(svc, gameMode)}");
        }
        else
        {
            foreach (var name in DefaultServices)
                lines.Add($"{name}: {(gameMode && name == GameModeController.Service ? GameModeText : "bilinmiyor")}");
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
                colour = health!.Services.Any(x => IsProblem(x, gameMode)) ? TrayColour.Yellow : TrayColour.Green;
                summary = ProblemSummary(health, gameMode)
                          ?? (gameMode && health.Services.Any(IsHeldByGameMode) ? GameModeController.Service + " kapalı, gerisi çalışıyor" : "her şey çalışıyor");
                break;
            case CoreRunState.External:
                colour = TrayColour.Blue;
                summary = "Core dışarıda çalışıyor"
                          + (reachable && ProblemSummary(health!, gameMode) is { } problems ? "; " + problems : "");
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

        return new TrayStatus(colour, Truncate((gameMode ? GameModePrefix : Prefix) + summary, MaxTooltipLength), lines, gameMode);
    }

    /// <summary>"sorun: whisper-svc kapalı (timeout), …" or null when no enabled service has a problem.</summary>
    private static string? ProblemSummary(CoreHealth health, bool gameMode)
    {
        var bad = health.Services.Where(x => IsProblem(x, gameMode)).ToList();
        return bad.Count == 0 ? null : "sorun: " + string.Join(", ", bad.Select(b => $"{b.Name} {ServiceText(b, gameMode)}"));
    }

    /// <summary>The game-mode service, enabled and not ok: stopped by game mode, not broken.</summary>
    private static bool IsHeldByGameMode(ServiceHealth s) =>
        s.Name == GameModeController.Service && s.Enabled && s.Status != "ok" && s.Status != "disabled";

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

    /// <summary>
    /// An enabled service that is not ok makes the icon yellow; disabled ones
    /// never do, and neither does whisper-svc stopped by game mode.
    /// </summary>
    public static bool IsProblem(ServiceHealth s, bool gameMode = false) =>
        s.Enabled && s.Status != "ok" && s.Status != "disabled" && !(gameMode && IsHeldByGameMode(s));

    /// <summary>
    /// Turkish status, with the Core's detail code in brackets when it sent one: "kapalı (timeout)".
    /// Known codes get a Turkish label: ok + idle (whisper-svc unloaded its
    /// model from the GPU and loads it again on the next request) is
    /// "hazır (boşta, model kaldırıldı)". In game mode whisper-svc reads
    /// "oyun modu" when not ok, and "…; oyun modu açık" if it runs anyway.
    /// </summary>
    public static string ServiceText(ServiceHealth s, bool gameMode = false)
    {
        if (gameMode && IsHeldByGameMode(s)) return GameModeText;
        var text = BaseServiceText(s);
        return gameMode && s.Name == GameModeController.Service && s.Enabled && s.Status == "ok" ? text + "; oyun modu açık" : text;
    }

    private static string BaseServiceText(ServiceHealth s)
    {
        if (s.Status == "ok" && s.Detail == "idle") return "hazır (boşta, model kaldırıldı)";
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
