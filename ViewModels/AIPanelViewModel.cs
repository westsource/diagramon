using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Media.Imaging;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Diagramon.Models;
using Diagramon.Services;
using Diagramon.Services.AIService;
using Diagramon.Services.Documents;
using Diagramon.Services.Documents.Formats;
using Diagramon.Services.Localization;

namespace Diagramon.ViewModels;

public partial class AIPanelViewModel : ViewModelBase
{
    private static readonly Strings S = Strings.Instance;
    private readonly SettingsService _settingsService;
    private readonly AIConversationService _conversationService;
    private readonly AuthService _authService;
    private readonly IStorageProvider? _storageProvider;
    private readonly DocumentFormatRegistry? _formats;

    /// <summary>
    /// 没有注册表时的兜底格式。
    /// </summary>
    /// <remarks>
    /// 面板允许在无注册表的场合被构造（设计期数据、单元测试），此时按 Mermaid 处理 ——
    /// 与 <c>DocumentFormatRegistry.Fallback</c> 的既有语义一致（未知格式一律当 Mermaid）。
    /// </remarks>
    private static readonly IDocumentFormat _fallbackFormat = new MermaidFormat();
    private IAIService? _aiService;
    private string? _currentStableId;
    private string _currentFormatId = DocumentFormatRegistry.FallbackFormatId;

    /// <summary>待发送的图片（已由 <see cref="ImagePreprocessor"/> 压到服务端上限内）。</summary>
    private byte[]? _pendingImageBytes;
    private string _pendingImageMediaType = "image/png";

    [ObservableProperty]
    private ObservableCollection<AIMessage> _messages = new();

    [ObservableProperty]
    private string _inputText = string.Empty;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private bool _isExpanded;

    [ObservableProperty]
    private double _panelHeight = 200;

    [ObservableProperty]
    private string _statusMessage = Strings.Instance.AIReady;

    [ObservableProperty]
    private bool _isConfigured;

    [ObservableProperty]
    private ObservableCollection<AIModelConfig> _availableModels = new();

    [ObservableProperty]
    private AIModelConfig? _selectedModel;

    /// <summary>待发送图片的缩略图（同时也是"有没有待发图片"的唯一判据）。</summary>
    [ObservableProperty]
    private Bitmap? _pendingImagePreview;

    partial void OnPendingImagePreviewChanged(Bitmap? value)
    {
        OnPropertyChanged(nameof(HasPendingImage));
    }

    public bool HasPendingImage => PendingImagePreview != null;

    /// <summary>
    /// 当前**账号**能不能识图 —— 与"下拉里选的是哪一档"无关。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 判据是"本档可选模型里有没有 vision 档"（D30 的口径），而不是"选中的别名带不带 vision"。
    /// 后者是上一版的写法，它要求用户先在几个长得一样的档里找到「识图」才能用 ——
    /// 那是把实现细节当成了前提。现在：选「自动」时服务端按内容选档；选显式档时服务端照旧严格按它来
    /// （带图会 400，**不会被悄悄改写**）。
    /// </para>
    /// <para>
    /// provider 仍要是服务端网关（<see cref="IAIService.SupportsVision"/>）：BYOK 四档不提供识图。
    /// </para>
    /// </remarks>
    public bool SupportsVision =>
        _aiService?.SupportsVision == true
        && _authService.AiModels.Any(a => a.SupportsVision);

    /// <summary>
    /// 「应用为 drawio」是否可用：**只在当前文档是 Mermaid 时**。
    /// </summary>
    /// <remarks>
    /// 该按钮复用现有 <c>ConvertMermaidToDrawio</c>（方案 §6.6：不新增转换代码），
    /// 而那条链路是 mermaid → 图形**单向**的。当前文档是 DOT 时这个按钮没有意义，直接不显示。
    /// </remarks>
    public bool CanApplyAsDrawio =>
        _formats?.Get(_currentFormatId)?.SupportsGraphImport == true;

