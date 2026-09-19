using System;
using System.Threading;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Diagramon.Services;
using Diagramon.Services.Localization;

namespace Diagramon.Views;

public sealed class UpdateDialog : Window
{
    private static readonly Strings S = Strings.Instance;
    private readonly IUpdateService _updateService;
    private readonly SettingsService _settingsService;
    private readonly string _currentVersion;

    private readonly StackPanel _rootPanel;
    private readonly Border _checkingPanel;
    private readonly Border _resultPanel;
    private readonly Border _noUpdatePanel;
    private readonly Border _errorPanel;
    private readonly Border _progressPanel;
    private readonly Border _completePanel;

    private TextBlock _latestVersionLabel = null!;
    private TextBlock _releaseNotesBox = null!;
    private Button _downloadButton = null!;
    private Button _downloadInBrowserButton = null!;
    private CheckBox _skipCheckBox = null!;
    private ProgressBar _progressBar = null!;
    private TextBlock _progressLabel = null!;
    private TextBlock _completeLabel = null!;

    private CancellationTokenSource? _downloadCts;
    private string? _downloadUrl;
    private string? _zipFileName;
    private string? _latestVersion;

    public UpdateDialog(IUpdateService updateService, SettingsService settingsService)
    {
        _updateService = updateService;
        _settingsService = settingsService;
        _currentVersion = _updateService.GetCurrentVersion();

        Title = S.CheckUpdate;
        Width = 520;
        Height = 380;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        var contentGrid = new Grid
        {
            RowDefinitions = new RowDefinitions("*,Auto"),
            Margin = new Thickness(24, 24, 24, 0)
        };

        _rootPanel = new StackPanel { Spacing = 12 };

        _checkingPanel = CreateCheckingPanel();
        _resultPanel = CreateResultPanel();
        _noUpdatePanel = CreateNoUpdatePanel();
        _errorPanel = CreateErrorPanel();
        _progressPanel = CreateProgressPanel();
        _completePanel = CreateCompletePanel();

        _rootPanel.Children.Add(_checkingPanel);
        _rootPanel.Children.Add(_resultPanel);
        _rootPanel.Children.Add(_noUpdatePanel);
        _rootPanel.Children.Add(_errorPanel);
        _rootPanel.Children.Add(_progressPanel);
        _rootPanel.Children.Add(_completePanel);

        var scrollViewer = new ScrollViewer
        {
            Content = _rootPanel,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };

        Grid.SetRow(scrollViewer, 0);
        contentGrid.Children.Add(scrollViewer);

        var currentVerBar = new TextBlock
        {
            Text = $"{S.CurrentVersion}: {_currentVersion}",
            FontSize = 12,
            Foreground = new SolidColorBrush(Color.Parse("#888888")),
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 8, 0, 12)
        };
        Grid.SetRow(currentVerBar, 1);
        contentGrid.Children.Add(currentVerBar);

        Content = contentGrid;

        ShowPanels();

