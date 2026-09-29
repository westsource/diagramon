using System.Text.Json.Serialization;

namespace Diagramon.Models;

/// <summary>
/// AI provider 种类。
/// </summary>
/// <remarks>
/// <b>这些值会被序列化进 <c>settings.json</c>（整数）</b>，因此新增项**只能追加在末尾**，
/// 绝不能插队或重排 —— 那会让老用户的 provider 静默错位（把 Azure 的配置当成 OpenAI 用）。
/// </remarks>
public enum AIProvider
{
    OpenAI,
    AzureOpenAI,
    Ollama,
    Custom,

    /// <summary>
    /// 「Diagramon 云」：走服务端网关（会员权益路径）。
    /// </summary>
    /// <remarks>
    /// 与其余四项的区别不是"另一个上游"，而是**整条链路不同**：BaseUrl 固定为服务端地址、
    /// 凭据是当前 access token（每次请求取、不落盘）、计费走套餐额度。
    /// 所以它不复用 <c>CustomAIService</c>，而是 <c>CloudAIService</c>（见该类注释）。
    /// </remarks>
    DiagramonCloud = 4,
}

public class AIModelConfig
{
    public string Id { get; set; } = System.Guid.NewGuid().ToString();
    public string Name { get; set; } = "新模型";
    public AIProvider Provider { get; set; } = AIProvider.Custom;
    /// <summary>
    /// 该 provider 的 API Key。
    /// </summary>
    /// <remarks>
    /// <b>不写进 settings.json</b>：它由 <c>SettingsService</c> 经 DPAPI 加密后单独存
    /// <c>secure.config</c>。此前这里没有忽略，于是**明文密钥同时被写进 settings.json**
    /// （实测本机就躺着一条明文 <c>sk-…</c>）—— DPAPI 那一份等于白做。
    /// </remarks>
    [JsonIgnore]
    public string? ApiKey { get; set; }

    public string? Endpoint { get; set; }
    public string? DeploymentName { get; set; }
    public string ModelId { get; set; } = "gpt-4o";
    public string? BaseUrl { get; set; }
    public int MaxTokens { get; set; } = 4096;
    public double Temperature { get; set; } = 0.7;
    public bool IsEnabled { get; set; } = true;

    public AIModelConfig Clone()
    {
        return new AIModelConfig
        {
            Id = Id,
            Name = Name,
            Provider = Provider,
            ApiKey = ApiKey,
            Endpoint = Endpoint,
            DeploymentName = DeploymentName,
            ModelId = ModelId,
            BaseUrl = BaseUrl,
            MaxTokens = MaxTokens,
            Temperature = Temperature,
            IsEnabled = IsEnabled
        };
    }

    public string DisplayName => string.IsNullOrWhiteSpace(Name) ? ModelId : Name;
}

public class AIProviderConfig
{
    public AIProvider Provider { get; set; } = AIProvider.OpenAI;

    /// <summary>同上：DPAPI 存 <c>secure.config</c>，不进 settings.json。</summary>
    [JsonIgnore]
    public string? ApiKey { get; set; }
    public string? Endpoint { get; set; }
    public string? DeploymentName { get; set; }
    public string Model { get; set; } = "gpt-4o";
    public string? BaseUrl { get; set; }
    public int MaxTokens { get; set; } = 4096;
    public double Temperature { get; set; } = 0.7;

    public AIProviderConfig Clone()
    {
        return new AIProviderConfig
        {
            Provider = Provider,
            ApiKey = ApiKey,
            Endpoint = Endpoint,
            DeploymentName = DeploymentName,
            Model = Model,
            BaseUrl = BaseUrl,
            MaxTokens = MaxTokens,
            Temperature = Temperature
        };
    }
}
