using System.Collections.Generic;
using AvaloniaEdit.Highlighting;

namespace Diagramon.Services.Documents;

/// <summary>
/// 一个可注册的文档格式（方案 §4.1 / §8.2.2）。所有按格式分派的地方都必须走注册表，
/// 不允许出现按格式 id 的 <c>if / else</c> 链。
/// </summary>
public interface IDocumentFormat
{
    /// <summary>格式 id：<c>mermaid</c> / <c>dot</c> / <c>drawio</c>…</summary>
    string Id { get; }

    /// <summary>界面显示名（本地化 key），用于文件类型过滤器与关于框。</summary>
    string DisplayNameKey { get; }

    /// <summary>该格式认领的扩展名，**按长度降序**（含复合扩展名，如 <c>.drawio.svg</c>）。</summary>
    IReadOnlyList<string> Extensions { get; }

    /// <summary>新建标签页的默认文件名（本地化 key），如 <c>未命名.mmd</c> / <c>未命名.dot</c>。</summary>
    string DefaultFileNameKey { get; }

    /// <summary>
    /// 上传到云端时写进服务端 <c>format</c> 字段的取值（服务端白名单，见《Diagramon 服务端方案》§6 第 7 条）。
    /// </summary>
    /// <remarks>
    /// <b>第一个元素是上传时使用的规范取值</b>，其余是同义别名（白名单里 <c>mmd</c>/<c>mermaid</c>、
    /// <c>dot</c>/<c>gv</c> 都合法），用于打开由别的客户端上传的文档时仍能匹配到本格式。
    /// Mermaid 沿用既有的 <c>mmd</c> 而不是 <c>mermaid</c>：否则同一批云端文档会出现两种 format。
    /// </remarks>
    IReadOnlyList<string> CloudFormatIds { get; }

    /// <summary>承载方式，决定界面显隐。</summary>
    DocumentSurfaceKind Surface { get; }

    /// <summary>该格式是否提供 AI 生成能力。</summary>
    bool SupportsAiAssistant { get; }

    /// <summary>渲染器：预览页 + 增量更新 + 页面内导出。</summary>
    IDocumentRenderer Renderer { get; }

    /// <summary>
    /// 位图导出与语法校验是否走 <c>mmdc</c> 子进程（Mermaid 现状）。
    /// </summary>
    /// <remarks>
    /// 决策 3 规定本期不动 Node / mmdc：Mermaid 的导出与校验保持原路径，
    /// 新格式（DOT）走各自渲染器的页面内导出。因此这是一条**格式数据**而不是按 id 的判断。
    /// </remarks>
    bool UsesMermaidCliExport { get; }

    /// <summary>
    /// 该格式的源码是否能被图形编辑器导入（目前只有 Mermaid：drawio 与 Excalidraw 都提供 mermaid 解析器）。
    /// </summary>
    /// <remarks>
    /// 这是**单向**能力：图形编辑器只提供 mermaid → 图形这一个方向，没有反向导出，
    /// 因此界面必须把"不可逆"写在明面上（见 <c>MenuConvertToDrawio</c> 文案）。
    /// </remarks>
    bool SupportsGraphImport { get; }

    /// <summary>可选布局；空列表 = 界面不显示布局选择器。</summary>
    IReadOnlyList<LayoutOption> LayoutOptions { get; }

    /// <summary>文本面的语法高亮定义；无文本面的格式返回 null。</summary>
    IHighlightingDefinition? Highlighting { get; }

    /// <summary>新建标签页的初始内容。</summary>
    string CreateDefaultContent();
}