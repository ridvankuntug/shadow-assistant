using System.Net;
using ShadowTray;

namespace ShadowTray.Tests;

public class CoreHealthTests
{
    [Fact]
    public void Parses_the_core_health_body()
    {
        // Shape produced by core/src/index.ts + server.ts (GET /health).
        var h = CoreHealth.Parse("""
            {"status":"ok","service":"core","version":"0.1.0","services":[
              {"name":"home-assistant","enabled":true,"status":"ok"},
              {"name":"shadow-vault","enabled":false,"status":"disabled"},
              {"name":"whisper-svc","enabled":true,"status":"loading"},
              {"name":"tts-svc","enabled":true,"status":"unknown"}]}
            """);
        Assert.True(h.Reachable);
        Assert.Equal(
            [
                new ServiceHealth("home-assistant", true, "ok"),
                new ServiceHealth("shadow-vault", false, "disabled"),
                new ServiceHealth("whisper-svc", true, "loading"),
                new ServiceHealth("tts-svc", true, "unknown"),
            ],
            h.Services);
    }

    [Fact]
    public void Parses_the_optional_detail_and_tolerates_its_absence()
    {
        var h = CoreHealth.Parse("""
            {"status":"ok","services":[
              {"name":"whisper-svc","enabled":true,"status":"down","detail":"timeout"},
              {"name":"tts-svc","enabled":true,"status":"down","detail":"http_503"},
              {"name":"home-assistant","enabled":true,"status":"ok"},
              {"name":"a","enabled":true,"status":"down","detail":""},
              {"name":"b","enabled":true,"status":"down","detail":7},
              {"name":"c","enabled":true,"status":"down","detail":null}]}
            """);
        Assert.Equal(
            [
                new ServiceHealth("whisper-svc", true, "down", "timeout"),
                new ServiceHealth("tts-svc", true, "down", "http_503"),
                new ServiceHealth("home-assistant", true, "ok"),
                new ServiceHealth("a", true, "down"),
                new ServiceHealth("b", true, "down"),
                new ServiceHealth("c", true, "down"),
            ],
            h.Services);
    }

    [Fact]
    public void Detail_is_cleaned_for_the_menu()
    {
        Assert.Null(CoreHealth.CleanDetail(null));
        Assert.Null(CoreHealth.CleanDetail("  \r\n "));
        Assert.Equal("timeout", CoreHealth.CleanDetail(" time\nout\t"));
        var longDetail = CoreHealth.CleanDetail(new string('x', 100))!;
        Assert.Equal(CoreHealth.MaxDetailLength, longDetail.Length);
        Assert.EndsWith("…", longDetail);
    }

    [Fact]
    public void Missing_services_list_is_reachable_with_no_services()
    {
        var h = CoreHealth.Parse("""{"status":"ok","service":"core"}""");
        Assert.True(h.Reachable);
        Assert.Empty(h.Services);
    }

    [Fact]
    public void Malformed_entries_are_skipped_or_defaulted()
    {
        var h = CoreHealth.Parse("""{"status":"ok","services":[1,{"enabled":true},{"name":"x"},{"name":"y","enabled":"yes","status":5}]}""");
        Assert.Equal([new ServiceHealth("x", false, "unknown"), new ServiceHealth("y", false, "unknown")], h.Services);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"error":"not_found"}""")]
    [InlineData("""{"status":"down"}""")]
    public void Anything_else_is_unreachable(string body)
    {
        Assert.False(CoreHealth.Parse(body).Reachable);
    }
}

public sealed class UiServerTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "shadowtray-ui-" + Guid.NewGuid().ToString("N"));
    private readonly string _outside;
    private UiServer? _server;
    private HttpClient? _http;

    public UiServerTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "assets"));
        File.WriteAllText(Path.Combine(_root, "index.html"), "<!doctype html><title>Shadow</title>");
        File.WriteAllText(Path.Combine(_root, "assets", "app.js"), "console.log(1)");
        _outside = Path.Combine(Path.GetDirectoryName(_root)!, "outside-" + Path.GetFileName(_root) + ".txt");
        File.WriteAllText(_outside, "secret");
    }

    public async Task InitializeAsync()
    {
        _server = new UiServer(_root, FreePort());
        await _server.StartAsync();
        _http = new HttpClient { BaseAddress = _server.Url };
    }

    public async Task DisposeAsync()
    {
        _http?.Dispose();
        if (_server is not null) await _server.DisposeAsync();
        Directory.Delete(_root, recursive: true);
        File.Delete(_outside);
    }

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        var port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    [Fact]
    public async Task Serves_index_and_assets()
    {
        var index = await _http!.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, index.StatusCode);
        Assert.Equal("text/html", index.Content.Headers.ContentType?.MediaType);
        Assert.Contains("Shadow", await index.Content.ReadAsStringAsync());
        Assert.Equal("no-cache", index.Headers.CacheControl?.ToString());
        Assert.Equal("nosniff", index.Headers.GetValues("X-Content-Type-Options").Single());

        var js = await _http.GetAsync("/assets/app.js");
        Assert.Equal(HttpStatusCode.OK, js.StatusCode);
        Assert.Equal("text/javascript", js.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Missing_files_and_paths_outside_the_root_are_404()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await _http!.GetAsync("/missing.js")).StatusCode);
        var name = Path.GetFileName(_outside);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync("/..%2F" + name)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _http.GetAsync("/..%5C" + name)).StatusCode);
    }

    [Fact]
    public async Task Only_get_and_head_are_allowed()
    {
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await _http!.PostAsync("/", new StringContent("x"))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _http.SendAsync(new HttpRequestMessage(HttpMethod.Head, "/"))).StatusCode);
    }

    [Theory]
    [InlineData("localhost", HttpStatusCode.OK)]
    [InlineData("127.0.0.1", HttpStatusCode.OK)]
    [InlineData("evil.example", HttpStatusCode.BadRequest)]
    public async Task Host_header_must_be_a_loopback_name(string host, HttpStatusCode expected)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/");
        req.Headers.Host = $"{host}:{_server!.Url.Port}";
        Assert.Equal(expected, (await _http!.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task A_taken_port_fails_to_start()
    {
        await using var second = new UiServer(_root, _server!.Url.Port);
        await Assert.ThrowsAsync<IOException>(second.StartAsync);
    }
}
