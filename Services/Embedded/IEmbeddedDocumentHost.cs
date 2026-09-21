using System;
using System.Threading.Tasks;
using Avalonia.Controls;
using Diagramon.Models;
using Diagramon.Services.Documents;
using TabItem = Diagramon.Models.TabItem;

namespace Diagramon.Services.Embedded;

/// <summary>
/// 内嵌图形编辑器承载面（方案 §4.7 / Phase 6 的抽象）：drawio 与 Excalidraw 共用的那一层。
/// </summary>
/// <remarks>
/// <para>
/// 抽这个接口的目的不是"预留扩展点"，而是**压测**：drawio 是协议型集成（iframe + postMessage +
/// host.html），Excalidraw 是库型集成（自己页面里实例化）。两者能落在同一个接口下，说明
/// <c>EmbeddedApp</c> 那一层没有被 drawio 的形状污染；若为了接 Excalidraw 必须改
/// <c>MainViewModel</c>/<c>MainWindow</c> 的核心结构，则说明抽象失败（见方案 §7 Phase 6 的验收口径）。
/// </para>
/// <para>
/// 约定：<b>内容真相永远在 <see cref="TabItem.Content"/></b>，承载面只是它的视图；
/// 回写必须挂起变更通知（<see cref="TabItem.SuspendContentNotifications"/>），
/// 绝不能把画布事件灌进文本渲染管线（方案 §4.6 的循环）。
/// </para>
/// </remarks>
public interface IEmbeddedDocumentHost
{
    /// <summary>该宿主服务的格式 id（注册表里的键）。</summary>
    string FormatId { get; }

    /// <summary>承载面运行时是否就绪（资源缺失时界面给明确指引，而不是白屏）。</summary>
    bool IsAvailable { get; }

    /// <summary>把承载控件挂进容器；只在首次需要时调用（懒创建）。</summary>
    void Attach(Border container);

    /// <summary>显示某个文档；切到同一文档时应避免无谓重载（保住画布自己的撤销历史）。</summary>
    void Show(TabItem tab);

    /// <summary>隐藏（切到别的格式时调用）。**不销毁实例**：重建要数秒且丢撤销历史。</summary>
    void Hide();

    /// <summary>按 Mermaid 源码载入（单向转换的落点；drawio 用 descriptor，Excalidraw 用 mermaid-to-excalidraw）。</summary>
    void LoadMermaidSource(TabItem tab, string mermaidSource);

    /// <summary>画布内保存被触发（宿主负责落盘）。</summary>
    event EventHandler<TabItem>? SaveRequested;

    /// <summary>承载面报错 / 资源不可用。</summary>
    event EventHandler<string>? ErrorReported;

    /// <summary>让画布在页面内栅格化并取回位图（零子进程）。</summary>
    Task<RendererResult> ExportImageAsync(string format, double scale, bool transparent);
}