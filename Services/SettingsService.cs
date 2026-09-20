using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Diagramon.Models;

namespace Diagramon.Services;

public class AppSettings
{
    public double EditorPreviewRatio { get; set; } = 0.5;
    public double PreviewZoom { get; set; } = 1.0;

    public const double MinExportScale = 1.5;
    public const double MaxExportScale = 10.0;

    /// <summary>图片保存/拷贝倍率:true=使用 FixedExportScale,false=按复杂度自动(1.5x~5.0x)。</summary>
    public bool UseFixedExportScale { get; set; }
    public double FixedExportScale { get; set; } = 3.0;

    public string LastOpenDirectory { get; set; } = string.Empty;

    /// <summary>
    /// 最近文件。以 <see cref="RecentEntry"/> 存储而非裸路径 —— 云端文档的身份是服务端 docId，
    /// 无法用路径表达。旧格式（裸路径数组）由 <see cref="RecentEntryListConverter"/> 兼容读取。
    /// </summary>
    [JsonConverter(typeof(RecentEntryListConverter))]
    public List<RecentEntry> RecentFiles { get; set; } = new();

    public List<AIModelConfig> ModelConfigs { get; set; } = new();
    public string? SelectedModelId { get; set; }

    public string? ConversationStoragePath { get; set; }
    public bool AIPanelExpanded { get; set; }
    public double AIPanelHeight { get; set; } = 200;

    public AIProvider SelectedProvider { get; set; } = AIProvider.OpenAI;
    public AIProviderConfig OpenAIConfig { get; set; } = new() { Provider = AIProvider.OpenAI, Model = "gpt-4o" };
    public AIProviderConfig AzureOpenAIConfig { get; set; } = new() { Provider = AIProvider.AzureOpenAI, Model = "gpt-4" };
    public AIProviderConfig OllamaConfig { get; set; } = new() { Provider = AIProvider.Ollama, Model = "llama3", BaseUrl = "http://localhost:11434" };

    public string? Language { get; set; }

    public bool AutoCheckUpdate { get; set; } = true;
    public string? SkipVersion { get; set; }
    public string? LastUpdateCheckTime { get; set; }
    public string? UpdateManifestUrl { get; set; }

    /// <summary>
    /// 设备标识。注册 / 登录 / 刷新都要带，且必须<b>跨重启稳定</b> ——
    /// 服务端把它与 refresh token 绑定，变了就会得到 401 device_mismatch。
    /// </summary>
    public string? DeviceId { get; set; }

    /// <summary>云端服务地址（origin，不含 <c>/v1</c>）。默认指向本地开发服务。</summary>
    public string ServiceBaseUrl { get; set; } = "http://127.0.0.1:8000";
}

