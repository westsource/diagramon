namespace Diagramon.Models;

public enum AIProvider
{
    OpenAI,
    AzureOpenAI,
    Ollama,
    Custom
}

public class AIModelConfig
{
    public string Id { get; set; } = System.Guid.NewGuid().ToString();
    public string Name { get; set; } = "新模型";
    public AIProvider Provider { get; set; } = AIProvider.Custom;
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
