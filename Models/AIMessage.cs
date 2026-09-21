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
            ErrorMessage = ErrorMessage
        };
    }
}

/// <summary>把 AI 生成的代码应用回编辑器的请求。</summary>
/// <param name="Code">要写入编辑器正文的代码。</param>
/// <param name="FormatId">生成该代码时的文档格式 id；<c>null</c> = 不校验（旧会话）。</param>
public sealed record AICodeApplyRequest(string Code, string? FormatId);
