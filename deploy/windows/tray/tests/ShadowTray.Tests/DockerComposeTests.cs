using ShadowTray;

namespace ShadowTray.Tests;

public class DockerComposeTests
{
    [Fact]
    public void Up_and_down_arguments_match_the_deploy_docs()
    {
        var env = Path.GetTempFileName();
        try
        {
            Assert.Equal(["compose", "--env-file", env, "up", "-d"], DockerCompose.Arguments("up", env));
            Assert.Equal(["compose", "--env-file", env, "down"], DockerCompose.Arguments("down", env));
        }
        finally
        {
            File.Delete(env);
        }
    }

    [Fact]
    public void Game_mode_commands_use_the_same_env_file_handling()
    {
        var env = Path.GetTempFileName();
        try
        {
            Assert.Equal(["compose", "--env-file", env, "stop", "whisper-svc"], DockerCompose.Arguments(GameModeController.StopCommand, env));
            Assert.Equal(["compose", "--env-file", env, "up", "-d", "whisper-svc"], DockerCompose.Arguments(GameModeController.StartCommand, env));
        }
        finally
        {
            File.Delete(env);
        }
        Assert.Equal(["compose", "stop", "whisper-svc"], DockerCompose.Arguments(GameModeController.StopCommand, null));
    }

    [Fact]
    public void Missing_env_file_is_left_out()
    {
        Assert.Equal(["compose", "up", "-d"], DockerCompose.Arguments("up", Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))));
        Assert.Equal(["compose", "down"], DockerCompose.Arguments("down", null));
    }

    [Fact]
    public void Finds_docker_in_the_docker_desktop_folder_when_not_on_path()
    {
        var pf = Path.Combine(Path.GetTempPath(), "pf-" + Guid.NewGuid().ToString("N"));
        var bin = Path.Combine(pf, "Docker", "Docker", "resources", "bin");
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(bin, "docker.exe"), "");
        try
        {
            Assert.Equal(Path.Combine(bin, "docker.exe"), DockerCompose.Find(k => k == "ProgramFiles" ? pf : k == "PATH" ? "" : null));
            Assert.Null(DockerCompose.Find(_ => null));
        }
        finally
        {
            Directory.Delete(pf, recursive: true);
        }
    }
}
