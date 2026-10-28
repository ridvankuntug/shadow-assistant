using ShadowTray;

namespace ShadowTray.Tests;

public class RestartTrackerTests
{
    private static readonly TimeSpan Short = TimeSpan.FromSeconds(3);

    [Fact]
    public void Default_policy_matches_run_core_ps1()
    {
        var p = RestartPolicy.Default;
        Assert.Equal(TimeSpan.FromSeconds(5), p.InitialDelay);
        Assert.Equal(TimeSpan.FromMinutes(5), p.MaxDelay);
        Assert.Equal(TimeSpan.FromMinutes(10), p.StableUptime);
        Assert.Equal(20, p.MaxFailures);
    }

    [Fact]
    public void Clean_exit_is_not_restarted()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        var d = t.OnExit(0, Short);
        Assert.Equal(ExitAction.Stop, d.Action);
        Assert.Equal(0, t.Failures);
    }

    [Fact]
    public void Delay_doubles_from_5s_and_caps_at_5_minutes()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        var delays = Enumerable.Range(0, 9).Select(_ => t.OnExit(1, Short)).Select(d => (int)d.Delay.TotalSeconds).ToArray();
        Assert.Equal([5, 10, 20, 40, 80, 160, 300, 300, 300], delays);
    }

    [Fact]
    public void Gives_up_on_the_20th_short_run_in_a_row()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        for (var i = 1; i <= 19; i++)
        {
            var d = t.OnExit(1, Short);
            Assert.Equal(ExitAction.Restart, d.Action);
            Assert.Equal(i, d.Failures);
        }
        var last = t.OnExit(1, Short);
        Assert.Equal(ExitAction.GiveUp, last.Action);
        Assert.Equal(20, last.Failures);
    }

    [Fact]
    public void A_run_of_10_minutes_resets_delay_and_failure_count()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        for (var i = 0; i < 5; i++) t.OnExit(1, Short);
        var d = t.OnExit(1, TimeSpan.FromMinutes(10));
        Assert.Equal(ExitAction.Restart, d.Action);
        Assert.Equal(TimeSpan.FromSeconds(5), d.Delay);
        Assert.Equal(1, d.Failures);
    }

    [Fact]
    public void A_run_just_under_10_minutes_does_not_reset()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        t.OnExit(1, Short);
        var d = t.OnExit(1, TimeSpan.FromMinutes(10) - TimeSpan.FromSeconds(1));
        Assert.Equal(TimeSpan.FromSeconds(10), d.Delay);
        Assert.Equal(2, d.Failures);
    }

    [Fact]
    public void Reset_starts_over()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        for (var i = 0; i < 4; i++) t.OnExit(1, Short);
        t.Reset();
        var d = t.OnExit(1, Short);
        Assert.Equal(TimeSpan.FromSeconds(5), d.Delay);
        Assert.Equal(1, d.Failures);
    }

    [Fact]
    public void Negative_exit_codes_count_as_crashes()
    {
        var t = new RestartTracker(RestartPolicy.Default);
        Assert.Equal(ExitAction.Restart, t.OnExit(-1073741510, Short).Action);
    }

    [Fact]
    public void Invalid_policies_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartTracker(RestartPolicy.Default with { InitialDelay = TimeSpan.Zero }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartTracker(RestartPolicy.Default with { MaxDelay = TimeSpan.FromSeconds(1) }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new RestartTracker(RestartPolicy.Default with { MaxFailures = 0 }));
    }
}
