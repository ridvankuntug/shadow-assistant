using System.Diagnostics;
using Microsoft.Win32;

namespace ShadowTray;

/// <summary>
/// The notification-area icon and its menu. All state lives in
/// <see cref="CoreSupervisor"/> and <see cref="HealthPoller"/>; a one-second
/// UI timer reads them and redraws, so no background thread touches WinForms.
/// </summary>
public sealed class TrayApp : ApplicationContext
{
    /// <summary>How long the Core gets to shut down after Ctrl+C before it is killed.</summary>
    private static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(10);
    /// <summary>Shorter grace at sign-out / shutdown, where Windows itself is waiting.</summary>
    private static readonly TimeSpan SessionEndGrace = TimeSpan.FromSeconds(5);
    /// <summary>
    /// Whole stop at sign-out / shutdown (wait for /health, Ctrl+C helper,
    /// <see cref="SessionEndGrace"/>, kill): the supervisor kills the Core by then.
    /// </summary>
    private static readonly TimeSpan SessionEndBudget = TimeSpan.FromSeconds(6);
    /// <summary>How long the UI thread blocks for that stop: the budget plus slack for thread scheduling.</summary>
    private static readonly TimeSpan SessionEndWait = SessionEndBudget + TimeSpan.FromSeconds(1);

    private readonly TraySettings _settings;
    private readonly RotatingLog _log;
    private readonly NodeLauncher? _launcher;
    private readonly CoreSupervisor _supervisor;
    private readonly HttpCoreHealthProbe _probe;
    private readonly HealthPoller _poller;
    private readonly DockerCompose _docker;
    private readonly TrayIcons _icons;
    private readonly NotifyIcon _notify;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _startItem, _stopItem, _restartItem, _dockerUpItem, _dockerDownItem, _uiItem;
    private readonly ToolStripSeparator _statusEnd;
    private readonly System.Windows.Forms.Timer _timer;
    private UiServer? _uiServer;
    private string? _uiError;
    private TrayStatus? _shown;
    private CoreRunState _lastState = CoreRunState.Stopped;
    private bool _dockerBusy;
    private bool _exiting;

    public TrayApp(TraySettings settings)
    {
        _settings = settings;
        _log = new RotatingLog(settings.LogDir);
        _log.Info("tray started");
        foreach (var w in settings.Warnings) _log.Info("warning: " + w);
        foreach (var p in settings.Problems) _log.Info("error: " + p);

        if (settings.NodePath is not null && settings.CoreEntry is not null && settings.RepoRoot is not null)
            _launcher = new NodeLauncher(settings.NodePath, settings.CoreEntry, settings.RepoRoot, _log.Info);
        _probe = new HttpCoreHealthProbe(settings.CoreBaseUrl);
        _supervisor = new CoreSupervisor(_launcher ?? (ICoreLauncher)new MissingLauncher(), RestartPolicy.Default, _log,
            settings.StartProblems, _probe);
        _poller = new HealthPoller(_probe, () => _supervisor.Snapshot.State is CoreRunState.Running or CoreRunState.External);
        _docker = new DockerCompose(DockerCompose.Find(Environment.GetEnvironmentVariable), settings.DeployDir, settings.EnvFile, _log);
        _icons = new TrayIcons(SystemInformation.SmallIconSize.Width);

        _menu = new ContextMenuStrip { ShowImageMargin = false };
        _statusEnd = new ToolStripSeparator();
        _uiItem = new ToolStripMenuItem("Arayüzü aç", null, (_, _) => OpenUi()) { Font = new Font(_menu.Font, FontStyle.Bold) };
        _restartItem = new ToolStripMenuItem("Yeniden başlat", null, async (_, _) => await RunGuarded(() => _supervisor.RestartAsync(StopGrace)));
        _stopItem = new ToolStripMenuItem("Durdur", null, async (_, _) => await RunGuarded(() => _supervisor.StopAsync(StopGrace)));
        _startItem = new ToolStripMenuItem("Başlat", null, (_, _) => _supervisor.Start());
        _dockerUpItem = new ToolStripMenuItem("Başlat (docker compose up -d)", null, async (_, _) => await RunDocker("up"));
        _dockerDownItem = new ToolStripMenuItem("Durdur (docker compose down)", null, async (_, _) => await RunDocker("down"));
        var docker = new ToolStripMenuItem("Konuşma servisleri (Docker)");
        docker.DropDownItems.AddRange([_dockerUpItem, _dockerDownItem]);
        if (!_docker.Available) docker.Enabled = false;
        _menu.Items.AddRange([
            _statusEnd,
            _uiItem,
            new ToolStripSeparator(),
            _restartItem,
            _stopItem,
            _startItem,
            docker,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Logları aç", null, (_, _) => OpenLogs()),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Çıkış", null, async (_, _) => await ExitAsync()),
        ]);
        _menu.Opening += (_, _) => Refresh(force: true);

