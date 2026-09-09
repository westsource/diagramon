using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using Avalonia;
using Avalonia.Input;
using Avalonia.Data.Converters;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Platform.Storage;
using AvaloniaEdit.Highlighting;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mermaider.Models;
using Mermaider.Services;
using Mermaider.Services.Localization;
using Mermaider.Views;
using Window = Avalonia.Controls.Window;

namespace Mermaider.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly MermaidService _mermaidService;
    private readonly FileService _fileService;
    private readonly SettingsService _settingsService;
    private readonly IUpdateService _updateService;
    private readonly IStorageProvider _storageProvider;
    private readonly Window _ownerWindow;
    private readonly AIConversationService _conversationService;
    private Timer? _debounceTimer;
    private readonly object _timerLock = new();
    private readonly object _renderLock = new();
    private CancellationTokenSource? _renderCancellationTokenSource;
    private long _renderGeneration;

    private static readonly Strings S = Strings.Instance;

    public static readonly IValueConverter TabBackgroundConverter = new FuncValueConverter<bool, IBrush>(
        isSelected => isSelected ? new SolidColorBrush(Color.Parse("#FFFFFF")) : new SolidColorBrush(Color.Parse("#E8E8E8"))
    );

    public static readonly IValueConverter TabFontWeightConverter = new FuncValueConverter<bool, FontWeight>(
        isSelected => isSelected ? FontWeight.Bold : FontWeight.Normal
    );

    [ObservableProperty]
    private ObservableCollection<TabItem> _tabs = new();

    [ObservableProperty]
    private int _selectedTabIndex = -1;

    [ObservableProperty]
    private double _previewZoom = 1.0;

    [ObservableProperty]
    private double _previewFitScale = 1.0;

    [ObservableProperty]
    private double _editorPreviewRatio = 0.5;

    [ObservableProperty]
    private double _editorPanelWidth = 640;

    [ObservableProperty]
    private bool _isEditorVisible = true;

    [ObservableProperty]
    private bool _isRendering;

    [ObservableProperty]
    private string _statusMessage = Strings.Instance.Ready;

    [ObservableProperty]
    private string _currentPreviewHtml = BuildPreviewHtml(string.Empty);

    public string AppVersion { get; } = GetDisplayVersion();

    private static string GetDisplayVersion()
    {
        var attr = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        if (attr != null && !string.IsNullOrWhiteSpace(attr.InformationalVersion))
        {
            var v = attr.InformationalVersion.Split('+')[0].Trim();
            if (!string.IsNullOrEmpty(v)) return v;
        }
        return "1.0.0.0";
    }

    public string WindowTitle => $"Mermaider v{AppVersion} - {S.AppTitle.Split('-').Last().Trim()}";

    public string MenuFile => S.MenuFile;
    public string MenuNew => S.MenuNew;
    public string MenuOpen => S.MenuOpen;
    public string MenuRecentFiles => S.MenuRecentFiles;
    public string MenuSave => S.MenuSave;
    public string MenuSaveAs => S.MenuSaveAs;
    public string MenuCloseTab => S.MenuCloseTab;
    public string MenuAISettings => S.MenuAISettings;
    public string MenuImageScaleSettings => S.MenuImageScaleSettings;
    public string MenuExit => S.MenuExit;
    public string MenuEdit => S.MenuEdit;
    public string MenuUndo => S.MenuUndo;
    public string MenuRedo => S.MenuRedo;
    public string MenuCut => S.MenuCut;
    public string MenuCopy => S.MenuCopy;
    public string MenuPaste => S.MenuPaste;
    public string MenuSelectAll => S.MenuSelectAll;
    public string MenuHelp => S.MenuHelp;
    public string MenuMermaidDocs => S.MenuMermaidDocs;
    public string MenuCheckUpdate => S.MenuCheckUpdate;
    public string MenuAbout => S.MenuAbout;
    public string MenuSettings => S.MenuSettings;
    public string SavePreviewImage => S.SavePreviewImage;
    public string CopyPreviewImage => S.CopyPreviewImage;
    public string NewTabTooltip => S.NewTabTooltip;
    public string LanguageMenu => S.LanguageMenu;

    public IReadOnlyDictionary<string, LanguageInfo> AvailableLanguages => LocalizationService.Instance.AvailableLanguages;

    public string CurrentLanguageCode
    {
        get => LocalizationService.Instance.CurrentLanguageCode;
        set
        {
            if (LocalizationService.Instance.CurrentLanguageCode != value)
            {
                LocalizationService.Instance.CurrentLanguageCode = value;
                _settingsService.SetLanguageCode(value);
                OnLanguageChanged();
            }
        }
    }

    private void OnLanguageChanged()
    {
        OnPropertyChanged(nameof(CurrentLanguageCode));
        OnPropertyChanged(nameof(WindowTitle));
        OnPropertyChanged(nameof(ZoomText));
        OnPropertyChanged(nameof(MenuFile));
        OnPropertyChanged(nameof(MenuNew));
        OnPropertyChanged(nameof(MenuOpen));
        OnPropertyChanged(nameof(MenuRecentFiles));
        OnPropertyChanged(nameof(MenuSave));
        OnPropertyChanged(nameof(MenuSaveAs));
        OnPropertyChanged(nameof(MenuCloseTab));
        OnPropertyChanged(nameof(MenuAISettings));
        OnPropertyChanged(nameof(MenuImageScaleSettings));
        OnPropertyChanged(nameof(MenuExit));
        OnPropertyChanged(nameof(MenuEdit));
        OnPropertyChanged(nameof(MenuUndo));
        OnPropertyChanged(nameof(MenuRedo));
        OnPropertyChanged(nameof(MenuCut));
        OnPropertyChanged(nameof(MenuCopy));
        OnPropertyChanged(nameof(MenuPaste));
        OnPropertyChanged(nameof(MenuSelectAll));
        OnPropertyChanged(nameof(MenuHelp));
        OnPropertyChanged(nameof(MenuMermaidDocs));
        OnPropertyChanged(nameof(MenuCheckUpdate));
        OnPropertyChanged(nameof(MenuAbout));
        OnPropertyChanged(nameof(MenuSettings));
        OnPropertyChanged(nameof(SavePreviewImage));
        OnPropertyChanged(nameof(CopyPreviewImage));
        OnPropertyChanged(nameof(NewTabTooltip));
        OnPropertyChanged(nameof(LanguageMenu));
        OnPropertyChanged(nameof(AvailableLanguages));

        AiAssistant?.RefreshLocalization();
    }

    [RelayCommand]
    private void SetLanguage(string languageCode)
    {
        CurrentLanguageCode = languageCode;
    }

    private const double MinZoom = 1.0;
    private const double MaxZoom = 5.0;
    private const double ZoomStep = 0.1;
    private const int DebounceMilliseconds = 350;

    private Timer? _bgRenderTimer;

    private static readonly Regex[] NodePatterns =
    {
        new(@"\b(\w+)(?=\[\[[^\]]*\]\])", RegexOptions.Compiled),
        new(@"\b(\w+)(?=>[^\]]*\])",      RegexOptions.Compiled),
        new(@"\b(\w+)(?=\{\{[^\}]*\}\})", RegexOptions.Compiled),
        new(@"\b(\w+)(?=\(\([^\)]*\)\))", RegexOptions.Compiled),
        new(@"\b(\w+)(?=\[[^\]]*\])",     RegexOptions.Compiled),
        new(@"\b(\w+)(?=\{[^\}]*\})",     RegexOptions.Compiled),
        new(@"\b(\w+)(?=\([^\)]*\))",     RegexOptions.Compiled),
    };

    private static readonly Regex EdgePattern = new(
        @"(?:<==>|<-->|-\.->|-\.-|==>|===|-->|---|--o|--x|<=>|<--|<---|<\.->)",
        RegexOptions.Compiled);

    private static readonly Regex SubgraphPattern = new(
        @"\bsubgraph\b",
        RegexOptions.Compiled);

    [ObservableProperty]
    private bool _canUndoAction;

    [ObservableProperty]
    private bool _canRedoAction;

    [ObservableProperty]
    private bool _canCutAction;

    [ObservableProperty]
    private bool _canCopyAction;

    [ObservableProperty]
    private bool _canPasteAction = true;

    [ObservableProperty]
    private bool _canSelectAllAction;

    [ObservableProperty]
    private ObservableCollection<RecentFileItem> _recentFiles = new();

    [ObservableProperty]
    private AIPanelViewModel? _aiAssistant;

    public bool HasRecentFiles => RecentFiles.Any(r => !r.IsMoreItem);

    public string ZoomText => string.Format(S.ZoomFormat, (int)(PreviewDisplayScale * 100));

    public double PreviewDisplayScale => PreviewZoom * PreviewFitScale;

    public IHighlightingDefinition MermaidHighlighting { get; } = MermaidHighlightingProvider.Create();

    public TabItem? CurrentTab => SelectedTabIndex >= 0 && SelectedTabIndex < Tabs.Count ? Tabs[SelectedTabIndex] : null;

    partial void OnPreviewZoomChanged(double value)
    {
        OnPropertyChanged(nameof(PreviewDisplayScale));
        OnPropertyChanged(nameof(ZoomText));
    }

    partial void OnPreviewFitScaleChanged(double value)
    {
        OnPropertyChanged(nameof(PreviewDisplayScale));
        OnPropertyChanged(nameof(ZoomText));
    }

    partial void OnSelectedTabIndexChanged(int value)
    {
        for (int i = 0; i < Tabs.Count; i++)
        {
            Tabs[i].IsSelected = (i == value);
        }

        PreviewFitScale = 1.0;
        ResetEditorState();
        OnPropertyChanged(nameof(PreviewDisplayScale));
        OnPropertyChanged(nameof(ZoomText));
        OnPropertyChanged(nameof(CurrentTab));

        AiAssistant?.SetCurrentFile(CurrentTab?.FilePath);

        if (CurrentTab != null)
        {
            if (!string.IsNullOrWhiteSpace(CurrentTab.WebPreviewHtml))
            {
                CurrentPreviewHtml = CurrentTab.WebPreviewHtml;
            }
            else
            {
                CurrentPreviewHtml = string.Empty;
            }
            ScheduleValidationAndRender(CurrentTab);
        }
    }

    partial void OnIsEditorVisibleChanged(bool value)
    {
        OnPropertyChanged(nameof(EditorPanelWidth));
    }

    public MainViewModel(MermaidService mermaidService, FileService fileService, SettingsService settingsService, IUpdateService updateService, IStorageProvider storageProvider, Window ownerWindow)
    {
        _mermaidService = mermaidService;
        _fileService = fileService;
        _settingsService = settingsService;
        _updateService = updateService;
        _storageProvider = storageProvider;
        _ownerWindow = ownerWindow;
        _fileService.SetStorageProvider(storageProvider);

        _conversationService = new AIConversationService(settingsService.Settings.ConversationStoragePath);

        EditorPreviewRatio = settingsService.Settings.EditorPreviewRatio;
        PreviewZoom = settingsService.Settings.PreviewZoom;
        RecentFiles.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasRecentFiles));

        _settingsService.CleanInvalidRecentFiles();
        foreach (var file in settingsService.RecentFiles)
        {
            RecentFiles.Add(new RecentFileItem(file));
        }
        if (RecentFiles.Count > 0)
        {
            AppendMoreItem();
        }
        OnPropertyChanged(nameof(HasRecentFiles));

        InitializeAIPanelViewModel();

        AddNewTab();

        _ = CheckForUpdateOnStartupAsync();
    }

    private async Task CheckForUpdateOnStartupAsync()
    {
        var settings = _settingsService.Settings;
        if (!settings.AutoCheckUpdate) return;

        var skipVersion = settings.SkipVersion;
        if (!string.IsNullOrEmpty(skipVersion) && skipVersion == _updateService.GetCurrentVersion())
            return;

        var lastCheck = settings.LastUpdateCheckTime;
        if (!string.IsNullOrEmpty(lastCheck))
        {
            if (DateTime.TryParse(lastCheck, out var lastCheckTime))
            {
                if ((DateTime.Now - lastCheckTime).TotalHours < 24)
                    return;
            }
        }

        var result = await _updateService.CheckForUpdateAsync();
        if (result != null && result.HasUpdate && !string.IsNullOrEmpty(result.DownloadUrl))
        {
            if (!string.IsNullOrEmpty(skipVersion) && skipVersion == result.LatestVersion)
                return;

            settings.LastUpdateCheckTime = DateTime.Now.ToString("O");
            _settingsService.Save();
            await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(() =>
            {
                StatusMessage = S.UpdateAvailable;
            });
        }
    }

    private void InitializeAIPanelViewModel()
    {
        AiAssistant = new AIPanelViewModel(_settingsService, _conversationService);
        AiAssistant.GetCurrentCode = () => CurrentTab?.Content;
        AiAssistant.CodeGenerated += OnAICodeGenerated;
        AiAssistant.OpenSettingsRequested += OnOpenAISettingsRequested;
    }

    private void OnAICodeGenerated(object? sender, string code)
    {
        if (CurrentTab != null)
        {
            CurrentTab.Content = code;
            StatusMessage = S.AICodeApplied;
        }
    }

    private void OnOpenAISettingsRequested(object? sender, EventArgs e)
    {
        OpenAISettings();
    }

    [RelayCommand]
    private void OpenAISettings()
    {
        var dialog = new AISettingsDialog(new AISettingsViewModel(_settingsService, _storageProvider, () =>
        {
            AiAssistant?.RefreshConfiguration();
        }));
        _ = dialog.ShowDialog(_ownerWindow);
    }

    [RelayCommand]
    private void OpenImageScaleSettings()
    {
        var dialog = new ImageScaleSettingsDialog(new ImageScaleSettingsViewModel(_settingsService, OnImageScaleSettingsSaved));
        _ = dialog.ShowDialog(_ownerWindow);
    }

    private void OnImageScaleSettingsSaved()
    {
        // 导出倍率可能变化:作废所有标签页的缓存 PNG,并让当前页按新设置预生成
        foreach (var tab in Tabs)
        {
            tab.CachedPngBytes = null;
            tab.CachedPngScale = -1;
        }

        if (CurrentTab != null)
        {
            ScheduleBackgroundImageGeneration(CurrentTab);
        }
    }

    public void SaveSettings()
    {
        _settingsService.Settings.EditorPreviewRatio = EditorPreviewRatio;
        _settingsService.Settings.PreviewZoom = PreviewZoom;
        AiAssistant?.SaveSettings();
        _settingsService.Save();
    }

    [RelayCommand]
    private void AddNewTab()
    {
        var tab = new TabItem
        {
            Header = S.NewTabTitle,
            Content = GetDefaultMermaidCode()
        };
        tab.ContentChanged += OnTabContentChanged;
        Tabs.Add(tab);
        SelectTab(Tabs.Count - 1, forceNotify: true);
    }

    private void SelectTab(int index, bool forceNotify = false)
    {
        var previousIndex = SelectedTabIndex;
        SelectedTabIndex = index;

        if (forceNotify && previousIndex == index)
        {
            for (int i = 0; i < Tabs.Count; i++)
            {
                Tabs[i].IsSelected = (i == index);
            }

            OnPropertyChanged(nameof(CurrentTab));

            if (CurrentTab != null)
            {
                if (!string.IsNullOrWhiteSpace(CurrentTab.WebPreviewHtml))
                {
                    CurrentPreviewHtml = CurrentTab.WebPreviewHtml;
                }
                ScheduleValidationAndRender(CurrentTab);
            }
        }
    }

    private void OnTabContentChanged(object? sender, EventArgs e)
    {
        if (sender is TabItem tab)
        {
            tab.IsModified = true;
            tab.UpdateHeader();
            tab.CachedPngBytes = null;
            tab.CachedPngScale = -1;
            ScheduleValidationAndRender(tab);
        }
    }

    private void ScheduleValidationAndRender(TabItem tab)
    {
        if (!ReferenceEquals(tab, CurrentTab))
        {
            return;
        }

        CancelActiveRender();

        lock (_timerLock)
        {
            _debounceTimer?.Dispose();
            _debounceTimer = new Timer(async _ =>
        {
            await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(async () =>
            {
                await ValidateAndRenderTab(tab);
            });
        }, null, TimeSpan.FromMilliseconds(DebounceMilliseconds), Timeout.InfiniteTimeSpan);
        }
    }

    private async Task ValidateAndRenderTab(TabItem tab)
    {
        if (!ReferenceEquals(tab, CurrentTab))
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(tab.Content))
        {
            CancelActiveRender();
            tab.WebPreviewHtml = BuildPreviewHtml(string.Empty);
            tab.HasError = false;
            tab.ErrorMessage = null;
            CurrentPreviewHtml = tab.WebPreviewHtml;
            StatusMessage = S.Ready;
            return;
        }

        var contentSnapshot = tab.Content;
        var generation = Interlocked.Increment(ref _renderGeneration);
        var cancellationToken = ReplaceRenderCancellationTokenSource().Token;

        StatusMessage = S.Rendering;
        IsRendering = true;

        try
        {
            await Task.Delay(1, cancellationToken);

            if (!IsLatestRenderRequest(tab, contentSnapshot, generation))
            {
                return;
            }

            tab.HasError = false;
            tab.ErrorMessage = null;
            tab.WebPreviewHtml = BuildPreviewHtml(contentSnapshot);
            CurrentPreviewHtml = tab.WebPreviewHtml;
            StatusMessage = S.PreviewUpdated;
            ScheduleBackgroundImageGeneration(tab);
        }
        catch (OperationCanceledException)
        {
            // 新的输入触发了新一轮渲染，当前任务已取消
        }
        catch (Exception ex)
        {
            var shortError = BuildUserFriendlyError(ex.Message);
            tab.HasError = true;
            tab.ErrorMessage = shortError;
            tab.WebPreviewHtml = BuildErrorPreviewHtml(shortError);
            CurrentPreviewHtml = tab.WebPreviewHtml;
            StatusMessage = string.Format(S.ErrorFormat, shortError);
        }
        finally
        {
            if (generation == Interlocked.Read(ref _renderGeneration))
            {
                IsRendering = false;
            }
        }
    }

    private CancellationTokenSource ReplaceRenderCancellationTokenSource()
    {
        lock (_renderLock)
        {
            _renderCancellationTokenSource?.Cancel();
            _renderCancellationTokenSource?.Dispose();
            _renderCancellationTokenSource = new CancellationTokenSource();
            return _renderCancellationTokenSource;
        }
    }

    private void CancelActiveRender()
    {
        lock (_renderLock)
        {
            _renderCancellationTokenSource?.Cancel();
            _renderCancellationTokenSource?.Dispose();
            _renderCancellationTokenSource = null;
        }
    }

    private bool IsLatestRenderRequest(TabItem tab, string contentSnapshot, long generation)
    {
        return generation == Interlocked.Read(ref _renderGeneration)
            && ReferenceEquals(tab, CurrentTab)
            && tab.Content == contentSnapshot;
    }

    private enum RenderErrorKind
    {
        Syntax,
        Environment,
    }

    private static RenderErrorKind ClassifyRenderError(string? rawError)
    {
        if (string.IsNullOrWhiteSpace(rawError))
        {
            return RenderErrorKind.Environment;
        }

        // 渲染环境类错误（Chrome 缺失/无法启动、Node 缺失等），与图表语法无关
        if (rawError.Contains("Could not find Chrome", StringComparison.OrdinalIgnoreCase) ||
            rawError.Contains("Failed to launch the browser process", StringComparison.OrdinalIgnoreCase) ||
            rawError.Contains("is not recognized", StringComparison.OrdinalIgnoreCase) ||
            rawError.Contains("不是内部或外部命令", StringComparison.OrdinalIgnoreCase))
        {
            return RenderErrorKind.Environment;
        }

        return RenderErrorKind.Syntax;
    }

    private static string BuildUserFriendlyError(string? rawError)
    {
        if (string.IsNullOrWhiteSpace(rawError))
        {
            return S.UnknownError;
        }

        if (rawError.Contains("Could not find Chrome", StringComparison.OrdinalIgnoreCase) ||
            rawError.Contains("Failed to launch the browser process", StringComparison.OrdinalIgnoreCase))
        {
            return S.ChromeNotFoundError;
        }

        if (rawError.Contains("is not recognized", StringComparison.OrdinalIgnoreCase) ||
            rawError.Contains("不是内部或外部命令", StringComparison.OrdinalIgnoreCase))
        {
            return S.NodeNotFoundError;
        }

        var lines = rawError
            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Trim())
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToArray();

        if (lines.Length == 0)
        {
            return S.UnknownError;
        }

        var candidate = lines.FirstOrDefault(line =>
            !line.StartsWith("at ", StringComparison.OrdinalIgnoreCase) &&
            !line.StartsWith("在 ", StringComparison.OrdinalIgnoreCase));

        candidate ??= lines[0];

        if (candidate.StartsWith("Error:", StringComparison.OrdinalIgnoreCase))
        {
            candidate = candidate.Substring("Error:".Length).Trim();
        }

        if (candidate.Length > 120)
        {
            candidate = candidate.Substring(0, 120) + "...";
        }

        return string.IsNullOrWhiteSpace(candidate) ? "未知错误" : candidate;
    }

    private async Task<byte[]?> RenderHighQualityPreviewAsync(TabItem tab)
    {
        if (string.IsNullOrWhiteSpace(tab.Content))
        {
            return null;
        }

        var elementCount = CountDiagramElements(tab.Content);
        var scale = GetExportScale(elementCount);

        if (tab.CachedPngBytes != null && Math.Abs(tab.CachedPngScale - scale) < 0.001)
        {
            return tab.CachedPngBytes;
        }

        var result = await _mermaidService.RenderAndValidateAsync(tab.Content, scale);
        if (!result.Success || result.ImageData == null)
        {
            var shortError = BuildUserFriendlyError(result.ErrorMessage);
            var kind = ClassifyRenderError(result.ErrorMessage);
            tab.HasError = true;
            tab.ErrorMessage = shortError;
            StatusMessage = kind == RenderErrorKind.Environment
                ? string.Format(S.RenderErrorFormat, shortError)
                : string.Format(S.SyntaxErrorFormat, shortError);
            return null;
        }

        tab.HasError = false;
        tab.ErrorMessage = null;
        return result.ImageData;
    }

    private static int CountDiagramElements(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return 1;

        code = Regex.Replace(code, @"%%[^\n]*", "");

        var countedIds = new HashSet<string>(StringComparer.Ordinal);
        var count = 0;

        foreach (var regex in NodePatterns)
        {
            foreach (Match match in regex.Matches(code))
            {
                if (countedIds.Add(match.Groups[1].Value))
                    count++;
            }
        }

        count += EdgePattern.Matches(code).Count;
        count += SubgraphPattern.Matches(code).Count;

        return Math.Max(1, count);
    }

    private static double CalculateScale(int elementCount)
    {
        if (elementCount <= 0)  return 1.5;
        if (elementCount <= 15) return 1.5 + elementCount * (2.0 / 15.0);
        if (elementCount <= 35) return 3.5 + (elementCount - 15) * (1.5 / 20.0);
        return 5.0;
    }

    private double GetExportScale(int elementCount)
    {
        var settings = _settingsService.Settings;
        if (settings.UseFixedExportScale)
        {
            return Math.Clamp(settings.FixedExportScale, AppSettings.MinExportScale, AppSettings.MaxExportScale);
        }

        return CalculateScale(elementCount);
    }

    private void ScheduleBackgroundImageGeneration(TabItem tab)
    {
        if (!ReferenceEquals(tab, CurrentTab))
            return;

        lock (_timerLock)
        {
            _bgRenderTimer?.Dispose();
            _bgRenderTimer = new Timer(async _ =>
            {
                await Avalonia.Threading.Dispatcher.UIThread.InvokeAsync(async () =>
                {
                    await GenerateBackgroundImageAsync(tab);
                });
            }, null, TimeSpan.FromMilliseconds(800), Timeout.InfiniteTimeSpan);
        }
    }

    private async Task GenerateBackgroundImageAsync(TabItem tab)
    {
        if (!ReferenceEquals(tab, CurrentTab))
            return;

        if (string.IsNullOrWhiteSpace(tab.Content))
            return;

        var contentSnapshot = tab.Content;

        var elementCount = CountDiagramElements(contentSnapshot);
        var scale = GetExportScale(elementCount);

        var result = await _mermaidService.RenderAndValidateAsync(contentSnapshot, scale);

        if (!result.Success || result.ImageData == null)
            return;

        if (ReferenceEquals(tab, CurrentTab) && tab.Content == contentSnapshot)
        {
            tab.CachedPngBytes = result.ImageData;
            tab.CachedPngScale = scale;
        }
    }

    private async Task<bool> SaveTabAsync(TabItem tab)
    {
        var filePath = tab.FilePath;
        bool isNewFile = string.IsNullOrEmpty(filePath);

        if (isNewFile)
        {
            filePath = await _fileService.SaveFileAsync(tab.Content, tab.Header);
            if (filePath == null)
            {
                return false;
            }

            tab.FilePath = filePath;
        }
        else
        {
            await _fileService.SaveFileToPathAsync(tab.Content, filePath!);
        }

        tab.IsModified = false;
        tab.UpdateHeader();

        if (isNewFile && !string.IsNullOrEmpty(filePath))
        {
            AddToRecentFiles(filePath);
        }

        StatusMessage = S.Saved;
        return true;
    }

    private async Task<SaveChangesDialogResult> ShowSaveChangesDialogAsync(TabItem tab)
    {
        var dialog = new SaveChangesDialog(tab.Header);
        return await dialog.ShowDialog<SaveChangesDialogResult>(_ownerWindow);
    }

    private async Task<bool> ConfirmCloseTabAsync(TabItem tab)
    {
        if (!tab.IsModified)
        {
            return true;
        }

        var action = await ShowSaveChangesDialogAsync(tab);
        return action switch
        {
            SaveChangesDialogResult.Save => await SaveTabAsync(tab),
            SaveChangesDialogResult.DontSave => true,
            _ => false
        };
    }

    [RelayCommand]
    private async Task CloseTab(TabItem tab)
    {
        var index = Tabs.IndexOf(tab);
        if (index < 0)
        {
            return;
        }

        if (!await ConfirmCloseTabAsync(tab))
        {
            StatusMessage = S.Cancelled;
            return;
        }

        tab.ContentChanged -= OnTabContentChanged;

        var wasSelected = (index == SelectedTabIndex);

        Tabs.RemoveAt(index);

        if (Tabs.Count == 0)
        {
            SelectedTabIndex = -1;
            OnPropertyChanged(nameof(CurrentTab));

            // 关闭最后一个标签页后立即创建新的示例标签页
            AddNewTab();
        }
        else if (wasSelected)
        {
            // 如果关闭的是当前选中的标签，选择相邻的标签
            var newIndex = Math.Min(index, Tabs.Count - 1);
            SelectTab(newIndex, forceNotify: true);
        }
        else if (SelectedTabIndex > index)
        {
            // 如果关闭的标签在当前选中标签之前，调整索引
            SelectedTabIndex--;
        }
        else
        {
            // 即使不是当前选中的标签被关闭，也需要更新 IsSelected 状态
            for (int i = 0; i < Tabs.Count; i++)
            {
                Tabs[i].IsSelected = (i == SelectedTabIndex);
            }
        }
    }

    [RelayCommand]
    private async Task NewFile()
    {
        AddNewTab();
    }

    [RelayCommand]
    private async Task OpenFile()
    {
        var (content, filePath) = await _fileService.OpenFileAsync();
        if (content != null)
        {
            if (TrySelectExistingTabByPath(filePath))
            {
                StatusMessage = S.FileAlreadyOpen;
                return;
            }

            var tab = new TabItem
            {
                Content = content,
                FilePath = filePath
            };
            tab.ContentChanged += OnTabContentChanged;
            tab.UpdateHeader();
            Tabs.Add(tab);
            SelectedTabIndex = Tabs.Count - 1;

            if (!string.IsNullOrEmpty(filePath))
            {
                AddToRecentFiles(filePath);
            }
        }
    }

    public async Task OpenFileFromPath(string filePath)
    {
        if (TrySelectExistingTabByPath(filePath))
        {
            StatusMessage = S.FileAlreadyOpen;
            return;
        }

        var content = await _fileService.OpenFileFromPathAsync(filePath);
        if (content != null)
        {
            var tab = new TabItem
            {
                Content = content,
                FilePath = filePath
            };
            tab.ContentChanged += OnTabContentChanged;
            tab.UpdateHeader();
            Tabs.Add(tab);
            SelectedTabIndex = Tabs.Count - 1;

            AddToRecentFiles(filePath);
        }
    }

    [RelayCommand]
    private async Task OpenRecentFile(RecentFileItem? item)
    {
        if (item == null) return;

        if (item.IsMoreItem)
        {
            await ShowRecentHistory();
            return;
        }

        var filePath = item.FilePath;
        if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
        {
            RemoveFromRecentFiles(filePath);
            StatusMessage = S.FileNotFound;
            return;
        }

        var existingTab = Tabs.FirstOrDefault(t => t.FilePath == filePath);
        if (existingTab != null)
        {
            SelectedTabIndex = Tabs.IndexOf(existingTab);
            return;
        }

        await OpenFileFromPath(filePath);
    }

    [RelayCommand]
    private async Task ShowRecentHistory()
    {
        var history = _settingsService.GetHistoryWithExistingFiles();
        if (history.Count == 0)
        {
            StatusMessage = S.RecentHistoryNoItems;
            return;
        }

        var dialog = new RecentHistoryDialog(history);
        var filePath = await dialog.ShowDialog<string?>(_ownerWindow);
        if (!string.IsNullOrEmpty(filePath))
        {
            await OpenFileFromPath(filePath);
        }
    }

    private void AddToRecentFiles(string filePath)
    {
        RemoveMoreItem();

        var existing = RecentFiles.FirstOrDefault(r => r.FilePath == filePath);
        if (existing != null)
        {
            RecentFiles.Remove(existing);
        }

        var item = new RecentFileItem(filePath);
        RecentFiles.Insert(0, item);

        while (RecentFiles.Count > SettingsService.MaxRecentFiles)
        {
            RecentFiles.RemoveAt(RecentFiles.Count - 1);
        }

        AppendMoreItem();

        _settingsService.AddRecentFile(filePath);
        OnPropertyChanged(nameof(HasRecentFiles));
    }

    private void RemoveMoreItem()
    {
        var more = RecentFiles.FirstOrDefault(r => r.IsMoreItem);
        if (more != null) RecentFiles.Remove(more);
    }

    private void AppendMoreItem()
    {
        RecentFiles.Add(RecentFileItem.CreateMoreItem());
    }

    private void RemoveFromRecentFiles(string? filePath)
    {
        if (string.IsNullOrEmpty(filePath)) return;

        RemoveMoreItem();

        var item = RecentFiles.FirstOrDefault(r => r.FilePath == filePath);
        if (item != null)
        {
            RecentFiles.Remove(item);
            _settingsService.RemoveRecentFile(filePath);
        }

        if (RecentFiles.Count > 0)
        {
            AppendMoreItem();
        }

        OnPropertyChanged(nameof(HasRecentFiles));
    }

    [RelayCommand]
    private async Task SaveFile()
    {
        if (CurrentTab == null) return;
        await SaveTabAsync(CurrentTab);
    }

    [RelayCommand]
    private async Task SaveFileAs()
    {
        if (CurrentTab == null) return;
        var filePath = await _fileService.SaveFileAsync(CurrentTab.Content, CurrentTab.Header);
        if (filePath == null) return;

        CurrentTab.FilePath = filePath;
        CurrentTab.IsModified = false;
        CurrentTab.UpdateHeader();
        AddToRecentFiles(filePath);
        StatusMessage = S.Saved;
    }

    private bool TrySelectExistingTabByPath(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return false;
        }

        string normalizedPath;
        try
        {
            normalizedPath = Path.GetFullPath(filePath);
        }
        catch
        {
            normalizedPath = filePath;
        }

        var existingTab = Tabs.FirstOrDefault(tab =>
        {
            if (string.IsNullOrWhiteSpace(tab.FilePath))
            {
                return false;
            }

            try
            {
                return string.Equals(
                    Path.GetFullPath(tab.FilePath),
                    normalizedPath,
                    StringComparison.OrdinalIgnoreCase
                );
            }
            catch
            {
                return string.Equals(tab.FilePath, filePath, StringComparison.OrdinalIgnoreCase);
            }
        });

        if (existingTab == null)
        {
            return false;
        }

        var existingIndex = Tabs.IndexOf(existingTab);
        if (existingIndex >= 0)
        {
            SelectedTabIndex = existingIndex;
            return true;
        }

        return false;
    }

    [RelayCommand]
    private async Task CopyImage()
    {
        if (CurrentTab == null) return;

        var pngBytes = await RenderHighQualityPreviewAsync(CurrentTab);
        if (pngBytes == null)
        {
            return;
        }

        var clipboard = _ownerWindow.Clipboard;
        if (clipboard == null)
        {
            StatusMessage = S.ClipboardNotSupported;
            return;
        }

        var dataObject = new DataObject();
        dataObject.Set("image/png", pngBytes);
        dataObject.Set("PNG", pngBytes);

        await clipboard.SetDataObjectAsync(dataObject);
        StatusMessage = S.ImageCopied;
    }

    [RelayCommand]
    private async Task SaveImage()
    {
        if (CurrentTab == null) return;

        var imageData = await RenderHighQualityPreviewAsync(CurrentTab);
        if (imageData == null)
        {
            return;
        }

        var fileName = Path.GetFileNameWithoutExtension(CurrentTab.Header) + ".png";
        var result = await _fileService.SaveImageAsync(imageData, fileName);
        if (result != null)
        {
            StatusMessage = S.ImageSaved;
        }
    }

    [RelayCommand]
    private void ZoomIn()
    {
        PreviewZoom = Math.Min(PreviewZoom + ZoomStep, MaxZoom);
        StatusMessage = string.Format(S.ZoomFormat, (int)(PreviewZoom * 100));
    }

    [RelayCommand]
    private void ZoomOut()
    {
        PreviewZoom = Math.Max(PreviewZoom - ZoomStep, MinZoom);
        StatusMessage = string.Format(S.ZoomFormat, (int)(PreviewZoom * 100));
    }

    [RelayCommand]
    private void ResetZoom()
    {
        PreviewZoom = 1.0;
        StatusMessage = S.ZoomReset;
    }

    [RelayCommand]
    private async Task CloseCurrentTab()
    {
        if (CurrentTab != null)
        {
            await CloseTab(CurrentTab);
        }
    }

    public bool HasUnsavedChanges => Tabs.Any(t => t.IsModified);

    public async Task<bool> ConfirmCloseAsync()
    {
        var modifiedTabs = Tabs.Where(t => t.IsModified).ToList();
        if (modifiedTabs.Count == 0)
        {
            return true;
        }

        foreach (var tab in modifiedTabs)
        {
            var result = await ShowSaveChangesDialogAsync(tab);
            if (result == SaveChangesDialogResult.Cancel)
            {
                return false;
            }
            if (result == SaveChangesDialogResult.Save)
            {
                var saved = await SaveTabAsync(tab);
                if (!saved)
                {
                    return false;
                }
            }
        }

        return true;
    }

    [RelayCommand]
    private async Task Exit()
    {
        if (await ConfirmCloseAsync())
        {
            (Avalonia.Application.Current?.ApplicationLifetime as Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime)?.Shutdown();
        }
    }

    [RelayCommand]
    private void Undo()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.UndoEditor();
        }
    }

    [RelayCommand]
    private void Redo()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.RedoEditor();
        }
    }

    [RelayCommand]
    private void Cut()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.CutEditor();
        }
    }

    [RelayCommand]
    private void Copy()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.CopyEditor();
        }
    }

    [RelayCommand]
    private void Paste()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.PasteEditor();
        }
    }

    [RelayCommand]
    private void SelectAll()
    {
        if (_ownerWindow is MainWindow mainWindow)
        {
            mainWindow.SelectAllEditor();
        }
    }

    [RelayCommand]
    private void About()
    {
        var dialog = new AboutDialog(
            "Mermaider",
            "本地 Mermaid 图表编辑器。支持代码编辑、语法高亮、实时预览、缩放拖拽、语法检测、图片导出；集成 AI 助手，可通过自然语言生成图表；支持多标签页多文件编辑；本地渲染，数据不上传。",
            "道荣（黄超）",
            AppVersion
        );

        _ = dialog.ShowDialog(_ownerWindow);
    }

    [RelayCommand]
    private void CheckUpdate()
    {
        var dialog = new UpdateDialog(_updateService, _settingsService);
        _ = dialog.ShowDialog(_ownerWindow);
    }

    [RelayCommand]
    private void OpenMermaidDocs()
    {
        try
        {
            var url = "https://mermaid.js.org/intro/";
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch
        {
            StatusMessage = S.CannotOpenLink;
        }
    }

    public void UpdatePreviewFitScale(Size viewportSize)
    {
        PreviewFitScale = 1.0;
    }

    public void UpdateEditorState(bool canUndo, bool canRedo, bool hasSelection, bool hasText)
    {
        var hasTab = CurrentTab != null;
        CanUndoAction = hasTab && canUndo;
        CanRedoAction = hasTab && canRedo;
        CanCutAction = hasTab && hasSelection;
        CanCopyAction = hasTab && hasSelection;
        CanPasteAction = hasTab;
        CanSelectAllAction = hasTab && hasText;
    }

    public void UpdateWorkspaceLayout(double totalWidth)
    {
        if (totalWidth <= 0)
        {
            return;
        }

        if (!IsEditorVisible)
        {
            EditorPanelWidth = 0;
            return;
        }

        const double splitterWidth = 5;
        const double minEditorWidth = 420;
        const double maxEditorWidth = 860;
        const double minPreviewWidth = 480;

        var usableWidth = Math.Max(0, totalWidth - splitterWidth);
        var targetWidth = usableWidth * EditorPreviewRatio;
        var editorWidth = Math.Clamp(targetWidth, minEditorWidth, maxEditorWidth);

        if (usableWidth - editorWidth < minPreviewWidth)
        {
            editorWidth = Math.Max(320, usableWidth - minPreviewWidth);
        }

        EditorPanelWidth = Math.Max(320, editorWidth);
    }

    private void ResetEditorState()
    {
        CanUndoAction = false;
        CanRedoAction = false;
        CanCutAction = false;
        CanCopyAction = false;
        CanPasteAction = CurrentTab != null;
        CanSelectAllAction = false;
    }

    [RelayCommand]
    private void ToggleEditorVisibility()
    {
        IsEditorVisible = !IsEditorVisible;
    }

    private static string GetDefaultMermaidCode()
    {
        return @"graph TD
    A[开始] --> B{判断}
    B -->|是| C[处理A]
    B -->|否| D[处理B]
    C --> E[结束]
    D --> E";
    }

    public void SetInitialContent()
    {
        if (CurrentTab != null)
        {
            CurrentTab.Content = @"graph TD
    A[开始] --> B{判断}
    B -->|是| C[处理A]
    B -->|否| D[处理B]
    C --> E[结束]
    D --> E";
            CurrentTab.IsModified = false;
            CurrentTab.UpdateHeader();
        }
    }

    private static string BuildPreviewHtml(string mermaidCode)
    {
        var mermaidCodeJson = JsonSerializer.Serialize(mermaidCode ?? string.Empty);
        return $$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      overflow: hidden;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    #root {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      box-sizing: border-box;
      cursor: grab;
      touch-action: none;
      user-select: none;
      background: #fff;
    }
    #diagram svg {
      display: block;
    }
    .error {
      color: #b42318;
      background: #fef3f2;
      border: 1px solid #fecdca;
      border-radius: 8px;
      padding: 12px;
      white-space: pre-wrap;
      max-width: 100%;
    }
  </style>
