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

    /// <summary>
    /// 把画布里的最新内容取回 <see cref="TabItem.Content"/>（**落盘前**调用）。
    /// </summary>
    /// <remarks>
    /// 正文的常规回写是事件驱动的（drawio autosave / Excalidraw onChange → 宿主轮询队列），
    /// 而 drawio 的 autosave 有 1.5s 去抖（<c>Editor.autosaveDelay</c>）：用户画完立刻按"保存"
    /// 会把去抖窗口内的编辑漏掉。所以保存动作必须能主动向画布要一次当前状态 ——
    /// 这条通道也是**画布内不再提供保存按钮**的前提（见 tools/drawio-host/host.html 的 noSaveBtn）。
    /// </remarks>
    Task FlushAsync();

    /// <summary>画布当前缩放比例（<c>1</c> = 100%），供状态栏读数使用。</summary>
    /// <remarks>与预览面的 <c>window.__previewScale</c> 对应：四处视图都要能报出当前比例。</remarks>
    double ZoomFactor { get; }

    /// <summary>画布缩放比例变化。</summary>
    event EventHandler? ZoomFactorChanged;

    /// <summary>按倍率缩放画布（应用级"放大 / 缩小"命令的落点）。</summary>
    Task ZoomAsync(double factor);

    /// <summary>适应视图：把内容缩放到可见范围（应用级 Ctrl+0 的落点）。</summary>
    Task FitAsync();

    /// <summary>
    /// 画布内按下的**应用级**快捷键（组合键词汇表：<c>ctrl+s</c> / <c>ctrl+shift+s</c> / <c>ctrl+o</c> /
    /// <c>ctrl+n</c> / <c>ctrl+w</c> / <c>ctrl+q</c> / <c>ctrl+0</c> / <c>ctrl+zoom-in</c> / <c>ctrl+zoom-out</c>）。
    /// </summary>
    /// <remarks>
    /// 画布持有焦点时键先落在 WebView 的窗口过程上，Avalonia 窗口级的 KeyBindings 收不到 ——
    /// 承载页在捕获阶段截住这些组合键再回传，见 tools/drawio-host/host.html 与 excalidraw 承载页。
    /// </remarks>
    event EventHandler<string>? HotkeyPressed;

    /// <summary>承载面报错 / 资源不可用。</summary>
    event EventHandler<string>? ErrorReported;

    /// <summary>让画布在页面内栅格化并取回位图（零子进程）。</summary>
    Task<RendererResult> ExportImageAsync(string format, double scale, bool transparent);
}