using System.Text.Json;

namespace Diagramon.Services.Embedded;

/// <summary>
/// 内嵌承载面与 C# 之间的两条约定脚本（drawio / Excalidraw 共用）。
/// </summary>
/// <remarks>
/// <para>
/// 为什么是"轮询队列"而不是消息事件：宿主只要能执行脚本就能工作。
/// <c>ExecuteScriptAsync</c> 在所有路径上都已验证可用，而包装层的消息事件在不同版本间形态不一，
/// 依赖它会把承载面绑死在某个 WebView 版本上。
/// </para>
/// <para>
/// 页面向 <c>window.__hostQueue</c> 追加 JSON 字符串，宿主取走即清空（数组元素是**字符串**，
/// 不是对象）；宿主向页面投递则执行 <c>window.__apply(&lt;JSON 字符串字面量&gt;)</c>。
/// </para>
/// </remarks>
internal static class EmbeddedProtocol
{
    /// <summary>取走队列并清空（队列为空返回 <c>[]</c>）。</summary>
    /// <remarks>
    /// 用 <c>splice</c> 而不是"换成新数组"：承载页可能持有队列数组的引用（例如页面加载时就
    /// <c>const q = []</c> 并把它挂到 <c>window.__hostQueue</c>），替换数组会让页面后续的 push
    /// 全部落进孤儿数组、事件静默丢失。这条坑在 Excalidraw 承载页上实际踩到过。
    /// </remarks>
    public const string DrainQueueScript =
        "(() => { const q = window.__hostQueue; if (!Array.isArray(q)) { return '[]'; } return JSON.stringify(q.splice(0, q.length)); })()";

    /// <summary>页面自报已就绪的探测表达式。</summary>
    public const string ReadyProbeScript = "typeof window.__apply === 'function'";

    /// <summary>把一条指令（对象）投给页面。</summary>
    public static string DeliverScript(object command)
    {
        var json = JsonSerializer.Serialize(command, new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });

        return $"window.__apply({JsonSerializer.Serialize(json)})";
    }
}