    public string AIPickImage => S.AIPickImage;
    public string AIPickImageTooltip => S.AIPickImageTooltip;
    public string AIClearImageTooltip => S.AIClearImageTooltip;
    public string AIApplyAsDrawio => S.AIApplyAsDrawio;
    public string AIApplyAsDrawioTooltip => S.AIApplyAsDrawioTooltip;

    public string ToggleButtonText => IsExpanded ? $"{S.AIAssistant} ▼" : $"{S.AIAssistant} ▲";

    public bool HasMessages => Messages.Count > 0;

    public bool HasModels => AvailableModels.Count > 0;

    public string AISettingsTooltip => S.AISettingsTooltip;
    public string AIClearHistoryTooltip => S.AIClearHistoryTooltip;
    public string AISelectModelTooltip => S.AISelectModelTooltip;
    public string AIInputPlaceholder => S.AIInputPlaceholder;
    public string AISend => S.AISend;
    public string AIApply => S.AIApply;
    public string AIRevert => S.AIRevert;
    public string AICodeGenerated => S.AICodeGenerated;

    /// <summary>生成或回退的代码要写回编辑器；载荷带上生成时的格式 id，由承载方核对。</summary>
    public event EventHandler<AICodeApplyRequest>? CodeGenerated;

    /// <summary>
    /// 「应用为 drawio」请求。
    /// </summary>
    /// <remarks>
    /// 刻意**不**在面板里做转换：转换要新建标签页、要碰承载层，那是 <c>MainViewModel</c> 的地盘。
    /// 面板只负责把"用户想把这个结果变成 drawio"说出来（方案 §6.6 第 6 步）。
    /// </remarks>
    public event EventHandler<AICodeApplyRequest>? ApplyAsDrawioRequested;
    public event EventHandler? ToggleRequested;
    public event EventHandler? OpenSettingsRequested;

    public AIPanelViewModel(
        SettingsService settingsService,
        AIConversationService conversationService,
        AuthService authService,
        IStorageProvider? storageProvider = null,
        DocumentFormatRegistry? formats = null)
    {
        _settingsService = settingsService;
        _conversationService = conversationService;
        _authService = authService;
        _storageProvider = storageProvider;
        _formats = formats;

        IsExpanded = settingsService.Settings.AIPanelExpanded;
        PanelHeight = settingsService.Settings.AIPanelHeight;

        LoadAvailableModels();
        InitializeAIService();

        // 冷启动时别名列表还是空的（要带令牌才拉得到）→ 后台补一次；拉不到就保持现状，不打扰用户。
        _ = RefreshCloudModelsAsync();
    }

    private void LoadAvailableModels()
    {
        _settingsService.ReloadSecureValues();
        
        var selectedId = _settingsService.Settings.SelectedModelId;

        AvailableModels.Clear();

        foreach (var model in _settingsService.Settings.ModelConfigs.Where(m => m.IsEnabled))
        {
            if (model.Provider != AIProvider.DiagramonCloud)
            {
                AvailableModels.Add(model);
                continue;
            }

            // 「Diagramon 云」在设置里是**一条**配置，但它代表"本账号可选的一档模型"。
            // 展开成每个别名一项，用户才能在这个面板里直接换模型 —— 否则换个模型要进设置改一遍。
            // 账号不可用的别名**不出现**（那份列表来自 /v1/ai/models，见 AuthService.AiModels），
            // 于是免费账号在这个列表里看不到云条目，识图入口也就随之不可用。
            //
            // **「自动」放在最前**（也是新用户的默认项）：它让"识图"不再要求用户先在下拉里
            // 找到识图档 —— 客户端只表达意图，服务端按请求内容选档（含图 → 识图档）。
            // 老服务端不认识这个保留值（发了会 400），所以要先探测，见 AuthService.SupportsAutoAlias。
            if (_authService.SupportsAutoAlias)
            {
                AvailableModels.Add(AutoModelItem(model));
            }

            foreach (var alias in _authService.AiModels)
            {
                AvailableModels.Add(CloudModelItem(model, alias));
            }
        }

        SelectedModel = AvailableModels.FirstOrDefault(m => m.Id == selectedId) ?? AvailableModels.FirstOrDefault();

        OnPropertyChanged(nameof(HasModels));
        OnPropertyChanged(nameof(SupportsVision));
    }

