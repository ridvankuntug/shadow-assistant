using System.Runtime.InteropServices;

namespace ShadowTray;

/// <summary>
/// Opens a file or URL through the desktop's explorer.exe instead of starting
/// it from the tray.
///
/// Why: Task Scheduler runs the tray inside a job object, and a process the
/// tray starts lands in that job too. When the task ends (Stop-ScheduledTask,
/// uninstall-core-task.ps1, "End" in Task Scheduler) Windows kills the whole
/// job; a browser the tray started first would go with it, all tabs included.
/// Breaking away (CREATE_BREAKAWAY_FROM_JOB) only works when every job in the
/// chain allows it, which the tray cannot control. Asking the shell to do the
/// ShellExecute makes explorer.exe the parent, so the browser is in none of
/// the tray's jobs.
///
/// How: the shell's desktop window (IShellWindows.FindWindowSW, SWC_DESKTOP)
/// → its IShellBrowser → active IShellView → the view's automation object
/// (IShellFolderViewDual) → Application (IShellDispatch2) → ShellExecute.
/// This is the documented way to have the shell launch something on one's
/// behalf (the same chain is used to start unelevated processes from an
/// elevated one). Runs on the caller's thread; needs an STA thread (the
/// WinForms UI thread is one).
/// </summary>
public static class ShellLauncher
{
    private const int CSIDL_DESKTOP = 0;
    private const int SWC_DESKTOP = 8;
    private const int SWFO_NEEDDISPATCH = 1;
    private const uint SVGIO_BACKGROUND = 0;
    private const int SW_SHOWNORMAL = 1;

    private static readonly Guid CLSID_ShellWindows = new("9BA05972-F6A8-11CF-A442-00A0C90A8F39");
    private static readonly Guid SID_STopLevelBrowser = new("4C96BE40-915C-11CF-99D3-00AA004AE837");
    private static readonly Guid IID_IShellBrowser = new("000214E2-0000-0000-C000-000000000046");
    private static readonly Guid IID_IDispatch = new("00020400-0000-0000-C000-000000000046");

    /// <summary>
    /// Opens <paramref name="target"/> (URL, document or exe) with the shell's
    /// default verb. Throws <see cref="COMException"/> / <see cref="InvalidOperationException"/>
    /// when there is no desktop shell (explorer.exe not running, other shell);
    /// the caller then falls back to starting it itself.
    /// </summary>
    public static void Open(string target, string? arguments = null)
    {
        object? windows = null, desktop = null, browser = null, view = null, folderView = null;
        try
        {
            var type = Type.GetTypeFromCLSID(CLSID_ShellWindows, throwOnError: true)!;
            windows = Activator.CreateInstance(type)
                      ?? throw new InvalidOperationException("ShellWindows not available");
            object loc = CSIDL_DESKTOP;
            object? root = null; // VT_EMPTY
            desktop = ((IShellWindows)windows).FindWindowSW(ref loc, ref root, SWC_DESKTOP, out _, SWFO_NEEDDISPATCH)
                      ?? throw new InvalidOperationException("no desktop shell window (is explorer.exe the shell?)");

            var sid = SID_STopLevelBrowser;
            var iid = IID_IShellBrowser;
            Marshal.ThrowExceptionForHR(((IServiceProvider)desktop).QueryService(ref sid, ref iid, out browser));
            ((IShellBrowser)browser!).QueryActiveShellView(out view);

            var dispatch = IID_IDispatch;
            ((IShellView)view!).GetItemObject(SVGIO_BACKGROUND, ref dispatch, out folderView);
            // IShellFolderViewDual.Application → IShellDispatch2 (late bound: both are automation interfaces).
            dynamic shell = ((dynamic)folderView!).Application;
            try
            {
                shell.ShellExecute(target, arguments ?? "", "", "open", SW_SHOWNORMAL);
            }
            finally
            {
                Marshal.FinalReleaseComObject((object)shell);
            }
        }
        finally
        {
            foreach (var o in new[] { folderView, view, browser, desktop, windows })
                if (o is not null && Marshal.IsComObject(o)) Marshal.FinalReleaseComObject(o);
        }
    }

    // Only the members used are real; the placeholders keep the vtable order
    // (they are never called, so their signatures do not matter).

    [ComImport, Guid("85CB6900-4D95-11CF-960C-0080C7F4EE85"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    private interface IShellWindows
    {
        void _Count(); void _Item(); void _NewEnum(); void _Register(); void _RegisterPending();
        void _Revoke(); void _OnNavigate(); void _OnActivated();

        [return: MarshalAs(UnmanagedType.IDispatch)]
        object? FindWindowSW([In, MarshalAs(UnmanagedType.Struct)] ref object pvarloc,
            [In, MarshalAs(UnmanagedType.Struct)] ref object? pvarlocRoot, int swClass, out int phwnd, int swfwOptions);
    }

    [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [PreserveSig]
        int QueryService(ref Guid guidService, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object? ppvObject);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellBrowser
    {
        // IOleWindow
        void _GetWindow(); void _ContextSensitiveHelp();
        // IShellBrowser
        void _InsertMenusSB(); void _SetMenuSB(); void _RemoveMenusSB(); void _SetStatusTextSB();
        void _EnableModelessSB(); void _TranslateAcceleratorSB(); void _BrowseObject(); void _GetViewStateStream();
        void _GetControlWindow(); void _SendControlMsg();
        void QueryActiveShellView([MarshalAs(UnmanagedType.IUnknown)] out object? ppshv);
    }

    [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellView
    {
        // IOleWindow
        void _GetWindow(); void _ContextSensitiveHelp();
        // IShellView
        void _TranslateAccelerator(); void _EnableModeless(); void _UIActivate(); void _Refresh();
        void _CreateViewWindow(); void _DestroyViewWindow(); void _GetCurrentInfo(); void _AddPropertySheetPages();
        void _SaveViewState(); void _SelectItem();
        void GetItemObject(uint uItem, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object? ppv);
    }
}
