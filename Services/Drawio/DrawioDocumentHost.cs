using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Threading;
using Diagramon.Models;
using Diagramon.Services.Documents;
using Diagramon.Services.Embedded;
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
    /// <summary>该宿主服务的格式 id（与 <c>DrawioFormat.FormatId</c> 一致）。</summary>
    public string FormatId => Documents.Formats.DrawioFormat.FormatId;

    /// <summary>资源是否就绪（缺资源时界面给明确指引，而不是白屏）。</summary>
    public bool IsAvailable => DrawioDirectory != null;

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(150);
    private static readonly TimeSpan ExportTimeout = TimeSpan.FromSeconds(60);

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
    private TaskCompletionSource<RendererResult>? _exportWaiter;

    public DrawioDocumentHost()
    {
        _pollTimer = new DispatcherTimer { Interval = PollInterval };
        _pollTimer.Tick += async (_, _) => await DrainAsync();
    }

    /// <summary>drawio 要求保存（用户在画布上按了保存，或 saveAndExit）。承载方负责落盘。</summary>
    public event EventHandler<TabItem>? SaveRequested;

    /// <summary>drawio 报错 / 承载面不可用时的提示文本。</summary>
    public event EventHandler<string>? ErrorReported;

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

    /// <summary>让 drawio 适配窗口。</summary>
    public void Fit() => SendAction(DrawioAction.Fit());

    /// <summary>
    /// 让 drawio 在画布内导出位图并取回字节（方案 §8.3.4 的 drawio 侧对应实现：
    /// 导出在页面内完成，**零子进程**）。
    /// </summary>
    public async Task<RendererResult> ExportImageAsync(string format, double scale, bool transparent)
    {
        if (!_ready || _currentTab == null)
        {
            return new RendererResult(false, null, "drawio 承载面尚未就绪");
        }

        var waiter = new TaskCompletionSource<RendererResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _exportWaiter = waiter;
        SendAction(DrawioAction.Export(format, scale, transparent));

        var completed = await Task.WhenAny(waiter.Task, Task.Delay(ExportTimeout));
        _exportWaiter = null;

        if (completed != waiter.Task)
        {
            return new RendererResult(false, null, "drawio 导出超时");
        }

        return await waiter.Task;
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
            ErrorReported?.Invoke(this, "缺少 drawio 渲染资源");
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
                ErrorReported?.Invoke(this, "drawio 承载页缺少消息入口 window.__apply，动作无法送达（承载页与宿主协议不一致）");
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
            ErrorReported?.Invoke(this, $"已拦截外部请求（离线模式）: {url}");
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
                if (!string.IsNullOrEmpty(message.Xml))
                {
                    ApplyContent(tab, message.Xml);
                }
                SaveRequested?.Invoke(this, tab);
                break;

            case "export":
                CompleteExport(message);
                break;

            case "error":
                ErrorReported?.Invoke(this, message.Message ?? "drawio 报告了一个错误");
                break;

            case "load":
                // 文档已载入；内容不写回（否则一打开就被标成"已修改"）
                break;
        }
    }

    /// <summary>
    /// autosave / save 回写：**挂起变更通知**，直接写正文。
    /// </summary>
    private void ApplyContent(TabItem tab, string xml)
    {
        _loadedXml = xml;

        tab.SuspendContentNotifications = true;
        try
        {
            if (!string.Equals(tab.Content, xml, StringComparison.Ordinal))
            {
                tab.Content = xml;
            }
        }
        finally
        {
            tab.SuspendContentNotifications = false;
        }

        tab.IsModified = true;
        tab.UpdateHeader();
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
            waiter.TrySetResult(new RendererResult(false, null, message.Message ?? "drawio 导出结果缺少图像数据"));
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
