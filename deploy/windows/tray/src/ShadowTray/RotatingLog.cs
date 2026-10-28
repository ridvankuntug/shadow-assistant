using System.Globalization;
using System.Text;

namespace ShadowTray;

/// <summary>
/// Append-only UTF-8 log file rotated by size, with the same file names as
/// run-core.ps1: <c>core.log</c> is current, <c>core.1.log</c> the newest old
/// file ... <c>core.N.log</c> the oldest. Thread-safe.
/// </summary>
public sealed class RotatingLog : IDisposable
{
    public const long DefaultMaxBytes = 10L * 1024 * 1024;
    public const int DefaultMaxFiles = 5;

    private static readonly UTF8Encoding Utf8NoBom = new(false);

    private readonly object _gate = new();
    private readonly string _baseName;
    private readonly Func<DateTimeOffset> _now;
    private StreamWriter? _writer;
    private bool _disposed;

    public RotatingLog(string directory, string baseName = "core", long maxBytes = DefaultMaxBytes,
        int maxFiles = DefaultMaxFiles, Func<DateTimeOffset>? now = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        ArgumentException.ThrowIfNullOrWhiteSpace(baseName);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxBytes, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(maxFiles, 1);
        Directory = directory;
        _baseName = baseName;
        MaxBytes = maxBytes;
        MaxFiles = maxFiles;
        _now = now ?? (() => DateTimeOffset.Now);
    }

    public string Directory { get; }
    public long MaxBytes { get; }
    public int MaxFiles { get; }
    public string CurrentFile => Path.Combine(Directory, _baseName + ".log");

    /// <summary>Path of old file <paramref name="index"/> (1 = newest).</summary>
    public string ArchiveFile(int index) =>
        Path.Combine(Directory, string.Create(CultureInfo.InvariantCulture, $"{_baseName}.{index}.log"));

    /// <summary>Writes a line as-is (Core output).</summary>
    public void WriteRaw(string line)
    {
        lock (_gate)
        {
            if (_disposed) return;
            try
            {
                var writer = EnsureOpen();
                writer.WriteLine(line);
                if (writer.BaseStream.Length >= MaxBytes) Rotate();
            }
            catch (IOException)
            {
                // Logging must never take the supervisor down (disk full, file locked).
                CloseWriter();
            }
            catch (UnauthorizedAccessException)
            {
                CloseWriter();
            }
        }
    }

    /// <summary>Writes a timestamped supervisor message, like run-core.ps1's Write-Log.</summary>
    public void Info(string message) => WriteRaw(FormatLine(_now(), message));

    public static string FormatLine(DateTimeOffset at, string message) =>
        at.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", CultureInfo.InvariantCulture) + " [tray] " + message;

    private StreamWriter EnsureOpen()
    {
        if (_writer is not null) return _writer;
        System.IO.Directory.CreateDirectory(Directory);
        // FileShare.ReadWrite: the log can be tailed (Get-Content -Wait) while we write.
        var stream = new FileStream(CurrentFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        _writer = new StreamWriter(stream, Utf8NoBom) { AutoFlush = true };
        return _writer;
    }

    private void Rotate()
    {
        CloseWriter();
        try
        {
            for (var i = MaxFiles; i >= 1; i--)
            {
                var src = i == 1 ? CurrentFile : ArchiveFile(i - 1);
                if (File.Exists(src)) File.Move(src, ArchiveFile(i), overwrite: true);
            }
        }
        catch (IOException)
        {
            // A reader holding a file without delete sharing: keep appending to
            // the current file and try again at the next line.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private void CloseWriter()
    {
        try { _writer?.Dispose(); }
        catch (IOException) { }
        _writer = null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
            CloseWriter();
        }
    }
}
