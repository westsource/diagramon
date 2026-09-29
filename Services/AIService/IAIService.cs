using System.Collections.Generic;
using System.Threading.Tasks;

using Diagramon.Models;
using Diagramon.Services.Documents;

namespace Diagramon.Services.AIService;

public interface IAIService
{
    string ProviderName { get; }
    bool IsConfigured { get; }

    /// <summary>
    /// 是否支持「图片 → 图表代码」（V2）。
    /// </summary>
    /// <remarks>
    /// **只有服务端网关支持**：图片识别是会员权益，也是唯一需要"客户端上传图片"的路径 ——
    /// 四个 BYOK provider 的 Key 是用户自己的，没有理由把图往他们的端点送。
    /// 界面靠这个开关决定「识图」按钮是否可用，而不是靠 provider 名字硬编码。
    /// </remarks>
    bool SupportsVision => false;

    /// <param name="retryOf">
    /// 本次是"渲染报错自动修正"的第二次调用时，传首次调用返回的 <see cref="AIMessage.RequestId"/>。
    /// 服务端据此写 <c>ai_usage.retry_of</c>，运营侧才能统计重试率（方案 §6.10）。
    /// <c>null</c> = 不是重试。
    /// </param>
    Task<AIMessage> GenerateAsync(
        string prompt,
        string? currentCode,
        List<AIMessage> history,
        IDocumentFormat format,
        string? retryOf = null);

    /// <summary>
    /// 用一张图片生成/逆向出图表代码。
    /// </summary>
    /// <remarks>
    /// 默认实现<b>不抛异常，而是返回一条带 <see cref="AIMessage.ErrorMessage"/> 的消息</b>：
    /// 面板本来就是靠 <c>ErrorMessage</c> 展示失败的，抛异常会让"不支持"变成一条没人处理的崩溃。
    /// 给默认实现也让那四个 provider **一行都不用改** —— 加方法的代价不该由无关实现承担。
    /// </remarks>
    /// <param name="image">已压到服务端上限内的原图字节。</param>
    /// <param name="mediaType">如 <c>image/png</c>（由 <c>ImagePreprocessor</c> 决定）。</param>
    /// <param name="prompt">用户的附加说明（可以为空）。</param>
    Task<AIMessage> GenerateFromImageAsync(
        byte[] image,
        string mediaType,
        string prompt,
        string? currentCode,
        List<AIMessage> history,
        IDocumentFormat format,
        string? retryOf = null) =>
        Task.FromResult(new AIMessage
        {
            Role = MessageRole.Assistant,
            Content = string.Empty,
            ErrorMessage = "该 provider 不支持图片识别（这是会员权益，请切换到「Diagramon 云」）",
            IsLoading = false,
        });
}
