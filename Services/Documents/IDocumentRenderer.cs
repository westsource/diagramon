using System.Collections.Generic;

namespace Diagramon.Services.Documents;

/// <summary>
/// 渲染器资源从哪来（方案 §4.1.1）。**必须是数据而不是代码** ——
/// 让"随包 JS"与"npm 拉取的 WASM"两种供给方式走同一套加载约定。
/// </summary>
public enum RendererProvision
{
    /// <summary>仓库内随包分发的 JS（Mermaid：<c>Assets/mermaid.min.js</c>），承载页走 <c>file://</c>。</summary>
    BundledJs,

    /// <summary>构建脚本从 npm 拉取的 WASM 包（DOT：<c>tools/graphviz</c>），承载页必须走真实 origin。</summary>
    NpmWasm,

    /// <summary>需自行构建后放入的产物。</summary>
    PrebuiltArtifact,

    /// <summary>不走预览路径（drawio 走独立 WebView 的 EmbeddedApp）。</summary>
    None,
}

/// <summary>渲染参数。DOT 只用到 <see cref="Layout"/>；Mermaid 全为默认值。</summary>
public sealed record RenderOptions(
    double Scale = 1.0,
    bool Transparent = true,
    string? Theme = null,
    string? Layout = null);

/// <summary>渲染器返回的位图结果。</summary>
public sealed record RendererResult(bool Success, byte[]? Data, string? Error);

/// <summary>
/// 承载页面需要的静态资源：把 <paramref name="Source"/> 落到承载目录下的 <paramref name="TargetFileName"/>。
/// </summary>
/// <param name="TargetFileName">相对承载目录的文件名，如 <c>mermaid.min.js</c>。</param>
/// <param name="Source">来源：<c>avares://</c> 资源 URI 或绝对文件路径。</param>
public sealed record RendererAsset(string TargetFileName, string Source);

/// <summary>
/// 文档渲染器（方案 §8.2.3 / §8.3.2）。
/// </summary>
/// <remarks>
/// <b>为什么建页与增量更新是两个方法</b>：DOT 的页面里要加载 WASM，每次改内容都重建 HTML
/// 会把 WASM 重载一遍；因此增量路径是接口的一等公民，不是可选优化。
/// 渲染器**不碰 WebView**，只产出页面文本与脚本；落盘、origin、导航由承载层负责。
/// </remarks>
public interface IDocumentRenderer
{
    /// <summary>资源供给方式。</summary>
    RendererProvision Provision { get; }

    /// <summary>
    /// 首次载入 / 切换到该格式时的整页 HTML（已含初始内容的首帧渲染调用）。
    /// </summary>
    /// <remarks>
    /// 首帧渲染写进页面而不是靠载入后再执行脚本：WebView 的"页面已加载完成"判据目前不可靠，
    /// 载入后立刻执行脚本会在渲染器尚未就绪时静默失败。
    /// </remarks>
    string BuildSurfaceHtml(string source, RenderOptions options);

    /// <summary>
    /// 承载页"已就绪"的探测表达式（一个 JS 表达式，返回布尔）。
    /// </summary>
    /// <remarks>
    /// 导航完成 ≠ 页面脚本可用：换格式导航后页面还在加载，这时注入更新脚本会打进**上一个**页面。
    /// 由渲染器自己回答"我的页面起来了吗"，是唯一不需要猜的判据。
    /// </remarks>
    string BuildReadyProbeScript();

    /// <summary>内容变化时的增量更新脚本（不重建页面、不重载渲染器）。</summary>
    string BuildUpdateScript(string source, RenderOptions options);

    /// <summary>
    /// 页面内栅格化为 PNG 的脚本；返回 <c>null</c> 表示该渲染器不支持页面内导出
    /// （Mermaid 走 <c>mmdc</c> 子进程，本期不动，见决策 3）。
    /// </summary>
    /// <remarks>
    /// 脚本执行后必须把 <c>window.__export</c> 置为
    /// <c>{ ok: true, dataUri: "data:image/png;base64,…", width, height }</c> 或
    /// <c>{ ok: false, error: "…" }</c>；承载层轮询该变量取值。
    /// 脚本内部要自带"等待渲染器就绪"的循环，因为无法保证执行时机晚于页面脚本加载。
    /// </remarks>
    string? BuildExportScript(string source, RenderOptions options);

    /// <summary>
    /// <see cref="RendererProvision.BundledJs"/> 需要随包落盘的资源；其它供给方式返回空列表。
    /// </summary>
    IReadOnlyList<RendererAsset> Assets { get; }

    /// <summary>
    /// <see cref="RendererProvision.NpmWasm"/> 需要在真实 origin 下提供的资源目录（绝对路径）；
    /// 承载层把它挂在 <c>/renderer/</c> 前缀下，因此页面里引用 <c>/renderer/graphviz.js</c>。
    /// 其它供给方式返回 <c>null</c>。
    /// </summary>
    string? OriginAssetsDirectory { get; }
}