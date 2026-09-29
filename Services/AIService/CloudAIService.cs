using System;
using Diagramon.Services.Documents;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.AIService.Prompting;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Services.AIService;

/// <summary>
/// 「Diagramon 云」：走服务端网关（会员权益路径）。
/// </summary>
/// <remarks>
/// <para>
/// 与 <see cref="CustomAIService"/> 的三点不同（提示词组装、代码围栏提取**完全共用**）：
/// </para>
/// <list type="number">
/// <item><b>URL 固定</b>：服务端地址 + <c>/v1/ai/chat/completions</c>，不取用户填的 BaseUrl。</item>
/// <item><b>凭据是当前 access token</b>：每次请求现取（<c>ApiClient.AccessToken</c>），**绝不落盘** ——
/// <c>AIModelConfig.ApiKey</c> 会被明文写进 settings.json，而 access token 是**账号凭据**。</item>
/// <item><b>401 → 静默刷新一次 → 重试一次</b>：token 只有 30 分钟寿命，而客户端没有到期调度。</item>
/// </list>
/// <para>
/// 也正因第 2 条，这里**不复用 <see cref="CustomAIService"/>**：那个类的凭据来自配置字段，
/// 用它就等于把 token 交给一个会落盘的字段。
/// </para>
/// </remarks>
public sealed class CloudAIService : IAIService
{
    /// <summary>一次生成几十秒是常态（推理模型的"思考"也计入输出）—— 客户端默认的 30 秒会把正常请求判成失败。</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromMinutes(5);

    private readonly AuthenticatedSender _sender;
    private readonly AuthService _auth;
    private readonly AIModelConfig _config;

    public CloudAIService(AuthService auth, AIModelConfig config)
    {
        _auth = auth ?? throw new ArgumentNullException(nameof(auth));
        _config = config ?? throw new ArgumentNullException(nameof(config));
        // 401 → 刷新一次 → 重试一次；语义与云端文档共用同一份实现（见 AuthenticatedSender 的注释）。
        // 由 AuthService 造发送器：只有它知道 baseUrl、当前令牌与那把刷新闸门。
        _sender = auth.CreateSender();
    }

    public string ProviderName =>
        string.IsNullOrWhiteSpace(_config.Name) ? Strings.Instance.AICloudProviderName : _config.Name;

    /// <summary>已登录 + 选了别名即可用。**未登录是正常状态**，不在这里报错。</summary>
    public bool IsConfigured => _auth.Session.IsSignedIn && !string.IsNullOrWhiteSpace(_config.ModelId);

    public async Task<AIMessage> GenerateAsync(
        string prompt, string? currentCode, List<AIMessage> history, IDocumentFormat format, string? retryOf = null)
    {
        var s = Strings.Instance;

        if (!_auth.Session.IsSignedIn)
        {
            return Fail(s.AICloudSignInRequired);
        }

        if (string.IsNullOrWhiteSpace(_config.ModelId))
        {
            return Fail(s.AIConfigComplete);
        }

        var requestBody = new
        {
            // **别名**（如 mermaid-default），不是上游模型名 —— 上游模型名由服务端映射，客户端看不到
            model = _config.ModelId,
            messages = AiMessages.Build(prompt, currentCode, history, format),
            max_tokens = _config.MaxTokens,
            temperature = _config.Temperature,
        };

        var result = await _sender.SendAsync<CloudChatResponse>(
            HttpMethod.Post,
            "/v1/ai/chat/completions",
            requestBody,
            timeout: RequestTimeout,
            extraHeaders: RetryHeaders(retryOf));

        if (!result.Ok)
        {
            return Fail(AiErrorText.Describe(result.ErrorCode, result.ErrorDetail, result.Details));
        }

        var choice = result.Value?.Choices?.FirstOrDefault();
        var generatedContent = choice?.Message?.Content?.Trim() ?? string.Empty;

        return new AIMessage
        {
            Role = MessageRole.Assistant,
            Content = generatedContent,
            GeneratedCode = AiPromptCatalog.ExtractCode(generatedContent, format.Ai),
            CodeBeforeGeneration = currentCode,
            // 截断必须可见：`length` 时用户拿到的是半截代码（见 AIMessage.IsTruncated）
            FinishReason = choice?.FinishReason,
            // 账本 id：重试时回填 retry_of 用（不是 trace_id，见 AIMessage.RequestId 的 remarks）
            RequestId = result.Value?.XDiagramon?.RequestId,
            // 服务端**实际用的档**：请求发 `auto` 时它才不等于请求里的值（含图 → 识图档）
            ResolvedAlias = result.Value?.Model,
            IsLoading = false,
        };
    }

    /// <summary>服务端网关支持图片识别（V2，会员权益）。</summary>
    public bool SupportsVision => true;

