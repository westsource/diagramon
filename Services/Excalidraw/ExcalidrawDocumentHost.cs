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

namespace Diagramon.Services.Excalidraw;

/// <summary>
/// Excalidraw 标签页的承载宿主（方案 Phase 6）。
/// </summary>
/// <remarks>
/// <para>
/// <b>库型集成</b>：Excalidraw 是在我们自己页面里实例化的 React 组件，没有 iframe、没有
/// postMessage 协议、没有 init 握手 —— 与 drawio（协议型）恰好相对。两者落在同一个
/// <see cref="Embedded.IEmbeddedDocumentHost"/> 下，是这一期要压测的事（方案 §7 Phase 6 的验收口径）。
/// </para>
/// <para>
/// 内容真相仍是 <see cref="TabItem.Content"/> 里的 JSON 文本；画布变更（Excalidraw 的 onChange
/// 在拖拽时每帧触发）先入队，由这里按 <see cref="PollInterval"/> 合并后回写，且回写挂起变更通知。
/// </para>
/// </remarks>
public sealed class ExcalidrawDocumentHost : IEmbeddedDocumentHost
{
    /// <summary>该宿主服务的格式 id（与 <c>ExcalidrawFormat.FormatId</c> 一致）。</summary>
    public string FormatId => Documents.Formats.ExcalidrawFormat.FormatId;

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(150);
    private static readonly TimeSpan ExportTimeout = TimeSpan.FromSeconds(60);

    private readonly DispatcherTimer _pollTimer;
    private readonly Queue<object> _pendingCommands = new();

    private LoopbackStaticServer? _server;
    private WebViewBridge? _bridge;
    private TabItem? _currentTab;
    private TabItem? _loadedTab;
    private string? _loadedJson;
    private bool _navigated;
    private bool _ready;
    private bool _polling;
    private TaskCompletionSource<RendererResult>? _exportWaiter;

    public ExcalidrawDocumentHost()
    {
        _pollTimer = new DispatcherTimer { Interval = PollInterval };
        _pollTimer.Tick += async (_, _) => await DrainAsync();
    }

    /// <summary>Excalidraw 要求保存（当前版本没有画布内保存按钮，保留事件以对齐接口）。</summary>
    public event EventHandler<TabItem>? SaveRequested;

    /// <summary>承载面报错 / 资源不可用。</summary>
    public event EventHandler<string>? ErrorReported;

    /// <summary><c>tools/excalidraw</c> 目录（含 <c>index.html</c> 与 <c>app.js</c>）；缺失返回 <c>null</c>。</summary>
    public static string? RuntimeDirectory
    {
        get
        {
            var directory = AppPaths.FindToolsDirectory("excalidraw");
            if (directory == null)
            {
                return null;
            }

            return File.Exists(Path.Combine(directory, "index.html")) &&
                   File.Exists(Path.Combine(directory, "app.js"))
                ? directory
                : null;
        }
    }

    public bool IsAvailable => RuntimeDirectory != null;

    public void Attach(Border container)
    {
        if (_bridge != null)
        {
            return;
        }

        _bridge = new WebViewBridge();

        // 与 drawio 宿主同一条教训：先订阅挂载回调，再设 Child —— 容器已在可视树上时，
        // 设 Child 会同步触发 attach，先设后订阅就永远等不到那次事件。
        _bridge.OnAttached(OnBridgeAttached);
        _bridge.AttachTo(container);
    }

    private void OnBridgeAttached()
    {
        EnsureNavigated();
        StartPolling();
    }

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

        if (ReferenceEquals(tab, _loadedTab) && string.Equals(tab.Content, _loadedJson, StringComparison.Ordinal))
        {
            StartPolling();
            return;
        }

