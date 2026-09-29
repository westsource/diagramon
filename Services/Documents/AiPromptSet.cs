namespace Diagramon.Services.Documents;

/// <summary>
/// 一个格式的 AI 提示词素材。
/// </summary>
/// <remarks>
/// <para>
/// <b>提示词属于格式，不属于"AI 服务"</b>：格式才知道自己的语法约束（DOT 的顶层必须是
/// <c>digraph</c>、Mermaid 支持哪些图表类型）、自己的显示名（历史回灌时要告诉模型"这是生成的 X 代码"）、
/// 自己的代码围栏标记（<c>```mermaid</c> / <c>```dot</c>）。
/// 放在一个中心目录里就必须按格式 id 分支 —— 那正是 §9 陷阱 6 的 if/else 链：
/// 每加一个格式都得回去改那个中心文件，漏一次就静默降级成"按 Mermaid 处理"。
/// </para>
/// <para>
/// 这里只放<b>素材</b>（各段原文 + 围栏正则）。拼接规则（"当前代码"怎么附加、
/// "与图片冲突时以图片为准"这句放在哪）由 <c>AiPromptCatalog</c> 统一做 ——
/// 拼接是跨格式共享的逻辑，各写一份必然漂移。
/// </para>
/// </remarks>
/// <param name="DisplayLabel">历史回灌时给模型看的格式名，如 <c>Mermaid</c> / <c>Graphviz DOT</c>。</param>
/// <param name="SystemPrompt">文字生成的系统提示词（不含当前代码）。</param>
/// <param name="VisionPrompt">图片识别的系统提示词（不含当前代码）。</param>
/// <param name="CurrentCodeHeader">追加当前代码时的提示行，如 <c>当前 Mermaid 代码：</c>。</param>
/// <param name="CodeFencePattern">从模型回复里抽代码用的正则（带一个捕获组）。</param>
public sealed record AiPromptSet(
    string DisplayLabel,
    string SystemPrompt,
    string VisionPrompt,
    string CurrentCodeHeader,
    string CodeFencePattern)
{
    /// <summary>
    /// 无 AI 能力的格式（drawio / excalidraw）用它。
    /// </summary>
    /// <remarks>
    /// 用"空素材"而不是 <c>null</c>：调用方少一处空判断，而"这个格式没有提示词"是格式的**属性**，
    /// 不是"缺数据"。
    /// </remarks>
    public static AiPromptSet None { get; } =
        new(string.Empty, string.Empty, string.Empty, string.Empty, string.Empty);
}