    /// <summary>
    /// 图片 → 图表代码。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 与 <see cref="GenerateAsync"/> 唯一的差别是 messages 的组装方式（<c>content</c> 数组带图片块）；
    /// 鉴权、错误映射、截断标记完全一致 —— 所以这里刻意**复用同一套**发送与失败处理，
    /// 而不是复制一份"多模态版"的请求流程。
    /// </para>
    /// <para>
    /// 体积由 <c>ImagePreprocessor</c> 在调用前压好（服务端单张 base64 上限 1 MiB，超了是 400）。
    /// </para>
    /// </remarks>
    public async Task<AIMessage> GenerateFromImageAsync(
        byte[] image,
        string mediaType,
        string prompt,
        string? currentCode,
        List<AIMessage> history,
        IDocumentFormat format,
        string? retryOf = null)
    {
        var s = Strings.Instance;

        if (!_auth.Session.IsSignedIn)
        {
            return Fail(s.AICloudSignInRequired);
        }

        if (string.IsNullOrWhiteSpace(_config.ModelId))
        {
            return Fail(s.AIConfigComplete);
        }

        var dataUrl = $"data:{mediaType};base64,{Convert.ToBase64String(image)}";

        var requestBody = new
        {
            model = _config.ModelId,
            messages = AiMessages.BuildWithImage(prompt, dataUrl, currentCode, history, format),
            max_tokens = _config.MaxTokens,
            temperature = _config.Temperature,
        };

        var result = await _sender.SendAsync<CloudChatResponse>(
            HttpMethod.Post, "/v1/ai/chat/completions", requestBody, timeout: RequestTimeout);

        if (!result.Ok)
        {
            return Fail(AiErrorText.Describe(result.ErrorCode, result.ErrorDetail, result.Details));
        }

        var choice = result.Value?.Choices?.FirstOrDefault();
        var generatedContent = choice?.Message?.Content?.Trim() ?? string.Empty;

        return new AIMessage
        {
            Role = MessageRole.Assistant,
            Content = generatedContent,
            GeneratedCode = AiPromptCatalog.ExtractCode(generatedContent, format.Ai),
            CodeBeforeGeneration = currentCode,
            FinishReason = choice?.FinishReason,
            // 识图路径同样要带上这两个字段 —— 漏了它们的后果是：
            // ①「渲染报错自动修正」的重试拿不到 retry_of（账本断链）；
            // ② 用 `auto` 时界面**说不出**本次用了哪一档（识图档更贵，必须如实展示）。
            // 实测踩过：`GenerateAsync` 加了、这里漏了，纯文本能显示"用「识图」档"、识图反而不能。
            RequestId = result.Value?.XDiagramon?.RequestId,
            ResolvedAlias = result.Value?.Model,
            IsLoading = false,
        };
    }

    /// <summary>
    /// 「渲染报错自动修正」的第二次调用要带上首次的账本 id（方案 §6.10）。
    /// </summary>
    /// <remarks>
    /// 不带也不影响功能（服务端把它当可选对账信息），只是运营侧统计不到重试率 ——
    /// 所以缺 id 时**静默不发**，不要因此让重试失败。
    /// </remarks>
    private static IReadOnlyDictionary<string, string>? RetryHeaders(string? retryOf) =>
        string.IsNullOrWhiteSpace(retryOf)
            ? null
            : new Dictionary<string, string> { ["X-Diagramon-Retry-Of"] = retryOf };

    private static AIMessage Fail(string message) => new()
    {
        Role = MessageRole.Assistant,
        Content = string.Empty,
        ErrorMessage = message,
        IsLoading = false,
    };

    // ---------------------------------------------------------------- 响应 DTO
    //
    // 与 CustomAIService 同形（OpenAI 形态）；服务端还会在响应里附 x_diagramon（额度），
    // 本期不读它 —— 额度显示走 membership.ai（随登录/刷新/me 更新），不必每次生成都解析。

    private sealed class CloudChatResponse
    {
        /// <summary>服务端回显的**实际使用的别名**（请求发 <c>auto</c> 时这里是解析结果）。</summary>
        [JsonPropertyName("model")]
        public string? Model { get; set; }

        [JsonPropertyName("choices")]
        public List<CloudChoice>? Choices { get; set; }

        /// <summary>平台扩展块（额度 + 本次账本 id）。</summary>
        [JsonPropertyName("x_diagramon")]
        public CloudDiagramonBlock? XDiagramon { get; set; }
    }

    private sealed class CloudDiagramonBlock
    {
        /// <summary><c>ai_usage</c> 那一行的 id；重试时回填 <c>X-Diagramon-Retry-Of</c>。</summary>
        [JsonPropertyName("requestId")]
        public string? RequestId { get; set; }
    }

    private sealed class CloudChoice
    {
        [JsonPropertyName("message")]
        public CloudMessage? Message { get; set; }

        /// <summary>`stop` / `length` / … —— `length` 表示被截断。</summary>
        [JsonPropertyName("finish_reason")]
        public string? FinishReason { get; set; }
    }

    private sealed class CloudMessage
    {
        [JsonPropertyName("content")]
        public string? Content { get; set; }
    }
}
