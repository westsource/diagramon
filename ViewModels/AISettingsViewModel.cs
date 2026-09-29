using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia.Data.Converters;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Diagramon.Models;
using Diagramon.Services;
using Diagramon.Services.Localization;
using Diagramon.Views;

namespace Diagramon.ViewModels;

public partial class AISettingsViewModel : ViewModelBase
{
    private static readonly Strings S = Strings.Instance;
    private readonly SettingsService _settingsService;
    private readonly IStorageProvider? _storageProvider;
    private readonly Action? _onSaved;
    private readonly AuthService? _authService;

    [ObservableProperty]
    private ObservableCollection<AIModelConfig> _modelConfigs = new();

    [ObservableProperty]
    private bool _isEditing;

    [ObservableProperty]
    private string _editPanelTitle = string.Empty;

    [ObservableProperty]
    private string _editingName = string.Empty;

    [ObservableProperty]
    private AIProvider _editingProvider = AIProvider.Custom;

    [ObservableProperty]
    private string _editingApiKey = string.Empty;

    [ObservableProperty]
    private string _editingBaseUrl = string.Empty;

    [ObservableProperty]
    private string _editingEndpoint = string.Empty;

    [ObservableProperty]
    private string _editingDeploymentName = string.Empty;

    [ObservableProperty]
    private string _editingModelId = string.Empty;

    [ObservableProperty]
    private int _editingMaxTokens = 4096;

    [ObservableProperty]
    private double _editingTemperature = 0.7;

    [ObservableProperty]
    private string _conversationStoragePath = string.Empty;

    [ObservableProperty]
    private string? _editingModelIdOriginal;

    public ObservableCollection<AIProvider> ProviderTypes { get; } = new(Enum.GetValues<AIProvider>());

    /// <summary>「Diagramon 云」可选的模型别名（来自 <c>/v1/config</c> 的 <c>aiAliases</c>）。</summary>
    public ObservableCollection<AiAliasDto> AliasChoices { get; } = new();

    [ObservableProperty]
    private AiAliasDto? _selectedAlias;

    partial void OnSelectedAliasChanged(AiAliasDto? value)
    {
        // 下拉是唯一入口：选中即写回 ModelId（持久化字段仍是一个字符串别名）
        if (value is not null)
        {
            EditingModelId = value.Id;
        }
    }

    /// <summary>
    /// 是否是「Diagramon 云」条目。
    /// </summary>
    /// <remarks>
    /// 该条目**不需要** Key 与 BaseUrl：地址固定为服务端地址，凭据是当前 access token（不落盘）。
    /// 把它显示成"填 Key 的 provider"会诱导用户把自己的令牌粘进去 —— 那正是 C1 要避免的落盘路径。
    /// </remarks>
    public bool IsCloudConfig => EditingProvider == AIProvider.DiagramonCloud;

    /// <summary>
    /// 「渲染报错时自动修正一次」（V2-8，D34）。
    /// </summary>
    /// <remarks>
    /// 这是本方案里唯一会**静默产生第二次计费**的功能，所以开关必须显眼、说明必须写明这一点 ——
    /// 用户看到账单上两笔扣费时，得能立刻找到并关掉它。
    /// </remarks>
    [ObservableProperty]
    private bool _renderFeedbackRetry = true;

    public string AIRenderFeedbackToggle => S.AIRenderFeedbackToggle;
    public string AIServiceUrlLabel => S.AIServiceUrlLabel;
    public string AIServiceUrlHint => S.AIServiceUrlHint;
    public string AITestConnection => S.AITestConnection;

    /// <summary>
    /// 云端服务地址（可改）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 此前只能手改 <c>settings.json</c>（默认 <c>http://127.0.0.1:8000</c>），联调换服务器要改文件、重启 —— 
    /// 所以给它一个输入框。<b>默认值刻意保持本机地址</b>：仓库里不写任何具体部署地址，
    /// 测试环境的域名由使用者在界面上填（或已存在 settings.json 里）。
    /// </para>
    /// <para>
    /// 改地址后**必须重新登录**：令牌是按服务器签发的，旧令牌在新服务器上无效
    /// （客户端会走静默刷新 → 失败 → 回到未登录态，不会崩，但用户要知道为什么）。
    /// </para>
    /// </remarks>
    [ObservableProperty]
    private string _serviceBaseUrl = string.Empty;

