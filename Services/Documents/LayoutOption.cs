namespace Diagramon.Services.Documents;

/// <summary>
/// 某个格式可选的一种布局（方案 §8.2.2）。Mermaid 返回空列表，DOT 返回六个布局引擎。
/// </summary>
/// <param name="Id">传给渲染器的取值（<see cref="RenderOptions.Layout"/>）。</param>
/// <param name="DisplayNameKey">
/// 本地化 key。取不到译文时界面回退显示 key 本身 —— DOT 的六个引擎名是专有名词，
/// 中英文下都写作 <c>dot</c>/<c>neato</c>/…，因此它们的 key 就是引擎名，无需额外词条。
/// </param>
/// <param name="IsDefault">是否为该格式的默认布局。</param>
public sealed record LayoutOption(string Id, string DisplayNameKey, bool IsDefault = false);