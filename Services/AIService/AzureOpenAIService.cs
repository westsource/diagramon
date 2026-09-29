using System;
using Diagramon.Services.Documents;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.AIService.Prompting;

namespace Diagramon.Services.AIService;

public class AzureOpenAIService : IAIService
{
    private readonly AIProviderConfig _config;
    private readonly HttpClient _httpClient;

    public string ProviderName => "Azure OpenAI";
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_config.ApiKey) &&
                                !string.IsNullOrWhiteSpace(_config.Endpoint) &&
                                !string.IsNullOrWhiteSpace(_config.DeploymentName);

    public AzureOpenAIService(AIProviderConfig config)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _httpClient = new HttpClient();
    }

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, IDocumentFormat format, string? retryOf = null)
    {
        if (!IsConfigured)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = "Azure OpenAI 配置不完整，请检查 Endpoint、Deployment Name 和 API Key",
                IsLoading = false
            };
        }

        var endpoint = _config.Endpoint!.TrimEnd('/');
        var url = $"{endpoint}/openai/deployments/{_config.DeploymentName}/chat/completions?api-version=2024-02-15-preview";
        var messages = AiMessages.Build(prompt, currentCode, history, format);

        var requestBody = new
        {
            messages = messages,
            max_tokens = _config.MaxTokens,
            temperature = _config.Temperature
        };

        var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Add("api-key", _config.ApiKey);
        request.Content = new StringContent(JsonSerializer.Serialize(requestBody), Encoding.UTF8, "application/json");

        try
        {
            var response = await _httpClient.SendAsync(request);
            var responseContent = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                var errorMessage = ExtractErrorMessage(responseContent) ?? $"HTTP {(int)response.StatusCode}: {response.ReasonPhrase}";
                return new AIMessage
                {
                    Role = MessageRole.Assistant,
                    Content = string.Empty,
                    ErrorMessage = errorMessage,
                    IsLoading = false
                };
            }

            var result = JsonSerializer.Deserialize<AzureOpenAIResponse>(responseContent, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            var generatedContent = result?.Choices?[0]?.Message?.Content?.Trim() ?? string.Empty;
            var diagramCode = AiPromptCatalog.ExtractCode(generatedContent, format.Ai);

            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = generatedContent,
                GeneratedCode = diagramCode,
                CodeBeforeGeneration = currentCode,
                FinishReason = result?.Choices?[0]?.FinishReason,
                IsLoading = false
            };
        }
        catch (Exception ex)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = $"请求失败: {ex.Message}",
                IsLoading = false
            };
        }
    }

    private string? ExtractErrorMessage(string responseContent)
    {
        try
        {
            var error = JsonSerializer.Deserialize<AzureOpenAIError>(responseContent, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            return error?.Error?.Message;
        }
        catch
        {
            return null;
        }
    }

    private class AzureOpenAIResponse
    {
        [JsonPropertyName("choices")]
        public List<AzureOpenAIChoice>? Choices { get; set; }
    }

    private class AzureOpenAIChoice
    {
        [JsonPropertyName("message")]
        public AzureOpenAIMessage? Message { get; set; }

        /// <summary>`stop` / `length` / … —— `length` 表示被截断。</summary>
        [JsonPropertyName("finish_reason")]
        public string? FinishReason { get; set; }
    }

    private class AzureOpenAIMessage
    {
        [JsonPropertyName("content")]
        public string? Content { get; set; }
    }

    private class AzureOpenAIError
    {
        [JsonPropertyName("error")]
        public AzureOpenAIErrorDetail? Error { get; set; }
    }

    private class AzureOpenAIErrorDetail
    {
        [JsonPropertyName("message")]
        public string? Message { get; set; }
    }
}
