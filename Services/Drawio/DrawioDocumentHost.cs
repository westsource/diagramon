using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Threading;
using Diagramon.Models;
using Diagramon.Services.Documents;
using Diagramon.Services.Embedded;
using Diagramon.Services.Localization;
using Diagramon.Services.Preview;
using TabItem = Diagramon.Models.TabItem;

namespace Diagramon.Services.Drawio;

/// <summary>
/// drawio 标签页的承载宿主（方案 §4.4–4.6 / §8.4）。
/// </summary>
/// <remarks>
/// <para>
/// 职责：起一个只服务 <c>tools/drawio</c> 的 loopback origin → 载入我方外壳页 <c>host.html</c>
/// （drawio 必须跑在 iframe 里，否则 <c>parent != window</c> 判定会让 embed 初始化整段跳过）
/// → 轮询外壳页转发出来的事件 → 驱动状态机（init 是唯一同步点）。
/// </para>
/// <para>
/// <b>承载 origin 用 loopback</b>：spike 项 1 查明控件本身**没有** <c>CoreWebView2</c> 成员
/// （现有预览反射取不到的正是这个原因），但它公开了 <c>PlatformWebView</c>，
/// 经 <c>IPlatformWebView&lt;WebView2Core&gt;.PlatformView</c> 能拿到 <c>CoreWebView2</c>，
/// 也就是说方案 §4.4 的首选（虚拟主机映射）**技术上可行**。这里仍选 loopback（§4.4 的回退方案）的理由：
/// 它不依赖包装层内部结构（升级不会突然失效），且 DOT 的 WASM/ESM 已经在这条路径上实测通过；
/// 虚拟主机只服务静态文件、同样要防跨源，省下的那个本地端口不值一条未实测的第二路径。
/// 结论见 <c>design/spike-结论.md</c>。
/// </para>
/// <para>
/// 与 <c>TabItem.Content</c> 的关系：**源文本始终是唯一真相**，画布只是它的视图。autosave 回写
/// 走挂起通知的方式，绝不触发 <c>ContentChanged</c> —— 否则会掉进 Mermaid 渲染管线形成死循环（§4.6）。
/// </para>
/// </remarks>
public sealed class DrawioDocumentHost : IEmbeddedDocumentHost
{
    private static readonly Strings S = Strings.Instance;

    /// <summary>该宿主服务的格式 id（与 <c>DrawioFormat.FormatId</c> 一致）。</summary>
    public string FormatId => Documents.Formats.DrawioFormat.FormatId;

    /// <summary>资源是否就绪（缺资源时界面给明确指引，而不是白屏）。</summary>
    public bool IsAvailable => DrawioDirectory != null;

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(150);
    private static readonly TimeSpan ExportTimeout = TimeSpan.FromSeconds(60);

    /// <summary>
    /// flush 的超时：等不到画布回话时照常落盘（用上一次回写的内容），但要**说出来** ——
    /// 静默按旧内容保存是这一步最容易埋进去的假成功。
    /// </summary>
    private static readonly TimeSpan FlushTimeout = TimeSpan.FromSeconds(5);

    private readonly DispatcherTimer _pollTimer;
    private readonly Queue<DrawioAction> _pendingActions = new();

    private LoopbackStaticServer? _server;
    private WebViewBridge? _bridge;
    private Border? _container;
    private TabItem? _currentTab;
    private TabItem? _loadedTab;
    private string? _loadedXml;
    private bool _navigated;
    private bool _ready;
    private bool _polling;
    private double _zoomFactor = 1;
    private TaskCompletionSource<RendererResult>? _exportWaiter;
    private TaskCompletionSource<string?>? _flushWaiter;

    public DrawioDocumentHost()
    {
        _pollTimer = new DispatcherTimer { Interval = PollInterval };
        _pollTimer.Tick += async (_, _) => await DrainAsync();
    }

    /// <summary>
    /// drawio 报错 / 承载面不可用时的提示文本。
    /// </summary>
    public event EventHandler<string>? ErrorReported;

    /// <inheritdoc />
    public double ZoomFactor => _zoomFactor;

    /// <inheritdoc />
    public event EventHandler? ZoomFactorChanged;

    /// <inheritdoc />
    public event EventHandler<string>? HotkeyPressed;