        SendScene(tab.Content);
        StartPolling();
    }

    public void Hide()
    {
        _bridge?.IsVisible = false;
        StopPolling();
        _currentTab = null;
    }

    /// <summary>按 Mermaid 源码载入（`@excalidraw/mermaid-to-excalidraw`，单向）。</summary>
    public void LoadMermaidSource(TabItem tab, string mermaidSource)
    {
        _currentTab = tab;
        _loadedTab = tab;
        _bridge?.IsVisible = true;
        EnsureNavigated();

        // 转换由页面内的 bundle 完成（它才知道 mermaid-to-excalidraw 的 API）；
        // 结果会以 `loaded` 事件 + 随后的 `scene` 回写回来，成为标签页内容。
        SendCommand(new { action = "loadMermaid", source = mermaidSource });
        StartPolling();
    }

    public async Task<RendererResult> ExportImageAsync(string format, double scale, bool transparent)
    {
        if (!_ready || _currentTab == null)
        {
            return new RendererResult(false, null, "Excalidraw 承载面尚未就绪");
        }

        var waiter = new TaskCompletionSource<RendererResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _exportWaiter = waiter;
        SendCommand(new { action = "export", format, scale, transparent });

        var completed = await Task.WhenAny(waiter.Task, Task.Delay(ExportTimeout));
        _exportWaiter = null;

        if (completed != waiter.Task)
        {
            return new RendererResult(false, null, "Excalidraw 导出超时");
        }

        return await waiter.Task;
    }

    private void EnsureNavigated()
    {
        if (_bridge == null || _navigated)
        {
            return;
        }

        var directory = RuntimeDirectory;
        if (directory == null)
        {
            ErrorReported?.Invoke(this, "缺少 Excalidraw 运行时资源");
            return;
        }

        _server ??= LoopbackStaticServer.Start([("/excalidraw/", directory)]);
        _bridge.Navigate($"{_server.BaseUrl}/excalidraw/index.html");
        _navigated = true;

        if (_currentTab != null)
        {
            SendScene(_currentTab.Content);
        }
    }

    private void SendScene(string json)
    {
        _loadedTab = _currentTab;
        _loadedJson = json;
        SendCommand(new { action = "setScene", scene = json });
    }

    private void SendCommand(object command)
    {
        if (_bridge == null)
        {
            return;
        }

        // ready 之前页面还没有投递入口：先排队。直接投递会被 ExecuteScriptAsync 静默丢弃
        // （对不存在的函数不报错），表现为命令石沉大海。
        if (!_ready)
        {
            _pendingCommands.Enqueue(command);
            return;
        }

        _ = _bridge.ExecuteScriptAsync(EmbeddedProtocol.DeliverScript(command));
    }

    /// <summary>
    /// 就绪后先确认承载页真的暴露了投递入口，再投递排队命令。
    /// </summary>
    /// <remarks>
    /// 入口名两侧不一致时 <c>ExecuteScriptAsync</c> 对不存在的函数**不报错**，命令会静默丢失
    /// （drawio 侧曾因此永远停在 Loading）。这里把"入口不存在"变成一条可见错误。
    /// </remarks>
    private async Task VerifyEntryAndFlushAsync()
    {
        if (_bridge != null)
        {
            var probe = (await _bridge.ExecuteScriptAsync(EmbeddedProtocol.ReadyProbeScript))?.Trim();
            if (probe != "true")
            {
                ErrorReported?.Invoke(this, "Excalidraw 承载页缺少消息入口 window.__apply，命令无法送达（承载页与宿主协议不一致）");
            }
        }

        while (_pendingCommands.Count > 0)
        {
            SendCommand(_pendingCommands.Dequeue());
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

        // 一帧可能入队很多条 scene；只处理最后一条（内容是全量快照）
        string? lastScene = null;

        foreach (var payload in payloads)
        {
            try
            {
                using var document = JsonDocument.Parse(payload);
                var root = document.RootElement;
                var name = root.TryGetProperty("event", out var e) ? e.GetString() : null;

                switch (name)
                {
                    case "ready":
                        _ready = true;
                        _ = VerifyEntryAndFlushAsync();
                        break;

                    case "scene":
                        lastScene = payload;
                        break;

                    case "export":
                        CompleteExport(root);
                        break;

                    // 离线守卫拦下的外部请求：不静默吞掉（说明有代码路径想联网）
                    case "external-blocked":
                        var blockedUrl = root.TryGetProperty("url", out var u) ? u.GetString() : null;
                        ErrorReported?.Invoke(this, $"已拦截外部请求（离线模式）: {blockedUrl}");
                        break;

                    case "error":
                        ErrorReported?.Invoke(this, root.TryGetProperty("message", out var m) ? m.GetString() ?? "Excalidraw 报错" : "Excalidraw 报错");
                        break;
                }
            }
            catch
            {
            }
        }

        if (lastScene != null)
        {
            ApplyScene(_currentTab, lastScene);
        }
    }

    private void ApplyScene(TabItem tab, string payload)
    {
        try
        {
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;

            var scene = new Dictionary<string, object?>
            {
                ["type"] = "excalidraw",
                ["version"] = 2,
                ["source"] = "Diagramon",
                ["elements"] = root.TryGetProperty("elements", out var elements) ? elements.Clone() : (object?)null,
                ["appState"] = root.TryGetProperty("appState", out var appState) ? appState.Clone() : null,
                ["files"] = new Dictionary<string, object?>(),
            };

            var json = JsonSerializer.Serialize(scene);
            _loadedJson = json;

            var changed = !string.Equals(tab.Content, json, StringComparison.Ordinal);

            tab.SuspendContentNotifications = true;
            try
            {
                if (changed)
                {
                    tab.Content = json;
                }
            }
            finally
            {
                tab.SuspendContentNotifications = false;
            }

            // 内容没变就不要标脏：Excalidraw 的 onChange 也会因 appState 变动触发
            // （滚动/缩放等），而我们的 appState 已过滤掉瞬态字段 ——
            // 那种情况下 json 与正文相同，标脏会让"只是打开看了一眼"变成"已修改"。
            if (!changed)
            {
                return;
            }

            tab.IsModified = true;
            tab.UpdateHeader();
        }
        catch
        {
        }
    }

    private void CompleteExport(JsonElement root)
    {
        var waiter = _exportWaiter;
        if (waiter == null)
        {
            return;
        }

        var data = root.TryGetProperty("data", out var d) ? d.GetString() : null;
        const string marker = "base64,";
        var separator = data?.IndexOf(marker, StringComparison.Ordinal) ?? -1;

        if (string.IsNullOrEmpty(data) || separator < 0)
        {
            var message = root.TryGetProperty("message", out var m) ? m.GetString() : null;
            waiter.TrySetResult(new RendererResult(false, null, message ?? "Excalidraw 导出结果缺少图像数据"));
            return;
        }

        try
        {
            waiter.TrySetResult(new RendererResult(true, Convert.FromBase64String(data[(separator + marker.Length)..]), null));
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
    }
}