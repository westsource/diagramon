using System;
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

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, string formatId)
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
        var messages = BuildMessages(prompt, currentCode, history, formatId);

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
            var diagramCode = AiPromptCatalog.ExtractCode(generatedContent, formatId);

            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = generatedContent,
                GeneratedCode = diagramCode,
                CodeBeforeGeneration = currentCode,
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

    private List<object> BuildMessages(string prompt, string? currentCode, List<AIMessage> history, string formatId)
    {
        var messages = new List<object>();

        var systemPrompt = AiPromptCatalog.SystemPromptFor(formatId, currentCode);
        messages.Add(new { role = "system", content = systemPrompt });

        foreach (var msg in history)
        {
            if (msg.Role == MessageRole.User)
            {
                messages.Add(new { role = "user", content = msg.Content });
            }
            else if (msg.Role == MessageRole.Assistant && !string.IsNullOrWhiteSpace(msg.GeneratedCode))
            {
                messages.Add(new { role = "assistant", content = $"这是生成的 Mermaid 代码：\n```\n{msg.GeneratedCode}\n```" });
            }
        }

        messages.Add(new { role = "user", content = prompt });

        return messages;
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
