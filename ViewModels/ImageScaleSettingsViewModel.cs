using System;
using System.Linq;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Diagramon.Services;
using Diagramon.Services.Localization;
using Diagramon.Views;

namespace Diagramon.ViewModels;

public partial class ImageScaleSettingsViewModel : ViewModelBase
{
    private static readonly Strings S = Strings.Instance;
    private readonly SettingsService _settingsService;
    private readonly Action? _onSaved;

    private const double MinScale = 1.5;
    private const double MaxScale = 10.0;

    [ObservableProperty]
    private bool _useAutoScale = true;

    [ObservableProperty]
    private bool _useFixedScale;

    [ObservableProperty]
    private double _fixedScale = 3.0;

    public string Title => S.ImageScaleTitle;
    public string Description => S.ImageScaleDescription;
    public string AutoModeText => S.ImageScaleAutoMode;
    public string FixedModeText => S.ImageScaleFixedMode;
    public string OKButton => S.OKButton;
    public string CancelButton => S.CancelButton;

    public bool FixedScaleEnabled => UseFixedScale;

    public ImageScaleSettingsViewModel() : this(new SettingsService(), null)
    {
    }

    public ImageScaleSettingsViewModel(SettingsService settingsService, Action? onSaved)
    {
        _settingsService = settingsService;
        _onSaved = onSaved;

        var settings = settingsService.Settings;
        UseFixedScale = settings.UseFixedExportScale;
        UseAutoScale = !UseFixedScale;
        FixedScale = Math.Clamp(settings.FixedExportScale, MinScale, MaxScale);
    }

    partial void OnUseAutoScaleChanged(bool value)
    {
        if (value) UseFixedScale = false;
        else if (!UseFixedScale) UseAutoScale = true; // 保证至少一个模式选中

        OnPropertyChanged(nameof(FixedScaleEnabled));
    }

    partial void OnUseFixedScaleChanged(bool value)
    {
        if (value) UseAutoScale = false;
        else if (!UseAutoScale) UseFixedScale = true; // 保证至少一个模式选中

        OnPropertyChanged(nameof(FixedScaleEnabled));
    }

    [RelayCommand]
    private void OK()
    {
        var settings = _settingsService.Settings;
        settings.UseFixedExportScale = UseFixedScale;
        settings.FixedExportScale = Math.Clamp(FixedScale, MinScale, MaxScale);
        _settingsService.Save();

        _onSaved?.Invoke();
        CloseDialog(true);
    }

    [RelayCommand]
    private void Cancel()
    {
        CloseDialog(false);
    }

    private void CloseDialog(bool result)
    {
        if (Avalonia.Application.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime lifetime)
        {
            if (lifetime.Windows.FirstOrDefault(w => w is ImageScaleSettingsDialog) is ImageScaleSettingsDialog dialog)
            {
                dialog.Close(result);
            }
        }
    }
}