public class SettingsService
{
    public const int MaxRecentFiles = 10;

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Diagramon",
        "settings.json"
    );

    private static readonly string RecentHistoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Diagramon",
        "recent-history.json"
    );

    /// <summary>敏感值的独立存储文件（DPAPI 密文）。AuthService 也用它存 refresh token。</summary>
    public static string SecureConfigPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Diagramon",
        "secure.config"
    );

    private RecentHistoryData _recentHistory = new();

    public AppSettings Settings { get; private set; }

    public IReadOnlyList<string> RecentFiles => _recentHistory.RecentFiles.AsReadOnly();

    public SettingsService()
    {
        Settings = Load();
        LoadRecentHistory();
        LoadSecureValues();
        EnsureDefaultModels();
    }

    private void LoadRecentHistory()
    {
        try
        {
            if (File.Exists(RecentHistoryPath))
            {
                var json = File.ReadAllText(RecentHistoryPath);
                _recentHistory = JsonSerializer.Deserialize<RecentHistoryData>(json) ?? new RecentHistoryData();
                return;
            }
        }
        catch { }

        // Migrate from old settings.json if present
        MigrateRecentHistoryFromSettings();
    }

    private void MigrateRecentHistoryFromSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                var oldSettings = JsonSerializer.Deserialize<AppSettingsWithRecent>(json);
                if (oldSettings != null && (oldSettings.RecentFiles.Count > 0 || oldSettings.RecentFileHistory.Count > 0))
                {
                    _recentHistory.RecentFiles = oldSettings.RecentFiles;
                    _recentHistory.RecentFileHistory = oldSettings.RecentFileHistory;
                    SaveRecentHistory();
                    // Remove these fields from settings.json by re-saving without them
                    SaveSettingsOnly();
                }
            }
        }
        catch { }
    }

    private void SaveRecentHistory()
    {
        try
        {
            var directory = Path.GetDirectoryName(RecentHistoryPath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var json = JsonSerializer.Serialize(_recentHistory, new JsonSerializerOptions
            {
                WriteIndented = true
            });
            File.WriteAllText(RecentHistoryPath, json);
        }
        catch { }
    }

    private void SaveSettingsOnly()
    {
        try
        {
            var directory = Path.GetDirectoryName(SettingsPath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var json = JsonSerializer.Serialize(Settings, new JsonSerializerOptions
            {
                WriteIndented = true
            });
            File.WriteAllText(SettingsPath, json);
        }
        catch { }
    }

    public string? GetLanguageCode()
    {
        return Settings.Language;
    }

    public void SetLanguageCode(string languageCode)
    {
        Settings.Language = languageCode;
        Save();
    }

    /// <summary>设备标识：首次调用时生成并持久化，之后跨重启返回同一个值。</summary>
    /// <remarks>
    /// 用 GUID 的 "N" 格式（32 个十六进制字符）：满足服务端 <c>device_id</c> 的 1–64 字符约束，
    /// 且不含连字符，避免不同平台在格式化上的差异。
    /// </remarks>
    public string GetOrCreateDeviceId()
    {
        if (string.IsNullOrWhiteSpace(Settings.DeviceId))
        {
            Settings.DeviceId = Guid.NewGuid().ToString("N");
            Save();
        }

        return Settings.DeviceId!;
    }

    private void EnsureDefaultModels()
    {
        if (Settings.ModelConfigs.Count == 0)
        {
            Settings.ModelConfigs = new List<AIModelConfig>
            {
                new AIModelConfig
                {
                    Id = "openai-default",
                    Name = "OpenAI GPT-4o",
                    Provider = AIProvider.OpenAI,
                    ModelId = "gpt-4o",
                    IsEnabled = true
                },
                new AIModelConfig
                {
                    Id = "ollama-default",
                    Name = "Ollama (本地)",
                    Provider = AIProvider.Ollama,
                    ModelId = "llama3",
                    BaseUrl = "http://localhost:11434",
                    IsEnabled = true
                }
            };
            Settings.SelectedModelId = "openai-default";
            Save();
        }

        if (string.IsNullOrEmpty(Settings.SelectedModelId) && Settings.ModelConfigs.Count > 0)
        {
            Settings.SelectedModelId = Settings.ModelConfigs[0].Id;
        }
    }

    private void LoadSecureValues()
    {
        foreach (var config in Settings.ModelConfigs)
        {
            config.ApiKey = SecureStorageService.LoadProtectedValue($"Model_{config.Id}_ApiKey", SecureConfigPath);
        }
        Settings.OpenAIConfig.ApiKey = SecureStorageService.LoadProtectedValue("OpenAI_ApiKey", SecureConfigPath);
        Settings.AzureOpenAIConfig.ApiKey = SecureStorageService.LoadProtectedValue("Azure_ApiKey", SecureConfigPath);
    }

    public void ReloadSecureValues()
    {
        LoadSecureValues();
    }

    public void SaveModelApiKey(string modelId, string? apiKey)
    {
        var config = Settings.ModelConfigs.FirstOrDefault(c => c.Id == modelId);
        if (config != null)
        {
            config.ApiKey = apiKey;
            SecureStorageService.SaveProtectedValue($"Model_{modelId}_ApiKey", apiKey, SecureConfigPath);
        }
    }

    public AIModelConfig? GetSelectedModelConfig()
    {
        return Settings.ModelConfigs.FirstOrDefault(c => c.Id == Settings.SelectedModelId);
    }

    public AIModelConfig? GetModelConfig(string? modelId)
    {
        if (string.IsNullOrEmpty(modelId)) return null;
        return Settings.ModelConfigs.FirstOrDefault(c => c.Id == modelId);
    }

    public void AddModelConfig(AIModelConfig config)
    {
        config.Id = string.IsNullOrEmpty(config.Id) ? Guid.NewGuid().ToString() : config.Id;
        Settings.ModelConfigs.Add(config);
        Save();
    }

    public void UpdateModelConfig(AIModelConfig config)
    {
        var existing = Settings.ModelConfigs.FirstOrDefault(c => c.Id == config.Id);
        if (existing != null)
        {
            var index = Settings.ModelConfigs.IndexOf(existing);
            Settings.ModelConfigs[index] = config;
            Save();
        }
    }

    public void RemoveModelConfig(string modelId)
    {
        var config = Settings.ModelConfigs.FirstOrDefault(c => c.Id == modelId);
        if (config != null)
        {
            Settings.ModelConfigs.Remove(config);
            SecureStorageService.SaveProtectedValue($"Model_{modelId}_ApiKey", null, SecureConfigPath);
            if (Settings.SelectedModelId == modelId)
            {
                Settings.SelectedModelId = Settings.ModelConfigs.FirstOrDefault()?.Id;
            }
            Save();
        }
    }

    public void SetSelectedModel(string? modelId)
    {
        if (Settings.ModelConfigs.Any(c => c.Id == modelId))
        {
            Settings.SelectedModelId = modelId;
            Save();
        }
    }

    public void SaveApiKey(AIProvider provider, string? apiKey)
    {
        switch (provider)
        {
            case AIProvider.OpenAI:
                Settings.OpenAIConfig.ApiKey = apiKey;
                SecureStorageService.SaveProtectedValue("OpenAI_ApiKey", apiKey, SecureConfigPath);
                break;
            case AIProvider.AzureOpenAI:
                Settings.AzureOpenAIConfig.ApiKey = apiKey;
                SecureStorageService.SaveProtectedValue("Azure_ApiKey", apiKey, SecureConfigPath);
                break;
            case AIProvider.Ollama:
            case AIProvider.Custom:
                break;
        }
    }

    public AIProviderConfig GetCurrentProviderConfig()
    {
        return Settings.SelectedProvider switch
        {
            AIProvider.OpenAI => Settings.OpenAIConfig,
            AIProvider.AzureOpenAI => Settings.AzureOpenAIConfig,
            AIProvider.Ollama => Settings.OllamaConfig,
            _ => Settings.OpenAIConfig
        };
    }

    private AppSettings Load()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                return JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
            }
        }
        catch
        {
        }

        return new AppSettings();
    }

    public void Save()
    {
        SaveSettingsOnly();
        SaveRecentHistory();
    }

    public void AddRecentFile(string filePath)
    {
        if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return;

        var location = new LocalDocumentLocation(filePath);

        // 以 StableId 去重：同一文件的不同书写形式（大小写 / 相对路径）不会重复入列
        Settings.RecentFiles.RemoveAll(entry => entry.StableId == location.StableId);
        Settings.RecentFiles.Insert(0, new RecentEntry(location));

        _recentHistory.RecentFiles.Remove(filePath);
        _recentHistory.RecentFiles.Insert(0, filePath);

        if (_recentHistory.RecentFiles.Count > MaxRecentFiles)
        {
            _recentHistory.RecentFiles = _recentHistory.RecentFiles.Take(MaxRecentFiles).ToList();
        }

        AddToHistory(filePath);
        Save();
    }

    public void RemoveRecentFile(string filePath)
    {
        var stableId = DocumentIdentity.Normalize(filePath) ?? filePath;

        if (Settings.RecentFiles.RemoveAll(entry => entry.StableId == stableId) > 0)
        {
            Save();
        }

        if (_recentHistory.RecentFiles.Remove(filePath))
        {
            SaveRecentHistory();
        }
    }

    /// <summary>剔除已不存在的本地文件；云端条目（Kind != "local"）不在此处校验。</summary>
    public void CleanInvalidRecentFiles()
    {
        var countBefore = Settings.RecentFiles.Count;

        Settings.RecentFiles = Settings.RecentFiles
            .Where(entry => entry.Kind != "local" || File.Exists(entry.DisplayPath))
            .ToList();

        if (Settings.RecentFiles.Count != countBefore)
        {
            Save();
        }

        var validFiles = _recentHistory.RecentFiles.Where(File.Exists).ToList();
        if (validFiles.Count != _recentHistory.RecentFiles.Count)
        {
            _recentHistory.RecentFiles = validFiles;
            SaveRecentHistory();
        }
    }

    public void AddToHistory(string filePath)
    {
        if (string.IsNullOrEmpty(filePath)) return;

        var existing = _recentHistory.RecentFileHistory.FirstOrDefault(e =>
            string.Equals(e.FilePath, filePath, StringComparison.OrdinalIgnoreCase));
        if (existing != null)
        {
            existing.LastOpenedTime = DateTime.Now;
        }
        else
        {
            _recentHistory.RecentFileHistory.Add(new RecentFileEntry
            {
                FilePath = filePath,
                LastOpenedTime = DateTime.Now
            });
        }
    }

    public void AddToHistoryAndSave(string filePath)
    {
        AddToHistory(filePath);
        SaveRecentHistory();
    }

    public List<RecentFileEntry> GetHistoryWithExistingFiles()
    {
        return _recentHistory.RecentFileHistory
            .Where(e => File.Exists(e.FilePath))
            .OrderByDescending(e => e.LastOpenedTime)
            .ToList();
    }
}

public class RecentHistoryData
{
    public List<string> RecentFiles { get; set; } = new();
    public List<RecentFileEntry> RecentFileHistory { get; set; } = new();
}

// Used only for migration from old settings.json format
internal class AppSettingsWithRecent
{
    public List<string> RecentFiles { get; set; } = new();
    public List<RecentFileEntry> RecentFileHistory { get; set; } = new();
}
