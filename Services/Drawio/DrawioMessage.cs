using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using Diagramon.Services.Documents;

namespace Diagramon.Services.Drawio;

/// <summary>
/// drawio 的 embed 模式是**活文档**（字段随版本增加），因此这里只声明我们用到的字段，
/// 其余一律忽略 —— 反序列化对未知字段宽容，避免上游加字段就把适配层打爆（方案 §6.3）。
/// </summary>
internal sealed class DrawioEvent
{
    [JsonPropertyName("event")]
    public string Event { get; set; } = string.Empty;

    [JsonPropertyName("xml")]
    public string? Xml { get; set; }

    [JsonPropertyName("data")]
    public string? Data { get; set; }

    [JsonPropertyName("format")]
    public string? Format { get; set; }

    [JsonPropertyName("exit")]
    public bool? Exit { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    /// <summary>上游错误事件里携带的协议版本/描述等附加字段，原样保留便于诊断。</summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? Extra { get; set; }
}

internal sealed class DrawioAction
{
    [JsonPropertyName("action")]
    public string Action { get; set; } = string.Empty;

    [JsonPropertyName("xml")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Xml { get; set; }

    [JsonPropertyName("autosave")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Autosave { get; set; }

    [JsonPropertyName("format")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Format { get; set; }

    [JsonPropertyName("scale")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Scale { get; set; }

    [JsonPropertyName("transparent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Transparent { get; set; }

    /// <summary>把 Mermaid 源码作为输入交给 drawio 的解析器（方案 §3.2.2 / §4.5）。</summary>
    [JsonPropertyName("descriptor")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DrawioDescriptor? Descriptor { get; set; }

    public static DrawioAction Load(string xml) => new() { Action = "load", Xml = xml, Autosave = 1 };

    public static DrawioAction LoadMermaid(string source, bool wrap = true) => new()
    {
        Action = "load",
        Autosave = 1,
        Descriptor = new DrawioDescriptor { Format = "mermaid", Data = source, Wrap = wrap },
    };

    public static DrawioAction Export(string format, double scale, bool transparent) => new()
    {
        Action = "export",
        Format = format,
        Scale = scale,
        Transparent = transparent,
    };

    public static DrawioAction Fit() => new() { Action = "fit" };
}

internal sealed class DrawioDescriptor
{
    [JsonPropertyName("format")]
    public string Format { get; set; } = string.Empty;

    [JsonPropertyName("data")]
    public string Data { get; set; } = string.Empty;

    [JsonPropertyName("wrap")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Wrap { get; set; }
}

/// <summary>
/// 外壳页 ↔ C# 之间的两条脚本已抽到 <see cref="Embedded.EmbeddedProtocol"/>（drawio 与 Excalidraw 共用），
/// 本文件只保留 drawio 自己的消息载荷类型。
/// </summary>
