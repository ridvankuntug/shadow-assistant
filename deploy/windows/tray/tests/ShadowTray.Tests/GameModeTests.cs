using ShadowTray;

namespace ShadowTray.Tests;

public sealed class GameModeTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tray-state-" + Guid.NewGuid().ToString("N"));
    private readonly List<string> _log = [];

    private string StatePath => Path.Combine(_dir, "ShadowAssistant", "tray-state.json");
    private TrayStateStore Store() => new(StatePath);

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private sealed class FakeRunner(params int[] codes) : IComposeRunner
    {
        private readonly Queue<int> _codes = new(codes);
        public bool Available { get; init; } = true;
        public Exception? Throw { get; init; }
        public List<string> Commands { get; } = [];

        public Task<int> RunAsync(IReadOnlyList<string> command)
        {
            Commands.Add(string.Join(' ', command));
            if (Throw is not null) throw Throw;
            return Task.FromResult(_codes.Count > 0 ? _codes.Dequeue() : 0);
        }
    }

    // --- store ---

    [Fact]
    public void Missing_state_file_means_game_mode_off_without_warning()
    {
        Assert.False(Store().Load(_log.Add).GameMode);
        Assert.Empty(_log);
    }

    [Fact]
    public void Save_then_load_round_trips_and_creates_the_folder()
    {
        Assert.True(Store().TrySave(new TrayState(true), _log.Add));
        Assert.True(Store().Load(_log.Add).GameMode);
        Assert.Equal("{\"gameMode\": true}\n", File.ReadAllText(StatePath));
        Assert.False(File.Exists(StatePath + ".tmp"));

        Assert.True(Store().TrySave(new TrayState(false), _log.Add));
        Assert.False(Store().Load(_log.Add).GameMode);
        Assert.Empty(_log);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"gameMode\": \"yes\"}")]
    [InlineData("")]
    public void Malformed_state_file_means_off_with_a_warning(string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        File.WriteAllText(StatePath, content);
        Assert.False(Store().Load(_log.Add).GameMode);
        Assert.Single(_log);
        Assert.StartsWith("warning:", _log[0]);
    }

    [Fact]
    public void Save_failure_is_reported_not_thrown()
    {
        // The state path is an existing directory: the move over it fails.
        Directory.CreateDirectory(StatePath);
        Assert.False(Store().TrySave(new TrayState(true), _log.Add));
        Assert.Contains(_log, l => l.StartsWith("warning: could not write"));
    }

    // --- controller ---

    [Fact]
    public async Task Turning_on_stops_whisper_and_saves()
    {
        var runner = new FakeRunner(0);
        var gm = new GameModeController(runner, Store(), _log.Add);
        Assert.False(gm.On);

        var r = await gm.SetAsync(true);

        Assert.True(r.Ok);
        Assert.True(gm.On);
        Assert.Equal(["stop whisper-svc"], runner.Commands);
        Assert.True(Store().Load(_log.Add).GameMode);
    }

    [Fact]
    public async Task Turning_off_uses_up_d_so_a_removed_container_is_recreated()
    {
        Store().TrySave(new TrayState(true), _log.Add);
        var runner = new FakeRunner(0);
        var gm = new GameModeController(runner, Store(), _log.Add);
        Assert.True(gm.On);

        var r = await gm.SetAsync(false);

        Assert.True(r.Ok);
        Assert.False(gm.On);
        Assert.Equal(["up -d whisper-svc"], runner.Commands);
        Assert.False(Store().Load(_log.Add).GameMode);
    }

    [Theory]
    [InlineData(true, 1)]
    [InlineData(true, -1)]
    [InlineData(false, 1)]
    public async Task Docker_failure_leaves_game_mode_and_the_saved_state_unchanged(bool turnOn, int code)
    {
        Store().TrySave(new TrayState(!turnOn), _log.Add);
        var gm = new GameModeController(new FakeRunner(code), Store(), _log.Add);

        var r = await gm.SetAsync(turnOn);

        Assert.False(r.Ok);
        Assert.Contains($"kod {code}", r.Message);
        Assert.Equal(!turnOn, gm.On);
        Assert.Equal(!turnOn, Store().Load(_log.Add).GameMode);
    }

    [Fact]
    public async Task Docker_exception_counts_as_failure()
    {
        var gm = new GameModeController(new FakeRunner { Throw = new InvalidOperationException("boom") }, Store(), _log.Add);
        var r = await gm.SetAsync(true);
        Assert.False(r.Ok);
        Assert.False(gm.On);
        Assert.Contains(_log, l => l.Contains("boom"));
    }

    [Fact]
    public async Task Same_state_runs_nothing()
    {
        var runner = new FakeRunner();
        var gm = new GameModeController(runner, Store(), _log.Add);
        Assert.True((await gm.SetAsync(false)).Ok);
        Assert.Empty(runner.Commands);
    }

    [Fact]
    public async Task Without_docker_on_fails_but_off_still_clears_the_flag()
    {
        var runner = new FakeRunner { Available = false };
        var gm = new GameModeController(runner, Store(), _log.Add);
        Assert.False((await gm.SetAsync(true)).Ok);
        Assert.False(gm.On);

        Store().TrySave(new TrayState(true), _log.Add);
        gm = new GameModeController(runner, Store(), _log.Add);
        var off = await gm.SetAsync(false);
        Assert.True(off.Ok);
        Assert.False(gm.On);
        Assert.False(Store().Load(_log.Add).GameMode);
        Assert.Empty(runner.Commands);
    }

    [Fact]
    public async Task Save_failure_still_changes_the_mode_and_says_so()
    {
        Directory.CreateDirectory(StatePath);
        var gm = new GameModeController(new FakeRunner(0), Store(), _log.Add);
        var r = await gm.SetAsync(true);
        Assert.True(r.Ok);
        Assert.True(gm.On);
        Assert.Contains("kaydedilemedi", r.Message);
    }

    [Fact]
    public async Task Reapply_at_start_stops_whisper_only_when_game_mode_is_saved_on()
    {
        var off = new FakeRunner();
        Assert.True(await new GameModeController(off, Store(), _log.Add).ReapplyAsync());
        Assert.Empty(off.Commands);

        Store().TrySave(new TrayState(true), _log.Add);
        var on = new FakeRunner(0);
        Assert.True(await new GameModeController(on, Store(), _log.Add).ReapplyAsync());
        Assert.Equal(["stop whisper-svc"], on.Commands);
    }

    [Fact]
    public async Task Reapply_failure_keeps_game_mode_on()
    {
        Store().TrySave(new TrayState(true), _log.Add);
        var gm = new GameModeController(new FakeRunner(1), Store(), _log.Add);
        Assert.False(await gm.ReapplyAsync());
        Assert.True(gm.On);
        Assert.True(Store().Load(_log.Add).GameMode);
        Assert.Contains(_log, l => l.StartsWith("warning: game mode is on"));
    }
}
