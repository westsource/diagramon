using System;
using Diagramon.Services.Documents;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.AIService.Prompting;

namespace Diagramon.Services.AIService;

public class OpenAIService : IAIService
{
    private readonly AIProviderConfig _config;
    private readonly HttpClient _httpClient;

    public string ProviderName => "OpenAI";
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_config.ApiKey);

    private static readonly string DefaultBaseUrl = "https://api.openai.com/v1";

    public OpenAIService(AIProviderConfig config)
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
                ErrorMessage = "API Key 未配置，请在设置中配置 OpenAI API Key",
                IsLoading = false
            };
        }

        var baseUrl = string.IsNullOrWhiteSpace(_config.BaseUrl) ? DefaultBaseUrl : _config.BaseUrl.TrimEnd('/');
        var messages = AiMessages.Build(prompt, currentCode, history, format);

        var requestBody = new
        {
            model = _config.Model,
            messages = messages,
            max_tokens = _config.MaxTokens,
            temperature = _config.Temperature
        };

        var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/chat/completions");
        request.Headers.Add("Authorization", $"Bearer {_config.ApiKey}");
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

            var result = JsonSerializer.Deserialize<OpenAIResponse>(responseContent, new JsonSerializerOptions
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
            var error = JsonSerializer.Deserialize<OpenAIError>(responseContent, new JsonSerializerOptions
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

    private class OpenAIResponse
    {
        [JsonPropertyName("choices")]
        public List<OpenAIChoice>? Choices { get; set; }
    }

    private class OpenAIChoice
    {
        [JsonPropertyName("message")]
        public OpenAIMessage? Message { get; set; }

        /// <summary>`stop` / `length` / … —— `length` 表示被截断。</summary>
        [JsonPropertyName("finish_reason")]
        public string? FinishReason { get; set; }
    }

    private class OpenAIMessage
    {
        [JsonPropertyName("content")]
        public string? Content { get; set; }
    }

    private class OpenAIError
    {
        [JsonPropertyName("error")]
        public OpenAIErrorDetail? Error { get; set; }
    }

    private class OpenAIErrorDetail
    {
        [JsonPropertyName("message")]
        public string? Message { get; set; }
    }
}
