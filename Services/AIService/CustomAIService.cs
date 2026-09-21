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

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, string formatId)
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
        var messages = BuildMessages(prompt, currentCode, history, formatId);

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