    /// <summary>测试连接的结果（成功/失败文案）。</summary>
    [ObservableProperty]
    private string _connectionStatus = string.Empty;

    [ObservableProperty]
    private bool _isTestingConnection;

    /// <summary>
    /// 探测 <c>GET /v1/config</c>（**匿名可调**）—— 与客户端冷启动走的第一个请求同一条路。
    /// </summary>
    [RelayCommand]
    private async Task TestConnection()
    {
        var url = NormalizeServiceUrl(ServiceBaseUrl);
        if (url is null)
        {
            ConnectionStatus = S.AITestInvalidUrl;
            return;
        }

        IsTestingConnection = true;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var response = await http.GetAsync(url + "/v1/config");

            if (!response.IsSuccessStatusCode)
            {
                ConnectionStatus = string.Format(S.AITestFailFormat, $"HTTP {(int)response.StatusCode}");
                return;
            }

            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var minVersion = document.RootElement.TryGetProperty("minVersion", out var value)
                ? value.GetString()
                : null;

            ConnectionStatus = string.Format(S.AITestOk, minVersion ?? "-");
        }
        catch (Exception ex)
        {
            ConnectionStatus = string.Format(S.AITestFailFormat, ex.Message);
        }
        finally
        {
            IsTestingConnection = false;
        }
    }

    /// <summary>
    /// 规范化服务地址：去掉尾部斜杠；非法（非 http/https、空）返回 <c>null</c>。
    /// </summary>
    /// <remarks>
    /// 空值**合法**（= 用 <c>SettingsService</c> 的默认本机地址），由调用方区分"空"与"非法"。
    /// </remarks>
    private static string? NormalizeServiceUrl(string? raw)
    {
        var trimmed = (raw ?? string.Empty).Trim().TrimEnd('/');
        if (trimmed.Length == 0)
        {
            return null;
        }

        return trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? trimmed
                : null;
    }
    public string AIRenderFeedbackHint => S.AIRenderFeedbackHint;

    public bool IsApiKeyRequired => EditingProvider is not (AIProvider.Ollama or AIProvider.DiagramonCloud);

    /// <summary>
    /// 是否需要填 Base URL。
    /// </summary>
    /// <remarks>
    /// **OpenAI 也要显示**：该 provider 走的就是 OpenAI 兼容协议，<c>OpenAIService</c> 在没有
    /// BaseUrl 时才回退到官方端点 <c>https://api.openai.com/v1</c>，因此指向 DeepSeek / 通义 /
    /// 自建网关等兼容端点时必须能改。只把 Azure 排除在外 —— 它用的是 Endpoint + Deployment Name。
    /// </remarks>
    public bool IsBaseUrlRequired => EditingProvider is not (AIProvider.AzureOpenAI or AIProvider.DiagramonCloud);

    /// <summary>
    /// Base URL 的占位提示。OpenAI 档必须说明"留空 = 官方端点"，
    /// 否则用户不知道空值代表什么（这正是把 DeepSeek 配成 OpenAI 档却打不通的常见原因）。
    /// </summary>
    public string BaseUrlWatermark => EditingProvider == AIProvider.OpenAI
        ? S.AIBaseUrlOfficialHint
        : "https://api.example.com/v1";

    public bool IsAzureConfig => EditingProvider == AIProvider.AzureOpenAI;

    public string AISettingsTitle => S.AISettingsTitle;
    public string AIModelConfig => S.AIModelConfig;
    public string AIConfiguredModels => S.AIConfiguredModels;
    public string AIAddModel => S.AIAddModel;
    public string AIEditModel => S.AIEditModel;
    public string AIDeleteModel => S.AIDeleteModel;
    public string AIModelName => S.AIModelName;
    public string AIServiceType => S.AIServiceType;
    public string AIModelId => S.AIModelId;
    public string AIAliasLabel => S.AIAliasLabel;
    public string AICloudHint => S.AICloudHint;
    public string AIAdvancedOptions => S.AIAdvancedOptions;
    public string AIConversationStorage => S.AIConversationStorage;
    public string AIBrowse => S.AIBrowse;
    public string AIClose => S.AIClose;
    public string AIEndpoint => S.AIEndpoint;
    public string AIDeploymentName => S.AIDeploymentName;
    public string SaveButton => S.SaveButton;
    public string CancelButton => S.CancelButton;

    public AISettingsViewModel() : this(new SettingsService(), null, null, null)
    {
    }

    public AISettingsViewModel(
        SettingsService settingsService,
        IStorageProvider? storageProvider,
        Action? onSaved,
        AuthService? authService = null)
    {
        _settingsService = settingsService;
        _storageProvider = storageProvider;
        _onSaved = onSaved;
        _authService = authService;

        LoadAliasChoices();
        RenderFeedbackRetry = _settingsService.Settings.AiRenderFeedbackRetry;
        ServiceBaseUrl = _settingsService.Settings.ServiceBaseUrl;
        LoadSettings();
    }

    /// <summary>
    /// 填「Diagramon 云」的别名候选。
    /// </summary>
    /// <remarks>
    /// 取自 <c>GET /v1/config</c> 的 <c>aiAliases</c>（**全量目录**，匿名可读）——
    /// 客户端靠它把"模型"变成可选项，而不是让人手打别名。
    /// 「这个账号到底能用哪些」由带令牌的 <c>GET /v1/ai/models</c> 回答；不在本档的别名会在调用时
    /// 得到 403「当前套餐不含该模型，升级后可用」（文案见 <c>AiErrorText</c>）。
    /// </remarks>
    private void LoadAliasChoices()
    {
        AliasChoices.Clear();
        foreach (var alias in _authService?.Config?.AiAliases ?? new List<AiAliasDto>())
        {
            AliasChoices.Add(alias);
        }
    }

    private void LoadSettings()
    {
        ModelConfigs.Clear();
        foreach (var config in _settingsService.Settings.ModelConfigs)
        {
            ModelConfigs.Add(config.Clone());
        }

        ConversationStoragePath = _settingsService.Settings.ConversationStoragePath ?? string.Empty;
    }

    /// <summary>存储路径输入框的占位提示：显示**真实的**默认目录（不把路径写死在译文里）。</summary>
    public string ConversationStorageWatermark =>
        string.Format(S.AIConversationStorageWatermarkFormat, AIConversationService.DefaultStoragePath);

    // 编辑面板里这几个字段标签原是 XAML 里的英文硬编码，现在走与其它标签同一条链路
    public string AIApiKeyLabel => S.AIApiKeyLabel;
    public string AIBaseUrlLabel => S.AIBaseUrlLabel;
    public string AIMaxTokensLabel => S.AIMaxTokensLabel;
    public string AITemperatureLabel => S.AITemperatureLabel;

    partial void OnEditingProviderChanged(AIProvider value)
    {
        OnPropertyChanged(nameof(IsApiKeyRequired));
        OnPropertyChanged(nameof(IsBaseUrlRequired));
        OnPropertyChanged(nameof(IsAzureConfig));
        OnPropertyChanged(nameof(BaseUrlWatermark));

        if (value == AIProvider.Ollama && string.IsNullOrEmpty(EditingBaseUrl))
        {
            EditingBaseUrl = "http://localhost:11434";
        }
    }

    [RelayCommand]
    private void AddModel()
    {
        EditPanelTitle = S.AIAddModel;
        EditingModelIdOriginal = null;
        EditingName = "新模型";
        EditingProvider = AIProvider.Custom;
        EditingApiKey = string.Empty;
        EditingBaseUrl = string.Empty;
        EditingEndpoint = string.Empty;
        EditingDeploymentName = string.Empty;
        EditingModelId = "gpt-4o";
        EditingMaxTokens = 4096;
        EditingTemperature = 0.7;
        IsEditing = true;
    }

    [RelayCommand]
    private void EditModel(AIModelConfig? config)
    {
        if (config == null) return;

        EditPanelTitle = S.AIEditModel;
        EditingModelIdOriginal = config.Id;
        EditingName = config.Name;
        EditingProvider = config.Provider;
        EditingApiKey = config.ApiKey ?? string.Empty;
        EditingBaseUrl = config.BaseUrl ?? string.Empty;
        EditingEndpoint = config.Endpoint ?? string.Empty;
        EditingDeploymentName = config.DeploymentName ?? string.Empty;
        EditingModelId = config.ModelId;
        EditingMaxTokens = config.MaxTokens;
        EditingTemperature = config.Temperature;
        IsEditing = true;
    }

    [RelayCommand]
    private void DeleteModel(AIModelConfig? config)
    {
        if (config == null) return;

        ModelConfigs.Remove(config);
    }

    [RelayCommand]
    private void CancelEdit()
    {
        IsEditing = false;
    }

    [RelayCommand]
    private void SaveModel()
    {
        var cleanBaseUrl = CleanBaseUrl(EditingBaseUrl, EditingProvider);

        var config = new AIModelConfig
        {
            Id = EditingModelIdOriginal ?? Guid.NewGuid().ToString(),
            Name = string.IsNullOrWhiteSpace(EditingName) ? EditingModelId : EditingName,
            Provider = EditingProvider,
            ApiKey = EditingApiKey,
            BaseUrl = cleanBaseUrl,
            Endpoint = EditingEndpoint,
            DeploymentName = EditingDeploymentName,
            ModelId = EditingModelId,
            MaxTokens = EditingMaxTokens,
            Temperature = EditingTemperature,
            IsEnabled = true
        };

        if (string.IsNullOrEmpty(EditingModelIdOriginal))
        {
            ModelConfigs.Add(config);
        }
        else
        {
            var existing = ModelConfigs.FirstOrDefault(c => c.Id == EditingModelIdOriginal);
            if (existing != null)
            {
                var index = ModelConfigs.IndexOf(existing);
                ModelConfigs[index] = config;
            }
        }

        IsEditing = false;
    }

    [RelayCommand]
    private async Task BrowseStoragePath()
    {
        if (_storageProvider == null) return;

        var folders = await _storageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions
        {
            Title = "选择对话历史存储目录"
        });

        if (folders.Count > 0)
        {
            ConversationStoragePath = folders[0].Path.LocalPath;
        }
    }

    [RelayCommand]
    private void Save()
    {
        _settingsService.Settings.ModelConfigs = ModelConfigs.ToList();
        _settingsService.Settings.ConversationStoragePath = ConversationStoragePath;
        _settingsService.Settings.AiRenderFeedbackRetry = RenderFeedbackRetry;

        // 空 = 保持默认（本机）；非空才写回。非法地址在测试连接时已提示，这里不静默改写。
        if (NormalizeServiceUrl(ServiceBaseUrl) is { } url)
        {
            _settingsService.Settings.ServiceBaseUrl = url;
        }

        foreach (var config in ModelConfigs)
        {
            _settingsService.SaveModelApiKey(config.Id, config.ApiKey);
        }

        _settingsService.Save();

        _onSaved?.Invoke();

        CloseDialog();
    }

    [RelayCommand]
    private void Close()
    {
        Save();
    }

    private void CloseDialog()
    {
        if (Avalonia.Application.Current?.ApplicationLifetime is Avalonia.Controls.ApplicationLifetimes.IClassicDesktopStyleApplicationLifetime lifetime)
        {
            if (lifetime.Windows.FirstOrDefault(w => w is AISettingsDialog) is AISettingsDialog dialog)
            {
                dialog.Close(true);
            }
        }
    }

    private static string CleanBaseUrl(string? url, AIProvider provider)
    {
        if (string.IsNullOrWhiteSpace(url))
            return string.Empty;

        var trimmed = url.Trim().TrimEnd('/');

        if (provider is AIProvider.Custom or AIProvider.OpenAI)
        {
            var suffixes = new[] { "/chat/completions", "/v1/chat/completions" };
            foreach (var suffix in suffixes)
            {
                if (trimmed.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                {
                    trimmed = trimmed[..^suffix.Length];
                    break;
                }
            }
        }
        else if (provider == AIProvider.Ollama)
        {
            if (trimmed.EndsWith("/api/chat", StringComparison.OrdinalIgnoreCase))
            {
                trimmed = trimmed[..^"/api/chat".Length];
            }
        }

        return trimmed;
    }

    public static readonly IValueConverter ProviderDisplayNameConverter = new FuncValueConverter<AIProvider, string>(
        provider => provider switch
        {
            AIProvider.OpenAI => "OpenAI",
            AIProvider.AzureOpenAI => "Azure OpenAI",
            AIProvider.Ollama => "Ollama (本地)",
            AIProvider.Custom => "自定义",
            _ => provider.ToString()
        }
    );
}