    private void InitializeAIService()
    {
        if (SelectedModel == null)
        {
            IsConfigured = false;
            StatusMessage = S.AIConfigRequired;
            return;
        }

        _aiService = CreateAIService(SelectedModel);
        IsConfigured = _aiService?.IsConfigured ?? false;
        // 「识图」按钮的可用性跟着 provider 走（只有云网关能识图）
        OnPropertyChanged(nameof(SupportsVision));
        if (!SupportsVision)
        {
            ClearPendingImage();
        }

        if (!IsConfigured)
        {
            StatusMessage = SelectedModel.Provider switch
            {
                AIProvider.OpenAI when string.IsNullOrWhiteSpace(SelectedModel.ApiKey) => S.AIConfigApiKey,
                AIProvider.AzureOpenAI when string.IsNullOrWhiteSpace(SelectedModel.ApiKey) => S.AIConfigAzureApiKey,
                AIProvider.Ollama => S.AIConfigOllama,
                AIProvider.Custom when string.IsNullOrWhiteSpace(SelectedModel.BaseUrl) => S.AIConfigBaseUrl,
                _ => S.AIConfigComplete
            };
        }
        else
        {
            StatusMessage = string.Format(S.AIReadyFormat, SelectedModel.DisplayName);
        }
    }

    /// <summary>
    /// 把云配置的某个别名做成一个可选模型项。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 合成 id <c>{configId}#{alias}</c>：<c>#</c> 之后是**要发出去的别名**，之前是设置里那条配置的 id。
    /// 这样 <c>SelectedModelId</c> 能原样记住用户选的是哪一档，重启后还能选中同一个
    /// （设置里那条配置的 id 保持不变即可）。
    /// </para>
    /// <para>
    /// 这是个**临时视图对象**，不写回 settings：<c>ApiKey</c> 有 <c>[JsonIgnore]</c>，
    /// 而这里的项根本没进 <c>ModelConfigs</c>，所以不会污染配置文件。
    /// </para>
    /// </remarks>
    private static AIModelConfig CloudModelItem(AIModelConfig cloudConfig, AiModelDto alias) => new()
    {
        Id = $"{cloudConfig.Id}#{alias.Id}",
        Name = $"{cloudConfig.Name} · {alias.DisplayName}",
        Provider = AIProvider.DiagramonCloud,
        // 发出去的模型名是**别名**（如 mermaid-default），不是合成 id
        ModelId = alias.Id,
        MaxTokens = cloudConfig.MaxTokens,
        Temperature = cloudConfig.Temperature,
        IsEnabled = true,
    };

    /// <summary>
    /// 「自动」这一项：模型名发保留别名 <c>auto</c>，由服务端按请求内容选档。
    /// </summary>
    private static AIModelConfig AutoModelItem(AIModelConfig cloudConfig) => new()
    {
        Id = $"{cloudConfig.Id}#auto",
        Name = $"{cloudConfig.Name} · {S.AIAutoModel}",
        Provider = AIProvider.DiagramonCloud,
        ModelId = "auto",
        MaxTokens = cloudConfig.MaxTokens,
        Temperature = cloudConfig.Temperature,
        IsEnabled = true,
    };

    /// <summary>
    /// 把"服务端实际用的档"如实说出来（只在它与请求不一致时才需要）。
    /// </summary>
    /// <remarks>
    /// `auto` 可能在用户不知情时切到更贵的档（识图档按图片折算 token）——
    /// 所以状态栏必须写清"本次用了哪一档"，这是 `auto` 能被接受的前提。
    /// </remarks>
    private string DescribeResolvedTier(AIMessage response)
    {
        var resolved = response.ResolvedAlias;
        if (string.IsNullOrEmpty(resolved))
        {
            return string.Empty;
        }

        var display = _authService.AiModels.FirstOrDefault(a => a.Id == resolved)?.DisplayName ?? resolved;
        return " " + string.Format(S.AIUsedTierFormat, display);
    }

