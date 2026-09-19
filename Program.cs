using Avalonia;
using System;
using System.IO;
using System.Threading.Tasks;
using Avalonia.WebView.Desktop;
using Diagramon.Services;

namespace Diagramon;

class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // 必须在任何路径被读取之前：把旧产品名（Mermaider）的本地数据搬过来，
        // 否则老用户会设置全丢、且因 secure.config 未迁移而被静默登出。
        AppDataMigration.Run();

        AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) =>
        {
            WriteCrashLog("UnhandledException", eventArgs.ExceptionObject as Exception);
        };

        TaskScheduler.UnobservedTaskException += (_, eventArgs) =>
        {
            WriteCrashLog("UnobservedTaskException", eventArgs.Exception);
            eventArgs.SetObserved();
        };

        BuildAvaloniaApp()
            .StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseDesktopWebView();

    private static void WriteCrashLog(string source, Exception? ex)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Diagramon");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "crash.log");
            var content = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {source}{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}";
            File.AppendAllText(file, content);
        }
        catch
        {
            // 忽略日志写入失败
        }
    }
}
