using System;
using System.IO;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Avalonia.Threading;
using AvaloniaWebView;
using Diagramon.Services;
using Diagramon.Services.Documents;
using Diagramon.Services.Documents.Formats;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;
using Diagramon.ViewModels;
using Diagramon.Views;

namespace Diagramon;

public class App : Application
{
    public override void RegisterServices()
    {
        base.RegisterServices();
        AvaloniaWebViewBuilder.Initialize(default);
    }

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var mermaidService = new MermaidService();
            var settingsService = new SettingsService();

            LocalizationService.Initialize(settingsService.GetLanguageCode());

            // 格式注册表：界面与文件解析的**唯一**格式分派点（方案 §4.1）。
            // 项目没有 DI 容器，照现状手工组装；加格式只改这一行。
            var formats = new DocumentFormatRegistry(
            [
                new MermaidFormat(),
                new DotFormat(),
                new DrawioFormat(),
                new ExcalidrawFormat(),
            ]);

            var fileService = new FileService(formats);
            IUpdateService updateService = new UpdateService(settingsService);

            // 云端：一个共享 HTTP 出入口 + 认证 + 文档存储。
            // 未登录是默认态 —— 这三者都可在无令牌下构造，且不阻塞启动。
            var apiClient = new ApiClient(settingsService);
            var authService = new AuthService(apiClient, settingsService);
            var documentStore = new RemoteDocumentStore(apiClient, authService.TryRestoreSessionAsync);

            var mainWindow = new MainWindow();
            var viewModel = new MainViewModel(
                mermaidService,
                formats,
                fileService,
                settingsService,
                authService,
                documentStore,
                updateService,
                mainWindow.StorageProvider,
                mainWindow
            );

            mainWindow.DataContext = viewModel;

            mainWindow.WindowState = WindowState.Maximized;

            var args = Environment.GetCommandLineArgs();
            if (args.Length > 1 && File.Exists(args[1]))
            {
                // 不能在 UI 线程上 .Wait()：OpenFileFromPath 内部的 await 会把续体投回 UI 线程，
                // 而 UI 线程正被 .Wait() 阻塞 → 死锁（应用启动即挂起、窗口永不出现）。
                var startupPath = args[1];
                Dispatcher.UIThread.Post(() => _ = viewModel.OpenFileFromPath(startupPath));
            }
            else
            {
                _ = Task.Run(async () =>
                {
                    await Task.Delay(1000);
                    Dispatcher.UIThread.Post(() => viewModel.SetInitialContent());
                });
            }

            desktop.MainWindow = mainWindow;
        }

        base.OnFrameworkInitializationCompleted();
    }
}
