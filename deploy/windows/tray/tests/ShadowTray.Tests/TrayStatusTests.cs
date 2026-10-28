using ShadowTray;

namespace ShadowTray.Tests;

public class TrayStatusTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 28, 12, 0, 0, TimeSpan.Zero);

    private static SupervisorSnapshot Running(TimeSpan? since = null) =>
        new(CoreRunState.Running, RunningSince: Now - (since ?? TimeSpan.FromMinutes(12)), MaxFailures: 20);

    private static CoreHealth Health(params (string Name, bool Enabled, string Status)[] s) =>
        new(true, s.Select(x => new ServiceHealth(x.Name, x.Enabled, x.Status)).ToList());

    private static readonly CoreHealth AllOk = Health(
        ("home-assistant", true, "ok"), ("shadow-vault", false, "disabled"), ("whisper-svc", true, "ok"), ("tts-svc", true, "ok"));

    [Fact]
    public void Green_when_core_runs_and_every_enabled_service_is_ok()
    {
        var s = TrayStatusEvaluator.Evaluate(Running(), AllOk, Now);
        Assert.Equal(TrayColour.Green, s.Colour);
        Assert.Equal("Shadow Assistant: her şey çalışıyor", s.Tooltip);
        Assert.Equal(
            ["Core: çalışıyor (12 dk)", "home-assistant: çalışıyor", "shadow-vault: devre dışı", "whisper-svc: çalışıyor", "tts-svc: çalışıyor"],
            s.Lines);
    }

    [Theory]
    [InlineData("down", "kapalı")]
    [InlineData("loading", "yükleniyor")]
    [InlineData("unknown", "bilinmiyor")]
    public void Yellow_when_an_enabled_service_is_not_ok(string status, string text)
    {
        var h = Health(("home-assistant", true, "ok"), ("whisper-svc", true, status), ("tts-svc", true, "ok"));
        var s = TrayStatusEvaluator.Evaluate(Running(), h, Now);
        Assert.Equal(TrayColour.Yellow, s.Colour);
        Assert.Equal($"Shadow Assistant: sorun: whisper-svc {text}", s.Tooltip);
        Assert.Contains($"whisper-svc: {text}", s.Lines);
    }

    [Fact]
    public void Disabled_services_never_make_it_yellow()
    {
        var h = Health(("home-assistant", false, "disabled"), ("whisper-svc", true, "ok"), ("tts-svc", false, "unknown"));
        Assert.Equal(TrayColour.Green, TrayStatusEvaluator.Evaluate(Running(), h, Now).Colour);
    }

    [Fact]
    public void Yellow_while_core_runs_but_health_does_not_answer_yet()
    {
        foreach (var h in new CoreHealth?[] { null, CoreHealth.Unreachable })
        {
            var s = TrayStatusEvaluator.Evaluate(Running(), h, Now);
            Assert.Equal(TrayColour.Yellow, s.Colour);
            Assert.Equal("Core: başlıyor", s.Lines[0]);
            Assert.Equal(["home-assistant: bilinmiyor", "whisper-svc: bilinmiyor", "tts-svc: bilinmiyor"], s.Lines.Skip(1));
        }
    }

    [Fact]
    public void Yellow_while_waiting_to_restart_with_countdown()
    {
        var snap = new SupervisorSnapshot(CoreRunState.WaitingRestart, NextRestartAt: Now.AddSeconds(40), Failures: 3, MaxFailures: 20, LastExitCode: 1);
        var s = TrayStatusEvaluator.Evaluate(snap, AllOk, Now);
        Assert.Equal(TrayColour.Yellow, s.Colour);
        Assert.Equal("Core: yeniden başlatılacak (40 sn sonra, deneme 3/19)", s.Lines[0]);
        // Health of the crashed run is not shown as current.
        Assert.Equal("home-assistant: bilinmiyor", s.Lines[1]);
    }

    [Fact]
    public void Yellow_while_stopping()
    {
        Assert.Equal(TrayColour.Yellow, TrayStatusEvaluator.Evaluate(new SupervisorSnapshot(CoreRunState.Stopping), null, Now).Colour);
    }

    [Theory]
    [InlineData(CoreRunState.Stopped)]
    [InlineData(CoreRunState.GaveUp)]
    [InlineData(CoreRunState.Failed)]
    public void Red_when_core_is_not_running(CoreRunState state)
    {
        var s = TrayStatusEvaluator.Evaluate(new SupervisorSnapshot(state, Failures: 20, MaxFailures: 20, LastExitCode: 1, Problem: "node.exe bulunamadı"), AllOk, Now);
        Assert.Equal(TrayColour.Red, s.Colour);
    }

    [Fact]
    public void Core_lines_for_stopped_given_up_and_failed()
    {
        Assert.Equal("Core: durduruldu", TrayStatusEvaluator.Evaluate(SupervisorSnapshot.Initial, null, Now).Lines[0]);
        Assert.Equal("Core: durduruldu (çıkış kodu 0)",
            TrayStatusEvaluator.Evaluate(new SupervisorSnapshot(CoreRunState.Stopped, LastExitCode: 0), null, Now).Lines[0]);
        Assert.Equal("Core: vazgeçildi (20 hata, son kod 1)",
            TrayStatusEvaluator.Evaluate(new SupervisorSnapshot(CoreRunState.GaveUp, Failures: 20, MaxFailures: 20, LastExitCode: 1), null, Now).Lines[0]);
        Assert.Equal("Core: başlatılamıyor: node.exe bulunamadı",
            TrayStatusEvaluator.Evaluate(new SupervisorSnapshot(CoreRunState.Failed, Problem: "node.exe bulunamadı"), null, Now).Lines[0]);
    }

    [Fact]
    public void Tooltip_never_exceeds_127_characters()
    {
        var many = Enumerable.Range(0, 20).Select(i => ($"a-rather-long-service-name-{i}", true, "down")).ToArray();
        var s = TrayStatusEvaluator.Evaluate(Running(), Health(many), Now);
        Assert.Equal(TrayStatusEvaluator.MaxTooltipLength, s.Tooltip.Length);
        Assert.EndsWith("…", s.Tooltip);

        foreach (var state in Enum.GetValues<CoreRunState>())
        {
            var snap = new SupervisorSnapshot(state, RunningSince: Now, NextRestartAt: Now, Failures: 99, MaxFailures: 100,
                LastExitCode: int.MinValue, Problem: new string('x', 500));
            Assert.True(TrayStatusEvaluator.Evaluate(snap, null, Now).Tooltip.Length <= 127, state.ToString());
        }
    }

    [Fact]
    public void Truncate_keeps_short_text()
    {
        Assert.Equal("abc", TrayStatusEvaluator.Truncate("abc", 3));
        Assert.Equal("ab…", TrayStatusEvaluator.Truncate("abcd", 3));
    }

    [Theory]
    [InlineData(0, "0 sn")]
    [InlineData(4.2, "5 sn")]
    [InlineData(59, "59 sn")]
    [InlineData(60, "1 dk")]
    [InlineData(3599, "59 dk")]
    [InlineData(3600 * 3 + 5 * 60 + 10, "3 sa 5 dk")]
    [InlineData(-5, "0 sn")]
    public void Durations_are_short_turkish(double seconds, string expected)
    {
        Assert.Equal(expected, TrayStatusEvaluator.Duration(TimeSpan.FromSeconds(seconds)));
    }

    [Fact]
    public void Detail_is_shown_after_the_status_and_its_absence_is_tolerated()
    {
        var h = new CoreHealth(true,
        [
            new ServiceHealth("home-assistant", true, "ok"),
            new ServiceHealth("whisper-svc", true, "down", "timeout"),
            new ServiceHealth("tts-svc", true, "down"),
        ]);
        var s = TrayStatusEvaluator.Evaluate(Running(), h, Now);
        Assert.Equal(TrayColour.Yellow, s.Colour);
        Assert.Equal(["home-assistant: çalışıyor", "whisper-svc: kapalı (timeout)", "tts-svc: kapalı"], s.Lines.Skip(1));
        Assert.Equal("Shadow Assistant: sorun: whisper-svc kapalı (timeout), tts-svc kapalı", s.Tooltip);
    }

    private static SupervisorSnapshot External(TimeSpan? since = null) =>
        new(CoreRunState.External, RunningSince: Now - (since ?? TimeSpan.FromMinutes(1)));

    [Fact]
    public void External_core_is_blue_with_its_services()
    {
        var s = TrayStatusEvaluator.Evaluate(External(), AllOk, Now);
        Assert.Equal(TrayColour.Blue, s.Colour);
        Assert.Equal("Shadow Assistant: Core dışarıda çalışıyor", s.Tooltip);
        Assert.Equal(
            ["Core: dışarıda çalışıyor", "home-assistant: çalışıyor", "shadow-vault: devre dışı", "whisper-svc: çalışıyor", "tts-svc: çalışıyor"],
            s.Lines);
    }

    [Fact]
    public void External_core_problems_are_in_the_tooltip_but_it_stays_blue()
    {
        var h = Health(("home-assistant", true, "ok"), ("whisper-svc", true, "down"));
        var s = TrayStatusEvaluator.Evaluate(External(), h, Now);
        Assert.Equal(TrayColour.Blue, s.Colour);
        Assert.Equal("Shadow Assistant: Core dışarıda çalışıyor; sorun: whisper-svc kapalı", s.Tooltip);
    }

    [Fact]
    public void External_core_without_a_reading_or_not_answering()
    {
        var waiting = TrayStatusEvaluator.Evaluate(External(), null, Now);
        Assert.Equal(TrayColour.Blue, waiting.Colour);
        Assert.Equal("Core: dışarıda çalışıyor", waiting.Lines[0]);
        Assert.Equal(["home-assistant: bilinmiyor", "whisper-svc: bilinmiyor", "tts-svc: bilinmiyor"], waiting.Lines.Skip(1));

        var gone = TrayStatusEvaluator.Evaluate(External(), CoreHealth.Unreachable, Now);
        Assert.Equal(TrayColour.Blue, gone.Colour);
        Assert.Equal("Core: dışarıda çalışıyor (yanıt vermiyor)", gone.Lines[0]);
        Assert.Equal("Shadow Assistant: Core dışarıda çalışıyor", gone.Tooltip);
    }

    [Fact]
    public void Health_of_an_external_core_counts_from_when_it_was_seen()
    {
        var snap = External(TimeSpan.FromSeconds(3));
        Assert.Null(TrayStatusEvaluator.CurrentHealth(snap, new HealthReading(AllOk, Now.AddSeconds(-4))));
        Assert.Same(AllOk, TrayStatusEvaluator.CurrentHealth(snap, new HealthReading(AllOk, Now.AddSeconds(-1))));
    }

    [Fact]
    public void Health_from_before_the_current_run_is_ignored()
    {
        var snap = Running(TimeSpan.FromSeconds(3));
        var stale = new HealthReading(AllOk, Now.AddSeconds(-4));
        var fresh = new HealthReading(AllOk, Now.AddSeconds(-1));
        Assert.Null(TrayStatusEvaluator.CurrentHealth(snap, stale));
        Assert.Same(AllOk, TrayStatusEvaluator.CurrentHealth(snap, fresh));
        Assert.Null(TrayStatusEvaluator.CurrentHealth(new SupervisorSnapshot(CoreRunState.Stopped), fresh));
        Assert.Null(TrayStatusEvaluator.CurrentHealth(snap, null));
    }

    // --- T8.6a idle, T8.6c game mode ---

    [Fact]
    public void Idle_whisper_is_healthy_with_a_turkish_label()
    {
        var h = new CoreHealth(true,
        [
            new ServiceHealth("home-assistant", true, "ok"),
            new ServiceHealth("whisper-svc", true, "ok", "idle"),
            new ServiceHealth("tts-svc", true, "ok"),
        ]);
        var s = TrayStatusEvaluator.Evaluate(Running(), h, Now);
        Assert.Equal(TrayColour.Green, s.Colour);
        Assert.Equal("Shadow Assistant: her şey çalışıyor", s.Tooltip);
        Assert.Contains("whisper-svc: hazır (boşta, model kaldırıldı)", s.Lines);
        // Other details keep the free-text rendering.
        Assert.Equal("kapalı (idle)", TrayStatusEvaluator.ServiceText(new ServiceHealth("x", true, "down", "idle")));
    }

    [Theory]
    [InlineData("down")]
    [InlineData("loading")]
    [InlineData("unknown")]
    public void Game_mode_whisper_down_is_not_a_problem(string status)
    {
        var h = new CoreHealth(true,
        [
            new ServiceHealth("home-assistant", true, "ok"),
            new ServiceHealth("whisper-svc", true, status, "unreachable"),
            new ServiceHealth("tts-svc", true, "ok"),
        ]);
        var s = TrayStatusEvaluator.Evaluate(Running(), h, Now, gameMode: true);
        Assert.Equal(TrayColour.Green, s.Colour);
        Assert.True(s.GameMode);
        Assert.Equal("Shadow Assistant (oyun modu): whisper-svc kapalı, gerisi çalışıyor", s.Tooltip);
        Assert.Equal(["home-assistant: çalışıyor", "whisper-svc: oyun modu", "tts-svc: çalışıyor"], s.Lines.Skip(1));

        // The same reading without game mode is a problem.
        Assert.Equal(TrayColour.Yellow, TrayStatusEvaluator.Evaluate(Running(), h, Now).Colour);
    }

    [Fact]
    public void Game_mode_still_reports_other_problems()
    {
        var h = Health(("whisper-svc", true, "down"), ("tts-svc", true, "down"));
        var s = TrayStatusEvaluator.Evaluate(Running(), h, Now, gameMode: true);
        Assert.Equal(TrayColour.Yellow, s.Colour);
        Assert.Equal("Shadow Assistant (oyun modu): sorun: tts-svc kapalı", s.Tooltip);
    }

    [Fact]
    public void Game_mode_with_whisper_running_anyway_says_so()
    {
        var s = TrayStatusEvaluator.Evaluate(Running(), AllOk, Now, gameMode: true);
        Assert.Equal(TrayColour.Green, s.Colour);
        Assert.Equal("Shadow Assistant (oyun modu): her şey çalışıyor", s.Tooltip);
        Assert.Contains("whisper-svc: çalışıyor; oyun modu açık", s.Lines);
    }

    [Fact]
    public void Game_mode_is_visible_while_the_core_is_not_answering_or_stopped()
    {
        var starting = TrayStatusEvaluator.Evaluate(Running(), null, Now, gameMode: true);
        Assert.Equal(TrayColour.Yellow, starting.Colour);
        Assert.Equal(["home-assistant: bilinmiyor", "whisper-svc: oyun modu", "tts-svc: bilinmiyor"], starting.Lines.Skip(1));
        Assert.StartsWith("Shadow Assistant (oyun modu): ", starting.Tooltip);

        var stopped = TrayStatusEvaluator.Evaluate(SupervisorSnapshot.Initial, null, Now, gameMode: true);
        Assert.Equal(TrayColour.Red, stopped.Colour);
        Assert.True(stopped.GameMode);
        Assert.Equal("Shadow Assistant (oyun modu): Core durduruldu", stopped.Tooltip);
    }

    [Fact]
    public void Game_mode_keeps_external_core_blue_without_whisper_problem()
    {
        var h = Health(("home-assistant", true, "ok"), ("whisper-svc", true, "down"));
        var s = TrayStatusEvaluator.Evaluate(External(), h, Now, gameMode: true);
        Assert.Equal(TrayColour.Blue, s.Colour);
        Assert.Equal("Shadow Assistant (oyun modu): Core dışarıda çalışıyor", s.Tooltip);
    }

    [Fact]
    public void Disabled_whisper_reads_disabled_in_game_mode()
    {
        var s = TrayStatusEvaluator.Evaluate(Running(), Health(("whisper-svc", false, "disabled")), Now, gameMode: true);
        Assert.Contains("whisper-svc: devre dışı", s.Lines);
    }

    [Fact]
    public void Game_mode_tooltip_never_exceeds_127_characters()
    {
        var many = Enumerable.Range(0, 20).Select(i => ($"a-rather-long-service-name-{i}", true, "down")).ToArray();
        Assert.Equal(TrayStatusEvaluator.MaxTooltipLength, TrayStatusEvaluator.Evaluate(Running(), Health(many), Now, gameMode: true).Tooltip.Length);
        foreach (var state in Enum.GetValues<CoreRunState>())
        {
            var snap = new SupervisorSnapshot(state, RunningSince: Now, NextRestartAt: Now, Failures: 99, MaxFailures: 100,
                LastExitCode: int.MinValue, Problem: new string('x', 500));
            Assert.True(TrayStatusEvaluator.Evaluate(snap, null, Now, gameMode: true).Tooltip.Length <= 127, state.ToString());
        }
    }
}
