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
}
