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

    public AIConversation GetOrCreateConversation(string? filePath)
    {
        var fileHash = ComputeFileHash(filePath);
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
                FilePath = filePath,
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

    public void DeleteConversation(string? filePath)
    {
        var fileHash = ComputeFileHash(filePath);
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

    public void AddMessage(string? filePath, AIMessage message)
    {
        var conversation = GetOrCreateConversation(filePath);
        conversation.Messages.Add(message);
        SaveConversation(conversation);
    }

    public void UpdateMessage(string? filePath, AIMessage message)
    {
        var conversation = GetOrCreateConversation(filePath);
        var index = conversation.Messages.FindIndex(m => m.Id == message.Id);
        if (index >= 0)
        {
            conversation.Messages[index] = message;
            SaveConversation(conversation);
        }
    }

    public void ClearConversation(string? filePath)
    {
        var conversation = GetOrCreateConversation(filePath);
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

    private string? ComputeFileHash(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath)) return null;

        try
        {
            var normalizedPath = Path.GetFullPath(filePath).ToLowerInvariant();
            using var sha256 = SHA256.Create();
            var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(normalizedPath));
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