    /// <inheritdoc />
    public Task ZoomAsync(double factor)
    {
        // 页面未就绪时直接丢弃：应用级缩放命令只可能在画布已经显示时被触发
        if (_ready && _bridge != null)
        {
            _ = _bridge.ExecuteScriptAsync(EmbeddedProtocol.ZoomByScript(factor));
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task FitAsync()
    {
        // 走承载页的 __hostFit：drawio 自己的 Fit Page（整页铺进视口）。
        // 不用 embed 的 `{"action":"fit"}` —— 那个 fit 的是内容框，小图会被放大到几十倍
        // （实测 160×60 → 606%），与预览面/Excalidraw 的"看清整幅图"语义不一致。
        if (_ready && _bridge != null)
        {
            _ = _bridge.ExecuteScriptAsync(EmbeddedProtocol.FitScript);
        }

        return Task.CompletedTask;
    }

    /// <summary><c>tools/drawio</c> 目录（含 <c>index.html</c> 与 <c>host.html</c>）；缺失返回 <c>null</c>。</summary>
    public static string? DrawioDirectory
    {
        get
        {
            var directory = AppPaths.FindToolsDirectory("drawio");
            if (directory == null)
            {
                return null;
            }

            return File.Exists(Path.Combine(directory, "index.html")) &&
                   File.Exists(Path.Combine(directory, "host.html"))
                ? directory
                : null;
        }
    }

    /// <summary>资源就绪的静态判断（实例版见 <see cref="IEmbeddedDocumentHost.IsAvailable"/>）。</summary>
    public static bool RuntimePresent => DrawioDirectory != null;

    /// <summary>把 WebView 挂进界面容器（只在首次需要 drawio 时调用，方案 §4.7 的懒创建）。</summary>
    public void Attach(Border container)
    {
        if (_bridge != null)
        {
            return;
        }

        _container = container;
        _bridge = new WebViewBridge();

        // 顺序要紧：先订阅挂载回调，再设 Child —— 容器已在可视树上时，设 Child 会同步触发 attach，
        // 先设后订阅就永远等不到那次事件（WebView 平台视图也就不会创建）。
        _bridge.OnAttached(OnBridgeAttached);
        _bridge.AttachTo(container);
    }

    private void OnBridgeAttached()
    {
        EnsureNavigated();
        StartPolling();
    }

    /// <summary>显示某个 drawio 文档（切换到该文档时会先 <c>load</c>）。</summary>
    public void Show(TabItem tab)
    {
        _currentTab = tab;

        if (_bridge == null)
        {
            return;
        }

        _bridge.IsVisible = true;

        if (!_navigated)
        {
            EnsureNavigated();
        }

        // 同一个文档、内容也没被外部改过 → 不重新 load，保住 drawio 自己的撤销历史（§8.4.4）
        if (ReferenceEquals(tab, _loadedTab) && string.Equals(tab.Content, _loadedXml, StringComparison.Ordinal))
        {
            StartPolling();
            return;
        }

        SendLoad(tab);
        StartPolling();
    }

    /// <summary>隐藏承载面（切到别的格式的标签页时调用；不销毁 WebView，避免丢撤销历史）。</summary>
    public void Hide()
    {
        _bridge?.IsVisible = false;
        StopPolling();
        _currentTab = null;
    }

    /// <summary>从 Mermaid 源码转换：交给 drawio 自己的解析器（单向，不可逆 —— 方案 §3.2.2）。</summary>
    public void LoadMermaidSource(TabItem tab, string mermaidSource)
    {
        _currentTab = tab;
        _bridge?.IsVisible = true;
        EnsureNavigated();
        SendAction(DrawioAction.LoadMermaid(mermaidSource));
        StartPolling();
    }

    /// <summary>
    /// 让 drawio 在画布内导出位图并取回字节（方案 §8.3.4 的 drawio 侧对应实现：
    /// 导出在页面内完成，**零子进程**）。
    /// </summary>
    public async Task<RendererResult> ExportImageAsync(string format, double scale, bool transparent)
    {
        if (!_ready || _currentTab == null)
        {
            return new RendererResult(false, null, string.Format(S.EmbeddedCanvasNotReadyFormat, S.FormatDrawio));
        }

        var waiter = new TaskCompletionSource<RendererResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _exportWaiter = waiter;
        SendAction(DrawioAction.Export(format, scale, transparent));

        var completed = await Task.WhenAny(waiter.Task, Task.Delay(ExportTimeout));
        _exportWaiter = null;

        if (completed != waiter.Task)
        {
            return new RendererResult(false, null, string.Format(S.EmbeddedExportTimeoutFormat, S.FormatDrawio));
        }

        return await waiter.Task;
    }

    /// <summary>
    /// 落盘前把画布的当前内容要回正文。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 走 drawio 的 <c>export</c>（<c>format: "xml"</c>）：它与 drawio 自己的 autosave 走的是同一个
    /// <c>getFileData</c>，实测两者的 XML **逐字节相同**（tools/drawio v31.4.6，同一画布状态）。
    /// 也就是说这条通道拿到的是"autosave 本来会写回的东西"，只是不必等那 1.5s 去抖。
    /// </para>
    /// <para>
    /// 回写后内容**没变就什么都不做**（见 <see cref="ApplyContent"/>）：flush 会在每次保存前跑一遍，
    /// 若每次都标脏，用户会看到"刚保存完还是已修改"。
    /// </para>
    /// </remarks>
    public async Task FlushAsync()
    {
        var tab = _currentTab;
        if (!_ready || tab == null || _bridge == null)
        {
            // 画布还没就绪：正文本来就是唯一真相（此时画布还没有任何编辑可言），直接放行落盘
            return;
        }

        var waiter = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _flushWaiter = waiter;
        SendAction(DrawioAction.ExportXml());

        var completed = await Task.WhenAny(waiter.Task, Task.Delay(FlushTimeout));
        _flushWaiter = null;

        if (completed != waiter.Task)
        {
            ErrorReported?.Invoke(this, string.Format(S.EmbeddedFlushTimeoutFormat, S.FormatDrawio));
            return;
        }

        var xml = await waiter.Task;
        if (!string.IsNullOrEmpty(xml))
        {
            ApplyContent(tab, xml);
        }
    }

    private void EnsureNavigated()
    {
        if (_bridge == null || _navigated)
        {
            return;
        }

        var directory = DrawioDirectory;
        if (directory == null)
        {
            ErrorReported?.Invoke(this, S.DrawioRendererMissing);
            return;
        }

        _server ??= LoopbackStaticServer.Start([("/drawio/", directory)]);
        _bridge.Navigate($"{_server.BaseUrl}/drawio/host.html");
        _navigated = true;

        // 页面载入前先把待发动作排上，等 init 到达再冲刷
        if (_currentTab != null)
        {
            SendLoad(_currentTab);
        }
    }

    private void SendLoad(TabItem tab)
    {
        _loadedTab = tab;
        _loadedXml = tab.Content;
        SendAction(DrawioAction.Load(tab.Content));
    }

    private void SendAction(DrawioAction action)
    {
        if (_bridge == null)
        {
            return;
        }

        // init 是唯一同步点：就绪前一律排队（§8.4.2）
        if (!_ready)
        {
            _pendingActions.Enqueue(action);
            return;
        }

        _ = _bridge.ExecuteScriptAsync(EmbeddedProtocol.DeliverScript(action));
    }

    /// <summary>
    /// <c>init</c> 到达后把排队动作投给页面，**并先确认承载页真的暴露了投递入口**。
    /// </summary>
    /// <remarks>
    /// 入口名一旦两侧不一致（曾经 drawio 页叫 <c>__deliver</c>，宿主发 <c>__apply</c>），
    /// <c>ExecuteScriptAsync</c> 对不存在的函数**不报错**：动作静默丢失，画布永远停在 Loading，
    /// 现场只剩一个转圈。因此这里把"入口不存在"变成一条可见错误（状态栏）。
    /// </remarks>
    private async Task FlushPendingAsync()
    {
        if (_bridge != null)
        {
            var probe = (await _bridge.ExecuteScriptAsync(EmbeddedProtocol.ReadyProbeScript))?.Trim();
            if (probe != "true")
            {
                ErrorReported?.Invoke(this, string.Format(S.EmbeddedHostEntryMissingFormat, S.FormatDrawio));
            }
        }

        while (_pendingActions.Count > 0)
        {
            SendAction(_pendingActions.Dequeue());
        }
    }

    private void StartPolling()
    {
        if (_polling || _bridge == null)
        {
            return;
        }

        _polling = true;
        _pollTimer.Start();
    }

    private void StopPolling()
    {
        _polling = false;
        _pollTimer.Stop();
    }

    private async Task DrainAsync()
    {
        if (_bridge == null || _currentTab == null)
        {
            return;
        }

        await UpdateZoomFactorAsync();

        var raw = await _bridge.ExecuteStringScriptAsync(EmbeddedProtocol.DrainQueueScript);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return;
        }

        List<string>? payloads;
        try
        {
            payloads = JsonSerializer.Deserialize<List<string>>(raw);
        }
        catch
        {
            return;
        }

        if (payloads == null)
        {
            return;
        }

        foreach (var payload in payloads)
        {
            HandlePayload(payload);
        }
    }

    private void HandlePayload(string payload)
    {
        DrawioEvent? message;
        try
        {
            message = JsonSerializer.Deserialize<DrawioEvent>(payload, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
            });
        }
        catch
        {
            return;
        }

        if (message == null || string.IsNullOrWhiteSpace(message.Event))
        {
            return;
        }

        // 离线守卫拦下的外部请求：不静默吞掉 —— 说明有代码路径想联网（上游版本变化时最容易出现）
        if (message.Event == "external-blocked")
        {
            var url = message.Extra != null && message.Extra.TryGetValue("url", out var u) && u.ValueKind == JsonValueKind.String
                ? u.GetString()
                : null;
            ErrorReported?.Invoke(this, string.Format(S.OfflineRequestBlockedFormat, url));
            return;
        }

        var tab = _currentTab;
        if (tab == null)
        {
            return;
        }

        switch (message.Event)
        {
            case "init":
                // 唯一的同步点：从这里开始才可以发动作
                _ready = true;
                _ = FlushPendingAsync();
                break;

            case "autosave":
                if (!string.IsNullOrEmpty(message.Xml))
                {
                    ApplyContent(tab, message.Xml);
                }
                break;

            case "save":
                // 画布里已经没有保存入口（host.html 传 noSaveBtn=1），这条分支留着是为了容忍
                // 上游仍发出 save（例如某个版本把快捷键接回来）：语义只剩"把画布内容写回正文"，
                // 落盘由本应用的保存动作负责（它会先 flush，见 FlushAsync）。
                if (!string.IsNullOrEmpty(message.Xml))
                {
                    ApplyContent(tab, message.Xml);
                }
                break;

            case "export":
                // drawio 的 export 事件被两个用途共用：落盘前的 flush（format=xml）与导出位图。
                // 必须靠 format 区分 —— 否则 flush 要回来的 XML 会被当成图片去解 base64。
                if (string.Equals(message.Format, "xml", StringComparison.OrdinalIgnoreCase))
                {
                    CompleteFlush(message.Xml);
                }
                else
                {
                    CompleteExport(message);
                }
                break;

            case "error":
                ErrorReported?.Invoke(this, message.MessageText ?? S.DrawioHostErrorFallback);
                break;

            case "hotkey":
                // 画布内截下的应用级快捷键（画布持焦点时窗口的 KeyBindings 收不到键）
                if (!string.IsNullOrWhiteSpace(message.Combo))
                {
                    HotkeyPressed?.Invoke(this, message.Combo);
                }
                break;

            case "load":
                // 文档已载入；内容不写回（否则一打开就被标成"已修改"）
                break;
        }
    }

