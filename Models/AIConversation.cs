using System;
using System.Collections.Generic;

namespace Diagramon.Models;

public class AIConversation
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string? FilePath { get; set; }
    public string? FileHash { get; set; }
    public List<AIMessage> Messages { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public DateTime UpdatedAt { get; set; } = DateTime.Now;

    public AIConversation Clone()
    {
        return new AIConversation
        {
            Id = Id,
            FilePath = FilePath,
            FileHash = FileHash,
            Messages = new List<AIMessage>(Messages.ConvertAll(m => m.Clone())),
            CreatedAt = CreatedAt,
            UpdatedAt = UpdatedAt
        };
    }
}
