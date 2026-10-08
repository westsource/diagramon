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
    private static readonly Strings S = Strings.Instance;

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
    private double _zoomFactor = 1;
    private TaskCompletionSource<RendererResult>? _exportWaiter;

    public ExcalidrawDocumentHost()
    {
        _pollTimer = new DispatcherTimer { Interval = PollInterval };
        _pollTimer.Tick += async (_, _) => await DrainAsync();
    }

    /// <summary>承载面报错 / 资源不可用。</summary>
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
        if (_ready && _bridge != null)
        {
            _ = _bridge.ExecuteScriptAsync(EmbeddedProtocol.ZoomByScript(factor));
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task FitAsync()
    {
        // 走承载页的 fit 命令：内容整体缩放到可见范围（空文档回 100% + 原点）
        SendCommand(new { action = "fit" });
        return Task.CompletedTask;
    }

    /// <summary>
    /// 落盘前的 flush：画布变更本来就是**即时报**的（onChange → 队列 → 宿主 150ms 轮询），
    /// 这里补一次取队列即可 —— 它挡掉的是"变更已入队、但宿主还没轮到取走"的那 150ms 窗口。
    /// </summary>
    public Task FlushAsync() => DrainAsync();

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
            // 同一份文档、内容没变 → 不重载（保住画布自己的撤销历史与视角）。但视口是**页面级瞬态**
            // （文档只存 viewBackgroundColor/gridSize 等 4 个字段，不含 zoom/scroll），
            // 若它停在看不到内容的位置，切回来就是"一片纯白 + Scroll back to content"。
            // 这里让承载页确认一次：空文档归位到 100%/原点，视口离开内容就拉回来，看得到内容则不动。
            SendCommand(new { action = "ensureVisible" });
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
            return new RendererResult(false, null, string.Format(S.EmbeddedCanvasNotReadyFormat, S.FormatExcalidraw));
        }

        var waiter = new TaskCompletionSource<RendererResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _exportWaiter = waiter;
        SendCommand(new { action = "export", format, scale, transparent });

        var completed = await Task.WhenAny(waiter.Task, Task.Delay(ExportTimeout));
        _exportWaiter = null;

        if (completed != waiter.Task)
        {
            return new RendererResult(false, null, string.Format(S.EmbeddedExportTimeoutFormat, S.FormatExcalidraw));
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
            ErrorReported?.Invoke(this, S.ExcalidrawRuntimeMissing);
            return;
        }

        _server ??= LoopbackStaticServer.Start([("/excalidraw/", directory)]);

        // 带上应用当前语言：承载页的 boot/失败横幅是页面自产的文案，页面访问不到应用的语言表
        // （见 tools/excalidraw-host/index.html 的 PAGE_TEXTS）。
        var language = Uri.EscapeDataString(LocalizationService.Instance.CurrentLanguageCode);
        _bridge.Navigate($"{_server.BaseUrl}/excalidraw/index.html?lang={language}");
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
                ErrorReported?.Invoke(this, string.Format(S.EmbeddedHostEntryMissingFormat, S.FormatExcalidraw));
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
                        ErrorReported?.Invoke(this, string.Format(S.OfflineRequestBlockedFormat, blockedUrl));
                        break;

                    case "hotkey":
                        // 画布内截下的应用级快捷键（画布持焦点时窗口的 KeyBindings 收不到键）
                        var combo = root.TryGetProperty("combo", out var c) ? c.GetString() : null;
                        if (!string.IsNullOrWhiteSpace(combo))
                        {
                            HotkeyPressed?.Invoke(this, combo!);
                        }
                        break;

                    case "error":
                        ErrorReported?.Invoke(this, root.TryGetProperty("message", out var m) ? m.GetString() ?? S.ExcalidrawHostErrorFallback : S.ExcalidrawHostErrorFallback);
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

    /// <summary>
    /// 读承载页报告的缩放比例（状态栏读数），变了才通知界面。
    /// </summary>
    /// <remarks>
    /// 搭在已有的 150ms 轮询上；拿不到值（返回 0）时保留上一次读数，避免状态栏百分比抖动。
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
            waiter.TrySetResult(new RendererResult(false, null, message ?? S.ExcalidrawExportMissingData));
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