        _notify = new NotifyIcon
        {
            Icon = _icons[TrayColour.Red],
            Text = "Shadow Assistant",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _notify.DoubleClick += (_, _) => OpenUi();

        _uiError = "başlatılıyor";
        _ = StartUiServerAsync();
        _poller.Start();
        _supervisor.Start();

        _timer = new System.Windows.Forms.Timer { Interval = 1000 };
        _timer.Tick += (_, _) => Refresh(force: false);
        _timer.Start();
        Refresh(force: true);

        SystemEvents.SessionEnded += OnSessionEnded;
    }

    private void Refresh(bool force)
    {
        var snap = _supervisor.Snapshot;
        var health = TrayStatusEvaluator.CurrentHealth(snap, _poller.Latest);
        var status = TrayStatusEvaluator.Evaluate(snap, health, DateTimeOffset.UtcNow);

        if (snap.State != _lastState)
        {
            if (snap.State == CoreRunState.GaveUp)
                _notify.ShowBalloonTip(10000, "Shadow Assistant", "Core art arda çöktü; yeniden denemiyor. Logları kontrol edin.", ToolTipIcon.Error);
            else if (snap.State == CoreRunState.Failed)
                _notify.ShowBalloonTip(10000, "Shadow Assistant", "Core başlatılamıyor: " + snap.Problem, ToolTipIcon.Error);
            _lastState = snap.State;
        }

        var busy = snap.State == CoreRunState.Stopping || _exiting;
        // An external Core is not the tray's to start, stop or restart; the
        // supervisor starts its own once that one stops answering.
        var external = snap.State == CoreRunState.External;
        _startItem.Enabled = !busy && !external && snap.State is not CoreRunState.Running;
        _stopItem.Enabled = !busy && snap.State is CoreRunState.Running or CoreRunState.WaitingRestart;
        _restartItem.Enabled = !busy && !external;
        _dockerUpItem.Enabled = _dockerDownItem.Enabled = !_dockerBusy && !_exiting;

        if (!force && !_menu.Visible && _shown is not null && _shown.Colour == status.Colour && _shown.Tooltip == status.Tooltip)
            return;

        if (_shown is null || _shown.Colour != status.Colour) _notify.Icon = _icons[status.Colour];
        if (_shown is null || _shown.Tooltip != status.Tooltip) _notify.Text = status.Tooltip;
        if (_shown is null || force || _menu.Visible) RebuildStatusLines(status.Lines);
        _shown = status;
    }

    private void RebuildStatusLines(IReadOnlyList<string> lines)
    {
        var end = _menu.Items.IndexOf(_statusEnd);
        var extra = _uiError is null ? lines : [.. lines, "Arayüz: " + _uiError];
        // Update in place when the count matches (no flicker while the menu is open).
        if (end == extra.Count)
        {
            for (var i = 0; i < end; i++) _menu.Items[i].Text = extra[i];
            return;
        }
        for (var i = end - 1; i >= 0; i--)
        {
            var old = _menu.Items[i];
            _menu.Items.RemoveAt(i);
            old.Dispose();
        }
        for (var i = 0; i < extra.Count; i++)
            _menu.Items.Insert(i, new ToolStripMenuItem(extra[i]) { Enabled = false });
    }

    private async Task StartUiServerAsync()
    {
        if (_settings.UiDist is null || !File.Exists(Path.Combine(_settings.UiDist, "index.html")))
        {
            _uiError = "ui/dist yok (ui içinde npm run build)";
            _log.Info("warning: ui/dist/index.html not found; the UI cannot be opened until it is built and the tray restarted");
            return;
        }
        var server = new UiServer(_settings.UiDist, _settings.UiPort);
        try
        {
            await server.StartAsync();
            _uiServer = server;
            _uiError = null;
            _log.Info($"serving ui/dist at {server.Url}");
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException)
        {
            await server.DisposeAsync();
            _uiError = $"port {_settings.UiPort} kullanılamıyor";
            _log.Info($"warning: could not serve the UI on port {_settings.UiPort}: {ex.Message} (set SHADOW_UI_PORT)");
        }
        Refresh(force: true);
    }

