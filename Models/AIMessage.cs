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
            Timestamp = Timestamp,
            IsLoading = IsLoading,
            ErrorMessage = ErrorMessage
        };
    }
}