    /// <summary>
    /// 拉一次"本账号可用的别名"并重建列表（登录后、面板打开时调）。
    /// </summary>
    public async Task RefreshCloudModelsAsync()
    {
        if (!_authService.Session.IsSignedIn)
        {
            return;
        }

        await _authService.RefreshAiModelsAsync();
        LoadAvailableModels();
    }

    private IAIService? CreateAIService(AIModelConfig config)
    {
        return config.Provider switch
        {
            AIProvider.OpenAI => new OpenAIService(ConvertToProviderConfig(config)),
            AIProvider.AzureOpenAI => new AzureOpenAIService(ConvertToProviderConfig(config)),
            AIProvider.Ollama => new OllamaService(ConvertToProviderConfig(config)),
            AIProvider.Custom => new CustomAIService(config),
            // 「Diagramon 云」：走服务端网关（会员权益）。凭据是**当前 access token**（每次现取、不落盘），
            // 所以它不复用 CustomAIService —— 那个类的 Key 来自配置字段，而那个字段会落盘。
            AIProvider.DiagramonCloud => new CloudAIService(_authService, config),
            _ => null
        };
    }

    private AIProviderConfig ConvertToProviderConfig(AIModelConfig modelConfig)
    {
        return new AIProviderConfig
        {
            Provider = modelConfig.Provider,
            ApiKey = modelConfig.ApiKey,
            Endpoint = modelConfig.Endpoint,
            DeploymentName = modelConfig.DeploymentName,
            Model = modelConfig.ModelId,
            BaseUrl = modelConfig.BaseUrl,
            MaxTokens = modelConfig.MaxTokens,
            Temperature = modelConfig.Temperature
        };
    }

    partial void OnSelectedModelChanged(AIModelConfig? value)
    {
        if (value != null)
        {
            _settingsService.SetSelectedModel(value.Id);
            InitializeAIService();
        }
    }

    /// <summary>
    /// 切换 AI 面板绑定的文档：<paramref name="stableId"/> 决定会话存档键（本地 = 规范化路径，
    /// 云端 = 服务端文档 id），<paramref name="formatId"/> 决定系统提示词与代码围栏。
    /// </summary>
    public void SetCurrentDocument(string? stableId, string formatId)
    {
        if (stableId == _currentStableId && formatId == _currentFormatId)
        {
            return;
        }

        _currentStableId = stableId;
        _currentFormatId = formatId;
        OnPropertyChanged(nameof(CanApplyAsDrawio));
        LoadConversation();
    }

    private void LoadConversation()
    {
        Messages.Clear();

        var conversation = _conversationService.GetOrCreateConversation(_currentStableId);
        foreach (var message in conversation.Messages)
        {
            Messages.Add(message);
        }

        OnPropertyChanged(nameof(HasMessages));
    }

    [RelayCommand]
    private void Toggle()
    {
        IsExpanded = !IsExpanded;
        OnPropertyChanged(nameof(ToggleButtonText));
        ToggleRequested?.Invoke(this, EventArgs.Empty);
    }

