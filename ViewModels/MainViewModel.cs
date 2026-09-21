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
using Diagramon.Models;
using Diagramon.Services;
using Diagramon.Services.Documents;
using Diagramon.Services.Documents.Formats;
using Diagramon.Services.Localization;
using Diagramon.Services.Preview;
using Diagramon.Services.Remote;
using Diagramon.Views;
using Window = Avalonia.Controls.Window;

// Avalonia.Media 也有一个 RenderOptions（位图渲染参数），这里指的是文档渲染参数。
using RenderOptions = Diagramon.Services.Documents.RenderOptions;

namespace Diagramon.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly MermaidService _mermaidService;
    private readonly DocumentFormatRegistry _formats;
    private readonly PreviewSurfaceHost _previewSurfaces = new();
    private readonly FileService _fileService;
    private readonly SettingsService _settingsService;
    private readonly IUpdateService _updateService;
    private readonly IStorageProvider _storageProvider;
    private readonly Window _ownerWindow;
    private readonly AIConversationService _conversationService;
    private readonly AuthService _authService;
    private readonly RemoteDocumentStore _documentStore;
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

    /// <summary>
    /// 云端会话与账户操作。**未登录是默认态** ——
    /// UI 按 <c>Auth.Session.IsCloudEntryVisible</c> 门控云端入口，而不是按网络可用性。
    /// </summary>
    public AuthService Auth => _authService;

    /// <summary>云端文档存储。仅在 <c>Auth.Session.IsCloudEntryVisible</c> 为真时应被调用。</summary>
    public RemoteDocumentStore Cloud => _documentStore;

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

    /// <summary>
    /// 承载页 URL：<c>file://</c>（随包 JS）或 loopback 的 <c>http://127.0.0.1:&lt;端口&gt;…</c>（WASM）。
    /// </summary>
    [ObservableProperty]
    private string _currentPreviewUrl = string.Empty;

    /// <summary>
    /// 承载面身份（格式 id）。它变了说明换了页面（换格式），承载层要重新导航；
    /// 没变则一律走增量脚本 —— 重建页面会把页内的渲染器重载一遍（DOT 的 WASM 尤其贵）。
    /// </summary>
    [ObservableProperty]
    private string _currentPreviewSurfaceKey = string.Empty;

    /// <summary>内容 / 布局变化时的增量更新脚本。</summary>
    [ObservableProperty]
    private string _currentUpdateScript = string.Empty;

    /// <summary>
    /// 承载面刷新计数器。承载层只认这一个信号，避免 URL 与脚本两个通知之间的竞态。
    /// </summary>
    [ObservableProperty]
    private int _currentPreviewRevision;

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

    /// <summary>标题栏：<c>Diagramon v&lt;版本&gt; - &lt;描述&gt;</c>。</summary>
    /// <remarks>
    /// <c>AppTitle</c> 形如「Diagramon - 多格式图表编辑器」，这里只取分隔符**之后**的部分。
    /// 必须按「 - 」整串切、且只切一刀：描述自身可能含连字符（如 <c>Multi-format</c>），
    /// 用 <c>Split('-')</c> 取末段会把它切成 <c>format Diagram Editor</c>。
    /// </remarks>
    public string WindowTitle => $"Diagramon v{AppVersion} - {AppTitleSuffix}";

    private static string AppTitleSuffix
    {
        get
        {
            var parts = S.AppTitle.Split(" - ", 2, StringSplitOptions.None);
            return (parts.Length == 2 ? parts[1] : S.AppTitle).Trim();
        }
    }

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

    public string MenuAccount => S.MenuAccount;
    public string MenuSignIn => S.MenuSignIn;
    public string MenuSignOut => S.MenuSignOut;
    public string CloudSaveToCloud => S.CloudSaveToCloud;
    public string CloudDocuments => S.CloudDocuments;

    /// <summary>已登录时在账户菜单里显示的当前账号。</summary>
    public string AccountDisplayName => S.Format("AuthSignedInFormat", Auth.Session.DisplayName);

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
        OnPropertyChanged(nameof(MenuAccount));
        OnPropertyChanged(nameof(MenuSignIn));
        OnPropertyChanged(nameof(MenuSignOut));
        OnPropertyChanged(nameof(AccountDisplayName));
        OnPropertyChanged(nameof(CloudSaveToCloud));
        OnPropertyChanged(nameof(CloudDocuments));
        OnPropertyChanged(nameof(AvailableLanguages));
        OnPropertyChanged(nameof(NewTabChoices));
        OnPropertyChanged(nameof(LayoutLabel));
        OnPropertyChanged(nameof(CurrentLayoutChoices));

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

    /// <summary>待执行的"Mermaid → 图形编辑器"转换请求（一次性，由承载层取走）。</summary>
    private (TabItem Tab, string Source)? _pendingMermaidImport;

    public bool HasRecentFiles => RecentFiles.Any(r => !r.IsMoreItem);

    public string ZoomText => string.Format(S.ZoomFormat, (int)(PreviewDisplayScale * 100));

    public double PreviewDisplayScale => PreviewZoom * PreviewFitScale;

    /// <summary>当前标签页的格式（<c>null</c> / 未知 id 时取注册表回退格式）。</summary>
    public IDocumentFormat CurrentFormat => _formats.Get(CurrentTab?.FormatId);

    /// <summary>当前格式的语法高亮定义；切换标签页时界面重新绑定。</summary>
    public IHighlightingDefinition? CurrentHighlighting => CurrentFormat.Highlighting;

    /// <summary>当前格式可选布局的本地化列表；空列表时界面不显示布局选择器。</summary>
    public IReadOnlyList<LayoutChoice> CurrentLayoutChoices => CurrentFormat.LayoutOptions
        .Select(option => new LayoutChoice(option.Id, FormatDisplayName(option.DisplayNameKey)))
        .ToList();

    public bool HasLayoutOptions => CurrentLayoutChoices.Count > 0;

    /// <summary>当前格式是否有文本面（编辑器）。</summary>
    public bool IsTextSurface => CurrentFormat.Surface is DocumentSurfaceKind.TextWithPreview
        or DocumentSurfaceKind.TextWithEmbeddedApp
        or DocumentSurfaceKind.TextOnly;

    /// <summary>编辑器区是否可见（用户开关 × 当前格式是否有文本面）。</summary>
    public bool IsEditorSurfaceVisible => IsEditorVisible && IsTextSurface;

    /// <summary>文本预览区是否可见。</summary>
    public bool IsPreviewSurfaceVisible => CurrentFormat.Surface is DocumentSurfaceKind.TextWithPreview
        or DocumentSurfaceKind.TextWithEmbeddedApp;

    /// <summary>内嵌图形编辑器（drawio 画布）是否可见。</summary>
    public bool IsEmbeddedAppVisible => CurrentFormat.Surface is DocumentSurfaceKind.EmbeddedApp
        or DocumentSurfaceKind.TextWithEmbeddedApp;

    /// <summary>当前格式是否提供 AI 助手（drawio 不提供：图形画布不是文本 DSL）。</summary>
    public bool IsAiPanelAvailable => CurrentFormat.SupportsAiAssistant;

    /// <summary>AI 面板是否显示（格式支持 × 用户展开）。</summary>
    public bool IsAiPanelVisible => IsAiPanelAvailable && AiAssistant?.IsExpanded == true;

    /// <summary>AI 折叠条是否显示（格式支持 × 用户收起）。</summary>
    public bool IsAiToggleBarVisible => IsAiPanelAvailable && AiAssistant?.IsExpanded != true;

    /// <summary>当前格式能否转成图形编辑器文档（单向，目前只有 Mermaid 具备该能力）。</summary>
    public bool CanConvertMermaid => CurrentFormat.SupportsGraphImport;

    public string MenuConvertToDrawio => S.MenuConvertToDrawio;

    public string MenuConvertToExcalidraw => S.MenuConvertToExcalidraw;

    public string LayoutLabel => S.LayoutLabel;

    /// <summary>File → New 的格式列表：注册表数据驱动，加格式不需要改界面。</summary>
    public IReadOnlyList<NewTabChoice> NewTabChoices => _formats.All
        .Select(format => new NewTabChoice(format.Id, FormatDisplayName(format.DisplayNameKey)))
        .ToList();

    /// <summary>本地化显示名；取不到译文时回退 key 本身（DOT 的引擎名就是 key）。</summary>
    private static string FormatDisplayName(string key)
    {
        var name = S.Get(key);
        return string.IsNullOrWhiteSpace(name) ? key : name;
    }

    [ObservableProperty]
    private LayoutChoice? _selectedLayoutChoice;

    /// <summary>每个格式各自记住布局选择（同一个格式的不同标签页共享）。</summary>
    private readonly Dictionary<string, string> _layoutByFormat = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>程序性回填选择器时不要触发重新渲染。</summary>
    private bool _suppressLayoutChange;

    partial void OnSelectedLayoutChoiceChanged(LayoutChoice? value)
    {
        if (value == null || _suppressLayoutChange)
        {
            return;
        }

        _layoutByFormat[CurrentFormat.Id] = value.Id;
        RefreshPreview(CurrentTab);
    }

    /// <summary>当前格式生效的布局取值；未选过时取该格式的默认布局。</summary>
    private string? SelectedLayoutId(IDocumentFormat format)
    {
        if (_layoutByFormat.TryGetValue(format.Id, out var id))
        {
            return id;
        }

        return format.LayoutOptions.FirstOrDefault(option => option.IsDefault)?.Id;
    }

    /// <summary>把布局选择器同步到当前格式（切标签页 / 换语言时调用）。</summary>
    private void SyncLayoutChoice()
    {
        var choices = CurrentLayoutChoices;
        var current = SelectedLayoutId(CurrentFormat);

        _suppressLayoutChange = true;
        try
        {
            SelectedLayoutChoice = choices.FirstOrDefault(choice => choice.Id == current)
                ?? choices.FirstOrDefault();
        }
        finally
        {
            _suppressLayoutChange = false;
        }
    }

    private RenderOptions BuildRenderOptions(IDocumentFormat format)
    {
        return new RenderOptions(Layout: SelectedLayoutId(format));
    }

    /// <summary>
    /// 清掉承载面状态：切到内嵌应用格式时用，避免把上一个文本格式的增量脚本推给隐藏的预览页。
    /// </summary>
    private void ClearPreviewSurface()
    {
        CurrentPreviewUrl = string.Empty;
        CurrentPreviewSurfaceKey = string.Empty;
        CurrentUpdateScript = string.Empty;
        CurrentPreviewRevision++;
    }

    /// <summary>
    /// 把当前内容 / 布局写进承载面。**页面只在换格式时重新导航**，其余一律走增量脚本。
    /// </summary>
    private void RefreshPreview(TabItem? tab)
    {
        if (tab == null || !ReferenceEquals(tab, CurrentTab))
        {
            return;
        }

        var format = _formats.Get(tab.FormatId);

        if (format.Surface == DocumentSurfaceKind.EmbeddedApp)
        {
            return;
        }

        var options = BuildRenderOptions(format);
        var surface = _previewSurfaces.GetOrPrepare(format);

        // 页面上总是写入当前内容：这样后续任何一次导航（换格式、换标签页）都能直接显示最新内容，
        // 而已经载入的页面不会被这次写盘影响 —— 它的更新走 CurrentUpdateScript。
        PreviewSurfaceHost.WritePage(surface, format.Renderer.BuildSurfaceHtml(tab.Content, options));

        CurrentPreviewUrl = surface.Url;
        CurrentPreviewSurfaceKey = format.Id;
        CurrentUpdateScript = format.Renderer.BuildUpdateScript(tab.Content, options);
        CurrentPreviewRevision++;
    }

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
        NotifyCurrentFormatChanged();

        if (CurrentTab != null)
        {
            ScheduleValidationAndRender(CurrentTab);
        }
    }

    /// <summary>
    /// 当前标签页换了：格式、高亮、布局选择器与 AI 会话键都要跟着换。
    /// </summary>
    private void NotifyCurrentFormatChanged()
    {
        OnPropertyChanged(nameof(CurrentTab));
        OnPropertyChanged(nameof(CurrentFormat));
        OnPropertyChanged(nameof(CurrentHighlighting));
        OnPropertyChanged(nameof(CurrentLayoutChoices));
        OnPropertyChanged(nameof(HasLayoutOptions));
        OnPropertyChanged(nameof(IsTextSurface));
        OnPropertyChanged(nameof(IsEditorSurfaceVisible));
        OnPropertyChanged(nameof(IsPreviewSurfaceVisible));
        OnPropertyChanged(nameof(IsEmbeddedAppVisible));
        OnPropertyChanged(nameof(IsAiPanelAvailable));
        OnPropertyChanged(nameof(IsAiPanelVisible));
        OnPropertyChanged(nameof(IsAiToggleBarVisible));
        OnPropertyChanged(nameof(CanConvertMermaid));

        SyncLayoutChoice();

        // AI 会话键用 StableId（本地 = 规范化路径，云端 = 服务端 id）；格式 id 决定提示词与代码围栏。
        AiAssistant?.SetCurrentDocument(CurrentTab?.Location?.StableId, CurrentFormat.Id);
    }

    partial void OnIsEditorVisibleChanged(bool value)
    {
        OnPropertyChanged(nameof(EditorPanelWidth));
        OnPropertyChanged(nameof(IsEditorSurfaceVisible));
    }

    public MainViewModel(MermaidService mermaidService, DocumentFormatRegistry formats, FileService fileService, SettingsService settingsService, AuthService authService, RemoteDocumentStore documentStore, IUpdateService updateService, IStorageProvider storageProvider, Window ownerWindow)
    {
        _mermaidService = mermaidService;
        _formats = formats;
        _fileService = fileService;
        _settingsService = settingsService;
        _authService = authService;
        _documentStore = documentStore;
        _updateService = updateService;
        _storageProvider = storageProvider;
        _ownerWindow = ownerWindow;
        _fileService.SetStorageProvider(storageProvider);

        _conversationService = new AIConversationService(settingsService.Settings.ConversationStoragePath);

        EditorPreviewRatio = settingsService.Settings.EditorPreviewRatio;
        PreviewZoom = settingsService.Settings.PreviewZoom;
        RecentFiles.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasRecentFiles));

        _settingsService.CleanInvalidRecentFiles();
        foreach (var entry in settingsService.Settings.RecentFiles)
        {
            if (entry.ToLocation() is { } location)
            {
                RecentFiles.Add(new RecentFileItem(location));
            }
        }
        if (RecentFiles.Count > 0)
        {
            AppendMoreItem();
        }
        OnPropertyChanged(nameof(HasRecentFiles));

        InitializeAIPanelViewModel();

        AddNewTab();

        _ = CheckForUpdateOnStartupAsync();
        _ = InitializeCloudAsync();
    }

    /// <summary>
    /// 冷启动的云端初始化：先匿名取配置，再用已保存的 refresh token 尝试恢复会话。
    /// </summary>
    /// <remarks>
    /// <b>完全在后台</b>：不等待鉴权结果、不阻塞 UI、不弹窗。
    /// 未登录、离线、令牌失效都是正常结果，本地功能一概不受影响。
    /// </remarks>
    private async Task InitializeCloudAsync()
    {
        try
        {
            await _authService.GetConfigAsync();
            await _authService.TryRestoreSessionAsync();
        }
        catch
        {
            // 网络不可达等：保持未登录态即可
        }
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

        // AI 面板的展开状态由它自己持有，这里只跟着刷新"面板/折叠条谁可见"
        AiAssistant.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(AIPanelViewModel.IsExpanded))
            {
                OnPropertyChanged(nameof(IsAiPanelVisible));
                OnPropertyChanged(nameof(IsAiToggleBarVisible));
            }
        };
    }

    private void OnAICodeGenerated(object? sender, AICodeApplyRequest request)
    {
        var tab = CurrentTab;
        if (tab == null)
        {
            return;
        }

        // 生成后用户可能切到了别的格式的标签页：把 DOT 代码灌进 Mermaid 文档是错的，宁可不应用。
        var format = _formats.Get(tab.FormatId);
        if (request.FormatId != null && !string.Equals(request.FormatId, format.Id, StringComparison.OrdinalIgnoreCase))
        {
            StatusMessage = S.AICodeFormatMismatch;
            return;
        }

        tab.Content = request.Code;
        StatusMessage = S.AICodeApplied;
    }

    /// <summary>
    /// 把当前 Mermaid 图转成一个新的 drawio 标签页（方案 Phase 4）。
    /// </summary>
    /// <remarks>
    /// **单向**：drawio 只提供 mermaid → 图形这一个方向，画布上的改动不会回写 Mermaid 源码，
    /// 因此原标签页保持打开、转换结果另开新标签页，界面文案也明说"不可逆"。
    /// 真正的载入动作由承载层在显示新标签页时执行（<see cref="TryTakeMermaidImport"/>）。
    /// </remarks>
    [RelayCommand]
    private void ConvertMermaidToDrawio() => ConvertMermaidTo(DrawioFormat.FormatId);

    /// <summary>把当前 Mermaid 图转成一个新的 Excalidraw 标签页（方案 Phase 6）。</summary>
    [RelayCommand]
    private void ConvertMermaidToExcalidraw() => ConvertMermaidTo(ExcalidrawFormat.FormatId);

    private void ConvertMermaidTo(string targetFormatId)
    {
        var source = CurrentTab;
        if (source == null || !CurrentFormat.SupportsGraphImport)
        {
            return;
        }

        var target = _formats.Get(targetFormatId);
        var tab = new TabItem
        {
            FormatId = target.Id,
            Header = FormatDisplayName(target.DefaultFileNameKey),
            Content = target.CreateDefaultContent(),
        };
        tab.ContentChanged += OnTabContentChanged;

        // 先登记转换请求再选中新标签页：承载层在显示它的那一刻需要读到这份源码
        _pendingMermaidImport = (tab, source.Content);

        Tabs.Add(tab);
        SelectTab(Tabs.Count - 1, forceNotify: true);

        StatusMessage = S.ConvertToDrawioDone;
    }

    /// <summary>承载层在显示图形编辑器标签页时取走一次性的 Mermaid 导入请求。</summary>
    public bool TryTakeMermaidImport(TabItem tab, out string source)
    {
        if (_pendingMermaidImport is { } pending && ReferenceEquals(pending.Tab, tab))
        {
            source = pending.Source;
            _pendingMermaidImport = null;
            return true;
        }

        source = string.Empty;
        return false;
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

    /// <summary>窗口关闭：释放承载面宿主持有的 loopback 端口。</summary>
    public void Shutdown()
    {
        _previewSurfaces.Dispose();
    }

    [RelayCommand]
    private void AddNewTab()
    {
        AddNewTab(_formats.Fallback);
    }

    /// <summary>按格式 id 新建标签页（File → New 的子项）。</summary>
    [RelayCommand]
    private void AddNewTabOfFormat(string? formatId)
    {
        AddNewTab(_formats.Get(formatId));
    }

    private void AddNewTab(IDocumentFormat format)
    {
        var tab = new TabItem
        {
            FormatId = format.Id,
            Header = FormatDisplayName(format.DefaultFileNameKey),
            Content = format.CreateDefaultContent()
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

            NotifyCurrentFormatChanged();

            if (CurrentTab != null)
            {
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

        var format = _formats.Get(tab.FormatId);

        // 内嵌图形编辑器（drawio）不进文本预览管线：画布由 DrawioDocumentHost 自己驱动，
        // 这里若继续跑 Mermaid 校验会把它当成坏语法反复报错（方案 §4.6 的循环复现点）。
        if (format.Surface == DocumentSurfaceKind.EmbeddedApp)
        {
            CancelActiveRender();
            ClearPreviewSurface();

            // 状态栏文案归承载层（MainWindow.SyncEmbeddedAppSurface）：它才知道画布资源是否就绪。
            // 这里若写"就绪"，会在 350ms 防抖后把"缺少运行时资源"这类指引覆盖掉。
            return;
        }

        if (string.IsNullOrWhiteSpace(tab.Content))
        {
            CancelActiveRender();
            RefreshPreview(tab);
            tab.HasError = false;
            tab.ErrorMessage = null;
            StatusMessage = S.Ready;
            return;
        }

        // 页面内渲染的格式（DOT）：语法错误由渲染器在页面里显示，C# 侧不做子进程校验。
        if (!format.UsesMermaidCliExport)
        {
            RefreshPreview(tab);
            tab.HasError = false;
            tab.ErrorMessage = null;
            StatusMessage = S.PreviewUpdated;
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
            RefreshPreview(tab);
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
            RefreshPreview(tab);
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

        var format = _formats.Get(tab.FormatId);

        if (format.Surface == DocumentSurfaceKind.EmbeddedApp)
        {
            var embeddedScale = GetInPageExportScale();

            if (tab.CachedPngBytes != null && Math.Abs(tab.CachedPngScale - embeddedScale) < 0.001)
            {
                return tab.CachedPngBytes;
            }

            var embeddedBytes = await RenderEmbeddedImageAsync(tab, embeddedScale);
            if (embeddedBytes == null)
            {
                return null;
            }

            tab.CachedPngBytes = embeddedBytes;
            tab.CachedPngScale = embeddedScale;
            return embeddedBytes;
        }

        var scale = format.UsesMermaidCliExport
            ? GetExportScale(CountDiagramElements(tab.Content))
            : GetInPageExportScale();

        if (tab.CachedPngBytes != null && Math.Abs(tab.CachedPngScale - scale) < 0.001)
        {
            return tab.CachedPngBytes;
        }

        if (!format.UsesMermaidCliExport)
        {
            var bytes = await RenderInPageImageAsync(tab, format, scale);
            if (bytes == null)
            {
                return null;
            }

            tab.CachedPngBytes = bytes;
            tab.CachedPngScale = scale;
            return bytes;
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

    /// <summary>
    /// 页面内导出的倍率：固定档用设置值，自动档取 3.0。
    /// </summary>
    /// <remarks>
    /// 自动档那套"按元素数自适应 1.5x~5.0x"的启发式是为 <c>mmdc</c> 位图导出定的
    /// （见 <see cref="CalculateScale"/>），对在页面内栅格化的矢量渲染器没有依据，
    /// 因此不套用 —— 倍率只影响输出位图分辨率，矢量源头始终是渲染器的 SVG。
    /// </remarks>
    private double GetInPageExportScale()
    {
        var settings = _settingsService.Settings;
        return settings.UseFixedExportScale
            ? Math.Clamp(settings.FixedExportScale, AppSettings.MinExportScale, AppSettings.MaxExportScale)
            : 3.0;
    }

    /// <summary>
    /// 让内嵌图形编辑器在画布内导出位图（drawio：页面内渲染，**零子进程**）。
    /// </summary>
    private async Task<byte[]?> RenderEmbeddedImageAsync(TabItem tab, double scale)
    {
        if (_ownerWindow is not MainWindow window)
        {
            StatusMessage = string.Format(S.ErrorFormat, S.UnknownError);
            return null;
        }

        var result = await window.ExportEmbeddedImageAsync("png", scale, transparent: true);
        if (!result.Success || result.Data == null)
        {
            var shortError = BuildUserFriendlyError(result.Error);
            tab.HasError = true;
            tab.ErrorMessage = shortError;
            StatusMessage = string.Format(S.RenderErrorFormat, shortError);
            return null;
        }

        tab.HasError = false;
        tab.ErrorMessage = null;
        return result.Data;
    }

    /// <summary>
    /// 在预览页内栅格化当前内容（DOT：SVG → canvas → PNG，**零子进程**）。
    /// </summary>
    private async Task<byte[]?> RenderInPageImageAsync(TabItem tab, IDocumentFormat format, double scale)
    {
        var options = new RenderOptions(Scale: scale, Layout: SelectedLayoutId(format));
        var script = format.Renderer.BuildExportScript(tab.Content, options);

        if (script == null)
        {
            StatusMessage = string.Format(S.ErrorFormat, S.UnknownError);
            return null;
        }

        if (_ownerWindow is not MainWindow window)
        {
            StatusMessage = string.Format(S.ErrorFormat, S.UnknownError);
            return null;
        }

        var result = await window.RenderInPageImageAsync(script, format.Id);
        if (!result.Success || result.Data == null)
        {
            var shortError = BuildUserFriendlyError(result.Error);
            tab.HasError = true;
            tab.ErrorMessage = shortError;
            StatusMessage = string.Format(S.RenderErrorFormat, shortError);
            return null;
        }

        tab.HasError = false;
        tab.ErrorMessage = null;
        return result.Data;
    }

    private void ScheduleBackgroundImageGeneration(TabItem tab)
    {
        if (!ReferenceEquals(tab, CurrentTab))
            return;

        // 只有走 mmdc 的格式需要预生成缓存；页面内导出的格式按需渲染即可（零子进程）。
        if (!_formats.Get(tab.FormatId).UsesMermaidCliExport)
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

    /// <summary>保存标签页（内嵌图形编辑器触发保存时也走这里）。</summary>
    public async Task<bool> SaveTabAsync(TabItem tab)
    {
        var filePath = tab.LocalFilePath;
        bool isNewFile = string.IsNullOrEmpty(filePath);

        if (isNewFile)
        {
            filePath = await _fileService.SaveFileAsync(tab.Content, tab.Header);
            if (filePath == null)
            {
                return false;
            }

            tab.Location = new LocalDocumentLocation(filePath);
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
                FormatId = _formats.Resolve(filePath).Id,
                Content = content,
                Location = string.IsNullOrEmpty(filePath) ? null : new LocalDocumentLocation(filePath)
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
                FormatId = _formats.Resolve(filePath).Id,
                Content = content,
                Location = string.IsNullOrEmpty(filePath) ? null : new LocalDocumentLocation(filePath)
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

        // 云端条目尚未落地（阶段 A4）。当前 RecentEntry.ToLocation() 只产出本地位置，
        // 因此这一分支暂时不可达；保留是为了 A4 接入时不遗漏。
        if (item.Location is not LocalDocumentLocation local)
        {
            return;
        }

        var filePath = local.FilePath;
        if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
        {
            RemoveFromRecentFiles(filePath);
            StatusMessage = S.FileNotFound;
            return;
        }

        var existingTab = Tabs.FirstOrDefault(t => t.Location?.StableId == local.StableId);
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

        var location = new LocalDocumentLocation(filePath);

        var existing = RecentFiles.FirstOrDefault(r => r.Location?.StableId == location.StableId);
        if (existing != null)
        {
            RecentFiles.Remove(existing);
        }

        RecentFiles.Insert(0, new RecentFileItem(location));

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

        var stableId = DocumentIdentity.Normalize(filePath) ?? filePath;

        var item = RecentFiles.FirstOrDefault(r => r.Location?.StableId == stableId);
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

        CurrentTab.Location = new LocalDocumentLocation(filePath);
        CurrentTab.IsModified = false;
        CurrentTab.UpdateHeader();
        AddToRecentFiles(filePath);
        StatusMessage = S.Saved;
    }

    private bool TrySelectExistingTabByPath(string? filePath)
    {
        // 两边都规范化后比较，等价于原实现（GetFullPath + OrdinalIgnoreCase）。
        // 规范化失败说明不是可用路径 —— 直接判定"无已打开标签"，不再做原串兜底比较。
        var stableId = DocumentIdentity.Normalize(filePath);
        if (stableId == null)
        {
            return false;
        }

        var existingTab = Tabs.FirstOrDefault(tab => tab.Location?.StableId == stableId);

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

    /// <summary>用户主动打开登录框。启动路径不调用它。</summary>
    [RelayCommand]
    private async Task ShowLogin()
    {
        var dialog = new LoginDialog(_authService);
        await dialog.ShowDialog(_ownerWindow);
        OnPropertyChanged(nameof(AccountDisplayName));
    }

    [RelayCommand]
    private async Task SignOut()
    {
        await _authService.LogoutAsync();
        OnPropertyChanged(nameof(AccountDisplayName));
    }

    /// <summary>
    /// 保存当前标签页到云端：已是云端文档则就地更新（带乐观锁），否则新建。
    /// </summary>
    /// <remarks>
    /// 契约 1 规定文档 id 由客户端生成（UUIDv7），因此新建时不需要先问服务端要 id。
    /// </remarks>
    [RelayCommand]
    private async Task SaveToCloud()
    {
        var tab = CurrentTab;
        if (tab == null) return;

        var content = tab.Content;

        var cloud = tab.Location as CloudDocumentLocation;
        var (id, suggestedName, version) = cloud != null
            ? (Guid.Parse(cloud.StableId), cloud.DisplayName, tab.CloudVersion)
            : (Guid.CreateVersion7(), tab.Header, (int?)null);

        // 目标路径默认是文档当前所在位置（新文档 = 根），文档名默认是当前云端名（新文档 = 标签页名）；
        // 两者都可以改，取消选择即中止本次保存。
        var target = await CloudPathPickerDialog.PickAsync(
            _ownerWindow, _documentStore, S.CloudPathSaveTitle, S.CloudPathSaveLabel, cloud?.Path, suggestedName);
        if (target == null) return;

        // 改名不需要额外请求：PUT 的 name 就是服务端的改名入口（同一目录内重名 → 409 name_taken）
        var result = await _documentStore.PutAsync(
            id, target.Name, _formats.Get(tab.FormatId).CloudFormatIds[0], content, version, path: target.Path, vaultId: cloud?.VaultId);

        if (!result.Ok)
        {
            // 「写入过程中断流 / 杀进程后重试」：服务端在 409 里回带当前 contentHash。
            // 与本地内容一致 → 上次写入其实已生效，按成功处理，不给用户看假冲突。
            if (result.ErrorCode == RemoteDocumentStore.ErrorVersionConflict
                && TryReadConflict(result.Details, out var serverHash, out var serverVersion)
                && serverHash == RemoteDocumentStore.Sha256Hex(content))
            {
                ApplyCloudSaved(tab, id, target.Name, serverVersion, target.Path, cloud?.VaultId);
                return;
            }

            StatusMessage = string.Format(S.CloudStatusErrorFormat, DescribeCloudError(result.ErrorCode));
            return;
        }

        ApplyCloudSaved(tab, id, target.Name, result.Value!.Version, target.Path, cloud?.VaultId);
    }

    /// <summary>从云端打开（先列表后按 id 取值 —— 契约规定列表不含 content）。</summary>
    [RelayCommand]
    private async Task OpenFromCloud()
    {
        var picked = await CloudDocumentsDialog.PickAsync(_ownerWindow, _documentStore);
        if (picked == null || !Guid.TryParse(picked.Id, out var id)) return;

        var result = await _documentStore.GetAsync(id);
        if (!result.Ok || result.Value == null)
        {
            StatusMessage = string.Format(S.CloudStatusErrorFormat, DescribeCloudError(result.ErrorCode));
            return;
        }

        var doc = result.Value;

        // v1 只处理内联文本；外置（blob 直传）分支不在本阶段范围内
        if (doc.Content == null)
        {
            StatusMessage = string.Format(S.CloudStatusErrorFormat, S.AuthErrorGeneric);
            return;
        }

        var tab = new TabItem
        {
            FormatId = _formats.ResolveCloudFormat(doc.Format).Id,
            Content = doc.Content,
            Location = new CloudDocumentLocation(doc.Id, doc.Name, doc.Path, doc.VaultId),
            CloudVersion = doc.Version,
        };
        tab.ContentChanged += OnTabContentChanged;
        tab.UpdateHeader();
        Tabs.Add(tab);
        SelectedTabIndex = Tabs.Count - 1;
    }

    private void ApplyCloudSaved(TabItem tab, Guid id, string name, int version, string path, string? vaultId)
    {
        tab.Location = new CloudDocumentLocation(id.ToString(), name, path, vaultId);
        tab.CloudVersion = version;
        tab.IsModified = false;
        tab.UpdateHeader();
        StatusMessage = string.Format(S.CloudStatusSavedFormat, version);
    }

    /// <summary>从 409 的 details 里读出服务端当前 hash 与版本。</summary>
    private static bool TryReadConflict(JsonElement? details, out string? contentHash, out int version)
    {
        contentHash = null;
        version = 0;

        if (details is not { ValueKind: JsonValueKind.Object } element)
        {
            return false;
        }

        if (element.TryGetProperty("contentHash", out var hash) && hash.ValueKind == JsonValueKind.String)
        {
            contentHash = hash.GetString();
        }

        if (element.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number)
        {
            version = v.GetInt32();
        }

        return contentHash != null;
    }

    private static string DescribeCloudError(string? code) => CloudErrorText.Describe(code);

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
            "Diagramon",
            S.AboutDescription,
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

    public void SetInitialContent()
    {
        if (CurrentTab != null)
        {
            CurrentTab.Content = CurrentFormat.CreateDefaultContent();
            CurrentTab.IsModified = false;
            CurrentTab.UpdateHeader();
        }
    }
}
