using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Diagramon.Models;
using Diagramon.Services;
using Diagramon.Services.AIService;
using Diagramon.Services.Localization;

namespace Diagramon.ViewModels;

public partial class AIPanelViewModel : ViewModelBase
{
    private static readonly Strings S = Strings.Instance;
    private readonly SettingsService _settingsService;
    private readonly AIConversationService _conversationService;
    private IAIService? _aiService;
    private string? _currentFilePath;

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

    public event EventHandler<string>? CodeGenerated;
    public event EventHandler? ToggleRequested;
    public event EventHandler? OpenSettingsRequested;

    public AIPanelViewModel(SettingsService settingsService, AIConversationService conversationService)
    {
        _settingsService = settingsService;
        _conversationService = conversationService;

        IsExpanded = settingsService.Settings.AIPanelExpanded;
        PanelHeight = settingsService.Settings.AIPanelHeight;

        LoadAvailableModels();
        InitializeAIService();
    }

    private void LoadAvailableModels()
    {
        _settingsService.ReloadSecureValues();
        
        AvailableModels.Clear();
        
        foreach (var model in _settingsService.Settings.ModelConfigs.Where(m => m.IsEnabled))
        {
            AvailableModels.Add(model);
        }

        var selectedId = _settingsService.Settings.SelectedModelId;
        SelectedModel = AvailableModels.FirstOrDefault(m => m.Id == selectedId) ?? AvailableModels.FirstOrDefault();

        OnPropertyChanged(nameof(HasModels));
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

    private IAIService? CreateAIService(AIModelConfig config)
    {
        return config.Provider switch
        {
            AIProvider.OpenAI => new OpenAIService(ConvertToProviderConfig(config)),
            AIProvider.AzureOpenAI => new AzureOpenAIService(ConvertToProviderConfig(config)),
            AIProvider.Ollama => new OllamaService(ConvertToProviderConfig(config)),
            AIProvider.Custom => new CustomAIService(config),
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

    public void SetCurrentFile(string? filePath)
    {
        _currentFilePath = filePath;
        LoadConversation();
    }

    private void LoadConversation()
    {
        Messages.Clear();

        var conversation = _conversationService.GetOrCreateConversation(_currentFilePath);
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
        if (string.IsNullOrWhiteSpace(InputText) || IsLoading || _aiService == null)
            return;

        var userMessage = new AIMessage
        {
            Role = MessageRole.User,
            Content = InputText.Trim(),
            Timestamp = DateTime.Now
        };

        Messages.Add(userMessage);
        OnPropertyChanged(nameof(HasMessages));

        var prompt = InputText.Trim();
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
            var history = Messages
                .Where(m => !m.IsLoading && m != loadingMessage)
                .ToList();

            var response = await _aiService.GenerateAsync(prompt, currentCode, history);

            var index = Messages.IndexOf(loadingMessage);
            if (index >= 0)
            {
                Messages[index] = response;
            }

            SaveConversation();

            if (!string.IsNullOrEmpty(response.GeneratedCode))
            {
                StatusMessage = S.AIGenerated;
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

    [RelayCommand]
    private void ApplyCode(AIMessage? message)
    {
        if (message == null || string.IsNullOrEmpty(message.GeneratedCode))
            return;

        CodeGenerated?.Invoke(this, message.GeneratedCode);
        StatusMessage = S.CodeGenerated;
    }

    [RelayCommand]
    private void RevertCode(AIMessage? message)
    {
        if (message == null || string.IsNullOrEmpty(message.CodeBeforeGeneration))
            return;

        CodeGenerated?.Invoke(this, message.CodeBeforeGeneration);
        StatusMessage = S.CodeReverted;
    }

    [RelayCommand]
    private void ClearHistory()
    {
        _conversationService.ClearConversation(_currentFilePath);
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
        var conversation = _conversationService.GetOrCreateConversation(_currentFilePath);
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
    }

    public void RefreshLocalization()
    {
        OnPropertyChanged(nameof(ToggleButtonText));
        OnPropertyChanged(nameof(StatusMessage));
        OnPropertyChanged(nameof(AISettingsTooltip));
        OnPropertyChanged(nameof(AIClearHistoryTooltip));
        OnPropertyChanged(nameof(AISelectModelTooltip));
        OnPropertyChanged(nameof(AIInputPlaceholder));
        OnPropertyChanged(nameof(AISend));
        OnPropertyChanged(nameof(AIApply));
        OnPropertyChanged(nameof(AIRevert));
        OnPropertyChanged(nameof(AICodeGenerated));
    }

    public Func<string?>? GetCurrentCode { get; set; }

    partial void OnIsExpandedChanged(bool value)
    {
        OnPropertyChanged(nameof(ToggleButtonText));
    }

    partial void OnPanelHeightChanged(double value)
    {
        _settingsService.Settings.AIPanelHeight = value;
    }
}
