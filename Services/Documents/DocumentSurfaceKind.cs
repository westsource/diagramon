namespace Diagramon.Services.Documents;

/// <summary>
/// 文档在界面上的承载方式（方案 §4.3）。界面只按这个枚举显隐，不按格式 id 判断。
/// </summary>
public enum DocumentSurfaceKind
{
    /// <summary>左侧文本编辑器 + 右侧实时预览（Mermaid、DOT）。</summary>
    TextWithPreview,

    /// <summary>只显示内嵌应用并占满整区（drawio 画布）。</summary>
    EmbeddedApp,

    /// <summary>文本与内嵌应用并排（drawio 的 XML 并排编辑，后置项）。</summary>
    TextWithEmbeddedApp,

    /// <summary>仅文本，无预览。</summary>
    TextOnly,
}