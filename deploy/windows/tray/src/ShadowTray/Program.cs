namespace ShadowTray;

internal static class Program
{
    /// <summary>
    /// Same name as run-core.ps1's mutex: the tray and the PowerShell
    /// supervisor exclude each other, so at most one Core supervisor runs per
    /// sign-in session. Local\ = this session only.
    /// </summary>
    internal const string MutexName = @"Local\ShadowAssistantCoreRunner";

    [STAThread]
    private static int Main(string[] args)
    {
        // Helper mode, started by the tray itself to send the Core Ctrl+C
        // (see ConsoleCtrl). Before the mutex: the tray that started it owns it.
        if (args.Length > 0 && args[0] == ConsoleCtrl.HelperSwitch) return ConsoleCtrl.RunHelper(args);
        ConsoleCtrl.ClearInheritedIgnoreFlag();

        using var mutex = new Mutex(false, MutexName);
        bool owned;
        try
        {
            owned = mutex.WaitOne(0);
        }
        catch (AbandonedMutexException)
        {
            // The previous owner died without releasing it; we own it now.
            owned = true;
        }
        // Another tray or run-core.ps1 already supervises the Core: exit quietly
        // (a second start from the logon task or a double click must not start a second Core).
        if (!owned) return 0;

        try
        {
            ApplicationConfiguration.Initialize();
            var settings = TraySettings.Resolve(args, Environment.GetEnvironmentVariable, AppContext.BaseDirectory);
            using var app = new TrayApp(settings);
            Application.Run(app);
            return 0;
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }
}
