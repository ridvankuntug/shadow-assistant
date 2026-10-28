namespace ShadowTray;

/// <summary>
/// Minimal reader for the repo-root <c>.env</c>, close to Node's
/// <c>process.loadEnvFile</c> (which the Core uses): <c>KEY=value</c> lines,
/// <c>#</c> comments, optional <c>export</c>, single/double/backtick quotes.
/// The tray only needs a few non-secret keys from it (CORE_HOST, CORE_PORT,
/// SHADOW_UI_PORT); values are never logged.
/// </summary>
public static class DotEnv
{
    public static Dictionary<string, string> Parse(string text)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            if (line.StartsWith("export ", StringComparison.Ordinal)) line = line[7..].TrimStart();
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            if (key.Length == 0) continue;
            result[key] = ParseValue(line[(eq + 1)..].Trim());
        }
        return result;
    }

    private static string ParseValue(string value)
    {
        if (value.Length >= 2 && value[0] is '"' or '\'' or '`')
        {
            var quote = value[0];
            var end = value.IndexOf(quote, 1);
            if (end > 0)
            {
                var inner = value[1..end];
                return quote == '"' ? inner.Replace("\\n", "\n") : inner;
            }
        }
        var hash = value.IndexOf('#');
        return (hash >= 0 ? value[..hash] : value).Trim();
    }

    /// <summary>Reads <paramref name="path"/>; a missing or unreadable file gives an empty set.</summary>
    public static Dictionary<string, string> Load(string path)
    {
        try
        {
            return File.Exists(path) ? Parse(File.ReadAllText(path)) : new Dictionary<string, string>(StringComparer.Ordinal);
        }
        catch (IOException)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
        catch (UnauthorizedAccessException)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
    }
}
