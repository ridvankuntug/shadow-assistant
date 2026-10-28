using System.Text;
using ShadowTray;

namespace ShadowTray.Tests;

public sealed class RotatingLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "shadowtray-tests-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void Defaults_match_run_core_ps1()
    {
        using var log = new RotatingLog(_dir);
        Assert.Equal(10L * 1024 * 1024, log.MaxBytes);
        Assert.Equal(5, log.MaxFiles);
        Assert.Equal(Path.Combine(_dir, "core.log"), log.CurrentFile);
        Assert.Equal(Path.Combine(_dir, "core.3.log"), log.ArchiveFile(3));
    }

    [Fact]
    public void Creates_the_folder_and_appends_utf8_without_bom()
    {
        using (var log = new RotatingLog(_dir))
        {
            log.WriteRaw("bir");
            log.WriteRaw("ğüşiöç");
        }
        var bytes = File.ReadAllBytes(Path.Combine(_dir, "core.log"));
        Assert.False(bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
        Assert.Equal(["bir", "ğüşiöç"], File.ReadAllLines(Path.Combine(_dir, "core.log"), Encoding.UTF8));
    }

    [Fact]
    public void Appends_to_an_existing_log()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Path.Combine(_dir, "core.log"), "old\n");
        using (var log = new RotatingLog(_dir)) log.WriteRaw("new");
        Assert.Equal(["old", "new"], File.ReadAllLines(Path.Combine(_dir, "core.log")));
    }

    [Fact]
    public void Rotates_when_the_size_limit_is_reached_and_keeps_max_files()
    {
        using var log = new RotatingLog(_dir, maxBytes: 20, maxFiles: 3);
        // Each line is 10 bytes + CRLF = 12 bytes: every second line triggers a rotation.
        for (var i = 0; i < 10; i++) log.WriteRaw($"line-{i:D5}");
        log.Dispose();

        var names = Directory.GetFiles(_dir).Select(f => Path.GetFileName(f)).Order().ToArray();
        Assert.Equal(["core.1.log", "core.2.log", "core.3.log"], names);
        // Newest archive holds the latest lines; core.log was rotated away and not recreated yet.
        Assert.Equal(["line-00008", "line-00009"], File.ReadAllLines(Path.Combine(_dir, "core.1.log")));
        Assert.Equal(["line-00006", "line-00007"], File.ReadAllLines(Path.Combine(_dir, "core.2.log")));
        Assert.Equal(["line-00004", "line-00005"], File.ReadAllLines(Path.Combine(_dir, "core.3.log")));
    }

    [Fact]
    public void Writing_after_rotation_starts_a_fresh_core_log()
    {
        using var log = new RotatingLog(_dir, maxBytes: 20, maxFiles: 2);
        log.WriteRaw("aaaaaaaaaa");
        log.WriteRaw("bbbbbbbbbb");
        log.WriteRaw("cccccccccc");
        log.Dispose();
        Assert.Equal(["cccccccccc"], File.ReadAllLines(Path.Combine(_dir, "core.log")));
        Assert.Equal(["aaaaaaaaaa", "bbbbbbbbbb"], File.ReadAllLines(Path.Combine(_dir, "core.1.log")));
    }

    [Fact]
    public void A_tailing_reader_does_not_block_writing()
    {
        using var log = new RotatingLog(_dir);
        log.WriteRaw("first");
        using var reader = new FileStream(Path.Combine(_dir, "core.log"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        log.WriteRaw("second");
        log.Dispose();
        Assert.Equal(["first", "second"], File.ReadAllLines(Path.Combine(_dir, "core.log")));
    }

    [Fact]
    public void Info_lines_are_timestamped_like_run_core()
    {
        var at = new DateTimeOffset(2026, 1, 2, 3, 4, 5, 678, TimeSpan.FromHours(3));
        Assert.Equal("2026-01-02T03:04:05.678+03:00 [tray] hello", RotatingLog.FormatLine(at, "hello"));
        using (var log = new RotatingLog(_dir, now: () => at)) log.Info("hello");
        Assert.Equal(["2026-01-02T03:04:05.678+03:00 [tray] hello"], File.ReadAllLines(Path.Combine(_dir, "core.log")));
    }

    [Fact]
    public void Writes_after_dispose_are_ignored()
    {
        var log = new RotatingLog(_dir);
        log.WriteRaw("x");
        log.Dispose();
        log.WriteRaw("y");
        Assert.Equal(["x"], File.ReadAllLines(Path.Combine(_dir, "core.log")));
    }
}