    /// <summary>
    /// autosave / save / flush 回写：**挂起变更通知**，直接写正文。
    /// </summary>
    /// <remarks>
    /// 内容与正文一致时**不标脏**：drawio 的 autosave 会把整份文档规范化后发回来，保存前的 flush
    /// 更会在每次保存时原样取回画布状态 —— 无条件 <c>IsModified = true</c> 会让"刚保存完"的文档
    /// 立刻又显示已修改，并在下次保存时白写一遍。
    /// </remarks>
    private void ApplyContent(TabItem tab, string xml)
    {
        _loadedXml = xml;

        var changed = !string.Equals(tab.Content, xml, StringComparison.Ordinal);

        tab.SuspendContentNotifications = true;
        try
        {
            if (changed)
            {
                tab.Content = xml;
            }
        }
        finally
        {
            tab.SuspendContentNotifications = false;
        }

        if (changed)
        {
            tab.IsModified = true;
            tab.UpdateHeader();
        }
    }

    /// <summary>
    /// 读承载页报告的缩放比例（状态栏读数），变了才通知界面。
    /// </summary>
    /// <remarks>
    /// 搭在已有的 150ms 轮询上，不另开定时器；拿不到值（返回 0）时保留上一次读数 ——
    /// 状态栏的百分比不能因为一次读失败就跳到 0。
    /// </remarks>
    private async Task UpdateZoomFactorAsync()
    {
        var raw = (await _bridge!.ExecuteStringScriptAsync(EmbeddedProtocol.ZoomProbeScript))?.Trim();
        if (!double.TryParse(raw, NumberStyles.Any, CultureInfo.InvariantCulture, out var factor) || factor <= 0)
        {
            return;
        }

        if (Math.Abs(factor - _zoomFactor) < 0.001)
        {
            return;
        }

        _zoomFactor = factor;
        ZoomFactorChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>flush 回话：把 XML 交给等待方（保存动作）去决定怎么落。</summary>
    private void CompleteFlush(string? xml)
    {
        _flushWaiter?.TrySetResult(xml);
    }

    private void CompleteExport(DrawioEvent message)
    {
        var waiter = _exportWaiter;
        if (waiter == null)
        {
            return;
        }

        var data = message.Data;
        const string marker = "base64,";
        var separator = data?.IndexOf(marker, StringComparison.Ordinal) ?? -1;

        if (string.IsNullOrEmpty(data) || separator < 0)
        {
            waiter.TrySetResult(new RendererResult(false, null, message.MessageText ?? S.DrawioExportMissingData));
            return;
        }

        try
        {
            var bytes = Convert.FromBase64String(data[(separator + marker.Length)..]);
            waiter.TrySetResult(new RendererResult(true, bytes, null));
        }
        catch (Exception ex)
        {
            waiter.TrySetResult(new RendererResult(false, null, ex.Message));
        }
    }

    public void Dispose()
    {
        StopPolling();
        _server?.Dispose();
        _server = null;
        _bridge = null;
        _container = null;
    }
}
