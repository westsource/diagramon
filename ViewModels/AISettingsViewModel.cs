using System;
using System.Collections.ObjectModel;
using System.Linq;
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

    public bool IsApiKeyRequired => EditingProvider != AIProvider.Ollama;

    public bool IsBaseUrlRequired => EditingProvider is AIProvider.Custom or AIProvider.Ollama;

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
    public string AIAdvancedOptions => S.AIAdvancedOptions;
    public string AIConversationStorage => S.AIConversationStorage;
    public string AIBrowse => S.AIBrowse;
    public string AIClose => S.AIClose;
    public string AIEndpoint => S.AIEndpoint;
    public string AIDeploymentName => S.AIDeploymentName;
    public string SaveButton => S.SaveButton;
    public string CancelButton => S.CancelButton;

    public AISettingsViewModel() : this(new SettingsService(), null, null)
    {
    }

    public AISettingsViewModel(SettingsService settingsService, IStorageProvider? storageProvider, Action? onSaved)
    {
        _settingsService = settingsService;
        _storageProvider = storageProvider;
        _onSaved = onSaved;

        LoadSettings();
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

    partial void OnEditingProviderChanged(AIProvider value)
    {
        OnPropertyChanged(nameof(IsApiKeyRequired));
        OnPropertyChanged(nameof(IsBaseUrlRequired));
        OnPropertyChanged(nameof(IsAzureConfig));

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
