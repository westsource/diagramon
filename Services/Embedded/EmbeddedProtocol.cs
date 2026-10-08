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

    /// <summary>
    /// 承载页缩放比例探测：返回画布当前缩放（<c>1</c> = 100%），拿不到时返回 <c>0</c>。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 承载页可选实现 <c>window.__hostZoom</c>；返回 <c>0</c> 表示"没有新值"，宿主保留上一次读数
    /// （不要把状态栏的百分比抖成 0）。
    /// </para>
    /// <para>
    /// 刻意返回**数字**：<c>ExecuteScriptAsync</c> 对字符串返回值会再包一层 JSON 引号
    /// （见 <see cref="WebViewBridge.ExecuteStringScriptAsync"/> 的注释），数字没有这一层。
    /// </para>
    /// <para>
    /// 为什么需要它：四处视图（Mermaid / DOT 预览面 + drawio / Excalidraw 画布）的缩放读数统一到
    /// 状态栏，而两个画布各自的读数 UI 已被隐藏 —— 没有这条回报，"统一读数"就没有数据来源。
    /// </para>
    /// </remarks>
    public const string ZoomProbeScript =
        "(() => { const probe = window.__hostZoom; if (typeof probe !== 'function') { return 0; } const value = Number(probe()); return Number.isFinite(value) && value > 0 ? value : 0; })()";

    /// <summary>把一条指令（对象）投给页面。</summary>
    public static string DeliverScript(object command)
    {
        var json = JsonSerializer.Serialize(command, new JsonSerializerOptions
        {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });

        return $"window.__apply({JsonSerializer.Serialize(json)})";
    }

    /// <summary>
    /// 让承载页按倍率缩放画布（应用级"放大 / 缩小"命令落到画布时的落点）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 承载页可选实现 <c>window.__hostZoomBy(factor)</c>：drawio 侧换算成等效的"合成 Ctrl+滚轮"
    /// 走它自己的缩放逻辑（含它自己的范围与锚点处理），Excalidraw 侧走 <c>updateScene</c>。
    /// </para>
    /// <para>
    /// 为什么不让 C# 直接算好绝对缩放：两家的缩放范围不同（drawio 5%–1600%、Excalidraw 10%–3000%）、
    /// 锚点与滚动状态也各在页面里，宿主算不了 —— 只传"相对倍率"这一个数字，剩下交给页面。
    /// </para>
    /// </remarks>
    public static string ZoomByScript(double factor)
    {
        var literal = factor.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture);
        return $"window.__hostZoomBy({literal})";
    }

    /// <summary>
    /// 让承载页执行它自己的"适应视图"（应用级 Ctrl+0 落到画布时的落点）。
    /// </summary>
    /// <remarks>
    /// 与 <see cref="ZoomByScript"/> 同一条路：承载页实现 <c>window.__hostFit</c>。
    /// 为什么不用各家的协议动作：drawio 的 embed <c>fit</c> 动作 fit 的是**内容框**
    /// （页面里只有一个小图形时会放大到几十倍），而它自己的 Fit Page 只挂在快捷键上 ——
    /// 承载页里用合成按键走那条路（见 tools/drawio-host/host.html 的 <c>__hostFit</c> 注释）。
    /// </remarks>
    public const string FitScript = "window.__hostFit()";
}