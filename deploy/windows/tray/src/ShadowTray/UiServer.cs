using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace ShadowTray;

/// <summary>
/// Serves the built web UI (ui\dist) at http://localhost:&lt;port&gt;/ so
/// "Arayüzü aç" has something to open: nothing else serves ui\dist on the PC
/// (the Core only has /health and /ws), and the UI cannot run from file://
/// (module scripts are blocked there and the microphone needs a secure
/// context, which http://localhost is).
///
/// Kestrel on the loopback interface only, static files only (GET/HEAD),
/// Host header limited to loopback names (no DNS rebinding). HttpListener was
/// tried first and dropped: a request with a Host other than the registered
/// "localhost" took the whole listener down, and binding 127.0.0.1 through
/// http.sys needs administrator rights.
/// </summary>
public sealed class UiServer : IAsyncDisposable
{
    private readonly WebApplication _app;

    public UiServer(string root, int port)
    {
        Url = new Uri($"http://localhost:{port}/");
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = Path.GetFullPath(root) });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(k =>
        {
            k.ListenLocalhost(port);
            k.AddServerHeader = false;
        });
        builder.Services.AddHostFiltering(o =>
        {
            o.AllowedHosts = ["localhost", "127.0.0.1", "[::1]"];
            o.AllowEmptyHosts = false;
        });

        _app = builder.Build();
        _app.UseHostFiltering();
        _app.Use(async (ctx, next) =>
        {
            if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method))
            {
                ctx.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
                ctx.Response.Headers.Allow = "GET, HEAD";
                return;
            }
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            await next(ctx);
        });
        var files = new PhysicalFileProvider(Path.GetFullPath(root));
        _app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
        _app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = files,
            // index.html names the hashed asset files: always revalidate it.
            OnPrepareResponse = r => r.Context.Response.Headers.CacheControl =
                r.File.Name == "index.html" ? "no-cache" : "public, max-age=3600",
        });
    }

    public Uri Url { get; }

    /// <summary>Starts listening; throws IOException when the port is taken.</summary>
    public Task StartAsync() => _app.StartAsync();

    public async ValueTask DisposeAsync()
    {
        try
        {
            await _app.StopAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is OperationCanceledException or InvalidOperationException)
        {
            // Never started or already stopped.
        }
        await _app.DisposeAsync().ConfigureAwait(false);
    }
}
