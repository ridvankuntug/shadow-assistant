using System.Text;
using System.Text.Json;

namespace ShadowTray;

/// <summary>Runs one <c>docker compose ...</c> command in deploy\ (see <see cref="DockerCompose"/>).</summary>
public interface IComposeRunner
{
    /// <summary>docker.exe and deploy\docker-compose.yml were found.</summary>
    bool Available { get; }

    /// <param name="command">What follows <c>docker compose [--env-file ...]</c>, e.g. <c>["stop", "whisper-svc"]</c>.</param>
    /// <returns>docker's exit code (-1 when it could not be started).</returns>
    Task<int> RunAsync(IReadOnlyList<string> command);
}

/// <summary>What the tray remembers between runs.</summary>
public sealed record TrayState(bool GameMode)
{
    public static TrayState Default { get; } = new(false);
}

/// <summary>
/// <c>%LOCALAPPDATA%\ShadowAssistant\tray-state.json</c>: <c>{"gameMode":true}</c>.
/// A missing file is the default state; an unreadable or malformed one is
/// the default state plus a warning (never a crash: the tray must start).
/// </summary>
public sealed class TrayStateStore(string path)
{
    public string Path => path;

    public static string DefaultPath() => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ShadowAssistant", "tray-state.json");

    public TrayState Load(Action<string> log)
    {
        string json;
        try
        {
            if (!File.Exists(path)) return TrayState.Default;
            json = File.ReadAllText(path, Encoding.UTF8);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log($"warning: could not read {path}: {ex.Message}; game mode off");
            return TrayState.Default;
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("gameMode", out var g)
                && g.ValueKind is JsonValueKind.True or JsonValueKind.False)
                return new TrayState(g.GetBoolean());
            log($"warning: {path} has no gameMode true/false; game mode off");
        }
        catch (JsonException ex)
        {
            log($"warning: {path} is not valid JSON ({ex.Message}); game mode off");
        }
        return TrayState.Default;
    }

    /// <summary>Writes a temp file and moves it over the old one, so a crash never leaves half a file.</summary>
    /// <returns>false (and a logged warning) when it could not be written.</returns>
    public bool TrySave(TrayState state, Action<string> log)
    {
        var tmp = path + ".tmp";
        try
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            File.WriteAllText(tmp, $"{{\"gameMode\": {(state.GameMode ? "true" : "false")}}}\n", new UTF8Encoding(false));
            File.Move(tmp, path, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log($"warning: could not write {path}: {ex.Message}");
            try { File.Delete(tmp); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            return false;
        }
    }
}

/// <summary>Result of turning game mode on or off: <see cref="Ok"/> false = nothing changed.</summary>
public sealed record GameModeResult(bool Ok, string Message);

/// <summary>
/// "Oyun modu": frees the GPU for games by stopping the whisper-svc container,
/// and starts it again when turned off. No WinForms; the tray reads
/// <see cref="On"/> and shows the message of each change.
///
/// The flag only changes after docker succeeded, so a failed command leaves
/// the menu check where it was. It is saved in <see cref="TrayStateStore"/>
/// so that game mode survives a tray restart / sign-in, visibly.
///
/// Off runs <c>up -d whisper-svc</c>, not <c>start</c>: <c>start</c> fails when
/// the container no longer exists (e.g. "Konuşma servisleri → Durdur" ran
/// <c>compose down</c> meanwhile); <c>up -d</c> creates it if needed and is a
/// no-op for a running one.
/// </summary>
public sealed class GameModeController
{
    public const string Service = "whisper-svc";
    public static readonly IReadOnlyList<string> StopCommand = ["stop", Service];
    public static readonly IReadOnlyList<string> StartCommand = ["up", "-d", Service];

    private readonly IComposeRunner _runner;
    private readonly TrayStateStore _store;
    private readonly Action<string> _log;
    private volatile bool _on;

    public GameModeController(IComposeRunner runner, TrayStateStore store, Action<string> log)
    {
        _runner = runner;
        _store = store;
        _log = log;
        _on = store.Load(log).GameMode;
        if (_on) _log("game mode is on (saved in " + store.Path + ")");
    }

    public bool On => _on;

    /// <summary>
    /// Turns game mode on (stop whisper-svc) or off (start it). Callers
    /// serialise calls (the tray runs one docker command at a time).
    /// </summary>
    public async Task<GameModeResult> SetAsync(bool on)
    {
        if (on == _on) return new GameModeResult(true, on ? "Oyun modu zaten açık." : "Oyun modu zaten kapalı.");

        if (!_runner.Available)
        {
            if (on) return new GameModeResult(false, "Oyun modu açılamadı: docker bulunamadı.");
            // Nothing to start without docker; do not keep the user stuck in game mode.
            _log("game mode off; docker not found, whisper-svc not started");
            return Commit(false, "Oyun modu kapatıldı; docker bulunamadığı için whisper-svc başlatılmadı.");
        }

        var command = on ? StopCommand : StartCommand;
        int code;
        try
        {
            code = await _runner.RunAsync(command).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log($"error: docker compose {string.Join(' ', command)}: {ex.Message}");
            code = -1;
        }
        if (code != 0)
        {
            _log($"game mode {(on ? "on" : "off")} failed (docker exit code {code}); unchanged");
            return new GameModeResult(false, on
                ? $"Oyun modu açılamadı: whisper-svc durdurulamadı (kod {code}); core.log'a bakın."
                : $"Oyun modu kapatılamadı: whisper-svc başlatılamadı (kod {code}); core.log'a bakın.");
        }
        _log("game mode " + (on ? "on: whisper-svc stopped" : "off: whisper-svc started"));
        return Commit(on, on ? "Oyun modu açık: whisper-svc durduruldu, GPU boş." : "Oyun modu kapalı: whisper-svc başlatıldı.");
    }

    /// <summary>
    /// At tray start with game mode saved on: stop whisper-svc again, in case
    /// it was started meanwhile (by hand, or by Docker's restart policy). A
    /// stopped container makes this a no-op. A failure (typically Docker
    /// Desktop not running yet at sign-in) leaves game mode on and is only
    /// logged: whisper-svc cannot run without Docker either.
    /// </summary>
    /// <returns>true when nothing had to be done or the stop succeeded.</returns>
    public async Task<bool> ReapplyAsync()
    {
        if (!_on || !_runner.Available) return true;
        int code;
        try
        {
            code = await _runner.RunAsync(StopCommand).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log("error: docker compose stop " + Service + ": " + ex.Message);
            code = -1;
        }
        if (code != 0) _log($"warning: game mode is on but stopping {Service} at start failed (docker exit code {code})");
        return code == 0;
    }

    private GameModeResult Commit(bool on, string message)
    {
        _on = on;
        return _store.TrySave(new TrayState(on), _log)
            ? new GameModeResult(true, message)
            : new GameModeResult(true, message + " (Durum kaydedilemedi; core.log'a bakın.)");
    }
}
