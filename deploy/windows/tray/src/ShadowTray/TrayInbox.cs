namespace ShadowTray;

/// <summary>
/// The tray's view of the Core's inbox counts (docs/08 "Tray"): two menu items
/// that open the UI at <c>#dev</c> / <c>#notifications</c>. Pure: no WinForms.
/// The counts come unauthenticated from loopback <c>GET /health</c>; the tray
/// holds no token, and every action happens in the UI.
/// </summary>
public static class TrayInbox
{
    /// <summary>UI hash of the Development panel (ui/src/App.tsx).</summary>
    public const string DevHash = "dev";
    /// <summary>UI hash of the notification list.</summary>
    public const string NotificationsHash = "notifications";

    /// <summary>"Geliştirme (3)"; without a count while the Core sends none.</summary>
    public static string DevMenuText(InboxCounts? inbox) => WithCount("Geliştirme", inbox?.Dev);

    /// <summary>"Bildirimler (2)"; without a count while the Core sends none.</summary>
    public static string NotificationsMenuText(InboxCounts? inbox) =>
        inbox is { NotificationsUnavailable: true } ? "Bildirimler (!)" : WithCount("Bildirimler", inbox?.Notifications);

    /// <summary>Tooltip text for the notifications item / icon while the Core cannot read them; null otherwise.</summary>
    public static string? NotificationsProblemText(InboxCounts? inbox) =>
        inbox is { NotificationsUnavailable: true } ? UnavailableText : null;

    /// <summary>Same wording as the UI's notification panel.</summary>
    public const string UnavailableText = "Bildirimler okunamadı";

    /// <summary>The UI address with <paramref name="hash"/> as its fragment: <c>http://localhost:8703/#dev</c>.</summary>
    public static string UiUrl(Uri uiBase, string? hash) =>
        string.IsNullOrEmpty(hash) ? uiBase.ToString() : new UriBuilder(uiBase) { Fragment = hash }.Uri.ToString();

    private static string WithCount(string label, int? count) => count is { } n ? $"{label} ({n})" : label;
}

/// <summary>
/// Decides the one balloon the inbox may show: "N yeni bildirim" when the
/// unread notification count rises (N = the rise; no titles or contents).
/// Development counts never show a balloon, so they are not looked at.
///
/// The first count seen is only the baseline (no balloon for what was already
/// unread when the tray started). A missing count (Core down, restarting,
/// older Core) keeps the last baseline, so a Core restart with the same
/// unread items shows nothing. A fall (items read) just lowers the baseline.
/// </summary>
public sealed class NotificationBalloon
{
    private int? _baseline;

    /// <returns>The balloon text, or null for no balloon.</returns>
    public string? Observe(InboxCounts? inbox)
    {
        // Unreadable file: the count is stale, neither a baseline nor a rise.
        if (inbox is { NotificationsUnavailable: true }) return null;
        if (inbox?.Notifications is not { } unread) return null;
        var previous = _baseline;
        _baseline = unread;
        return previous is { } p && unread > p ? $"{unread - p} yeni bildirim" : null;
    }
}
