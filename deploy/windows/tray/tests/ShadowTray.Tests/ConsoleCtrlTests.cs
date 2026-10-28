using ShadowTray;

namespace ShadowTray.Tests;

public sealed class ConsoleCtrlTests
{
    [Theory]
    [InlineData("")]
    [InlineData("--send-ctrl-c")]
    [InlineData("--send-ctrl-c abc")]
    [InlineData("--send-ctrl-c -5")]
    [InlineData("--send-ctrl-c 0")]
    [InlineData("--send-ctrl-c 12 extra")]
    [InlineData("--other 12")]
    public void Helper_rejects_bad_arguments_without_touching_the_console(string commandLine)
    {
        var args = commandLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(ConsoleCtrl.BadArguments, ConsoleCtrl.RunHelper(args));
    }

    [Fact]
    public void Helper_is_the_exe_itself_when_published()
    {
        var cmd = ConsoleCtrl.HelperCommand(@"C:\tray\ShadowTray.exe", @"C:\tray\ShadowTray.dll");
        Assert.NotNull(cmd);
        Assert.Equal(@"C:\tray\ShadowTray.exe", cmd.Value.File);
        Assert.Empty(cmd.Value.LeadingArgs);
    }

    [Theory]
    [InlineData(@"C:\Program Files\dotnet\dotnet.exe")]
    [InlineData(@"C:\Program Files\dotnet\DOTNET.EXE")]
    public void Helper_runs_the_dll_again_when_hosted_by_dotnet(string host)
    {
        var cmd = ConsoleCtrl.HelperCommand(host, @"C:\tray\ShadowTray.dll");
        Assert.NotNull(cmd);
        Assert.Equal(host, cmd.Value.File);
        Assert.Equal([@"C:\tray\ShadowTray.dll"], cmd.Value.LeadingArgs);
    }

    [Fact]
    public void No_helper_without_a_path()
    {
        Assert.Null(ConsoleCtrl.HelperCommand(null, @"C:\tray\ShadowTray.dll"));
        Assert.Null(ConsoleCtrl.HelperCommand("", @"C:\tray\ShadowTray.dll"));
        Assert.Null(ConsoleCtrl.HelperCommand(@"C:\Program Files\dotnet\dotnet.exe", null));
    }
}
