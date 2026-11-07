using System.Net;
using System.Net.Sockets;
using System.Text;
using ShadowTray;

namespace ShadowTray.Tests;

/// <summary>T7.w.4d (docs/08 "Tray"): inbox counts from /health in the tray.</summary>
public class TrayInboxTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 7, 12, 0, 0, TimeSpan.Zero);

    private static SupervisorSnapshot Running() =>
        new(CoreRunState.Running, RunningSince: Now - TimeSpan.FromMinutes(1), MaxFailures: 20);

    // --- parsing -----------------------------------------------------------

    [Fact]
    public void Parses_the_inbox_counts()
    {
        var h = CoreHealth.Parse("""{"status":"ok","services":[],"inbox":{"dev":3,"notifications":2}}""");
        Assert.True(h.Reachable);
        Assert.Equal(new InboxCounts(3, 2), h.Inbox);
    }

    [Fact]
    public void Each_count_is_optional()
    {
        // Today's Core sends only dev; the notification store adds its count separately.
        Assert.Equal(new InboxCounts(3, null), CoreHealth.Parse("""{"status":"ok","inbox":{"dev":3}}""").Inbox);
        Assert.Equal(new InboxCounts(null, 4), CoreHealth.Parse("""{"status":"ok","inbox":{"notifications":4}}""").Inbox);
        Assert.Equal(new InboxCounts(null, null), CoreHealth.Parse("""{"status":"ok","inbox":{}}""").Inbox);
    }

    [Fact]
    public void Absent_inbox_is_null()
    {
        // Remote callers and older Cores get no inbox.
        var h = CoreHealth.Parse("""{"status":"ok","service":"core","services":[{"name":"tts-svc","enabled":true,"status":"ok"}]}""");
        Assert.True(h.Reachable);
        Assert.Null(h.Inbox);
        Assert.Single(h.Services);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("3")]
    [InlineData("\"x\"")]
    [InlineData("[1,2]")]
    public void A_malformed_inbox_is_ignored_without_failing_the_health(string inbox)
    {
        var h = CoreHealth.Parse("{\"status\":\"ok\",\"services\":[{\"name\":\"tts-svc\",\"enabled\":true,\"status\":\"ok\"}],\"inbox\":" + inbox + "}");
        Assert.True(h.Reachable);
        Assert.Null(h.Inbox);
        Assert.Equal([new ServiceHealth("tts-svc", true, "ok")], h.Services);
    }

    [Theory]
    [InlineData("\"3\"")]
    [InlineData("-1")]
    [InlineData("1.5")]
    [InlineData("1e20")]
    [InlineData("true")]
    [InlineData("null")]
    [InlineData("{}")]
    public void A_malformed_count_is_dropped_and_the_other_kept(string bad)
    {
        var h = CoreHealth.Parse("{\"status\":\"ok\",\"inbox\":{\"dev\":" + bad + ",\"notifications\":2}}");
        Assert.True(h.Reachable);
        Assert.Equal(new InboxCounts(null, 2), h.Inbox);
    }

    // --- status, dot -------------------------------------------------------

    [Fact]
    public void Status_carries_the_inbox_and_a_dot_only_for_unread_notifications()
    {
        var withUnread = TrayStatusEvaluator.Evaluate(Running(), new CoreHealth(true, [], new InboxCounts(5, 1)), Now);
        Assert.Equal(new InboxCounts(5, 1), withUnread.Inbox);
        Assert.True(withUnread.NotificationDot);

        var devOnly = TrayStatusEvaluator.Evaluate(Running(), new CoreHealth(true, [], new InboxCounts(5, 0)), Now);
        Assert.False(devOnly.NotificationDot);

        var noCount = TrayStatusEvaluator.Evaluate(Running(), new CoreHealth(true, [], new InboxCounts(5, null)), Now);
        Assert.False(noCount.NotificationDot);
    }

    [Fact]
    public void External_core_counts_are_shown_too()
    {
        var external = new SupervisorSnapshot(CoreRunState.External, RunningSince: Now);
        var s = TrayStatusEvaluator.Evaluate(external, new CoreHealth(true, [], new InboxCounts(0, 2)), Now);
        Assert.True(s.NotificationDot);
    }

    [Fact]
    public void No_counts_or_dot_while_the_core_does_not_answer()
    {
        var stopped = TrayStatusEvaluator.Evaluate(SupervisorSnapshot.Initial, new CoreHealth(true, [], new InboxCounts(1, 1)), Now);
        Assert.Null(stopped.Inbox);
        Assert.False(stopped.NotificationDot);

        var unreachable = TrayStatusEvaluator.Evaluate(Running(), CoreHealth.Unreachable, Now);
        Assert.Null(unreachable.Inbox);
    }

    [Fact]
    public void Every_icon_has_a_dot_variant_that_differs()
    {
        using var icons = new TrayIcons(16);
        foreach (var colour in Enum.GetValues<TrayColour>())
        foreach (var gameMode in new[] { false, true })
        {
            using var plain = icons[colour, gameMode, false].ToBitmap();
            using var dotted = icons[colour, gameMode, true].ToBitmap();
            // The dot sits in the top-right corner.
            Assert.NotEqual(plain.GetPixel(12, 3), dotted.GetPixel(12, 3));
        }
    }

    [Fact]
    public void A_reading_from_before_the_current_run_brings_no_counts()
    {
        var run = Running();
        var stale = new HealthReading(new CoreHealth(true, [], new InboxCounts(4, 9)), run.RunningSince!.Value - TimeSpan.FromSeconds(1));
        var s = TrayStatusEvaluator.Evaluate(run, TrayStatusEvaluator.CurrentHealth(run, stale), Now);
        Assert.Null(s.Inbox);
        Assert.False(s.NotificationDot);
    }

    // --- menu --------------------------------------------------------------

    [Fact]
    public void Menu_texts_show_the_counts_when_known()
    {
        Assert.Equal("Geliştirme (3)", TrayInbox.DevMenuText(new InboxCounts(3, 0)));
        Assert.Equal("Bildirimler (0)", TrayInbox.NotificationsMenuText(new InboxCounts(3, 0)));
        Assert.Equal("Geliştirme", TrayInbox.DevMenuText(null));
        Assert.Equal("Bildirimler", TrayInbox.NotificationsMenuText(new InboxCounts(3, null)));
    }

    [Fact]
    public void Menu_items_open_the_ui_at_their_hash()
    {
        var ui = new Uri("http://localhost:8703/");
        Assert.Equal("http://localhost:8703/#dev", TrayInbox.UiUrl(ui, TrayInbox.DevHash));
        Assert.Equal("http://localhost:8703/#notifications", TrayInbox.UiUrl(ui, TrayInbox.NotificationsHash));
        Assert.Equal("http://localhost:8703/", TrayInbox.UiUrl(ui, null));
    }

    // --- balloon -----------------------------------------------------------

    [Fact]
    public void Development_counts_never_show_a_balloon()
    {
        var b = new NotificationBalloon();
        Assert.Null(b.Observe(new InboxCounts(0, null)));
        Assert.Null(b.Observe(new InboxCounts(5, null)));
        Assert.Null(b.Observe(new InboxCounts(9, 0)));
        Assert.Null(b.Observe(new InboxCounts(20, 0)));
    }

    [Fact]
    public void A_rise_in_unread_notifications_shows_one_balloon_with_the_rise()
    {
        var b = new NotificationBalloon();
        Assert.Null(b.Observe(new InboxCounts(0, 2)));   // baseline: already unread at start
        Assert.Equal("1 yeni bildirim", b.Observe(new InboxCounts(0, 3)));
        Assert.Null(b.Observe(new InboxCounts(0, 3)));   // same count: once only
        Assert.Null(b.Observe(new InboxCounts(0, 1)));   // read: lowers the baseline
        Assert.Equal("2 yeni bildirim", b.Observe(new InboxCounts(0, 3)));
    }

    [Fact]
    public void A_core_that_stops_answering_keeps_the_baseline()
    {
        var b = new NotificationBalloon();
        Assert.Null(b.Observe(new InboxCounts(0, 2)));
        Assert.Null(b.Observe(null));                     // Core down / restarting
        Assert.Null(b.Observe(new InboxCounts(0, null))); // a Core without the count
        Assert.Null(b.Observe(new InboxCounts(0, 2)));    // back with the same items
        Assert.Equal("1 yeni bildirim", b.Observe(new InboxCounts(0, 3)));
    }

    // --- no token ----------------------------------------------------------

    [Fact]
    public void Settings_have_no_token()
    {
        // The tray reads only non-secret .env keys; the counts need none.
        Assert.DoesNotContain(typeof(TraySettings).GetProperties(),
            p => p.Name.Contains("Token", StringComparison.OrdinalIgnoreCase)
                 || p.Name.Contains("Secret", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task The_health_request_carries_no_credentials()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            using var probe = new HttpCoreHealthProbe(new Uri($"http://127.0.0.1:{port}/"), TimeSpan.FromSeconds(5));
            var check = probe.CheckAsync(CancellationToken.None);

            using var client = await listener.AcceptTcpClientAsync();
            var stream = client.GetStream();
            var request = new StringBuilder();
            var buffer = new byte[4096];
            while (!request.ToString().Contains("\r\n\r\n"))
            {
                var n = await stream.ReadAsync(buffer);
                if (n == 0) break;
                request.Append(Encoding.ASCII.GetString(buffer, 0, n));
            }
            var body = """{"status":"ok","inbox":{"dev":1,"notifications":0}}""";
            var response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n{body}";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(response));

            var health = await check;
            Assert.Equal(new InboxCounts(1, 0), health.Inbox);
            var head = request.ToString();
            Assert.StartsWith("GET /health HTTP/1.1", head);
            Assert.DoesNotContain("authorization:", head, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("cookie:", head, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("token", head, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            listener.Stop();
        }
    }
}
