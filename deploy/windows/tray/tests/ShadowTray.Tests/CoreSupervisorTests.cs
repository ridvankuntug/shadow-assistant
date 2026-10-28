using System.Collections.Concurrent;
using ShadowTray;

namespace ShadowTray.Tests;

public sealed class CoreSupervisorTests : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "shadowtray-sup-" + Guid.NewGuid().ToString("N"));
    private readonly RotatingLog _log;
    private readonly FakeLauncher _launcher = new();

    public CoreSupervisorTests() => _log = new RotatingLog(_dir);

    public void Dispose()
    {
        _log.Dispose();
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private static RestartPolicy Fast(int maxFailures = 20, double stableSeconds = 600) =>
        new(TimeSpan.FromMilliseconds(20), TimeSpan.FromMilliseconds(80), TimeSpan.FromSeconds(stableSeconds), maxFailures);

    private CoreSupervisor Create(RestartPolicy? policy = null, Func<IReadOnlyList<string>>? problems = null) =>
        new(_launcher, policy ?? Fast(), _log, problems ?? (() => []));

    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + Timeout;
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("condition not reached");
            await Task.Delay(10);
        }
    }

    private string LogText()
    {
        _log.Dispose();
        return File.ReadAllText(Path.Combine(_dir, "core.log"));
    }

    [Fact]
    public async Task Runs_the_core_and_logs_its_output()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        _launcher.Last.Output("hello from core");
        Assert.Equal(1, _launcher.Started);
        Assert.Contains("hello from core", LogText());
    }

    [Fact]
    public async Task Clean_exit_is_not_restarted()
    {
        var sup = Create();
        sup.Start();
        await Until(() => _launcher.Started == 1);
        _launcher.Last.Exit(0);
        await Until(() => sup.Snapshot.State == CoreRunState.Stopped);
        await Task.Delay(150);
        Assert.Equal(1, _launcher.Started);
        Assert.Equal(0, sup.Snapshot.LastExitCode);
        Assert.Contains("not restarting", LogText());
    }

    [Fact]
    public async Task Crash_is_restarted_after_the_backoff()
    {
        var sup = Create();
        sup.Start();
        await Until(() => _launcher.Started == 1);
        _launcher.Last.Exit(1);
        await Until(() => _launcher.Started == 2);
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        Assert.Equal(1, sup.Snapshot.LastExitCode);
        Assert.Contains("restart 1/19", LogText());
    }

    [Fact]
    public async Task Gives_up_after_max_failures()
    {
        var sup = Create(Fast(maxFailures: 3));
        sup.Start();
        for (var i = 1; i <= 3; i++)
        {
            await Until(() => _launcher.Started == i && sup.Snapshot.State == CoreRunState.Running);
            _launcher.Last.Exit(7);
        }
        await Until(() => sup.Snapshot.State == CoreRunState.GaveUp);
        Assert.Equal(3, sup.Snapshot.Failures);
        Assert.Equal(7, sup.Snapshot.LastExitCode);
        await Task.Delay(200);
        Assert.Equal(3, _launcher.Started);

        // Başlat after giving up starts over with fresh counters.
        sup.Start();
        await Until(() => _launcher.Started == 4 && sup.Snapshot.State == CoreRunState.Running);
        Assert.Equal(0, sup.Snapshot.Failures);
    }

    [Fact]
    public async Task Stop_sends_ctrl_c_and_does_not_restart()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        var proc = _launcher.Last;
        proc.ExitOnGracefulStop = 0;
        await sup.StopAsync(TimeSpan.FromSeconds(5)).WaitAsync(Timeout);
        Assert.Equal(1, proc.GracefulStops);
        Assert.False(proc.Killed);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
        await Task.Delay(150);
        Assert.Equal(1, _launcher.Started);
        Assert.Contains("stopped on request", LogText());
    }

    [Fact]
    public async Task Stop_kills_when_the_core_ignores_ctrl_c()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        var proc = _launcher.Last;
        await sup.StopAsync(TimeSpan.FromMilliseconds(100)).WaitAsync(Timeout);
        Assert.True(proc.Killed);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
        Assert.Contains("killing it", LogText());
    }

    [Fact]
    public async Task Stop_kills_when_ctrl_c_cannot_be_sent()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        var proc = _launcher.Last;
        proc.CanSendCtrlC = false;
        await sup.StopAsync(TimeSpan.FromSeconds(5)).WaitAsync(Timeout);
        Assert.True(proc.Killed);
    }

    [Fact]
    public async Task Stop_while_waiting_to_restart_cancels_the_restart()
    {
        var sup = Create(new RestartPolicy(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60), TimeSpan.FromMinutes(10), 20));
        sup.Start();
        await Until(() => _launcher.Started == 1);
        _launcher.Last.Exit(1);
        await Until(() => sup.Snapshot.State == CoreRunState.WaitingRestart);
        Assert.NotNull(sup.Snapshot.NextRestartAt);
        await sup.StopAsync(TimeSpan.FromSeconds(1)).WaitAsync(Timeout);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
        Assert.Equal(1, _launcher.Started);
    }

    [Fact]
    public async Task Start_while_waiting_restarts_immediately()
    {
        var sup = Create(new RestartPolicy(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60), TimeSpan.FromMinutes(10), 20));
        sup.Start();
        await Until(() => _launcher.Started == 1);
        _launcher.Last.Exit(1);
        await Until(() => sup.Snapshot.State == CoreRunState.WaitingRestart);
        sup.Start();
        await Until(() => _launcher.Started == 2 && sup.Snapshot.State == CoreRunState.Running);
        Assert.Equal(0, sup.Snapshot.Failures);
    }

    [Fact]
    public async Task Restart_stops_then_starts_with_fresh_counters()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        _launcher.Last.ExitOnGracefulStop = 0;
        await sup.RestartAsync(TimeSpan.FromSeconds(5)).WaitAsync(Timeout);
        await Until(() => _launcher.Started == 2 && sup.Snapshot.State == CoreRunState.Running);
    }

    [Fact]
    public async Task Start_while_running_does_nothing_and_concurrent_stops_send_one_ctrl_c()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        sup.Start();
        await Task.Delay(100);
        Assert.Equal(1, _launcher.Started);

        var proc = _launcher.Last;
        proc.ExitDelayAfterCtrlC = TimeSpan.FromMilliseconds(200);
        proc.ExitOnGracefulStop = 0;
        await Task.WhenAll(sup.StopAsync(TimeSpan.FromSeconds(5)), sup.StopAsync(TimeSpan.FromSeconds(5))).WaitAsync(Timeout);
        Assert.Equal(1, proc.GracefulStops);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
    }

    [Fact]
    public async Task Start_problems_fail_without_launching()
    {
        var problems = new List<string> { "node.exe bulunamadı" };
        var sup = Create(problems: () => problems);
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Failed);
        Assert.Equal("node.exe bulunamadı", sup.Snapshot.Problem);
        Assert.Equal(0, _launcher.Started);

        problems.Clear();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
    }

    [Fact]
    public async Task Launch_exception_fails()
    {
        _launcher.ThrowOnStart = new System.ComponentModel.Win32Exception("boom");
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Failed);
        Assert.Contains("boom", sup.Snapshot.Problem);
    }

    [Fact]
    public async Task Stop_when_not_running_returns_at_once()
    {
        var sup = Create();
        await sup.StopAsync(TimeSpan.FromSeconds(1)).WaitAsync(Timeout);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
    }

    [Fact]
    public async Task Exited_process_is_disposed()
    {
        var sup = Create();
        sup.Start();
        await Until(() => _launcher.Started == 1);
        var proc = _launcher.Last;
        proc.Exit(0);
        await Until(() => proc.Disposed);
    }

    [Fact]
    public async Task Stop_during_restart_cancels_the_restart()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        var proc = _launcher.Last;
        proc.ExitDelayAfterCtrlC = TimeSpan.FromMilliseconds(200);
        proc.ExitOnGracefulStop = 0;
        var restart = sup.RestartAsync(TimeSpan.FromSeconds(5));
        await Until(() => sup.Snapshot.State == CoreRunState.Stopping);
        // Durdur / Çıkış while the restart is still stopping the Core.
        await Task.WhenAll(restart, sup.StopAsync(TimeSpan.FromSeconds(5))).WaitAsync(Timeout);
        await Task.Delay(150);
        Assert.Equal(1, _launcher.Started);
        Assert.Equal(1, proc.GracefulStops);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
        Assert.Contains("restart cancelled", LogText());
    }

    [Fact]
    public async Task Dispose_during_restart_starts_nothing()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        var proc = _launcher.Last;
        proc.ExitDelayAfterCtrlC = TimeSpan.FromMilliseconds(200);
        proc.ExitOnGracefulStop = 0;
        var restart = sup.RestartAsync(TimeSpan.FromSeconds(5));
        await Until(() => sup.Snapshot.State == CoreRunState.Stopping);
        sup.Dispose();
        await restart.WaitAsync(Timeout);
        await Task.Delay(150);
        Assert.Equal(1, _launcher.Started);
    }

    [Fact]
    public async Task Nothing_starts_after_dispose()
    {
        var sup = Create();
        sup.Dispose();
        sup.Start();
        await sup.RestartAsync(TimeSpan.FromSeconds(1)).WaitAsync(Timeout);
        await Task.Delay(150);
        Assert.Equal(0, _launcher.Started);
        Assert.Equal(CoreRunState.Stopped, sup.Snapshot.State);
    }

    [Fact]
    public async Task Dispose_while_waiting_to_restart_ends_the_loop_without_a_start()
    {
        var sup = Create(new RestartPolicy(TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60), TimeSpan.FromMinutes(10), 20));
        sup.Start();
        await Until(() => _launcher.Started == 1);
        _launcher.Last.Exit(1);
        await Until(() => sup.Snapshot.State == CoreRunState.WaitingRestart);
        sup.Dispose();
        await Until(() => sup.Snapshot.State == CoreRunState.Stopped);
        sup.Start();
        await Task.Delay(150);
        Assert.Equal(1, _launcher.Started);
    }

    [Fact]
    public async Task Restart_after_a_completed_stop_starts_again()
    {
        var sup = Create();
        sup.Start();
        await Until(() => sup.Snapshot.State == CoreRunState.Running);
        _launcher.Last.ExitOnGracefulStop = 0;
        await sup.StopAsync(TimeSpan.FromSeconds(5)).WaitAsync(Timeout);
        // A stop that finished before the restart began does not cancel it.
        await sup.RestartAsync(TimeSpan.FromSeconds(5)).WaitAsync(Timeout);
        await Until(() => _launcher.Started == 2 && sup.Snapshot.State == CoreRunState.Running);
    }

    private sealed class FakeLauncher : ICoreLauncher
    {
        private readonly ConcurrentQueue<FakeProcess> _all = new();
        private volatile FakeProcess? _last;
        public Exception? ThrowOnStart { get; set; }
        public int Started => _all.Count;
        public FakeProcess Last => _last ?? throw new InvalidOperationException("nothing started");
        public string Describe() => "fake";

        public ICoreProcess Start(Action<string> output)
        {
            if (ThrowOnStart is not null) throw ThrowOnStart;
            var p = new FakeProcess(output, _all.Count + 1);
            _all.Enqueue(p);
            _last = p;
            return p;
        }
    }

    private sealed class FakeProcess(Action<string> output, int id) : ICoreProcess
    {
        private readonly TaskCompletionSource<int> _exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _gracefulStops;
        public int Id => id;
        public Task<int> Exited => _exit.Task;
        public bool CanSendCtrlC { get; set; } = true;
        public int? ExitOnGracefulStop { get; set; }
        public TimeSpan ExitDelayAfterCtrlC { get; set; }
        public int GracefulStops => _gracefulStops;
        public bool Killed { get; private set; }
        public bool Disposed { get; private set; }

        public void Output(string line) => output(line);
        public void Exit(int code) => _exit.TrySetResult(code);

        public bool RequestGracefulStop()
        {
            if (!CanSendCtrlC) return false;
            Interlocked.Increment(ref _gracefulStops);
            if (ExitOnGracefulStop is { } code)
            {
                if (ExitDelayAfterCtrlC > TimeSpan.Zero) _ = Task.Delay(ExitDelayAfterCtrlC).ContinueWith(_ => Exit(code));
                else Exit(code);
            }
            return true;
        }

        public void Kill()
        {
            Killed = true;
            Exit(1);
        }

        public void Dispose() => Disposed = true;
    }
}
