using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Diagramon.Models;

namespace Diagramon.Services;

public class AIConversationService
{
    private string _storagePath;
    private readonly Dictionary<string, AIConversation> _cache = new();

    public AIConversationService(string? customStoragePath = null)
    {
        _storagePath = customStoragePath ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Diagramon",
            "Conversations"
        );

        EnsureDirectoryExists();
    }

    /// <summary>
    /// 取（或建）某个文档的对话。入参是**稳定身份**（<c>IDocumentLocation.StableId</c>）而不是文件路径：
    /// 本地身份 = 规范化路径，云端身份 = 服务端文档 id，两者都直接进 sha256 当作存档文件名。
    /// </summary>
    /// <remarks>
    /// 改造前这里自己把路径 <c>GetFullPath().ToLowerInvariant()</c> 再哈希；
    /// 规范化上移到 <c>DocumentIdentity.Normalize</c> 后，本地场景的哈希**逐字节不变**，已有会话文件无需迁移。
    /// </remarks>
    public AIConversation GetOrCreateConversation(string? stableId)
    {
        var fileHash = ComputeFileHash(stableId);
        var cacheKey = fileHash ?? "default";

        if (_cache.TryGetValue(cacheKey, out var cached))
        {
            return cached;
        }

        var conversation = LoadConversation(fileHash);
        if (conversation == null)
        {
            conversation = new AIConversation
            {
                Id = Guid.NewGuid().ToString(),
                FilePath = stableId,
                FileHash = fileHash,
                Messages = new List<AIMessage>(),
                CreatedAt = DateTime.Now,
                UpdatedAt = DateTime.Now
            };
        }

        _cache[cacheKey] = conversation;
        return conversation;
    }

    public void SaveConversation(AIConversation conversation)
    {
        if (conversation == null) return;

        conversation.UpdatedAt = DateTime.Now;

        var fileHash = conversation.FileHash ?? "default";
        var filePath = Path.Combine(_storagePath, $"{fileHash}.json");

        try
        {
            var json = JsonSerializer.Serialize(conversation, new JsonSerializerOptions
            {
                WriteIndented = true
            });
            File.WriteAllText(filePath, json);

            var cacheKey = fileHash;
            _cache[cacheKey] = conversation;
        }
        catch
        {
        }
    }

    public void DeleteConversation(string? stableId)
    {
        var fileHash = ComputeFileHash(stableId);
        if (string.IsNullOrEmpty(fileHash)) return;

        var conversationPath = Path.Combine(_storagePath, $"{fileHash}.json");
        try
        {
            if (File.Exists(conversationPath))
            {
                File.Delete(conversationPath);
            }
            _cache.Remove(fileHash);
        }
        catch
        {
        }
    }

    public void AddMessage(string? stableId, AIMessage message)
    {
        var conversation = GetOrCreateConversation(stableId);
        conversation.Messages.Add(message);
        SaveConversation(conversation);
    }

    public void UpdateMessage(string? stableId, AIMessage message)
    {
        var conversation = GetOrCreateConversation(stableId);
        var index = conversation.Messages.FindIndex(m => m.Id == message.Id);
        if (index >= 0)
        {
            conversation.Messages[index] = message;
            SaveConversation(conversation);
        }
    }

    public void ClearConversation(string? stableId)
    {
        var conversation = GetOrCreateConversation(stableId);
        conversation.Messages.Clear();
        conversation.UpdatedAt = DateTime.Now;
        SaveConversation(conversation);
    }

    public List<AIConversation> GetAllConversations()
    {
        var conversations = new List<AIConversation>();

        try
        {
            if (!Directory.Exists(_storagePath)) return conversations;

            foreach (var file in Directory.GetFiles(_storagePath, "*.json"))
            {
                try
                {
                    var json = File.ReadAllText(file);
                    var conversation = JsonSerializer.Deserialize<AIConversation>(json);
                    if (conversation != null)
                    {
                        conversations.Add(conversation);
                    }
                }
                catch
                {
                }
            }
        }
        catch
        {
        }

        return conversations.OrderByDescending(c => c.UpdatedAt).ToList();
    }

    public void SetStoragePath(string newPath)
    {
        if (string.IsNullOrWhiteSpace(newPath)) return;

        _storagePath = newPath;
        _cache.Clear();
        EnsureDirectoryExists();
    }

    private AIConversation? LoadConversation(string? fileHash)
    {
        if (string.IsNullOrEmpty(fileHash)) return null;

        var filePath = Path.Combine(_storagePath, $"{fileHash}.json");

        try
        {
            if (File.Exists(filePath))
            {
                var json = File.ReadAllText(filePath);
                return JsonSerializer.Deserialize<AIConversation>(json);
            }
        }
        catch
        {
        }

        return null;
    }

    /// <summary>
    /// 稳定身份 → 会话存档文件名。**不做路径规范化** —— 规范化由 <c>DocumentIdentity.Normalize</c>
    /// 在构造 <c>StableId</c> 时完成，这里再规范化一次对云端身份（服务端 id）是错的（会被当成相对路径解析）。
    /// 非法/空身份返回 <c>null</c>，落进原来的 <c>default</c> 桶。
    /// </summary>
    private static string? ComputeFileHash(string? stableId)
    {
        if (string.IsNullOrWhiteSpace(stableId)) return null;

        try
        {
            using var sha256 = SHA256.Create();
            var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(stableId));
            return Convert.ToHexString(bytes).ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }

    private void EnsureDirectoryExists()
    {
        try
        {
            if (!Directory.Exists(_storagePath))
            {
                Directory.CreateDirectory(_storagePath);
            }
        }
        catch
        {
        }
    }
}
