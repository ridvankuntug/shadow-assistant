using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ShadowTray;

/// <summary>
/// Job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when the tray process
/// ends for any reason (crash, Task Manager, sign-out), Windows closes the
/// last handle to the job and kills every process in it, i.e. the Core and
/// anything the Core started (Claude Code subprocesses).
/// </summary>
public sealed class KillOnCloseJob : IDisposable
{
    private readonly SafeFileHandle _handle;

    public KillOnCloseJob()
    {
        var h = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (h == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        _handle = new SafeFileHandle(h, ownsHandle: true);

        var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!Native.SetInformationJobObject(_handle, Native.JobObjectExtendedLimitInformation, ptr, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public void Assign(Process process)
    {
        if (!Native.AssignProcessToJobObject(_handle, process.SafeHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
    }

    /// <summary>Kills every process in the job (the job stays usable).</summary>
    public void Terminate(uint exitCode = 1) => Native.TerminateJobObject(_handle, exitCode);

    public void Dispose() => _handle.Dispose();
}

/// <summary>
/// Sends Ctrl+C to a console process: the Core's SIGINT handler then closes
/// the WebSocket server, flushes the usage log and exits with code 0.
///
/// Raising Ctrl+C means attaching to the Core's (window-less) console and
/// calling GenerateConsoleCtrlEvent, which delivers the event to every process
/// on that console, the sender included, asynchronously. The sender therefore
/// has to ignore Ctrl+C, and that "ignore" flag is inherited by the processes
/// it starts. The tray does none of this itself: it runs its own exe again as
/// a short-lived helper (<c>ShadowTray.exe --send-ctrl-c &lt;pid&gt;</c>, or
/// <c>dotnet ShadowTray.dll --send-ctrl-c &lt;pid&gt;</c> when the tray itself
/// runs under dotnet.exe; <see cref="RunHelper"/>) that attaches, ignores,
/// raises the event and exits.
/// A late event can only reach the helper, never the tray, and the tray's own
/// flag is never touched, so a Core started right afterwards still gets Ctrl+C
/// handled normally.
/// </summary>
public static class ConsoleCtrl
{
    public const string HelperSwitch = "--send-ctrl-c";

    /// <summary>Helper exit codes (anything but <see cref="Sent"/> means "not sent").</summary>
    public const int Sent = 0, BadArguments = 2, AttachFailed = 3, GenerateFailed = 4, IgnoreFailed = 5;

    private static readonly TimeSpan HelperTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// The exe started as helper; the running tray exe by default. Tools and
    /// tests that host this code in another process point it at ShadowTray.exe.
    /// </summary>
    public static string? HelperPath { get; set; } = Environment.ProcessPath;

    /// <summary>ShadowTray.dll, passed to dotnet.exe when <see cref="HelperPath"/> is the dotnet host.</summary>
    public static string? HelperAssemblyPath { get; set; } = typeof(ConsoleCtrl).Assembly.Location;

    /// <summary>
    /// File and leading arguments that run this app again as the helper. When
    /// the tray runs as <c>dotnet ShadowTray.dll</c>, the process path is
    /// dotnet.exe, so the helper is <c>dotnet.exe ShadowTray.dll</c>.
    /// Null when that cannot be built.
    /// </summary>
    public static (string File, IReadOnlyList<string> LeadingArgs)? HelperCommand(string? processPath, string? assemblyPath)
    {
        if (string.IsNullOrEmpty(processPath)) return null;
        if (!string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase))
            return (processPath, []);
        return string.IsNullOrEmpty(assemblyPath) ? null : (processPath, [assemblyPath]);
    }

    /// <summary>
    /// Clears an "ignore Ctrl+C" flag inherited from whoever started the tray,
    /// so the Core does not inherit it. Call once at start-up: the tray never
    /// sets the flag itself and has no console, so no Ctrl+C event is pending.
    /// </summary>
    public static void ClearInheritedIgnoreFlag() => Native.SetConsoleCtrlHandler(null, false);

    /// <returns>false when the event could not be sent (helper missing or failed, process gone).</returns>
    public static bool SendCtrlC(int processId, Action<string>? warn = null)
    {
        if (HelperCommand(HelperPath, HelperAssemblyPath) is not { } helper)
        {
            warn?.Invoke("warning: cannot send Ctrl+C: path of the tray exe unknown");
            return false;
        }
        var psi = new ProcessStartInfo(helper.File) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in helper.LeadingArgs) psi.ArgumentList.Add(a);
        psi.ArgumentList.Add(HelperSwitch);
        psi.ArgumentList.Add(processId.ToString(CultureInfo.InvariantCulture));
        try
        {
            using var p = Process.Start(psi);
            if (p is null) return false;
            if (!p.WaitForExit(HelperTimeout))
            {
                try { p.Kill(); } catch (InvalidOperationException) { } catch (Win32Exception) { }
                warn?.Invoke("warning: Ctrl+C helper did not finish in time");
                return false;
            }
            if (p.ExitCode == Sent) return true;
            warn?.Invoke(string.Create(CultureInfo.InvariantCulture, $"warning: Ctrl+C helper failed (exit code {p.ExitCode})"));
            return false;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            warn?.Invoke("warning: could not start the Ctrl+C helper: " + ex.Message);
            return false;
        }
    }

    /// <summary>
    /// Helper mode (<c>--send-ctrl-c &lt;pid&gt;</c>): runs in its own short-lived
    /// process and returns its exit code.
    /// </summary>
    public static int RunHelper(IReadOnlyList<string> args)
    {
        if (args.Count != 2 || args[0] != HelperSwitch ||
            !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid <= 0)
            return BadArguments;
        // Set first: the event also reaches this process. The flag dies with it.
        if (!Native.SetConsoleCtrlHandler(null, true)) return IgnoreFailed;
        // A process can be attached to one console only.
        Native.FreeConsole();
        if (!Native.AttachConsole((uint)pid)) return AttachFailed;
        return Native.GenerateConsoleCtrlEvent(Native.CTRL_C_EVENT, 0) ? Sent : GenerateFailed;
    }
}

internal static class Native
{
    public const uint CTRL_C_EVENT = 0;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    public delegate bool ConsoleCtrlHandler(uint ctrlType);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(SafeHandle job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(SafeHandle job, SafeHandle process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(SafeHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

    // Only ever called with a null handler (set / clear "ignore Ctrl+C").
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler? handler, [MarshalAs(UnmanagedType.Bool)] bool add);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr icon);

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
