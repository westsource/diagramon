using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Diagramon.Models;

/// <summary>
/// 读取 settings.json 中的 RecentFiles。
/// </summary>
/// <remarks>
/// 兼容旧格式：该字段曾经是 <c>List&lt;string&gt;</c>（裸路径）。
/// 不做兼容的话，老用户升级后设置文件会反序列化失败，最近文件全部丢失。
/// </remarks>
public sealed class RecentEntryListConverter : JsonConverter<List<RecentEntry>>
{
    public override List<RecentEntry> Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var result = new List<RecentEntry>();

        if (reader.TokenType != JsonTokenType.StartArray)
        {
            return result;
        }

        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            switch (reader.TokenType)
            {
                // 旧格式：裸路径字符串
                case JsonTokenType.String:
                {
                    var path = reader.GetString();
                    if (!string.IsNullOrWhiteSpace(path))
                    {
                        result.Add(new RecentEntry(new LocalDocumentLocation(path)));
                    }
                    break;
                }

                // 新格式：对象
                case JsonTokenType.StartObject:
                {
                    using var document = JsonDocument.ParseValue(ref reader);
                    var root = document.RootElement;

                    var displayPath = GetString(root, "DisplayPath");
                    if (string.IsNullOrWhiteSpace(displayPath))
                    {
                        break;
                    }

                    result.Add(new RecentEntry
                    {
                        Kind = GetString(root, "Kind") ?? "local",
                        DisplayPath = displayPath,
                        StableId = GetString(root, "StableId")
                            ?? (DocumentIdentity.Normalize(displayPath) ?? displayPath)
                    });
                    break;
                }
            }
        }

        return result;
    }

    public override void Write(
        Utf8JsonWriter writer,
        List<RecentEntry> value,
        JsonSerializerOptions options)
    {
        writer.WriteStartArray();

        foreach (var entry in value)
        {
            writer.WriteStartObject();
            writer.WriteString(nameof(RecentEntry.Kind), entry.Kind);
            writer.WriteString(nameof(RecentEntry.DisplayPath), entry.DisplayPath);
            writer.WriteString(nameof(RecentEntry.StableId), entry.StableId);
            writer.WriteEndObject();
        }

        writer.WriteEndArray();
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }
}
