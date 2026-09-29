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

public class CustomAIService : IAIService
{
    private readonly AIModelConfig _config;
    private readonly HttpClient _httpClient;

    public string ProviderName => _config?.Name ?? "Custom";
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_config?.BaseUrl) && !string.IsNullOrWhiteSpace(_config?.ModelId);

    public CustomAIService(AIModelConfig config)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
    }

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, IDocumentFormat format, string? retryOf = null)
    {
        if (!IsConfigured)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = "模型配置不完整，请检查 Base URL 和 Model ID",
                IsLoading = false
            };
        }

        var baseUrl = _config.BaseUrl!.TrimEnd('/');
        var messages = AiMessages.Build(prompt, currentCode, history, format);

        var requestBody = new
        {
            model = _config.ModelId,
            messages = messages,
            max_tokens = _config.MaxTokens,
            temperature = _config.Temperature
        };

        var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/chat/completions");
        
        if (!string.IsNullOrWhiteSpace(_config.ApiKey))
        {
            request.Headers.Add("Authorization", $"Bearer {_config.ApiKey}");
        }
        
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
        catch (HttpRequestException ex)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = $"无法连接到服务 ({baseUrl})。错误: {ex.Message}",
                IsLoading = false
            };
        }
        catch (TaskCanceledException)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = "请求超时，请检查服务状态或尝试使用更小的模型",
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

        /// <summary>`stop` / `length` / … —— `length` 表示被截断（必须让用户看见，见 AIMessage.IsTruncated）。</summary>
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