</head>
<body>
  <div id="root"><div id="diagram"></div></div>
  <script src="./mermaid.min.js"></script>
  <script>
    const root = document.getElementById('root');
    const target = document.getElementById('diagram');
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const minScale = 0.2;
    const maxScale = 30;

    function applyTransform() {
      target.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      target.style.transformOrigin = 'center center';
    }

    function fitToViewport() {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      applyTransform();

      const rootRect = root.getBoundingClientRect();
      const diagramRect = target.getBoundingClientRect();
      if (rootRect.width <= 0 || rootRect.height <= 0 || diagramRect.width <= 0 || diagramRect.height <= 0) {
        return;
      }

      const padding = 24;
      const fitScaleX = Math.max(0.01, (rootRect.width - padding) / diagramRect.width);
      const fitScaleY = Math.max(0.01, (rootRect.height - padding) / diagramRect.height);
      const fitScale = Math.min(fitScaleX, fitScaleY);
      scale = Math.max(minScale, Math.min(maxScale, fitScale));
      applyTransform();
    }

    function showError(message) {
      const safeMessage = String(message ?? '').replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s]));
      target.innerHTML = `<pre class="error">${safeMessage}</pre>`;
    }

    async function renderDiagram(code) {
      try {
        if (!code || !code.trim()) {
          target.innerHTML = '';
          return;
        }
        if (!window.mermaid) {
          showError('mermaid.js 暂未加载，请稍候');
          return;
        }
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });
        const id = `mermaid-${Date.now()}`;
        const container = document.createElement('div');
        container.style.position = 'absolute';
        container.style.top = '-9999px';
        container.style.left = '-9999px';
        document.body.appendChild(container);
        const { svg } = await mermaid.render(id, code, container);
        target.innerHTML = svg;
        container.remove();
        requestAnimationFrame(() => fitToViewport());
      } catch (err) {
        showError(err && err.message ? err.message : err);
      }
    }

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      root.style.cursor = 'grabbing';
      root.setPointerCapture(e.pointerId);
    });

    root.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      offsetX += dx;
      offsetY += dy;
      applyTransform();
    });

    root.addEventListener('pointerup', (e) => {
      dragging = false;
      root.style.cursor = 'grab';
      if (root.hasPointerCapture(e.pointerId)) {
        root.releasePointerCapture(e.pointerId);
      }
    });

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const oldScale = scale;
      const zoomStep = e.deltaY < 0 ? 1.1 : 0.9;
      scale = Math.max(minScale, Math.min(maxScale, scale * zoomStep));
      if (Math.abs(scale - oldScale) < 1e-6) return;

      const rect = root.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ratio = scale / oldScale;
      offsetX -= cx * (ratio - 1);
      offsetY -= cy * (ratio - 1);
      applyTransform();
    }, { passive: false });

    root.addEventListener('dblclick', () => {
      fitToViewport();
    });

    renderDiagram({{mermaidCodeJson}});
  </script>
</body>
</html>
""";
    }

    private static string BuildErrorPreviewHtml(string errorMessage)
    {
        var escaped = System.Net.WebUtility.HtmlEncode(errorMessage);
        return $$"""
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; background: #fff; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    .error {
      color: #b42318;
      background: #fef3f2;
      border: 1px solid #fecdca;
      border-radius: 8px;
      margin: 16px;
      padding: 12px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <pre class="error">{{escaped}}</pre>
</body>
</html>
""";
    }
}
