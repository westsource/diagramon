using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Diagramon.Models;

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

    public async Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history)
    {
        var baseUrl = string.IsNullOrWhiteSpace(_config.BaseUrl) ? DefaultBaseUrl : _config.BaseUrl.TrimEnd('/');
        var messages = BuildMessages(prompt, currentCode, history);

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
            var mermaidCode = ExtractMermaidCode(generatedContent);

            return new AIMessage
            {
                Role = MessageRole.Assistant,
                Content = generatedContent,
                GeneratedCode = mermaidCode,
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

    private List<object> BuildMessages(string prompt, string? currentCode, List<AIMessage> history)
    {
        var messages = new List<object>();

        var systemPrompt = BuildSystemPrompt(currentCode);
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

    private string BuildSystemPrompt(string? currentCode)
    {
        var prompt = @"你是一个专业的 Mermaid 图表代码生成助手。你的任务是根据用户的自然语言描述生成或修改 Mermaid 代码。

规则：
1. 只返回 Mermaid 代码，不要包含其他解释文字
2. 代码必须符合 Mermaid 语法规范
3. 如果用户要求修改现有代码，请基于现有代码进行修改
4. 如果用户描述不清晰，生成一个合理的默认图表
5. 支持的图表类型：流程图、时序图、类图、状态图、甘特图、饼图、ER图等

返回格式：直接返回 Mermaid 代码，不要使用代码块标记。";

        if (!string.IsNullOrWhiteSpace(currentCode))
        {
            prompt += $"\n\n当前 Mermaid 代码：\n{currentCode}";
        }

        return prompt;
    }

    private string? ExtractMermaidCode(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
            return null;

        var codeBlockMatch = System.Text.RegularExpressions.Regex.Match(content, @"```\s*(?:mermaid)?\s*([\s\S]*?)```");
        if (codeBlockMatch.Success)
        {
            return codeBlockMatch.Groups[1].Value.Trim();
        }

        var trimmed = content.Trim();
        if (trimmed.StartsWith("graph ") || trimmed.StartsWith("sequenceDiagram") ||
            trimmed.StartsWith("classDiagram") || trimmed.StartsWith("stateDiagram") ||
            trimmed.StartsWith("gantt") || trimmed.StartsWith("pie") ||
            trimmed.StartsWith("erDiagram") || trimmed.StartsWith("flowchart"))
        {
            return trimmed;
        }

        return trimmed;
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