    private void OpenUi()
    {
        if (_uiServer is null)
        {
            _notify.ShowBalloonTip(5000, "Shadow Assistant", "Arayüz açılamıyor: " + (_uiError ?? "bilinmeyen hata"), ToolTipIcon.Warning);
            return;
        }
        var url = _uiServer.Url.ToString();
        try
        {
            // Through explorer.exe, so the browser is not in the tray's (Task
            // Scheduler) job and survives the task ending (see ShellLauncher).
            ShellLauncher.Open(url);
        }
        catch (Exception ex)
        {
            _log.Info("warning: could not open the UI through the shell (" + ex.Message + "); starting the browser from the tray instead");
            Launch(new ProcessStartInfo(url) { UseShellExecute = true });
        }
    }

    private void OpenLogs()
    {
        Directory.CreateDirectory(_settings.LogDir);
        var psi = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
        psi.ArgumentList.Add(_settings.LogDir);
        Launch(psi);
    }

    private void Launch(ProcessStartInfo psi)
    {
        try
        {
            Process.Start(psi)?.Dispose();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            _log.Info("warning: could not open " + psi.FileName + ": " + ex.Message);
            _notify.ShowBalloonTip(5000, "Shadow Assistant", "Açılamadı: " + ex.Message, ToolTipIcon.Warning);
        }
    }

    private async Task RunDocker(string verb)
    {
        if (_dockerBusy) return;
        _dockerBusy = true;
        Refresh(force: false);
        try
        {
            var code = await Task.Run(() => _docker.RunAsync(verb));
            var what = verb == "up" ? "başlatma" : "durdurma";
            _notify.ShowBalloonTip(5000, "Shadow Assistant",
                code == 0 ? $"Konuşma servisleri: {what} tamam." : $"Konuşma servisleri: {what} başarısız (kod {code}); core.log'a bakın.",
                code == 0 ? ToolTipIcon.Info : ToolTipIcon.Warning);
        }
        finally
        {
            _dockerBusy = false;
            Refresh(force: false);
        }
    }

    private async Task RunGuarded(Func<Task> action)
    {
        Refresh(force: false);
        try
        {
            await Task.Run(action);
        }
        catch (Exception ex)
        {
            _log.Info("error: " + ex.Message);
        }
        Refresh(force: true);
    }

    private async Task ExitAsync()
    {
        if (_exiting) return;
        _exiting = true;
        Refresh(force: true);
        _log.Info("exit requested from the tray menu");
        await Task.Run(() => _supervisor.StopAsync(StopGrace));
        ExitThread();
    }

    /// <summary>
    /// SessionEnded, not SessionEnding: SessionEnding is only the query, and a
    /// sign-out cancelled after it (by the user or another app) must leave the
    /// Core running and the menu usable. SessionEnded is raised only when the
    /// session really ends (WM_ENDSESSION with TRUE); Windows waits for it.
    /// </summary>
    private void OnSessionEnded(object? sender, SessionEndedEventArgs e)
    {
        // Best effort: let the Core flush its logs before Windows ends the session.
        _log.Info("session ending; stopping Core");
        _exiting = true;
        try
        {
            _supervisor.StopAsync(SessionEndGrace, SessionEndBudget).Wait(SessionEndWait);
        }
        catch (AggregateException) { }
    }

    protected override void ExitThreadCore()
    {
        if (!_exiting)
        {
            _exiting = true;
            try { _supervisor.StopAsync(SessionEndGrace, SessionEndBudget).Wait(SessionEndWait); }
            catch (AggregateException) { }
        }
        _log.Info("tray exiting");
        base.ExitThreadCore();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.SessionEnded -= OnSessionEnded;
            _timer.Dispose();
            _notify.Visible = false;
            _notify.Dispose();
            _menu.Dispose();
            _icons.Dispose();
            _poller.Dispose();
            if (_uiServer is not null) Task.Run(() => _uiServer.DisposeAsync().AsTask()).Wait(TimeSpan.FromSeconds(3));
            // No start after this (e.g. from a restart still in progress); then
            // closing the job kills a Core that is somehow still running.
            _supervisor.Dispose();
            _launcher?.Dispose();
            _probe.Dispose();
            _log.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>Used when settings are incomplete: StartProblems already reports why.</summary>
    private sealed class MissingLauncher : ICoreLauncher
    {
        public ICoreProcess Start(Action<string> output) => throw new InvalidOperationException("Core yapılandırması eksik");
        public string Describe() => "(not configured)";
    }
}
