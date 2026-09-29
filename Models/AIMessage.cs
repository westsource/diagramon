using System;

namespace Diagramon.Models;

public enum MessageRole
{
    User,
    Assistant
}

public class AIMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public MessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public string? GeneratedCode { get; set; }
    public string? CodeBeforeGeneration { get; set; }

    /// <summary>
    /// 生成该消息时当前标签页的文档格式 id（见 <c>DocumentFormatRegistry</c>）。
    /// </summary>
    /// <remarks>
    /// 应用代码时必须核对：用户可能生成后再切到别的格式的标签页，那时把 DOT 代码灌进 Mermaid 文档是错的。
    /// 旧会话文件里没有这个字段，反序列化后为 <c>null</c> —— 视为"不校验"，保持旧消息可用。
    /// </remarks>
    public string? FormatId { get; set; }

    public DateTime Timestamp { get; set; } = DateTime.Now;
    public bool IsLoading { get; set; }
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 上游给的结束原因（OpenAI 形态的 <c>finish_reason</c>；Ollama 是 <c>done_reason</c>）。
    /// </summary>
    /// <remarks>
    /// 存在的唯一理由是 <c>"length"</c> **必须被看见**：输出被截断时用户拿到的是一段**半截代码**
    /// —— 预览区会报语法错或画出半张图，而面板却显示"已生成"。半截代码比直接报错更糟。
    /// </remarks>
    public string? FinishReason { get; set; }

    /// <summary>是否因长度上限被截断。</summary>
    public bool IsTruncated => string.Equals(FinishReason, "length", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 服务端 <c>ai_usage</c> 那一行的 id（响应里的 <c>x_diagramon.requestId</c>）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 只有一个用途：做"渲染报错自动修正"时，第二次调用要把它放进
    /// <c>X-Diagramon-Retry-Of</c>，服务端才能把两笔账连起来（运营侧据此统计重试率，方案 §6.10）。
    /// </para>
    /// <para>
    /// <b>不能拿 <c>X-Request-Id</c> 顶替</b>：那个头是 <c>trace_id</c>（日志链路用），
    /// 与账本 id 不是同一个值 —— 用它填 retry_of 会连到一个不存在的行。
    /// BYOK provider 没有这个概念，保持 <c>null</c>。
    /// </para>
    /// </remarks>
    public string? RequestId { get; set; }

    /// <summary>
    /// 服务端**实际使用**的别名（响应的 <c>model</c> 字段）。
    /// </summary>
    /// <remarks>
    /// 请求发的是保留别名 <c>auto</c> 时，服务端会按内容选一档（含图 → 识图档）——
    /// 这个字段就是它选的结果。**必须如实展示给用户**：`auto` 可能在用户不知情时切到更贵的档，
    /// 不说出来就是欺骗（"我选的是自动"不等于"我不在乎花了多少"）。
    /// 老服务端/流式路径拿不到时为空。
    /// </remarks>
    public string? ResolvedAlias { get; set; }

    public AIMessage Clone()
    {
        return new AIMessage
        {
            Id = Id,
            Role = Role,
            Content = Content,
            GeneratedCode = GeneratedCode,
            CodeBeforeGeneration = CodeBeforeGeneration,
            FormatId = FormatId,
            Timestamp = Timestamp,
            IsLoading = IsLoading,
            ErrorMessage = ErrorMessage,
            FinishReason = FinishReason,
            RequestId = RequestId,
            ResolvedAlias = ResolvedAlias
        };
    }
}

/// <summary>把 AI 生成的代码应用回编辑器的请求。</summary>
/// <param name="Code">要写入编辑器正文的代码。</param>
/// <param name="FormatId">生成该代码时的文档格式 id；<c>null</c> = 不校验（旧会话）。</param>
public sealed record AICodeApplyRequest(string Code, string? FormatId);
