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

    /// <summary>
    /// 上游回话里的 <c>message</c>。**故意不是 <c>string</c>**：drawio 在 <c>error</c> 事件里发字符串，
    /// 但在 <c>autosave</c> / <c>export</c> / <c>fit</c> 等事件里把**原始请求对象**原样回带
    /// （<c>{"action":"load","xml":…}</c>）。按字符串反序列化会在这些事件上抛异常，
    /// 而调用方对反序列化失败的做法是"丢弃这条载荷" —— 于是 autosave 回写与 export/flush 的回话
    /// 全部静默丢失（画布上的改动永远进不了正文）。取值一律走 <see cref="MessageText"/>。
    /// </summary>
    [JsonPropertyName("message")]
    public JsonElement? Message { get; set; }

    /// <summary><c>message</c> 是字符串时的文本（错误提示用）；对象形态返回 <c>null</c>。</summary>
    public string? MessageText =>
        Message is { ValueKind: JsonValueKind.String } element ? element.GetString() : null;

    /// <summary>承载页转发的应用级快捷键组合（<c>hotkey</c> 事件）。</summary>
    [JsonPropertyName("combo")]
    public string? Combo { get; set; }

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

    /// <summary>
    /// 要回画布当前的 XML（落盘前的 flush 用）。
    /// </summary>
    /// <remarks>
    /// drawio 的 embed 导出用同一个 <c>export</c> 动作 + <c>format</c> 区分产物；<c>xml</c> 这一档
    /// 走的是 <c>getFileData</c>，与它自己 autosave 发出的字符串实测**逐字节相同**，
    /// 因此拿它回写正文与 autosave 完全同源，只是不必等 1.5s 去抖。
    /// 回话同样走 <c>export</c> 事件，靠 <c>format</c> 与位图导出区分（见 DrawioDocumentHost.HandlePayload）。
    /// </remarks>
    public static DrawioAction ExportXml() => new() { Action = "export", Format = "xml" };
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
