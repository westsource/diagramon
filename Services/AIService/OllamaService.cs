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

public class OllamaService : IAIService
{
    private readonly AIProviderConfig _config;
    private readonly HttpClient _httpClient;

    public string ProviderName => "Ollama";
    public bool IsConfigured => true;

    private static readonly string DefaultBaseUrl = "http://localhost:11434";

    public OllamaService(AIProviderConfig config)
    {
        _config = config ?? throw new ArgumentNullException(nameof(config));
        _httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
    }

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, string formatId)
    {
        var baseUrl = string.IsNullOrWhiteSpace(_config.BaseUrl) ? DefaultBaseUrl : _config.BaseUrl.TrimEnd('/');
        var messages = BuildMessages(prompt, currentCode, history, formatId);

        var requestBody = new
        {
            model = _config.Model,
            messages = messages,
            stream = false,
            options = new
            {
                temperature = _config.Temperature,
                num_predict = _config.MaxTokens
            }
        };

        var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/chat");
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

            var result = JsonSerializer.Deserialize<OllamaResponse>(responseContent, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            var generatedContent = result?.Message?.Content?.Trim() ?? string.Empty;
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
                ErrorMessage = $"无法连接到 Ollama 服务 ({baseUrl})。请确保 Ollama 已启动并运行。错误: {ex.Message}",
                IsLoading = false
            };
        }
        catch (TaskCanceledException)
        {
            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = string.Empty,
                ErrorMessage = "请求超时，请检查 Ollama 服务状态或尝试使用更小的模型",
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
            var error = JsonSerializer.Deserialize<OllamaError>(responseContent, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
            return error?.Error;
        }
        catch
        {
            return null;
        }
    }

    private class OllamaResponse
    {
        [JsonPropertyName("message")]
        public OllamaMessage? Message { get; set; }
    }

    private class OllamaMessage
    {
        [JsonPropertyName("content")]
        public string? Content { get; set; }
    }

    private class OllamaError
    {
        [JsonPropertyName("error")]
        public string? Error { get; set; }
    }
}
