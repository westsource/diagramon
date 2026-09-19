using System;
using System.ComponentModel;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Diagramon.Services;
using Diagramon.Services.Localization;

namespace Diagramon.ViewModels;

public partial class UpdateDialogViewModel : ObservableObject
{
    private readonly IUpdateService _updateService;
    private static readonly Strings S = Strings.Instance;

    [ObservableProperty]
    private string _currentVersion = "";

    [ObservableProperty]
    private string _latestVersion = "";

    [ObservableProperty]
    private string _releaseNotes = "";

    [ObservableProperty]
    private string _downloadUrl = "";

    [ObservableProperty]
    private string _zipFileName = "";

    [ObservableProperty]
    private long _zipFileSize;

    [ObservableProperty]
    private bool _isUpdateAvailable;

    [ObservableProperty]
    private bool _isChecking = true;

    [ObservableProperty]
    private bool _isDownloading;

    [ObservableProperty]
    private bool _isDownloadComplete;

    [ObservableProperty]
    private double _downloadProgress;

    [ObservableProperty]
    private string _downloadProgressText = "";

    [ObservableProperty]
    private string _downloadFilePath = "";

    [ObservableProperty]
    private bool _hasError;

    [ObservableProperty]
    private string _errorMessage = "";

    [ObservableProperty]
    private bool _noUpdate;

    public UpdateDialogViewModel(IUpdateService updateService)
    {
        _updateService = updateService;
        CurrentVersion = _updateService.GetCurrentVersion();
    }

    [RelayCommand]
    public async Task CheckForUpdate()
    {
        IsChecking = true;
        HasError = false;
        IsUpdateAvailable = false;
        NoUpdate = false;

        var result = await _updateService.CheckForUpdateAsync();

        IsChecking = false;

        if (result == null || string.IsNullOrEmpty(result.LatestVersion))
        {
            HasError = true;
            ErrorMessage = S.CheckUpdateFailed;
            return;
        }

        LatestVersion = result.LatestVersion;
        ReleaseNotes = result.ReleaseNotes ?? "";
        DownloadUrl = result.DownloadUrl ?? "";
        ZipFileName = result.ZipFileName ?? "";
        ZipFileSize = result.ZipFileSize;

        if (result.HasUpdate && !string.IsNullOrEmpty(DownloadUrl))
        {
            IsUpdateAvailable = true;
        }
        else
        {
            NoUpdate = true;
        }
    }

    public void StartDownload()
    {
        IsDownloading = true;
        DownloadProgress = 0;
        DownloadProgressText = "0%";
    }

    public void UpdateProgress(double progress)
    {
        DownloadProgress = progress;
        DownloadProgressText = $"{progress * 100:F1}%";
    }

    public void CompleteDownload(string filePath)
    {
        IsDownloading = false;
        IsDownloadComplete = true;
        DownloadFilePath = filePath;
    }

    public void FailDownload(string error)
    {
        IsDownloading = false;
        HasError = true;
        ErrorMessage = error;
    }
}