    [RelayCommand]
    private async Task Send()
    {
        var hasImage = _pendingImageBytes is not null;

        // 有图时**空文字也合法**：选完图直接点发送是最自然的用法，逼用户先打一句话是多余的摩擦。
        if (IsLoading || _aiService == null || (string.IsNullOrWhiteSpace(InputText) && !hasImage))
            return;

        var prompt = string.IsNullOrWhiteSpace(InputText) ? S.AIImageDefaultPrompt : InputText.Trim();
        var image = _pendingImageBytes;
        var mediaType = _pendingImageMediaType;

        var userMessage = new AIMessage
        {
            Role = MessageRole.User,
            // 带图时在气泡里留痕：否则回看会话完全看不出这一轮带了图
            Content = hasImage ? $"{prompt}\n{S.AIImageAttached}" : prompt,
            Timestamp = DateTime.Now
        };

        Messages.Add(userMessage);
        OnPropertyChanged(nameof(HasMessages));

        // 图片**发完即弃**：留着会在下次发送时被重复上传；失败重发时让用户重选一次更清楚
        ClearPendingImage();

        InputText = string.Empty;

        var loadingMessage = new AIMessage
        {
            Role = MessageRole.Assistant,
            Content = string.Empty,
            IsLoading = true,
            Timestamp = DateTime.Now
        };
        Messages.Add(loadingMessage);

        IsLoading = true;
        StatusMessage = S.AIGenerating;

        try
        {
            var currentCode = GetCurrentCode?.Invoke() ?? string.Empty;

            // **本轮提问不进历史**：它以 prompt 的形式单独传，留在历史里会让模型看到两遍
            // （V2-7 顺手修掉的重复；同时也少算一份 token）
            var history = Messages
                .Where(m => !m.IsLoading && m != loadingMessage && m != userMessage)
                .ToList();

            // 格式在这里**解析一次**：提示词、代码提取、历史里的格式名都从它取，
            // 服务层因此不需要认识注册表（只认识"一个格式"）。
            var format = _formats?.Get(_currentFormatId) ?? _fallbackFormat;

            var response = image is null
                ? await _aiService.GenerateAsync(prompt, currentCode, history, format)
                : await _aiService.GenerateFromImageAsync(
                    image, mediaType, prompt, currentCode, history, format);

            // 记录生成时的格式：应用代码时据此判断当前标签页是否还是同一个格式
            response.FormatId = _currentFormatId;

            var index = Messages.IndexOf(loadingMessage);
            if (index >= 0)
            {
                Messages[index] = response;
            }

            response = await FixByRenderErrorAsync(response, format, loadingMessage) ?? response;

            SaveConversation();

            if (!string.IsNullOrEmpty(response.GeneratedCode))
            {
                // **截断必须被看见**：`finish_reason=length` 时用户拿到的是半截代码
                // （预览会报语法错或画出半张图），而"已生成"这句话会让人以为一切正常。
                // 同理，`auto` 解析出来的档位也要写出来（可能在用户不知情时切到了更贵的档）。
                StatusMessage = (response.IsTruncated ? S.AIErrorOutputTruncated : S.AIGenerated)
                    + DescribeResolvedTier(response);
            }
            else if (!string.IsNullOrEmpty(response.ErrorMessage))
            {
                StatusMessage = string.Format(S.AIErrorFormat, response.ErrorMessage);
            }
            else
            {
                StatusMessage = S.AIResponded;
            }
        }
        catch (Exception ex)
        {
            var index = Messages.IndexOf(loadingMessage);
            if (index >= 0)
            {
                Messages[index] = new AIMessage
                {
                    Role = MessageRole.Assistant,
                    Content = string.Empty,
                    ErrorMessage = string.Format(S.AIGenerationError, ex.Message),
                    IsLoading = false,
                    Timestamp = DateTime.Now
                };
            }
            StatusMessage = string.Format(S.AIErrorFormat, ex.Message);
        }
        finally
        {
            IsLoading = false;
        }
    }