        _ = CheckForUpdatesAsync();
    }

    private Border CreateCheckingPanel()
    {
        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 12,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.CheckingUpdate,
                        FontSize = 16,
                        FontWeight = FontWeight.SemiBold
                    },
                    new ProgressBar
                    {
                        IsIndeterminate = true,
                        Height = 6,
                        Margin = new Thickness(0, 8, 0, 0)
                    }
                }
            }
        };
    }

    private Border CreateResultPanel()
    {
        _latestVersionLabel = new TextBlock
        {
            Text = $"{S.LatestVersion}: ",
            FontSize = 14,
            FontWeight = FontWeight.SemiBold,
            Foreground = new SolidColorBrush(Color.Parse("#2563EB"))
        };

        _releaseNotesBox = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            FontSize = 13,
            Foreground = new SolidColorBrush(Color.Parse("#555555"))
        };

        _downloadButton = new Button
        {
            Content = S.DownloadUpdate,
            MinWidth = 100,
            Padding = new Thickness(16, 6),
            HorizontalContentAlignment = HorizontalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left
        };
        _downloadButton.Click += OnDownloadClick;

        _downloadInBrowserButton = new Button
        {
            Content = S.DownloadInBrowser,
            MinWidth = 100,
            Padding = new Thickness(16, 6),
            HorizontalContentAlignment = HorizontalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left
        };
        _downloadInBrowserButton.Click += OnDownloadInBrowserClick;

        _skipCheckBox = new CheckBox
        {
            Content = S.SkipVersion,
            Margin = new Thickness(0, 4, 0, 0)
        };

        var buttonPanel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 12,
            Margin = new Thickness(0, 8, 0, 0),
            Children =
            {
                _downloadButton,
                _downloadInBrowserButton,
                _skipCheckBox
            }
        };

        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 8,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.UpdateAvailable,
                        FontSize = 18,
                        FontWeight = FontWeight.SemiBold,
                        Foreground = new SolidColorBrush(Color.Parse("#2563EB"))
                    },
                    new StackPanel
                    {
                        Spacing = 4,
                        Children =
                        {
                            new TextBlock
                            {
                                Text = $"{S.CurrentVersion}: {_currentVersion}",
                                FontSize = 14
                            },
                            _latestVersionLabel
                        }
                    },
                    new TextBlock
                    {
                        Text = S.ReleaseNotes,
                        FontWeight = FontWeight.Medium,
                        Margin = new Thickness(0, 8, 0, 0)
                    },
                    new Border
                    {
                        Background = new SolidColorBrush(Color.Parse("#F8F8F8")),
                        BorderBrush = new SolidColorBrush(Color.Parse("#E0E0E0")),
                        BorderThickness = new Thickness(1),
                        CornerRadius = new CornerRadius(6),
                        Padding = new Thickness(12),
                        MaxHeight = 180,
                        Child = new ScrollViewer
                        {
                            Content = _releaseNotesBox,
                            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
                        }
                    },
                    buttonPanel
                }
            }
        };
    }

    private Border CreateNoUpdatePanel()
    {
        var retryButton = new Button
        {
            Content = S.CheckUpdate,
            MinWidth = 100,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left
        };
        retryButton.Click += async (_, _) => await CheckForUpdatesAsync();

        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 12,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.UpdateNotAvailable,
                        FontSize = 16,
                        FontWeight = FontWeight.SemiBold,
                        Foreground = new SolidColorBrush(Color.Parse("#16A34A"))
                    },
                    new TextBlock
                    {
                        Text = $"{S.CurrentVersion}: {_currentVersion}",
                        FontSize = 14
                    },
                    retryButton
                }
            }
        };
    }

    private Border CreateErrorPanel()
    {
        var retryButton = new Button
        {
            Content = S.CheckUpdate,
            MinWidth = 100,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            HorizontalAlignment = HorizontalAlignment.Left
        };
        retryButton.Click += async (_, _) => await CheckForUpdatesAsync();

        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 12,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.CheckUpdateFailed,
                        FontSize = 14,
                        Foreground = new SolidColorBrush(Color.Parse("#DC2626"))
                    },
                    retryButton
                }
            }
        };
    }

    private Border CreateProgressPanel()
    {
        _progressBar = new ProgressBar
        {
            Height = 8,
            Minimum = 0,
            Maximum = 1,
            Value = 0,
            Margin = new Thickness(0, 8, 0, 0)
        };

        _progressLabel = new TextBlock
        {
            Text = "0%",
            FontSize = 13,
            Foreground = new SolidColorBrush(Color.Parse("#666666"))
        };

        var cancelButton = new Button
        {
            Content = S.CancelButton,
            MinWidth = 80
        };
        cancelButton.Click += (_, _) =>
        {
            _downloadCts?.Cancel();
            Close();
        };

        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 8,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.DownloadingUpdate,
                        FontSize = 16,
                        FontWeight = FontWeight.SemiBold
                    },
                    _progressBar,
                    _progressLabel,
                    cancelButton
                }
            }
        };
    }

    private Border CreateCompletePanel()
    {
        _completeLabel = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 22
        };

        var okButton = new Button
        {
            Content = S.AboutOK,
            MinWidth = 88
        };
        okButton.Click += (_, _) => Close();

        return new Border
        {
            Child = new StackPanel
            {
                Spacing = 12,
                Children =
                {
                    new TextBlock
                    {
                        Text = S.DownloadComplete,
                        FontSize = 18,
                        FontWeight = FontWeight.SemiBold,
                        Foreground = new SolidColorBrush(Color.Parse("#16A34A"))
                    },
                    _completeLabel,
                    okButton
                }
            }
        };
    }

    private void ShowPanels()
    {
        _checkingPanel.IsVisible = false;
        _resultPanel.IsVisible = false;
        _noUpdatePanel.IsVisible = false;
        _errorPanel.IsVisible = false;
        _progressPanel.IsVisible = false;
        _completePanel.IsVisible = false;
    }

    private async Task CheckForUpdatesAsync()
    {
        ShowPanels();
        _checkingPanel.IsVisible = true;

        try
        {
            var result = await _updateService.CheckForUpdateAsync();

            ShowPanels();

            if (result == null || string.IsNullOrEmpty(result.LatestVersion))
            {
                _errorPanel.IsVisible = true;
                return;
            }

            if (result.HasUpdate && !string.IsNullOrEmpty(result.DownloadUrl))
            {
                _downloadUrl = result.DownloadUrl;
                _zipFileName = result.ZipFileName;
                _latestVersion = result.LatestVersion;

                _latestVersionLabel.Text = $"{S.LatestVersion}: {result.LatestVersion}";
                _releaseNotesBox.Text = string.IsNullOrEmpty(result.ReleaseNotes)
                    ? S.CheckUpdate
                    : result.ReleaseNotes;

                if (!string.IsNullOrEmpty(_settingsService.Settings.SkipVersion) &&
                    _settingsService.Settings.SkipVersion == result.LatestVersion)
                {
                    _skipCheckBox.IsChecked = true;
                    _skipCheckBox.IsEnabled = false;
                }

                _resultPanel.IsVisible = true;
            }
            else
            {
                _noUpdatePanel.IsVisible = true;
            }
        }
        catch
        {
            ShowPanels();
            _errorPanel.IsVisible = true;
        }
    }

    private async void OnDownloadClick(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        try
        {
            var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
            {
                DefaultExtension = ".zip",
                FileTypeChoices = new[]
                {
                    new FilePickerFileType("ZIP Archive") { Patterns = new[] { "*.zip" } }
                },
                SuggestedFileName = _zipFileName ?? "Diagramon-update.zip"
            });

            if (file == null) return;

            var path = file.TryGetLocalPath();
            if (string.IsNullOrEmpty(path)) return;

            if (_skipCheckBox.IsChecked == true && _latestVersion != null)
            {
                _settingsService.Settings.SkipVersion = _latestVersion;
                _settingsService.Save();
            }

            ShowPanels();
            _progressPanel.IsVisible = true;

            _downloadCts = new CancellationTokenSource();
            var progress = new Progress<double>(p =>
            {
                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    _progressBar.Value = p;
                    _progressLabel.Text = $"{p * 100:F1}%";
                });
            });

            await _updateService.DownloadUpdateAsync(_downloadUrl!, path, progress, _downloadCts.Token);

            ShowPanels();
            _completePanel.IsVisible = true;
            _completeLabel.Text = $"{S.DownloadCompleteMessage}\n\n{S.CurrentVersion}: {_currentVersion}\n{S.LatestVersion}: {_latestVersion}";
        }
        catch (OperationCanceledException)
        {
            Close();
        }
        catch
        {
            ShowPanels();
            _errorPanel.IsVisible = true;
        }
    }

    private void OnDownloadInBrowserClick(object? sender, Avalonia.Interactivity.RoutedEventArgs e)
    {
        if (string.IsNullOrEmpty(_downloadUrl)) return;

        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = _downloadUrl,
                UseShellExecute = true
            });
        }
        catch
        {
            // fallback
        }
    }
}