    /// <summary>
    /// 选图 → 预处理 → 挂成"待发送"。
    /// </summary>
    /// <remarks>
    /// 图片**只在内存里**：不落盘、不进会话记录（会话记录是 JSON 文本，塞 base64 会把文件撑爆）。
    /// 所以关掉面板或切走 provider 时待发图片会被丢掉 —— 这是有意的。
    /// </remarks>
    [RelayCommand]
    private async Task PickImage()
    {
        if (!SupportsVision)
        {
            StatusMessage = S.AIVisionNeedsCloud;
            return;
        }

        if (_storageProvider is null)
        {
            return;
        }

        // 首次上传前必须告知（D25）：这张图会离开本机，用户有权先知道
        if (ConfirmVisionUpload is not null && !await ConfirmVisionUpload())
        {
            return;
        }

        try
        {
            var files = await _storageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                Title = S.AIPickImageTooltip,
                AllowMultiple = false,
                FileTypeFilter =
                [
                    new FilePickerFileType(S.AIPickImage)
                    {
                        Patterns = ["*.png", "*.jpg", "*.jpeg", "*.webp"],
                    },
                ],
            });

            var file = files.FirstOrDefault();
            if (file is null)
            {
                return;
            }

            await using var stream = await file.OpenReadAsync();
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer);
            buffer.Position = 0;

            var prepared = ImagePreprocessor.Prepare(buffer);

            ClearPendingImage();
            _pendingImageBytes = prepared.Data;
            _pendingImageMediaType = prepared.MediaType;
            PendingImagePreview = new Bitmap(new MemoryStream(prepared.Data));

            StatusMessage = string.Format(
                S.AIImageAttachedFormat, prepared.Width, prepared.Height, prepared.Data.Length / 1024);
        }
        catch (Exception ex)
        {
            ClearPendingImage();
            StatusMessage = string.Format(S.AIImageReadFailedFormat, ex.Message);
        }
    }

    [RelayCommand]
    private void ClearImage() => ClearPendingImage();

    private void ClearPendingImage()
    {
        _pendingImageBytes = null;
        _pendingImageMediaType = "image/png";
        PendingImagePreview?.Dispose();
        PendingImagePreview = null;
    }

    /// <summary>
    /// 应用代码 + 转成 drawio 标签页（复用现有转换链路，不新增转换代码）。
    /// </summary>
    [RelayCommand]
    private void ApplyAsDrawio(AIMessage? message)
    {
        if (message == null || string.IsNullOrEmpty(message.GeneratedCode))
            return;

        ApplyAsDrawioRequested?.Invoke(this, new AICodeApplyRequest(message.GeneratedCode, message.FormatId));
        StatusMessage = S.CodeGenerated;
    }

    [RelayCommand]
    private void ApplyCode(AIMessage? message)
    {
        if (message == null || string.IsNullOrEmpty(message.GeneratedCode))
            return;

        CodeGenerated?.Invoke(this, new AICodeApplyRequest(message.GeneratedCode, message.FormatId));
        StatusMessage = S.CodeGenerated;
    }

    [RelayCommand]
    private void RevertCode(AIMessage? message)
    {
        if (message == null || string.IsNullOrEmpty(message.CodeBeforeGeneration))
            return;

        CodeGenerated?.Invoke(this, new AICodeApplyRequest(message.CodeBeforeGeneration, message.FormatId));
        StatusMessage = S.CodeReverted;
    }

    /// <summary>
    /// 渲染反馈闭环（V2-8，D34）：生成后**先渲染一次**，报错就把原文发回去让模型修一次。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 拿到的是"<b>会自我校验的生成</b>"，不是自主代理：不需要 agent loop、不需要给模型文件权限、
    /// 不需要新协议 —— 渲染器本来就装在客户端。代价只有几十行。
    /// </para>
    /// <para>
    /// <b>上限 1 次</b>（可关）：重试是**第二次真实调用**、第二次计费，不设上限账单就不可预测。
    /// 所以状态栏明说"第 2 次"，设置里也有开关。
    /// </para>
    /// <para>
    /// 第二次的结果作为**新的一条消息**追加，而不是覆盖第一条 —— 用户要能看到
    /// "第一版是什么、为什么被修"。覆盖会让"自动修正"变成一次静默改写。
    /// </para>
    /// </remarks>
    /// <returns>修正后的消息；没触发修正时返回 <c>null</c>。</returns>
    private async Task<AIMessage?> FixByRenderErrorAsync(
        AIMessage response, IDocumentFormat format, AIMessage loadingMessage)
    {
        if (_aiService is null
            || ProbeRenderError is null
            || !_settingsService.Settings.AiRenderFeedbackRetry
            || response.GeneratedCode is not { Length: > 0 } generated)
        {
            return null;
        }

        var renderError = await ProbeRenderError(generated);
        if (string.IsNullOrEmpty(renderError))
        {
            return null;
        }

        StatusMessage = string.Format(S.AIRenderRetryStatus, 2);

        // 历史带上刚失败的那一版：currentCode 与它相同 → 组装时会去重，不会重复塞
        var history = Messages.Where(m => !m.IsLoading && m != loadingMessage).ToList();

        var retry = await _aiService.GenerateAsync(
            string.Format(S.AIRenderRetryPrompt, renderError),
            generated,
            history,
            format,
            retryOf: response.RequestId);

        if (string.IsNullOrEmpty(retry.GeneratedCode))
        {
            return null;
        }

        retry.FormatId = _currentFormatId;
        retry.CodeBeforeGeneration = response.CodeBeforeGeneration;
        Messages.Add(retry);
        OnPropertyChanged(nameof(HasMessages));

        return retry;
    }

    [RelayCommand]
    private void ClearHistory()
    {
        _conversationService.ClearConversation(_currentStableId);
        Messages.Clear();
        OnPropertyChanged(nameof(HasMessages));
        StatusMessage = S.ConversationCleared;
    }

    [RelayCommand]
    private void OpenSettings()
    {
        OpenSettingsRequested?.Invoke(this, EventArgs.Empty);
    }

    private void SaveConversation()
    {
        var conversation = _conversationService.GetOrCreateConversation(_currentStableId);
        conversation.Messages = Messages.ToList();
        _conversationService.SaveConversation(conversation);
    }

    public void SaveSettings()
    {
        _settingsService.Settings.AIPanelExpanded = IsExpanded;
        _settingsService.Settings.AIPanelHeight = PanelHeight;
        _settingsService.Save();
    }

    public void RefreshConfiguration()
    {
        LoadAvailableModels();
        InitializeAIService();

        // 冷启动时别名列表还是空的（要带令牌才拉得到）→ 后台补一次；拉不到就保持现状，不打扰用户。
        _ = RefreshCloudModelsAsync();
    }

    public void RefreshLocalization()
    {
        // 整表失效，理由同 MainViewModel.OnLanguageChanged：手写属性名清单会漂移。
        OnPropertyChanged(string.Empty);
    }

    public Func<string?>? GetCurrentCode { get; set; }

    /// <summary>
    /// 首次选图前的告知确认（D25）。由承载方弹窗；返回 <c>false</c> = 用户取消，不上传。
    /// </summary>
    /// <remarks>
    /// 用回调而不是事件：这里要的是<b>同步的答案</b>（继续还是取消），事件是"通知已发生"，
    /// 拿不回结果。承载方本来就有弹窗能力（<c>MainViewModel</c> 持有 owner window），
    /// 面板自己弹窗就得知道窗口层级 —— 那是 Views 的职责。
    /// </remarks>
    public Func<Task<bool>>? ConfirmVisionUpload { get; set; }

    /// <summary>
    /// 把一段代码渲染进预览页并取回报错原文（V2-8，方案 §6.10）。返回 <c>null</c> = 没报错。
    /// </summary>
    /// <remarks>
    /// 与 <see cref="GetCurrentCode"/>、<see cref="ConfirmVisionUpload"/> 同一种做法：
    /// 面板不懂 WebView，承载方（<c>MainWindow</c>）才有渲染能力。
    /// </remarks>
    public Func<string, Task<string?>>? ProbeRenderError { get; set; }

    partial void OnIsExpandedChanged(bool value)
    {
        OnPropertyChanged(nameof(ToggleButtonText));
    }

    partial void OnPanelHeightChanged(double value)
    {
        _settingsService.Settings.AIPanelHeight = value;
    }
}
